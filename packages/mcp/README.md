# assayscore-mcp

An MCP server that lets an AI agent check a Celo x402 seller or ERC-8004 agent with [Assay](https://assayscore.xyz) before it pays.

## Add it

Claude Code:

```sh
claude mcp add assay -- npx -y assayscore-mcp
```

Claude Desktop, Cursor or any MCP client (`mcpServers` in its config):

```json
{
  "mcpServers": {
    "assay": { "command": "npx", "args": ["-y", "assayscore-mcp"] }
  }
}
```

It talks to the public Assay API. To use your own deployment, set `ASSAY_URL`.

## Tools

All tools are read-only and free. The server never holds a wallet.

| Tool | What it answers |
| --- | --- |
| `assay_check_seller` | pass, caution or block for a Celo address, with rating, organic revenue share, reasons and what X says. Call it before paying an unfamiliar x402 seller. With a paying client, `fresh_x: true` buys an X search for the address on the spot ($0.01). |
| `assay_find_sellers` | reliable sellers on Celo, searchable by name, what they sell, category or address, with a minimum rating. |
| `assay_rating_plan` | what would raise a seller's rating: customers needed for the next rating, time, activity and identity, and what is struck out. |
| `assay_independent_payers` | which of a seller's payers count as independent users by the hackathon's rule, with reasons and volume in the window. |
| `assay_report` | the full report: organic and circular revenue, payers, payment loops, funding, identity. |
| `assay_find_agents` | ERC-8004 agents on Celo, searchable, with payment-verified review counts. |
| `assay_economy` | totals for the whole Celo x402 economy. |

MIT
