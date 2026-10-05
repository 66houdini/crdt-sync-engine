/**
 * Convergence fuzzer: runs the simulator over a range of seeds and fails loudly
 * on the first one that does not converge.
 *
 *   pnpm sim:fuzz [--seeds 2000] [--start 1] [--crdt fugue|rga]
 *
 * A failing seed is reproduced exactly with `pnpm sim --seed <seed>`.
 */
import { fuzz } from "../src/index";
import { crdtFlag, intFlag, parseFlags, withCrdt } from "./common";

const flags = parseFlags(process.argv.slice(2));
const count = intFlag(flags, "seeds", 2000);
const start = intFlag(flags, "start", 1);
const crdt = crdtFlag(flags, "fugue");

const report = withCrdt(crdt, (factory) => fuzz(factory, start, count));
const t = report.totals;
console.log(
  `crdt=${crdt} seeds=${start}..${start + report.seeds - 1} inserts=${t.inserts} deletes=${t.deletes} ` +
    `delivered=${t.delivered} duplicated=${t.duplicated} reordered=${t.reordered} partitions=${t.partitions}`,
);

if (report.failure !== null) {
  const bar = "=".repeat(72);
  console.error(bar);
  console.error(`CONVERGENCE FAILURE   crdt=${crdt}   seed=${report.failure.seed}`);
  console.error(report.failure.error.message);
  console.error(`Reproduce with:  pnpm sim --seed ${report.failure.seed} --crdt ${crdt} --trace`);
  console.error(bar);
  process.exit(1);
}
console.log(`OK: all ${report.seeds} seeds converged`);
