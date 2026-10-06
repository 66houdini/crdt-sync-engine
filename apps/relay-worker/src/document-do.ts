import { DurableObject } from "cloudflare:workers";
import { FugueMax, type FugueOp, parseFugueOp } from "@crdt/core";
import type { Env } from "./env";
import { REPLICA_ID_PATTERN, SERVER_REPLICA_ID, type SequencedOp, type ServerMessage } from "./protocol";

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
/** Fold the log into a snapshot once this many ops have accumulated since the last one. */
const DEFAULT_SNAPSHOT_EVERY_OPS = 5000;
/** Ops kept in the log behind a snapshot, so recently connected clients can still catch up incrementally. */
const DEFAULT_LOG_TAIL_OPS = 1000;

interface Attachment {
  replicaId: string;
}

/**
 * One instance per document: a relay that orders, persists and fans out FugueMax ops.
 *
 * Free-tier shape:
 *  - WebSocket Hibernation API, so an idle document costs no duration.
 *  - Ops are applied and broadcast immediately but persisted in batches: one SQLite
 *    row per flush, not per keystroke. A burst of typing costs two row writes
 *    (the alarm and the batch) per FLUSH_INTERVAL_MS.
 *  - Nothing that must survive hibernation lives only in memory: the document is
 *    rebuilt from SQLite in the constructor and each socket's replica id is stored
 *    in its attachment.
 *  - Storage is bounded by the document, not its history: the log is periodically
 *    folded into a compact binary snapshot and only a short tail of recent ops is
 *    kept. Superseded snapshots and log segments go to R2 if a bucket is bound.
 *
 * Losing the un-flushed buffer (crash or eviction before the alarm) is detected,
 * not ignored: a pending alarm that this instance did not schedule means a previous
 * instance died with ops in memory. The document epoch is then bumped and every
 * client is told to resync from the snapshot and resend what was never acked.
 */
export class DocumentDO extends DurableObject<Env> {
  private doc = new FugueMax(SERVER_REPLICA_ID);
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
  private buffer: SequencedOp[] = [];
  /** True iff this instance has an alarm pending for its own buffer. */
  private alarmScheduled = false;
  private compacting = false;
  /** Changes whenever the object is constructed afresh; lets a client tell a cold start from a warm request. */
  private readonly instance = crypto.randomUUID();
  private readonly snapshotEvery: number;
  private readonly logTail: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.snapshotEvery = positiveInt(env.SNAPSHOT_EVERY_OPS, DEFAULT_SNAPSHOT_EVERY_OPS);
    this.logTail = positiveInt(env.LOG_TAIL_OPS, DEFAULT_LOG_TAIL_OPS);
    void ctx.blockConcurrencyWhile(async () => {
      this.rehydrate();
      // An alarm we did not schedule belongs to a previous instance whose buffer is gone.
      if ((await ctx.storage.getAlarm()) !== null) {
        await ctx.storage.deleteAlarm();
        this.declareLoss();
      }
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private rehydrate(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS op_batches (first_seq INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL, ops TEXT NOT NULL)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS snapshot_chunks (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.epoch = Number(this.readMeta("epoch") ?? 0);
    this.docId = this.readMeta("doc_id");
    this.snapshotSeq = Number(this.readMeta("snapshot_seq") ?? 0);

    const snapshot = this.readSnapshot();
    if (snapshot !== null) this.doc = FugueMax.decode(snapshot, SERVER_REPLICA_ID);
    this.seq = this.snapshotSeq;

    // Replay only what the snapshot does not already contain. Rows at or below the
    // snapshot are the retained tail, kept for client catch-up.
    for (const row of this.sql.exec<{ last_seq: number; ops: string }>(
      "SELECT last_seq, ops FROM op_batches WHERE last_seq > ? ORDER BY first_seq",
      this.snapshotSeq,
    )) {
      for (const op of JSON.parse(row.ops) as FugueOp[]) this.doc.applyRemoteOp(op);
      this.seq = row.last_seq;
    }
    this.durableSeq = this.seq;
    this.logStart = this.computeLogStart();
  }

  private computeLogStart(): number {
    const first = this.sql.exec<{ first: number | null }>("SELECT MIN(first_seq) AS first FROM op_batches").one().first;
    return first === null ? this.durableSeq : first - 1;
  }

  private readSnapshot(): Uint8Array | null {
    const chunks = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM snapshot_chunks ORDER BY idx")
      .toArray()
      .map((row) => new Uint8Array(row.data));
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

    if (route === "text") return new Response(this.doc.toString());
    if (route === "stats") {
      return Response.json({
        instance: this.instance,
        seq: this.seq,
        durableSeq: this.durableSeq,
        snapshotSeq: this.snapshotSeq,
        logStart: this.logStart,
        epoch: this.epoch,
        buffered: this.buffer.length,
        length: this.doc.length,
        tombstones: this.doc.tombstoneCount,
        connections: this.ctx.getWebSockets().length,
      });
    }
    if (route !== "ws") return new Response("not found", { status: 404 });

    const replicaId = url.searchParams.get("replica") ?? "";
    if (!REPLICA_ID_PATTERN.test(replicaId) || replicaId === SERVER_REPLICA_ID) {
      return new Response("missing or invalid ?replica=", { status: 400 });
    }

    // A replica id identifies one writer; a second connection replaces the first.
    for (const stale of this.ctx.getWebSockets(replicaId)) stale.close(4001, "replaced by a newer connection");

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [replicaId]);
    server.serializeAttachment({ replicaId } satisfies Attachment);

    // Make everything durable first, so every sequence number the client is about to learn is stable.
    this.flush();
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
      let page: SequencedOp[] = [];
      for (const row of this.sql.exec<{ first_seq: number; ops: string }>(
        "SELECT first_seq, ops FROM op_batches WHERE last_seq > ? ORDER BY first_seq",
        since,
      )) {
        (JSON.parse(row.ops) as FugueOp[]).forEach((op, i) => {
          const seq = row.first_seq + i;
          if (seq > since) page.push({ seq, op });
        });
        if (page.length >= 500) {
          this.send(ws, { type: "ops", ops: page });
          page = [];
        }
      }
      if (page.length > 0) this.send(ws, { type: "ops", ops: page });
    } else {
      // Full state, in the compact binary encoding: a header, then that many binary frames.
      const state = this.doc.encode();
      const frames = Math.max(1, Math.ceil(state.length / MAX_CHUNK_BYTES));
      this.send(ws, { type: "snapshot", frames });
      for (let i = 0; i < frames; i++) {
        try {
          ws.send(state.subarray(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES));
        } catch {
          return;
        }
      }
    }
    this.send(ws, { type: "synced", seq: this.durableSeq, epoch: this.epoch, counter: this.doc.appliedCount(replicaId) });
  }

  // ---------------------------------------------------------------- WebSocket (hibernation API)

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const { replicaId } = ws.deserializeAttachment() as Attachment;
    if (typeof message !== "string" || message.length > MAX_INCOMING_CHARS) {
      this.send(ws, { type: "error", message: "expected a JSON text frame of at most 250k characters" });
      return;
    }

    let rawOps: unknown;
    try {
      const parsed = JSON.parse(message) as { type?: unknown; ops?: unknown };
      rawOps = parsed.type === "ops" ? parsed.ops : undefined;
    } catch {
      rawOps = undefined;
    }
    if (!Array.isArray(rawOps)) {
      this.send(ws, { type: "error", message: 'expected {"type":"ops","ops":[...]}' });
      return;
    }

    const accepted: SequencedOp[] = [];
    for (const raw of rawOps) {
      const problem = this.accept(raw, replicaId, accepted);
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
    } else if (this.buffer.length === 0) {
      // Pure resend of ops that are already durable: confirm right away.
      this.send(ws, this.ackFor(replicaId));
    }
  }

  /** Validates and applies one incoming op. Returns an error description, or null on success / duplicate. */
  private accept(raw: unknown, replicaId: string, accepted: SequencedOp[]): string | null {
    const op = parseFugueOp(raw);
    if (op === null) return "malformed op";
    if (op.id.replicaId !== replicaId) return "op id does not belong to this connection's replica";
    if (op.type === "insert" && op.char.length > MAX_CHAR_LENGTH) return "char too long";
    if (this.doc.hasApplied(op.id)) return null;
    try {
      if (!this.doc.isDeliverable(op)) return `op ${op.id.counter} is not deliverable (out of order, or it references ops the relay does not have)`;
    } catch (err) {
      return err instanceof Error ? err.message : "malformed op";
    }
    this.doc.applyRemoteOp(op);
    accepted.push({ seq: ++this.seq, op });
    return null;
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    // Likely the prelude to hibernation: do not leave ops in memory.
    this.flush();
  }

  override webSocketError(): void {
    this.flush();
  }

  // ---------------------------------------------------------------- batched persistence

  private scheduleFlush(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    void this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }

  override async alarm(): Promise<void> {
    if (!this.alarmScheduled) {
      // Scheduled by a previous instance that never got to flush.
      if (this.buffer.length === 0) this.declareLoss();
      return;
    }
    this.alarmScheduled = false;
    this.flush();
    await this.compactIfDue();
  }

  /** Writes the buffered ops as one row per ~250 kB and acks every connected client. */
  private flush(): void {
    if (this.alarmScheduled) {
      this.alarmScheduled = false;
      void this.ctx.storage.deleteAlarm();
    }
    if (this.buffer.length === 0) return;

    const buffer = this.buffer;
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
    });
    this.buffer = [];
    this.durableSeq = this.seq;

    for (const ws of this.ctx.getWebSockets()) {
      const { replicaId } = ws.deserializeAttachment() as Attachment;
      this.send(ws, this.ackFor(replicaId));
    }
  }

  private ackFor(replicaId: string): ServerMessage {
    return { type: "ack", seq: this.durableSeq, epoch: this.epoch, counter: this.doc.appliedCount(replicaId) };
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
      const state = this.doc.encode();
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

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Zero-padded so archive keys sort in sequence order. */
function pad(seq: number): string {
  return String(seq).padStart(12, "0");
}
