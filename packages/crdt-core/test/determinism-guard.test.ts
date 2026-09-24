import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tripwire for the determinism rule: crdt-core and the simulator must take all
 * randomness from an explicitly passed seeded Prng and must never read a clock or
 * schedule timers. This is a lexical scan, not a proof (aliasing such as
 * `const M = Math; M.random()` would slip past), but it catches the realistic mistakes.
 */
const GUARDED_ROOTS = ["../src", "../../sim/src"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bMath\s*\.\s*random\b/, "Math.random"],
  [/\bMath\s*\[\s*["'`]random/, "Math['random']"],
  [/\bDate\s*\.\s*now\b/, "Date.now"],
  [/(?<![.\w$])Date\s*\(/, "Date()"],
  [/\bnew\s+Date\b/, "new Date"],
  [/\bperformance\s*\.\s*now\b/, "performance.now"],
  [/\bprocess\s*\.\s*hrtime\b/, "process.hrtime"],
  [/\bcrypto\s*\.\s*(getRandomValues|randomUUID|randomBytes|randomInt)\b/, "crypto randomness"],
  [/\b(setTimeout|setInterval|setImmediate)\s*\(/, "timer"],
];

/** Removes comments so docs may mention forbidden APIs. Naive about `//` inside strings, which only hides code, never invents a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function findViolations(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  code.split("\n").forEach((line, i) => {
    for (const [pattern, name] of FORBIDDEN) {
      if (pattern.test(line)) hits.push(`line ${i + 1}: ${name}: ${line.trim()}`);
    }
  });
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|cts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("determinism guard", () => {
  it("finds no clocks, ambient randomness, or timers in crdt-core/src and sim/src", () => {
    const files = GUARDED_ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      findViolations(readFileSync(file, "utf8")).map((hit) => `${relative(process.cwd(), file)} ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it("detects each forbidden pattern (the guard itself is meaningful)", () => {
    const samples = [
      "const x = Math.random();",
      "const x = Math['random']();",
      "const t = Date.now();",
      "const t = Date();",
      "const d = new Date(0);",
      "const t = performance.now();",
      "const t = process.hrtime.bigint();",
      "crypto.getRandomValues(buf);",
      "const id = crypto.randomUUID();",
      "setTimeout(fn, 10);",
      "setInterval(fn, 10);",
    ];
    for (const sample of samples) {
      expect(findViolations(sample), sample).not.toEqual([]);
    }
  });

  it("ignores comments and innocent look-alikes", () => {
    const clean = [
      "// never call Math.random() here",
      "/* Date.now() is forbidden */",
      "const x = rng.next();",
      "const updatedDate = parseDate(s);",
      "obj.Date(1);",
    ];
    for (const sample of clean) {
      expect(findViolations(sample), sample).toEqual([]);
    }
  });
});
