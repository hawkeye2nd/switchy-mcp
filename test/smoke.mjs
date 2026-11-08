// Smoke test: mock Switchy (Hasura-like GraphQL + REST) and drive the MCP server over stdio.
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const T = (kind, name, ofType = null) => ({ kind, name, ofType });
const list = (n) => T("NON_NULL", null, T("LIST", null, T("NON_NULL", null, T("OBJECT", n))));
const S = (n) => T("NON_NULL", null, T("SCALAR", n));
const hasuraArgs = [{ name: "where" }, { name: "order_by" }, { name: "limit" }, { name: "offset" }];
const types = {
  links: ["id", "domain", "url", "title", "createdDate", "folderId"].map((n) => ({ name: n, type: S("String") })).concat([{ name: "tags", type: T("SCALAR", "jsonb") }]),
  workspaces: ["id", "name", "companyName"].map((n) => ({ name: n, type: S("String") })),
  domains: ["name", "createdDate", "removedDate"].map((n) => ({ name: n, type: T("SCALAR", "String") })),
};
const seen = [];
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers["api-authorization"], body: b });
    res.setHeader("Content-Type", "application/json");
    if (req.headers["api-authorization"] !== "test-token") { res.statusCode = 401; return res.end("Unauthorized"); }
    if (req.url === "/graphql") {
      const { query, variables } = JSON.parse(b);
      if (query.includes("__schema { queryType { fields"))
        return res.end(JSON.stringify({ data: { __schema: { queryType: { fields: Object.keys(types).map((n) => ({ name: n, args: hasuraArgs, type: list(n) })) } } } }));
      if (query.includes("__type(name: $n) { fields { name type"))
        return res.end(JSON.stringify({ data: { __type: { fields: types[variables.n] ?? null } } }));
      if (query.includes("links")) return res.end(JSON.stringify({ data: { links: [{ id: "abc", domain: "go.x.com", url: "https://x.com" }] } }));
      if (query.includes("workspaces")) return res.end(JSON.stringify({ data: { workspaces: [{ id: "1", name: "Cybis" }] } }));
      return res.end(JSON.stringify({ data: {} }));
    }
    if (req.url === "/v1/links/create") return res.end(JSON.stringify({ id: "new", ...JSON.parse(b).link }));
    if (req.url.startsWith("/v1/links/")) return res.end(JSON.stringify({ updated: req.url }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node", args: ["dist/index.js"],
  env: { ...process.env, SWITCHY_API_TOKEN: "test-token", SWITCHY_GRAPHQL_URL: `${base}/graphql`, SWITCHY_API_URL: `${base}/v1` },
}));
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); };
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { r, j: (() => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } })() }; };

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
assert(tools.length === 9, "9 tools registered");

let { j } = await call("switchy_list_tables"); assert(j.length === 3, "list_tables");
({ j } = await call("switchy_list_workspaces")); assert(j.rows[0].name === "Cybis", "list_workspaces");
({ j } = await call("switchy_list_links", { search: "promo", tag: "fb", limit: 5 }));
assert(j.rows[0].id === "abc", "list_links returns rows");
const q = JSON.parse(seen.at(-1).body);
assert(q.variables.where._and[0]._or.length === 3 && q.variables.limit === 5 && q.variables.order_by[0].createdDate === "desc", "list_links builds Hasura filter");
assert(q.query.includes("$where: links_bool_exp"), "typed variables");
({ j } = await call("switchy_create_link", { url: "https://example.com", domain: "go.x.com", slug: "promo", tags: ["a"] }));
assert(j.id === "promo" && Array.isArray(j.pixels) && j.domain === "go.x.com", "create_link payload");
({ j } = await call("switchy_update_link", { domain: "go.x.com", slug: "promo", url: "https://e.com" }));
assert(j.updated === "/v1/links/by-domain/go.x.com/promo" && seen.at(-1).method === "PUT", "update_link by domain");
let { r } = await call("switchy_update_link", { url: "https://e.com" }); assert(r.isError, "update_link requires target");
({ r } = await call("switchy_graphql_query", { query: "mutation { x }" })); assert(r.isError, "raw query blocks mutations");
({ r } = await call("switchy_list_records", { table: "nope" })); assert(r.isError && r.content[0].text.includes("Available"), "unknown table error");
assert(seen.every((s) => s.auth === "test-token"), "auth header on every request");
await client.close(); srv.close(); console.log("ALL PASSED");
