#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
/**
 * Assay MCP server (stdio).
 *
 *   npx -y assayscore-mcp                      # the public Assay API
 *   ASSAY_URL=https://your-assay npx -y assayscore-mcp
 *
 * Free endpoints are used by default. To use the paid endpoints (signed scores,
 * no rate limit), pass a paying fetch through the library API instead; this CLI
 * stays keyless on purpose so it never holds a wallet.
 */
import { createAssay, DEFAULT_BASE_URL } from "assayscore";
import { registerTools } from "./tools.js";

const baseUrl = process.env.ASSAY_URL || DEFAULT_BASE_URL;

const server = new McpServer({ name: "assay", version: "0.2.0" });
registerTools(server, createAssay({ baseUrl }), { paid: false });
await server.connect(new StdioServerTransport());
