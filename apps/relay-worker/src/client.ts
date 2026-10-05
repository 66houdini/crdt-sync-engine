import { FugueMax, type FugueJSON, type FugueOp } from "@crdt/core";
import type { ClientMessage, ServerMessage } from "./protocol";

const OPS_PER_MESSAGE = 500;

export interface ReceiveResult {
  /** Messages the caller should now send on the same connection. */
  send: ClientMessage[];
  /** The relay asked for a resync: close this connection and open a new one. */
  reconnect: boolean;
  /** The local document changed. */
  changed: boolean;
  error?: string;
}

/**
 * Client half of the relay protocol, independent of any transport: it owns the
 * local FugueMax replica, remembers which of its own ops the relay has not yet
 * made durable, and turns incoming server messages into document updates.
 *
 * The caller owns the socket. Typical loop:
 *   connect to `/doc/<id>/ws?` + session.connectQuery()
 *   on message  -> r = session.receive(msg); send r.send; if (r.reconnect) reconnect
 *   on edit     -> send session.insert(...) / session.delete(...) if connected
 * Edits made while disconnected are kept and resent after the next `synced`.
 */
export class ClientSession {
  doc: FugueMax;
  private unacked: FugueOp[] = [];
  private since: number | null = null;
  private epoch: number | null = null;
  private snapshotParts: string[] = [];

  constructor(readonly replicaId: string) {
    this.doc = new FugueMax(replicaId);
  }

  get text(): string {
    return this.doc.toString();
  }

  /** Own ops the relay has not confirmed as durable. */
  get unackedCount(): number {
    return this.unacked.length;
  }

  /** Query string for the next connection attempt. */
  connectQuery(): string {
    this.snapshotParts = [];
    const params = [`replica=${encodeURIComponent(this.replicaId)}`];
    if (this.since !== null && this.epoch !== null) params.push(`since=${this.since}`, `epoch=${this.epoch}`);
    return params.join("&");
  }

  insert(index: number, text: string): ClientMessage[] {
    return this.record(this.doc.insertText(index, text));
  }

  delete(index: number, count = 1): ClientMessage[] {
    const ops: FugueOp[] = [];
    for (let i = 0; i < count; i++) ops.push(this.doc.delete(index));
    return this.record(ops);
  }

  private record(ops: FugueOp[]): ClientMessage[] {
    this.unacked.push(...ops);
    return chunk(ops);
  }

  receive(message: ServerMessage): ReceiveResult {
    const result: ReceiveResult = { send: [], reconnect: false, changed: false };
    switch (message.type) {
      case "snapshot": {
        this.snapshotParts[message.index] = message.data;
        if (message.index === message.total - 1) {
          this.rebuildFrom(JSON.parse(this.snapshotParts.join("")) as FugueJSON);
          this.snapshotParts = [];
          result.changed = true;
        }
        break;
      }
      case "ops": {
        for (const { op } of message.ops) this.doc.applyRemoteOp(op);
        result.changed = message.ops.length > 0;
        break;
      }
      case "synced": {
        this.confirm(message.seq, message.epoch, message.counter);
        // Everything the relay does not have durably yet goes out again; duplicates are ignored there.
        result.send = chunk(this.unacked);
        break;
      }
      case "ack": {
        this.confirm(message.seq, message.epoch, message.counter);
        break;
      }
      case "resync": {
        this.since = null;
        this.epoch = null;
        result.reconnect = true;
        break;
      }
      case "error": {
        result.error = message.message;
        break;
      }
    }
    return result;
  }

  private confirm(seq: number, epoch: number, counter: number): void {
    this.since = seq;
    this.epoch = epoch;
    this.unacked = this.unacked.filter((op) => op.id.counter >= counter);
  }

  /**
   * Replaces the local document with the relay's state and replays the local ops
   * the relay has not confirmed. Anything else the old document held is dropped on
   * purpose: after a relay data loss it may contain other replicas' ops that no
   * longer exist anywhere. A local op that depended on such an op cannot be
   * replayed; it and the local ops after it are discarded.
   */
  private rebuildFrom(state: FugueJSON): void {
    const doc = FugueMax.fromJSON(state, this.replicaId);
    const kept: FugueOp[] = [];
    for (const op of this.unacked) {
      if (doc.hasApplied(op.id)) continue;
      if (!doc.isDeliverable(op)) break;
      doc.applyRemoteOp(op);
      kept.push(op);
    }
    this.doc = doc;
    this.unacked = kept;
  }
}

function chunk(ops: readonly FugueOp[]): ClientMessage[] {
  const out: ClientMessage[] = [];
  for (let i = 0; i < ops.length; i += OPS_PER_MESSAGE) {
    out.push({ type: "ops", ops: ops.slice(i, i + OPS_PER_MESSAGE) });
  }
  return out;
}
