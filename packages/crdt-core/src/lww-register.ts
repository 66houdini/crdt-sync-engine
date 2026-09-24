/** Identifies a write. Precondition: a `(timestamp, replicaId)` pair is never reused for a different write. */
export interface Stamp {
  readonly timestamp: number;
  readonly replicaId: string;
}

export interface LWWState<T> extends Stamp {
  readonly value: T;
}

/** `null` is the empty register (no write observed yet). */
export type LWWRegisterJSON<T> = LWWState<T> | null;

/**
 * Total order on stamps: higher timestamp wins; equal timestamps are broken by
 * replicaId. Uses plain code-unit string comparison, never `localeCompare`,
 * whose result depends on the host locale and would break convergence.
 */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.replicaId === b.replicaId) return 0;
  return a.replicaId < b.replicaId ? -1 : 1;
}

export function assertValidStamp(timestamp: number, replicaId: string): void {
  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`LWW timestamp must be finite, got ${timestamp}`);
  }
  if (typeof replicaId !== "string") {
    throw new TypeError(`LWW replicaId must be a string, got ${typeof replicaId}`);
  }
}

/**
 * Last-write-wins register. Immutable: `set` and `merge` return a register and
 * never modify their operands, which makes the merge laws directly testable.
 * `T` should be JSON-serializable for `toJSON`/`fromJSON` to round-trip.
 */
export class LWWRegister<T> {
  private constructor(private readonly state: LWWState<T> | null) {}

  static empty<T>(): LWWRegister<T> {
    return new LWWRegister<T>(null);
  }

  static of<T>(value: T, timestamp: number, replicaId: string): LWWRegister<T> {
    return LWWRegister.empty<T>().set(value, timestamp, replicaId);
  }

  /** Applies a write; it only takes effect if its stamp beats the current one. */
  set(value: T, timestamp: number, replicaId: string): LWWRegister<T> {
    assertValidStamp(timestamp, replicaId);
    return this.merge(new LWWRegister<T>({ value, timestamp, replicaId }));
  }

  merge(other: LWWRegister<T>): LWWRegister<T> {
    if (other.state === null) return this;
    if (this.state === null) return other;
    return compareStamps(other.state, this.state) > 0 ? other : this;
  }

  value(): T | undefined {
    return this.state?.value;
  }

  stamp(): Stamp | undefined {
    return this.state === null
      ? undefined
      : { timestamp: this.state.timestamp, replicaId: this.state.replicaId };
  }

  isEmpty(): boolean {
    return this.state === null;
  }

  toJSON(): LWWRegisterJSON<T> {
    return this.state === null ? null : { ...this.state };
  }

  static fromJSON<T>(json: LWWRegisterJSON<T>): LWWRegister<T> {
    if (json === null) return LWWRegister.empty<T>();
    return LWWRegister.of(json.value, json.timestamp, json.replicaId);
  }
}
