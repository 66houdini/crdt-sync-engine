import fc from "fast-check";
import { compareStamps, type Stamp } from "../src/index";

export const REPLICA_IDS = ["a", "b", "c", "d"] as const;

/** Arbitrary list of items whose (timestamp, replicaId) stamps are pairwise distinct. */
export function uniqueStamped<T extends Stamp>(
  item: fc.Arbitrary<T>,
  constraints: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<T[]> {
  return fc.uniqueArray(item, {
    selector: (x) => `${x.timestamp}|${x.replicaId}`,
    ...constraints,
  });
}

export function stampArb(maxTimestamp = 20): fc.Arbitrary<Stamp> {
  return fc.record({
    timestamp: fc.integer({ min: 0, max: maxTimestamp }),
    replicaId: fc.constantFrom(...REPLICA_IDS),
  });
}

export function maxByStamp<T extends Stamp>(items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (best === undefined || compareStamps(item, best) > 0) best = item;
  }
  return best;
}

/** Splits `pool` into `n` random (possibly overlapping, possibly empty) shuffled subsets. */
export function subsetsOf<T>(pool: readonly T[], n: number): fc.Arbitrary<T[][]> {
  return fc.tuple(...Array.from({ length: n }, () => fc.shuffledSubarray(pool.slice())));
}

/** A permutation of `0..n-1`. */
export function permutation(n: number): fc.Arbitrary<number[]> {
  const idx = Array.from({ length: n }, (_, i) => i);
  return fc.shuffledSubarray(idx, { minLength: n, maxLength: n });
}
