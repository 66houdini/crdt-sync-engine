import { type Id, idKey } from "./ids";
import { PendingBuffer } from "./pending";
import type { SequenceCrdt } from "./sequence";

export type RgaOp =
  | { readonly type: "insert"; readonly id: Id; readonly char: string; readonly originId: Id | null }
  | { readonly type: "delete"; readonly target: Id };

interface RgaElem {
  readonly id: Id;
  readonly char: string;
  readonly originId: Id | null;
  tombstone: boolean;
}

export interface RgaJSON {
  elems: { id: Id; char: string; originId: Id | null; tombstone: boolean }[];
}

/** RGA timestamp order: Lamport counter first, replicaId as tie-break. */
function compareTimestamps(a: Id, b: Id): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.replicaId < b.replicaId ? -1 : a.replicaId > b.replicaId ? 1 : 0;
}

/**
 * Replicated Growable Array (Roh et al.), the baseline sequence CRDT.
 *
 * Each element records the element it was inserted after (its origin). Ids carry a
 * Lamport counter, so an element's id is always greater than its origin's. The
 * list order is the pre-order walk of the origin tree with siblings sorted by
 * descending id, which the classic linear rule computes directly: start right
 * after the origin and skip every element with a greater id.
 *
 * RGA keeps concurrent forward-typed runs intact but interleaves runs that were
 * typed backward (repeatedly inserting at the same position): all those characters
 * share one origin and are ordered purely by timestamp. FugueMax fixes that.
 *
 * Kept deliberately simple (flat array, O(n) per op); it is a baseline, not the product.
 */
export class RGA implements SequenceCrdt<RgaOp> {
  private clock = 0;
  private readonly elems: RgaElem[] = [];
  private readonly byId = new Map<string, RgaElem>();
  private readonly pending = new PendingBuffer<RgaOp>();
  private visible = 0;

  constructor(readonly replicaId: string) {}

  get length(): number {
    return this.visible;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  insert(index: number, char: string): RgaOp {
    if (!Number.isInteger(index) || index < 0 || index > this.visible) {
      throw new RangeError(`RGA.insert index ${index} out of range [0, ${this.visible}]`);
    }
    const origin = index === 0 ? null : this.visibleAt(index - 1);
    const op: RgaOp = {
      type: "insert",
      id: { replicaId: this.replicaId, counter: this.clock + 1 },
      char,
      originId: origin === null ? null : origin.id,
    };
    this.applyRemoteOp(op);
    return op;
  }

  delete(index: number): RgaOp {
    if (!Number.isInteger(index) || index < 0 || index >= this.visible) {
      throw new RangeError(`RGA.delete index ${index} out of range [0, ${this.visible})`);
    }
    const op: RgaOp = { type: "delete", target: this.visibleAt(index).id };
    this.applyRemoteOp(op);
    return op;
  }

  applyRemoteOp(op: RgaOp): void {
    const queue: RgaOp[] = [op];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (next.type === "delete") {
        const target = this.byId.get(idKey(next.target));
        if (target === undefined) {
          this.pending.park(idKey(next.target), next);
        } else if (!target.tombstone) {
          target.tombstone = true;
          this.visible--;
        }
        continue;
      }

      const key = idKey(next.id);
      if (this.byId.has(key)) continue; // duplicate delivery
      if (next.originId !== null && !this.byId.has(idKey(next.originId))) {
        this.pending.park(idKey(next.originId), next);
        continue;
      }
      this.integrateInsert(next);
      queue.push(...this.pending.release(key));
    }
  }

  private integrateInsert(op: Extract<RgaOp, { type: "insert" }>): void {
    const elem: RgaElem = { id: op.id, char: op.char, originId: op.originId, tombstone: false };
    let pos = 0;
    if (op.originId !== null) {
      pos = this.elems.indexOf(this.byId.get(idKey(op.originId)) as RgaElem) + 1;
    }
    // Skip concurrent siblings with greater ids, together with their subtrees
    // (every descendant has an even greater Lamport counter).
    while (pos < this.elems.length && compareTimestamps((this.elems[pos] as RgaElem).id, op.id) > 0) {
      pos++;
    }
    this.elems.splice(pos, 0, elem);
    this.byId.set(idKey(op.id), elem);
    this.visible++;
    if (op.id.counter > this.clock) this.clock = op.id.counter;
  }

  private visibleAt(index: number): RgaElem {
    let seen = 0;
    for (const elem of this.elems) {
      if (!elem.tombstone && seen++ === index) return elem;
    }
    throw new RangeError(`RGA: no visible element at index ${index}`);
  }

  toString(): string {
    let out = "";
    for (const elem of this.elems) if (!elem.tombstone) out += elem.char;
    return out;
  }

  toJSON(): RgaJSON {
    return {
      elems: this.elems.map((e) => ({ id: e.id, char: e.char, originId: e.originId, tombstone: e.tombstone })),
    };
  }
}
