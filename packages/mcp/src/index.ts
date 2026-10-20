#!/usr/bin/env node
/**
 * Assay MCP server (stdio).
 *
 *   ASSAY_URL=https://api-production-63cc.up.railway.app node packages/mcp/dist/index.js
 *
 * Free endpoints are used by default. To use the paid endpoints (signed scores,
 * no rate limit), pass a paying fetch through the library API instead; this CLI
 * stays keyless on purpose so it never holds a wallet.
 */
import { createAssay } from "@assay/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const baseUrl = process.env.ASSAY_URL;
if (!baseUrl) {
  process.stderr.write("Set ASSAY_URL to your Assay server, e.g. ASSAY_URL=https://api.example.com\n");
  process.exit(1);
}

const server = new McpServer({ name: "assay", version: "0.1.0" });
registerTools(server, createAssay({ baseUrl }), { paid: false });
await server.connect(new StdioServerTransport());
