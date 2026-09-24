import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LWWRegister, type LWWState } from "../src/index";
import { maxByStamp, permutation, stampArb, subsetsOf, uniqueStamped } from "./arbitraries";

type Value = number | string;
type Write = LWWState<Value>;

const writeArb: fc.Arbitrary<Write> = fc
  .tuple(stampArb(), fc.oneof(fc.integer(), fc.string({ maxLength: 4 })))
  .map(([stamp, value]) => ({ ...stamp, value }));

const writePool = uniqueStamped(writeArb, { minLength: 1, maxLength: 12 });

function registerFrom(writes: readonly Write[]): LWWRegister<Value> {
  return writes.reduce(
    (reg, w) => reg.set(w.value, w.timestamp, w.replicaId),
    LWWRegister.empty<Value>(),
  );
}

/** Three registers built from overlapping subsets of one pool of uniquely-stamped writes. */
const threeRegisters = writePool.chain((pool) =>
  subsetsOf(pool, 3).map((subsets) => subsets.map(registerFrom) as [
    LWWRegister<Value>,
    LWWRegister<Value>,
    LWWRegister<Value>,
  ]),
);

function expectSame(a: LWWRegister<Value>, b: LWWRegister<Value>): void {
  expect(a.toJSON()).toEqual(b.toJSON());
}

describe("LWWRegister merge laws", () => {
  it("is commutative", () => {
    fc.assert(
      fc.property(threeRegisters, ([a, b]) => {
        expectSame(a.merge(b), b.merge(a));
      }),
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(threeRegisters, ([a, b, c]) => {
        expectSame(a.merge(b).merge(c), a.merge(b.merge(c)));
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(threeRegisters, ([a, b]) => {
        expectSame(a.merge(a), a);
        expectSame(a.merge(b).merge(b), a.merge(b));
      }),
    );
  });

  it("has the empty register as identity", () => {
    fc.assert(
      fc.property(threeRegisters, ([a]) => {
        expectSame(a.merge(LWWRegister.empty()), a);
        expectSame(LWWRegister.empty<Value>().merge(a), a);
      }),
    );
  });
});

describe("LWWRegister convergence", () => {
  it("converges to the highest (timestamp, replicaId) write across replicas and merge orders", () => {
    const scenario = writePool.chain((pool) =>
      fc.integer({ min: 3, max: 5 }).chain((n) =>
        fc.tuple(
          fc.constant(pool),
          subsetsOf(pool, n),
          fc.tuple(...Array.from({ length: n }, () => permutation(n))),
        ),
      ),
    );

    fc.assert(
      fc.property(scenario, ([pool, subsets, orders]) => {
        const replicas = subsets.map(registerFrom);
        // Each replica folds in every replica's state in its own random order.
        const converged = replicas.map((self, i) =>
          (orders[i] ?? []).reduce((acc, j) => acc.merge(replicas[j]!), self),
        );

        const union = pool.filter((w) => subsets.some((s) => s.includes(w)));
        const winner = maxByStamp(union);
        for (const r of converged) {
          expectSame(r, converged[0]!);
          expect(r.value()).toEqual(winner?.value);
          expect(r.stamp()).toEqual(
            winner && { timestamp: winner.timestamp, replicaId: winner.replicaId },
          );
        }
      }),
    );
  });
});

describe("LWWRegister semantics", () => {
  it("ignores a write with an older stamp", () => {
    const r = LWWRegister.of("new", 5, "a").set("old", 4, "z");
    expect(r.value()).toBe("new");
  });

  it("breaks timestamp ties by replicaId (code-unit order)", () => {
    const x = LWWRegister.of("from-a", 7, "a");
    const y = LWWRegister.of("from-b", 7, "b");
    expect(x.merge(y).value()).toBe("from-b");
    expect(y.merge(x).value()).toBe("from-b");
    // Uppercase sorts before lowercase in code-unit order, regardless of locale.
    expect(LWWRegister.of("B", 1, "B").merge(LWWRegister.of("a", 1, "a")).value()).toBe("a");
  });

  it("does not mutate operands", () => {
    const a = LWWRegister.of(1, 1, "a");
    const b = LWWRegister.of(2, 2, "b");
    a.merge(b);
    a.set(3, 3, "c");
    expect(a.value()).toBe(1);
    expect(b.value()).toBe(2);
  });

  it("rejects non-finite timestamps", () => {
    expect(() => LWWRegister.of(1, Number.NaN, "a")).toThrow(RangeError);
    expect(() => LWWRegister.of(1, Number.POSITIVE_INFINITY, "a")).toThrow(RangeError);
  });

  it("round-trips through JSON", () => {
    fc.assert(
      fc.property(threeRegisters, ([a, b]) => {
        const revived = LWWRegister.fromJSON<Value>(JSON.parse(JSON.stringify(a.toJSON())));
        expectSame(revived, a);
        expectSame(revived.merge(b), a.merge(b));
      }),
    );
  });
});
