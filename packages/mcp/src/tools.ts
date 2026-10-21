import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AssayClient } from "assayscore";
import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte address")
  .describe("Celo address of the seller, buyer or agent wallet");

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): Text => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown): Text => ({
  content: [{ type: "text", text: `Assay error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

/** Register Assay's tools on an MCP server. Kept separate from stdio so it can be tested in memory. */
export function registerTools(server: McpServer, assay: AssayClient, opts: { paid: boolean }): void {
  server.registerTool(
    "assay_check_seller",
    {
      title: "Check an x402 seller before paying",
      description:
        "Returns pass, caution or block for a Celo address, with its Assay rating, organic revenue share and reasons, plus what X says about the address (posts naming it, and how many use words like scam or hack). Call this before paying an unfamiliar x402 seller.",
      inputSchema: {
        address,
        fresh_x: z
          .boolean()
          .optional()
          .describe(
            "Buy a fresh X search for the address with the check ($0.01 instead of $0.002). Only with a paying client; ignored on the free API.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address: a, fresh_x }) => {
      try {
        if (opts.paid) return ok(await assay.check(a, { freshX: fresh_x }));
        const report = await assay.address(a);
        const x = report.x;
        return ok({
          ...report.check,
          x: x
            ? {
                searched: new Date(x.checkedAt * 1000).toISOString().slice(0, 10),
                mentions: x.mentions,
                warnings: x.warnings,
                posts: x.posts.slice(0, 3).map((p) => ({ url: p.url, author: p.author, warning: p.warning })),
                searchUrl: x.searchUrl,
              }
            : "not searched yet",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "assay_report",
    {
      title: "Full Assay credit report",
      description:
        "Organic vs circular x402 revenue, payer breakdown, funding analysis, flags with evidence transactions, and ERC-8004 / Self identity for one Celo address.",
      inputSchema: { address },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address: a }) => {
      try {
        return ok(opts.paid ? await assay.attest(a) : await assay.address(a));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "assay_independent_payers",
    {
      title: "Independent payers, by the hackathon's rule",
      description:
        "For a Celo seller address: which payers count as independent users under the Agents on Open Rails rule (not the seller or its loop, not funded by the seller or its funder, active on Celo before the window), with reasons per payer and volume inside the window.",
      inputSchema: { address },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address: a }) => {
      try {
        const r = await assay.independent(a, { limit: 50 });
        return ok({ rule: r.rule, window: r.window, totals: r.totals, payers: r.rows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "assay_find_agents",
    {
      title: "Find ERC-8004 agents on Celo",
      description:
        "Search ERC-8004 agents by name, id or address. Results are ranked by reviews from wallets that actually paid the agent, then by x402 revenue.",
      inputSchema: {
        query: z.string().max(80).optional().describe("Name, #id or address"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        return ok(await assay.agents({ q: query, limit: limit ?? 10 }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "assay_economy",
    {
      title: "State of the Celo x402 economy",
      description:
        "Gross vs organic x402 volume on Celo, payment loops detected, rating distribution and top sellers.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await assay.economy());
      } catch (err) {
        return fail(err);
      }
    },
  );
}
