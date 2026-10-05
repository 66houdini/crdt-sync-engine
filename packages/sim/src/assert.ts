import type { SequenceCrdt } from "@crdt/core";

export class ConvergenceError extends Error {
  override readonly name = "ConvergenceError";
}

/**
 * Strong eventual consistency check, used by every simulator test: once all
 * messages are delivered, every replica must have nothing buffered, the same
 * visible text, and a byte-identical serialized internal structure.
 */
export function assertConverged<Op>(replicas: readonly SequenceCrdt<Op>[]): void {
  const first = replicas[0];
  if (first === undefined) return;
  const text = first.toString();
  const structure = JSON.stringify(first.toJSON());

  for (const replica of replicas) {
    if (replica.pendingCount !== 0) {
      throw new ConvergenceError(
        `replica ${replica.replicaId} still has ${replica.pendingCount} op(s) waiting for dependencies after full delivery`,
      );
    }
    if (replica.toString() !== text) {
      throw new ConvergenceError(
        `text diverged:\n  ${first.replicaId}: ${JSON.stringify(text)}\n  ${replica.replicaId}: ${JSON.stringify(replica.toString())}`,
      );
    }
    if (JSON.stringify(replica.toJSON()) !== structure) {
      throw new ConvergenceError(
        `same text but different internal structure on ${first.replicaId} and ${replica.replicaId} (text ${JSON.stringify(text)})`,
      );
    }
  }
}
