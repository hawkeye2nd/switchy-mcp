# switchy-mcp

An MCP server for the [Switchy.io](https://switchy.io) link shortener API ([docs](https://developers.switchy.io)).

## Tools

| Tool | What it does |
| --- | --- |
| `switchy_list_workspaces` | Workspace(s) the token belongs to |
| `switchy_list_domains` | Short domains in the workspace |
| `switchy_list_links` | List or search links (slug, URL, title), filtered by domain, folder or tag |
| `switchy_create_link` | Create a short link: custom slug, tags, folder, pixels, geo-redirects, expiry, password, OG meta |
| `switchy_update_link` | Update a link by `uniqId`, or by `domain` + `slug` |
| `switchy_list_tables` | Which GraphQL tables the token can read |
| `switchy_describe_type` | Columns and filters of a GraphQL type |
| `switchy_list_records` | Read any table with Hasura `where` / `order_by` filters |
| `switchy_graphql_query` | Raw read-only GraphQL query, for aggregates or nested data |

Switchy's API only reads through GraphQL. Writes are limited to the two REST link endpoints, so this server can't delete links.

The read tools introspect the schema at runtime, so they pick up whatever columns your workspace exposes.

## Setup

1. In Switchy, open the workspace and go to **Settings → Integrations → Generate a token**. Each token works for one workspace only.
2. Build:
   ```bash
   npm install && npm run build
   ```
3. Add it to your MCP client. For Claude Desktop (`claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "switchy": {
         "command": "node",
         "args": ["/absolute/path/to/switchy-mcp/dist/index.js"],
         "env": { "SWITCHY_API_TOKEN": "your-token" }
       }
     }
   }
   ```
   For Claude Code:
   ```bash
   claude mcp add switchy -e SWITCHY_API_TOKEN=your-token -- node /absolute/path/to/switchy-mcp/dist/index.js
   ```

### Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `SWITCHY_API_TOKEN` | yes | Sent as `Api-Authorization` |
| `SWITCHY_PARTNER_TOKEN` | no | Official partner integrations only (`Partner-Authorization`) |
| `SWITCHY_GRAPHQL_URL` / `SWITCHY_API_URL` | no | Override endpoints (used by tests) |

## Test

```bash
npm test
```
This runs an end-to-end smoke test against a local mock of the Switchy API. No token is needed.

## Limits

Switchy allows 1,000 link creations per hour and 10,000 per day. `hi.switchy.io` and `swiy.io` only work for official integrations, so pass one of your own domains.
