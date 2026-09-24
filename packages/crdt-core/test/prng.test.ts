import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Prng } from "../src/index";

/** Canonical mulberry32, transcribed from the widely-circulated reference implementation. */
function referenceMulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Prng", () => {
  it("matches the reference mulberry32 sequence", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const ours = new Prng(seed);
        const ref = referenceMulberry32(seed);
        for (let i = 0; i < 16; i++) expect(ours.next()).toBe(ref());
      }),
    );
  });

  it("is reproducible from its seed", () => {
    const run = (seed: number) => {
      const rng = new Prng(seed);
      return [rng.nextUint32(), rng.int(10), rng.bool(), rng.pick(["x", "y", "z"]), rng.shuffle([1, 2, 3, 4, 5])];
    };
    expect(run(12345)).toEqual(run(12345));
    expect(run(12345)).not.toEqual(run(12346));
  });

  it("pins the sequence for seed 12345 (recorded failing seeds depend on it)", () => {
    const rng = new Prng(12345);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toMatchInlineSnapshot(`
      [
        4207900869,
        1317490944,
        2079646450,
      ]
    `);
  });

  it("int stays within bounds", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 1000 }), (seed, n) => {
        const rng = new Prng(seed);
        for (let i = 0; i < 50; i++) {
          const x = rng.int(n);
          expect(Number.isInteger(x) && x >= 0 && x < n).toBe(true);
        }
      }),
    );
  });

  it("shuffle returns a permutation without mutating its input", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.integer()), (seed, items) => {
        const copy = items.slice();
        const shuffled = new Prng(seed).shuffle(items);
        expect(items).toEqual(copy);
        expect(shuffled.slice().sort((x, y) => x - y)).toEqual(copy.sort((x, y) => x - y));
      }),
    );
  });

  it("rejects bad arguments", () => {
    expect(() => new Prng(1.5)).toThrow(RangeError);
    expect(() => new Prng(0).int(0)).toThrow(RangeError);
    expect(() => new Prng(0).pick([])).toThrow(RangeError);
  });
});
