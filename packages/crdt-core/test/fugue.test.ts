import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FugueMax, type FugueOp, Prng, idKey, parseFugueOp } from "../src/index";
import { ReferenceFugueMax } from "./fugue-reference";
import { expectConverged, runScenario, scenarioArb, typeBackward, typeForward } from "./sequence-harness";

const factory = (id: string) => new FugueMax(id);

const orderedIds = (doc: FugueMax): string[] =>
  doc.toJSON().nodes.map((n) => idKey({ replicaId: n.id[0], counter: n.id[1] }));

function deliverAll(doc: FugueMax, ops: readonly FugueOp[]): void {
  for (const op of ops) doc.applyRemoteOp(op);
}

describe("FugueMax convergence", () => {
  it("converges under random concurrent edits, reordering and duplication, and matches the paper's algorithm", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { replicas, ops } = runScenario(factory, scenario);
        expectConverged(replicas);

        // Generation order is a causal order, which is what the reference requires.
        const reference = new ReferenceFugueMax("reference");
        for (const op of ops) reference.deliver(op);
        expect(replicas[0]!.toString()).toBe(reference.values());
        expect(orderedIds(replicas[0] as FugueMax)).toEqual(reference.orderedIds());
      }),
      { numRuns: 500 },
    );
  });

  it("a fresh replica fed every op in reverse order reaches the same state", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { replicas, ops } = runScenario(factory, scenario);
        const fresh = new FugueMax("observer");
        deliverAll(fresh, ops.slice().reverse());
        expect(fresh.pendingCount).toBe(0);
        expect(JSON.stringify(fresh.toJSON())).toBe(JSON.stringify(replicas[0]!.toJSON()));
      }),
    );
  });
});

describe("FugueMax vs the paper's Algorithm 1 (differential)", () => {
  type Step =
    | { kind: "insert"; replica: number; pos: number; char: string }
    | { kind: "delete"; replica: number; pos: number }
    | { kind: "sync"; from: number; to: number };

  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant("insert" as const), replica: fc.nat(2), pos: fc.nat(1000), char: fc.constantFrom(..."abcdefgh") }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("delete" as const), replica: fc.nat(2), pos: fc.nat(1000) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("sync" as const), from: fc.nat(2), to: fc.nat(2) }) },
  );

  it("generates identical ops and identical text at every step, including in concurrent states", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 70 }), (steps) => {
        const peers = ["a", "b", "c"].map((id) => ({
          impl: new FugueMax(id),
          ref: new ReferenceFugueMax(id),
          log: [] as FugueOp[],
          seen: new Set<string>(),
        }));

        for (const step of steps) {
          if (step.kind === "sync") {
            const from = peers[step.from]!;
            const to = peers[step.to]!;
            // Pulling a peer's log in its application order is causal delivery.
            for (const op of from.log) {
              if (to.seen.has(idKey(op.id))) continue;
              to.impl.applyRemoteOp(op);
              to.ref.deliver(op);
              to.log.push(op);
              to.seen.add(idKey(op.id));
            }
            expect(to.impl.toString()).toBe(to.ref.values());
            expect(orderedIds(to.impl)).toEqual(to.ref.orderedIds());
            continue;
          }

          const peer = peers[step.replica]!;
          let op: FugueOp;
          let refOp: FugueOp;
          if (step.kind === "insert") {
            const index = step.pos % (peer.impl.length + 1);
            op = peer.impl.insert(index, step.char);
            refOp = peer.ref.insert(index, step.char);
          } else {
            if (peer.impl.length === 0) continue;
            const index = step.pos % peer.impl.length;
            op = peer.impl.delete(index);
            refOp = peer.ref.delete(index);
          }
          expect(op).toEqual(refOp);
          peer.log.push(op);
          peer.seen.add(idKey(op.id));
          expect(peer.impl.toString()).toBe(peer.ref.values());
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("FugueMax sibling order (the part people get wrong)", () => {
  it("orders same-side siblings with equal origins by ascending id", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => new FugueMax(id)) as [FugueMax, FugueMax, FugueMax];
    const ops = [c.insert(0, "C"), a.insert(0, "A"), b.insert(0, "B")];
    for (const doc of [a, b, c]) deliverAll(doc, ops);
    expect(a.toString()).toBe("ABC");
    expectConverged([a, b, c]);
  });

  it("orders concurrent left-side siblings by ascending id", () => {
    const [a, b] = [new FugueMax("a"), new FugueMax("b")];
    const base = a.insertText(0, "xy");
    deliverAll(b, base);
    // x has a right child (y), so inserting between them makes a left child of y.
    const fromB = b.insert(1, "B");
    const fromA = a.insert(1, "A");
    expect(fromA.side).toBe("left");
    a.applyRemoteOp(fromB);
    b.applyRemoteOp(fromA);
    expect(a.toString()).toBe("xABy");
    expectConverged([a, b]);
  });

  it("reproduces the paper's Figure 7: right-side siblings go in reverse order of their right origins", () => {
    // A, B, C are inserted concurrently into an empty list and order by id: A < B < C.
    const a = new FugueMax("a");
    const b = new FugueMax("b");
    const c = new FugueMax("c");
    const A = a.insert(0, "A");
    const B = b.insert(0, "B");
    const C = c.insert(0, "C");

    // One replica has seen {A, C} and inserts X between them (right origin C).
    // Its id is chosen to be the GREATEST, so plain Fugue (id order only) would put X after Y.
    const z = new FugueMax("z");
    deliverAll(z, [A, C]);
    expect(z.toString()).toBe("AC");
    const X = z.insert(1, "X");

    // Concurrently, replica b has seen {A, B} and inserts Y between them (right origin B).
    b.applyRemoteOp(A);
    expect(b.toString()).toBe("AB");
    const Y = b.insert(1, "Y");

    expect(X.parent).toEqual(A.id);
    expect(Y.parent).toEqual(A.id);
    expect([X.side, Y.side]).toEqual(["right", "right"]);
    expect(X.rightOrigin).toEqual(C.id);
    expect(Y.rightOrigin).toEqual(B.id);

    const all = [A, B, C, X, Y];
    const rng = new Prng(7);
    const replicas = [a, b, c, z, new FugueMax("late")];
    for (const doc of replicas) deliverAll(doc, rng.shuffle(all));
    // Maximal non-interleaving admits exactly one order here (paper, Section IV-B).
    expect(a.toString()).toBe("AXYBC");
    expectConverged(replicas);
  });

  it("matches the paper on randomized Figure-7-style histories (siblings with different right origins)", () => {
    // Round 1: several replicas insert concurrently into an empty list (root siblings).
    // Round 2: writers that each saw a different subset insert between what they saw,
    // which yields right-side siblings whose right origins differ. Repeat once more.
    const history = fc.record({
      roots: fc.integer({ min: 2, max: 5 }),
      rounds: fc.array(
        fc.array(fc.record({ sees: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), pos: fc.nat(100) }), {
          minLength: 2,
          maxLength: 4,
        }),
        { minLength: 1, maxLength: 2 },
      ),
      seed: fc.integer(),
    });

    fc.assert(
      fc.property(history, ({ roots, rounds, seed }) => {
        const causal: FugueOp[] = [];
        for (let i = 0; i < roots; i++) causal.push(new FugueMax(`root${i}`).insert(0, String.fromCharCode(65 + i)));

        // Writer names sort in the opposite direction to their creation order, so id
        // order regularly disagrees with right-origin order.
        let writer = 0;
        for (const round of rounds) {
          const known = causal.slice();
          const produced = round.map((w) => {
            const doc = new FugueMax(`w${String(99 - writer++).padStart(2, "0")}`);
            // Causally closed view: an op is visible only if everything it references is.
            const seen = new Set<string>();
            for (const [i, op] of known.entries()) {
              if (op.type !== "insert" || !w.sees[i % w.sees.length]) continue;
              const deps = [op.parent, op.rightOrigin].filter((d) => d !== null);
              if (deps.every((d) => seen.has(idKey(d)))) {
                doc.applyRemoteOp(op);
                seen.add(idKey(op.id));
              }
            }
            return doc.insert(w.pos % (doc.length + 1), String.fromCharCode(97 + writer));
          });
          causal.push(...produced);
        }

        const reference = new ReferenceFugueMax("reference");
        for (const op of causal) reference.deliver(op);
        const doc = new FugueMax("observer");
        deliverAll(doc, new Prng(seed).shuffle(causal));
        expect(doc.pendingCount).toBe(0);
        expect(doc.toString()).toBe(reference.values());
      }),
      { numRuns: 500 },
    );
  });

  it("reproduces the paper's Figure 6: forward non-interleaving takes precedence", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => new FugueMax(id)) as [FugueMax, FugueMax, FugueMax];
    const A = a.insert(0, "A");
    const B = b.insert(0, "B");
    const C = c.insert(0, "C");
    a.applyRemoteOp(C);
    const X = a.insert(1, "X");
    expect(a.toString()).toBe("AXC");
    a.applyRemoteOp(B);
    expect(a.toString()).toBe("AXBC");
    deliverAll(c, [A, B, X]);
    expect(c.toString()).toBe("AXBC");
  });
});

describe("FugueMax non-interleaving", () => {
  type Mode = "forward" | "backward" | "scattered";
  const runArb = fc.record({
    length: fc.integer({ min: 1, max: 6 }),
    mode: fc.constantFrom<Mode>("forward", "backward", "scattered"),
    seed: fc.integer(),
  });

  /** Types `text` at `index` in the given keystroke order; the local result is always `text` in place. */
  function typeRun(doc: FugueMax, index: number, text: string, mode: Mode, seed: number): FugueOp[] {
    if (mode === "forward") return typeForward(doc, index, text);
    if (mode === "backward") return typeBackward(doc, index, text);
    // Scattered: the characters are typed in a random order, each at its correct
    // place relative to the part of the run typed so far (cursor jumping around).
    const order = new Prng(seed).shuffle([...text].map((_, i) => i));
    const done: number[] = [];
    return order.map((k) => {
      const offset = done.filter((j) => j < k).length;
      done.push(k);
      return doc.insert(index + offset, text[k]!);
    });
  }

  it("never interleaves concurrent multi-character runs inserted at the same position", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(..."0123456789"), maxLength: 6 }),
        fc.nat(100),
        fc.array(runArb, { minLength: 2, maxLength: 4 }),
        fc.integer(),
        (base, posSeed, runs, deliverySeed) => {
          const replicas = runs.map((_, i) => new FugueMax(`r${i}`));
          const baseOps = replicas[0]!.insertText(0, base);
          replicas.slice(1).forEach((doc) => deliverAll(doc, baseOps));
          const index = posSeed % (base.length + 1);

          // Each replica uses its own alphabet, so a run is identifiable in the output.
          const texts = runs.map((run, i) =>
            Array.from({ length: run.length }, (_, k) => String.fromCharCode(65 + i * 6 + k)).join(""),
          );
          const opsByReplica = runs.map((run, i) => {
            const ops = typeRun(replicas[i]!, index, texts[i]!, run.mode, run.seed);
            expect(replicas[i]!.toString()).toBe(base.slice(0, index) + texts[i]! + base.slice(index));
            return ops;
          });

          const rng = new Prng(deliverySeed);
          replicas.forEach((doc, i) => {
            const incoming = opsByReplica.flatMap((ops, j) => (j === i ? [] : ops));
            deliverAll(doc, rng.shuffle(incoming));
          });

          expectConverged(replicas);
          const text = replicas[0]!.toString();
          for (const run of texts) expect(text, `run ${run} in ${text}`).toContain(run);
          // The runs sit together at the insertion point, in some order, with the base intact around them.
          expect(text.slice(0, index)).toBe(base.slice(0, index));
          expect(text.slice(text.length - (base.length - index))).toBe(base.slice(index));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("keeps runs intact when other replicas concurrently delete the surrounding text", () => {
    fc.assert(
      fc.property(fc.array(runArb, { minLength: 2, maxLength: 3 }), fc.integer(), (runs, seed) => {
        const base = "0123";
        const replicas = runs.map((_, i) => new FugueMax(`r${i}`));
        const baseOps = replicas[0]!.insertText(0, base);
        replicas.slice(1).forEach((doc) => deliverAll(doc, baseOps));

        const eraser = new FugueMax("eraser");
        deliverAll(eraser, baseOps);
        const erase = [eraser.delete(1), eraser.delete(1)]; // removes "1" and "2"

        const texts = runs.map((run, i) =>
          Array.from({ length: run.length }, (_, k) => String.fromCharCode(65 + i * 6 + k)).join(""),
        );
        const opsByReplica = runs.map((run, i) => typeRun(replicas[i]!, 2, texts[i]!, run.mode, run.seed));

        const rng = new Prng(seed);
        const all = [...replicas, eraser];
        all.forEach((doc, i) => {
          const incoming = [...opsByReplica.flatMap((ops, j) => (j === i ? [] : ops)), ...(doc === eraser ? [] : erase)];
          deliverAll(doc, rng.shuffle(incoming));
        });
        expectConverged(all);
        const text = all[0]!.toString();
        for (const run of texts) expect(text).toContain(run);
        expect(text.startsWith("0") && text.endsWith("3")).toBe(true);
      }),
    );
  });
});

describe("FugueMax delivery", () => {
  it("buffers ops until their dependencies arrive and drops duplicates", () => {
    const a = new FugueMax("a");
    const [h, i] = a.insertText(0, "hi") as [FugueOp, FugueOp];
    const del = a.delete(0);

    const b = new FugueMax("b");
    b.applyRemoteOp(del);
    b.applyRemoteOp(i);
    expect(b.toString()).toBe("");
    expect(b.pendingCount).toBe(2);
    b.applyRemoteOp(h);
    expect(b.toString()).toBe("i");
    expect(b.pendingCount).toBe(0);

    deliverAll(b, [h, i, del, del, h]);
    expect(b.toString()).toBe("i");
    expect(JSON.stringify(b.toJSON())).toBe(JSON.stringify(a.toJSON()));
  });

  it("records every concurrent delete of the same character", () => {
    const a = new FugueMax("a");
    const b = new FugueMax("b");
    const x = a.insert(0, "x");
    b.applyRemoteOp(x);
    const da = a.delete(0);
    const db = b.delete(0);
    a.applyRemoteOp(db);
    b.applyRemoteOp(da);
    expectConverged([a, b]);
    expect(a.toJSON().nodes[0]!.deletedBy).toEqual([["a", 1], ["b", 0]]);
  });

  it("rejects malformed ops without stranding well-formed ones", () => {
    const a = new FugueMax("a");
    const ops = a.insertText(0, "ab");
    const b = new FugueMax("b");
    const bogus: FugueOp = { type: "insert", id: { replicaId: "evil", counter: 0 }, char: "!", parent: null, side: "left", rightOrigin: null };
    expect(() => b.applyRemoteOp(bogus)).toThrow(/malformed/);
    deliverAll(b, ops);
    expect(b.toString()).toBe("ab");
  });

  it("validates untrusted ops", () => {
    const a = new FugueMax("a");
    const ins = a.insert(0, "x");
    const del = a.delete(0);
    expect(parseFugueOp(JSON.parse(JSON.stringify(ins)))).toEqual(ins);
    expect(parseFugueOp(JSON.parse(JSON.stringify(del)))).toEqual(del);
    for (const bad of [null, 1, {}, { ...ins, id: { replicaId: 1, counter: 0 } }, { ...ins, char: "" }, { ...ins, side: "up" },
      { ...ins, id: { replicaId: "a", counter: -1 } }, { ...ins, side: "left" }, { ...del, target: null }, { ...ins, type: "nope" }]) {
      expect(parseFugueOp(bad)).toBeNull();
    }
  });

  it("rejects out-of-range indices", () => {
    const doc = new FugueMax("a");
    expect(() => doc.insert(1, "x")).toThrow(RangeError);
    expect(() => doc.insert(-1, "x")).toThrow(RangeError);
    expect(() => doc.delete(0)).toThrow(RangeError);
    expect(() => doc.insert(0, "")).toThrow(TypeError);
  });
});

describe("FugueMax at scale", () => {
  it("matches a plain array model across chunk splits (single replica, 6000 random edits)", () => {
    const rng = new Prng(2024);
    const doc = new FugueMax("a");
    const model: string[] = [];
    for (let step = 0; step < 6000; step++) {
      if (model.length === 0 || rng.bool(0.7)) {
        // Bias towards the end and towards the last position, like real typing.
        const index = rng.bool(0.5) ? model.length : rng.int(model.length + 1);
        const ch = String.fromCharCode(97 + rng.int(26));
        doc.insert(index, ch);
        model.splice(index, 0, ch);
      } else {
        const index = rng.int(model.length);
        doc.delete(index);
        model.splice(index, 1);
      }
    }
    expect(doc.toString()).toBe(model.join(""));
    expect(doc.length).toBe(model.length);
    expect(doc.nodeCount - doc.tombstoneCount).toBe(model.length);
  });

  it("handles long forward and backward runs without recursion (deep trees)", () => {
    const n = 30_000;
    const forward = new FugueMax("a");
    for (let i = 0; i < n; i++) forward.insert(i, "x");
    const backward = new FugueMax("b");
    for (let i = 0; i < n; i++) backward.insert(0, "y");
    expect(forward.toString().length).toBe(n);
    expect(backward.toString().length).toBe(n);

    // A late concurrent sibling must be placed after the whole 30k-deep subtree.
    const other = new FugueMax("zz");
    const op = other.insert(0, "!");
    forward.applyRemoteOp(op);
    expect(forward.toString().endsWith("x!")).toBe(true);
    expect(FugueMax.fromJSON(forward.toJSON(), "c").toString()).toBe(forward.toString());
  });
});

describe("FugueMax serialization", () => {
  it("round-trips through JSON and the restored replica keeps converging", () => {
    fc.assert(
      fc.property(scenarioArb, scenarioArb, (first, second) => {
        const { replicas } = runScenario(factory, first);
        const original = replicas[0] as FugueMax;
        const restored = FugueMax.fromJSON(JSON.parse(JSON.stringify(original.toJSON())), original.replicaId);
        expect(JSON.stringify(restored.toJSON())).toBe(JSON.stringify(original.toJSON()));
        expect(restored.toString()).toBe(original.toString());

        // Continue editing: the restored replica and a peer restored from the same
        // state exchange fresh concurrent edits and must converge.
        const peer = FugueMax.fromJSON(original.toJSON(), "peer");
        const opsA: FugueOp[] = [];
        const opsB: FugueOp[] = [];
        for (const action of second.actions) {
          if (action.kind === "deliver") continue;
          const [doc, out] = action.replica % 2 === 0 ? [restored, opsA] : [peer, opsB];
          if (action.kind === "insert") out.push(doc.insert(action.pos % (doc.length + 1), action.char));
          else if (doc.length > 0) out.push(doc.delete(action.pos % doc.length));
        }
        deliverAll(restored, opsB.slice().reverse());
        deliverAll(peer, opsA);
        expectConverged([restored, peer]);
      }),
      { numRuns: 200 },
    );
  });

  it("serializes canonically: replicas that applied ops in different orders produce identical bytes", () => {
    const a = new FugueMax("a");
    const b = new FugueMax("b");
    const fromA = a.insertText(0, "left");
    const fromB = b.insertText(0, "right");
    deliverAll(a, fromB);
    deliverAll(b, fromA.slice().reverse());
    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
  });
});
