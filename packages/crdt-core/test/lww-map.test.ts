import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LWWMap, type Stamp } from "../src/index";
import { REPLICA_IDS, maxByStamp, permutation, stampArb, subsetsOf, uniqueStamped } from "./arbitraries";

const KEYS = ["k0", "k1", "k2", "k3"] as const;
type Key = (typeof KEYS)[number];

type Op = Stamp & ({ kind: "set"; key: Key; value: number } | { kind: "delete"; key: Key });

const opArb: fc.Arbitrary<Op> = fc
  .tuple(stampArb(15), fc.constantFrom(...KEYS), fc.boolean(), fc.integer({ min: 0, max: 99 }))
  .map(([stamp, key, isSet, value]): Op =>
    isSet ? { ...stamp, kind: "set", key, value } : { ...stamp, kind: "delete", key },
  );

const opPool = uniqueStamped(opArb, { maxLength: 30, size: "max" });

function apply(map: LWWMap<Key, number>, op: Op): LWWMap<Key, number> {
  return op.kind === "set"
    ? map.set(op.key, op.value, op.timestamp, op.replicaId)
    : map.delete(op.key, op.timestamp, op.replicaId);
}

function mapFrom(ops: readonly Op[]): LWWMap<Key, number> {
  return ops.reduce(apply, LWWMap.empty<Key, number>());
}

/** Expected live entries: per key, the highest-stamped op wins; a winning delete means absent. */
function oracle(ops: readonly Op[]): [Key, number][] {
  const out: [Key, number][] = [];
  for (const key of KEYS) {
    const winner = maxByStamp(ops.filter((op) => op.key === key));
    if (winner?.kind === "set") out.push([key, winner.value]);
  }
  return out;
}

function expectSame(a: LWWMap<Key, number>, b: LWWMap<Key, number>): void {
  expect(a.toJSON()).toEqual(b.toJSON());
}

const threeMaps = opPool.chain((pool) =>
  subsetsOf(pool, 3).map((subsets) => subsets.map(mapFrom) as [
    LWWMap<Key, number>,
    LWWMap<Key, number>,
    LWWMap<Key, number>,
  ]),
);

describe("LWWMap merge laws", () => {
  it("is commutative", () => {
    fc.assert(fc.property(threeMaps, ([a, b]) => expectSame(a.merge(b), b.merge(a))));
  });

  it("is associative", () => {
    fc.assert(
      fc.property(threeMaps, ([a, b, c]) => expectSame(a.merge(b).merge(c), a.merge(b.merge(c)))),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(threeMaps, ([a, b]) => {
        expectSame(a.merge(a), a);
        expectSame(a.merge(b).merge(b), a.merge(b));
      }),
    );
  });
});

describe("LWWMap convergence", () => {
  // Each replica only issues ops stamped with its own replicaId, applies them locally
  // in a random order, then gossips with random peers before a final full exchange.
  const scenario = opPool.chain((pool) =>
    fc.tuple(
      fc.constant(pool),
      fc.tuple(...REPLICA_IDS.map((id) => fc.shuffledSubarray(pool.filter((op) => op.replicaId === id), {
        minLength: pool.filter((op) => op.replicaId === id).length,
      }))),
      fc.array(
        fc.tuple(fc.nat(REPLICA_IDS.length - 1), fc.nat(REPLICA_IDS.length - 1)),
        { maxLength: 20, size: "max" },
      ),
      fc.tuple(...REPLICA_IDS.map(() => permutation(REPLICA_IDS.length))),
    ),
  );

  it("converges to the per-key highest-stamped op under random gossip and merge orders", () => {
    fc.assert(
      fc.property(scenario, ([pool, localOps, gossip, finalOrders]) => {
        const replicas = localOps.map(mapFrom);

        for (const [from, to] of gossip) {
          replicas[to] = replicas[to]!.merge(replicas[from]!);
        }

        const snapshot = replicas.slice();
        const converged = snapshot.map((self, i) =>
          finalOrders[i]!.reduce((acc, j) => acc.merge(snapshot[j]!), self),
        );

        const expected = oracle(pool);
        const canonical = JSON.stringify(converged[0]!.toJSON());
        for (const r of converged) {
          expect(JSON.stringify(r.toJSON())).toBe(canonical);
          expect(r.entries()).toEqual(expected);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("LWWMap tombstones", () => {
  it("a later delete beats a concurrent earlier set in either merge order", () => {
    const writer = LWWMap.empty<string, number>().set("x", 1, 4, "a");
    const deleter = LWWMap.empty<string, number>().delete("x", 5, "b");
    for (const m of [writer.merge(deleter), deleter.merge(writer)]) {
      expect(m.has("x")).toBe(false);
      expect(m.get("x")).toBeUndefined();
    }
  });

  it("a later set beats an earlier delete (re-add)", () => {
    const base = LWWMap.empty<string, number>().set("x", 1, 1, "a").delete("x", 2, "a");
    const readd = base.set("x", 2, 3, "b");
    expect(readd.get("x")).toBe(2);
    expect(base.merge(readd).get("x")).toBe(2);
    expect(readd.merge(base).get("x")).toBe(2);
  });

  it("a delete of a locally-absent key still suppresses an older set that arrives later", () => {
    const deleter = LWWMap.empty<string, number>().delete("x", 10, "b");
    const lateWriter = LWWMap.empty<string, number>().set("x", 7, 9, "a");
    expect(deleter.merge(lateWriter).has("x")).toBe(false);
  });

  it("serializes tombstones and round-trips through JSON", () => {
    fc.assert(
      fc.property(threeMaps, ([a, b]) => {
        const revived = LWWMap.fromJSON<Key, number>(JSON.parse(JSON.stringify(a.toJSON())));
        expectSame(revived, a);
        expectSame(revived.merge(b), a.merge(b));
      }),
    );
  });

  it("serializes canonically regardless of write order", () => {
    fc.assert(
      fc.property(opPool, (ops) => {
        const forward = mapFrom(ops);
        const backward = mapFrom(ops.slice().reverse());
        expect(JSON.stringify(forward.toJSON())).toBe(JSON.stringify(backward.toJSON()));
      }),
    );
  });

  it("rejects invalid keys and stamps", () => {
    const m = LWWMap.empty<number, number>();
    expect(() => m.set(Number.NaN, 1, 1, "a")).toThrow(TypeError);
    expect(() => m.set(1, 1, Number.NaN, "a")).toThrow(RangeError);
  });
});
