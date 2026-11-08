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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function withCors(res: Response) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return withCors(await handle(request, env));
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
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
    // 403 rather than 401: a 401 makes MCP clients start an OAuth flow this server doesn't offer.
    return json(403, { error: "Forbidden: missing or wrong access key" });
  }

  // Stateless server: no server-initiated SSE stream and no sessions to delete.
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS" },
    });
  }

  // Be lenient with clients that only send Accept: application/json.
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json, text/event-stream");
  const req = new Request(request, { headers });

  // Missing Switchy token doesn't block the handshake; tool calls return a clear error instead.
  const client = new SwitchyClient({ apiToken: env.SWITCHY_API_TOKEN ?? "", partnerToken: env.SWITCHY_PARTNER_TOKEN });
  const server = createServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
