import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type DB, openDatabase } from "../src/db.js";
import { FxRates } from "../src/enrich/fx.js";
import { type Env, loadEnv } from "../src/env.js";
import type { SqdBlock, SqdClient, SqdHead, SqdQuery } from "../src/indexer/sqd.js";

export const FIXTURE_BLOCKS: SqdBlock[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/blocks.json", import.meta.url)), "utf8"),
);

export function memoryDb(): DB {
  return openDatabase(":memory:");
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: "test", DATABASE_PATH: ":memory:", ...overrides });
}

/** FX with fixed rates so USD values are deterministic. */
export function fixedFx(db: DB): FxRates {
  db.prepare(
    "INSERT OR REPLACE INTO fx (fiat, day, rate) VALUES ('ARS', 20000, 1500), ('BRL', 20000, 5), ('COP', 20000, 4000)",
  ).run();
  return new FxRates(db);
}

/** Stands in for the SQD portal: serves the given blocks, honouring from/to. */
export function fakeSqd(blocks: SqdBlock[], head?: number): SqdClient {
  const sorted = [...blocks].sort((a, b) => a.header.number - b.header.number);
  const top = head ?? sorted.at(-1)?.header.number ?? 0;
  return {
    async finalizedHead(): Promise<SqdHead> {
      return { number: top, hash: "0x" };
    },
    async *stream(q: SqdQuery) {
      for (const b of sorted) {
        if (b.header.number >= q.fromBlock && (q.toBlock === undefined || b.header.number <= q.toBlock))
          yield b;
      }
    },
  } as unknown as SqdClient;
}

export const pad = (a: string) => `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
export const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
