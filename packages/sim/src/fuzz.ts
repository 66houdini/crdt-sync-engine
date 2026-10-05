import { Prng, type SequenceCrdt } from "@crdt/core";
import { assertConverged } from "./assert";
import { type CrdtFactory, type SimResult, randomOptions, runSimulation } from "./simulator";

/** 32-bit FNV-1a, as 8 hex digits. Used to fingerprint a run so two runs can be compared at a glance. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface SeedRun<Op> extends SimResult<Op> {
  seed: number;
  text: string;
  /** Fingerprint of the full event trace plus the final internal structure. */
  digest: string;
}

/**
 * One complete, reproducible simulation: a single PRNG seeded with `seed` picks
 * the scenario shape and then drives the whole run. Throws if the replicas do
 * not converge. Everything the fuzzer and `pnpm sim --seed N` do goes through here.
 */
export function runSeed<Op>(factory: CrdtFactory<Op>, seed: number): SeedRun<Op> {
  const rng = new Prng(seed);
  const result = runSimulation(factory, rng, randomOptions(rng));
  assertConverged(result.replicas);
  const first = result.replicas[0] as SequenceCrdt<Op>;
  return {
    ...result,
    seed,
    text: first.toString(),
    digest: fnv1a(`${result.trace.join("\n")}\n${JSON.stringify(first.toJSON())}`),
  };
}

export interface FuzzFailure {
  seed: number;
  error: Error;
}

export interface FuzzReport {
  seeds: number;
  failure: FuzzFailure | null;
  totals: { inserts: number; deletes: number; delivered: number; duplicated: number; reordered: number; partitions: number; buffered: number };
}

/** Runs seeds `start .. start+count-1` and stops at the first failure. */
export function fuzz<Op>(factory: CrdtFactory<Op>, start: number, count: number): FuzzReport {
  const totals = { inserts: 0, deletes: 0, delivered: 0, duplicated: 0, reordered: 0, partitions: 0, buffered: 0 };
  for (let seed = start; seed < start + count; seed++) {
    try {
      const { stats } = runSeed(factory, seed);
      totals.inserts += stats.inserts;
      totals.deletes += stats.deletes;
      totals.delivered += stats.delivered;
      totals.duplicated += stats.duplicated;
      totals.reordered += stats.reordered;
      totals.partitions += stats.partitions;
      totals.buffered += stats.maxBuffered;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { seeds: seed - start + 1, failure: { seed, error }, totals };
    }
  }
  return { seeds: count, failure: null, totals };
}
