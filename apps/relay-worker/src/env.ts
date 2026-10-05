import type { DocumentDO } from "./document-do";

export interface Env {
  DOCUMENT_DO: DurableObjectNamespace<DocumentDO>;
}
