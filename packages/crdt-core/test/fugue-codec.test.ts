import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FugueMax, type FugueOp, decodeFugueState, encodeFugueState, utf8Decode, utf8Encode } from "../src/index";
import { runScenario, scenarioArb } from "./sequence-harness";

const factory = (id: string) => new FugueMax(id);

function isWellFormed(text: string): boolean {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

describe("UTF-8 helpers", () => {
  it("round-trip arbitrary strings and agree with the platform encoder", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200, size: "max" }), (text) => {
        // Lone surrogates are not valid text; the platform encoder replaces them, so skip those inputs.
        fc.pre(isWellFormed(text));
        const bytes = utf8Encode(text);
        expect([...bytes]).toEqual([...new TextEncoder().encode(text)]);
        expect(utf8Decode(bytes)).toBe(text);
      }),
      { numRuns: 500 },
    );
  });

  it("handles astral characters and long inputs", () => {
    const text = "h\u00e9llo \u{1F600} \u4e16\u754c ".repeat(5000);
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });
});

describe("FugueMax binary encoding", () => {
  it("is lossless for arbitrary concurrent histories", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const doc = runScenario(factory, scenario).replicas[0] as FugueMax;
        const state = doc.toJSON();
        expect(decodeFugueState(encodeFugueState(state))).toEqual(state);

        const restored = FugueMax.decode(doc.encode(), "restored");
        expect(restored.toString()).toBe(doc.toString());
        expect(JSON.stringify(restored.toJSON())).toBe(JSON.stringify(state));
      }),
      { numRuns: 500 },
    );
  });

  it("round-trips multi-code-unit characters, concurrent deletes and the empty document", () => {
    expect(FugueMax.decode(new FugueMax("a").encode(), "b").toJSON()).toEqual(new FugueMax("a").toJSON());

    const a = new FugueMax("alice");
    const b = new FugueMax("bob:with:colons");
    const ops: FugueOp[] = [a.insert(0, "\u{1F600}"), a.insert(1, "e\u0301"), a.insert(2, "\u4e16"), a.insert(3, "x")];
    for (const op of ops) b.applyRemoteOp(op);
    const da = a.delete(3);
    const db = b.delete(3); // the same character, deleted concurrently by both
    a.applyRemoteOp(db);
    b.applyRemoteOp(da);
    b.insert(0, "\u00df");

    const restored = FugueMax.decode(b.encode(), "carol");
    expect(restored.toJSON()).toEqual(b.toJSON());
    expect(restored.toString()).toBe("\u00df\u{1F600}e\u0301\u4e16");
    expect(restored.toJSON().nodes.at(-1)?.deletedBy).toHaveLength(2);
  });

  it("stores a run of ordinary typing in a handful of bytes beyond the text itself", () => {
    const doc = new FugueMax("writer");
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(250);
    doc.insertText(0, text);
    const bytes = doc.encode();
    expect(bytes.length).toBeLessThan(text.length + 40);
    expect(bytes.length).toBeLessThan(JSON.stringify(doc.toJSON()).length / 50);
    expect(FugueMax.decode(bytes, "reader").toString()).toBe(text);
  });

  it("stores right-to-left typing as compactly as left-to-right typing", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const forward = new FugueMax("writer");
    forward.insertText(0, text);
    const backward = new FugueMax("writer");
    for (const ch of [...text].reverse()) backward.insert(0, ch);
    expect(backward.toString()).toBe(text);

    const bytes = backward.encode();
    expect(bytes.length).toBeLessThan(text.length + 40);
    expect(Math.abs(bytes.length - forward.encode().length)).toBeLessThan(8);
    expect(FugueMax.decode(bytes, "reader").toJSON()).toEqual(backward.toJSON());
  });

  it("round-trips documents that mix forward runs, backward runs and concurrent siblings", () => {
    const a = new FugueMax("a");
    const b = new FugueMax("b");
    const base = a.insertText(0, "[]");
    for (const op of base) b.applyRemoteOp(op);
    const fromA: FugueOp[] = [..."olleh"].map((ch) => a.insert(1, ch)); // "hello", typed backward
    fromA.push(...a.insertText(6, " there")); // then forward from its end
    const fromB: FugueOp[] = [..."dlrow"].map((ch) => b.insert(1, ch)); // concurrent backward run
    for (const op of fromB) a.applyRemoteOp(op);
    for (const op of fromA) b.applyRemoteOp(op);
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toContain("hello there");
    expect(a.toString()).toContain("world");
    expect(FugueMax.decode(a.encode(), "reader").toJSON()).toEqual(a.toJSON());
  });

  it("stores held-down backspace as one run of delete dots", () => {
    const doc = new FugueMax("writer");
    doc.insertText(0, "x".repeat(2000));
    const before = doc.encode().length;
    for (let i = 0; i < 1000; i++) doc.delete(doc.length - 1);
    const after = doc.encode().length;
    // 1000 fewer characters of text, and the 1000 tombstones cost only a few bytes.
    expect(after).toBeLessThan(before - 980);
    expect(FugueMax.decode(doc.encode(), "reader").toJSON()).toEqual(doc.toJSON());
  });

  it("drops the text of deleted characters from memory and from the saved state", () => {
    const doc = new FugueMax("a");
    doc.insertText(0, "secret");
    for (let i = 0; i < 6; i++) doc.delete(0);
    expect(doc.toJSON().nodes.every((node) => node.char === "")).toBe(true);
    expect(utf8Decode(doc.encode())).not.toContain("secret");
  });

  it("rejects data that is not a FugueMax state", () => {
    expect(() => decodeFugueState(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/bad magic/);
    expect(() => decodeFugueState(new FugueMax("a").encode().slice(0, 5))).toThrow(/unexpected end/);
  });
});
