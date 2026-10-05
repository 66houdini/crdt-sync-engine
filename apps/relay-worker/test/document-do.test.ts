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
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return; // a connection we already abandoned
      const message = JSON.parse(event.data as string) as ServerMessage;
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
  (await (await SELF.fetch(`https://relay.test/doc/${docId}/stats`)).json()) as Record<string, number>;
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
