import { SELF, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ClientSession } from "../src/client";
import type { ServerMessage } from "../src/protocol";

let docCounter = 0;
const freshDocId = (): string => `doc-${++docCounter}`;
const stubFor = (docId: string) => env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(docId));

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function untilAsync(condition: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** A ClientSession wired to a real WebSocket against the worker, with automatic resync. */
class TestClient {
  readonly session: ClientSession;
  readonly received: ServerMessage[] = [];
  ws: WebSocket | null = null;
  closeCode: number | null = null;
  synced = false;
  binaryFrames = 0;

  constructor(
    readonly docId: string,
    replicaId: string,
  ) {
    this.session = new ClientSession(replicaId);
  }

  static async open(docId: string, replicaId: string): Promise<TestClient> {
    const client = new TestClient(docId, replicaId);
    await client.connect();
    return client;
  }

  async connect(): Promise<void> {
    this.synced = false;
    const res = await SELF.fetch(`https://relay.test/doc/${this.docId}/ws?${this.session.connectQuery()}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return; // a connection we already abandoned
      if (typeof event.data !== "string") {
        this.binaryFrames++;
        this.session.receive(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      const message = JSON.parse(event.data) as ServerMessage;
      this.received.push(message);
      const result = this.session.receive(message);
      if (message.type === "synced") this.synced = true;
      for (const out of result.send) ws.send(JSON.stringify(out));
      if (result.reconnect) {
        this.ws = null;
        ws.close(1000, "resync");
        void this.connect();
      }
    });
    ws.addEventListener("close", (event) => {
      if (this.ws === ws) {
        this.ws = null;
        this.closeCode = event.code;
      }
    });
    await until(() => this.synced, `${this.session.replicaId} synced`);
  }

  private push(messages: unknown[]): void {
    if (this.ws !== null) for (const m of messages) this.ws.send(JSON.stringify(m));
  }

  type(index: number, text: string): void {
    this.push(this.session.insert(index, text));
  }

  erase(index: number, count = 1): void {
    this.push(this.session.delete(index, count));
  }

  caret(index: number): void {
    this.push([this.session.presence(index)]);
  }

  errors(): string[] {
    return this.received.flatMap((m) => (m.type === "error" ? [m.message] : []));
  }

  disconnect(): void {
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  get text(): string {
    return this.session.text;
  }

  count(type: ServerMessage["type"]): number {
    return this.received.filter((m) => m.type === type).length;
  }
}

const serverText = async (docId: string): Promise<string> => (await SELF.fetch(`https://relay.test/doc/${docId}/text`)).text();
const serverStats = async (docId: string) =>
  (await (await SELF.fetch(`https://relay.test/doc/${docId}/stats`)).json()) as Record<string, unknown>;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const batchRows = (docId: string): Promise<number> =>
  runInDurableObject(stubFor(docId), (_instance, state) =>
    Number(state.storage.sql.exec("SELECT COUNT(*) AS c FROM op_batches").one().c),
  );

describe("DocumentDO relay", () => {
  it("relays concurrent edits between two clients and converges with the server", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    const bob = await TestClient.open(docId, "bob");

    // Both type at the same position before either has seen the other's ops.
    alice.type(0, "hello");
    bob.type(0, "world");
    await until(() => alice.text.length === 10 && bob.text.length === 10, "both see 10 chars");

    expect(alice.text).toBe(bob.text);
    expect(await serverText(docId)).toBe(alice.text);
    // FugueMax: the concurrent words are not interleaved.
    expect(alice.text.includes("hello") && alice.text.includes("world")).toBe(true);
    expect(JSON.stringify(alice.session.doc.toJSON().nodes)).toBe(JSON.stringify(bob.session.doc.toJSON().nodes));
  });

  it("batches persistence: many messages become one row, written by the alarm, and only then acked", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    for (let i = 0; i < 40; i++) alice.type(i, "x");
    await untilAsync(async () => (await serverStats(docId)).seq === 40, "relay applied all 40");
    const stats = await serverStats(docId);
    expect(stats.seq).toBe(40);
    expect(stats.buffered).toBe(40);
    expect(stats.durableSeq).toBe(0);
    expect(await batchRows(docId)).toBe(0);
    expect(alice.session.unackedCount).toBe(40);

    expect(await runDurableObjectAlarm(stubFor(docId))).toBe(true);
    expect(await batchRows(docId)).toBe(1);
    await until(() => alice.session.unackedCount === 0, "ack after flush");
    expect((await serverStats(docId)).durableSeq).toBe(40);
  });

  it("survives hibernation: state is rebuilt from SQLite and sockets keep their replica id", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    const bob = await TestClient.open(docId, "bob");
    alice.type(0, "before ");
    await until(() => bob.text === "before ", "bob sees first edit");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "flushed");

    // Tear down the in-memory instance; hibernatable sockets stay connected.
    await evictDurableObject(stubFor(docId));

    alice.type(7, "after");
    await until(() => bob.text === "before after", "bob sees the edit made after eviction");
    expect(await serverText(docId)).toBe("before after");
    // Nothing was lost, so nobody was told to resync.
    expect(alice.count("resync") + bob.count("resync")).toBe(0);
    expect((await serverStats(docId)).connections).toBe(2);
  });

  it("reconciles a client that was cut off mid-edit and kept typing offline", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    const bob = await TestClient.open(docId, "bob");
    alice.type(0, "shared");
    await until(() => bob.text === "shared", "initial sync");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "flushed");

    bob.disconnect();
    bob.type(6, " +bob-offline");
    alice.type(0, "alice-online+ ");
    await until(() => alice.text === "alice-online+ shared", "alice applied her own edit");
    expect(bob.text).toBe("shared +bob-offline");

    const before = bob.received.length;
    await bob.connect();
    await until(() => bob.text === alice.text, "converged after reconnect");
    expect(bob.text).toBe("alice-online+ shared +bob-offline");
    expect(await serverText(docId)).toBe(bob.text);
    // The reconnect was incremental: only the missed ops were sent, not a snapshot.
    expect(bob.received.slice(before).some((m) => m.type === "snapshot")).toBe(false);
    expect(bob.received.slice(before).some((m) => m.type === "ops")).toBe(true);
  });

  it("sends a new client a snapshot, and a returning replica id resumes its counter", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    alice.type(0, "abc");
    alice.erase(1);
    await untilAsync(async () => (await serverText(docId)) === "ac", "relay applied the edits");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "flushed");
    alice.disconnect();

    // Same replica id, brand new process with no local state.
    const again = await TestClient.open(docId, "alice");
    expect(again.count("snapshot")).toBeGreaterThan(0);
    expect(again.text).toBe("ac");
    again.type(2, "!");
    const carol = await TestClient.open(docId, "carol");
    await until(() => carol.text === "ac!", "carol sees the resumed replica's edit");
    expect(again.session.doc.appliedCount("alice")).toBe(5);
  });

  it("detects a lost un-flushed buffer, bumps the epoch, and clients resync without losing their edits", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    const bob = await TestClient.open(docId, "bob");
    alice.type(0, "durable");
    await until(() => bob.text === "durable", "first edit relayed");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "flushed");

    // Relayed to bob but still only in the relay's memory when the instance dies.
    alice.type(7, " volatile");
    await until(() => bob.text === "durable volatile", "second edit relayed");
    expect((await serverStats(docId)).buffered).toBe(9);
    await evictDurableObject(stubFor(docId));

    // The new instance finds the orphaned alarm and tells everyone to resync.
    expect((await serverStats(docId)).epoch).toBe(1);
    await until(() => alice.count("resync") === 1 && bob.count("resync") === 1, "resync notices");
    await until(() => alice.synced && bob.synced, "both reconnected");
    await untilAsync(async () => (await serverText(docId)) === "durable volatile", "alice resent the lost ops");
    await until(() => bob.text === "durable volatile", "bob has the edit again");

    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "resent ops acked");
    expect((await serverStats(docId)).durableSeq).toBe(16);
    expect(alice.text).toBe(bob.text);
  });

  it("folds the log into a snapshot, trims it to a tail, archives to R2, and still rehydrates", async () => {
    // The test configuration snapshots every 30 ops and keeps a 10-op tail.
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    const burst = async (n: number): Promise<void> => {
      alice.type(alice.text.length, String.fromCharCode(96 + n).repeat(12));
      await untilAsync(async () => (await serverStats(docId)).seq === n * 12, `burst ${n} applied`);
      await runDurableObjectAlarm(stubFor(docId));
      await until(() => alice.session.unackedCount === 0, `burst ${n} acked`);
    };

    await burst(1);
    const early = await TestClient.open(docId, "early"); // synced at seq 12
    early.disconnect();
    await burst(2);
    expect((await serverStats(docId)).snapshotSeq).toBe(0);
    expect(await batchRows(docId)).toBe(2);

    await burst(3); // 36 ops since the (absent) snapshot: compaction runs
    let stats = await serverStats(docId);
    expect(stats.snapshotSeq).toBe(36);
    expect(stats.logStart).toBe(24); // only the batch covering seq 25..36 is kept as the tail
    expect(await batchRows(docId)).toBe(1);

    const archive = env.SNAPSHOT_ARCHIVE as R2Bucket;
    const keys = async (): Promise<string[]> => (await archive.list({ prefix: `${docId}/` })).objects.map((o) => o.key);
    expect(await keys()).toEqual([`${docId}/ops-000000000001-000000000012.json`, `${docId}/ops-000000000013-000000000024.json`]);
    const archived = JSON.parse(await (await archive.get(`${docId}/ops-000000000001-000000000012.json`))!.text()) as unknown[];
    expect(archived).toHaveLength(12);

    const recent = await TestClient.open(docId, "recent"); // synced at seq 36
    recent.disconnect();
    await burst(4);

    // A cold start now loads the snapshot and replays only the ops after it.
    await evictDurableObject(stubFor(docId));
    const expected = "a".repeat(12) + "b".repeat(12) + "c".repeat(12) + "d".repeat(12);
    expect(await serverText(docId)).toBe(expected);
    expect((await serverStats(docId)).seq).toBe(48);

    // A client whose position is still inside the log tail catches up incrementally...
    await recent.connect();
    expect(recent.text).toBe(expected);
    expect(recent.count("snapshot")).toBe(1); // only the one from its very first connection
    // ...one that fell behind the tail gets a fresh (binary) snapshot instead.
    const framesBefore = early.binaryFrames;
    await early.connect();
    expect(early.text).toBe(expected);
    expect(early.count("snapshot")).toBe(2);
    expect(early.binaryFrames).toBe(framesBefore + 1);

    // The next compaction archives the snapshot it replaces.
    await burst(5);
    await burst(6); // seq 72: 36 ops past the snapshot
    stats = await serverStats(docId);
    expect(stats.snapshotSeq).toBe(72);
    expect(await keys()).toContain(`${docId}/snapshot-000000000036.fgm`);
    await evictDurableObject(stubFor(docId));
    expect(await serverText(docId)).toBe(expected + "e".repeat(12) + "f".repeat(12));
  });

  it("serves connections and stats after a cold start without rebuilding the document", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    alice.type(0, "lazy relay");
    await untilAsync(async () => (await serverStats(docId)).seq === 10, "applied");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "flushed");
    alice.disconnect();
    await evictDurableObject(stubFor(docId));

    // Reads are answered from the summary row, the stored snapshot and the log.
    expect((await serverStats(docId)).materialized).toBe(false);
    const bob = await TestClient.open(docId, "bob");
    expect(bob.text).toBe("lazy relay");
    await alice.connect(); // incremental reconnect
    expect(alice.text).toBe("lazy relay");
    const stats = await serverStats(docId);
    expect(stats.materialized).toBe(false);
    expect(stats.length).toBe(10);
    expect(stats.seq).toBe(10);

    // The first op that has to be validated builds the document.
    bob.type(10, "!");
    await until(() => alice.text === "lazy relay!", "relayed");
    expect((await serverStats(docId)).materialized).toBe(true);
    expect(await serverText(docId)).toBe("lazy relay!");
  });

  it("a client's unconfirmed edits survive a full state transfer that arrives as snapshot plus later ops", async () => {
    // Snapshot every 30 ops: after 36 ops the stored snapshot is behind the log by nothing,
    // after 48 it is behind by 12, so a full sync is "snapshot at 36, then ops 37..48".
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    for (let n = 1; n <= 4; n++) {
      alice.type(alice.text.length, String(n).repeat(12));
      await untilAsync(async () => (await serverStats(docId)).seq === n * 12, `burst ${n}`);
      await runDurableObjectAlarm(stubFor(docId));
      await until(() => alice.session.unackedCount === 0, `burst ${n} acked`);
    }
    expect((await serverStats(docId)).snapshotSeq).toBe(36);

    // Bob syncs, goes offline, and types right after the newest text (which is not in the snapshot).
    const bob = await TestClient.open(docId, "bob");
    bob.disconnect();
    bob.type(48, " <- bob was here");
    // Force bob through a full state transfer on his next connection.
    await runInDurableObject(stubFor(docId), (instance) => {
      (instance as unknown as { epoch: number }).epoch = 7;
    });
    await bob.connect();
    expect(bob.count("snapshot")).toBe(2);
    await until(() => alice.text === bob.text && bob.text.endsWith("444444444444 <- bob was here"), "bob's edits were kept and relayed");
    expect(await serverText(docId)).toBe(bob.text);
  });

  it("stops accepting inserts when a document is full", async () => {
    const docId = freshDocId(); // limit in the test configuration: 1000 elements
    const alice = await TestClient.open(docId, "alice");
    for (let round = 1; round <= 3; round++) {
      alice.type(alice.text.length, "x".repeat(390));
      const expected = Math.min(1000, round * 390);
      await untilAsync(async () => (await serverStats(docId)).seq === expected, `round ${round}`);
      await pause(1100); // let the rate limiter refill
    }
    const stats = await serverStats(docId);
    expect(stats.length).toBe(1000);
    expect(alice.errors().some((e) => e.includes("document is full"))).toBe(true);
    // The writer whose insert was refused is stuck: its later ops would leave a gap.
    alice.erase(0, 1);
    await until(() => alice.errors().some((e) => e.includes("out of order")), "later ops from the same writer are refused");
    expect((await serverStats(docId)).seq).toBe(1000);

    // Other clients can still delete, which frees nothing: tombstones count towards the limit.
    const bob = await TestClient.open(docId, "bob");
    expect(bob.text.length).toBe(1000);
    bob.erase(0, 5);
    await untilAsync(async () => (await serverStats(docId)).seq === 1005, "deletes accepted");
    expect((await serverStats(docId)).length).toBe(995);
    bob.type(0, "z");
    await until(() => bob.errors().some((e) => e.includes("document is full")), "still full");
  });

  it("rate-limits a flood, and the client's edits still all arrive once it reconnects", async () => {
    const docId = freshDocId(); // burst in the test configuration: 400 ops
    const alice = await TestClient.open(docId, "alice");
    const bob = await TestClient.open(docId, "bob");
    alice.type(0, "y".repeat(500));
    await until(() => alice.closeCode === 4008, "closed for flooding");
    expect(alice.errors().some((e) => e.includes("rate limited"))).toBe(true);
    const accepted = (await serverStats(docId)).seq as number;
    expect(accepted).toBeGreaterThan(300);
    expect(accepted).toBeLessThan(500);

    await pause(1200);
    await alice.connect(); // resends what was never accepted
    await untilAsync(async () => (await serverStats(docId)).seq === 500, "the rest arrived");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "acked");
    await until(() => bob.text.length === 500, "bob has all of it");
    expect(bob.text).toBe(alice.text);
  });

  it("deletes a document that has been idle past its time-to-live", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    alice.type(0, "temporary");
    await untilAsync(async () => (await serverStats(docId)).seq === 9, "applied");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.session.unackedCount === 0, "flushed");

    // Not yet due: an alarm that fires early changes nothing.
    await runDurableObjectAlarm(stubFor(docId));
    expect(await serverText(docId)).toBe("temporary");

    // Pretend the last activity was two hours ago (the configured TTL is one hour).
    alice.disconnect();
    await untilAsync(async () => (await serverStats(docId)).connections === 0, "disconnected");
    await runInDurableObject(stubFor(docId), async (instance, state) => {
      const past = Date.now() - 2 * 3600_000;
      (instance as unknown as { lastActive: number }).lastActive = past;
      await state.storage.setAlarm(past + 3600_000);
    });
    await untilAsync(async () => (await serverStats(docId)).seq === 0, "expired");
    expect(await serverText(docId)).toBe("");
    expect(
      await runInDurableObject(stubFor(docId), (_i, state) => Number(state.storage.sql.exec("SELECT COUNT(*) AS c FROM op_batches").one().c)),
    ).toBe(0);

    // A client that remembers the old document is reset to the empty one.
    await alice.connect();
    expect(alice.text).toBe("");
  });

  it("relays carets as stable cursors, tells newcomers who is here, and announces departures", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    const bob = await TestClient.open(docId, "bob");
    alice.type(0, "hello");
    await until(() => bob.text === "hello", "text relayed");
    alice.caret(5);
    await until(() => bob.session.peerCarets().length === 1, "bob sees alice");
    expect(bob.session.peerCarets()).toEqual([{ replicaId: "alice", index: 5 }]);

    // Bob types in front: alice's caret, as bob sees it, moves with her text.
    bob.type(0, ">> ");
    expect(bob.session.peerCarets()).toEqual([{ replicaId: "alice", index: 8 }]);

    // Presence survives hibernation (it lives in the socket attachment) and reaches newcomers.
    await untilAsync(async () => (await serverStats(docId)).seq === 8, "applied");
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => bob.session.unackedCount === 0, "flushed");
    await evictDurableObject(stubFor(docId));
    const carol = await TestClient.open(docId, "carol");
    expect(carol.session.peerCarets()).toEqual([{ replicaId: "alice", index: 8 }]);

    alice.disconnect();
    await until(() => bob.session.peerCarets().length === 0 && carol.session.peerCarets().length === 0, "alice left");
  });

  it("detects a lost buffer even when the orphaned alarm is what wakes the object", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    alice.type(0, "volatile");
    await untilAsync(async () => (await serverStats(docId)).buffered === 8, "buffered, not flushed");
    await evictDurableObject(stubFor(docId));
    await runDurableObjectAlarm(stubFor(docId));
    await until(() => alice.count("resync") === 1, "told to resync");
    await until(() => alice.synced, "reconnected");
    await untilAsync(async () => (await serverText(docId)) === "volatile", "resent");
    expect((await serverStats(docId)).epoch).toBe(1);
  });

  it("rejects malformed and spoofed ops without disturbing the document", async () => {
    const docId = freshDocId();
    const alice = await TestClient.open(docId, "alice");
    alice.type(0, "ok");
    const ws = alice.ws as WebSocket;
    ws.send("not json");
    ws.send(JSON.stringify({ type: "ops", ops: [{ type: "insert", id: { replicaId: "mallory", counter: 0 }, char: "!", parent: null, side: "right", rightOrigin: null }] }));
    ws.send(JSON.stringify({ type: "ops", ops: [{ type: "insert", id: { replicaId: "alice", counter: 99 }, char: "!", parent: null, side: "right", rightOrigin: null }] }));
    await until(() => alice.count("error") === 3, "three errors");
    expect(await serverText(docId)).toBe("ok");
    expect((await serverStats(docId)).seq).toBe(2);
  });

  it("validates the replica id and replaces an older connection from the same replica", async () => {
    const docId = freshDocId();
    const bad = await SELF.fetch(`https://relay.test/doc/${docId}/ws?replica=server`, { headers: { Upgrade: "websocket" } });
    expect(bad.status).toBe(400);
    expect((await SELF.fetch(`https://relay.test/doc/${docId}/ws?replica=a`)).status).toBe(426);

    const first = await TestClient.open(docId, "alice");
    const second = await TestClient.open(docId, "alice");
    await until(() => first.closeCode === 4001, "first connection closed as replaced");
    expect(second.ws).not.toBeNull();
    expect((await serverStats(docId)).connections).toBe(1);
  });
});
