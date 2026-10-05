/** Common surface of the sequence CRDTs (RGA, FugueMax), used by tests and the simulator. */
export interface SequenceCrdt<Op> {
  readonly replicaId: string;
  /** Number of visible (non-deleted) characters. */
  readonly length: number;
  /** Remote ops buffered because a causal dependency has not arrived yet. */
  readonly pendingCount: number;
  /** Inserts `char` so that it becomes the visible character at `index`; returns the op to broadcast. */
  insert(index: number, char: string): Op;
  /** Deletes the visible character at `index`; returns the op to broadcast. */
  delete(index: number): Op;
  /** Applies an op from another replica. Safe under reordering and duplication. */
  applyRemoteOp(op: Op): void;
  toString(): string;
  /** Canonical serialization of the full internal structure, tombstones included. */
  toJSON(): unknown;
}
