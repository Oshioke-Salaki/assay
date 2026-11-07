// withAssay: the same Remesso client, but every payment checks its recipient with Assay first.
//
//   const remesso = withAssay(createRemesso({ account }), { assay: createAssay({ payingFetch }) });
//   await remesso.agents.pay(agentId, { ... });   // throws RecipientBlockedError for a wash seller
//
// - pay, remittances.send, agents.pay and requests.pay are guarded; everything else is untouched.
// - agents.pay resolves the agent's wallet, checks it, and passes it as `expectedWallet`, so the
//   payment fails if the agent's wallet changes between the check and the payment.
// - With a paying Assay client, each check is a paid x402 call ($0.002, in USA₮ if you prefer it)
//   that returns an EIP-712 score signed by Assay. When the caller sets no memo, the payment's
//   onchain memo records the verdict and a short hash of that signature, linking the payment to
//   the check that cleared it.
// - Verdicts are cached (10 minutes by default), and checks for the same address share one request.
import { keccak256 } from "viem";

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
 * @param {boolean} [opts.paid]        use the paid check; default: true when opts.assay can pay
 * @param {string} [opts.minRating]    lowest rating to pay, e.g. "BB"; default: only "block" stops a payment
 * @param {boolean} [opts.allowUnrated] pay addresses with too little history to rate (NR); default true
 * @param {number} [opts.cacheMs]      default 10 minutes
 * @param {"allow"|"block"} [opts.onAssayError] when Assay cannot be reached; default "block"
 * @param {(d: object) => void} [opts.onDecision] called with every decision, for your logs
 */
export function withAssay(remesso, opts) {
  const { assay, minRating, allowUnrated = true, cacheMs = 10 * 60_000, onAssayError = "block", onDecision } = opts;
  const paid = opts.paid ?? true;
  const cache = new Map(); // address -> { at, result }
  const inflight = new Map(); // address -> Promise

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

  /** At most 32 bytes: "assay pass A 1f2e3d4c" (the hash is of Assay's signature). */
  function memoFor(r) {
    const sig = r.attestation?.signature;
    return `assay ${r.verdict} ${r.rating}${sig ? ` ${keccak256(sig).slice(2, 10)}` : ""}`;
  }

  async function guard(address, via) {
    let result;
    try {
      result = await check(address);
    } catch (err) {
      onDecision?.({ address, via, ok: onAssayError === "allow", error: String(err?.message ?? err) });
      if (onAssayError === "allow") return null;
      throw err;
    }
    const ok = allowed(result);
    onDecision?.({ address, via, ok, result });
    if (!ok) throw new RecipientBlockedError(address, result);
    return result;
  }

  const withMemo = (input, r) => (input.memo || !r ? input : { ...input, memo: memoFor(r) });

  return {
    ...remesso,
    async pay(input) {
      return remesso.pay(withMemo(input, await guard(input.to, "pay")));
    },
    remittances: {
      ...remesso.remittances,
      async send(input) {
        return remesso.remittances.send(withMemo(input, await guard(input.to, "remittances.send")));
      },
    },
    agents: {
      ...remesso.agents,
      async pay(agentId, input) {
        const { wallet } = await remesso.agents.find(agentId);
        if (!wallet) throw new Error(`agent ${agentId} has no wallet to pay`);
        await guard(wallet, `agents.pay #${agentId}`);
        return remesso.agents.pay(agentId, { ...input, expectedWallet: wallet });
      },
    },
    requests: {
      ...remesso.requests,
      async pay(id, payOpts) {
        const request = await remesso.requests.get(id);
        await guard(request.to, `requests.pay ${id}`);
        return remesso.requests.pay(id, payOpts);
      },
    },
    /** The check on its own, e.g. to show a verdict before the user confirms a payment. */
    assay: { check, allowed, memoFor },
  };
}
