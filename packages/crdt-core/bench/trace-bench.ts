/**
 * Replays the crdt-benchmarks "B4" real-world editing trace through FugueMax and
 * reports throughput and saved-state size.
 *
 *   pnpm bench:fetch   # once
 *   pnpm bench
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FugueMax, type FugueEncodingBreakdown, type FugueOp, encodeFugueState, utf8Encode } from "../src/index";
import { TRACE_PATH } from "./fetch-trace";

type Edit = [position: number, deleteCount: number, inserted?: string];

interface Trace {
  edits: Edit[];
  finalText: string;
}

const WARMUP = 2;
const TRIALS = 7;

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

function replay(edits: readonly Edit[], collect: FugueOp[] | null): FugueMax {
  const doc = new FugueMax("author");
  for (const [position, deleteCount, inserted] of edits) {
    for (let i = 0; i < deleteCount; i++) {
      const op = doc.delete(position);
      if (collect !== null) collect.push(op);
    }
    if (inserted !== undefined) {
      for (let i = 0; i < inserted.length; i++) {
        const op = doc.insert(position + i, inserted[i] as string);
        if (collect !== null) collect.push(op);
      }
    }
  }
  return doc;
}

function time<T>(body: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = body();
  return { ms: performance.now() - start, value };
}

function measure<T>(body: () => T): { ms: number; value: T } {
  for (let i = 0; i < WARMUP; i++) body();
  const runs = Array.from({ length: TRIALS }, () => time(body));
  return { ms: median(runs.map((r) => r.ms)), value: (runs[0] as { value: T }).value };
}

const kB = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;
const perSec = (ops: number, ms: number): string => `${Math.round(ops / (ms / 1000)).toLocaleString("en-US")} ops/s`;

async function main(): Promise<void> {
  if (!existsSync(TRACE_PATH)) {
    console.error("trace not found; run `pnpm bench:fetch` first");
    process.exit(1);
  }
  const trace = (await import(pathToFileURL(TRACE_PATH).href)) as Trace;
  const { edits, finalText } = trace;

  const ops: FugueOp[] = [];
  const reference = replay(edits, ops);
  if (reference.toString() !== finalText) throw new Error("replay does not reproduce the trace's final text");
  const inserts = ops.filter((op) => op.type === "insert").length;
  const deletes = ops.length - inserts;

  const local = measure(() => replay(edits, null));
  const remote = measure(() => {
    const doc = new FugueMax("reader");
    for (const op of ops) doc.applyRemoteOp(op);
    return doc;
  });
  if (JSON.stringify(remote.value.toJSON()) !== JSON.stringify(reference.toJSON())) {
    throw new Error("remote replay diverged from local replay");
  }

  const encoded = measure(() => reference.encode());
  const decoded = measure(() => FugueMax.decode(encoded.value, "loader"));
  if (decoded.value.toString() !== finalText) throw new Error("decode does not reproduce the final text");
  const json = measure(() => JSON.stringify(reference.toJSON()));

  const textBytes = utf8Encode(finalText).length;
  const saved = encoded.value.length;
  const metadata = saved - textBytes;
  const opBytes = utf8Encode(JSON.stringify(ops)).length / ops.length;

  console.log(`trace: ${ops.length.toLocaleString("en-US")} ops (${inserts.toLocaleString("en-US")} inserts, ${deletes.toLocaleString("en-US")} deletes)`);
  console.log(`final document: ${finalText.length.toLocaleString("en-US")} chars, ${kB(textBytes)} as UTF-8; ${reference.tombstoneCount.toLocaleString("en-US")} tombstones`);
  console.log(`node ${process.version}, median of ${TRIALS} runs after ${WARMUP} warm-ups`);
  console.log("");
  console.log(`local edits (insert/delete by index)   ${perSec(ops.length, local.ms).padStart(18)}   ${local.ms.toFixed(0)} ms`);
  console.log(`remote ops  (applyRemoteOp)            ${perSec(ops.length, remote.ms).padStart(18)}   ${remote.ms.toFixed(0)} ms`);
  console.log("");
  console.log(`saved state (binary)                   ${kB(saved).padStart(18)}   save ${encoded.ms.toFixed(0)} ms, load ${decoded.ms.toFixed(0)} ms`);
  console.log(`  of which CRDT metadata               ${kB(metadata).padStart(18)}   ${((metadata / textBytes) * 100).toFixed(0)}% of the text size`);
  console.log(`  metadata per visible character       ${(metadata / finalText.length).toFixed(2).padStart(12)} bytes`);
  console.log(`  metadata per character ever typed    ${(metadata / inserts).toFixed(2).padStart(12)} bytes`);
  const parts: FugueEncodingBreakdown = { header: 0, structure: 0, runs: 0, text: 0, tombstoneFlags: 0, deleteDots: 0 };
  encodeFugueState(reference.toJSON(), parts);
  console.log(`  breakdown: tree structure ${kB(parts.structure)} in ${parts.runs.toLocaleString("en-US")} runs, tombstone flags ${kB(parts.tombstoneFlags)}, delete-op ids ${kB(parts.deleteDots)}, text ${kB(parts.text)}, header ${parts.header} B`);
  console.log(`saved state (JSON, for comparison)     ${kB(json.value.length).padStart(18)}   ${json.ms.toFixed(0)} ms`);
  console.log(`network op size (JSON)                 ${opBytes.toFixed(0).padStart(12)} bytes/op`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
