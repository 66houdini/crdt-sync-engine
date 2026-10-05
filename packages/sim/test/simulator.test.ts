import { FugueMax, type FugueOp, Prng, RGA, type SequenceCrdt } from "@crdt/core";
import { describe, expect, it } from "vitest";
import { ConvergenceError, assertConverged, fuzz, randomOptions, runSeed, runSimulation } from "../src/index";

const fugue = (id: string) => new FugueMax(id);
const rga = (id: string) => new RGA(id);

describe("simulator determinism", () => {
  it("is a pure function of the seed: identical trace, text and structure on every run", () => {
    for (const seed of [1, 12345, 987654321]) {
      const first = runSeed(fugue, seed);
      const second = runSeed(fugue, seed);
      expect(second.trace).toEqual(first.trace);
      expect(second.text).toBe(first.text);
      expect(second.digest).toBe(first.digest);
      expect(JSON.stringify(second.replicas[0]!.toJSON())).toBe(JSON.stringify(first.replicas[0]!.toJSON()));
    }
  });

  it("different seeds explore different executions", () => {
    const digests = new Set(Array.from({ length: 50 }, (_, seed) => runSeed(fugue, seed).digest));
    expect(digests.size).toBe(50);
  });

  it("pins the outcome of seed 12345 (guards the replay contract against accidental changes)", () => {
    const run = runSeed(fugue, 12345);
    expect({ replicas: run.options.replicas, steps: run.options.steps, text: run.text, digest: run.digest }).toMatchInlineSnapshot(`
      {
        "digest": "87b6b8d4",
        "replicas": 5,
        "steps": 119,
        "text": "yawzorwjhebttayednrltlgmhumulzypwkjpfvbgszuwlfutapelggnsastyhrfmtpwywssioewajpqjxuptvaetcehdtea",
      }
    `);
  });
});

describe("strong eventual consistency under simulated faults", () => {
  it("FugueMax converges on 400 seeds, and the faults are really being exercised", () => {
    const report = fuzz(fugue, 1, 400);
    expect(report.failure).toBeNull();
    expect(report.totals.reordered).toBeGreaterThan(1000);
    expect(report.totals.duplicated).toBeGreaterThan(1000);
    expect(report.totals.partitions).toBeGreaterThan(100);
    // Reordering really did deliver ops ahead of their causal dependencies.
    expect(report.totals.buffered).toBeGreaterThan(400);
  });

  it("RGA converges on 200 seeds", () => {
    expect(fuzz(rga, 1, 200).failure).toBeNull();
  });
});

describe("the simulator finds real bugs", () => {
  /** Positional ops with no conflict resolution: the classic non-convergent design. */
  class NaiveList implements SequenceCrdt<{ index: number; char: string | null }> {
    private chars: string[] = [];
    readonly pendingCount = 0;
    constructor(readonly replicaId: string) {}
    get length(): number {
      return this.chars.length;
    }
    insert(index: number, char: string) {
      this.chars.splice(index, 0, char);
      return { index, char };
    }
    delete(index: number) {
      this.chars.splice(index, 1);
      return { index, char: null };
    }
    applyRemoteOp(op: { index: number; char: string | null }): void {
      if (op.char === null) this.chars.splice(op.index, 1);
      else this.chars.splice(Math.min(op.index, this.chars.length), 0, op.char);
    }
    toString(): string {
      return this.chars.join("");
    }
    toJSON(): unknown {
      return this.chars;
    }
  }

  /** FugueMax with duplicate suppression removed: every re-delivered insert is applied again under a fresh id. */
  class NotIdempotent implements SequenceCrdt<FugueOp> {
    private readonly inner: FugueMax;
    private extra = 0;
    constructor(readonly replicaId: string) {
      this.inner = new FugueMax(replicaId);
    }
    get length(): number {
      return this.inner.length;
    }
    get pendingCount(): number {
      return this.inner.pendingCount;
    }
    insert(index: number, char: string): FugueOp {
      return this.inner.insert(index, char);
    }
    delete(index: number): FugueOp {
      return this.inner.delete(index);
    }
    applyRemoteOp(op: FugueOp): void {
      if (op.type === "insert" && this.inner.hasApplied(op.id)) {
        const ghost = `${this.replicaId}-dup`;
        this.inner.applyRemoteOp({ ...op, id: { replicaId: ghost, counter: this.extra++ } });
      } else {
        this.inner.applyRemoteOp(op);
      }
    }
    toString(): string {
      return this.inner.toString();
    }
    toJSON(): unknown {
      return this.inner.toJSON();
    }
  }

  it("reports a failing seed for a non-convergent list, and that seed reproduces the failure", () => {
    const report = fuzz((id) => new NaiveList(id), 1, 50);
    expect(report.failure).not.toBeNull();
    const { seed } = report.failure!;
    expect(() => runSeed((id) => new NaiveList(id), seed)).toThrow();
    expect(() => runSeed((id) => new NaiveList(id), seed)).toThrow();
  });

  it("catches a CRDT that is not idempotent under duplicated delivery", () => {
    const report = fuzz((id) => new NotIdempotent(id), 1, 50);
    expect(report.failure?.error).toBeInstanceOf(ConvergenceError);
  });

  it("assertConverged distinguishes text divergence, structural divergence and stuck ops", () => {
    const a = new FugueMax("a");
    const b = new FugueMax("b");
    const [x, y] = a.insertText(0, "xy");
    b.applyRemoteOp(y!);
    expect(() => assertConverged([a, b])).toThrow(/waiting for dependencies/);
    b.applyRemoteOp(x!);
    assertConverged([a, b]);

    b.insert(0, "z");
    expect(() => assertConverged([a, b])).toThrow(/text diverged/);

    // Same text, different tombstones.
    const c = new FugueMax("c");
    const d = new FugueMax("d");
    c.insert(0, "k");
    d.insertText(0, "qk");
    d.delete(0);
    expect(c.toString()).toBe(d.toString());
    expect(() => assertConverged([c, d])).toThrow(/different internal structure/);
  });
});

describe("simulator options", () => {
  it("runs a fixed scenario shape with an explicitly passed PRNG", () => {
    const rng = new Prng(99);
    const result = runSimulation(fugue, rng, {
      replicas: 5,
      steps: 300,
      weights: { edit: 3, deliver: 2, duplicate: 2, partition: 1 },
      deleteProbability: 0.3,
      maxBurst: 5,
      backwardProbability: 0.5,
      maxPartitionSteps: 60,
    });
    assertConverged(result.replicas);
    expect(result.replicas).toHaveLength(5);
    expect(result.stats.partitions).toBeGreaterThan(0);
  });

  it("randomOptions stays within sane bounds", () => {
    for (let seed = 0; seed < 200; seed++) {
      const o = randomOptions(new Prng(seed));
      expect(o.replicas).toBeGreaterThanOrEqual(2);
      expect(o.replicas).toBeLessThanOrEqual(5);
      expect(o.steps).toBeGreaterThanOrEqual(40);
      expect(o.weights.edit).toBeGreaterThan(0);
    }
  });
});
