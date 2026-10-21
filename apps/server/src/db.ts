import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settlements (
    tx_hash   TEXT    NOT NULL,
    log_index INTEGER NOT NULL,
    block     INTEGER NOT NULL,
    ts        INTEGER NOT NULL,
    relayer   TEXT    NOT NULL,
    token     TEXT    NOT NULL,
    payer     TEXT    NOT NULL,
    payee     TEXT    NOT NULL,
    amount    TEXT    NOT NULL,
    usd       REAL    NOT NULL,
    scored    INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  ) WITHOUT ROWID;
  CREATE INDEX settlements_payee ON settlements (payee, ts);
  CREATE INDEX settlements_payer ON settlements (payer, ts);
  CREATE INDEX settlements_block ON settlements (block);

  -- Per (payer, payee, UTC day) roll-up of scored settlements. The ledger is built from this.
  CREATE TABLE pair_days (
    payer     TEXT    NOT NULL,
    payee     TEXT    NOT NULL,
    day       INTEGER NOT NULL,
    count     INTEGER NOT NULL,
    usd       REAL    NOT NULL,
    first_ts  INTEGER NOT NULL,
    last_ts   INTEGER NOT NULL,
    last_tx   TEXT    NOT NULL,
    PRIMARY KEY (payer, payee, day)
  ) WITHOUT ROWID;
  CREATE INDEX pair_days_day ON pair_days (day);
  CREATE INDEX pair_days_payee ON pair_days (payee);

  CREATE TABLE relayers (
    address     TEXT PRIMARY KEY,
    settlements INTEGER NOT NULL DEFAULT 0,
    usd         REAL    NOT NULL DEFAULT 0,
    first_block INTEGER NOT NULL,
    last_block  INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE cursors (
    name       TEXT PRIMARY KEY,
    block      INTEGER NOT NULL,
    block_ts   INTEGER,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE agents (
    agent_id         TEXT PRIMARY KEY,
    owner            TEXT NOT NULL,
    wallet           TEXT,
    uri              TEXT,
    registered_block INTEGER NOT NULL,
    registered_ts    INTEGER NOT NULL,
    name             TEXT,
    description      TEXT,
    image            TEXT,
    x402             INTEGER,
    meta_fetched_at  INTEGER,
    meta_error       TEXT
  );
  CREATE INDEX agents_owner ON agents (owner);
  CREATE INDEX agents_wallet ON agents (wallet);

  CREATE TABLE feedback (
    agent_id    TEXT    NOT NULL,
    client      TEXT    NOT NULL,
    idx         INTEGER NOT NULL,
    value       TEXT    NOT NULL,
    decimals    INTEGER NOT NULL,
    tag1        TEXT    NOT NULL,
    tag2        TEXT    NOT NULL,
    endpoint    TEXT    NOT NULL,
    uri         TEXT    NOT NULL,
    hash        TEXT    NOT NULL,
    block       INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    tx_hash     TEXT    NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    proof_tx    TEXT,
    comment     TEXT,
    PRIMARY KEY (agent_id, client, idx)
  ) WITHOUT ROWID;
  CREATE INDEX feedback_client ON feedback (client);
  CREATE INDEX feedback_block ON feedback (block);

  CREATE TABLE funding (
    address          TEXT PRIMARY KEY,
    funder           TEXT,
    funded_at        INTEGER,
    first_seen_at    INTEGER,
    funder_is_public INTEGER NOT NULL DEFAULT 0,
    fetched_at       INTEGER NOT NULL,
    error            TEXT
  ) WITHOUT ROWID;

  CREATE TABLE funder_profiles (
    address    TEXT PRIMARY KEY,
    is_public  INTEGER NOT NULL,
    reason     TEXT,
    fetched_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE humans (
    address    TEXT PRIMARY KEY,
    agent_id   TEXT,
    nullifier  TEXT,
    fresh      INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE fx (
    fiat TEXT    NOT NULL,
    day  INTEGER NOT NULL,
    rate REAL    NOT NULL,
    PRIMARY KEY (fiat, day)
  ) WITHOUT ROWID;
  `,
  // v2: proof of payment for calls Assay pays to services it does not own.
  `
  CREATE TABLE paid_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    service    TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    status     INTEGER NOT NULL,
    usd        REAL    NOT NULL,
    tx_hash    TEXT,
    payer      TEXT    NOT NULL,
    note       TEXT
  );
  CREATE INDEX paid_calls_ts ON paid_calls (ts);
  `,
  // v3: what X says about each seller, one paid search per address (see enrich/xmentions.ts).
  `
  CREATE TABLE x_mentions (
    address    TEXT    PRIMARY KEY,
    checked_at INTEGER NOT NULL,
    status     TEXT    NOT NULL,
    mentions   INTEGER NOT NULL,
    warnings   INTEGER NOT NULL,
    data       TEXT    NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX x_mentions_checked ON x_mentions (checked_at);
  `,
  // v4: addresses people asked about, searched on X ahead of the revenue-ordered queue.
  `
  CREATE TABLE x_wanted (
    address   TEXT    PRIMARY KEY,
    wanted_at INTEGER NOT NULL,
    paid      INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,
  // v5: API usage per day and kind, and distinct callers as salted hashes (see usage.ts).
  `
  CREATE TABLE usage_daily (
    day   INTEGER NOT NULL,
    kind  TEXT    NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, kind)
  ) WITHOUT ROWID;
  CREATE TABLE usage_visitors (
    day  INTEGER NOT NULL,
    hash TEXT    NOT NULL,
    PRIMARY KEY (day, hash)
  ) WITHOUT ROWID;
  `,
];

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function getCursor(db: DB, name: string): number | null {
  const row = db.prepare("SELECT block FROM cursors WHERE name = ?").get(name) as
    | { block: number }
    | undefined;
  return row?.block ?? null;
}

export function setCursor(db: DB, name: string, block: number, blockTs: number | null): void {
  db.prepare(
    `INSERT INTO cursors (name, block, block_ts, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET block = excluded.block, block_ts = excluded.block_ts, updated_at = excluded.updated_at`,
  ).run(name, block, blockTs, Math.floor(Date.now() / 1000));
}
