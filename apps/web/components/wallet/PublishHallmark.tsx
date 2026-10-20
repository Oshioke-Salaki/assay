"use client";

import type { Rating } from "@assay/core";
import { type TokenInfo, tokenByAddress } from "@assay/core";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { useState } from "react";
import { formatUnits } from "viem";
import styles from "@/components/app.module.css";
import { useToast } from "@/components/Toaster";
import { txUrl } from "@/lib/format";
import { erc20BalanceAbi, REGISTRY_ADDRESS, registryAbi } from "./config";
import { WalletProviders } from "./Providers";
import { useWallet, walletErrorMessage } from "./useWallet";
import { WalletPicker } from "./WalletPicker";

interface Offer {
  token: TokenInfo;
  amount: bigint;
}

/** The tokens and amounts the server's 402 asks for, in the server's order (USD₮ first). */
async function priceList(url: string): Promise<Offer[]> {
  const res = await corsSafeFetch(url);
  if (res.status === 503) throw new Error("Paid reports are not switched on for this Assay server yet.");
  const header = res.headers.get("payment-required");
  if (res.status !== 402 || !header) throw new Error(`Assay answered ${res.status} instead of a price.`);
  const required = JSON.parse(atob(header)) as { accepts?: { asset: string; amount: string }[] };
  return (required.accepts ?? []).flatMap((a) => {
    const token = tokenByAddress(a.asset);
    return token ? [{ token, amount: BigInt(a.amount) }] : [];
  });
}

function shown(o: Offer): string {
  const n = formatUnits(o.amount, o.token.decimals);
  return o.token.fiat === "USD" ? `$${n} in ${o.token.symbol}` : `${n} ${o.token.symbol}`;
}

type Step =
  | { kind: "idle" }
  | { kind: "working"; text: string }
  | { kind: "done"; hash: `0x${string}` }
  | { kind: "error"; text: string };

interface Attested {
  attestation: {
    message: Record<string, string | number>;
    signature: `0x${string}`;
  } | null;
}

/**
 * The x402 client adds an `Access-Control-Expose-Headers` header to its paid retry. That is a
 * response header; sent on a request it fails the browser's CORS preflight on servers that do not
 * list it, and the payment surfaces as "Failed to fetch". Strip it before the request leaves.
 */
const corsSafeFetch: typeof fetch = (input, init) => {
  const req = new Request(input, init);
  req.headers.delete("access-control-expose-headers");
  return fetch(req);
};

export function PublishHallmark(props: { subject: `0x${string}`; rating: Rating }) {
  return (
    <WalletProviders>
      <Inner {...props} />
    </WalletProviders>
  );
}

/**
 * Buy a signed score for $0.01 over x402 (paid from the visitor's own wallet, in the first of
 * USD₮, USDC, USA₮, wARS, wBRL or wCOP it holds enough of) and publish it to AssayRegistry so contracts can read it.
 */
function Inner({ subject, rating }: { subject: `0x${string}`; rating: Rating }) {
  const w = useWallet();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const toast = useToast();
  const configured = Boolean(REGISTRY_ADDRESS);

  async function run() {
    try {
      if (!w.isConnected) return;
      await w.ensureCelo();
      const client = w.walletClient;
      const pub = w.publicClient;
      if (!client || !pub || !w.address) throw new Error("Wallet not ready yet. Try again.");
      const account = w.address;

      setStep({ kind: "working", text: "Checking your stablecoin balances…" });
      // Same-origin: next.config rewrites /x402/* to the Assay API.
      const url = `/x402/v1/attest/${subject}`;
      const offers = await priceList(url);
      const balances = await Promise.all(
        offers.map((o) =>
          pub
            .readContract({
              address: o.token.address,
              abi: erc20BalanceAbi,
              functionName: "balanceOf",
              args: [account],
            })
            .catch(() => 0n),
        ),
      );
      // The first token in the server's order that this wallet can cover.
      const offer = offers.find((o, i) => (balances[i] ?? 0n) >= o.amount);
      if (!offer)
        throw new Error(
          `This wallet cannot cover $0.01 in ${offers.map((o) => o.token.symbol).join(", ")} on Celo. Top up a little and try again.`,
        );

      setStep({
        kind: "working",
        text: `Paying ${shown(offer)}. Sign the authorization in your wallet…`,
      });
      const payer = new x402Client(
        (_v, reqs) => reqs.find((r) => r.asset.toLowerCase() === offer.token.address) ?? reqs[0]!,
      );
      payer.register(
        "eip155:42220",
        new ExactEvmScheme({
          address: account,
          signTypedData: (m) =>
            client.signTypedData({ account, ...(m as Parameters<typeof client.signTypedData>[0]) }),
          // wFIAT pays through Permit2: the scheme reads the allowance and, if it is missing, signs an
          // EIP-2612 permit that the facilitator submits, so the payer still needs no gas.
          readContract: (args) => pub.readContract(args as Parameters<typeof pub.readContract>[0]),
        }),
      );
      // x402 pays only its default assets (the dollars) unless told otherwise: allow this one token,
      // capped at the amount just quoted.
      if (offer.token.fiat !== "USD")
        payer.setSpendControls({
          allowedAssets: [
            {
              network: "eip155:42220",
              asset: offer.token.address,
              maxAmountPerPayment: offer.amount.toString(),
            },
          ],
        });
      const pay = wrapFetchWithPayment(corsSafeFetch, payer);
      const res = await pay(url);
      if (!res.ok) throw new Error(`Assay answered ${res.status}. Nothing was published.`);
      const body = (await res.json()) as Attested;
      if (!body.attestation)
        throw new Error("This server has no attester key, so it cannot sign a hallmark yet.");

      setStep({ kind: "working", text: "Publishing the hallmark. Confirm the transaction in your wallet…" });
      const m = body.attestation.message;
      const hash = await client.writeContract({
        account,
        chain: client.chain,
        address: REGISTRY_ADDRESS as `0x${string}`,
        abi: registryAbi,
        functionName: "publish",
        args: [
          {
            subject,
            score: Number(m.score),
            rating: Number(m.rating),
            organicUsdMicros: BigInt(m.organicUsdMicros!),
            grossUsdMicros: BigInt(m.grossUsdMicros!),
            effectivePayersX100: Number(m.effectivePayersX100),
            asOfBlock: BigInt(m.asOfBlock!),
            issuedAt: BigInt(m.issuedAt!),
            expiresAt: BigInt(m.expiresAt!),
          },
          body.attestation.signature,
        ],
      });
      setStep({ kind: "working", text: "Waiting for Celo to confirm…" });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error(
          "The transaction reverted. Your $0.01 bought the signed score, which is still valid for 7 days.",
        );
      setStep({ kind: "done", hash });
      toast({
        tone: "success",
        title: "Hallmark published on Celo",
        href: txUrl(hash),
        hrefLabel: "View transaction",
      });
    } catch (err) {
      const text = walletErrorMessage(err);
      setStep({ kind: "error", text });
      toast({ tone: "error", title: "Hallmark not published", detail: text });
    }
  }

  if (!configured) {
    return (
      <p className={styles.empty}>
        Publishing opens once AssayRegistry is deployed on Celo. Until then the score is readable through the
        API.
      </p>
    );
  }

  const busy = step.kind === "working";
  return (
    <div className={styles.form}>
      <p style={{ maxWidth: "72ch" }}>
        Buy this address&rsquo;s signed score for $0.01 over x402 and write it to AssayRegistry. Any contract
        on Celo can then call <code>isInvestmentGrade({subject.slice(0, 8)}…)</code>. The score is valid for 7
        days.
        {rating === "NR" ? " This address is not rated yet, so contracts will read NR." : ""}
      </p>
      {w.isConnected ? (
        <div className={styles.actions}>
          <button type="button" className="btn btn--ink" onClick={run} disabled={busy}>
            {busy ? "Working…" : "Pay $0.01 and publish"}
          </button>
          <span className={styles.muted} style={{ alignSelf: "center" }}>
            {w.address?.slice(0, 6)}…{w.address?.slice(-4)}
            {w.address === subject ? " (this address)" : ""}
          </span>
          <button type="button" className="btn btn--quiet" onClick={w.disconnect} disabled={busy}>
            Disconnect
          </button>
        </div>
      ) : (
        <WalletPicker
          options={w.options}
          busy={w.connecting}
          onPick={(uid) => {
            setStep({ kind: "idle" });
            w.connect(uid).catch((e: unknown) => setStep({ kind: "error", text: walletErrorMessage(e) }));
          }}
        />
      )}
      <p
        role="status"
        aria-live="polite"
        className={
          step.kind === "error"
            ? `${styles.notice} ${styles.noticeBad}`
            : step.kind === "done"
              ? `${styles.notice} ${styles.noticeGood}`
              : styles.muted
        }
      >
        {step.kind === "working" ? (
          step.text
        ) : step.kind === "error" ? (
          step.text
        ) : step.kind === "done" ? (
          <>
            Published.{" "}
            <a className="link" href={txUrl(step.hash)}>
              View the transaction
            </a>
          </>
        ) : (
          ""
        )}
      </p>
    </div>
  );
}
