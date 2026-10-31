import type { Address } from "assayscore-core";
import { ContractFunctionZeroDataError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analysis, loadContext } from "../src/analysis.js";
import type { DB } from "../src/db.js";
import { AgentCards, type OwnerReader, parseRegistration, readOwner } from "../src/enrich/agents.js";
import { memoryDb } from "./helpers.js";

const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const WALLET = "0x00000000000000000000000000000000000000a2" as Address;
const PAYTO = "0x00000000000000000000000000000000000000c1" as Address;
const OTHER = "0x00000000000000000000000000000000000000c2" as Address;
const STRANGER = "0x00000000000000000000000000000000000000f1" as Address;
const CLIENT = "0x00000000000000000000000000000000000000b1" as Address;

// Registration files served over https come from here instead of the network.
const remote = vi.hoisted(() => ({ fetch: async (_url: string): Promise<string> => "" }));
vi.mock("../src/lib/http.js", async (orig) => ({
  ...((await orig()) as object),
  fetchUntrusted: (url: string) => remote.fetch(url),
}));

afterEach(() => vi.unstubAllGlobals());

/** owner() answers from a table; addresses missing from it revert, like an EOA or a contract without owner(). */
function owners(table: Record<string, string>): OwnerReader & { calls: number } {
  const r = {
    calls: 0,
    async readContract({ address }: { address: Address }) {
      r.calls++;
      const o = table[address];
      if (o === "down") throw new Error("fetch failed: 503");
      if (!o) throw new ContractFunctionZeroDataError({ functionName: "owner" });
      return o;
    },
  };
  return r as OwnerReader & { calls: number };
}

function registration(services: unknown[]): string {
  const json = JSON.stringify({ name: "Pay Agent", services });
  return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

function addAgent(db: DB, id: string, uri: string, wallet: Address | null = null) {
  db.prepare(
    "INSERT INTO agents (agent_id, owner, wallet, uri, registered_block, registered_ts) VALUES (?, ?, ?, ?, 1, 1)",
  ).run(id, OWNER, wallet, uri);
}

describe("parseRegistration addresses", () => {
  it("reads Celo CAIP-10 service endpoints only", () => {
    const card = parseRegistration(
      JSON.stringify({
        services: [
          { name: "web", endpoint: "https://shop.example" },
          { name: "agentWallet", endpoint: `eip155:42220:${PAYTO.toUpperCase().replace("0X", "0x")}` },
          { name: "base", endpoint: `eip155:8453:${OTHER}` },
          { name: "Self Agent ID", endpoint: "https://docs.example", agentRegistry: `eip155:42220:${OTHER}` },
          { name: "dup", endpoint: ` eip155:42220:${PAYTO} ` },
          null,
        ],
        endpoints: [{ name: "agentWallet", endpoint: `eip155:42220:${OTHER}` }],
      }),
    );
    expect(card.addresses).toEqual([PAYTO, OTHER]);
  });

  it("caps the list and tolerates files without services", () => {
    expect(parseRegistration(JSON.stringify({ name: "x" })).addresses).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      endpoint: `eip155:42220:0x${(i + 1).toString(16).padStart(40, "0")}`,
    }));
    expect(parseRegistration(JSON.stringify({ services: many })).addresses).toHaveLength(10);
  });
});

describe("readOwner", () => {
  it("is null for an EOA, a revert, or the zero address", async () => {
    expect(await readOwner(owners({ [PAYTO]: OWNER.toUpperCase().replace("0X", "0x") }), PAYTO)).toBe(OWNER);
    expect(await readOwner(owners({}), PAYTO)).toBeNull();
    expect(await readOwner(owners({ [PAYTO]: `0x${"0".repeat(40)}` }), PAYTO)).toBeNull();
    expect(await readOwner(owners({ [PAYTO]: "garbage" }), PAYTO)).toBeNull();
  });

  it("throws when the RPC fails, since that says nothing about the owner", async () => {
    await expect(readOwner(owners({ [PAYTO]: "down" }), PAYTO)).rejects.toThrow(/503/);
  });
});

describe("contracts linked to an agent", () => {
  async function setup(table: Record<string, string>, services: unknown[], wallet: Address | null = null) {
    const db = memoryDb();
    addAgent(db, "7", registration(services), wallet);
    const rpc = owners(table);
    const cards = new AgentCards(db, "https://ipfs.invalid/", () => {}, rpc);
    await cards.batch();
    await cards.linkPass();
    return { db, cards, rpc };
  }

  it("credits a contract the agent's file lists and its owner owns", async () => {
    const { db } = await setup({ [PAYTO]: OWNER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    expect(loadContext(db).agentIds.get(PAYTO)).toEqual(["7"]);
    const agent = new Analysis(db).agent("7");
    expect(agent?.linked).toEqual([PAYTO]);
    expect(new Analysis(db).agentsFor(PAYTO).map((a) => a.agentId)).toEqual(["7"]);
  });

  it("accepts a contract owned by the agent's verified wallet", async () => {
    const { db } = await setup(
      { [PAYTO]: WALLET },
      [{ name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` }],
      WALLET,
    );
    expect(loadContext(db).agentIds.get(PAYTO)).toEqual(["7"]);
  });

  it("ignores a listed contract someone else owns", async () => {
    const { db } = await setup({ [PAYTO]: STRANGER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    expect(loadContext(db).agentIds.get(PAYTO)).toBeUndefined();
    expect(new Analysis(db).agent("7")?.linked).toEqual([]);
  });

  it("ignores a contract that names the agent's owner but is not in its file", async () => {
    // The spoof: any contract can return any address from owner(). The file is the owner's own word.
    const { db } = await setup({ [PAYTO]: OWNER, [OTHER]: OWNER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    expect(loadContext(db).agentIds.get(OTHER)).toBeUndefined();
  });

  it("ignores a listed EOA", async () => {
    const { db } = await setup({}, [{ name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` }]);
    expect(loadContext(db).agentIds.get(PAYTO)).toBeUndefined();
    const row = db.prepare("SELECT checked_at, contract_owner FROM agent_links").get() as {
      checked_at: number | null;
      contract_owner: string | null;
    };
    expect(row.checked_at).not.toBeNull();
    expect(row.contract_owner).toBeNull();
  });

  it("drops the link when the agent changes hands or the file stops listing it", async () => {
    const { db, cards } = await setup({ [PAYTO]: OWNER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    db.prepare("UPDATE agents SET owner = ? WHERE agent_id = '7'").run(STRANGER);
    expect(loadContext(db).agentIds.get(PAYTO)).toBeUndefined();

    db.prepare("UPDATE agents SET owner = ?, uri = ?, meta_fetched_at = NULL WHERE agent_id = '7'").run(
      OWNER,
      registration([{ name: "web", endpoint: "https://shop.example" }]),
    );
    await cards.batch();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_links").get()).toEqual({ n: 0 });
    expect(loadContext(db).agentIds.get(PAYTO)).toBeUndefined();
  });

  it("keeps a link when a later owner() lookup fails, and tries again within the hour", async () => {
    const { db } = await setup({ [PAYTO]: OWNER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    const down = new AgentCards(db, "https://ipfs.invalid/", () => {}, owners({ [PAYTO]: "down" }));
    const now = Math.floor(Date.now() / 1000);
    expect(await down.linkPass(50, now + 86_400 + 60)).toBe(1);
    expect(loadContext(db).agentIds.get(PAYTO)).toEqual(["7"]);
    expect(await down.linkPass(50, now + 86_400 + 120)).toBe(0);
    expect(await down.linkPass(50, now + 86_400 + 3_700)).toBe(1);
  });

  it("re-reads owner() after a day, not before", async () => {
    const { cards, rpc } = await setup({ [PAYTO]: OWNER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    const now = Math.floor(Date.now() / 1000);
    expect(await cards.linkPass(50, now + 3_600)).toBe(0);
    expect(await cards.linkPass(50, now + 86_400 + 60)).toBe(1);
    expect(rpc.calls).toBe(2);
  });

  it("counts payments to the contract toward the agent's revenue and paying reviews", async () => {
    const { db } = await setup({ [PAYTO]: OWNER }, [
      { name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` },
    ]);
    db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 2, 12.5, 100, 200, '0x1')",
    ).run(CLIENT, PAYTO);
    db.prepare(
      `INSERT INTO settlements (tx_hash, log_index, block, ts, relayer, token, payer, payee, amount, usd, scored)
       VALUES ('0xabc', 0, 1, 150, ?, ?, ?, ?, '1', 12.5, 1)`,
    ).run(OWNER, OWNER, CLIENT, PAYTO);
    db.prepare(
      `INSERT INTO feedback (agent_id, client, idx, value, decimals, tag1, tag2, endpoint, uri, hash, block, ts, tx_hash, proof_tx)
       VALUES ('7', ?, 1, '90', 0, '', '', '', '', '0x', 2, 300, '0xdef', '0xabc')`,
    ).run(CLIENT);
    const analysis = new Analysis(db);
    const agent = analysis.agent("7")!;
    expect(agent.revenueUsd).toBe(12.5);
    expect(agent.paidReviews).toBe(1);
    expect(analysis.reviews("7")[0]?.tier).toBe("proven");
    expect(analysis.payments("7", CLIENT).map((p) => p.payee)).toEqual([PAYTO]);
  });

  describe("https registration files", () => {
    const URL_ = "https://shop.example/.well-known/agent.json";
    const file = (services: unknown[]) => JSON.stringify({ name: "Shop", services });

    it("re-reads a file edited in place, keeps owner() readings, and survives an outage", async () => {
      const db = memoryDb();
      addAgent(db, "7", URL_);
      let body = file([{ name: "web", endpoint: "https://shop.example" }]);
      let up = true;
      remote.fetch = async () => {
        if (!up) throw new Error("HTTP 503");
        return body;
      };
      const cards = new AgentCards(db, "https://ipfs.invalid/", () => {}, owners({ [PAYTO]: OWNER }));
      const t0 = 1_000_000;
      await cards.batch(20, t0);
      expect(loadContext(db).agentIds.get(PAYTO)).toBeUndefined();

      // The owner adds the contract to the same URL; nothing happens onchain.
      body = file([{ name: "agentWallet", endpoint: `eip155:42220:${PAYTO}` }]);
      expect(await cards.batch(20, t0 + 3_600)).toBe(0);
      expect(await cards.batch(20, t0 + 86_400 + 1)).toBe(1);
      await cards.linkPass(50, t0 + 86_400 + 2);
      expect(loadContext(db).agentIds.get(PAYTO)).toEqual(["7"]);

      // A second refresh with the same file keeps the owner() reading, so the link never blinks.
      await cards.batch(20, t0 + 2 * 86_400 + 10);
      expect(loadContext(db).agentIds.get(PAYTO)).toEqual(["7"]);

      // The host is down on the next refresh: the name and the link stay.
      up = false;
      await cards.batch(20, t0 + 3 * 86_400 + 20);
      expect(loadContext(db).agentIds.get(PAYTO)).toEqual(["7"]);
      const row = db.prepare("SELECT name, meta_error FROM agents WHERE agent_id = '7'").get() as {
        name: string;
        meta_error: string;
      };
      expect(row.name).toBe("Shop");
      expect(row.meta_error).toMatch(/503/);
    });
  });
});
