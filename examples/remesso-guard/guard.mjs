// withAssay: the same Remesso client, but each new payment checks its recipient with Assay first.
//
//   const remesso = withAssay(createRemesso({ account, fetchText }), { assay: createAssay({ payingFetch }) });
//   await remesso.agents.pay(agentId, { ... });   // throws RecipientBlockedError for a wash seller
//
// What is checked, and the address checked:
//   pay, remittances.send   input.to
//   agents.pay              the agent's registered wallet (pinned as expectedWallet)
//   requests.pay            the request's requested.to
//   invoices.pay            the invoice's recipient, once Remesso has verified the invoice
//   schedules.create        input.to, or the answered request's requested.to (pinned as to)
// What is NOT checked: later runs of a schedule, schedules.setActive / setTrigger,
// remittances.reconcile / recoverPending, and anything paid by another client or agent through
// a policy. Those only finish or repeat payments to recipients fixed earlier.
//
// Rules this wrapper keeps:
// 1. Every payment that can move money is checked against the address Remesso will pay. An
//    address is read the way Remesso reads it (viem's getAddress, a peer dependency the two
//    share), so the wrapper and Remesso never disagree about what an input names.
// 2. It changes no payment term. It only pins the address it checked: expectedWallet on
//    agents.pay, and `to` on schedules.create answering a request.
// 3. It refuses with RemessoError: RecipientBlockedError (code "refused") when Assay does not
//    clear the address, "http" or "timeout" when Assay cannot answer (unless onAssayError: "allow").
// 4. Unchecked, a call goes to Remesso only when Remesso refuses it from the input alone, by the
//    same test Remesso applies (no funding, no key, an address getAddress rejects, an invoice
//    long expired). Common refusals that depend on what was read (no wallet, no profile, a
//    required reference, a request that can't be paid) are thrown here with Remesso's own code,
//    before a check is bought. A failed read is thrown, never passed on. Other refusals Remesso
//    makes later (no account, over the policy's caps, no balance) come after the check, so that
//    check is still paid for.
// 5. It keeps no state per idempotency key: retries are checked too. Resume a payment that already
//    started with the unwrapped client (e.g. remittances.reconcile); it can only finish what was
//    checked when it began. A refusal here never means an earlier attempt was unpaid.
import { RemessoError } from "remesso-sdk";
import { getAddress } from "viem";

const RATINGS = ["D", "CCC", "B", "BB", "BBB", "A", "AA", "AAA"];
const CLEARS = new Set(["pass", "caution"]); // verdicts that may be paid; anything else is refused
const FUNDING = ["wallet", "policy"];
const EXPIRED_MARGIN_S = 120; // this long past expiry, an invoice is expired by Remesso's clock too
const now = () => performance.now(); // monotonic: a clock change cannot extend a cached verdict

/** The address Remesso will read from x (its checksum() is getAddress), or null if it rejects x. */
function addressOf(x) {
  try {
    return getAddress(x);
  } catch {
    return null;
  }
}

export class RecipientBlockedError extends RemessoError {
  constructor(address, result) {
    const reasons = Array.isArray(result?.reasons) ? result.reasons : [];
    super("refused", `Assay ${result?.verdict === "block" ? "blocked" : "did not clear"} ${address}${reasons.length ? `: ${reasons.join("; ")}` : ""}`, {
      address,
      verdict: result?.verdict,
      rating: result?.rating,
    });
    this.name = "RecipientBlockedError";
    this.address = address;
    this.result = result;
  }
}

/**
 * @param {object} remesso  a client from createRemesso (pass fetchText from remesso-sdk/node so
 *        agents with remote registration files can be paid at all)
 * @param {object} opts
 * @param {object} opts.assay          a client from createAssay
 * @param {boolean} [opts.paid]        true (default): the paid check, $0.002 over x402 with a score
 *        signed by Assay; needs createAssay({ payingFetch }), and refuses to run without it.
 *        false: the free check, the same verdict without a signature.
 * @param {string} [opts.minRating]    lowest rating to pay, e.g. "BB"; default: only "block" stops a payment
 * @param {boolean} [opts.allowUnrated] pay addresses too new to rate (NR). Default true, or false
 *        when minRating is set. A personal wallet with no x402 revenue is always NR.
 * @param {number} [opts.cacheMs]      reuse a verdict for this long; default 10 minutes, 0 = never
 * @param {number} [opts.maxCached]    addresses kept in the cache; default 5000
 * @param {number} [opts.timeoutMs]    how long a payment waits for Assay; default 15000
 * @param {"allow"|"block"} [opts.onAssayError] when Assay cannot answer; default "block"
 * @param {(d: object) => void} [opts.onDecision] every decision (errors thrown here are ignored)
 */
export function withAssay(remesso, opts) {
  const { assay, minRating, onDecision } = opts ?? {};
  const paid = opts?.paid ?? true;
  const allowUnrated = opts?.allowUnrated ?? minRating === undefined;
  const cacheMs = opts?.cacheMs ?? 10 * 60_000;
  const maxCached = opts?.maxCached ?? 5000;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const onAssayError = opts?.onAssayError ?? "block";
  if (!assay) throw new TypeError("withAssay needs { assay: createAssay(...) }");
  if (minRating !== undefined && !RATINGS.includes(minRating)) throw new TypeError(`unknown minRating ${minRating}`);
  for (const [k, v] of Object.entries({ cacheMs, maxCached, timeoutMs })) {
    if (!Number.isFinite(v) || v < 0) throw new TypeError(`${k} must be a finite number >= 0`);
  }
  if (!["allow", "block"].includes(onAssayError)) throw new TypeError('onAssayError must be "allow" or "block"');

  const cache = new Map(); // lowercase address -> { at, result }, oldest first
  const inflight = new Map(); // lowercase address -> the one Assay call for it, until it settles

  const report = (d) => {
    try {
      onDecision?.(d);
    } catch {
      // a logging callback must not decide a payment
    }
  };

  async function lookup(address) {
    if (paid) return assay.check(address); // throws AssayError no_paying_fetch if it cannot pay
    return { ...(await assay.address(address)).check, attestation: null };
  }

  /**
   * One Assay call per address at a time, kept until it settles even if a payment stops waiting,
   * so a late answer still fills the cache and a retry never buys a second check for it.
   */
  function call(address) {
    const key = address.toLowerCase();
    if (!inflight.has(key)) {
      const p = Promise.resolve()
        .then(() => lookup(address))
        .then((result) => {
          if (!result || typeof result.verdict !== "string" || typeof result.rating !== "string") {
            throw new RemessoError("http", `Assay returned no verdict for ${address}`);
          }
          if (cacheMs > 0 && maxCached > 0) {
            cache.delete(key);
            cache.set(key, { at: now(), result });
            while (cache.size > maxCached) cache.delete(cache.keys().next().value);
          }
          return result;
        })
        .finally(() => inflight.delete(key));
      p.catch(() => {}); // a caller that stopped waiting must not leave an unhandled rejection
      inflight.set(key, p);
    }
    return inflight.get(key);
  }

  /** The verdict for an address: cached, or the shared call, waited on for at most timeoutMs. */
  async function check(address) {
    const key = address.toLowerCase();
    const hit = cache.get(key);
    if (hit) {
      const age = now() - hit.at;
      if (age >= 0 && age < cacheMs) return hit.result;
      cache.delete(key);
    }
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RemessoError("timeout", `Assay did not answer for ${address} within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([call(address), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  function allowed(r) {
    if (!CLEARS.has(r.verdict)) return false;
    if (r.rating === "NR") return allowUnrated;
    if (minRating && !(RATINGS.indexOf(r.rating) >= RATINGS.indexOf(minRating))) return false;
    return true;
  }

  /** Resolves when Assay clears `address`; throws a RemessoError when it does not. */
  async function guard(address, via) {
    let result;
    try {
      result = await check(address);
    } catch (err) {
      if (err?.code === "no_paying_fetch") {
        throw new TypeError("paid checks need createAssay({ payingFetch }); pass paid: false for the free check");
      }
      report({ address, via, ok: onAssayError === "allow", error: String(err?.message ?? err) });
      if (onAssayError === "allow") return;
      throw err instanceof RemessoError ? err : new RemessoError("http", `Assay could not check ${address}: ${String(err?.message ?? err)}`);
    }
    const ok = allowed(result);
    report({ address, via, ok, result });
    if (!ok) throw new RecipientBlockedError(address, result);
  }

  const PAYABLE_REQUEST = ["pending", "accepted", "accepted_with_changes"]; // as requests.pay in remesso-sdk
  const guarded = { ...remesso };

  guarded.pay = async (input) => {
    const to = addressOf(input?.to);
    if (!to) return remesso.pay(input); // Remesso's checksum() rejects the same input
    await guard(to, "pay");
    return remesso.pay(input);
  };

  guarded.remittances = {
    ...remesso.remittances,
    async send(input) {
      // Remesso's first three tests, in its order (remittances.js): it refuses these unread.
      const inputOnly =
        !input || !FUNDING.includes(input.funding) || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim();
      const to = inputOnly ? null : addressOf(input.to);
      if (!to) return remesso.remittances.send(input);
      await guard(to, "remittances.send");
      return remesso.remittances.send(input);
    },
  };

  guarded.agents = {
    ...remesso.agents,
    async pay(agentId, input) {
      // Remesso's input tests (agents.js), refused before it reads the registry.
      if (
        !input ||
        !FUNDING.includes(input.funding) ||
        (input.funding === "wallet" && (input.policyId != null || input.payer != null)) ||
        (input.requestId && (input.amount !== undefined || input.token !== undefined))
      ) {
        return remesso.agents.pay(agentId, input);
      }
      const found = await remesso.agents.find(agentId); // a failed read is thrown, never passed on
      if (!found.wallet) throw new RemessoError("refused", "the receiving agent has no registered wallet");
      const wallet = addressOf(found.wallet);
      if (!wallet) throw new RemessoError("invalid", `not an address: ${found.wallet}`);
      // Remesso reads expectedWallet only when truthy, through checksum(), after the registry.
      if (input.expectedWallet) {
        const expected = addressOf(input.expectedWallet);
        if (!expected) throw new RemessoError("invalid", `not an address: ${input.expectedWallet}`);
        if (expected !== wallet) {
          throw new RemessoError("conflict", "the receiving agent's wallet differs from the wallet you approved");
        }
      }
      if (!found.profile) {
        throw new RemessoError("refused", `the agent has no readable supported payment profile: ${found.note ?? "no remesso entry"}`);
      }
      if (found.profile.reference?.required && !input.requestId) {
        throw new RemessoError("refused", "the receiving agent requires a payment request reference");
      }
      await guard(wallet, `agents.pay #${agentId}`);
      // Always pin the checked wallet: Remesso refuses if the registry now names another.
      return remesso.agents.pay(agentId, { ...input, expectedWallet: wallet });
    },
  };

  guarded.requests = {
    ...remesso.requests,
    async pay(id, payOpts) {
      const request = await remesso.requests.get(id); // a failed read is thrown
      if (!PAYABLE_REQUEST.includes(request.status)) {
        throw new RemessoError("refused", `request ${request.id} is ${request.status}, so it isn't paid`);
      }
      const to = addressOf(request.requested?.to);
      if (!to) throw new RemessoError("invalid", `not an address: ${request.requested?.to}`);
      await guard(to, `requests.pay ${id}`);
      return remesso.requests.pay(id, payOpts);
    },
  };

  guarded.invoices = {
    ...remesso.invoices,
    async pay(invoice, payOpts) {
      // Remesso's option tests (invoices.js), refused before anything is read.
      if (!payOpts || !FUNDING.includes(payOpts.funding) || Object.keys(payOpts).some((k) => !["funding", "policyId", "waitMs", "maxDebit"].includes(k))) {
        return remesso.invoices.pay(invoice, payOpts);
      }
      const expected = await remesso.invoices.verify(invoice, { allowExpired: true }); // signature and terms; thrown if not
      // Long expired, Remesso can only report an earlier payment or refuse; it starts no new one.
      const longExpired = expected.expiresAt + EXPIRED_MARGIN_S <= Math.floor(Date.now() / 1000);
      // Wallet funding without a request is refused by Remesso whatever else it reads.
      if (longExpired || (payOpts.funding === "wallet" && !expected.requestId)) return remesso.invoices.pay(invoice, payOpts);
      await guard(expected.recipient, `invoices.pay ${expected.id}`);
      return remesso.invoices.pay(invoice, payOpts);
    },
  };

  guarded.schedules = {
    ...remesso.schedules,
    async create(input) {
      if (!input?.request) {
        const to = addressOf(input?.to);
        if (!to) return remesso.schedules.create(input); // Remesso's checksum() rejects the same input
        await guard(to, "schedules.create");
        return remesso.schedules.create(input);
      }
      const request = await remesso.requests.get(input.request); // a failed read is thrown
      if (request.status !== "pending") {
        throw new RemessoError("refused", `request ${request.id} is ${request.status}, so there is nothing to answer`);
      }
      const to = addressOf(request.requested?.to);
      if (!to) throw new RemessoError("invalid", `not an address: ${request.requested?.to}`);
      // Remesso reads a given `to` only when truthy, and refuses one the request does not name.
      if (input.to && String(input.to).toLowerCase() !== to.toLowerCase()) {
        throw new RemessoError("refused", `request ${request.id} asks to be paid at ${request.requested.to}, not ${input.to}`);
      }
      await guard(to, `schedules.create ${input.request}`);
      // Pin what was checked: Remesso refuses the request if it now names another address.
      return remesso.schedules.create({ ...input, to });
    },
  };

  /** The check on its own, e.g. to show a verdict before the user confirms a payment. */
  guarded.assay = { check, allowed };
  return guarded;
}
