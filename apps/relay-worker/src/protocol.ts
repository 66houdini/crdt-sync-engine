import type { FugueOp } from "@crdt/core";

/**
 * Wire protocol between a client replica and a DocumentDO. All messages are JSON text frames.
 *
 * Connect:  GET /doc/<documentId>/ws?replica=<id>[&since=<seq>&epoch=<n>]   (WebSocket upgrade)
 *
 * The relay assigns every accepted op a per-document sequence number. `since` and
 * `epoch` are what the client last saw in a `synced` / `ack` message; when they
 * are still valid the relay replies with just the ops after `since`, otherwise
 * with a full snapshot. Either way the reply ends with `synced`.
 *
 * Durability. The relay applies and broadcasts ops immediately but persists them
 * in batches. A client must treat an op as delivered only once an `ack` (or
 * `synced`) covers its counter, and must resend everything else after reconnecting.
 * Resends are harmless: ops are idempotent.
 */
export interface SequencedOp {
  seq: number;
  op: FugueOp;
}

export type ClientMessage = { type: "ops"; ops: FugueOp[] };

export type ServerMessage =
  /** One slice of the JSON-encoded FugueJSON state; slices arrive in order, `index` 0..total-1. */
  | { type: "snapshot"; index: number; total: number; data: string }
  /** Ops from other replicas (live), or the catch-up tail after `since` (may include the client's own). */
  | { type: "ops"; ops: SequencedOp[] }
  /** End of the initial sync. Everything up to `seq` is durable; `counter` of this client's ops are durable. */
  | { type: "synced"; seq: number; epoch: number; counter: number }
  /** A batch was persisted: everything up to `seq` is durable, including this client's first `counter` ops. */
  | { type: "ack"; seq: number; epoch: number; counter: number }
  /**
   * The relay restarted and lost a not-yet-persisted batch, so clients may hold ops
   * it no longer has. The client must reconnect without `since` and rebuild from the snapshot.
   */
  | { type: "resync"; epoch: number }
  | { type: "error"; message: string };

export const REPLICA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Replica id the relay's own FugueMax instance uses; it never authors ops. */
export const SERVER_REPLICA_ID = "server";
