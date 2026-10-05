import { FugueMax, type FugueOp } from "@crdt/core";
import { describe, expect, it } from "vitest";
import { fugueGc, fuzz, runSeed } from "../src/index";

const fugue = (id: string): FugueMax => new FugueMax(id);

describe("garbage collection under simulated faults", () => {
  it("converges, structure included, on 300 seeds with heartbeats reordered, duplicated and partitioned", () => {
    expect(fuzz<FugueOp>(fugue, 1, 300, fugueGc()).failure).toBeNull();
  });

  it("actually removes tombstones, and what is left is identical on every replica", () => {
    let deleted = 0;
    let remaining = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const run = runSeed<FugueOp>(fugue, seed, fugueGc());
      deleted += run.stats.deletes;
      const counts = run.replicas.map((doc) => (doc as FugueMax).tombstoneCount);
      expect(new Set(counts).size).toBe(1);
      remaining += counts[0]!;
    }
    expect(deleted).toBeGreaterThan(1000);
    // A tombstone survives only while something still hangs off it.
    expect(remaining).toBeLessThan(deleted * 0.8);
  });

  it("is deterministic with maintenance enabled", () => {
    expect(runSeed<FugueOp>(fugue, 4242, fugueGc()).digest).toBe(runSeed<FugueOp>(fugue, 4242, fugueGc()).digest);
  });
});
