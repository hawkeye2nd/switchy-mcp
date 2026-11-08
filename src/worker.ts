// Cloudflare Worker entry: remote MCP over Streamable HTTP (stateless).
// Endpoint: https://<worker>/mcp/<MCP_ACCESS_KEY>  (or /mcp with "Authorization: Bearer <MCP_ACCESS_KEY>")
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { SwitchyClient } from "./switchy.js";

export interface Env {
  SWITCHY_API_TOKEN?: string;
  SWITCHY_PARTNER_TOKEN?: string;
  MCP_ACCESS_KEY?: string;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json(200, { name: "switchy-mcp", ok: true, configured: Boolean(env.SWITCHY_API_TOKEN) });
    }

    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) return json(404, { error: "Not found" });

    if (!env.MCP_ACCESS_KEY) return json(500, { error: "MCP_ACCESS_KEY secret is not set on the worker" });
    const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    const presented = m[1] ? decodeURIComponent(m[1]) : bearer;
    if (!presented || !timingSafeEqual(presented, env.MCP_ACCESS_KEY)) {
      return json(401, { error: "Unauthorized" });
    }

    if (!env.SWITCHY_API_TOKEN) {
      return json(503, {
        error: "SWITCHY_API_TOKEN secret is not set. Add it in Cloudflare: Workers → switchy-mcp → Settings → Variables and Secrets.",
      });
    }

    // Stateless: fresh server + transport per request.
    const client = new SwitchyClient({ apiToken: env.SWITCHY_API_TOKEN, partnerToken: env.SWITCHY_PARTNER_TOKEN });
    const server = createServer(client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
