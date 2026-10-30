import { METHODOLOGY_VERSION, RATING_FLOORS, THIN_FILE } from "assayscore-core";
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell, Panel } from "@/components/AppShell";
import styles from "@/components/app.module.css";
import { API_PUBLIC } from "@/lib/api";
import docs from "./docs.module.css";

export const metadata: Metadata = { title: "Docs" };

const SECTIONS = [
  ["quickstart", "Quickstart"],
  ["api", "HTTP API"],
  ["guard", "SDK guard"],
  ["mcp", "MCP server"],
  ["registry", "AssayRegistry"],
  ["reviews", "Payment-verified reviews"],
  ["alerts", "Alerts"],
  ["claim", "Claim your page"],
  ["sellers", "Find sellers"],
  ["plan", "Raise your rating"],
  ["reply", "Right of reply"],
  ["payer", "Check a payer"],
  ["independent", "Independent payers"],
  ["trust", "Trust model"],
  ["methodology", "Methodology"],
  ["pricing", "Pricing and limits"],
  ["selfhost", "Run your own"],
] as const;

function Code({ children, label }: { children: string; label: string }) {
  return (
    <figure className={docs.figure}>
      <figcaption className="sr-only">{label}</figcaption>
      <pre className={docs.code}>
        <code>{children.trim()}</code>
      </pre>
    </figure>
  );
}

export default function DocsPage() {
  const api = API_PUBLIC;
  return (
    <AppShell current="/docs">
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Docs</h1>
          <p className={styles.finding}>
            Check any Celo address before paying it, from a browser, an HTTP call, an x402 client or an MCP
            tool. Read the score onchain from a contract.
          </p>
        </div>
      </div>

      <nav aria-label="On this page" className={`${styles.panel} ${docs.toc}`}>
        <h2 className={styles.panelTitle}>On this page</h2>
        <ul>
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <div className={docs.body}>
        <Panel title="Quickstart" id="quickstart">
          <p>The free endpoint returns the whole report for any address. No key, no wallet.</p>
          <Code label="Free report with curl">{`
curl ${api}/v1/address/0xSELLER
          `}</Code>
          <p>
            Agents that check sellers before paying them use the paid check: $0.002 over x402 in USD₮ by
            default, or USDC, USA₮, wARS, wBRL or wCOP. No rate limit, and a signed score in the answer.
          </p>
          <Code label="Paid check with an x402 client">{`
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { preferAssets } from "assayscore";

// Pay in the token your wallet holds; x402 otherwise takes the server's first option (USD₮).
const client = new x402Client(preferAssets("USDT", "USDC"))
  .register("eip155:42220", new ExactEvmScheme(privateKeyToAccount(KEY)));
const pay = wrapFetchWithPayment(fetch, client);
const res = await pay("${api}/v1/check/0xSELLER");
const { verdict, rating, reasons, attestation } = await res.json();
          `}</Code>
        </Panel>

        <Panel title="HTTP API" id="api">
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Price</th>
                  <th>Returns</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "GET /v1/check/:address",
                    "$0.002",
                    "pass, caution or block; rating; organic share; reasons; signed EIP-712 score",
                  ],
                  [
                    "GET /v1/attest/:address",
                    "$0.01",
                    "the full report plus a signed score AssayRegistry accepts",
                  ],
                  [
                    "GET /v1/address/:address",
                    "free, rate limited",
                    "the full report: revenue split, payers, flags with evidence, identity",
                  ],
                  [
                    "GET /v1/economy",
                    "free",
                    "gross vs organic volume, loops, ratings, review stats, top sellers",
                  ],
                  ["GET /v1/economy/daily?days=120", "free", "volume per UTC day, gross and organic"],
                  ["GET /v1/sellers?sort=organic|gross", "free", "every seller with its rating, paginated"],
                  [
                    "GET /v1/agents?q=&paid=1",
                    "free",
                    "ERC-8004 agents ranked by reviews from paying wallets",
                  ],
                  [
                    "GET /v1/agents/:id",
                    "free",
                    "one agent with its report and every review, each tiered by payment",
                  ],
                  [
                    "GET /v1/agents/:id/payments/:client",
                    "free",
                    "a client's settlements to an agent, for reviewing",
                  ],
                  ["GET /v1/proof/:tx", "free", "a live check of one settlement transaction on Celo"],
                  ["GET /v1/status", "free", "indexed block, lag, relayers, attester and registry"],
                  [
                    "GET /.well-known/agent-registration.json",
                    "free",
                    "Assay's own ERC-8004 registration file",
                  ],
                ].map(([e, p, r]) => (
                  <tr key={e}>
                    <td>
                      <code>{e}</code>
                    </td>
                    <td>{p}</td>
                    <td>{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Errors are JSON with <code>error</code> and <code>message</code>. Bad addresses answer 400 before
            any payment is asked for. The free endpoints allow 60 calls a minute per IP and answer 429 with{" "}
            <code>retry-after</code> after that.
          </p>
        </Panel>

        <Panel title="SDK guard" id="guard">
          <p>
            <code>withAssayGuard</code> wraps any x402 paying fetch. When a seller answers 402, every{" "}
            <code>payTo</code> it offers is checked first; a blocked seller throws{" "}
            <code>AssayBlockedError</code> and nothing is paid. Responses that are not 402 pass through
            untouched.
          </p>
          <Code label="Guarding an x402 client">{`
import { withAssayGuard, AssayBlockedError } from "assayscore";

// npm install assayscore
const guarded = withAssayGuard(fetch, pay, {
  minRating: "BB",        // optional: refuse anything rated below BB
  allowUnrated: true,     // new sellers have to start somewhere
  onAssayError: "allow",  // fail open if Assay is unreachable; "block" to fail closed
});

try {
  await guarded("https://seller.example/api/forecast");
} catch (e) {
  if (e instanceof AssayBlockedError) console.log(e.result.reasons);
}
          `}</Code>
        </Panel>

        <Panel title="MCP server" id="mcp">
          <p>
            Read-only tools for any MCP client: <code>assay_check_seller</code> (with <code>fresh_x</code> to
            buy an X search on the spot when the client can pay), <code>assay_report</code>,{" "}
            <code>assay_independent_payers</code>, <code>assay_find_agents</code> and{" "}
            <code>assay_economy</code>.
          </p>
          <Code label="Add the MCP server to Claude Code">{`
claude mcp add assay -- npx -y assayscore-mcp

# Claude Desktop, Cursor or any MCP client:
# { "mcpServers": { "assay": { "command": "npx", "args": ["-y", "assayscore-mcp"] } } }
          `}</Code>
        </Panel>

        <Panel title="AssayRegistry" id="registry">
          <p>
            A paid check or report includes an EIP-712 <code>Score</code> signed by Assay&rsquo;s attester.
            Anyone can submit it to AssayRegistry on Celo; contracts then read it without trusting an API.
            Scores are valid for 7 days and only a newer score replaces an older one.
          </p>
          <Code label="Gating a contract on an Assay rating">{`
interface IAssayRegistry {
    function isInvestmentGrade(address subject) external view returns (bool); // fresh and BBB or better
    function verify(Score calldata s, bytes calldata signature) external view returns (bool);
}

function payOut(address seller) external {
    require(assay.isInvestmentGrade(seller), "seller not investment grade");
    // ...
}
          `}</Code>
          <p>
            Rating codes run from 1 (D) to 8 (AAA); 0 is not rated. The domain is <code>Assay</code>, version{" "}
            <code>1</code>, chain 42220, verifying contract the registry.
          </p>
        </Panel>

        <Panel title="Payment-verified reviews" id="reviews">
          <p>
            Reviews in the ERC-8004 Reputation Registry cost nothing to write, so most say little. Assay tiers
            every review on Celo:
            <strong> payment proven</strong> when its feedback file names a settlement that Assay finds
            onchain from the reviewer to the agent, <strong>paid customer</strong> when the reviewer paid the
            agent before writing it, and <strong>never paid it</strong> otherwise. Reviews written from an
            agent&rsquo;s page here store their file inline as a <code>data:</code> URI with{" "}
            <code>proofOfPayment</code>, so anyone can check them without Assay.
          </p>
        </Panel>

        <Panel title="Trust model" id="trust">
          <p>
            The rating is computed off-chain, from public Celo data, by open code. What is onchain is the
            check that a score was signed by Assay&rsquo;s attester, is fresh and is about that address:
            AssayRegistry verifies the EIP-712 signature, and contracts call{" "}
            <code>isInvestmentGrade(subject)</code>. The chain proves who issued a score and when, not that it
            is right. What makes it checkable: every signed score records the block and time it was computed
            from, and anyone can replay it from their own node.
          </p>
          <Code label="Verify a signed score from your own node">{`
pnpm --filter @assay/server verify check.json          # the JSON a paid check returned
pnpm --filter @assay/server verify --onchain 0xSeller   # the score in AssayRegistry
# VERIFIED: the signature is Assay's and your node computes the same score.
          `}</Code>
          <p>
            Settlements, which decide gross revenue, are onchain facts every node agrees on. Funding, Self and
            ERC-8004 enrichment decide what counts as organic; the replay says when a difference comes from
            there. There are no manual overrides, paying never changes a rating, and Assay rates itself by the
            same rules on <Link href="/stats">/stats</Link>.
          </p>
          <p>
            <strong>If Assay gets it wrong.</strong> A score sits in a payment path, so a mistake cuts both
            ways. The guard stops a payment only on a <code>block</code> verdict, lets unrated sellers through
            and lets payments through if Assay is unreachable, unless the buyer asks for stricter. Every
            finding links its transactions, sellers can answer any finding in their own words, and a rule that
            misjudges a case is fixed in the open, with a test and a new method version, never with a one-off
            override. Report a wrong rating as a{" "}
            <a className="link" href="https://github.com/Oshioke-Salaki/assay/issues">
              GitHub issue
            </a>
            . The full model is in{" "}
            <a className="link" href="https://github.com/Oshioke-Salaki/assay/blob/main/docs/TRUST.md">
              TRUST.md
            </a>
            .
          </p>
        </Panel>

        <Panel title="Methodology" id="methodology">
          <p>Version {METHODOLOGY_VERSION}. Every x402 settlement on Celo is read from finalized blocks:</p>
          <ul className={docs.list}>
            <li>
              EIP-3009 transfers of USDC, USD₮ and USA₮ that the payer signed and someone else submitted,
              paired with their <code>AuthorizationUsed</code> event;
            </li>
            <li>
              wARS, wBRL and wCOP transfers inside calls to the x402 Permit2 proxy, priced in dollars at that
              day&rsquo;s rate.
            </li>
          </ul>
          <p>Revenue is then assayed. A payment counts as organic unless:</p>
          <ul className={docs.list}>
            <li>
              <strong>It comes back.</strong> Sellers and payers that can reach each other through payments
              form a loop (a strongly connected component). Within a loop only the net inflow counts: money
              the seller sends back to its loop is subtracted from what the loop paid it.
            </li>
            <li>
              <strong>The seller paid for it.</strong> A payer first funded by the seller, or by a wallet the
              seller funded, counts for nothing. Funding sent through a contract (a batch sender, say) is
              credited to whoever called the contract, so routing it through one changes nothing.
            </li>
            <li>
              <strong>It shares the seller&rsquo;s purse.</strong> A payer funded by the seller&rsquo;s own
              private funder, or by a member of its loop, counts for nothing. Exchanges, bridges, contracts
              and very busy wallets are public sources and are ignored, unless they buy or sell over x402
              themselves.
            </li>
          </ul>
          <p>
            The score is{" "}
            <code>100 × quality^1.5 × (0.55 × diversity + 0.45 × track) × dormancy + identity</code>, where
            quality is the organic share, diversity is <code>1 − e^(−payers/6)</code> over effective
            independent payers (an inverse Herfindahl in which wallets with one private funder, or one Self
            human, count once and wallets created only to pay count half), track is{" "}
            <code>1 − e^(−days/10)</code> over days with organic revenue, dormancy is 0.85 after 30 idle days
            and 0.6 after 90, and identity adds up to 8 points for an ERC-8004 identity and a fresh Self
            proof, only when quality is 0.5 or more.
          </p>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {RATING_FLOORS.map(([r]) => (
                    <th key={r}>{r}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {RATING_FLOORS.map(([r, f]) => (
                    <td key={r}>{f}+</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Fewer than {THIN_FILE.minSettlements} settlements, {THIN_FILE.minPayers} payers or $
            {THIN_FILE.minGrossUsd} of revenue is a thin file: the numbers are shown and the rating is NR.
            Funding data is filled in continuously; until a payer is checked it is treated as independent and
            the report says how much is checked. wFIAT days before Assay&rsquo;s first stored rate use the
            earliest stored rate.
          </p>
        </Panel>

        <Panel title="Alerts" id="alerts">
          <p>
            Watch an address and get a signed webhook when something changes: the rating, the pre-payment
            verdict, a new critical finding, or posts with warning words naming it on X. One payment of $0.05
            over x402 covers thirty days; paying again for the same address and URL extends it.
          </p>
          <Code label="Start a watch">{`
POST ${API_PUBLIC}/v1/watch        # x402, $0.05
{ "address": "0xSeller…", "url": "https://your.app/assay-webhook" }

# 201 → { "id": "w_…", "secret": "…", "expiresAt": 1764000000 }
# The first delivery, watch.started, arrives within two minutes.
          `}</Code>
          <p>
            Every delivery is a JSON POST with <code>x-assay-event</code>, <code>x-assay-timestamp</code> and{" "}
            <code>x-assay-signature: sha256=HMAC(secret, timestamp + "." + body)</code>. Check the signature,
            then read <code>event</code>, <code>detail</code>, <code>previous</code> and <code>current</code>.
            A delivery that fails is retried for up to half a day; URLs must be public https, and redirects
            are not followed. <code>GET /v1/watch/:id</code> and <code>DELETE /v1/watch/:id</code> take the
            secret in <code>x-assay-watch-secret</code>.
          </p>
        </Panel>

        <Panel title="Claim your page" id="claim">
          <p>
            If a seller address is yours, open its report and use &ldquo;Claim this page&rdquo;: connect that
            wallet, sign one message (it moves no money), and your name, what you sell, website and X handle
            appear on the report and in the sellers directory. A claim says &ldquo;this wallet&rsquo;s owner
            chose this name&rdquo;; names that read as someone else&rsquo;s are refused. Every address also
            has a badge for READMEs that shows its current rating and links to the report.
          </p>
          <Code label="Badge">{`
[![Assay rating](${API_PUBLIC}/v1/badge/0xYourAddress.svg)](https://assayscore.xyz/address/0xYourAddress)
          `}</Code>
        </Panel>

        <Panel title="Find sellers" id="sellers">
          <p>
            The <Link href="/sellers">sellers directory</Link> lists every x402 seller on Celo, ranked by
            organic revenue, searchable by name, what they sell, category or address, with a rating floor and
            a claimed-only switch. Agents get the same list from{" "}
            <code>GET /v1/sellers?q=&amp;minRating=&amp;category=&amp;claimed=1</code> and the MCP tool{" "}
            <code>assay_find_sellers</code>, so a buyer&rsquo;s agent can pick a reliable seller instead of
            only checking one it already found.
          </p>
        </Panel>

        <Panel title="Raise your rating" id="plan">
          <p>
            Every report with revenue carries &ldquo;What would raise this rating&rdquo;: how many more
            independent customers reach the next rating, what time and activity add, and what identity is
            worth, each computed by running the real score formula on the changed input. It cannot be gamed:
            payers you funded or that share your funder are struck out before anything is scored, so the only
            lever that moves a rating is real customers. Also at <code>GET /v1/address/:address/plan</code>{" "}
            and the MCP tool <code>assay_rating_plan</code>.
          </p>
        </Panel>

        <Panel title="Right of reply" id="reply">
          <p>
            A credit bureau lets you dispute. On your own report, connect the wallet and answer any finding in
            your own words: the response appears under that finding, dated and marked as yours. It never
            changes the score; the finding stays and readers weigh both. Owners of claimed pages also get free
            alerts on their own address, ninety days per signature (<code>POST /v1/respond</code>,{" "}
            <code>POST /v1/watch/own</code>).
          </p>
        </Panel>

        <Panel title="Check a payer" id="payer">
          <p>
            The mirror of the pre-payment check, for sellers. Before a refund, an allowance or credit, paste a
            payer&rsquo;s address on your report: established customer, new wallet, caution or block, with the
            reasons in plain words (age on Celo, who funded it, how many sellers it pays, loop share,
            identity, and how it stands to you). Also at <code>GET /v1/payer/:address?seller=0x…</code> and
            the MCP tool <code>assay_check_payer</code>.
          </p>
        </Panel>

        <Panel title="Independent payers" id="independent">
          <p>
            The Agents on Open Rails hackathon counts a payer only if it is not yours, was not first funded by
            you or your own funder, and was active on Celo before the window started. Assay already traces all
            three, so any team can see how its payers come out under that rule, free, with each payer&rsquo;s
            volume inside the window: on every report, and at <code>GET /v1/independent/:address</code>.
          </p>
        </Panel>

        <Panel title="Pricing and limits" id="pricing">
          <p>
            Reports in the browser and the free endpoints cost nothing, within 60 calls a minute. Paid
            endpoints are $0.002 per check, $0.01 per check with an X search bought now for you (
            <code>/v1/check/:address/x</code>), $0.01 per full report with attestation, and $0.05 for thirty
            days of alerts on one address, paid over x402 through Celo&rsquo;s facilitator in USD₮ by default,
            or USDC, USA₮, or Ripio&rsquo;s wARS, wBRL and wCOP at the day&rsquo;s exchange rate. Nobody needs
            CELO for gas, wFIAT included. The seller pays the facilitator&rsquo;s fee; buyers pay only the
            price.
          </p>
          <p>
            For a payment under a cent, the free report is the right tool: the paid check exists for the
            signature a contract can verify and for evidence fetched on demand. If a paid search cannot be
            bought or does not answer, the API answers 502 or 503 and the x402 payment is not settled.
          </p>
        </Panel>

        <Panel title="Run your own" id="selfhost">
          <p>
            Assay is open source. One process indexes Celo, enriches addresses and serves the API from a
            SQLite file; the web app is a separate Next.js deploy.
          </p>
          <Code label="Running the server">{`
git clone https://github.com/Oshioke-Salaki/assay && cd assay
pnpm install && pnpm build
cp apps/server/.env.example apps/server/.env   # set PAY_TO, X402_API_KEY, ATTESTER_PRIVATE_KEY, REGISTRY_ADDRESS
pnpm --filter @assay/server backfill            # index Celo history once
pnpm --filter @assay/server start               # API + indexer
          `}</Code>
          <p>
            <Link className="link" href="https://github.com/Oshioke-Salaki/assay">
              Source on GitHub
            </Link>
          </p>
        </Panel>
      </div>
    </AppShell>
  );
}
