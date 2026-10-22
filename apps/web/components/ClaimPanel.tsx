"use client";

import {
  type ClaimFields,
  claimMessage,
  SELLER_CATEGORIES,
  type SellerCategory,
  validateClaim,
} from "assayscore-core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "@/components/app.module.css";
import { useToast } from "@/components/Toaster";
import { API_PUBLIC, type ClaimInfo } from "@/lib/api";
import { WalletProviders } from "./wallet/Providers";
import { AssayNotice, useWallet, walletErrorMessage } from "./wallet/useWallet";
import { WalletPicker } from "./wallet/WalletPicker";

export function ClaimPanel(props: { subject: `0x${string}`; claim: ClaimInfo | null; siteUrl: string }) {
  return (
    <WalletProviders>
      <Inner {...props} />
    </WalletProviders>
  );
}

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * The wallet's owner signs one message (no money moves) and its name, website and X handle
 * appear on this report and in the seller lists. The same wallet can change or remove them.
 */
function Inner({
  subject,
  claim,
  siteUrl,
}: {
  subject: `0x${string}`;
  claim: ClaimInfo | null;
  siteUrl: string;
}) {
  const w = useWallet();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(claim?.name ?? "");
  const [url, setUrl] = useState(claim?.url ?? "");
  const [x, setX] = useState(claim?.x ?? "");
  const [logoUrl, setLogoUrl] = useState(claim?.logoUrl ?? "");
  const [what, setWhat] = useState(claim?.what ?? "");
  const [category, setCategory] = useState<SellerCategory | "">(
    (claim?.category as SellerCategory | null) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const isOwner = w.isConnected && w.address?.toLowerCase() === subject.toLowerCase();

  async function submit(action: "claim" | "release") {
    setNote(null);
    const draft: Partial<ClaimFields> = {
      address: subject,
      action,
      name,
      url,
      x,
      logoUrl,
      what,
      category,
      issuedAt: Math.floor(Date.now() / 1000),
      nonce: nonce(),
    };
    const v = validateClaim(draft);
    if (!v.ok) {
      setNote({ tone: "bad", text: v.error });
      return;
    }
    try {
      setBusy(true);
      const client = w.walletClient;
      if (!client || !w.address) throw new AssayNotice("Wallet not ready yet. Try again.");
      const signature = await client.signMessage({ account: w.address, message: claimMessage(v.fields) });
      const res = await fetch(`${API_PUBLIC}/v1/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...v.fields, signature }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new AssayNotice(body.message ?? `Assay answered ${res.status}.`);
      setNote({
        tone: "ok",
        text:
          action === "claim"
            ? "Saved. The page shows it within a minute."
            : "Removed. The page updates within a minute.",
      });
      toast({ tone: "success", title: action === "claim" ? "Page claimed" : "Claim removed" });
      router.refresh();
    } catch (err) {
      const text = walletErrorMessage(err);
      setNote({ tone: "bad", text });
    } finally {
      setBusy(false);
    }
  }

  const badgeMd = `[![Assay rating](${API_PUBLIC}/v1/badge/${subject}.svg)](${siteUrl}/address/${subject})`;
  const copyBadge = async () => {
    try {
      await navigator.clipboard.writeText(badgeMd);
      toast({ tone: "success", title: "Badge markdown copied" });
    } catch {
      toast({ tone: "error", title: "Could not copy", detail: "Select the text and copy it by hand." });
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ maxWidth: "72ch" }}>
        {claim
          ? `This page is claimed as "${claim.name}". The same wallet can change or remove that.`
          : "Is this your wallet? Put your name on it. You sign one message from the wallet; it moves no money. Your name, what you sell, website and X handle then appear on this report and in the sellers directory, where buyers' agents look."}
      </p>

      {!w.isConnected ? (
        <WalletPicker
          options={w.options}
          busy={w.connecting}
          onPick={(uid) => {
            setNote(null);
            w.connect(uid).catch((e: unknown) => setNote({ tone: "bad", text: walletErrorMessage(e) }));
          }}
        />
      ) : !isOwner ? (
        <p className={`${styles.notice}`}>
          Connected as {w.address?.slice(0, 6)}…{w.address?.slice(-4)}, which is not this address. Connect the
          wallet that owns {subject.slice(0, 6)}…{subject.slice(-4)} to claim it.{" "}
          <button
            type="button"
            className="link"
            onClick={w.disconnect}
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
          >
            Disconnect
          </button>
        </p>
      ) : (
        <form
          className={styles.form}
          style={{ maxWidth: 520 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit("claim");
          }}
        >
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
              placeholder="What people call your service"
            />
          </label>
          <label>
            What you sell (optional, shown in the sellers directory)
            <input
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              maxLength={80}
              placeholder="e.g. Weather data by the call, Translation API"
            />
          </label>
          <label>
            Category (optional)
            <select value={category} onChange={(e) => setCategory(e.target.value as SellerCategory | "")}>
              <option value="">Choose one</option>
              {SELLER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Website (optional)
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              maxLength={200}
              placeholder="https://"
              inputMode="url"
            />
          </label>
          <label>
            X handle (optional)
            <input
              value={x}
              onChange={(e) => setX(e.target.value)}
              maxLength={16}
              placeholder="handle, without the @"
            />
          </label>
          <label>
            Logo link (optional)
            <input
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              maxLength={300}
              placeholder="https://…/logo.png"
              inputMode="url"
            />
          </label>
          <div className={styles.actions}>
            <button type="submit" className="btn btn--ink" disabled={busy}>
              {busy ? "Working…" : claim ? "Sign and update" : "Sign and claim"}
            </button>
            {claim ? (
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                onClick={() => void submit("release")}
              >
                Remove my claim
              </button>
            ) : null}
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={w.disconnect}>
              Disconnect
            </button>
          </div>
          <p className={styles.muted} style={{ fontSize: "0.8125rem" }}>
            A claim says "this wallet's owner chose this name". It is not a check of who you are, and names
            that read as someone else's are refused.
          </p>
        </form>
      )}
      {note ? (
        <p
          role="status"
          aria-live="polite"
          className={`${styles.notice} ${note.tone === "bad" ? styles.noticeBad : styles.noticeGood}`}
        >
          {note.text}
        </p>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        <p style={{ fontWeight: 600 }}>Badge for your README or docs</p>
        {/* biome-ignore lint/performance/noImgElement: the badge is this site's own SVG, served by the API. */}
        <img
          src={`${API_PUBLIC}/v1/badge/${subject}.svg`}
          alt="Assay rating badge"
          height={20}
          style={{ justifySelf: "start" }}
        />
        <code
          className={styles.addr}
          style={{
            display: "block",
            padding: "10px 12px",
            background: "var(--app-ground)",
            borderRadius: 6,
            fontSize: "0.8125rem",
          }}
        >
          {badgeMd}
        </code>
        <div>
          <button type="button" className="btn btn--quiet" onClick={copyBadge}>
            Copy markdown
          </button>
        </div>
        <p className={styles.muted} style={{ fontSize: "0.8125rem" }}>
          It shows the current rating and updates on its own, and links to this report.
        </p>
      </div>
    </div>
  );
}
