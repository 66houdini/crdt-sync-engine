import type { Env } from "./env";

export { DocumentDO } from "./document-do";

export default {
  async fetch(_request, _env): Promise<Response> {
    return new Response("crdt relay: not implemented yet", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
