"use client";

import { withAttribution } from "@celo/attribution-tags";
import { useCallback, useMemo } from "react";
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { celo } from "wagmi/chains";
import { ATTRIBUTION_TAG } from "./config";

/** Wallet error codes live on the error or anywhere down its cause chain. */
function errorCode(err: unknown): number | undefined {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 6; depth++) {
    if (typeof e.code === "number") return e.code;
    e = e.cause as typeof e;
  }
  return undefined;
}

/**
 * Plain-language messages for the wallet errors people actually hit. "Cancelled" is said only for a
 * real rejection (EIP-1193 code 4001); anything else shows the wallet's own words, so a failure is
 * never dressed up as something the person did.
 */
export function walletErrorMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; name?: string };
  const text = `${e?.name ?? ""} ${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  const code = errorCode(err);
  if (code === 4001 || /user rejected/i.test(text)) return "You cancelled it in your wallet.";
  if (code === -32002 || /already pending/i.test(text))
    return "Your wallet already has a request waiting. Open the wallet extension and finish or close it.";
  if (/insufficient funds|gas required exceeds|exceeds balance/i.test(text))
    return "Not enough CELO for gas. Add a little CELO, or open this page in MiniPay, which pays gas in stablecoins.";
  if (code === 4902 || /unrecognized chain|chain .* not (added|supported)/i.test(text))
    return "Your wallet does not know Celo yet. Approve adding Celo mainnet when it asks, then try again.";
  if (/ProviderNotFound|no provider|not installed/i.test(text))
    return "No wallet found in this browser. Install MetaMask or Rabby, or open the page in MiniPay.";
  if (/failed to fetch|networkerror|load failed/i.test(text))
    return "Could not reach the Assay server. Check your connection and try again; nothing was charged.";
  const own = e?.shortMessage ?? e?.message?.split("\n")[0];
  return own ? `Your wallet said: ${own}` : "Something went wrong in the wallet.";
}

export interface WalletOption {
  uid: string;
  name: string;
  icon?: string;
}

/**
 * The connected wallet, with a wallet client whose every transaction carries Assay's ERC-8021
 * attribution tag. `ensureCelo` switches the wallet to Celo mainnet when it is elsewhere.
 */
export function useWallet() {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: celo.id });

  const tagged = useMemo(
    () =>
      walletClient && ATTRIBUTION_TAG ? walletClient.extend(withAttribution(ATTRIBUTION_TAG)) : walletClient,
    [walletClient],
  );

  // Every wallet the browser announces (EIP-6963) is its own option, so a Brave user with MetaMask
  // picks MetaMask instead of whatever grabbed window.ethereum first. The generic "Injected"
  // entry is only offered when nothing announced itself (MiniPay, older wallets).
  const options = useMemo<WalletOption[]>(() => {
    const named = connectors.filter((c) => c.id !== "injected");
    const list = named.length > 0 ? named : connectors;
    const seen = new Set<string>();
    return list
      .filter((c) => {
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
      })
      .map((c) => ({ uid: c.uid, name: c.id === "injected" ? "Browser wallet" : c.name, icon: c.icon }));
  }, [connectors]);

  const connectWith = useCallback(
    async (uid?: string) => {
      const connector = connectors.find((c) => c.uid === (uid ?? options[0]?.uid)) ?? connectors[0];
      if (!connector) throw new Error("ProviderNotFound");
      // No chainId here: some wallets fail the connect if asked to switch at the same time.
      // The network is switched (or added) right before the first action instead.
      await connect.mutateAsync({ connector });
    },
    [connect, connectors, options],
  );

  const ensureCelo = useCallback(async () => {
    if (connection.chainId !== celo.id) await switchChain.mutateAsync({ chainId: celo.id });
  }, [connection.chainId, switchChain]);

  return {
    address: connection.address?.toLowerCase() as `0x${string}` | undefined,
    isConnected: connection.isConnected,
    onCelo: connection.chainId === celo.id,
    hasInjected: connectors.length > 0,
    connecting: connect.isPending,
    connect: connectWith,
    options,
    disconnect: () => disconnect.mutate({}),
    ensureCelo,
    walletClient: tagged,
    publicClient,
    tagConfigured: Boolean(ATTRIBUTION_TAG),
  };
}
