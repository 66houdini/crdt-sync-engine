import { DurableObject } from "cloudflare:workers";
import { FugueMax, type FugueOp, isId, parseFugueOp } from "@crdt/core";
import type { Env } from "./env";
import {
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  REPLICA_ID_PATTERN,
  SERVER_REPLICA_ID,
  type SequencedOp,
  type ServerMessage,
} from "./protocol";

/** How long accepted ops may sit in memory before being written to SQLite. */
const FLUSH_INTERVAL_MS = 2000;
/** Flush early once this many ops are buffered. */
const MAX_BUFFERED_OPS = 1000;
/** Upper bound for one stored batch row and for one outgoing text frame (SQLite values cap at 2 MB, frames at 1 MiB). */
const MAX_CHUNK_CHARS = 250_000;
/** Upper bound for one stored snapshot chunk and one outgoing binary frame. */
const MAX_CHUNK_BYTES = 500_000;
const MAX_INCOMING_CHARS = 250_000;
const MAX_CHAR_LENGTH = 16;
const OPS_PER_FRAME = 500;
/** Fold the log into a snapshot once this many ops have accumulated since the last one. */
const DEFAULT_SNAPSHOT_EVERY_OPS = 5000;
/** Ops kept in the log behind a snapshot, so recently connected clients can still catch up incrementally. */
const DEFAULT_LOG_TAIL_OPS = 1000;
const DEFAULT_MAX_DOC_ELEMENTS = 500_000;
const DEFAULT_MAX_CONNECTIONS = 64;
/** Enough for a large paste; ordinary typing is around ten ops a second. */
const DEFAULT_RATE_BURST = 3000;
const DEFAULT_RATE_PER_SECOND = 300;
/** Every message costs this much on top of its ops, so empty or duplicate-only frames are not free. */
const MESSAGE_COST = 2;
/** Sentinel returned by `accept` when the replica has run out of tokens. */
const RATE_LIMITED = "\u0000rate-limited";

/** State of an empty document, sent to new clients of a document that has no snapshot yet. */
const EMPTY_STATE = new FugueMax(SERVER_REPLICA_ID).encode();

interface Attachment {
  replicaId: string;
  /** Last caret this connection reported, as an id tuple; survives hibernation with the socket. */
  cursor?: [string, number] | null;
}

/** Everything the relay needs to serve reads, kept in one meta row so waking up never has to rebuild the document. */
interface Summary {
  seq: number;
  vv: [string, number][];
  length: number;
  tombstones: number;
  lastActive: number | null;
}

/**
 * One instance per document: a relay that orders, persists and fans out FugueMax ops.
 *
 * Free-tier shape:
 *  - WebSocket Hibernation API, so an idle document costs no duration.
 *  - Ops are applied and broadcast immediately but persisted in batches: one SQLite
 *    row per flush, not per keystroke.
 *  - Nothing that must survive hibernation lives only in memory: state is read back
 *    from SQLite in the constructor and each socket's replica id is in its attachment.
 *  - Waking up is cheap. Connecting, reconnecting and reading stats are served from
 *    the stored snapshot, the log and a small summary row; the document itself is
 *    rebuilt only when an op has to be validated against it (or to compact it).
 *  - Storage is bounded by the document, not its history: the log is periodically
 *    folded into a compact binary snapshot and only a short tail of recent ops is
 *    kept. Superseded snapshots and log segments go to R2 if a bucket is bound.
 *  - It defends its quota: per-replica rate limiting, a cap on document size and
 *    on connections, and optional expiry of idle documents.
 *
 * Losing the un-flushed buffer (crash or eviction before the alarm) is detected,
 * not ignored: a pending flush alarm that this instance did not schedule means a
 * previous instance died with ops in memory. The document epoch is then bumped and
 * every client is told to resync from the snapshot and resend what was never acked.
 */
export class DocumentDO extends DurableObject<Env> {
  /** The document, once something has needed it. See `materialize`. */
  private doc: FugueMax | null = null;
  /** Ops accepted per replica. Maintained by the relay itself so it is known without the document. */
  private vv = new Map<string, number>();
  /** Live characters plus tombstones. */
  private elements = 0;
  private length = 0;
  /** Last sequence number assigned. */
  private seq = 0;
  /** Last sequence number persisted. */
  private durableSeq = 0;
  /** Sequence number the stored snapshot reflects (0: no snapshot). */
  private snapshotSeq = 0;
  /** Ops with a greater sequence number are still in the log. */
  private logStart = 0;
  private epoch = 0;
  private docId: string | null = null;
  private lastActive: number | null = null;
  private buffer: SequencedOp[] = [];
  /** True iff this instance has a flush alarm pending for its own buffer. */
  private alarmScheduled = false;
  private compacting = false;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Changes whenever the object is constructed afresh; lets a client tell a cold start from a warm request. */
  private readonly instance = crypto.randomUUID();

  private readonly snapshotEvery: number;
  private readonly logTail: number;
  private readonly maxElements: number;
  private readonly maxConnections: number;
  private readonly rateBurst: number;
  private readonly ratePerSecond: number;
  /** 0: documents never expire. */
  private readonly ttlMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.snapshotEvery = positiveInt(env.SNAPSHOT_EVERY_OPS, DEFAULT_SNAPSHOT_EVERY_OPS);
    this.logTail = positiveInt(env.LOG_TAIL_OPS, DEFAULT_LOG_TAIL_OPS);
    this.maxElements = positiveInt(env.MAX_DOC_ELEMENTS, DEFAULT_MAX_DOC_ELEMENTS);
    this.maxConnections = positiveInt(env.MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS);
    this.rateBurst = positiveInt(env.RATE_BURST, DEFAULT_RATE_BURST);
    this.ratePerSecond = positiveInt(env.RATE_PER_SECOND, DEFAULT_RATE_PER_SECOND);
    this.ttlMs = positiveInt(env.DOC_TTL_SECONDS, 0) * 1000;

    void ctx.blockConcurrencyWhile(async () => {
      this.rehydrate();
      // The only alarm a healthy document leaves behind is its expiry alarm. Any other
      // pending alarm is a flush alarm from a previous instance whose buffer is gone.
      const pending = await ctx.storage.getAlarm();
      if (pending !== null && pending !== this.expiryTime()) {
        this.declareLoss();
        this.rearm();
      } else if (pending === null && this.ttlMs > 0) {
        this.touch();
      }
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // ---------------------------------------------------------------- waking up

  /** Reads back what is needed to serve reads. Does not rebuild the document unless the summary is missing. */
  private rehydrate(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS op_batches (first_seq INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL, ops TEXT NOT NULL)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS snapshot_chunks (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.epoch = Number(this.readMeta("epoch") ?? 0);
    this.docId = this.readMeta("doc_id");
    this.snapshotSeq = Number(this.readMeta("snapshot_seq") ?? 0);

    const newest = this.sql.exec<{ last: number | null }>("SELECT MAX(last_seq) AS last FROM op_batches").one().last;
    this.seq = Math.max(this.snapshotSeq, newest ?? 0);
    this.durableSeq = this.seq;
    this.logStart = this.computeLogStart();

    const stored = this.readMeta("summary");
    const summary = stored === null ? null : (JSON.parse(stored) as Summary);
    if (summary !== null && summary.seq === this.seq) {
      this.vv = new Map(summary.vv);
      this.length = summary.length;
      this.elements = summary.length + summary.tombstones;
      this.lastActive = summary.lastActive;
    } else if (this.seq > 0) {
      // Stored before summaries existed: derive it once from the document.
      const doc = this.materialize();
      this.vv = doc.versionVector();
      this.length = doc.length;
      this.elements = doc.nodeCount;
      this.writeSummary();
    }
  }

  /**
   * The document itself: the stored snapshot plus the ops logged after it. Built
   * on first use and then kept for the life of the instance. Reads never call
   * this; accepting an op, compacting and `/text` do.
   */
  private materialize(): FugueMax {
    if (this.doc !== null) return this.doc;
    const snapshot = this.readSnapshot();
    const doc = snapshot === null ? new FugueMax(SERVER_REPLICA_ID) : FugueMax.decode(snapshot, SERVER_REPLICA_ID);
    // Rows at or below the snapshot are the retained tail, kept only for client catch-up.
    for (const row of this.sql.exec<{ ops: string }>(
      "SELECT ops FROM op_batches WHERE last_seq > ? ORDER BY first_seq",
      this.snapshotSeq,
    )) {
      for (const op of JSON.parse(row.ops) as FugueOp[]) doc.applyRemoteOp(op);
    }
    this.doc = doc;
    return doc;
  }

  private computeLogStart(): number {
    const first = this.sql.exec<{ first: number | null }>("SELECT MIN(first_seq) AS first FROM op_batches").one().first;
    return first === null ? this.durableSeq : first - 1;
  }

  private snapshotChunks(): Uint8Array[] {
    return this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM snapshot_chunks ORDER BY idx")
      .toArray()
      .map((row) => new Uint8Array(row.data));
  }

  private readSnapshot(): Uint8Array | null {
    const chunks = this.snapshotChunks();
    if (chunks.length === 0) return null;
    const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private readMeta(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows[0]?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  private writeSummary(): void {
    const summary: Summary = {
      seq: this.durableSeq,
      vv: [...this.vv],
      length: this.length,
      tombstones: this.elements - this.length,
      lastActive: this.lastActive,
    };
    this.writeMeta("summary", JSON.stringify(summary));
  }

  private declareLoss(): void {
    this.epoch += 1;
    this.writeMeta("epoch", String(this.epoch));
    this.broadcast({ type: "resync", epoch: this.epoch }, null);
  }

  // ---------------------------------------------------------------- HTTP

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/");
    const route = segments.pop();
    if (this.docId === null) {
      // Remember the document's name: an object only knows its opaque id, and archive keys should be readable.
      this.docId = segments.pop() ?? "unnamed";
      this.writeMeta("doc_id", this.docId);
    }

    if (route === "text") return new Response(this.materialize().toString());
    if (route === "stats") {
      return Response.json({
        instance: this.instance,
        seq: this.seq,
        durableSeq: this.durableSeq,
        snapshotSeq: this.snapshotSeq,
        logStart: this.logStart,
        epoch: this.epoch,
        buffered: this.buffer.length,
        materialized: this.doc !== null,
        length: this.length,
        tombstones: this.elements - this.length,
        connections: this.ctx.getWebSockets().length,
      });
    }
    if (route !== "ws") return new Response("not found", { status: 404 });

    const replicaId = url.searchParams.get("replica") ?? "";
    if (!REPLICA_ID_PATTERN.test(replicaId) || replicaId === SERVER_REPLICA_ID) {
      return new Response("missing or invalid ?replica=", { status: 400 });
    }

    // A replica id identifies one writer; a second connection replaces the first.
    const stale = this.ctx.getWebSockets(replicaId);
    if (this.ctx.getWebSockets().length - stale.length >= this.maxConnections) {
      return new Response("this document has too many connections", { status: 503 });
    }
    for (const ws of stale) ws.close(CLOSE_REPLACED, "replaced by a newer connection");

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [replicaId]);
    server.serializeAttachment({ replicaId } satisfies Attachment);

    // Make everything durable first, so every sequence number the client is about to learn is stable.
    this.flush();
    this.touch();
    this.sendInitialSync(server, replicaId, url.searchParams);
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendInitialSync(ws: WebSocket, replicaId: string, params: URLSearchParams): void {
    const since = params.has("since") ? Number(params.get("since")) : Number.NaN;
    const incremental =
      Number(params.get("epoch")) === this.epoch &&
      Number.isSafeInteger(since) &&
      since >= this.logStart &&
      since <= this.durableSeq;

    if (incremental) {
      this.sendOpsAfter(ws, since);
    } else {
      // Full state straight from storage: the snapshot as stored, then the ops logged
      // after it. Nothing is decoded or re-encoded, so this costs the same however
      // large the document is.
      const chunks = this.snapshotChunks();
      const frames = chunks.length === 0 ? [EMPTY_STATE] : chunks;
      this.send(ws, { type: "snapshot", frames: frames.length });
      for (const frame of frames) {
        try {
          ws.send(frame);
        } catch {
          return;
        }
      }
      this.sendOpsAfter(ws, this.snapshotSeq);
    }

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const peer = other.deserializeAttachment() as Attachment;
      if (peer.cursor !== undefined) this.send(ws, presenceOf(peer));
    }
    this.send(ws, { type: "synced", seq: this.durableSeq, epoch: this.epoch, counter: this.vv.get(replicaId) ?? 0 });
  }

  private sendOpsAfter(ws: WebSocket, since: number): void {
    let page: SequencedOp[] = [];
    for (const row of this.sql.exec<{ first_seq: number; ops: string }>(
      "SELECT first_seq, ops FROM op_batches WHERE last_seq > ? ORDER BY first_seq",
      since,
    )) {
      (JSON.parse(row.ops) as FugueOp[]).forEach((op, i) => {
        const seq = row.first_seq + i;
        if (seq > since) page.push({ seq, op });
      });
      while (page.length >= OPS_PER_FRAME) this.send(ws, { type: "ops", ops: page.splice(0, OPS_PER_FRAME) });
    }
    if (page.length > 0) this.send(ws, { type: "ops", ops: page });
  }

  // ---------------------------------------------------------------- WebSocket (hibernation API)

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const { replicaId } = ws.deserializeAttachment() as Attachment;
    if (!this.spend(replicaId, MESSAGE_COST)) {
      this.rateLimit(ws);
      return;
    }
    if (typeof message !== "string" || message.length > MAX_INCOMING_CHARS) {
      this.send(ws, { type: "error", message: "expected a JSON text frame of at most 250k characters" });
      return;
    }

    let parsed: { type?: unknown; ops?: unknown; cursor?: unknown };
    try {
      parsed = JSON.parse(message) as typeof parsed;
    } catch {
      parsed = {};
    }

    if (parsed.type === "presence" && (parsed.cursor === null || isId(parsed.cursor))) {
      const cursor: [string, number] | null = parsed.cursor === null ? null : [parsed.cursor.replicaId, parsed.cursor.counter];
      ws.serializeAttachment({ replicaId, cursor } satisfies Attachment);
      this.broadcast(presenceOf({ replicaId, cursor }), ws);
      return;
    }
    if (parsed.type !== "ops" || !Array.isArray(parsed.ops)) {
      this.send(ws, { type: "error", message: 'expected {"type":"ops","ops":[...]} or {"type":"presence","cursor":...}' });
      return;
    }

    const accepted: SequencedOp[] = [];
    let limited = false;
    for (const raw of parsed.ops) {
      const problem = this.accept(raw, replicaId, accepted);
      if (problem === RATE_LIMITED) {
        limited = true;
        break;
      }
      if (problem !== null) {
        // Later ops from this replica depend on the rejected one; stop here.
        this.send(ws, { type: "error", message: problem });
        break;
      }
    }

    if (accepted.length > 0) {
      this.buffer.push(...accepted);
      this.broadcast({ type: "ops", ops: accepted }, ws);
      if (this.buffer.length >= MAX_BUFFERED_OPS) this.flush();
      else this.scheduleFlush();
    } else if (this.buffer.length === 0 && !limited) {
      // Pure resend of ops that are already durable: confirm right away.
      this.send(ws, this.ackFor(replicaId));
    }
    if (limited) this.rateLimit(ws);
  }

  /**
   * Validates and applies one incoming op. Returns an error description, or null
   * on success / duplicate.
   *
   * A refusal is sticky for that writer: its later ops carry later counters and
   * would leave a gap, so they are refused as out of order until it reconnects
   * and resends. For a rate limit that is exactly what happens. For a full
   * document there is nothing to wait for, and that writer's unsent edits stay
   * local; other clients are unaffected.
   */
  private accept(raw: unknown, replicaId: string, accepted: SequencedOp[]): string | null {
    const op = parseFugueOp(raw);
    if (op === null) return "malformed op";
    if (op.id.replicaId !== replicaId) return "op id does not belong to this connection's replica";
    if (op.type === "insert" && op.char.length > MAX_CHAR_LENGTH) return "char too long";

    // Duplicates and gaps are decided from the version vector alone, without the document.
    const applied = this.vv.get(replicaId) ?? 0;
    if (op.id.counter < applied) return null;
    if (op.id.counter > applied) return `op ${op.id.counter} is out of order (expected ${applied})`;
    if (op.type === "insert" && this.elements >= this.maxElements) return `document is full (${this.maxElements} elements)`;
    if (!this.spend(replicaId, 1)) return RATE_LIMITED;

    const doc = this.materialize();
    try {
      if (!doc.isDeliverable(op)) return `op ${op.id.counter} references ops the relay does not have`;
    } catch (err) {
      return err instanceof Error ? err.message : "malformed op";
    }
    doc.applyRemoteOp(op);
    this.vv.set(replicaId, applied + 1);
    if (op.type === "insert") this.elements++;
    this.length = doc.length;
    accepted.push({ seq: ++this.seq, op });
    return null;
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    const { replicaId, cursor } = ws.deserializeAttachment() as Attachment;
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    if (cursor !== undefined) this.broadcast({ type: "presence", replicaId, cursor: null, gone: true }, ws);
    // Likely the prelude to hibernation: do not leave ops in memory.
    this.flush();
  }

  override webSocketError(): void {
    this.flush();
  }

  // ---------------------------------------------------------------- rate limiting

  /** Token bucket per replica. In memory only: an eviction refills it, which is harmless. */
  private spend(replicaId: string, cost: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(replicaId);
    if (bucket === undefined) this.buckets.set(replicaId, (bucket = { tokens: this.rateBurst, at: now }));
    bucket.tokens = Math.min(this.rateBurst, bucket.tokens + ((now - bucket.at) / 1000) * this.ratePerSecond);
    bucket.at = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /**
   * Closes a connection that is over its allowance. Whatever was accepted stays
   * accepted; the client keeps the rest as unacknowledged and resends it when it
   * reconnects, by which time the bucket has refilled.
   */
  private rateLimit(ws: WebSocket): void {
    this.send(ws, { type: "error", message: "rate limited: slow down and reconnect" });
    try {
      ws.close(CLOSE_RATE_LIMITED, "rate limited");
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------- batched persistence

  private scheduleFlush(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    void this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }

  override async alarm(): Promise<void> {
    if (this.alarmScheduled) {
      this.flush();
      await this.compactIfDue();
      return;
    }
    if (this.ttlMs > 0 && this.lastActive !== null) {
      if (Date.now() < this.lastActive + this.ttlMs) {
        this.rearm(); // fired early; nothing is due
      } else if (this.ctx.getWebSockets().length > 0) {
        this.touch(); // someone is still connected: count that as activity
      } else {
        await this.expire();
      }
      return;
    }
    // Scheduled by a previous instance that never got to flush.
    if (this.buffer.length === 0) this.declareLoss();
  }

  /** Writes the buffered ops as one row per ~250 kB and acks every connected client. */
  private flush(): void {
    const hadAlarm = this.alarmScheduled;
    this.alarmScheduled = false;
    if (this.buffer.length === 0) {
      if (hadAlarm) this.rearm();
      return;
    }

    const buffer = this.buffer;
    this.durableSeq = this.seq;
    this.lastActive = Date.now();
    this.ctx.storage.transactionSync(() => {
      let firstSeq = (buffer[0] as SequencedOp).seq;
      let parts: string[] = [];
      let size = 0;
      const writeRow = (lastSeq: number): void => {
        this.sql.exec("INSERT INTO op_batches (first_seq, last_seq, ops) VALUES (?, ?, ?)", firstSeq, lastSeq, `[${parts.join(",")}]`);
        firstSeq = lastSeq + 1;
        parts = [];
        size = 0;
      };
      for (const { seq, op } of buffer) {
        const json = JSON.stringify(op);
        if (size + json.length > MAX_CHUNK_CHARS && parts.length > 0) writeRow(seq - 1);
        parts.push(json);
        size += json.length + 1;
      }
      writeRow(this.seq);
      this.writeSummary();
    });
    this.buffer = [];
    this.rearm();

    for (const ws of this.ctx.getWebSockets()) {
      const { replicaId } = ws.deserializeAttachment() as Attachment;
      this.send(ws, this.ackFor(replicaId));
    }
  }

  private ackFor(replicaId: string): ServerMessage {
    return { type: "ack", seq: this.durableSeq, epoch: this.epoch, counter: this.vv.get(replicaId) ?? 0 };
  }

  // ---------------------------------------------------------------- expiry of idle documents

  private expiryTime(): number | null {
    return this.ttlMs > 0 && this.lastActive !== null ? this.lastActive + this.ttlMs : null;
  }

  /** Leaves exactly one alarm behind when no flush is pending: the expiry alarm, or none. */
  private rearm(): void {
    const expiry = this.expiryTime();
    if (expiry === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(expiry);
  }

  /** Records activity (a connection, or the object first coming to life) and pushes the expiry alarm out. */
  private touch(): void {
    if (this.ttlMs === 0) return;
    this.lastActive = Date.now();
    this.writeSummary();
    if (!this.alarmScheduled) this.rearm();
  }

  /**
   * Deletes the document and everything stored for it. A client that still
   * remembers it reconnects with a sequence number the empty document does not
   * have, so it is sent the (empty) snapshot and starts over.
   */
  private async expire(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.doc = null;
    this.vv = new Map();
    this.elements = 0;
    this.length = 0;
    this.lastActive = null;
    this.buffer = [];
    this.buckets.clear();
    this.rehydrate();
  }

  // ---------------------------------------------------------------- snapshots and compaction

  /**
   * Folds the applied log into a snapshot once enough ops have accumulated, then
   * trims the log to a short tail. Runs from the alarm, right after a flush, so
   * the in-memory document is exactly the durable state at `durableSeq`.
   *
   * If an R2 bucket is bound, the snapshot being replaced and the log rows being
   * dropped are copied there first; nothing is deleted from SQLite unless that
   * succeeded. Without a bucket they are simply discarded: the new snapshot
   * already contains everything needed to serve the document.
   */
  private async compactIfDue(): Promise<void> {
    if (this.compacting || this.buffer.length > 0 || this.durableSeq - this.snapshotSeq < this.snapshotEvery) return;
    this.compacting = true;
    try {
      // Captured synchronously: both describe the document at exactly `seq`,
      // whatever arrives while the archive uploads are awaited below.
      const seq = this.durableSeq;
      const state = this.materialize().encode();
      const cutoff = seq - this.logTail;

      const bucket = this.env.SNAPSHOT_ARCHIVE;
      if (bucket !== undefined) {
        const prefix = this.docId ?? this.ctx.id.toString();
        const previous = this.readSnapshot();
        if (previous !== null) await bucket.put(`${prefix}/snapshot-${pad(this.snapshotSeq)}.fgm`, previous);
        const dropped = this.sql
          .exec<{ first_seq: number; last_seq: number; ops: string }>(
            "SELECT first_seq, last_seq, ops FROM op_batches WHERE last_seq <= ? ORDER BY first_seq",
            cutoff,
          )
          .toArray();
        for (const row of dropped) {
          await bucket.put(`${prefix}/ops-${pad(row.first_seq)}-${pad(row.last_seq)}.json`, row.ops);
        }
      }

      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM snapshot_chunks");
        for (let i = 0; i * MAX_CHUNK_BYTES < Math.max(state.length, 1); i++) {
          const chunk = state.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
          this.sql.exec("INSERT INTO snapshot_chunks (idx, data) VALUES (?, ?)", i, chunk.buffer);
        }
        this.writeMeta("snapshot_seq", String(seq));
        this.sql.exec("DELETE FROM op_batches WHERE last_seq <= ?", cutoff);
      });
      this.snapshotSeq = seq;
      this.logStart = this.computeLogStart();
    } catch (err) {
      // Compaction is an optimisation; the log is intact, so try again next time.
      console.error("compaction failed", err);
    } finally {
      this.compacting = false;
    }
  }

  // ---------------------------------------------------------------- sending

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket is gone; its close handler will run.
    }
  }

  private broadcast(message: ServerMessage, except: WebSocket | null): void {
    const frame = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(frame);
      } catch {
        // see send()
      }
    }
  }
}

function presenceOf(attachment: Attachment): ServerMessage {
  const cursor = attachment.cursor ?? null;
  return {
    type: "presence",
    replicaId: attachment.replicaId,
    cursor: cursor === null ? null : { replicaId: cursor[0], counter: cursor[1] },
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Zero-padded so archive keys sort in sequence order. */
function pad(seq: number): string {
  return String(seq).padStart(12, "0");
}
