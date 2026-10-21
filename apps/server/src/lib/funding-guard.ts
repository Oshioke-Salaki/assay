/**
 * Assay must never fund a wallet that pays it. By Assay's own rules (and the hackathon's), a
 * payer first funded by the seller is seller-funded: its payments are struck from organic
 * revenue and do not count as independent use. The operator CLI checks every outgoing transfer
 * against this before sending.
 */
export function hasPaid(counterparties: readonly { payee: string }[], payTo: string): boolean {
  const p = payTo.toLowerCase();
  return counterparties.some((c) => c.payee.toLowerCase() === p);
}

export function fundingRefusal(to: string): string {
  return `Refusing to send to ${to}: it has paid Assay. Funding it would make its payments seller-funded, which Assay strikes out and the hackathon does not count. Point people to the USA₮ faucet instead.`;
}

export const FUNDING_NOTE =
  "note: a wallet Assay funds can never count as an independent customer. Fund only Assay's own operational wallets.";
