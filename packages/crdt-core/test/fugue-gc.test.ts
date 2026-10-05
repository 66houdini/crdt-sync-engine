import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FugueMax, type FugueHeartbeat, type FugueOp, Prng } from "../src/index";

const MEMBERS = ["a", "b", "c"];

function trio(): [FugueMax, FugueMax, FugueMax] {
  return MEMBERS.map((id) => {
    const doc = new FugueMax(id);
    doc.enableGc(MEMBERS);
    return doc;
  }) as [FugueMax, FugueMax, FugueMax];
}

function deliver(docs: readonly FugueMax[], ops: readonly FugueOp[]): void {
  for (const doc of docs) for (const op of ops) doc.applyRemoteOp(op);
}

/** Everyone tells everyone what they have applied and what they know to be stable. */
function gossip(docs: readonly FugueMax[], rounds = 1): void {
  for (let i = 0; i < rounds; i++) {
    const beats = docs.map((doc) => doc.heartbeat());
    for (const doc of docs) for (const hb of beats) doc.receiveHeartbeat(hb);
  }
}

const structure = (doc: FugueMax): string => JSON.stringify(doc.toJSON());

/** Tombstones that nothing references: after a complete collection there must be none. */
function unreferencedTombstones(doc: FugueMax): number {
  const { nodes } = doc.toJSON();
  const referenced = new Set<string>();
  for (const n of nodes) {
    if (n.parent !== null) referenced.add(n.parent.join(":"));
    if (n.rightOrigin !== null) referenced.add(n.rightOrigin.join(":"));
  }
  return nodes.filter((n) => n.deletedBy !== undefined && !referenced.has(n.id.join(":"))).length;
}

describe("FugueMax garbage collection", () => {
  it("removes a tombstone only after every member is known to have applied the delete and condemned it", () => {
    const [a, b, c] = trio();
    const typed = a.insertText(0, "abc");
    deliver([b, c], typed);
    const del = a.delete(2); // "c", a leaf nothing refers to
    expect(a.tombstoneCount).toBe(1);

    // Nobody else has even seen the delete.
    gossip([a, b, c], 3);
    expect(a.collectGarbage()).toBe(0);

    // b has it, c does not: still not stable.
    b.applyRemoteOp(del);
    gossip([a, b, c], 3);
    expect(a.collectGarbage()).toBe(0);
    expect(b.collectGarbage()).toBe(0);

    // Now everyone has applied it, but one round only tells each replica what the
    // others have applied; nobody yet knows that the others consider it stable.
    c.applyRemoteOp(del);
    gossip([a, b, c], 1);
    expect([a, b, c].map((d) => d.collectGarbage())).toEqual([0, 0, 0]);

    // Second round carries the stable cuts: now removal is safe everywhere.
    gossip([a, b, c], 1);
    expect([a, b, c].map((d) => d.collectGarbage())).toEqual([1, 1, 1]);
    for (const doc of [a, b, c]) {
      expect(doc.toString()).toBe("ab");
      expect(doc.tombstoneCount).toBe(0);
      expect(doc.nodeCount).toBe(2);
    }
    expect(structure(a)).toBe(structure(b));
    expect(structure(b)).toBe(structure(c));
  });

  it("is safe against the late concurrent op that makes early removal wrong", () => {
    // a deletes "b" while c, which has not seen the delete, types right before it.
    // c's insert becomes a left child of the tombstone and is delayed in the network.
    const [a, b, c] = trio();
    const typed = a.insertText(0, "abc");
    deliver([b, c], typed);

    const del = a.delete(1);
    b.applyRemoteOp(del);
    const late = c.insert(1, "X");
    expect(late.parent).toEqual(typed[1]!.id);
    expect(c.toString()).toBe("aXbc");

    // However much a and b gossip, c has not acknowledged the delete: the tombstone stays.
    gossip([a, b], 5);
    a.receiveHeartbeat(c.heartbeat());
    b.receiveHeartbeat(c.heartbeat());
    gossip([a, b], 5);
    expect(a.collectGarbage()).toBe(0);
    expect(a.tombstoneCount).toBe(1);

    // c learns of the delete and gossips before its own insert reaches anyone. The
    // heartbeat records that c had already issued that insert, so a and b must wait for it.
    c.applyRemoteOp(del);
    gossip([a, b, c], 5);
    expect(a.collectGarbage()).toBe(0);
    expect(b.collectGarbage()).toBe(0);

    // The late op arrives and can still be placed, because the tombstone is still there.
    a.applyRemoteOp(late);
    b.applyRemoteOp(late);
    expect(a.toString()).toBe("aXc");
    gossip([a, b, c], 5);
    for (const doc of [a, b, c]) doc.collectGarbage();
    // The tombstone now has a live child, so it stays as structure.
    for (const doc of [a, b, c]) {
      expect(doc.toString()).toBe("aXc");
      expect(doc.tombstoneCount).toBe(1);
    }
    expect(structure(a)).toBe(structure(c));
  });

  it("stops referencing condemned tombstones, so inserts made after removal elsewhere still apply", () => {
    const [a, b, c] = trio();
    const typed = a.insertText(0, "abc");
    deliver([b, c], typed);
    const del = a.delete(2); // "c": a leaf, the right child of "b"
    deliver([b, c], [del]);
    gossip([a, b, c], 2);

    // a removes the tombstone; c has not collected yet and still holds it.
    expect(a.collectGarbage()).toBe(1);
    expect(c.tombstoneCount).toBe(1);

    // In c's tree "b" still has a right child (the tombstone), so plain Fugue would
    // make this insert a left child of the tombstone, which a no longer has.
    const op = c.insert(2, "X");
    expect(op.parent).toEqual(typed[1]!.id);
    expect(op.side).toBe("right");
    expect(op.rightOrigin).toBeNull();
    a.applyRemoteOp(op);
    b.applyRemoteOp(op);
    expect(a.toString()).toBe("abX");
    expect(b.toString()).toBe("abX");
    expect(c.toString()).toBe("abX");

    gossip([a, b, c], 3);
    for (const doc of [a, b, c]) doc.collectGarbage();
    expect(structure(a)).toBe(structure(b));
    expect(structure(b)).toBe(structure(c));
    expect(a.tombstoneCount).toBe(0);
  });

  it("keeps a tombstone that is still some element's right origin, because sibling order depends on it", () => {
    // P (from a), Z (from b) and N (from c) are concurrent root inserts: order "PZN".
    const [a, b, c] = trio();
    const P = a.insert(0, "P");
    const Z = b.insert(0, "Z");
    const N = c.insert(0, "N");
    deliver([b, c], [P]);
    deliver([a, b], [N]);
    a.applyRemoteOp(Z);

    // c has not seen Z: it inserts X after P with right origin N. Only a receives X.
    expect(c.toString()).toBe("PN");
    const X = c.insert(1, "X");
    expect(X.rightOrigin).toEqual(N.id);
    a.applyRemoteOp(X);
    expect(a.toString()).toBe("PXZN");

    // N is deleted and the delete becomes stable everywhere. N has no children.
    const del = a.delete(3);
    deliver([b, c], [del]);
    c.applyRemoteOp(Z);
    gossip([a, b, c], 3);
    // ...but X still names N as its right origin, so a must keep it.
    expect(a.collectGarbage()).toBe(0);

    // b, which never saw X, inserts Y after P with right origin Z. X and Y are now
    // right-side siblings whose order is decided by comparing N's and Z's positions.
    const Y = b.insert(1, "Y");
    expect(Y.parent).toEqual(P.id);
    expect(Y.rightOrigin).toEqual(Z.id);
    a.applyRemoteOp(Y);
    b.applyRemoteOp(X);
    deliver([c], [Y]);
    for (const doc of [a, b, c]) expect(doc.toString()).toBe("PXYZ");

    gossip([a, b, c], 3);
    for (const doc of [a, b, c]) doc.collectGarbage();
    expect(structure(a)).toBe(structure(b));
    expect(structure(b)).toBe(structure(c));
    expect(a.toString()).toBe("PXYZ");
  });

  it("collects whole deleted regions from the leaves up", () => {
    const [a, b, c] = trio();
    const typed = a.insertText(0, "hello world");
    const erased: FugueOp[] = [];
    for (let i = 0; i < 6; i++) erased.push(a.delete(5)); // " world": a chain, each the parent of the next
    deliver([b, c], [...typed, ...erased]);
    gossip([a, b, c], 2);
    expect([a, b, c].map((d) => d.collectGarbage())).toEqual([6, 6, 6]);
    expect(a.toString()).toBe("hello");
    expect(a.nodeCount).toBe(5);
  });

  it("ignores re-delivered ops for elements that were already collected", () => {
    const [a, b, c] = trio();
    const typed = a.insertText(0, "xy");
    const del = a.delete(1);
    deliver([b, c], [...typed, del]);
    gossip([a, b, c], 2);
    for (const doc of [a, b, c]) doc.collectGarbage();
    const before = structure(b);
    deliver([b], [...typed, del, del, ...typed]);
    expect(structure(b)).toBe(before);
    expect(b.toString()).toBe("x");
  });

  it("a collected state can be saved, restored and edited further", () => {
    const [a, b, c] = trio();
    const ops = [...a.insertText(0, "abcdef"), a.delete(5), a.delete(4)];
    deliver([b, c], ops);
    gossip([a, b, c], 2);
    for (const doc of [a, b, c]) doc.collectGarbage();

    const restored = FugueMax.fromJSON(JSON.parse(structure(a)), "a");
    expect(structure(restored)).toBe(structure(a));
    const op = restored.insert(4, "!");
    b.applyRemoteOp(op);
    expect(b.toString()).toBe("abcd!");
  });

  it("does nothing unless enabled, and requires this replica to be a member", () => {
    const doc = new FugueMax("a");
    doc.insertText(0, "ab");
    doc.delete(0);
    expect(doc.collectGarbage()).toBe(0);
    expect(() => doc.heartbeat()).toThrow(/enableGc/);
    expect(() => doc.enableGc(["b", "c"])).toThrow(/members/);
  });
});

describe("FugueMax garbage collection under arbitrary schedules", () => {
  type Action =
    | { kind: "insert"; replica: number; pos: number; char: string }
    | { kind: "delete"; replica: number; pos: number; count: number }
    | { kind: "deliver"; to: number; pick: number; duplicate: boolean }
    | { kind: "heartbeat"; replica: number }
    | { kind: "catchUp"; to: number }
    | { kind: "gossipRound" }
    | { kind: "collect"; replica: number };

  const actionArb: fc.Arbitrary<Action> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant("insert" as const), replica: fc.nat(2), pos: fc.nat(1000), char: fc.constantFrom(..."abcdefgh") }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constant("delete" as const), replica: fc.nat(2), pos: fc.nat(1000), count: fc.integer({ min: 1, max: 4 }) }) },
    { weight: 8, arbitrary: fc.record({ kind: fc.constant("deliver" as const), to: fc.nat(2), pick: fc.nat(1000), duplicate: fc.boolean() }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constant("heartbeat" as const), replica: fc.nat(2) }) },
    // The next two make stability actually happen mid-run, while other ops are still in flight.
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("catchUp" as const), to: fc.nat(2) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("gossipRound" as const) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("collect" as const), replica: fc.nat(2) }) },
  );

  type Packet = { op: FugueOp } | { hb: FugueHeartbeat };

  it("never changes what any replica displays, never strands an op, and converges structurally", () => {
    let midRunCollections = 0;
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 150, size: "max" }), fc.integer(), (actions, seed) => {
        const docs = trio();
        // Shadows receive exactly the same ops at the same moments but never collect.
        const shadows = MEMBERS.map((id) => new FugueMax(id));
        const inboxes: Packet[][] = MEMBERS.map(() => []);
        let collected = 0;

        const send = (from: number, packet: Packet): void => {
          inboxes.forEach((inbox, i) => {
            if (i !== from) inbox.push(packet);
          });
        };
        const receive = (to: number, packet: Packet): void => {
          if ("op" in packet) {
            docs[to]!.applyRemoteOp(packet.op);
            shadows[to]!.applyRemoteOp(packet.op);
          } else {
            docs[to]!.receiveHeartbeat(packet.hb);
          }
        };
        const check = (i: number): void => {
          expect(docs[i]!.toString()).toBe(shadows[i]!.toString());
          expect(docs[i]!.pendingCount).toBe(shadows[i]!.pendingCount);
        };

        for (const action of actions) {
          if (action.kind === "deliver") {
            const inbox = inboxes[action.to]!;
            if (inbox.length === 0) continue;
            const i = action.pick % inbox.length;
            receive(action.to, inbox[i]!);
            if (!action.duplicate) inbox.splice(i, 1);
            check(action.to);
            continue;
          }
          if (action.kind === "catchUp") {
            for (const packet of inboxes[action.to]!.splice(0)) receive(action.to, packet);
            check(action.to);
            continue;
          }
          if (action.kind === "gossipRound") {
            gossip(docs);
            continue;
          }
          const r = action.replica;
          const doc = docs[r]!;
          if (action.kind === "heartbeat") {
            send(r, { hb: doc.heartbeat() });
          } else if (action.kind === "collect") {
            collected += doc.collectGarbage();
            check(r);
          } else if (action.kind === "insert") {
            const op = doc.insert(action.pos % (doc.length + 1), action.char);
            shadows[r]!.applyRemoteOp(op);
            send(r, { op });
            check(r);
          } else {
            for (let i = 0; i < action.count && doc.length > 0; i++) {
              const op = doc.delete(action.pos % doc.length);
              shadows[r]!.applyRemoteOp(op);
              send(r, { op });
            }
            check(r);
          }
        }

        // Quiescence: deliver everything (shuffled, some twice), then gossip to a fixpoint.
        const rng = new Prng(seed);
        inboxes.forEach((inbox, to) => {
          for (const packet of rng.shuffle(inbox)) {
            receive(to, packet);
            if (rng.bool(0.2)) receive(to, packet);
          }
        });
        const collectedMidRun = collected;
        gossip(docs, 2);
        for (const doc of docs) collected += doc.collectGarbage();

        docs.forEach((doc, i) => {
          check(i);
          expect(doc.pendingCount).toBe(0);
          expect(structure(doc)).toBe(structure(docs[0]!));
          // Complete: everything that can go has gone.
          expect(unreferencedTombstones(doc)).toBe(0);
          expect(doc.collectGarbage()).toBe(0);
        });
        expect(docs[0]!.nodeCount).toBe(shadows[0]!.nodeCount - (shadows[0]!.tombstoneCount - docs[0]!.tombstoneCount));
        midRunCollections += collectedMidRun;
      }),
      { numRuns: 600 },
    );
    // The schedules must really exercise removal while editing continues.
    expect(midRunCollections).toBeGreaterThan(300);
  }, 120_000);
});
