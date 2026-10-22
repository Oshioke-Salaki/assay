# Assay, for Celo Core Co. and Prezenti

One page. Numbers are read from the API on the day it is sent; refresh them first.

## What Assay is

Assay is the credit bureau for agent payments on Celo. It reads every x402 settlement on mainnet (861,785 as of 22 Oct 2026), traces where each payer's money came from, and rates every seller AAA to D on revenue from buyers it does not control. Agents check a seller before paying it; sellers claim their page, see what would raise their rating, and answer findings in their own words. Live at assayscore.xyz; open source; `npm i assayscore`; an MCP server for any coding agent.

## What it found

Of $203K settled over x402 on Celo, 19.6% is organic. $125K was paid by wallets the sellers funded themselves, traced to the first transfer that funded each payer; $29K more went round in nine payment loops, the largest 378 wallets paying each other. 138 of 661 sellers rate D; 19 rate B or better. These are the numbers behind Celo's own x402 dashboards, and they are checkable transaction by transaction.

## Why this matters to Celo

Celo's bet is that agents will pay each other on open rails. That only holds if the rails carry a trust signal, otherwise the first thing agents learn is that volume can be faked for a fraction of a cent. Assay is that signal, built on Celo's stack end to end: x402 through the Celo facilitator (USD₮, USDC, USA₮, wARS, wBRL, wCOP, gasless), ERC-8004 identity, Self proofs, Celo Agent Visa tiers, the SQD portal, Chainstack RPC.

## Three things we can do together now

1. **Integrity for ecosystem programmes.** The Agents on Open Rails hackathon defines an independent user as a wallet that is not the project's, was not funded by it or its funder, and was active on Celo before the window. Assay already applies that rule to any PayTo address, free, at `/v1/independent/:address`, with reasons per payer and volume in the window. The same query can score every entry, every grant milestone, every Builder Graph rating.
2. **A trust header on the facilitator.** If x402.celo.org returned a seller's Assay verdict with every 402 quote, every agent payment on Celo would pass through a check without integrating anything.
3. **A verified-seller filter for Aigora and agent marketplaces.** "Rated BBB or better by Assay" as a listing filter, from the directory at assayscore.xyz/sellers.

## Where it goes

Assay rates agents today. Next, Assay Ledger keeps their books (statements, counterparties, retention) on the same data; later, credit against organic receivables. Same engine, three products, all on Celo.

## What we ask

Prezenti: a grant to run Assay as public infrastructure for twelve months (hosting, data, one engineer) and to build the facilitator header and the programme-scoring query with Celo Core Co.

Everything Assay earns and spends is public at assayscore.xyz/stats, including its own rating by its own rules.

Contact: Oshioke Salaki · github.com/Oshioke-Salaki/assay
