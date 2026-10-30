/**
 * Operator commands. Every transaction is sent through a wallet client extended with the
 * ERC-8021 attribution tag, so it counts for the hackathon and is attributable on Celo.
 *
 *   pnpm --filter @assay/server ops deploy-registry
 *   pnpm --filter @assay/server ops register-agent
 *   pnpm --filter @assay/server ops publish 0xSubject
 *   pnpm --filter @assay/server ops verify-tag 0xTxHash
 *
 * Env: OPERATOR_PRIVATE_KEY, ATTRIBUTION_TAG, RPC_URL (default forno), plus
 * ATTESTER_PRIVATE_KEY / REGISTRY_ADDRESS / PUBLIC_URL depending on the command.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyTx, withAttribution } from "@celo/attribution-tags";
import {
  ERC8004_IDENTITY_REGISTRY,
  identityRegistryAbi,
  isAddress,
  isTxHash,
  normalizeAddress,
} from "assayscore-core";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeDeployData,
  type Hex,
  http,
  parseAbi,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { loadEnv } from "../env.js";
import { FUNDING_NOTE, fundingRefusal, hasPaid } from "../lib/funding-guard.js";
import { createRuntime } from "../runtime.js";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const REGISTRY_ABI = parseAbi([
  "function attester() view returns (address)",
  "function owner() view returns (address)",
  "function publish((address subject,uint8 score,uint8 rating,uint64 organicUsdMicros,uint64 grossUsdMicros,uint32 effectivePayersX100,uint64 asOfBlock,uint64 issuedAt,uint64 expiresAt) s, bytes signature)",
  "function scoreOf(address subject) view returns ((address subject,uint8 score,uint8 rating,uint64 organicUsdMicros,uint64 grossUsdMicros,uint32 effectivePayersX100,uint64 asOfBlock,uint64 issuedAt,uint64 expiresAt) score, bool fresh)",
]);

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

function key(name: string): Hex {
  const v = need(name);
  const k = (v.startsWith("0x") ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte private key`);
  return k;
}

const rpcUrl = process.env.RPC_URL ?? "https://forno.celo.org";
const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl) });

function wallet() {
  // The entry's ERC-8021 code; override with ATTRIBUTION_TAG (e.g. after joining a team, whose tag differs).
  const tag = process.env.ATTRIBUTION_TAG?.trim() || "celo_27fe67eb1be5";
  const account = privateKeyToAccount(key("OPERATOR_PRIVATE_KEY"));
  return createWalletClient({ account, chain: celo, transport: http(rpcUrl) }).extend(withAttribution(tag));
}

async function confirm(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  const tag = await verifyTx({ client: publicClient, hash }).catch(() => null);
  console.log(`tx ${hash} block ${receipt.blockNumber} tag ${tag ? tag.codes.join(",") : "MISSING"}`);
  if (!tag) throw new Error("Transaction carries no attribution tag");
  return receipt;
}

async function deployRegistry() {
  const w = wallet();
  const attester = privateKeyToAccount(key("ATTESTER_PRIVATE_KEY")).address;
  const owner =
    process.env.REGISTRY_OWNER && isAddress(process.env.REGISTRY_OWNER)
      ? process.env.REGISTRY_OWNER
      : w.account.address;
  const artifact = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../../contracts/out/AssayRegistry.sol/AssayRegistry.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { abi: unknown[]; bytecode: { object: Hex } };
  // withAttribution wraps sendTransaction but not deployContract, so send the creation
  // code through sendTransaction to get the tag appended.
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [attester, owner],
  });
  const hash = await w.sendTransaction({ data });
  const receipt = await confirm(hash);
  const address = receipt.contractAddress;
  if (!address) throw new Error("No contract address in receipt");
  // The tag rides after the constructor arguments; prove the constructor still read them correctly.
  const [onchainAttester, onchainOwner] = await Promise.all([
    publicClient.readContract({ address, abi: REGISTRY_ABI, functionName: "attester" }),
    publicClient.readContract({ address, abi: REGISTRY_ABI, functionName: "owner" }),
  ]);
  if (
    onchainAttester.toLowerCase() !== attester.toLowerCase() ||
    onchainOwner.toLowerCase() !== owner.toLowerCase()
  ) {
    throw new Error(`Constructor arguments did not land: attester ${onchainAttester}, owner ${onchainOwner}`);
  }
  console.log(
    `AssayRegistry deployed at ${address}\nattester ${onchainAttester}\nowner ${onchainOwner}\nSet REGISTRY_ADDRESS=${address}`,
  );
}

async function registerAgent() {
  const w = wallet();
  const uri =
    process.env.AGENT_URI ?? `${need("PUBLIC_URL").replace(/\/$/, "")}/.well-known/agent-registration.json`;
  const hash = await w.writeContract({
    address: ERC8004_IDENTITY_REGISTRY,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [uri],
  });
  const receipt = await confirm(hash);
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== ERC8004_IDENTITY_REGISTRY) continue;
    try {
      const ev = decodeEventLog({ abi: identityRegistryAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Registered") {
        console.log(
          `Registered ERC-8004 agent #${ev.args.agentId} -> ${uri}\nSet AGENT_ID=${ev.args.agentId}`,
        );
        return;
      }
    } catch {
      // other events
    }
  }
  throw new Error("No Registered event found");
}

/** Point Assay's ERC-8004 identity at a new registration file, e.g. after the API moves domain. */
async function setAgentUri(uriArg: string | undefined) {
  const env = loadEnv();
  const agentId = BigInt(need("AGENT_ID"));
  const uri =
    uriArg ??
    `${(env.PUBLIC_URL ?? need("PUBLIC_URL")).replace(/\/$/, "")}/.well-known/agent-registration.json`;
  // The file must answer before anything onchain points at it.
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`${uri} answered ${res.status}; not updating the registry.`);
  const w = wallet();
  const hash = await w.writeContract({
    address: ERC8004_IDENTITY_REGISTRY,
    abi: setAgentUriAbi,
    functionName: "setAgentURI",
    args: [agentId, uri],
  });
  await confirm(hash);
  console.log(`Agent #${agentId} now points at ${uri}`);
}

const setAgentUriAbi = [
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
] as const;

async function publish(subjectArg: string | undefined) {
  if (!subjectArg || !isAddress(subjectArg)) throw new Error("Usage: ops publish 0xSubjectAddress");
  const env = loadEnv();
  const rt = createRuntime(env);
  if (!rt.attester || !env.REGISTRY_ADDRESS) throw new Error("Set ATTESTER_PRIVATE_KEY and REGISTRY_ADDRESS");
  const subject = normalizeAddress(subjectArg);
  const { assessment, block, now } = rt.analysis.scored(subject);
  const signed = await rt.attester.sign(assessment, block, now);
  rt.close();
  const m = signed.message;
  const score = {
    subject,
    score: Number(m.score),
    rating: Number(m.rating),
    organicUsdMicros: BigInt(m.organicUsdMicros!),
    grossUsdMicros: BigInt(m.grossUsdMicros!),
    effectivePayersX100: Number(m.effectivePayersX100),
    asOfBlock: BigInt(m.asOfBlock!),
    issuedAt: BigInt(m.issuedAt!),
    expiresAt: BigInt(m.expiresAt!),
  };
  const w = wallet();
  const hash = await w.writeContract({
    address: env.REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "publish",
    args: [score, signed.signature],
  });
  await confirm(hash);
  const [stored, fresh] = await publicClient.readContract({
    address: env.REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "scoreOf",
    args: [subject],
  });
  console.log(`Published: score ${stored.score}, rating code ${stored.rating}, fresh ${fresh}`);
}

const ERC20_TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const SENDABLE: Record<string, { address: `0x${string}`; decimals: number } | null> = {
  celo: null,
  usdc: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
  usdt: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
};

/**
 * Assay never funds a wallet that pays it: that wallet's payments would become seller-funded and
 * stop counting, by Assay's rules and the hackathon's. Checked against the live API before every
 * transfer, and fails closed when the API cannot be reached.
 */
async function refuseToFundACustomer(to: string) {
  const payTo = process.env.PAY_TO?.trim();
  if (!payTo) throw new Error("Set PAY_TO so `send` can refuse to fund a wallet that pays Assay");
  const api = (process.env.PUBLIC_URL ?? "https://api.assayscore.xyz").replace(/\/+$/, "");
  let counterparties: { payee: string }[];
  try {
    const res = await fetch(`${api}/v1/address/${to}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`API answered ${res.status}`);
    const body = (await res.json()) as { assessment: { buyer: { counterparties: { payee: string }[] } } };
    counterparties = body.assessment.buyer.counterparties;
  } catch (err) {
    throw new Error(`Not sending: could not check ${to} against ${api} (${String(err)}).`);
  }
  if (hasPaid(counterparties, payTo)) throw new Error(fundingRefusal(to));
  console.error(FUNDING_NOTE);
}

/** Tagged transfer from the agent wallet: ops send <to> <celo|usdc|usdt> <amount> */
async function send(to: string | undefined, asset: string | undefined, amount: string | undefined) {
  if (!to || !isAddress(to) || !asset || !(asset in SENDABLE) || !amount || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error("Usage: ops send 0xTo celo|usdc|usdt 0.05");
  }
  await refuseToFundACustomer(to);
  const w = wallet();
  const token = SENDABLE[asset];
  const hash = token
    ? await w.writeContract({
        address: token.address,
        abi: ERC20_TRANSFER,
        functionName: "transfer",
        args: [to as `0x${string}`, parseUnits(amount, token.decimals)],
      })
    : await w.sendTransaction({ to: to as `0x${string}`, value: parseUnits(amount, 18) });
  await confirm(hash);
  console.log(`sent ${amount} ${asset.toUpperCase()} to ${to}`);
}

async function verifyTag(hash: string | undefined) {
  if (!isTxHash(hash)) throw new Error("Usage: ops verify-tag 0xTxHash");
  const tag = await verifyTx({ client: publicClient, hash });
  console.log(tag ? `tagged: ${tag.codes.join(", ")} (schema ${tag.schemaId})` : "no attribution tag");
}

const [cmd, arg] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  "deploy-registry": deployRegistry,
  "register-agent": registerAgent,
  "set-agent-uri": () => setAgentUri(arg),
  publish: () => publish(arg),
  "verify-tag": () => verifyTag(arg),
  send: () => send(arg, process.argv[4], process.argv[5]),
};
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.error(`Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
try {
  await run();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
