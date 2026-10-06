/**
 * Cold-start probe for a deployed relay: how large can a document get before
 * waking its Durable Object (rebuilding the document from SQLite) becomes slow or
 * exceeds the platform's CPU budget?
 *
 * For each size it writes a document with that many elements (about a quarter of
 * them deleted again, like real editing), waits until everything is durable,
 * disconnects, then waits for the object to be evicted and times the request
 * that wakes it. `/stats` reports an id that changes with every new instance,
 * which is how a cold start is told apart from a warm request.
 *
 *   pnpm --filter @crdt/demo-client measure --url wss://<worker>.workers.dev [--sizes 1000,5000,20000] [--idle 150]
 *
 * Wall-clock latency includes the network. For CPU time, run `wrangler tail
 * --format json` alongside and read `cpuTime` on the matching `/stats` event.
 */
import { Connection, parseArgs } from "./connection";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Stats {
  instance: string;
  seq: number;
  durableSeq: number;
  snapshotSeq: number;
  length: number;
  tombstones: number;
}

interface Probe {
  ok: boolean;
  status: number;
  ms: number;
  stats: Stats | null;
  body: string;
}

async function probe(httpBase: string, doc: string): Promise<Probe> {
  const start = performance.now();
  try {
    const response = await fetch(`${httpBase}/doc/${doc}/stats`);
    const body = await response.text();
    const ms = performance.now() - start;
    return { ok: response.ok, status: response.status, ms, stats: response.ok ? (JSON.parse(body) as Stats) : null, body: body.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, ms: performance.now() - start, stats: null, body: String(err) };
  }
}

async function build(url: string, doc: string, elements: number): Promise<void> {
  const conn = new Connection(url, doc, "loader");
  await conn.connect();
  const line = "The quick brown fox jumps over the lazy dog. ";
  let typed = 0;
  while (typed < elements) {
    const text = line.repeat(8).slice(0, Math.min(360, elements - typed));
    conn.insert(conn.session.doc.length, text);
    typed += text.length;
    // Delete roughly a quarter of what was just typed, as backspacing would.
    const erase = Math.min(Math.floor(text.length / 4), conn.session.doc.length);
    if (typed < elements && erase > 0) conn.delete(conn.session.doc.length - erase, erase);
    // Stay well below the relay's buffer and Cloudflare's message-rate comfort zone.
    if (conn.session.unackedCount > 4000) {
      for (let i = 0; i < 600 && conn.session.unackedCount > 0; i++) await sleep(100);
    }
  }
  for (let i = 0; i < 1200 && conn.session.unackedCount > 0; i++) await sleep(100);
  if (conn.session.unackedCount > 0) throw new Error(`relay did not acknowledge all ops for ${doc}`);
  conn.drop();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { url: "ws://127.0.0.1:8787", sizes: "1000,5000,20000", idle: "150", attempts: "4" });
  const url = args.url as string;
  const httpBase = url.replace(/^ws/, "http");
  const sizes = (args.sizes as string).split(",").map(Number);
  const idleSeconds = Number(args.idle);
  const attempts = Number(args.attempts);
  const run = Date.now().toString(36);

  console.log(`relay ${url}; waiting ${idleSeconds}s of idleness before each cold probe`);
  const docs: { size: number; doc: string; instance: string }[] = [];
  for (const size of sizes) {
    const doc = `measure-${run}-${size}`;
    process.stdout.write(`building ${doc} ... `);
    await build(url, doc, size);
    const warm = await probe(httpBase, doc);
    if (warm.stats === null) throw new Error(`could not read stats for ${doc}: ${warm.status} ${warm.body}`);
    console.log(
      `${warm.stats.length} live + ${warm.stats.tombstones} tombstones, seq ${warm.stats.seq}, snapshot at ${warm.stats.snapshotSeq}; warm request ${warm.ms.toFixed(0)} ms`,
    );
    docs.push({ size, doc, instance: warm.stats.instance });
  }

  console.log("");
  console.log("elements  result                 cold request   warm request");
  for (const entry of docs) {
    let line = `${String(entry.size).padStart(8)}  not evicted within the wait; raise --idle`;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await sleep(idleSeconds * 1000);
      const cold = await probe(httpBase, entry.doc);
      if (!cold.ok) {
        line = `${String(entry.size).padStart(8)}  FAILED (HTTP ${cold.status})      ${cold.ms.toFixed(0).padStart(8)} ms   ${cold.body.replace(/\s+/g, " ").slice(0, 80)}`;
        break;
      }
      if ((cold.stats as Stats).instance !== entry.instance) {
        const warm = await probe(httpBase, entry.doc);
        line = `${String(entry.size).padStart(8)}  rebuilt from storage   ${cold.ms.toFixed(0).padStart(8)} ms   ${warm.ms.toFixed(0).padStart(8)} ms`;
        break;
      }
    }
    console.log(line);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
