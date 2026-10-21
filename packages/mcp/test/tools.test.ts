import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAssay } from "assayscore";
import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools.js";

const SELLER = "0x5555555555555555555555555555555555555555";

async function connect(fetchImpl: typeof fetch) {
  const server = new McpServer({ name: "assay", version: "test" });
  registerTools(server, createAssay({ baseUrl: "https://assay.test", fetch: fetchImpl }), { paid: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("Assay MCP tools", () => {
  it("lists four read-only tools", async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "assay_check_seller",
      "assay_economy",
      "assay_find_agents",
      "assay_report",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("checks a seller through the free endpoint", async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ check: { verdict: "block", rating: "D", reasons: ["Circular revenue"] } }),
        ),
    );
    const client = await connect(f as unknown as typeof fetch);
    const res = await client.callTool({ name: "assay_check_seller", arguments: { address: SELLER } });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text).verdict).toBe("block");
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`https://assay.test/v1/address/${SELLER}`);
  });

  it("includes what X says, or says it has not been searched", async () => {
    const x = {
      checkedAt: 1_792_000_000,
      status: "ok",
      mentions: 2,
      warnings: 1,
      weakWarnings: 0,
      posts: [
        { url: "https://x.com/a/status/1", author: "a", warning: true },
        { url: "https://x.com/b/status/2", author: "b", warning: false },
      ],
      searchUrl: "https://x.com/search?q=x",
      tx: null,
    };
    const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body)));
    const withX = await connect(
      reply({
        check: { verdict: "caution", rating: "BB", reasons: ["1 post on X names this address"] },
        x,
      }) as unknown as typeof fetch,
    );
    const a = JSON.parse(
      (
        (await withX.callTool({ name: "assay_check_seller", arguments: { address: SELLER } })).content as {
          text: string;
        }[]
      )[0]!.text,
    );
    expect(a.x).toEqual({
      searched: "2026-10-14",
      mentions: 2,
      warnings: 1,
      posts: [
        { url: "https://x.com/a/status/1", author: "a", warning: true },
        { url: "https://x.com/b/status/2", author: "b", warning: false },
      ],
      searchUrl: "https://x.com/search?q=x",
    });
    const without = await connect(
      reply({ check: { verdict: "pass", rating: "A", reasons: [] }, x: null }) as unknown as typeof fetch,
    );
    const b = JSON.parse(
      (
        (await without.callTool({ name: "assay_check_seller", arguments: { address: SELLER } })).content as {
          text: string;
        }[]
      )[0]!.text,
    );
    expect(b.x).toBe("not searched yet");
  });

  it("rejects bad addresses before calling Assay", async () => {
    const f = vi.fn();
    const client = await connect(f as unknown as typeof fetch);
    const res = await client.callTool({ name: "assay_check_seller", arguments: { address: "0x12" } });
    expect(res.isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("turns API failures into tool errors instead of crashing", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate_limited", message: "slow down" }), { status: 429 }),
    );
    const client = await connect(f as unknown as typeof fetch);
    const res = await client.callTool({ name: "assay_economy", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/slow down/);
  });
});
