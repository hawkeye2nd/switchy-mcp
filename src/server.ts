import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwitchyClient, SwitchyError } from "./switchy.js";

type TypeRef = { kind: string; name: string | null; ofType?: TypeRef | null };
type Field = { name: string; type: TypeRef; args?: { name: string }[] };

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }";

function baseType(t: TypeRef): TypeRef {
  let cur = t;
  while (cur.ofType) cur = cur.ofType;
  return cur;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const msg =
    err instanceof SwitchyError
      ? `${err.message}${err.details ? `\n${JSON.stringify(err.details, null, 2)}` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

const jsonObject = z.record(z.string(), z.any());

// ---- Link input schema (mirrors https://developers.switchy.io/docs/guides/how-to-create-a-link)
const pixelSchema = z
  .object({
    platform: z
      .enum(["linkedin", "facebook", "gtm", "quora", "pinterest", "twitter", "ga", "bing", "nexus", "adroll", "adwords"])
      .describe("Pixel platform"),
    value: z.string().describe("Pixel value / ID on that platform"),
    id: z.string().optional().describe("Existing pixel UUID in Switchy (omit to create)"),
    title: z.string().optional(),
    workspaceId: z.number().int().optional(),
  })
  .passthrough();

const linkFields = {
  url: z.string().url().describe("Destination URL the short link redirects to"),
  title: z.string().optional().describe("Open Graph title (auto-filled if autofill=true)"),
  description: z.string().optional().describe("Open Graph description"),
  image: z.string().url().optional().describe("Open Graph image URL"),
  favicon: z.string().url().optional(),
  folderId: z.number().int().optional().describe("Folder to place the link in"),
  tags: z.array(z.string()).optional(),
  note: z.string().optional().describe("Private note visible in the Switchy dashboard"),
  pixels: z.array(pixelSchema).optional().describe("Retargeting pixels"),
  showGDPR: z.boolean().optional().describe("Show GDPR consent popup when pixels are present"),
  extraOptionsGeolocations: z
    .array(z.object({ value: z.string().describe("ISO country code, e.g. 'US'"), url: z.string().url() }).passthrough())
    .optional()
    .describe("Geo-targeted redirects"),
  extraOptionsLinkRotator: z.array(z.any()).optional().describe("Link rotator options (raw Switchy JSON)"),
  deepLinkingEnable: z.boolean().optional(),
  masking: z.boolean().optional().describe("Enable link cloaking"),
  linkScriptEnable: z.boolean().optional(),
  linkScripts: z.array(z.number().int()).optional(),
  linkExpiration: z
    .object({
      enable: z.boolean(),
      end: z.string().describe("ISO date, e.g. 2026-12-31T23:59:00.000Z"),
      url: z.string().url().describe("Where to redirect after expiry"),
      timezone: z.number().int(),
    })
    .optional(),
  passwordProtect: z.object({ enable: z.boolean(), password: z.string() }).optional(),
};

function clean(obj: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function createServer(client: SwitchyClient) {
  const server = new McpServer({ name: "switchy", version: "0.1.0" });

  // ---------- schema helpers (cached) ----------
  let rootFieldsCache: Field[] | null = null;
  const typeFieldsCache = new Map<string, Field[]>();

  async function rootFields(): Promise<Field[]> {
    if (rootFieldsCache) return rootFieldsCache;
    const data = await client.graphql<{ __schema: { queryType: { fields: Field[] } } }>(
      `query { __schema { queryType { fields { name args { name } type { ${TYPE_REF} } } } } }`,
    );
    rootFieldsCache = data.__schema.queryType.fields ?? [];
    return rootFieldsCache;
  }

  async function typeFields(typeName: string): Promise<Field[]> {
    const cached = typeFieldsCache.get(typeName);
    if (cached) return cached;
    const data = await client.graphql<{ __type: { fields: Field[] | null } | null }>(
      `query($n: String!) { __type(name: $n) { fields { name type { ${TYPE_REF} } } } }`,
      { n: typeName },
    );
    const fields = data.__type?.fields ?? [];
    typeFieldsCache.set(typeName, fields);
    return fields;
  }

  async function resolveTable(table: string) {
    const roots = await rootFields();
    const root = roots.find((f) => f.name === table);
    if (!root) {
      const available = roots.map((f) => f.name).filter((n) => !n.endsWith("_aggregate") && !n.endsWith("_by_pk"));
      throw new Error(`Unknown table "${table}". Available: ${available.join(", ") || "(none — check token)"}`);
    }
    const typeName = baseType(root.type).name!;
    const scalars = (await typeFields(typeName)).filter((f) => {
      const k = baseType(f.type).kind;
      return k === "SCALAR" || k === "ENUM";
    });
    return { typeName, scalars };
  }

  async function listRecords(args: {
    table: string;
    where?: Record<string, unknown>;
    order_by?: unknown;
    limit?: number;
    offset?: number;
    fields?: string[];
  }) {
    const { typeName, scalars } = await resolveTable(args.table);
    const fields = args.fields?.length ? args.fields : scalars.map((f) => f.name);
    if (!fields.length) throw new Error(`No selectable scalar fields on ${typeName}`);
    const root = (await rootFields()).find((f) => f.name === args.table)!;
    // Hasura-style arguments; only pass the ones the root field supports.
    const argNames = new Set((root.args ?? []).map((a) => a.name));
    const vars: Record<string, unknown> = {};
    const parts: string[] = [];
    const defs: string[] = [];
    const add = (name: string, value: unknown, gqlType: string) => {
      if (value === undefined || !argNames.has(name)) return;
      vars[name] = value;
      parts.push(`${name}: $${name}`);
      defs.push(`$${name}: ${gqlType}`);
    };
    add("where", args.where, `${typeName}_bool_exp`);
    add("order_by", args.order_by, `[${typeName}_order_by!]`);
    add("limit", args.limit, "Int");
    add("offset", args.offset, "Int");
    const query = `query${defs.length ? `(${defs.join(", ")})` : ""} { ${args.table}${
      parts.length ? `(${parts.join(", ")})` : ""
    } { ${fields.join(" ")} } }`;
    const data = await client.graphql<Record<string, unknown[]>>(query, vars);
    const rows = data[args.table] ?? [];
    return { table: args.table, count: rows.length, offset: args.offset ?? 0, rows };
  }

  const paging = {
    limit: z.number().int().min(1).max(500).default(50).describe("Max rows (default 50)"),
    offset: z.number().int().min(0).optional().describe("Rows to skip, for pagination"),
  };

  // ---------- discovery ----------
  server.registerTool(
    "switchy_list_tables",
    {
      title: "List queryable Switchy data",
      description:
        "List the GraphQL root fields (tables) this workspace token can query, e.g. workspaces, domains, links, folders. Use the names with switchy_list_records.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () =>
        (await rootFields()).map((f) => ({ name: f.name, type: baseType(f.type).name })),
      ),
  );

  server.registerTool(
    "switchy_describe_type",
    {
      title: "Describe a Switchy GraphQL type",
      description:
        "Show the fields of a GraphQL type (e.g. 'links', 'domains', 'links_bool_exp') so you know which columns and filters exist.",
      inputSchema: { name: z.string().describe("GraphQL type name, e.g. 'links'") },
      annotations: { readOnlyHint: true },
    },
    ({ name }) =>
      run(async () => {
        const d = await client.graphql<{ __type: unknown }>(
          `query($n: String!) { __type(name: $n) { name kind description
             fields { name description type { ${TYPE_REF} } }
             inputFields { name type { ${TYPE_REF} } }
             enumValues { name } } }`,
          { n: name },
        );
        if (!d.__type) throw new Error(`Type "${name}" not found`);
        return d.__type;
      }),
  );

  // ---------- reads ----------
  server.registerTool(
    "switchy_list_workspaces",
    {
      title: "List workspaces",
      description: "Return the Switchy workspace(s) the API token belongs to.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => listRecords({ table: "workspaces" })),
  );

  server.registerTool(
    "switchy_list_domains",
    {
      title: "List domains",
      description: "List the custom/short domains available in the workspace (removed domains excluded by default).",
      inputSchema: { include_removed: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    ({ include_removed }) =>
      run(() =>
        listRecords({
          table: "domains",
          where: include_removed ? undefined : { removedDate: { _is_null: true } },
        }),
      ),
  );

  server.registerTool(
    "switchy_list_links",
    {
      title: "List / search short links",
      description:
        "List short links in the workspace, newest first. Optional `search` matches (case-insensitive) against the slug, destination URL and title. Optional filters for domain, folder and tag. Returns a compact view (short_url, url, title, clicks, tags, dates, uniq); set detailed=true for every column, or pass `fields`.",
      inputSchema: {
        search: z.string().optional().describe("Text to look for in slug, URL or title"),
        domain: z.string().optional().describe("Only links on this domain"),
        folderId: z.number().int().optional(),
        tag: z.string().optional().describe("Only links carrying this tag"),
        detailed: z.boolean().default(false).describe("Return every column (pixels, expiration, OG image, ...)"),
        fields: z.array(z.string()).optional().describe("Exact columns to return (overrides detailed)"),
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    ({ search, domain, folderId, tag, detailed, fields, limit, offset }) =>
      run(async () => {
        const { scalars } = await resolveTable("links");
        const names = new Set(scalars.map((f) => f.name));
        const and: Record<string, unknown>[] = [];
        if (search) {
          const or = ["id", "url", "title", "description", "note"]
            .filter((n) => names.has(n))
            .map((n) => ({ [n]: { _ilike: `%${search}%` } }));
          if (or.length) and.push({ _or: or });
        }
        if (domain && names.has("domain")) and.push({ domain: { _eq: domain } });
        if (folderId !== undefined && names.has("folderId")) and.push({ folderId: { _eq: folderId } });
        if (tag && names.has("tags")) and.push({ tags: { _contains: [tag] } });
        const dateField = ["createdDate", "createdAt", "created_at"].find((n) => names.has(n));
        const compact = ["id", "domain", "uniq", "url", "title", "clicks", "tags", "folderId", "note", "createdDate"].filter(
          (n) => names.has(n),
        );
        const result = await listRecords({
          table: "links",
          where: and.length ? { _and: and } : undefined,
          order_by: dateField ? [{ [dateField]: "desc" }] : undefined,
          fields: fields?.length ? fields : detailed ? undefined : compact,
          limit,
          offset,
        });
        result.rows = (result.rows as Record<string, unknown>[]).map((r) => {
          const out: Record<string, unknown> = {};
          if (typeof r.domain === "string" && typeof r.id === "string") out.short_url = `https://${r.domain}/${r.id}`;
          for (const [k, v] of Object.entries(r)) {
            if (detailed || fields?.length || (v !== null && !(Array.isArray(v) && v.length === 0))) out[k] = v;
          }
          return out;
        });
        return result;
      }),
  );

  server.registerTool(
    "switchy_list_records",
    {
      title: "Query any Switchy table",
      description:
        "Generic read of any table from switchy_list_tables using Hasura-style filters. Example where: {\"domain\": {\"_eq\": \"go.example.com\"}}; order_by: [{\"createdDate\": \"desc\"}]. Fields default to all scalar columns.",
      inputSchema: {
        table: z.string().describe("Root field name, e.g. 'links', 'folders', 'pixels'"),
        where: jsonObject.optional().describe("Hasura bool_exp filter"),
        order_by: z.array(jsonObject).optional().describe("Hasura order_by list"),
        fields: z.array(z.string()).optional().describe("Columns to return (default: all scalar columns)"),
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => listRecords(args)),
  );

  server.registerTool(
    "switchy_graphql_query",
    {
      title: "Run a raw GraphQL query",
      description:
        "Run an arbitrary read-only GraphQL query against https://graphql.switchy.io/v1/graphql (Hasura). Use for nested selections, aggregates (e.g. links_aggregate { aggregate { count } }) or anything the other tools don't cover.",
      inputSchema: {
        query: z.string().describe("GraphQL query document"),
        variables: jsonObject.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, variables }) =>
      run(async () => {
        if (/^\s*(mutation|subscription)\b/i.test(query)) {
          throw new Error("Only queries are allowed here. Use switchy_create_link / switchy_update_link for writes.");
        }
        return client.graphql(query, variables);
      }),
  );

  // ---------- writes ----------
  server.registerTool(
    "switchy_create_link",
    {
      title: "Create a short link",
      description:
        "Create a Switchy short link (POST /v1/links/create). `domain` should be one of the workspace's domains (see switchy_list_domains). `slug` sets the back-half (domain/slug); omitted = random. Rate limit: 1,000/hour, 10,000/day.",
      inputSchema: {
        ...linkFields,
        domain: z.string().optional().describe("Short domain, e.g. 'go.example.com'"),
        slug: z.string().optional().describe("Custom alias (the link id); random if omitted"),
        autofill: z
          .boolean()
          .optional()
          .describe("Let Switchy fetch Open Graph title/description/image from the URL (server default: true)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ slug, autofill, ...rest }) =>
      run(() => {
        const link = clean({ ...rest, id: slug });
        // Sensible defaults the API expects to be present.
        link.pixels ??= [];
        link.tags ??= [];
        link.extraOptionsGeolocations ??= [];
        link.extraOptionsLinkRotator ??= [];
        link.showGDPR ??= false;
        return client.createLink(link, autofill);
      }),
  );

  const { url: _url, ...optionalLinkFields } = linkFields;
  server.registerTool(
    "switchy_update_link",
    {
      title: "Update a short link",
      description:
        "Update an existing link (PUT /v1/links/:uniqId or /v1/links/by-domain/:domain/:slug). Identify it with `uniqId`, or with `domain` + `slug`. Only pass fields you want to change; `url` is required by Switchy, so pass the current destination if unchanged.",
      inputSchema: {
        uniqId: z.union([z.string(), z.number()]).optional().describe("The link's `uniq` number from switchy_list_links"),
        domain: z.string().optional().describe("Domain of the link (with slug)"),
        slug: z.string().optional().describe("Slug/id of the link on that domain (with domain)"),
        url: linkFields.url,
        ...optionalLinkFields,
        autofill: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ uniqId, domain, slug, autofill, ...rest }) =>
      run(() => {
        let target: { uniqId: string } | { domain: string; id: string };
        if (uniqId !== undefined && uniqId !== "") target = { uniqId: String(uniqId) };
        else if (domain && slug) target = { domain, id: slug };
        else throw new Error("Provide either uniqId, or both domain and slug.");
        return client.updateLink(target, clean(rest), autofill);
      }),
  );

  return server;
}
