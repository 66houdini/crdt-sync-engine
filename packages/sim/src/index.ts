// Deterministic network simulator for @crdt/core. No clocks, timers, or ambient randomness.
export { ConvergenceError, assertConverged } from "./assert";
export {
  DEFAULT_OPTIONS,
  randomOptions,
  runSimulation,
  type CrdtFactory,
  type Maintenance,
  type SimOptions,
  type SimResult,
  type SimStats,
} from "./simulator";
export { fnv1a, fuzz, runSeed, type FuzzFailure, type FuzzReport, type SeedRun } from "./fuzz";
export { fugueGc } from "./gc";
export { concurrentWordsScenario, type AnomalyOutcome, type TypingDirection } from "./anomaly";
