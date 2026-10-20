"use client";

import { ERC8004_IDENTITY_REGISTRY, ERC8004_REPUTATION_REGISTRY, reputationRegistryAbi } from "@assay/core";
import { useEffect, useState } from "react";
import { keccak256, stringToBytes, toHex } from "viem";
import styles from "@/components/app.module.css";
import { API_PUBLIC } from "@/lib/api";
import { date, short, txUrl, usd } from "@/lib/format";
import { WalletProviders } from "./Providers";
import { useWallet, walletErrorMessage } from "./useWallet";
import { WalletPicker } from "./WalletPicker";

interface Payment {
  txHash: `0x${string}`;
  ts: number;
  usd: number;
  payee: `0x${string}`;
}

interface PaymentsResponse {
  isOwner: boolean;
  payments: Payment[];
  agent: { owner: `0x${string}`; wallet: `0x${string}` | null };
}

interface ProofResponse {
  ok: boolean;
  status: string;
  settlements: { payer: string; payee: string; usd: number; ts: number }[];
}

export function ReviewForm({ agentId }: { agentId: string }) {
  return (
    <WalletProviders>
      <Inner agentId={agentId} />
    </WalletProviders>
  );
}

/**
 * A review that can only be written by someone who paid the agent: the wallet picks one of its
 * own settlements to the agent (or pastes a fresh one, checked live on Celo), and the review is
 * written to the ERC-8004 Reputation Registry with that settlement as proofOfPayment, inline as a
 * data: URI so anyone can verify it without trusting Assay's servers.
 */
function Inner({ agentId }: { agentId: string }) {
  const w = useWallet();
  const [loaded, setLoaded] = useState<PaymentsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [proof, setProof] = useState<string>("");
  const [pasted, setPasted] = useState("");
  const [score, setScore] = useState(80);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<{
    kind: "idle" | "working" | "done" | "error";
    text?: string;
    hash?: `0x${string}`;
  }>({
    kind: "idle",
  });

  useEffect(() => {
    if (!w.address) return;
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    fetch(`${API_PUBLIC}/v1/agents/${agentId}/payments/${w.address}`)
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            ((await r.json().catch(() => ({}))) as { message?: string }).message ?? `API ${r.status}`,
          );
        return (await r.json()) as PaymentsResponse;
      })
      .then((d) => {
        if (cancelled) return;
        setLoaded(d);
        setProof(d.payments[0]?.txHash ?? "");
      })
      .catch(
        (e: unknown) =>
          !cancelled && setLoadError(e instanceof Error ? e.message : "Could not load your payments."),
      );
    return () => {
      cancelled = true;
    };
  }, [agentId, w.address]);

  async function checkPasted(): Promise<string> {
    const tx = pasted.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error("A transaction hash is 0x and 64 hex characters.");
    const r = await fetch(`${API_PUBLIC}/v1/proof/${tx}`);
    if (!r.ok) throw new Error("Could not check that transaction on Celo right now.");
    const p = (await r.json()) as ProofResponse;
    if (!p.ok) {
      throw new Error(
        p.status === "pending"
          ? "That transaction is not mined yet. Wait a few seconds."
          : p.status === "not_found"
            ? "That transaction does not exist on Celo mainnet."
            : "That transaction is not an x402 payment.",
      );
    }
    const agentAddrs = [loaded?.agent.owner, loaded?.agent.wallet]
      .filter(Boolean)
      .map((x) => x!.toLowerCase());
    const match = p.settlements.find((s) => s.payer === w.address && agentAddrs.includes(s.payee));
    if (!match) throw new Error("In that transaction your wallet did not pay this agent.");
    return tx.toLowerCase();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (!w.address || !w.walletClient || !w.publicClient || !loaded)
        throw new Error("Connect your wallet first.");
      if (loaded.isOwner)
        throw new Error("You own this agent. ERC-8004 does not let owners review themselves.");
      setState({ kind: "working", text: "Checking your payment…" });
      const proofTx = proof === "paste" ? await checkPasted() : proof;
      if (!proofTx) throw new Error("Pick the payment this review is about.");
      const payee =
        loaded.payments.find((p) => p.txHash === proofTx)?.payee ?? loaded.agent.wallet ?? loaded.agent.owner;
      await w.ensureCelo();
      const file = {
        agentRegistry: `eip155:42220:${ERC8004_IDENTITY_REGISTRY}`,
        agentId: Number(agentId),
        clientAddress: `eip155:42220:${w.address}`,
        createdAt: new Date().toISOString(),
        value: score,
        valueDecimals: 0,
        tag1: "x402",
        tag2: "assay",
        proofOfPayment: { fromAddress: w.address, toAddress: payee, chainId: "42220", txHash: proofTx },
        comment: comment.trim().slice(0, 280) || undefined,
      };
      const json = JSON.stringify(file);
      const uri = `data:application/json;base64,${btoa(String.fromCharCode(...stringToBytes(json)))}`;
      setState({ kind: "working", text: "Confirm the review in your wallet…" });
      const hash = await w.walletClient.writeContract({
        account: w.address,
        chain: w.walletClient.chain,
        address: ERC8004_REPUTATION_REGISTRY,
        abi: reputationRegistryAbi,
        functionName: "giveFeedback",
        args: [BigInt(agentId), BigInt(score), 0, "x402", "assay", "", uri, keccak256(toHex(json))],
      });
      setState({ kind: "working", text: "Waiting for Celo to confirm…" });
      const receipt = await w.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The registry rejected the review.");
      setState({ kind: "done", hash });
    } catch (err) {
      setState({ kind: "error", text: walletErrorMessage(err) });
    }
  }

  if (!w.isConnected) {
    return (
      <div className={styles.form}>
        <p>Only wallets that paid this agent can review it. Connect the wallet you paid from.</p>
        <WalletPicker
          options={w.options}
          busy={w.connecting}
          onPick={(uid) => {
            setState({ kind: "idle" });
            w.connect(uid).catch((e: unknown) => setState({ kind: "error", text: walletErrorMessage(e) }));
          }}
        />
        {state.kind === "error" ? (
          <p className={`${styles.notice} ${styles.noticeBad}`}>{state.text}</p>
        ) : null}
      </div>
    );
  }

  if (loadError) return <p className={`${styles.notice} ${styles.noticeBad}`}>{loadError}</p>;
  if (!loaded) return <p className={styles.muted}>Looking up your payments to this agent…</p>;
  if (loaded.isOwner) {
    return (
      <p className={styles.notice}>
        This wallet owns the agent. ERC-8004 does not let an owner review its own agent.
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label>
        The payment this review is about
        <select value={proof} onChange={(e) => setProof(e.target.value)}>
          {loaded.payments.map((p) => (
            <option key={p.txHash} value={p.txHash}>
              {usd(p.usd)} on {date(p.ts)} · {short(p.txHash)}
            </option>
          ))}
          <option value="paste">A newer payment (paste its transaction)</option>
        </select>
      </label>
      {proof === "paste" || loaded.payments.length === 0 ? (
        <label>
          Settlement transaction hash
          <input
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              if (proof !== "paste") setProof("paste");
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
      ) : null}
      <label>
        Score: {score} of 100
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={score}
          onChange={(e) => setScore(Number(e.target.value))}
        />
      </label>
      <label>
        What happened (optional, 280 characters)
        <textarea value={comment} maxLength={280} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className={styles.actions}>
        <button type="submit" className="btn btn--ink" disabled={state.kind === "working"}>
          {state.kind === "working" ? "Working…" : "Write the review onchain"}
        </button>
        <span className={styles.muted} style={{ alignSelf: "center" }}>
          From {short(w.address)}
          {w.tagConfigured ? "" : " · attribution tag not set"}
        </span>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={
          state.kind === "error"
            ? `${styles.notice} ${styles.noticeBad}`
            : state.kind === "done"
              ? `${styles.notice} ${styles.noticeGood}`
              : styles.muted
        }
      >
        {state.kind === "done" && state.hash ? (
          <>
            Review written.{" "}
            <a className="link" href={txUrl(state.hash)}>
              View the transaction
            </a>
            . It appears here once the block is finalized.
          </>
        ) : (
          (state.text ?? "")
        )}
      </p>
    </form>
  );
}
