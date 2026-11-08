#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { SwitchyClient } from "./switchy.js";

const apiToken = process.env.SWITCHY_API_TOKEN;
if (!apiToken) {
  console.error(
    "SWITCHY_API_TOKEN is not set. Get one in Switchy: workspace Settings → Integrations → Generate a token.",
  );
  process.exit(1);
}

const client = new SwitchyClient({
  apiToken,
  partnerToken: process.env.SWITCHY_PARTNER_TOKEN || undefined,
});

const server = createServer(client);
await server.connect(new StdioServerTransport());
console.error("Switchy MCP server running on stdio");
