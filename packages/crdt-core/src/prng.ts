/**
 * Small deterministic PRNG (mulberry32).
 *
 * Every source of randomness in crdt-core and the simulator must flow through an
 * explicitly passed instance of this class, so any run can be replayed exactly
 * from its seed. The output sequence is part of the replay contract: changing
 * this algorithm invalidates previously recorded failing seeds.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError(`Prng seed must be a safe integer, got ${seed}`);
    }
    this.state = seed >>> 0;
  }

  /** Uniform integer in [0, 2^32). */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 4294967296) {
      throw new RangeError(`Prng.int bound must be an integer in [1, 2^32], got ${maxExclusive}`);
    }
    return Math.floor(this.next() * maxExclusive);
  }

  /** True with probability `p`. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Prng.pick from empty array");
    return items[this.int(items.length)] as T;
  }

  /** Returns a shuffled copy (Fisher-Yates); the input is not modified. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}
