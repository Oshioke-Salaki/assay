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

/** Plain-language messages for the wallet errors people actually hit. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; name?: string; code?: number };
  const text = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  if (e?.code === 4001 || /user rejected|denied|rejected the request/i.test(text))
    return "You cancelled it in your wallet.";
  if (/insufficient funds|gas required exceeds/i.test(text))
    return "Not enough CELO for gas. Add a little CELO, or open this page in MiniPay, which pays gas in stablecoins.";
  if (/chain|network/i.test(text) && /mismatch|unsupported|switch/i.test(text))
    return "Switch your wallet to Celo mainnet and try again.";
  if (/ProviderNotFound|no provider|window\.ethereum/i.test(text))
    return "No wallet found in this browser. Open the page in MiniPay, MetaMask or Rabby.";
  return e?.shortMessage ?? e?.message?.split("\n")[0] ?? "Something went wrong in the wallet.";
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

  const connectInjected = useCallback(async () => {
    const connector = connectors[0];
    if (!connector) throw new Error("ProviderNotFound");
    await connect.mutateAsync({ connector, chainId: celo.id });
  }, [connect, connectors]);

  const ensureCelo = useCallback(async () => {
    if (connection.chainId !== celo.id) await switchChain.mutateAsync({ chainId: celo.id });
  }, [connection.chainId, switchChain]);

  return {
    address: connection.address?.toLowerCase() as `0x${string}` | undefined,
    isConnected: connection.isConnected,
    onCelo: connection.chainId === celo.id,
    hasInjected: connectors.length > 0,
    connecting: connect.isPending,
    connect: connectInjected,
    disconnect: () => disconnect.mutate({}),
    ensureCelo,
    walletClient: tagged,
    publicClient,
    tagConfigured: Boolean(ATTRIBUTION_TAG),
  };
}
