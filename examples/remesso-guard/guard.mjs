// withAssay: the same Remesso client, but every payment checks its recipient with Assay first.
//
//   const remesso = withAssay(createRemesso({ account }), { assay: createAssay({ payingFetch }) });
//   await remesso.agents.pay(agentId, { ... });   // throws RecipientBlockedError for a wash seller
//
// - Guarded: pay, remittances.send, agents.pay, requests.pay, invoices.pay and schedules.create.
//   Everything else is untouched. A schedule is checked once, when it is created.
// - agents.pay resolves the agent's wallet, checks it, and passes it as `expectedWallet`, so the
//   payment fails if the agent's wallet changes between the check and the payment.
// - With a paying Assay client, each check is a paid x402 call ($0.002, in USA₮ if you prefer it)
//   that returns an EIP-712 score signed by Assay. onDecision receives it with the payment's
//   idempotencyKey, so you can store the proof next to the payment record.
// - The payment itself is never changed, unless you opt in with `memo: true`: then a policy
//   payment that has no memo and answers no request carries "assay pass A". Wallet payments and
//   request payments are left alone, because Remesso refuses a memo on those. A key keeps the
//   memo it was first sent with, so a retry under the same idempotencyKey matches it.
// - Verdicts are cached (10 minutes by default), and checks for the same address share one request.

const RATINGS = ["D", "CCC", "B", "BB", "BBB", "A", "AA", "AAA"];

export class RecipientBlockedError extends Error {
  constructor(address, result) {
    super(`Assay ${result.verdict === "block" ? "blocked" : "did not clear"} ${address}: ${result.reasons.join("; ")}`);
    this.name = "RecipientBlockedError";
    this.address = address;
    this.result = result;
  }
}

/**
 * @param {object} remesso  a client from createRemesso
 * @param {object} opts
 * @param {object} opts.assay          a client from createAssay (give it payingFetch for signed, paid checks)
 * @param {boolean} [opts.paid]        use the paid check; default true (falls back to the free one without payingFetch)
 * @param {string} [opts.minRating]    lowest rating to pay, e.g. "BB"; default: only "block" stops a payment
 * @param {boolean} [opts.allowUnrated] pay addresses with too little history to rate (NR); default true
 * @param {number} [opts.cacheMs]      default 10 minutes
 * @param {"allow"|"block"} [opts.onAssayError] when Assay cannot be reached; default "block"
 * @param {boolean} [opts.memo]        tag eligible policy payments with "assay <verdict> <rating>"; default false
 * @param {(d: object) => void} [opts.onDecision] every decision, with Assay's result and the idempotencyKey
 */
export function withAssay(remesso, opts) {
  const { assay, minRating, allowUnrated = true, cacheMs = 10 * 60_000, onAssayError = "block", onDecision } = opts;
  const paid = opts.paid ?? true;
  const cache = new Map(); // address -> { at, result }
  const inflight = new Map(); // address -> Promise
  const memoByKey = new Map(); // idempotencyKey -> the memo it was first sent with

  async function lookup(address) {
    if (paid) {
      try {
        return await assay.check(address); // verdict + signed score
      } catch (err) {
        if (err?.code !== "no_paying_fetch") throw err;
      }
    }
    return { ...(await assay.address(address)).check, attestation: null };
  }

  /** Check an address once per cacheMs, sharing concurrent requests. */
  async function check(address) {
    const key = address.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.result;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        lookup(address)
          .then((result) => {
            cache.set(key, { at: Date.now(), result });
            return result;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  }

  function allowed(r) {
    if (r.verdict === "block") return false;
    if (r.rating === "NR") return allowUnrated;
    if (minRating && RATINGS.indexOf(r.rating) < RATINGS.indexOf(minRating)) return false;
    return true;
  }

  async function guard(address, via, idempotencyKey) {
    let result;
    try {
      result = await check(address);
    } catch (err) {
      onDecision?.({ address, via, idempotencyKey, ok: onAssayError === "allow", error: String(err?.message ?? err) });
      if (onAssayError === "allow") return null;
      throw err;
    }
    const ok = allowed(result);
    onDecision?.({ address, via, idempotencyKey, ok, result });
    if (!ok) throw new RecipientBlockedError(address, result);
    return result;
  }

  /** Remesso takes a memo only on a policy payment that answers no request. */
  function withMemo(input, r, policy) {
    if (!opts.memo || !r || !policy || input.requestId || input.memo !== undefined) return input;
    const key = input.idempotencyKey;
    const memo = (key && memoByKey.get(key)) ?? `assay ${r.verdict} ${r.rating}`;
    if (key) memoByKey.set(key, memo);
    return { ...input, memo };
  }

  const guarded = { ...remesso };
  if (remesso.pay) {
    guarded.pay = async (input) => {
      const r = await guard(input.to, "pay", input.idempotencyKey);
      return remesso.pay(withMemo(input, r, true));
    };
  }
  if (remesso.remittances) {
    guarded.remittances = {
      ...remesso.remittances,
      async send(input) {
        const r = await guard(input.to, "remittances.send", input.idempotencyKey);
        return remesso.remittances.send(withMemo(input, r, input.funding === "policy"));
      },
    };
  }
  if (remesso.agents) {
    guarded.agents = {
      ...remesso.agents,
      async pay(agentId, input) {
        const { wallet } = await remesso.agents.find(agentId);
        if (!wallet) throw new Error(`agent ${agentId} has no wallet to pay`);
        await guard(wallet, `agents.pay #${agentId}`, input.idempotencyKey);
        return remesso.agents.pay(agentId, { ...input, expectedWallet: wallet });
      },
    };
  }
  if (remesso.requests) {
    guarded.requests = {
      ...remesso.requests,
      async pay(id, payOpts) {
        const request = await remesso.requests.get(id);
        await guard(request.to, `requests.pay ${id}`, payOpts?.idempotencyKey);
        return remesso.requests.pay(id, payOpts);
      },
    };
  }
  if (remesso.invoices) {
    guarded.invoices = {
      ...remesso.invoices,
      async pay(invoice, payOpts) {
        // Remesso verifies the invoice's signature itself; the recipient it pays is the signed one.
        await guard(invoice.message.recipient, `invoices.pay ${invoice.message.orderId}`);
        return remesso.invoices.pay(invoice, payOpts);
      },
    };
  }
  if (remesso.schedules) {
    guarded.schedules = {
      ...remesso.schedules,
      async create(input) {
        await guard(input.to, "schedules.create");
        return remesso.schedules.create(input);
      },
    };
  }
  /** The check on its own, e.g. to show a verdict before the user confirms a payment. */
  guarded.assay = { check, allowed };
  return guarded;
}
