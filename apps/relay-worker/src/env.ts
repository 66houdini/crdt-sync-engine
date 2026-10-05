import type { DocumentDO } from "./document-do";

export interface Env {
  DOCUMENT_DO: DurableObjectNamespace<DocumentDO>;
  /** Optional R2 bucket for superseded snapshots and compacted log segments. */
  SNAPSHOT_ARCHIVE?: R2Bucket;
  /** Optional overrides (decimal strings) for the compaction thresholds. */
  SNAPSHOT_EVERY_OPS?: string;
  LOG_TAIL_OPS?: string;
}
