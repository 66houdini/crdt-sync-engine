import type { Prng, SequenceCrdt } from "@crdt/core";
import { assertConverged } from "./assert";
import type { CrdtFactory } from "./simulator";

export type TypingDirection = "forward" | "backward";

export interface AnomalyOutcome {
  text: string;
  /** Both words survive as contiguous substrings. */
  intact: boolean;
}

/**
 * The scenario from Kleppmann, Gomes, Mulligan & Beresford, "Interleaving
 * anomalies in collaborative text editors" (PaPoC 2019): starting from a shared
 * document, two replicas concurrently insert a multi-character word at the same
 * position, then exchange their edits.
 *
 * `direction` is how each word is keyed in. "forward" is ordinary left-to-right
 * typing. "backward" inserts every character at the same index (the last letter
 * first), which is what happens when a user repeatedly prepends or types with the
 * cursor held in place. That paper shows RGA only interleaves in the second case;
 * Logoot/LSEQ-style CRDTs interleave in the first as well.
 *
 * Delivery order and duplication are drawn from `rng`, so the outcome is shown
 * to hold independently of network behaviour.
 */
export function concurrentWordsScenario<Op>(
  factory: CrdtFactory<Op>,
  rng: Prng,
  direction: TypingDirection,
  words: readonly [string, string] = ["the", "fox"],
  base = ">",
): AnomalyOutcome {
  const a = factory("a");
  const b = factory("b");

  const baseOps: Op[] = [...base].map((ch, i) => a.insert(i, ch));
  for (const op of baseOps) b.applyRemoteOp(op);

  const at = base.length;
  const type = (doc: SequenceCrdt<Op>, word: string): Op[] =>
    direction === "forward"
      ? [...word].map((ch, i) => doc.insert(at + i, ch))
      : [...word].reverse().map((ch) => doc.insert(at, ch));

  // Concurrent: neither replica has seen the other's word yet.
  const fromA = type(a, words[0]);
  const fromB = type(b, words[1]);

  const exchange = (to: SequenceCrdt<Op>, ops: readonly Op[]): void => {
    for (const op of rng.shuffle(ops)) {
      to.applyRemoteOp(op);
      if (rng.bool(0.3)) to.applyRemoteOp(op);
    }
  };
  exchange(a, fromB);
  exchange(b, fromA);

  assertConverged([a, b]);
  const text = a.toString();
  return { text, intact: text.includes(words[0]) && text.includes(words[1]) };
}
