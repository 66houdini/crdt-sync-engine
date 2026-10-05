import type { Prng, SequenceCrdt } from "@crdt/core";

export type CrdtFactory<Op> = (replicaId: string) => SequenceCrdt<Op>;

export interface SimOptions {
  replicas: number;
  steps: number;
  /** Relative likelihood of each kind of step. */
  weights: { edit: number; deliver: number; duplicate: number; partition: number };
  /** Chance that an edit is a deletion (when there is something to delete). */
  deleteProbability: number;
  /** Longest run of characters typed in one edit. */
  maxBurst: number;
  /** Chance that a run is typed right-to-left (every character at the same index). */
  backwardProbability: number;
  /** Longest partition, in steps. */
  maxPartitionSteps: number;
}

export const DEFAULT_OPTIONS: SimOptions = {
  replicas: 3,
  steps: 200,
  weights: { edit: 4, deliver: 5, duplicate: 1, partition: 0.5 },
  deleteProbability: 0.25,
  maxBurst: 4,
  backwardProbability: 0.3,
  maxPartitionSteps: 40,
};

/** Draws a scenario shape from the PRNG, so each fuzz seed explores a different regime. */
export function randomOptions(rng: Prng): SimOptions {
  return {
    replicas: 2 + rng.int(4),
    steps: 40 + rng.int(260),
    weights: {
      edit: 1 + rng.int(6),
      deliver: 1 + rng.int(8),
      duplicate: rng.int(3),
      partition: rng.next(),
    },
    deleteProbability: rng.next() * 0.5,
    maxBurst: 1 + rng.int(6),
    backwardProbability: rng.next(),
    maxPartitionSteps: 5 + rng.int(80),
  };
}

export interface SimStats {
  inserts: number;
  deletes: number;
  /** Deliveries, counting repeats. */
  delivered: number;
  /** Deliveries of a message that was already delivered at least once. */
  duplicated: number;
  /** Deliveries that overtook an older message on the same sender -> recipient link. */
  reordered: number;
  partitions: number;
  /** Most ops any replica had parked waiting for a causal dependency. */
  maxBuffered: number;
  maxInFlight: number;
}

export interface SimResult<Op> {
  replicas: SequenceCrdt<Op>[];
  options: SimOptions;
  stats: SimStats;
  /** One line per event; identical for identical seeds. */
  trace: string[];
}

interface Message<Op> {
  readonly n: number;
  readonly from: number;
  readonly to: number;
  readonly op: Op;
  deliveries: number;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/**
 * Runs N replicas in-process against a fully simulated network: no sockets, no
 * timers, no clock. Every decision (who acts, what they do, which message is
 * delivered next, what is duplicated, who is partitioned and for how long) is
 * drawn from the one PRNG passed in, so a run is a pure function of its seed.
 *
 * Faults modelled:
 *  - reordering: the next message delivered is a uniformly random one in flight;
 *  - duplication: a message can be delivered and left in flight to arrive again;
 *  - partition / heal: a replica stops receiving for a random window (it keeps
 *    editing and sending), then catches up on everything queued, in random order.
 *
 * The run ends by healing every partition and delivering all remaining messages
 * in random order. It does not itself assert convergence; pass the result's
 * replicas to `assertConverged`.
 */
export function runSimulation<Op>(factory: CrdtFactory<Op>, rng: Prng, options: SimOptions = DEFAULT_OPTIONS): SimResult<Op> {
  const replicas = Array.from({ length: options.replicas }, (_, i) => factory(`r${i}`));
  const inFlight: Message<Op>[] = [];
  const partitionedUntil = replicas.map(() => 0);
  const trace: string[] = [];
  const stats: SimStats = {
    inserts: 0,
    deletes: 0,
    delivered: 0,
    duplicated: 0,
    reordered: 0,
    partitions: 0,
    maxBuffered: 0,
    maxInFlight: 0,
  };
  let messageCount = 0;
  let step = 0;

  const log = (line: string): void => {
    trace.push(`${String(step).padStart(4, "0")} ${line}`);
  };

  const broadcast = (from: number, op: Op): void => {
    for (let to = 0; to < replicas.length; to++) {
      if (to !== from) inFlight.push({ n: messageCount++, from, to, op, deliveries: 0 });
    }
    if (inFlight.length > stats.maxInFlight) stats.maxInFlight = inFlight.length;
  };

  const deliver = (index: number, keepInFlight: boolean): void => {
    const message = inFlight[index] as Message<Op>;
    const overtook = inFlight.some((m) => m.from === message.from && m.to === message.to && m.n < message.n && m.deliveries === 0);
    const target = replicas[message.to] as SequenceCrdt<Op>;
    target.applyRemoteOp(message.op);
    stats.delivered++;
    if (message.deliveries > 0) stats.duplicated++;
    else if (overtook) stats.reordered++;
    message.deliveries++;
    if (target.pendingCount > stats.maxBuffered) stats.maxBuffered = target.pendingCount;
    log(`deliver${keepInFlight ? "+keep" : ""} #${message.n} r${message.from}->r${message.to}`);
    if (!keepInFlight) {
      inFlight[index] = inFlight[inFlight.length - 1] as Message<Op>;
      inFlight.pop();
    }
  };

  const deliverableIndices = (): number[] => {
    const out: number[] = [];
    inFlight.forEach((m, i) => {
      if (partitionedUntil[m.to] === 0) out.push(i);
    });
    return out;
  };

  const drainTo = (to: number): void => {
    const queued = rng.shuffle(inFlight.filter((m) => m.to === to).map((m) => m.n));
    for (const n of queued) deliver(inFlight.findIndex((m) => m.n === n), false);
  };

  const edit = (): void => {
    const r = rng.int(replicas.length);
    const doc = replicas[r] as SequenceCrdt<Op>;
    const before = doc.toString();

    if (doc.length > 0 && rng.bool(options.deleteProbability)) {
      const count = Math.min(doc.length, 1 + rng.int(3));
      const index = rng.int(doc.length - count + 1);
      for (let i = 0; i < count; i++) broadcast(r, doc.delete(index));
      stats.deletes += count;
      log(`r${r} delete ${count}@${index}`);
      expectText(doc, before.slice(0, index) + before.slice(index + count), step);
      return;
    }

    const length = 1 + rng.int(options.maxBurst);
    const index = rng.int(doc.length + 1);
    const backward = rng.bool(options.backwardProbability);
    let text = "";
    for (let i = 0; i < length; i++) text += ALPHABET[rng.int(ALPHABET.length)];
    if (backward) {
      for (let i = length - 1; i >= 0; i--) broadcast(r, doc.insert(index, text[i] as string));
    } else {
      for (let i = 0; i < length; i++) broadcast(r, doc.insert(index + i, text[i] as string));
    }
    stats.inserts += length;
    log(`r${r} insert${backward ? "<" : ">"} ${JSON.stringify(text)}@${index}`);
    expectText(doc, before.slice(0, index) + text + before.slice(index), step);
  };

  const { weights } = options;
  const totalWeight = weights.edit + weights.deliver + weights.duplicate + weights.partition;

  for (step = 1; step <= options.steps; step++) {
    for (let r = 0; r < replicas.length; r++) {
      if (partitionedUntil[r] !== 0 && (partitionedUntil[r] as number) <= step) {
        partitionedUntil[r] = 0;
        log(`heal r${r}`);
        drainTo(r);
      }
    }

    let roll = rng.next() * totalWeight;
    if ((roll -= weights.edit) < 0) {
      edit();
    } else if ((roll -= weights.deliver) < 0) {
      const candidates = deliverableIndices();
      if (candidates.length === 0) edit();
      else deliver(rng.pick(candidates), false);
    } else if ((roll -= weights.duplicate) < 0) {
      const candidates = deliverableIndices();
      if (candidates.length === 0) edit();
      else deliver(rng.pick(candidates), true);
    } else {
      const r = rng.int(replicas.length);
      if (partitionedUntil[r] === 0) {
        partitionedUntil[r] = step + 1 + rng.int(options.maxPartitionSteps);
        stats.partitions++;
        log(`partition r${r} until ${partitionedUntil[r]}`);
      }
    }
  }

  // Quiescence: heal everything, then deliver all that is still in flight, in
  // random order, occasionally twice.
  step = options.steps + 1;
  partitionedUntil.fill(0);
  log("quiesce");
  for (const n of rng.shuffle(inFlight.map((m) => m.n))) {
    const again = rng.bool(0.1);
    deliver(inFlight.findIndex((m) => m.n === n), again);
    if (again) deliver(inFlight.findIndex((m) => m.n === n), false);
  }

  return { replicas, options, stats, trace };
}

function expectText<Op>(doc: SequenceCrdt<Op>, expected: string, step: number): void {
  const actual = doc.toString();
  if (actual !== expected) {
    throw new Error(
      `step ${step}: local edit on ${doc.replicaId} had the wrong effect: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
