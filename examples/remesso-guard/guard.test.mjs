// node --test. Nothing here is paid and no transaction is sent: Assay is a stand-in, Remesso is
// either a stand-in with remesso-sdk's real shapes or the real SDK with no funded account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemesso, RemessoError } from "remesso-sdk";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RecipientBlockedError, withAssay } from "./guard.mjs";

const GOOD = "0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";
const BAD = "0x3d5ea1ce6f3fa5fae7a38b77f569570b3ea9a9a4";
const NEW = "0x1111111111111111111111111111111111111111";

const verdicts = () => ({
  [GOOD]: { verdict: "pass", rating: "A", organicShare: 1, reasons: ["Rated A"] },
  [BAD]: { verdict: "block", rating: "D", organicShare: 0.14, reasons: ["Early payments from wallets it funded"] },
  [NEW]: { verdict: "caution", rating: "NR", organicShare: null, reasons: ["Too little history"] },
});

/** A stand-in Assay client. `table` maps lowercase address -> result, or a function of the address. */
function stubAssay(table = verdicts(), { delay = 5 } = {}) {
  const calls = [];
  const answer = async (a) => {
    calls.push(a);
    await new Promise((r) => setTimeout(r, delay));
    const v = typeof table === "function" ? table(a) : table[a.toLowerCase()];
    return v;
  };
  return {
    calls,
    async check(a) {
      const v = await answer(a);
      return v && { ...v, attestation: { signature: `0x${"ab".repeat(65)}`, signer: "0xsigner" } };
    },
    async address(a) {
      return { check: await answer(a) };
    },
  };
}

/** A stand-in Remesso client with remesso-sdk 0.3.1's shapes. It records what would be paid. */
function stubRemesso() {
  const paid = [];
  const record = (via, x) => {
    paid.push({ via, ...x });
    return { status: "confirmed" };
  };
  const agents = {
    1: { wallet: GOOD, profile: {} }, 2: { wallet: BAD, profile: {} }, 3: { wallet: GOOD, profile: null }, 4: { wallet: null, profile: null },
    5: { wallet: GOOD, profile: { reference: { required: true } } },
  };
  const requests = {
    "r-good": { status: "pending", to: GOOD },
    "r-bad": { status: "pending", to: BAD },
    "r-paid": { status: "used", to: GOOD },
  };
  return {
    paid,
    address: "0xme",
    pay: async (input) => record("pay", { input }),
    remittances: { quote: async () => "quote", send: async (input) => record("send", { input }) },
    agents: {
      async find(id) {
        const a = agents[id];
        return { agentId: BigInt(id), wallet: a?.wallet ?? null, profile: a?.profile ?? null };
      },
      async pay(id, input) {
        const a = agents[id];
        if (!a?.wallet) throw new RemessoError("refused", "the receiving agent has no registered wallet");
        if (!a.profile) throw new RemessoError("refused", "the agent has no readable supported payment profile");
        return record("agents.pay", { id, input });
      },
    },
    requests: {
      async get(id) {
        const r = requests[id];
        if (!r) throw new RemessoError("not_found", "no such request");
        return { id, reference: id, status: r.status, payer: "0xme", requested: { to: r.to, amount: "1", token: "USAT", intervalSeconds: null, runs: null } };
      },
      async pay(id, opts) {
        const r = requests[id];
        if (!r) throw new RemessoError("not_found", "no such request");
        if (r.status === "used") throw new RemessoError("refused", `request ${id} is used`);
        return record("requests.pay", { id, opts });
      },
    },
    invoices: {
      async verify(invoice) {
        if (!invoice?.message?.recipient) throw new RemessoError("invalid", "bad invoice");
        const expiresAt = invoice.message.expiresAt ?? Math.floor(Date.now() / 1000) + 600;
        return { id: "0xinv", idempotencyKey: "invoice:0xinv", recipient: invoice.message.recipient, expiresAt, requestId: invoice.message.requestId || null };
      },
      async pay(invoice, opts) {
        if (!invoice?.message?.recipient) throw new RemessoError("invalid", "bad invoice"); // as the real SDK
        return record("invoices.pay", { invoice, opts });
      },
    },
    schedules: { create: async (input) => record("schedules.create", { input }) },
  };
}

const send = (to, extra = {}) => ({ to, amount: "1", token: "USAT", funding: "policy", idempotencyKey: "k", ...extra });

// ---------------------------------------------------------------- blocking and passing

test("a blocked recipient is never paid, on any guarded path", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await assert.rejects(g.pay(send(BAD)), RecipientBlockedError);
  await assert.rejects(g.remittances.send(send(BAD, { funding: "wallet" })), RecipientBlockedError);
  await assert.rejects(g.agents.pay(2, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a" }), RecipientBlockedError);
  await assert.rejects(g.requests.pay("r-bad"), RecipientBlockedError);
  await assert.rejects(g.invoices.pay({ message: { recipient: BAD } }, { funding: "policy" }), RecipientBlockedError);
  await assert.rejects(g.schedules.create({ to: BAD, amount: "1", token: "USAT", every: "week" }), RecipientBlockedError);
  await assert.rejects(g.schedules.create({ request: "r-bad" }), RecipientBlockedError);
  assert.equal(r.paid.length, 0);
});

test("RecipientBlockedError is a RemessoError with code refused, so Remesso's tools report it as a refusal", async () => {
  const g = withAssay(stubRemesso(), { assay: stubAssay() });
  const err = await g.pay(send(BAD)).catch((e) => e);
  assert.ok(err instanceof RemessoError);
  assert.equal(err.code, "refused");
  assert.equal(err.details.verdict, "block");
});

test("a passing recipient is paid with its input unchanged", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  const input = send(GOOD, { memo: "invoice 42" });
  await g.pay(input);
  await g.remittances.send({ ...input, funding: "wallet", memo: undefined });
  assert.deepEqual(r.paid[0].input, input);
  assert.equal(r.paid[1].input.memo, undefined);
  assert.equal(r.paid.length, 2);
});

test("unknown verdicts are refused, and missing reasons do not crash", async () => {
  for (const v of [{ verdict: "BLOCK", rating: "A" }, { verdict: "bogus", rating: "A" }, { verdict: "block", rating: "D" }]) {
    const g = withAssay(stubRemesso(), { assay: stubAssay(() => v) });
    const err = await g.pay(send(GOOD)).catch((e) => e);
    assert.ok(err instanceof RecipientBlockedError, JSON.stringify(v));
  }
});

test("minRating, and allowUnrated defaulting to false once a floor is set", async () => {
  const floor = withAssay(stubRemesso(), { assay: stubAssay(), minRating: "AA" });
  await assert.rejects(floor.pay(send(GOOD)), RecipientBlockedError); // A < AA
  await assert.rejects(floor.pay(send(NEW)), RecipientBlockedError); // NR, floor set
  const open = withAssay(stubRemesso(), { assay: stubAssay() });
  await open.pay(send(NEW)); // NR allowed by default without a floor
  const both = withAssay(stubRemesso(), { assay: stubAssay(), minRating: "A", allowUnrated: true });
  await both.pay(send(NEW));
  await both.pay(send(GOOD));
});

// ---------------------------------------------------------------- Remesso refuses first, no check bought

test("invoices Remesso cannot start (expired, wallet without request) go to Remesso unchecked", async () => {
  const assay = stubAssay();
  const r = stubRemesso();
  const g = withAssay(r, { assay });
  await g.invoices.pay({ message: { recipient: BAD, expiresAt: 1 } }, { funding: "policy" }); // expired: Remesso reports or refuses
  await g.invoices.pay({ message: { recipient: BAD } }, { funding: "wallet" }); // wallet + no request: Remesso refuses
  assert.equal(assay.calls.length, 0);
});

test("a lookup that fails is thrown, never passed on unchecked", async () => {
  const assay = stubAssay();
  const r = stubRemesso();
  r.agents.find = async () => { throw new RemessoError("http", "rpc blip"); };
  r.requests.get = async () => { throw new RemessoError("http", "backend blip"); };
  r.invoices.verify = async () => { throw new RemessoError("http", "rpc blip"); };
  const g = withAssay(r, { assay });
  await assert.rejects(g.agents.pay(1, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a" }), /rpc blip/);
  await assert.rejects(g.requests.pay("r-good"), /backend blip/);
  await assert.rejects(g.schedules.create({ request: "r-good" }), /backend blip/);
  await assert.rejects(g.invoices.pay({ message: { recipient: GOOD } }, { funding: "policy" }), /rpc blip/);
  assert.equal(r.paid.length, 0);
});

test("input Remesso refuses anyway goes to Remesso unchecked", async () => {
  const assay = stubAssay();
  const r = stubRemesso();
  const g = withAssay(r, { assay });
  await assert.rejects(g.agents.pay(4, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a" }), /no registered wallet/);
  await assert.rejects(g.agents.pay(3, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a" }), /payment profile/);
  await assert.rejects(g.agents.pay(5, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a" }), /requires a payment request reference/);
  await assert.rejects(g.requests.pay("r-paid"), /is used/);
  await assert.rejects(g.requests.pay("r-missing"), /no such request/);
  await assert.rejects(g.invoices.pay({ message: {} }, { funding: "wallet" }), /bad invoice/);
  assert.equal(assay.calls.length, 0);
  assert.equal(r.paid.length, 0);
});

test("agents.pay: always pins the checked wallet, and refuses a different expectedWallet", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.agents.pay(1, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a1" });
  assert.equal(r.paid[0].input.expectedWallet, getAddress(GOOD));
  await g.agents.pay(1, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a2", expectedWallet: GOOD.toUpperCase().replace("0X", "0x") });
  assert.equal(r.paid[1].input.expectedWallet, getAddress(GOOD));
  const err = await g.agents.pay(1, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "a3", expectedWallet: NEW }).catch((e) => e);
  assert.ok(err instanceof RemessoError);
  assert.equal(err.code, "conflict");
  assert.equal(r.paid.length, 2);
});

test("pass 2, F1: a falsy expectedWallet (null, empty, 0, false) is checked and pinned, never skipped", async () => {
  for (const expectedWallet of [null, "", 0, false]) {
    const assay = stubAssay();
    const r = stubRemesso();
    const g = withAssay(r, { assay });
    await assert.rejects(g.agents.pay(2, { funding: "policy", amount: "5", token: "USAT", idempotencyKey: "k", expectedWallet }), RecipientBlockedError);
    await g.agents.pay(1, { funding: "policy", amount: "5", token: "USAT", idempotencyKey: "k", expectedWallet });
    assert.equal(r.paid.length, 1, String(expectedWallet));
    assert.equal(r.paid[0].input.expectedWallet, getAddress(GOOD));
    assert.equal(assay.calls.length, 2);
  }
});

test("pass 2, F2: an address given as a String object is checked like a string", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await assert.rejects(g.pay(send(new String(BAD))), RecipientBlockedError);
  await assert.rejects(g.remittances.send(send(new String(BAD))), RecipientBlockedError);
  await assert.rejects(g.schedules.create({ to: new String(BAD), amount: "1", token: "USAT", every: "week" }), RecipientBlockedError);
  await assert.rejects(g.agents.pay(1, { funding: "wallet", amount: "1", token: "USAT", idempotencyKey: "k", expectedWallet: new String(NEW) }), (e) => e.code === "conflict");
  assert.equal(r.paid.length, 0);
});

test("pass 2, F4: a payment that stops waiting keeps the Assay call; a retry reuses it, no second check bought", async () => {
  let resolve;
  let calls = 0;
  const slow = { check: () => { calls++; return new Promise((r) => { resolve = r; }); } };
  const r = stubRemesso();
  const g = withAssay(r, { assay: slow, timeoutMs: 20 });
  await assert.rejects(g.pay(send(GOOD)), (e) => e.code === "timeout");
  await assert.rejects(g.pay(send(GOOD)), (e) => e.code === "timeout"); // retry while the first call runs
  assert.equal(calls, 1);
  resolve({ verdict: "pass", rating: "A", reasons: [] }); // the late answer fills the cache
  await new Promise((r2) => setTimeout(r2, 5));
  await g.pay(send(GOOD));
  assert.equal(calls, 1);
  assert.equal(r.paid.length, 1);
});

test("pass 2, L1: a schedule answering a request pins the request's address even when to is empty, and refuses another to", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.schedules.create({ request: "r-good", to: "" });
  assert.equal(r.paid[0].input.to, getAddress(GOOD));
  await assert.rejects(g.schedules.create({ request: "r-good", to: NEW }), (e) => e.code === "refused");
  assert.equal(r.paid.length, 1);
});

test("remittances.send that Remesso refuses on its input (no funding, no key) buys no check", async () => {
  const assay = stubAssay();
  const r = stubRemesso();
  r.remittances.send = async (input) => {
    if (!["policy", "wallet"].includes(input?.funding)) throw new RemessoError("invalid", "choose funding");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) throw new RemessoError("invalid", "key");
    return { status: "confirmed" };
  };
  const g = withAssay(r, { assay });
  await assert.rejects(g.remittances.send({ to: GOOD, amount: "1", token: "USAT" }), (e) => e.code === "invalid");
  await assert.rejects(g.remittances.send({ to: GOOD, amount: "1", token: "USAT", funding: "wallet", idempotencyKey: " " }), (e) => e.code === "invalid");
  assert.equal(assay.calls.length, 0);
});

test("schedules.create answering a request checks requested.to and pins it as to", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  await g.schedules.create({ request: "r-good" });
  assert.equal(r.paid[0].input.to, getAddress(GOOD));
  assert.equal(r.paid[0].input.request, "r-good");
});

test("every call is checked, retries included (no per-key state)", async () => {
  let verdict = "pass";
  const assay = stubAssay(() => ({ verdict, rating: "A", reasons: [] }));
  const r = stubRemesso();
  const g = withAssay(r, { assay, cacheMs: 0 });
  await g.pay(send(GOOD, { idempotencyKey: "same" }));
  verdict = "block";
  await assert.rejects(g.pay(send(GOOD, { idempotencyKey: "same" })), RecipientBlockedError);
  assert.equal(assay.calls.length, 2);
  assert.equal(r.paid.length, 1);
});

// ---------------------------------------------------------------- Assay failures

test("an unreachable Assay blocks by default, and can be set to allow", async () => {
  const down = { check: async () => { throw new Error("ECONNREFUSED"); } };
  const r = stubRemesso();
  const err = await withAssay(r, { assay: down }).pay(send(GOOD)).catch((e) => e);
  assert.ok(err instanceof RemessoError);
  assert.equal(err.code, "http");
  await withAssay(r, { assay: down, onAssayError: "allow" }).pay(send(GOOD));
  assert.equal(r.paid.length, 1);
});

test("a hung Assay times out instead of hanging the payment", async () => {
  const hung = { check: () => new Promise(() => {}) };
  const t0 = Date.now();
  const err = await withAssay(stubRemesso(), { assay: hung, timeoutMs: 50 }).pay(send(GOOD)).catch((e) => e);
  assert.equal(err.code, "timeout");
  assert.ok(Date.now() - t0 < 2000);
});

test("paid mode without a paying client refuses loudly instead of falling back", async () => {
  const noPay = { check: async () => { const e = new Error("check() needs an x402 payingFetch"); e.code = "no_paying_fetch"; throw e; } };
  await assert.rejects(withAssay(stubRemesso(), { assay: noPay }).pay(send(GOOD)), TypeError);
  const free = stubAssay();
  await withAssay(stubRemesso(), { assay: free, paid: false }).pay(send(GOOD)); // explicit free mode
});

test("a throwing onDecision decides nothing", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay(), onDecision: () => { throw new Error("logger down"); } });
  await g.pay(send(GOOD));
  await assert.rejects(g.pay(send(BAD)), RecipientBlockedError);
  assert.equal(r.paid.length, 1);
});

// ---------------------------------------------------------------- cache

test("concurrent checks of one address share one call; failures are not cached", async () => {
  const assay = stubAssay();
  const g = withAssay(stubRemesso(), { assay });
  await Promise.all([1, 2, 3].map(() => g.pay(send(GOOD))));
  await g.pay(send(GOOD.toUpperCase().replace("0X", "0x")));
  assert.equal(assay.calls.length, 1);
  let n = 0;
  const flaky = { check: async () => { if (n++ === 0) throw new Error("blip"); return { verdict: "pass", rating: "A", reasons: [] }; } };
  const g2 = withAssay(stubRemesso(), { assay: flaky });
  await assert.rejects(g2.pay(send(GOOD)));
  await g2.pay(send(GOOD));
});

test("the cache is bounded", async () => {
  const assay = stubAssay(() => ({ verdict: "pass", rating: "A", reasons: [] }), { delay: 0 });
  const g = withAssay(stubRemesso(), { assay, maxCached: 2 });
  const a = (i) => `0x${String(i).padStart(40, "0")}`;
  for (const i of [1, 2, 3]) await g.pay(send(a(i)));
  await g.pay(send(a(1))); // evicted, so checked again
  assert.equal(assay.calls.length, 4);
});

test("bad options are refused at setup", () => {
  const assay = stubAssay();
  assert.throws(() => withAssay(stubRemesso(), { assay, minRating: "AAAA" }), /unknown minRating/);
  assert.throws(() => withAssay(stubRemesso(), { assay, cacheMs: Infinity }), /cacheMs/);
  assert.throws(() => withAssay(stubRemesso(), { assay, timeoutMs: -1 }), /timeoutMs/);
  assert.throws(() => withAssay(stubRemesso(), { assay, onAssayError: "maybe" }), /onAssayError/);
  assert.throws(() => withAssay(stubRemesso(), {}), /assay/);
});

test("everything that pays nobody is the client's own", async () => {
  const r = stubRemesso();
  const g = withAssay(r, { assay: stubAssay() });
  assert.equal(await g.remittances.quote(), "quote");
  assert.equal(g.address, "0xme");
  assert.equal(g.requests.get, r.requests.get);
});

// ---------------------------------------------------------------- the real remesso-sdk

const noChain = {
  readContract: async ({ functionName }) => {
    if (functionName === "getAgentWallet") return "0x0000000000000000000000000000000000000000";
    throw new Error("no registration");
  },
};
const errOf = async (fn) => fn().then(() => null, (e) => e);

test("real SDK: an invalid address gets Remesso's own error and buys no check", async () => {
  const assay = stubAssay();
  const g = withAssay(createRemesso(), { assay });
  const err = await errOf(() => g.remittances.send(send("0x1234")));
  assert.ok(err instanceof RemessoError, String(err));
  assert.equal(err.code, "invalid");
  assert.equal(assay.calls.length, 0);
});

test("real SDK: a wallet payment to a cleared address reaches Remesso unchanged", async () => {
  const g = withAssay(createRemesso(), { assay: stubAssay() });
  const err = await errOf(() => g.remittances.send(send(GOOD, { funding: "wallet", token: "USDT" })));
  assert.ok(err instanceof RemessoError);
  assert.doesNotMatch(err.message, /memo/);
  assert.equal(err.code, "no_account"); // stopped only because this client has no signer
});

test("real SDK: an agent with no wallet gets Remesso's own refusal, no check", async () => {
  const assay = stubAssay();
  const g = withAssay(createRemesso({ publicClient: noChain }), { assay });
  const err = await errOf(() => g.agents.pay(123, { funding: "wallet", amount: "1", token: "USDT", idempotencyKey: "x" }));
  assert.ok(err instanceof RemessoError, String(err));
  assert.match(err.message, /no registered wallet/);
  assert.equal(assay.calls.length, 0);
});

test("real SDK: invoices are verified by Remesso before any check", async () => {
  // Remesso requires the recipient to sign its own invoice, so each recipient is a throwaway
  // key here (never funded, nothing is sent). Assay blocks one and clears the other.
  const okRecipient = privateKeyToAccount(generatePrivateKey());
  const badRecipient = privateKeyToAccount(generatePrivateKey());
  const payer = privateKeyToAccount(generatePrivateKey());
  const sign = (account) =>
    createRemesso({ account }).invoices.sign({
      payer: payer.address, amount: "1", token: "USDT", orderId: "o-1", expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
  const good = await sign(okRecipient);
  const bad = await sign(badRecipient);
  const assay = stubAssay((a) =>
    a.toLowerCase() === badRecipient.address.toLowerCase()
      ? { verdict: "block", rating: "D", reasons: ["test"] }
      : { verdict: "pass", rating: "A", reasons: [] });
  const g = withAssay(createRemesso(), { assay });

  assert.ok((await errOf(() => g.invoices.pay(bad, { funding: "policy" }))) instanceof RecipientBlockedError);
  const passed = await errOf(() => g.invoices.pay(good, { funding: "policy" }));
  assert.ok(passed instanceof RemessoError && !(passed instanceof RecipientBlockedError), String(passed)); // Remesso's own: no signer

  const tampered = { ...good, message: { ...good.message, amount: "999000000" } }; // signature no longer matches
  const before = assay.calls.length;
  const err = await errOf(() => g.invoices.pay(tampered, { funding: "policy" }));
  assert.ok(err instanceof RemessoError && !(err instanceof RecipientBlockedError), String(err));
  assert.equal(assay.calls.length, before); // refused by Remesso, no check bought
});
