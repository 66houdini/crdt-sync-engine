/**
 * Replays one simulation exactly.
 *
 *   pnpm sim --seed 12345 [--crdt fugue|rga] [--gc] [--trace]
 *
 * Output is a pure function of the flags: the same seed prints the same bytes.
 */
import { FugueMax, type FugueOp, Prng } from "@crdt/core";
import { type CrdtFactory, type Maintenance, assertConverged, fnv1a, fugueGc, randomOptions, runSimulation } from "../src/index";
import { crdtFlag, intFlag, parseFlags, withCrdt } from "./common";

const flags = parseFlags(process.argv.slice(2));
const seed = intFlag(flags, "seed", 1);
const crdt = crdtFlag(flags, "fugue");
const showTrace = flags.has("trace");

const gc = flags.has("gc");
if (gc && crdt !== "fugue") throw new Error("--gc requires --crdt fugue");

function replay(): boolean {
  if (!gc) return withCrdt(crdt, (factory) => report(factory, null));
  return report<FugueOp>((id) => new FugueMax(id), fugueGc());
}

function report<Op>(factory: CrdtFactory<Op>, maintenance: Maintenance<Op> | null): boolean {
  const rng = new Prng(seed);
  const options = randomOptions(rng);
  console.log(`seed=${seed} crdt=${crdt}${gc ? "+gc" : ""} replicas=${options.replicas} steps=${options.steps}`);

  const result = runSimulation(factory, rng, options, maintenance);
  if (showTrace) for (const line of result.trace) console.log(line);

  const s = result.stats;
  console.log(
    `inserts=${s.inserts} deletes=${s.deletes} delivered=${s.delivered} duplicated=${s.duplicated} ` +
      `reordered=${s.reordered} partitions=${s.partitions} max-buffered=${s.maxBuffered} max-in-flight=${s.maxInFlight}`,
  );
  for (const replica of result.replicas) console.log(`${replica.replicaId}: ${JSON.stringify(replica.toString())}`);

  try {
    assertConverged(result.replicas);
  } catch (err) {
    console.log(`NOT CONVERGED: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const digest = fnv1a(`${result.trace.join("\n")}\n${JSON.stringify(result.replicas[0]?.toJSON())}`);
  console.log(`digest=${digest}`);
  console.log("CONVERGED");
  return true;
}

process.exit(replay() ? 0 : 1);
