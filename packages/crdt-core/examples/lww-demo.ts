/**
 * Milestone 1 acceptance demo: three replicas make random local writes to an
 * LWWRegister and an LWWMap, gossip in random order, then do a final exchange and
 * must all converge. Timestamps come from per-replica Lamport clocks (never the
 * wall clock); all randomness comes from one seeded Prng.
 *
 *   pnpm demo:lww --seed 42
 */
import { LWWMap, LWWRegister, Prng } from "../src/index";

interface Replica {
  id: string;
  clock: number;
  register: LWWRegister<string>;
  map: LWWMap<string, number>;
}

const KEYS = ["apple", "banana", "cherry", "date", "elder"];
const STEPS = 200;

function parseSeed(argv: readonly string[]): number {
  const i = argv.indexOf("--seed");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (raw === undefined) return 1;
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) throw new Error(`--seed must be an integer, got ${raw}`);
  return seed;
}

function maxTimestampOf(r: Replica): number {
  const stamps = [r.register.stamp()?.timestamp ?? 0, ...r.map.toJSON().map((e) => e.timestamp)];
  return Math.max(...stamps);
}

function localWrite(r: Replica, rng: Prng): void {
  r.clock += 1;
  if (rng.bool()) {
    r.register = r.register.set(`${r.id}@${r.clock}`, r.clock, r.id);
  } else if (rng.bool(0.75)) {
    r.map = r.map.set(rng.pick(KEYS), rng.int(100), r.clock, r.id);
  } else {
    r.map = r.map.delete(rng.pick(KEYS), r.clock, r.id);
  }
}

/** `to` receives `from`'s full state and advances its Lamport clock past everything it has seen. */
function receive(to: Replica, from: Replica): void {
  to.register = to.register.merge(from.register);
  to.map = to.map.merge(from.map);
  to.clock = Math.max(to.clock, maxTimestampOf(from));
}

function serialize(r: Replica): string {
  return JSON.stringify({ register: r.register.toJSON(), map: r.map.toJSON() });
}

function main(): void {
  const seed = parseSeed(process.argv);
  const rng = new Prng(seed);
  const replicas: Replica[] = ["r0", "r1", "r2"].map((id) => ({
    id,
    clock: 0,
    register: LWWRegister.empty<string>(),
    map: LWWMap.empty<string, number>(),
  }));

  let writes = 0;
  let merges = 0;
  for (let step = 0; step < STEPS; step++) {
    if (rng.bool(0.6)) {
      localWrite(rng.pick(replicas), rng);
      writes++;
    } else {
      const [from, to] = rng.shuffle(replicas);
      receive(to!, from!);
      merges++;
    }
  }

  const diverged = new Set(replicas.map(serialize)).size > 1;

  // Final anti-entropy: every ordered pair exchanges state once, in random order.
  // No new writes happen, and each replica always holds its own writes, so after
  // every replica has pulled from every other one they all hold the same writes.
  const pairs = replicas.flatMap((to) => replicas.filter((from) => from !== to).map((from) => [to, from] as const));
  for (const [to, from] of rng.shuffle(pairs)) receive(to, from);

  const states = replicas.map(serialize);
  const converged = states.every((s) => s === states[0]);

  console.log(`seed=${seed} writes=${writes} gossip-merges=${merges} diverged-before-sync=${diverged}`);
  for (const r of replicas) {
    console.log(`  ${r.id}: register=${JSON.stringify(r.register.value())} map=${JSON.stringify(Object.fromEntries(r.map.entries()))}`);
  }

  if (!converged) {
    console.error(`FAIL: replicas did not converge (seed=${seed})`);
    process.exit(1);
  }
  console.log("OK: all 3 replicas converged to identical state");
}

main();
