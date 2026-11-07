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
    invoices: {
      verify: async () => "verified",
      async pay(invoice) {
        paid.push({ via: "invoices.pay", invoice });
        return { status: "confirmed" };
      },
    },
    schedules: {
      async create(input) {
        paid.push({ via: "schedules.create", input });
        return { id: 1n };
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
  await assert.rejects(g.invoices.pay({ message: { recipient: BAD, orderId: "o1" } }, { funding: "wallet" }), RecipientBlockedError);
  await assert.rejects(g.schedules.create({ to: BAD, amount: "1", token: "USAT", every: "week" }), RecipientBlockedError);
  assert.equal(r.paid.length, 0);
});

test("by default the payment is passed through unchanged", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  const input = { to: GOOD, amount: "1", token: "USAT", funding: "policy", idempotencyKey: "d" };
  await g.remittances.send(input);
  assert.deepEqual(r.paid[0].input, input);
});

test("memo: true tags only policy payments that answer no request, and fits 32 bytes", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay(), memo: true });
  await g.remittances.send({ to: GOOD, amount: "1", token: "USAT", funding: "policy", idempotencyKey: "d1" });
  await g.remittances.send({ to: GOOD, amount: "1", token: "USAT", funding: "wallet", idempotencyKey: "d2" });
  await g.remittances.send({ to: GOOD, amount: "1", token: "USAT", funding: "policy", requestId: "q", idempotencyKey: "d3" });
  await g.pay({ to: GOOD, amount: "1", idempotencyKey: "d4" });
  assert.equal(r.paid[0].input.memo, "assay pass A");
  assert.equal("memo" in r.paid[1].input, false);
  assert.equal("memo" in r.paid[2].input, false);
  assert.equal(r.paid[3].input.memo, "assay pass A");
  assert.doesNotThrow(() => memo32("assay caution CCC")); // the longest one
});

test("a retry under the same key carries the same memo, even after a fresh check", async () => {
  const r = stubRemesso();
  const assay = stubAssay();
  const g = withAssay(r, { assay, memo: true, cacheMs: 0 });
  const input = { to: GOOD, amount: "1", idempotencyKey: "retry" };
  await g.pay(input);
  verdicts[GOOD].rating = "AA"; // the rating moved between the attempt and its retry
  try {
    await g.pay(input);
  } finally {
    verdicts[GOOD].rating = "A";
  }
  assert.equal(assay.calls.length, 2);
  assert.equal(r.paid[0].input.memo, r.paid[1].input.memo);
});

test("onDecision gets the signed score with the payment's idempotencyKey", async () => {
  const seen = [];
  const g = withAssay(stubRemesso(), { assay: stubAssay(), onDecision: (d) => seen.push(d) });
  await g.pay({ to: GOOD, amount: "1", idempotencyKey: "proof" });
  assert.equal(seen[0].idempotencyKey, "proof");
  assert.match(seen[0].result.attestation.signature, /^0x/);
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

test("invoices and schedules are paid once they pass", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.invoices.pay({ message: { recipient: GOOD, orderId: "o2" } }, { funding: "wallet" });
  await g.schedules.create({ to: GOOD, amount: "1", token: "USAT", every: "week" });
  assert.deepEqual(r.paid.map((p) => p.via), ["invoices.pay", "schedules.create"]);
});

test("everything Remesso has that pays nobody is untouched", async () => {
  const g = withAssay(stubRemesso(), { assay: stubAssay() });
  assert.equal(await g.remittances.quote(), "quote");
  assert.equal(await g.invoices.verify(), "verified");
  assert.equal(g.address, "0xme");
});

// Against the real remesso-sdk: it must get past Remesso's own memo rules. With no account the
// SDK stops later (it has nobody to sign with), which shows the wrapper's input was accepted.
import { createRemesso } from "remesso-sdk";

async function sdkError(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

test("real SDK: wallet and request payments are not refused for a memo", async () => {
  for (const memo of [false, true]) {
    const g = withAssay(createRemesso(), { assay: stubAssay(), memo });
    const wallet = await sdkError(() =>
      g.remittances.send({ to: GOOD, amount: "1", token: "USDT", funding: "wallet", idempotencyKey: "w1" }));
    const request = await sdkError(() =>
      g.remittances.send({ to: GOOD, amount: "1", token: "USDT", funding: "policy", requestId: "00000000-0000-4000-8000-000000000000", idempotencyKey: "w2" }));
    for (const err of [wallet, request]) {
      assert.ok(err, "the SDK should stop without an account");
      assert.doesNotMatch(err.message, /memo/, `memo=${memo}: ${err.message}`);
    }
  }
});
