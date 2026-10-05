import { type Id, compareIds, idKey, isId } from "./ids";
import { PendingBuffer } from "./pending";
import type { SequenceCrdt } from "./sequence";

export type Side = "left" | "right";

export interface FugueInsertOp {
  readonly type: "insert";
  /** The op's dot, which is also the new element's id. */
  readonly id: Id;
  readonly char: string;
  /** `null` is the tree root. */
  readonly parent: Id | null;
  readonly side: Side;
  /**
   * The element directly after the insertion position at insert time (tombstones
   * included); `null` means the end of the list. For a left child this is its parent.
   */
  readonly rightOrigin: Id | null;
}

export interface FugueDeleteOp {
  readonly type: "delete";
  /** The op's own dot (deletes consume a counter too, so version vectors cover them). */
  readonly id: Id;
  readonly target: Id;
}

export type FugueOp = FugueInsertOp | FugueDeleteOp;

type IdTuple = [replicaId: string, counter: number];

export interface FugueNodeJSON {
  id: IdTuple;
  char: string;
  parent: IdTuple | null;
  side: Side;
  rightOrigin: IdTuple | null;
  /** Dots of the delete ops applied to this element, sorted; present iff the element is a tombstone. */
  deletedBy?: IdTuple[];
}

/** Canonical full state: elements in list order (tombstones included) plus the version vector. */
export interface FugueJSON {
  version: 1;
  vv: [replicaId: string, count: number][];
  nodes: FugueNodeJSON[];
}

const CHUNK_MAX = 512;

/** A run of consecutive elements of the list order. Chunks form a doubly linked list. */
class Chunk {
  nodes: FNode[] = [];
  visible = 0;
  prev: Chunk | null = null;
  next: Chunk | null = null;
}

class FNode {
  leftChildren: FNode[] | null = null;
  rightChildren: FNode[] | null = null;
  deleted = false;
  deletedBy: Id[] | null = null;
  chunk!: Chunk;

  constructor(
    readonly id: Id,
    readonly char: string,
    /** `null` is the root. */
    public parent: FNode | null,
    readonly side: Side,
    /** `null` is the end of the list. */
    public rightOrigin: FNode | null,
  ) {}
}

const toTuple = (id: Id): IdTuple => [id.replicaId, id.counter];
const fromTuple = (t: IdTuple): Id => ({ replicaId: t[0], counter: t[1] });

/**
 * FugueMax list CRDT, after Weidner, Gentle & Kleppmann, "The Art of the Fugue:
 * Minimizing Interleaving in Collaborative Text Editing" (arXiv:2305.00583),
 * Algorithm 1 with the Section IV-C modifications.
 *
 * State is a tree. Every element is a left or right child of its parent, and the
 * list order is the in-order walk: left children, the node, right children.
 *
 *  - insert(i, x): let leftOrigin be the visible element at i-1 (or the root) and
 *    rightOrigin the next element after it, tombstones included. If leftOrigin has
 *    no right children the new node becomes a right child of leftOrigin, otherwise
 *    a left child of rightOrigin.
 *  - Left-side siblings are ordered by ascending id.
 *  - Right-side siblings are ordered by the REVERSE list order of their right
 *    origins (the sibling whose right origin is further right comes first, with
 *    "end of list" furthest right), ties broken by ascending id. This is the
 *    FugueMax rule; plain Fugue orders right-side siblings by id alone.
 *
 * Ids order lexicographically by (replicaId, counter). The "Max" stands for
 * "maximally non-interleaving", not for a maximum-id tie-break: among same-origin
 * siblings the paper puts the LOWER id first (Definition 4, condition 3).
 *
 * Implementation notes. The list order is also materialised as a linked list of
 * chunks so index lookups and neighbour queries do not walk the tree, which is a
 * linear chain for ordinary left-to-right typing. Nothing here recurses.
 *
 * Delivery. The paper assumes causal broadcast. This class provides it itself:
 * every op carries a dot (replicaId, counter) with counters contiguous per
 * replica, and an op is applied only after its predecessor from the same replica
 * and every element it references. Earlier arrivals are buffered, duplicates are
 * dropped, so `applyRemoteOp` is safe under arbitrary reordering and duplication.
 */
export class FugueMax implements SequenceCrdt<FugueOp> {
  private head = new Chunk();
  private readonly rootRight: FNode[] = [];
  /** Elements by replica, indexed by counter (sparse: delete dots have no element). */
  private readonly nodes = new Map<string, (FNode | undefined)[]>();
  /** Number of ops applied from each replica; the next expected counter. */
  private readonly vv = new Map<string, number>();
  private readonly pending = new PendingBuffer<FugueOp>();
  private visible = 0;
  private total = 0;

  constructor(readonly replicaId: string) {}

  get length(): number {
    return this.visible;
  }

  /** Elements held, tombstones included. */
  get nodeCount(): number {
    return this.total;
  }

  get tombstoneCount(): number {
    return this.total - this.visible;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Ops applied per replica. Counters `0 .. n-1` from a replica are applied iff its entry is `n`. */
  versionVector(): Map<string, number> {
    return new Map(this.vv);
  }

  /** Number of ops applied from `replicaId`. */
  appliedCount(replicaId: string): number {
    return this.vv.get(replicaId) ?? 0;
  }

  /** True iff the op with this dot has already been applied (a re-delivery would be a no-op). */
  hasApplied(id: Id): boolean {
    return (this.vv.get(id.replicaId) ?? 0) > id.counter;
  }

  /**
   * True iff `applyRemoteOp(op)` would apply the op right now rather than drop it
   * as a duplicate or buffer it. Throws on a malformed op.
   */
  isDeliverable(op: FugueOp): boolean {
    if (op.id.counter !== (this.vv.get(op.id.replicaId) ?? 0)) return false;
    return this.missingDependency(op) === null;
  }

  // ---------------------------------------------------------------- local edits

  insert(index: number, char: string): FugueInsertOp {
    if (!Number.isInteger(index) || index < 0 || index > this.visible) {
      throw new RangeError(`FugueMax.insert index ${index} out of range [0, ${this.visible}]`);
    }
    if (typeof char !== "string" || char.length === 0) {
      throw new TypeError("FugueMax.insert requires a non-empty string");
    }
    const leftOrigin = index === 0 ? null : this.visibleAt(index - 1);
    const rightOrigin = leftOrigin === null ? this.first() : this.nextInOrder(leftOrigin);
    const rightSiblings = leftOrigin === null ? this.rootRight : leftOrigin.rightChildren;
    const id = this.nextDot();

    let op: FugueInsertOp;
    if (rightSiblings === null || rightSiblings.length === 0) {
      op = {
        type: "insert",
        id,
        char,
        parent: leftOrigin === null ? null : leftOrigin.id,
        side: "right",
        rightOrigin: rightOrigin === null ? null : rightOrigin.id,
      };
    } else {
      // leftOrigin has right children, so rightOrigin is one of its descendants and has
      // no left children of its own: a left child of rightOrigin lands exactly in between.
      const anchor = rightOrigin as FNode;
      op = { type: "insert", id, char, parent: anchor.id, side: "left", rightOrigin: anchor.id };
    }
    this.integrate(op);
    return op;
  }

  /** Inserts a string left to right; returns one op per character. */
  insertText(index: number, text: string): FugueInsertOp[] {
    return [...text].map((ch, i) => this.insert(index + i, ch));
  }

  delete(index: number): FugueDeleteOp {
    if (!Number.isInteger(index) || index < 0 || index >= this.visible) {
      throw new RangeError(`FugueMax.delete index ${index} out of range [0, ${this.visible})`);
    }
    const op: FugueDeleteOp = { type: "delete", id: this.nextDot(), target: this.visibleAt(index).id };
    this.integrate(op);
    return op;
  }

  private nextDot(): Id {
    return { replicaId: this.replicaId, counter: this.vv.get(this.replicaId) ?? 0 };
  }

  // ---------------------------------------------------------------- remote ops

  /**
   * Applies an op from another replica. A malformed op is rejected with an error,
   * but only after every other op that became deliverable has been processed, so a
   * bad op can never strand well-formed ones.
   */
  applyRemoteOp(op: FugueOp): void {
    const queue: FugueOp[] = [op];
    let failure: unknown;
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      const applied = this.vv.get(next.id.replicaId) ?? 0;
      if (next.id.counter < applied) continue; // duplicate delivery
      if (next.id.counter > applied) {
        this.pending.park(idKey({ replicaId: next.id.replicaId, counter: next.id.counter - 1 }), next);
        continue;
      }
      let missing: Id | null;
      try {
        missing = this.missingDependency(next);
      } catch (err) {
        failure ??= err;
        continue;
      }
      if (missing !== null) {
        this.pending.park(idKey(missing), next);
        continue;
      }
      this.integrate(next);
      queue.push(...this.pending.release(idKey(next.id)));
    }
    if (failure !== undefined) throw failure;
  }

  private missingDependency(op: FugueOp): Id | null {
    if (op.type === "delete") return this.requireOrMissing(op.target);
    if (op.parent === null && op.side === "left") {
      throw new Error("FugueMax: malformed op (the root has no left children)");
    }
    if (op.parent !== null) {
      const missing = this.requireOrMissing(op.parent);
      if (missing !== null) return missing;
    }
    return op.rightOrigin === null ? null : this.requireOrMissing(op.rightOrigin);
  }

  /** Returns `id` if the element has not been created yet, `null` if it is present. */
  private requireOrMissing(id: Id): Id | null {
    if (this.lookup(id) !== undefined) return null;
    if ((this.vv.get(id.replicaId) ?? 0) > id.counter) {
      throw new Error(`FugueMax: op references ${idKey(id)}, which is not a live element (removed or never an insert)`);
    }
    return id;
  }

  private lookup(id: Id): FNode | undefined {
    return this.nodes.get(id.replicaId)?.[id.counter];
  }

  /** Applies an op whose dependencies are all present and advances the version vector. */
  private integrate(op: FugueOp): void {
    if (op.type === "insert") this.integrateInsert(op);
    else this.integrateDelete(op);
    this.vv.set(op.id.replicaId, op.id.counter + 1);
  }

  private integrateInsert(op: FugueInsertOp): void {
    const parent = op.parent === null ? null : (this.lookup(op.parent) as FNode);
    const rightOrigin = op.rightOrigin === null ? null : (this.lookup(op.rightOrigin) as FNode);
    const node = new FNode(op.id, op.char, parent, op.side, rightOrigin);

    if (op.side === "right") {
      const siblings = parent === null ? this.rootRight : (parent.rightChildren ??= []);
      let i = 0;
      while (i < siblings.length && !this.rightSiblingPrecedes(node, siblings[i] as FNode)) i++;
      siblings.splice(i, 0, node);
      // First right child: directly after the parent. Otherwise directly after the
      // whole subtree of the sibling before it.
      const after = i === 0 ? parent : lastInSubtree(siblings[i - 1] as FNode);
      this.placeAfter(after, node);
    } else {
      const owner = parent as FNode;
      const siblings = (owner.leftChildren ??= []);
      let i = 0;
      while (i < siblings.length && compareIds(node.id, (siblings[i] as FNode).id) > 0) i++;
      siblings.splice(i, 0, node);
      // Directly before the subtree of the next left sibling, or before the parent
      // itself when this is the last left child.
      const nextSibling = siblings[i + 1];
      this.placeBefore(nextSibling === undefined ? owner : firstInSubtree(nextSibling), node);
    }

    let byCounter = this.nodes.get(op.id.replicaId);
    if (byCounter === undefined) this.nodes.set(op.id.replicaId, (byCounter = []));
    byCounter[op.id.counter] = node;
    this.visible++;
    this.total++;
  }

  /**
   * FugueMax order for right-side siblings (Section IV-C): `node` goes before
   * `sibling` iff node.rightOrigin is later in the list than sibling.rightOrigin,
   * or the right origins are equal and node has the lower id.
   */
  private rightSiblingPrecedes(node: FNode, sibling: FNode): boolean {
    if (node.rightOrigin === sibling.rightOrigin) return compareIds(node.id, sibling.id) < 0;
    return this.isLater(node.rightOrigin, sibling.rightOrigin);
  }

  /** True iff `a` comes after `b` in the list order; `null` is the end of the list. Requires a !== b. */
  private isLater(a: FNode | null, b: FNode | null): boolean {
    if (a === null) return true;
    if (b === null) return false;
    if (a.chunk === b.chunk) return a.chunk.nodes.indexOf(a) > a.chunk.nodes.indexOf(b);
    for (let c = b.chunk.next; c !== null; c = c.next) if (c === a.chunk) return true;
    return false;
  }

  private integrateDelete(op: FugueDeleteOp): void {
    const target = this.lookup(op.target) as FNode;
    if (!target.deleted) {
      target.deleted = true;
      target.chunk.visible--;
      this.visible--;
    }
    (target.deletedBy ??= []).push(op.id);
  }

  // ---------------------------------------------------------------- list order

  private first(): FNode | null {
    for (let c: Chunk | null = this.head; c !== null; c = c.next) {
      if (c.nodes.length > 0) return c.nodes[0] as FNode;
    }
    return null;
  }

  private nextInOrder(node: FNode): FNode | null {
    const chunk = node.chunk;
    const i = chunk.nodes.indexOf(node);
    if (i + 1 < chunk.nodes.length) return chunk.nodes[i + 1] as FNode;
    for (let c = chunk.next; c !== null; c = c.next) {
      if (c.nodes.length > 0) return c.nodes[0] as FNode;
    }
    return null;
  }

  private visibleAt(index: number): FNode {
    let remaining = index;
    let chunk: Chunk | null = this.head;
    while (chunk !== null && remaining >= chunk.visible) {
      remaining -= chunk.visible;
      chunk = chunk.next;
    }
    if (chunk !== null) {
      for (const node of chunk.nodes) {
        if (!node.deleted && remaining-- === 0) return node;
      }
    }
    throw new RangeError(`FugueMax: no visible element at index ${index}`);
  }

  /** Places `node` directly after `ref` in the list order; `null` means at the very front. */
  private placeAfter(ref: FNode | null, node: FNode): void {
    if (ref === null) this.placeAt(this.head, 0, node);
    else this.placeAt(ref.chunk, ref.chunk.nodes.indexOf(ref) + 1, node);
  }

  private placeBefore(ref: FNode, node: FNode): void {
    this.placeAt(ref.chunk, ref.chunk.nodes.indexOf(ref), node);
  }

  private placeAt(chunk: Chunk, at: number, node: FNode): void {
    chunk.nodes.splice(at, 0, node);
    node.chunk = chunk;
    if (!node.deleted) chunk.visible++;
    if (chunk.nodes.length > CHUNK_MAX) this.split(chunk);
  }

  private split(chunk: Chunk): void {
    const tail = new Chunk();
    tail.nodes = chunk.nodes.splice(chunk.nodes.length >> 1);
    for (const node of tail.nodes) {
      node.chunk = tail;
      if (!node.deleted) tail.visible++;
    }
    chunk.visible -= tail.visible;
    tail.prev = chunk;
    tail.next = chunk.next;
    if (chunk.next !== null) chunk.next.prev = tail;
    chunk.next = tail;
  }

  private *inOrder(): IterableIterator<FNode> {
    for (let c: Chunk | null = this.head; c !== null; c = c.next) yield* c.nodes;
  }

  // ---------------------------------------------------------------- output

  toString(): string {
    const parts: string[] = [];
    for (const node of this.inOrder()) if (!node.deleted) parts.push(node.char);
    return parts.join("");
  }

  /** Ids of the visible characters in order (stable handles for cursors and tests). */
  visibleIds(): Id[] {
    const out: Id[] = [];
    for (const node of this.inOrder()) if (!node.deleted) out.push(node.id);
    return out;
  }

  toJSON(): FugueJSON {
    const nodes: FugueNodeJSON[] = [];
    for (const node of this.inOrder()) {
      const json: FugueNodeJSON = {
        id: toTuple(node.id),
        char: node.char,
        parent: node.parent === null ? null : toTuple(node.parent.id),
        side: node.side,
        rightOrigin: node.rightOrigin === null ? null : toTuple(node.rightOrigin.id),
      };
      if (node.deletedBy !== null) json.deletedBy = node.deletedBy.slice().sort(compareIds).map(toTuple);
      nodes.push(json);
    }
    const vv = [...this.vv].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { version: 1, vv, nodes };
  }

  /**
   * Rebuilds a replica from a full state. `replicaId` is the identity the new
   * replica will write as; its counter resumes from the state's version vector.
   */
  static fromJSON(json: FugueJSON, replicaId: string): FugueMax {
    if (json.version !== 1) throw new Error(`FugueMax.fromJSON: unsupported version ${String(json.version)}`);
    const doc = new FugueMax(replicaId);
    for (const [replica, count] of json.vv) doc.vv.set(replica, count);

    // Pass 1: create the elements in list order (a left child precedes its parent,
    // so links are resolved in a second pass).
    const created: FNode[] = [];
    let chunk = doc.head;
    for (const entry of json.nodes) {
      const node = new FNode(fromTuple(entry.id), entry.char, null, entry.side, null);
      if (entry.deletedBy !== undefined) {
        node.deleted = true;
        node.deletedBy = entry.deletedBy.map(fromTuple);
      }
      if (chunk.nodes.length >= CHUNK_MAX * 0.75) {
        const next = new Chunk();
        next.prev = chunk;
        chunk.next = next;
        chunk = next;
      }
      chunk.nodes.push(node);
      node.chunk = chunk;
      if (!node.deleted) {
        chunk.visible++;
        doc.visible++;
      }
      let byCounter = doc.nodes.get(node.id.replicaId);
      if (byCounter === undefined) doc.nodes.set(node.id.replicaId, (byCounter = []));
      byCounter[node.id.counter] = node;
      created.push(node);
    }
    doc.total = created.length;

    // Pass 2: resolve parent / right-origin links. Appending children in list order
    // reproduces the sibling order exactly, because the list order is the tree walk.
    const resolve = (t: IdTuple | null): FNode | null => {
      if (t === null) return null;
      const node = doc.lookup(fromTuple(t));
      if (node === undefined) throw new Error(`FugueMax.fromJSON: dangling reference ${t[1]}:${t[0]}`);
      return node;
    };
    json.nodes.forEach((entry, i) => {
      const node = created[i] as FNode;
      const parent = resolve(entry.parent);
      node.parent = parent;
      node.rightOrigin = resolve(entry.rightOrigin);
      if (entry.side === "right") (parent === null ? doc.rootRight : (parent.rightChildren ??= [])).push(node);
      else if (parent === null) throw new Error("FugueMax.fromJSON: the root has no left children");
      else (parent.leftChildren ??= []).push(node);
    });
    return doc;
  }
}

function lastInSubtree(node: FNode): FNode {
  let n = node;
  while (n.rightChildren !== null && n.rightChildren.length > 0) {
    n = n.rightChildren[n.rightChildren.length - 1] as FNode;
  }
  return n;
}

function firstInSubtree(node: FNode): FNode {
  let n = node;
  while (n.leftChildren !== null && n.leftChildren.length > 0) n = n.leftChildren[0] as FNode;
  return n;
}

/** Validates the shape of an untrusted op (e.g. one received over the network). */
export function parseFugueOp(x: unknown): FugueOp | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!isId(o.id)) return null;
  const id: Id = { replicaId: o.id.replicaId, counter: o.id.counter };
  if (o.type === "delete") {
    if (!isId(o.target)) return null;
    return { type: "delete", id, target: { replicaId: o.target.replicaId, counter: o.target.counter } };
  }
  if (o.type !== "insert") return null;
  if (typeof o.char !== "string" || o.char.length === 0) return null;
  if (o.side !== "left" && o.side !== "right") return null;
  if (o.parent !== null && !isId(o.parent)) return null;
  if (o.rightOrigin !== null && !isId(o.rightOrigin)) return null;
  const parent = o.parent === null ? null : { replicaId: o.parent.replicaId, counter: o.parent.counter };
  const rightOrigin =
    o.rightOrigin === null ? null : { replicaId: o.rightOrigin.replicaId, counter: o.rightOrigin.counter };
  if (o.side === "left") {
    // A left child's right origin is its parent by definition.
    if (parent === null || rightOrigin === null) return null;
    if (parent.replicaId !== rightOrigin.replicaId || parent.counter !== rightOrigin.counter) return null;
  }
  return { type: "insert", id, char: o.char, parent, side: o.side, rightOrigin };
}
