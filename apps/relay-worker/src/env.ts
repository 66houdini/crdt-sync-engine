import type { DocumentDO } from "./document-do";

/** All tuning values are optional decimal strings (wrangler `[vars]`); see document-do.ts for the defaults. */
export interface Env {
  DOCUMENT_DO: DurableObjectNamespace<DocumentDO>;
  /** Optional R2 bucket for superseded snapshots and compacted log segments. */
  SNAPSHOT_ARCHIVE?: R2Bucket;
  SNAPSHOT_EVERY_OPS?: string;
  LOG_TAIL_OPS?: string;
  /** Most elements (live characters plus tombstones) a document may hold. */
  MAX_DOC_ELEMENTS?: string;
  MAX_CONNECTIONS?: string;
  /** Per-replica token bucket: burst size and refill rate, in ops. */
  RATE_BURST?: string;
  RATE_PER_SECOND?: string;
  /** Delete a document this many seconds after its last activity. Unset or 0: keep forever. */
  DOC_TTL_SECONDS?: string;
}
