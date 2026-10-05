import type { Env } from "./env";

export { DocumentDO } from "./document-do";

const DOC_ROUTE = /^\/doc\/([A-Za-z0-9_-]{1,128})\/(ws|text|stats)$/;

const USAGE = `crdt relay
  GET /doc/<id>/ws?replica=<id>[&since=<seq>&epoch=<n>]   WebSocket sync endpoint
  GET /doc/<id>/text                                       current document text
  GET /doc/<id>/stats                                      relay counters (JSON)
`;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = DOC_ROUTE.exec(url.pathname);
    if (match === null) {
      return new Response(USAGE, { status: url.pathname === "/" ? 200 : 404 });
    }
    if (match[2] === "ws" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    // One Durable Object per document.
    const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(match[1] as string));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
