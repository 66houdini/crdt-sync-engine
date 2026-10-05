import fc from "fast-check";
import { expect } from "vitest";
import { Prng, type SequenceCrdt } from "../src/index";

export type Factory<Op> = (replicaId: string) => SequenceCrdt<Op>;

export type Action =
  | { kind: "insert"; replica: number; pos: number; char: string }
  | { kind: "delete"; replica: number; pos: number }
  | { kind: "deliver"; to: number; pick: number; duplicate: boolean };

export interface Scenario {
  replicas: number;
  actions: Action[];
  finalSeed: number;
}

const charArb = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz");

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("insert" as const), replica: fc.nat(7), pos: fc.nat(1000), char: charArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("delete" as const), replica: fc.nat(7), pos: fc.nat(1000) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("deliver" as const), to: fc.nat(7), pick: fc.nat(1000), duplicate: fc.boolean() }) },
);

export const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  replicas: fc.integer({ min: 2, max: 4 }),
  actions: fc.array(actionArb, { maxLength: 80 }),
  finalSeed: fc.integer(),
});

export interface ScenarioResult<Op> {
  replicas: SequenceCrdt<Op>[];
  /** Every op in generation order, which is a valid causal order. */
  ops: Op[];
}

/**
 * Runs random concurrent edits with random, reordered, possibly duplicated delivery,
 * then delivers everything still in flight in a shuffled order. Along the way it
 * checks that every local edit has exactly the effect the user asked for.
 */
export function runScenario<Op>(factory: Factory<Op>, scenario: Scenario): ScenarioResult<Op> {
  const replicas = Array.from({ length: scenario.replicas }, (_, i) => factory(`r${i}`));
  const inboxes: Op[][] = replicas.map(() => []);
  const ops: Op[] = [];

  const broadcast = (from: number, op: Op): void => {
    ops.push(op);
    inboxes.forEach((inbox, i) => {
      if (i !== from) inbox.push(op);
    });
  };

  for (const action of scenario.actions) {
    if (action.kind === "deliver") {
      const to = action.to % replicas.length;
      const inbox = inboxes[to]!;
      if (inbox.length === 0) continue;
      const i = action.pick % inbox.length;
      replicas[to]!.applyRemoteOp(inbox[i]!);
      if (!action.duplicate) {
        inbox[i] = inbox[inbox.length - 1]!;
        inbox.pop();
      }
      continue;
    }

    const r = action.replica % replicas.length;
    const doc = replicas[r]!;
    const before = doc.toString();
    if (action.kind === "insert") {
      const index = action.pos % (doc.length + 1);
      broadcast(r, doc.insert(index, action.char));
      expect(doc.toString()).toBe(before.slice(0, index) + action.char + before.slice(index));
    } else if (doc.length > 0) {
      const index = action.pos % doc.length;
      broadcast(r, doc.delete(index));
      expect(doc.toString()).toBe(before.slice(0, index) + before.slice(index + 1));
    }
  }

  const rng = new Prng(scenario.finalSeed);
  replicas.forEach((doc, i) => {
    for (const op of rng.shuffle(inboxes[i]!)) {
      doc.applyRemoteOp(op);
      if (rng.bool(0.2)) doc.applyRemoteOp(op);
    }
  });

  return { replicas, ops };
}

export function expectConverged<Op>(replicas: readonly SequenceCrdt<Op>[]): void {
  const text = replicas[0]!.toString();
  const structure = JSON.stringify(replicas[0]!.toJSON());
  for (const doc of replicas) {
    expect(doc.pendingCount).toBe(0);
    expect(doc.toString()).toBe(text);
    expect(JSON.stringify(doc.toJSON())).toBe(structure);
  }
}

/** Types `text` left to right starting at `index`. */
export function typeForward<Op>(doc: SequenceCrdt<Op>, index: number, text: string): Op[] {
  return [...text].map((ch, i) => doc.insert(index + i, ch));
}

/** Types `text` right to left: every character is inserted at the same `index`. */
export function typeBackward<Op>(doc: SequenceCrdt<Op>, index: number, text: string): Op[] {
  return [...text].reverse().map((ch) => doc.insert(index, ch));
}

/** True if `a` and `b` both occur in `text` as contiguous substrings. */
export function bothIntact(text: string, a: string, b: string): boolean {
  return text.includes(a) && text.includes(b);
}
