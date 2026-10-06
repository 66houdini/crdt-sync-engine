import { FugueMax, type FugueOp, type Id } from "@crdt/core";
import type { ClientMessage, ServerMessage } from "./protocol";

const OPS_PER_MESSAGE = 500;

export interface ReceiveResult {
  /** Messages the caller should now send on the same connection. */
  send: ClientMessage[];
  /** The relay asked for a resync: close this connection and open a new one. */
  reconnect: boolean;
  /** The local document changed. */
  changed: boolean;
  /** Another client's caret moved, appeared or left. */
  presenceChanged: boolean;
  error?: string;
}

export interface PeerCaret {
  replicaId: string;
  /** Caret position in the local document, resolved from the peer's stable cursor. */
  index: number;
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
  private snapshotFrames: Uint8Array[] = [];
  private snapshotFramesExpected = 0;
  /** A snapshot replaced the document and the local unacknowledged ops are not back in it yet. */
  private replayPending = false;
  private readonly peers = new Map<string, Id | null>();

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
    this.snapshotFrames = [];
    this.snapshotFramesExpected = 0;
    this.peers.clear();
    const params = [`replica=${encodeURIComponent(this.replicaId)}`];
    if (this.since !== null && this.epoch !== null) params.push(`since=${this.since}`, `epoch=${this.epoch}`);
    return params.join("&");
  }

  insert(index: number, text: string): ClientMessage[] {
    this.settleBeforeEdit();
    return this.record(this.doc.insertText(index, text));
  }

  /**
   * A local edit in the middle of a state transfer must not reuse the op ids of
   * unconfirmed local ops that are still waiting to be replayed, so replay them now.
   */
  private settleBeforeEdit(): void {
    if (this.replayPending) this.replayUnacked();
  }

  delete(index: number, count = 1): ClientMessage[] {
    this.settleBeforeEdit();
    const ops: FugueOp[] = [];
    for (let i = 0; i < count; i++) ops.push(this.doc.delete(index));
    return this.record(ops);
  }

  private record(ops: FugueOp[]): ClientMessage[] {
    this.unacked.push(...ops);
    return chunk(ops);
  }

  /** Announces where the local caret is. The cursor is stable, so peers can place it even after further edits. */
  presence(caret: number): ClientMessage {
    return { type: "presence", cursor: this.doc.idBefore(Math.max(0, Math.min(caret, this.doc.length))) };
  }

  /** Other clients' carets, as positions in the local document right now. */
  peerCarets(): PeerCaret[] {
    return [...this.peers].map(([replicaId, cursor]) => ({ replicaId, index: this.doc.caretAfter(cursor) }));
  }

  /** Handles one frame from the relay: a parsed JSON message, or the bytes of a binary frame. */
  receive(message: ServerMessage | Uint8Array): ReceiveResult {
    const result: ReceiveResult = { send: [], reconnect: false, changed: false, presenceChanged: false };
    if (message instanceof Uint8Array) {
      this.snapshotFrames.push(message);
      if (this.snapshotFrames.length === this.snapshotFramesExpected) {
        // Everything the old document held is dropped on purpose: after a relay data
        // loss it may contain other replicas' ops that no longer exist anywhere.
        this.doc = FugueMax.decode(concat(this.snapshotFrames), this.replicaId);
        this.replayPending = true;
        this.snapshotFrames = [];
        this.snapshotFramesExpected = 0;
        result.changed = true;
      }
      return result;
    }
    switch (message.type) {
      case "snapshot": {
        this.snapshotFrames = [];
        this.snapshotFramesExpected = message.frames;
        break;
      }
      case "ops": {
        for (const { op } of message.ops) this.doc.applyRemoteOp(op);
        result.changed = message.ops.length > 0;
        break;
      }
      case "synced": {
        if (this.replayPending) {
          this.replayUnacked();
          result.changed = true;
        }
        this.confirm(message.seq, message.epoch, message.counter);
        // Everything the relay does not have durably yet goes out again; duplicates are ignored there.
        result.send = chunk(this.unacked);
        break;
      }
      case "ack": {
        this.confirm(message.seq, message.epoch, message.counter);
        break;
      }
      case "presence": {
        if (message.gone === true) this.peers.delete(message.replicaId);
        else this.peers.set(message.replicaId, message.cursor);
        result.presenceChanged = true;
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
   * Puts the local ops the relay has not confirmed back into a document that was
   * just rebuilt from the relay's state. This runs at `synced`, once the ops that
   * followed the snapshot have been applied, because a local op may depend on
   * them. A local op that still cannot be placed depended on an op the relay
   * lost; it and the local ops after it are discarded.
   */
  private replayUnacked(): void {
    this.replayPending = false;
    const kept: FugueOp[] = [];
    for (const op of this.unacked) {
      if (this.doc.hasApplied(op.id)) continue;
      if (!this.doc.isDeliverable(op)) break;
      this.doc.applyRemoteOp(op);
      kept.push(op);
    }
    this.unacked = kept;
  }
}

function concat(frames: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

function chunk(ops: readonly FugueOp[]): ClientMessage[] {
  const out: ClientMessage[] = [];
  for (let i = 0; i < ops.length; i += OPS_PER_MESSAGE) {
    out.push({ type: "ops", ops: ops.slice(i, i + OPS_PER_MESSAGE) });
  }
  return out;
}
