import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// One instance per document. Real implementation lands in Milestone 4.
export class DocumentDO extends DurableObject<Env> {}
