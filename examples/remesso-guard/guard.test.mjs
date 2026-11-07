// node --test: the wrapper's behaviour, with stand-ins for Remesso and Assay. Nothing is paid.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memo32 } from "remesso-sdk";
import { RecipientBlockedError, withAssay } from "./guard.mjs";

const GOOD = "0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";
const BAD = "0x3d5ea1ce6f3fa5fae7a38b77f569570b3ea9a9a4";
const NEW = "0x1111111111111111111111111111111111111111";

const verdicts = {
  [GOOD]: { verdict: "pass", rating: "A", organicShare: 1, reasons: ["Rated A"] },
  [BAD]: { verdict: "block", rating: "D", organicShare: 0.14, reasons: ["Early payments from wallets it funded"] },
  [NEW]: { verdict: "caution", rating: "NR", organicShare: null, reasons: ["Too little history"] },
};

function stubAssay() {
  const calls = [];
  return {
    calls,
    async check(a) {
      calls.push(a);
      await new Promise((r) => setTimeout(r, 10));
      return { ...verdicts[a.toLowerCase()], attestation: { signature: `0x${"ab".repeat(65)}`, signer: "0xsigner" } };
    },
    async address(a) {
      return { check: verdicts[a.toLowerCase()] };
    },
  };
}

function stubRemesso() {
  const paid = [];
  const agentsById = { 1: GOOD, 2: BAD };
  return {
    paid,
    address: "0xme",
    async pay(input) {
      paid.push({ via: "pay", input });
      return { status: "confirmed" };
    },
    remittances: {
      quote: async () => "quote",
      async send(input) {
        paid.push({ via: "send", input });
        return { status: "confirmed" };
      },
    },
    agents: {
      async find(id) {
        return { agentId: BigInt(id), wallet: agentsById[id] ?? null };
      },
      async pay(id, input) {
        paid.push({ via: "agents.pay", id, input });
        return { status: "confirmed" };
      },
    },
    requests: {
      async get(id) {
        return { id, to: id === "r-bad" ? BAD : GOOD };
      },
      async pay(id) {
        paid.push({ via: "requests.pay", id });
        return { status: "confirmed" };
      },
    },
  };
}

test("a blocked recipient is never paid, on any path", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await assert.rejects(g.pay({ to: BAD, amount: "1", idempotencyKey: "a" }), RecipientBlockedError);
  await assert.rejects(g.remittances.send({ to: BAD, amount: "1", token: "USAT", funding: "wallet", idempotencyKey: "b" }), RecipientBlockedError);
  await assert.rejects(g.agents.pay(2, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "c" }), RecipientBlockedError);
  await assert.rejects(g.requests.pay("r-bad"), RecipientBlockedError);
  assert.equal(r.paid.length, 0);
});

test("a passing recipient is paid, and the memo links the payment to the signed check", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.remittances.send({ to: GOOD, amount: "1", token: "USAT", funding: "wallet", idempotencyKey: "d" });
  const memo = r.paid[0].input.memo;
  assert.match(memo, /^assay pass A [0-9a-f]{8}$/);
  assert.doesNotThrow(() => memo32(memo)); // fits Remesso's 32-byte onchain memo
});

test("the caller's own memo is kept", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.pay({ to: GOOD, amount: "1", idempotencyKey: "e", memo: "invoice 42" });
  assert.equal(r.paid[0].input.memo, "invoice 42");
});

test("agents.pay pins the wallet it checked", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.agents.pay(1, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "f" });
  assert.equal(r.paid[0].input.expectedWallet, GOOD);
});

test("concurrent and repeated checks of one address cost one call", async () => {
  const assay = stubAssay();
  const g = withAssay(stubRemesso(), { assay });
  await Promise.all([1, 2, 3].map((i) => g.pay({ to: GOOD, amount: "1", idempotencyKey: `g${i}` })));
  await g.pay({ to: GOOD.toUpperCase().replace("0X", "0x"), amount: "1", idempotencyKey: "g4" });
  assert.equal(assay.calls.length, 1);
});

test("minRating and allowUnrated", async () => {
  const strict = withAssay(stubRemesso(), { assay: stubAssay(), minRating: "AA", allowUnrated: false });
  await assert.rejects(strict.pay({ to: GOOD, amount: "1", idempotencyKey: "h" }), RecipientBlockedError);
  await assert.rejects(strict.pay({ to: NEW, amount: "1", idempotencyKey: "i" }), RecipientBlockedError);
  const open = withAssay(stubRemesso(), { assay: stubAssay() });
  await open.pay({ to: NEW, amount: "1", idempotencyKey: "j" });
});

test("when Assay is unreachable the default is to not pay", async () => {
  const down = { check: async () => { throw new Error("ECONNREFUSED"); } };
  const r = stubRemesso();
  await assert.rejects(withAssay(r, { assay: down }).pay({ to: GOOD, amount: "1", idempotencyKey: "k" }), /ECONNREFUSED/);
  await withAssay(r, { assay: down, onAssayError: "allow" }).pay({ to: GOOD, amount: "1", idempotencyKey: "l" });
  assert.equal(r.paid.length, 1);
});

test("everything Remesso has that pays nobody is untouched", async () => {
  const g = withAssay(stubRemesso(), { assay: stubAssay() });
  assert.equal(await g.remittances.quote(), "quote");
  assert.equal(g.address, "0xme");
});
