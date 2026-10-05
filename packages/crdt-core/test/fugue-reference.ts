import { type FugueDeleteOp, type FugueInsertOp, type FugueOp, type Id, compareIds, idKey } from "../src/index";

interface RefNode {
  id: Id | null; // null only for the root
  value: string | null; // null is the paper's ⊥ (root or tombstone)
  rightOrigin: Id | null;
  leftChildren: RefNode[];
  rightChildren: RefNode[];
}

/**
 * Deliberately naive transcription of the paper's Algorithm 1 with the FugueMax
 * modifications of Section IV-C: a plain tree, a recursive traversal, positions
 * recomputed from scratch. It assumes causal delivery, exactly like the paper.
 * Used as the oracle for differential tests of the optimised implementation.
 *
 * One bookkeeping difference from the pseudocode: deletes also consume a counter,
 * to match the production id scheme. The paper notes id construction is immaterial.
 */
export class ReferenceFugueMax {
  private readonly root: RefNode = { id: null, value: null, rightOrigin: null, leftChildren: [], rightChildren: [] };
  private readonly byKey = new Map<string, RefNode>();
  private counter = 0;

  constructor(readonly replicaId: string) {}

  /** traverse(): every non-root node in list order, tombstones included. */
  private traverse(node: RefNode = this.root, out: RefNode[] = []): RefNode[] {
    for (const child of node.leftChildren) this.traverse(child, out);
    if (node !== this.root) out.push(node);
    for (const child of node.rightChildren) this.traverse(child, out);
    return out;
  }

  values(): string {
    return this.traverse()
      .filter((n) => n.value !== null)
      .map((n) => n.value)
      .join("");
  }

  orderedIds(): string[] {
    return this.traverse().map((n) => idKey(n.id as Id));
  }

  insert(i: number, x: string): FugueInsertOp {
    const id: Id = { replicaId: this.replicaId, counter: this.counter };
    const all = this.traverse();
    const visible = all.filter((n) => n.value !== null);
    const leftOrigin = i === 0 ? this.root : (visible[i - 1] as RefNode);
    const rightOrigin = (leftOrigin === this.root ? all[0] : all[all.indexOf(leftOrigin) + 1]) ?? null;

    let op: FugueInsertOp;
    if (leftOrigin.rightChildren.length === 0) {
      op = { type: "insert", id, char: x, parent: leftOrigin.id, side: "right", rightOrigin: rightOrigin?.id ?? null };
    } else {
      const anchor = (rightOrigin as RefNode).id as Id;
      op = { type: "insert", id, char: x, parent: anchor, side: "left", rightOrigin: anchor };
    }
    this.deliver(op);
    return op;
  }

  delete(i: number): FugueDeleteOp {
    const node = this.traverse().filter((n) => n.value !== null)[i] as RefNode;
    const op: FugueDeleteOp = { type: "delete", id: { replicaId: this.replicaId, counter: this.counter }, target: node.id as Id };
    this.deliver(op);
    return op;
  }

  /** "on delivering ... by causal broadcast". The caller must deliver in causal order. */
  deliver(op: FugueOp): void {
    if (op.id.replicaId === this.replicaId) this.counter = Math.max(this.counter, op.id.counter + 1);
    if (op.type === "delete") {
      (this.byKey.get(idKey(op.target)) as RefNode).value = null;
      return;
    }

    const parent = op.parent === null ? this.root : (this.byKey.get(idKey(op.parent)) as RefNode);
    const node: RefNode = { id: op.id, value: op.char, rightOrigin: op.rightOrigin, leftChildren: [], rightChildren: [] };

    if (op.side === "right") {
      const order = this.orderedIds();
      const position = (id: Id | null): number => (id === null ? Number.POSITIVE_INFINITY : order.indexOf(idKey(id)));
      const sibs = parent.rightChildren;
      // i <- least index such that node.rightOrigin ≻ rightSibs[i].rightOrigin, or
      //      (the right origins are equal and node.id < rightSibs[i].id)
      let i = 0;
      while (i < sibs.length) {
        const sib = sibs[i] as RefNode;
        const mine = position(node.rightOrigin);
        const theirs = position(sib.rightOrigin);
        if (mine > theirs || (mine === theirs && compareIds(op.id, sib.id as Id) < 0)) break;
        i++;
      }
      sibs.splice(i, 0, node);
    } else {
      const sibs = parent.leftChildren;
      // i <- least index such that node.id < leftSibs[i]
      let i = 0;
      while (i < sibs.length && !(compareIds(op.id, (sibs[i] as RefNode).id as Id) < 0)) i++;
      sibs.splice(i, 0, node);
    }
    this.byKey.set(idKey(op.id), node);
  }
}
