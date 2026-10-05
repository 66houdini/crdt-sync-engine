import type { FugueJSON, FugueNodeJSON, Side } from "./fugue";

/**
 * Compact binary encoding of a FugueMax state (the same information as FugueJSON).
 *
 * The saved state is the list of elements in list order, and the encoding leans on
 * how text is actually written:
 *
 *  - Runs. Left-to-right typing produces consecutive elements with the same
 *    author, consecutive counters, each the right child of the one before, all
 *    with the same right origin. Such a run is stored once: author, first
 *    counter, length, and where the head hangs.
 *  - Positional references. Parents and right origins are stored as a distance
 *    in list order from the run, and the common cases (the element just before
 *    the run, the element just after it, the root, the end) take no bytes at all.
 *  - Columns. Text, tombstone flags and delete dots are separate streams, each
 *    run-length encoded. Deleted characters are not stored.
 *
 * Layout: magic "FGM1" | replica table | version vector | runs | text | tombstone
 * flags | delete dots. Integers are LEB128 varints; signed values are zigzagged.
 */

const MAGIC = [0x46, 0x47, 0x4d, 0x31]; // "FGM1"

// Run header bits.
const SIDE_LEFT = 1;
const PARENT_SHIFT = 1; // 2 bits
const ORIGIN_SHIFT = 3; // 2 bits
const SAME_REPLICA = 1 << 5;

const enum ParentMode {
  Explicit = 0,
  Previous = 1, // the element just before the run
  AfterRun = 2, // the element just after the run
  Root = 3,
}

const enum OriginMode {
  Explicit = 0,
  AfterRun = 1,
  End = 2,
  Parent = 3,
}

const enum DotRun {
  Ascending = 0,
  Descending = 1,
  Explicit = 2,
}

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private reserve(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    next.set(this.buf);
    this.buf = next;
  }

  byte(value: number): void {
    this.reserve(1);
    this.buf[this.len++] = value;
  }

  varint(value: number): void {
    this.reserve(10);
    let v = value;
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
  }

  signed(value: number): void {
    this.varint(value < 0 ? -value * 2 - 1 : value * 2);
  }

  bytes(data: Uint8Array): void {
    this.varint(data.length);
    this.reserve(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  get length(): number {
    return this.len;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Byte counts per section of an encoded state, for benchmarks and diagnostics. */
export interface FugueEncodingBreakdown {
  /** Magic, replica table and version vector. */
  header: number;
  /** Tree structure: ids, parents, sides and right origins, as runs. */
  structure: number;
  runs: number;
  /** UTF-8 text of the live characters plus their length runs. */
  text: number;
  tombstoneFlags: number;
  /** Ids of the delete ops, needed only for garbage collection. */
  deleteDots: number;
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("FugueMax.decode: unexpected end of data");
    return this.buf[this.pos++] as number;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 0x80;
    }
  }

  signed(): number {
    const v = this.varint();
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.buf.length) throw new Error("FugueMax.decode: unexpected end of data");
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

/** UTF-8 encoder. Hand-rolled because crdt-core has no access to TextEncoder (no DOM / Node types). */
export function utf8Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out[n++] = cp;
    } else if (cp < 0x800) {
      out[n++] = 0xc0 | (cp >> 6);
      out[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[n++] = 0xe0 | (cp >> 12);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    } else {
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 0x3f);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return out.slice(0, n);
}

export function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk: number[] = [];
  const push = (unit: number): void => {
    chunk.push(unit);
    if (chunk.length >= 8192) {
      parts.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++] as number;
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | ((bytes[i++] as number) & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | (((bytes[i++] as number) & 0x3f) << 6) | ((bytes[i++] as number) & 0x3f);
    else {
      cp =
        ((b & 0x07) << 18) |
        (((bytes[i++] as number) & 0x3f) << 12) |
        (((bytes[i++] as number) & 0x3f) << 6) |
        ((bytes[i++] as number) & 0x3f);
    }
    if (cp < 0x10000) {
      push(cp);
    } else {
      cp -= 0x10000;
      push(0xd800 + (cp >> 10));
      push(0xdc00 + (cp & 0x3ff));
    }
  }
  parts.push(String.fromCharCode(...chunk));
  return parts.join("");
}

const key = (id: readonly [string, number]): string => `${id[1]}:${id[0]}`;
const sameId = (a: readonly [string, number] | null, b: readonly [string, number] | null): boolean =>
  a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1];

export function encodeFugueState(state: FugueJSON, breakdown?: FugueEncodingBreakdown): Uint8Array {
  const { nodes } = state;
  const w = new Writer();
  for (const b of MAGIC) w.byte(b);

  // Replica table.
  const replicas = new Set<string>();
  for (const [replica] of state.vv) replicas.add(replica);
  for (const node of nodes) {
    replicas.add(node.id[0]);
    for (const dot of node.deletedBy ?? []) replicas.add(dot[0]);
  }
  const table = [...replicas].sort();
  const replicaIndex = new Map(table.map((replica, i) => [replica, i]));
  w.varint(table.length);
  for (const replica of table) w.bytes(utf8Encode(replica));

  const counts = new Map(state.vv);
  for (const replica of table) w.varint(counts.get(replica) ?? 0);

  const headerEnd = w.length;

  // Runs.
  const indexOf = new Map<string, number>();
  nodes.forEach((node, i) => indexOf.set(key(node.id), i));
  const refIndex = (id: [string, number] | null): number => {
    if (id === null) return -1;
    const i = indexOf.get(key(id));
    if (i === undefined) throw new Error("FugueMax.encode: dangling reference");
    return i;
  };

  const runStarts: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as FugueNodeJSON;
    const prev = nodes[i - 1];
    const head = nodes[runStarts[runStarts.length - 1] ?? 0] as FugueNodeJSON;
    const continues =
      prev !== undefined &&
      node.side === "right" &&
      node.id[0] === prev.id[0] &&
      node.id[1] === prev.id[1] + 1 &&
      sameId(node.parent, prev.id) &&
      sameId(node.rightOrigin, head.rightOrigin);
    if (!continues) runStarts.push(i);
  }

  w.varint(nodes.length);
  w.varint(runStarts.length);
  let previousReplica = -1;
  let previousCounter = 0;
  runStarts.forEach((start, r) => {
    const end = runStarts[r + 1] ?? nodes.length;
    const head = nodes[start] as FugueNodeJSON;
    const parent = refIndex(head.parent);
    const origin = refIndex(head.rightOrigin);
    const after = end < nodes.length ? end : -2; // -2: no such element

    const parentMode =
      parent === -1 ? ParentMode.Root : parent === start - 1 ? ParentMode.Previous : parent === after ? ParentMode.AfterRun : ParentMode.Explicit;
    const originMode =
      origin === -1 ? OriginMode.End : origin === parent ? OriginMode.Parent : origin === after ? OriginMode.AfterRun : OriginMode.Explicit;
    const replica = replicaIndex.get(head.id[0]) as number;

    w.byte(
      (head.side === "left" ? SIDE_LEFT : 0) |
        (parentMode << PARENT_SHIFT) |
        (originMode << ORIGIN_SHIFT) |
        (replica === previousReplica ? SAME_REPLICA : 0),
    );
    if (replica !== previousReplica) w.varint(replica);
    w.signed(head.id[1] - previousCounter);
    w.varint(end - start - 1);
    if (parentMode === ParentMode.Explicit) w.signed(parent - start);
    if (originMode === OriginMode.Explicit) w.signed(origin - start);
    previousReplica = replica;
    previousCounter = head.id[1];
  });

  const structureEnd = w.length;

  // Text of the live elements: per-element UTF-16 lengths (run-length encoded), then the characters.
  const live = nodes.filter((node) => node.deletedBy === undefined);
  const lengthRuns: [count: number, length: number][] = [];
  for (const node of live) {
    const last = lengthRuns[lengthRuns.length - 1];
    if (last !== undefined && last[1] === node.char.length) last[0]++;
    else lengthRuns.push([1, node.char.length]);
  }
  w.varint(lengthRuns.length);
  for (const [count, length] of lengthRuns) {
    w.varint(count);
    w.varint(length);
  }
  w.bytes(utf8Encode(live.map((node) => node.char).join("")));

  const textEnd = w.length;

  // Tombstone flags: alternating run lengths, starting with live.
  const flagRuns: number[] = [0];
  let deleted = false;
  for (const node of nodes) {
    if ((node.deletedBy !== undefined) !== deleted) {
      deleted = !deleted;
      flagRuns.push(0);
    }
    flagRuns[flagRuns.length - 1] = (flagRuns[flagRuns.length - 1] as number) + 1;
  }
  w.varint(flagRuns.length);
  for (const length of flagRuns) w.varint(length);

  const flagsEnd = w.length;

  // Delete dots, in list order of the tombstones. Holding backspace or delete
  // yields consecutive dots on neighbouring elements, stored as one run.
  const tombstones = nodes.filter((node) => node.deletedBy !== undefined);
  for (let i = 0; i < tombstones.length; ) {
    const dots = (tombstones[i] as FugueNodeJSON).deletedBy as [string, number][];
    if (dots.length !== 1) {
      w.varint((dots.length << 2) | DotRun.Explicit);
      for (const dot of dots) {
        w.varint(replicaIndex.get(dot[0]) as number);
        w.varint(dot[1]);
      }
      i++;
      continue;
    }
    const first = dots[0] as [string, number];
    let length = 1;
    let step = 0;
    for (;;) {
      const next = tombstones[i + length]?.deletedBy;
      if (next === undefined || next.length !== 1) break;
      const dot = next[0] as [string, number];
      const delta = dot[1] - (first[1] + step * (length - 1));
      if (dot[0] !== first[0] || (delta !== 1 && delta !== -1)) break;
      if (step === 0) step = delta;
      else if (delta !== step) break;
      length++;
    }
    w.varint((length << 2) | (step === -1 ? DotRun.Descending : DotRun.Ascending));
    w.varint(replicaIndex.get(first[0]) as number);
    w.varint(first[1]);
    i += length;
  }

  if (breakdown !== undefined) {
    breakdown.header = headerEnd;
    breakdown.structure = structureEnd - headerEnd;
    breakdown.runs = runStarts.length;
    breakdown.text = textEnd - structureEnd;
    breakdown.tombstoneFlags = flagsEnd - textEnd;
    breakdown.deleteDots = w.length - flagsEnd;
  }
  return w.finish();
}

export function decodeFugueState(bytes: Uint8Array): FugueJSON {
  const r = new Reader(bytes);
  for (const b of MAGIC) {
    if (r.byte() !== b) throw new Error("FugueMax.decode: not a FugueMax state (bad magic)");
  }

  const table: string[] = [];
  const replicaCount = r.varint();
  for (let i = 0; i < replicaCount; i++) table.push(utf8Decode(r.bytes()));
  const replicaAt = (i: number): string => {
    const replica = table[i];
    if (replica === undefined) throw new Error("FugueMax.decode: replica index out of range");
    return replica;
  };

  const vv: [string, number][] = [];
  for (const replica of table) {
    const count = r.varint();
    if (count > 0) vv.push([replica, count]);
  }

  const nodeCount = r.varint();
  const runCount = r.varint();
  const ids: [string, number][] = [];
  const sides: Side[] = [];
  const parents: number[] = []; // list index, -1 for the root
  const origins: number[] = []; // list index, -1 for the end
  let previousReplica = -1;
  let previousCounter = 0;
  for (let run = 0; run < runCount; run++) {
    const header = r.byte();
    const replica = (header & SAME_REPLICA) !== 0 ? previousReplica : r.varint();
    const counter = previousCounter + r.signed();
    const length = r.varint() + 1;
    const start = ids.length;
    const after = start + length < nodeCount ? start + length : -1;

    const parentMode = ((header >> PARENT_SHIFT) & 3) as ParentMode;
    const originMode = ((header >> ORIGIN_SHIFT) & 3) as OriginMode;
    const parent =
      parentMode === ParentMode.Root ? -1 : parentMode === ParentMode.Previous ? start - 1 : parentMode === ParentMode.AfterRun ? after : start + r.signed();
    const origin =
      originMode === OriginMode.End ? -1 : originMode === OriginMode.Parent ? parent : originMode === OriginMode.AfterRun ? after : start + r.signed();

    const name = replicaAt(replica);
    for (let k = 0; k < length; k++) {
      ids.push([name, counter + k]);
      sides.push(k === 0 && (header & SIDE_LEFT) !== 0 ? "left" : "right");
      parents.push(k === 0 ? parent : start + k - 1);
      origins.push(origin);
    }
    previousReplica = replica;
    previousCounter = counter;
  }
  if (ids.length !== nodeCount) throw new Error("FugueMax.decode: run lengths do not add up");

  const lengths: number[] = [];
  const lengthRunCount = r.varint();
  for (let i = 0; i < lengthRunCount; i++) {
    const count = r.varint();
    const length = r.varint();
    for (let k = 0; k < count; k++) lengths.push(length);
  }
  const text = utf8Decode(r.bytes());

  const isDeleted: boolean[] = [];
  const flagRunCount = r.varint();
  for (let i = 0, deleted = false; i < flagRunCount; i++, deleted = !deleted) {
    const length = r.varint();
    for (let k = 0; k < length; k++) isDeleted.push(deleted);
  }
  if (isDeleted.length !== nodeCount) throw new Error("FugueMax.decode: tombstone flags do not add up");

  const tombstoneCount = isDeleted.filter(Boolean).length;
  const dots: [string, number][][] = [];
  while (dots.length < tombstoneCount) {
    const tag = r.varint();
    const kind = (tag & 3) as DotRun;
    const length = tag >> 2;
    if (kind === DotRun.Explicit) {
      const list: [string, number][] = [];
      for (let k = 0; k < length; k++) list.push([replicaAt(r.varint()), r.varint()]);
      dots.push(list);
    } else {
      const replica = replicaAt(r.varint());
      const first = r.varint();
      const step = kind === DotRun.Descending ? -1 : 1;
      for (let k = 0; k < length; k++) dots.push([[replica, first + step * k]]);
    }
  }

  const ref = (index: number): [string, number] | null => {
    if (index === -1) return null;
    const id = ids[index];
    if (id === undefined) throw new Error("FugueMax.decode: reference out of range");
    return id;
  };
  const nodes: FugueNodeJSON[] = [];
  let liveSeen = 0;
  let textPos = 0;
  let deadSeen = 0;
  for (let i = 0; i < nodeCount; i++) {
    const node: FugueNodeJSON = {
      id: ids[i] as [string, number],
      char: "",
      parent: ref(parents[i] as number),
      side: sides[i] as Side,
      rightOrigin: ref(origins[i] as number),
    };
    if (isDeleted[i] === true) {
      node.deletedBy = dots[deadSeen++] as [string, number][];
    } else {
      const length = lengths[liveSeen++] as number;
      node.char = text.slice(textPos, textPos + length);
      textPos += length;
    }
    nodes.push(node);
  }
  return { version: 1, vv, nodes };
}
