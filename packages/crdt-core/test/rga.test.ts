import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RGA, type RgaOp } from "../src/index";
import { bothIntact, expectConverged, runScenario, scenarioArb, typeBackward, typeForward } from "./sequence-harness";

const factory = (id: string) => new RGA(id);

describe("RGA convergence", () => {
  it("converges under random concurrent edits, reordering and duplication", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        expectConverged(runScenario(factory, scenario).replicas);
      }),
      { numRuns: 500 },
    );
  });

  it("applying every op in a different order on a fresh replica gives the same document", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer(), (scenario, seed) => {
        const { replicas, ops } = runScenario(factory, scenario);
        const fresh = new RGA("observer");
        // Reverse generation order is about as hostile as it gets for causal dependencies.
        for (const op of seed % 2 === 0 ? ops.slice().reverse() : ops) fresh.applyRemoteOp(op);
        expect(fresh.pendingCount).toBe(0);
        expect(fresh.toString()).toBe(replicas[0]!.toString());
      }),
    );
  });
});

describe("RGA semantics", () => {
  it("behaves like a plain string for a single replica", () => {
    const doc = new RGA("a");
    typeForward(doc, 0, "hello");
    doc.insert(5, "!");
    doc.delete(0);
    doc.insert(0, "J");
    expect(doc.toString()).toBe("Jello!");
    expect(doc.length).toBe(6);
  });

  it("buffers an insert whose origin has not arrived, and a delete whose target has not arrived", () => {
    const a = new RGA("a");
    const [h, i] = typeForward(a, 0, "hi") as [RgaOp, RgaOp];
    const del = a.delete(1);

    const b = new RGA("b");
    b.applyRemoteOp(del);
    b.applyRemoteOp(i);
    expect(b.toString()).toBe("");
    expect(b.pendingCount).toBe(2);
    b.applyRemoteOp(h);
    expect(b.toString()).toBe("h");
    expect(b.pendingCount).toBe(0);
  });

  it("is idempotent under duplicate delivery", () => {
    const a = new RGA("a");
    const ops = [...typeForward(a, 0, "abc"), a.delete(1)];
    const b = new RGA("b");
    for (const op of [...ops, ...ops, ...ops]) b.applyRemoteOp(op);
    expect(b.toString()).toBe("ac");
    expect(JSON.stringify(b.toJSON())).toBe(JSON.stringify(a.toJSON()));
  });

  it("rejects out-of-range indices", () => {
    const doc = new RGA("a");
    expect(() => doc.insert(1, "x")).toThrow(RangeError);
    expect(() => doc.delete(0)).toThrow(RangeError);
  });
});

describe("RGA interleaving behaviour (documented baseline)", () => {
  function concurrentWords(type: typeof typeForward): string {
    const a = new RGA("a");
    const b = new RGA("b");
    const base = a.insert(0, ">");
    b.applyRemoteOp(base);
    const opsA = type(a, 1, "the");
    const opsB = type(b, 1, "fox");
    opsB.forEach((op) => a.applyRemoteOp(op));
    opsA.forEach((op) => b.applyRemoteOp(op));
    expect(a.toString()).toBe(b.toString());
    return a.toString();
  }

  it("keeps concurrent forward-typed words intact", () => {
    expect(bothIntact(concurrentWords(typeForward), "the", "fox")).toBe(true);
  });

  it("interleaves concurrent backward-typed words", () => {
    const text = concurrentWords(typeBackward);
    expect(bothIntact(text, "the", "fox")).toBe(false);
    expect(text).toBe(">ftohxe");
  });
});
