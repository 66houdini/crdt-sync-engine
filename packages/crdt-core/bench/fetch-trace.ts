/**
 * Downloads the real-world editing trace used by the benchmark into bench/.data/
 * (git-ignored). The trace is the keystroke-by-keystroke history of a LaTeX paper,
 * (c) Martin Kleppmann, published in automerge-perf and redistributed in Kevin
 * Jahns's crdt-benchmarks. It is not covered by this repository's license, which
 * is why it is fetched rather than committed.
 *
 *   pnpm bench:fetch
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const TRACE_URL = "https://raw.githubusercontent.com/dmonad/crdt-benchmarks/main/js-lib/b4-editing-trace.js";
export const TRACE_PATH = fileURLToPath(new URL("./.data/b4-editing-trace.js", import.meta.url));

async function main(): Promise<void> {
  if (existsSync(TRACE_PATH)) {
    console.log(`already present: ${TRACE_PATH}`);
    return;
  }
  console.log(`downloading ${TRACE_URL}`);
  let body = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(TRACE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.text();
      break;
    } catch (err) {
      if (attempt === 4) throw new Error(`download failed after ${attempt} attempts: ${String(err)}`);
      console.log(`  attempt ${attempt} failed, retrying`);
    }
  }
  mkdirSync(dirname(TRACE_PATH), { recursive: true });
  writeFileSync(TRACE_PATH, body);
  console.log(`saved ${(body.length / 1e6).toFixed(1)} MB to ${TRACE_PATH}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
