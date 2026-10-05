import { FugueMax, Prng, RGA } from "@crdt/core";
import { describe, expect, it } from "vitest";
import { concurrentWordsScenario } from "../src/index";

const rga = (id: string) => new RGA(id);
const fugue = (id: string) => new FugueMax(id);

/**
 * Interleaving-anomaly demo, after Kleppmann, Gomes, Mulligan & Beresford,
 * "Interleaving anomalies in collaborative text editors" (PaPoC 2019).
 *
 * Two replicas share the document ">" and concurrently insert "the" and "fox"
 * at the same position, right after ">".
 *
 * What that paper establishes, and what these tests pin down, is direction
 * dependent. RGA does NOT interleave words typed left to right: each word forms
 * its own chain of origins. It DOES interleave words typed right to left (every
 * character inserted at the same position), because then all six characters
 * share one origin and are ordered purely by timestamp. So the anomaly is
 * asserted for backward typing, and its absence for forward typing is asserted
 * too rather than left implicit.
 *
 * Each case is repeated over many seeds: the seed only changes delivery order
 * and duplication, which must not affect the outcome.
 */
describe("interleaving anomaly: RGA baseline vs FugueMax", () => {
  const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);

  it("RGA: concurrent words typed backward come out interleaved (the anomaly is present)", () => {
    for (const seed of SEEDS) {
      const outcome = concurrentWordsScenario(rga, new Prng(seed), "backward");
      expect(outcome.intact).toBe(false);
      expect(outcome.text.includes("the")).toBe(false);
      expect(outcome.text.includes("fox")).toBe(false);
      // No characters were lost or invented; they are just shuffled together.
      expect([...outcome.text].sort().join("")).toBe([...">thefox"].sort().join(""));
      // Deterministic garbling: timestamp order with replica id as tie-break.
      expect(outcome.text).toBe(">ftohxe");
    }
  });

  it("FugueMax: the same backward-typed words both stay intact", () => {
    for (const seed of SEEDS) {
      const outcome = concurrentWordsScenario(fugue, new Prng(seed), "backward");
      expect(outcome.intact).toBe(true);
      expect(["the", "fox"].every((w) => outcome.text.includes(w))).toBe(true);
      expect(outcome.text).toBe(">thefox");
    }
  });

  it("FugueMax: forward-typed words stay intact", () => {
    for (const seed of SEEDS) {
      const outcome = concurrentWordsScenario(fugue, new Prng(seed), "forward");
      expect(outcome.intact).toBe(true);
      expect(outcome.text).toBe(">thefox");
    }
  });

  it("RGA: forward-typed words also stay intact (RGA's anomaly is specific to backward insertion)", () => {
    for (const seed of SEEDS) {
      const outcome = concurrentWordsScenario(rga, new Prng(seed), "forward");
      expect(outcome.intact).toBe(true);
      expect(outcome.text).toBe(">foxthe");
    }
  });

  it("holds for arbitrary word pairs: RGA garbles every backward pair, FugueMax none", () => {
    const pairs: [string, string][] = [
      ["Alice", "Charlie"],
      ["hello", "world"],
      ["ab", "xy"],
      ["milk, ", "eggs, "],
    ];
    for (const words of pairs) {
      for (const seed of [1, 2, 3]) {
        expect(concurrentWordsScenario(rga, new Prng(seed), "backward", words, "List: ").intact).toBe(false);
        expect(concurrentWordsScenario(fugue, new Prng(seed), "backward", words, "List: ").intact).toBe(true);
        expect(concurrentWordsScenario(fugue, new Prng(seed), "forward", words, "List: ").intact).toBe(true);
      }
    }
  });
});
