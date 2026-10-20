import { createConfig, http } from "wagmi";
import { celo } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/** Injected wallets only: MiniPay, MetaMask, Rabby, Valora's browser. No WalletConnect project id needed. */
export const wagmiConfig = createConfig({
  chains: [celo],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [celo.id]: http(process.env.NEXT_PUBLIC_CELO_RPC ?? "https://forno.celo.org") },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

/**
 * ERC-8021 attribution code for every transaction the frontend sends (Agents on Open Rails entry).
 * Public by nature: it is appended to calldata. The default keeps a missing env var from ever
 * producing an untagged transaction.
 */
export const ATTRIBUTION_TAG = process.env.NEXT_PUBLIC_ATTRIBUTION_TAG || "celo_27fe67eb1be5";

export const REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS ?? "") as `0x${string}` | "";

export const registryAbi = [
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "subject", type: "address" },
          { name: "score", type: "uint8" },
          { name: "rating", type: "uint8" },
          { name: "organicUsdMicros", type: "uint64" },
          { name: "grossUsdMicros", type: "uint64" },
          { name: "effectivePayersX100", type: "uint32" },
          { name: "asOfBlock", type: "uint64" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
