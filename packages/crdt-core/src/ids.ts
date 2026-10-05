/** Globally unique operation / element identifier. */
export interface Id {
  readonly replicaId: string;
  readonly counter: number;
}

/** Map key for an Id. Counter first so replica ids containing ":" stay unambiguous. */
export function idKey(id: Id): string {
  return `${id.counter}:${id.replicaId}`;
}

export function idEquals(a: Id | null, b: Id | null): boolean {
  if (a === null || b === null) return a === b;
  return a.counter === b.counter && a.replicaId === b.replicaId;
}

/** Lexicographic order on (replicaId, counter), using code-unit string comparison. */
export function compareIds(a: Id, b: Id): number {
  if (a.replicaId !== b.replicaId) return a.replicaId < b.replicaId ? -1 : 1;
  return a.counter - b.counter;
}

export function isId(x: unknown): x is Id {
  if (typeof x !== "object" || x === null) return false;
  const { replicaId, counter } = x as Record<string, unknown>;
  return typeof replicaId === "string" && Number.isSafeInteger(counter) && (counter as number) >= 0;
}
