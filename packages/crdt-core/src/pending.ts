/**
 * Holds operations whose causal dependencies have not arrived yet. Each parked op
 * waits on exactly one missing id; when that id is applied the op is released and
 * re-examined (it may then park again on its next missing dependency). This is
 * what lets the sequence CRDTs tolerate arbitrary reordering and duplication.
 */
export class PendingBuffer<Op> {
  private readonly waiting = new Map<string, Op[]>();
  private count = 0;

  park(missingKey: string, op: Op): void {
    const list = this.waiting.get(missingKey);
    if (list === undefined) this.waiting.set(missingKey, [op]);
    else list.push(op);
    this.count++;
  }

  /** Removes and returns every op that was waiting on `key`, in arrival order. */
  release(key: string): Op[] {
    if (this.count === 0) return [];
    const list = this.waiting.get(key);
    if (list === undefined) return [];
    this.waiting.delete(key);
    this.count -= list.length;
    return list;
  }

  get size(): number {
    return this.count;
  }
}
