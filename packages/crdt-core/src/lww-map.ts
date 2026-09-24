import { LWWRegister, assertValidStamp, type Stamp } from "./lww-register";

export type LWWMapKey = string | number;

/**
 * Per-key register payload. A delete is a write of a tombstone, carrying its own
 * stamp, so it competes with concurrent sets by the same LWW rule. Tombstones are
 * kept forever: dropping one would let an older concurrent set that arrives later
 * resurrect the key.
 */
type Slot<V> = { readonly deleted: false; readonly value: V } | { readonly deleted: true };

export type LWWMapEntryJSON<K extends LWWMapKey, V> =
  | (Stamp & { readonly key: K; readonly deleted: false; readonly value: V })
  | (Stamp & { readonly key: K; readonly deleted: true });

/** Entries sorted by key, tombstones included, so equal maps serialize to identical bytes. */
export type LWWMapJSON<K extends LWWMapKey, V> = LWWMapEntryJSON<K, V>[];

/** Canonical key order: numbers before strings, then natural order within each type. */
function compareKeys(a: LWWMapKey, b: LWWMapKey): number {
  if (typeof a !== typeof b) return typeof a === "number" ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertValidKey(key: LWWMapKey): void {
  if (typeof key === "number" ? !Number.isFinite(key) : typeof key !== "string") {
    throw new TypeError(`LWWMap key must be a string or finite number, got ${String(key)}`);
  }
}

/** Last-write-wins map: one LWW register per key, with tombstoned deletes. Immutable. */
export class LWWMap<K extends LWWMapKey, V> {
  private constructor(private readonly registers: ReadonlyMap<K, LWWRegister<Slot<V>>>) {}

  static empty<K extends LWWMapKey, V>(): LWWMap<K, V> {
    return new LWWMap<K, V>(new Map());
  }

  set(key: K, value: V, timestamp: number, replicaId: string): LWWMap<K, V> {
    return this.write(key, { deleted: false, value }, timestamp, replicaId);
  }

  /** Records a tombstone even if the key is absent locally: a concurrent older set may still arrive. */
  delete(key: K, timestamp: number, replicaId: string): LWWMap<K, V> {
    return this.write(key, { deleted: true }, timestamp, replicaId);
  }

  private write(key: K, slot: Slot<V>, timestamp: number, replicaId: string): LWWMap<K, V> {
    assertValidKey(key);
    assertValidStamp(timestamp, replicaId);
    const current = this.registers.get(key) ?? LWWRegister.empty<Slot<V>>();
    const next = current.set(slot, timestamp, replicaId);
    if (next === current) return this;
    const registers = new Map(this.registers);
    registers.set(key, next);
    return new LWWMap(registers);
  }

  merge(other: LWWMap<K, V>): LWWMap<K, V> {
    const registers = new Map(this.registers);
    for (const [key, theirs] of other.registers) {
      const ours = registers.get(key);
      registers.set(key, ours === undefined ? theirs : ours.merge(theirs));
    }
    return new LWWMap(registers);
  }

  get(key: K): V | undefined {
    const slot = this.registers.get(key)?.value();
    return slot === undefined || slot.deleted ? undefined : slot.value;
  }

  has(key: K): boolean {
    const slot = this.registers.get(key)?.value();
    return slot !== undefined && !slot.deleted;
  }

  /** Live (non-deleted) entries in canonical key order. */
  entries(): [K, V][] {
    const out: [K, V][] = [];
    for (const [key, reg] of this.registers) {
      const slot = reg.value();
      if (slot !== undefined && !slot.deleted) out.push([key, slot.value]);
    }
    return out.sort((a, b) => compareKeys(a[0], b[0]));
  }

  keys(): K[] {
    return this.entries().map(([key]) => key);
  }

  get size(): number {
    return this.entries().length;
  }

  toJSON(): LWWMapJSON<K, V> {
    const out: LWWMapJSON<K, V> = [];
    for (const [key, reg] of this.registers) {
      const state = reg.toJSON();
      if (state === null) continue;
      const { timestamp, replicaId } = state;
      out.push(
        state.value.deleted
          ? { key, timestamp, replicaId, deleted: true }
          : { key, timestamp, replicaId, deleted: false, value: state.value.value },
      );
    }
    return out.sort((a, b) => compareKeys(a.key, b.key));
  }

  /** Duplicate keys in the input are merged by the LWW rule rather than rejected. */
  static fromJSON<K extends LWWMapKey, V>(json: LWWMapJSON<K, V>): LWWMap<K, V> {
    let map = LWWMap.empty<K, V>();
    for (const entry of json) {
      map = entry.deleted
        ? map.delete(entry.key, entry.timestamp, entry.replicaId)
        : map.set(entry.key, entry.value, entry.timestamp, entry.replicaId);
    }
    return map;
  }
}
