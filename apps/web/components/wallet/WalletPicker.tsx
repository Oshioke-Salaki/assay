"use client";

import styles from "@/components/app.module.css";
import type { WalletOption } from "./useWallet";

/** One button per wallet the browser offers. With a single wallet it is just "Connect …". */
export function WalletPicker({
  options,
  busy,
  onPick,
}: {
  options: WalletOption[];
  busy: boolean;
  onPick: (uid: string) => void;
}) {
  if (options.length === 0) {
    return (
      <p className={styles.notice}>
        No wallet found in this browser. Install{" "}
        <a className="link" href="https://metamask.io/download/">
          MetaMask
        </a>{" "}
        or{" "}
        <a className="link" href="https://rabby.io/">
          Rabby
        </a>
        , or open this page in MiniPay.
      </p>
    );
  }
  return (
    <div className={styles.actions}>
      {options.map((o) => (
        <button
          key={o.uid}
          type="button"
          className="btn btn--ink"
          disabled={busy}
          onClick={() => onPick(o.uid)}
        >
          {o.icon ? (
            // Wallet icons are data: URIs the wallet itself announces; next/image cannot optimise them.
            // biome-ignore lint/performance/noImgElement: data URI from the wallet
            <img src={o.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />
          ) : null}
          {busy ? "Connecting…" : `Connect ${o.name}`}
        </button>
      ))}
    </div>
  );
}
