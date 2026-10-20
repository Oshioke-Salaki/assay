import {
  type Address,
  type Assessment,
  ATTESTATION_TTL_SECONDS,
  ATTESTATION_TYPES,
  attestationDomain,
  RATING_CODES,
  toMicros,
} from "@assay/core";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface SignedAttestation {
  domain: ReturnType<typeof attestationDomain>;
  types: typeof ATTESTATION_TYPES;
  primaryType: "Score";
  /** Integers as decimal strings so the JSON round-trips without bigint support. */
  message: Record<string, string | number>;
  signature: Hex;
  signer: Address;
}

export class Attester {
  private readonly account;

  constructor(
    privateKey: Hex,
    private readonly registry: Address,
  ) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address.toLowerCase() as Address;
  }

  async sign(
    a: Assessment,
    asOfBlock: number,
    now = Math.floor(Date.now() / 1000),
  ): Promise<SignedAttestation> {
    const gross = toMicros(a.seller.grossUsd);
    const organic = toMicros(a.seller.organicUsd);
    const message = {
      subject: a.address,
      score: a.score ?? 0,
      rating: RATING_CODES[a.rating],
      // AssayRegistry rejects organic > gross; never let float rounding produce that.
      organicUsdMicros: organic > gross ? gross : organic,
      grossUsdMicros: gross,
      effectivePayersX100: Math.min(2 ** 32 - 1, Math.round((a.components?.effectivePayers ?? 0) * 100)),
      asOfBlock: BigInt(Math.max(0, asOfBlock)),
      issuedAt: BigInt(now),
      expiresAt: BigInt(now + ATTESTATION_TTL_SECONDS),
    };
    const domain = attestationDomain(this.registry);
    const signature = await this.account.signTypedData({
      domain,
      types: ATTESTATION_TYPES,
      primaryType: "Score",
      message,
    });
    return {
      domain,
      types: ATTESTATION_TYPES,
      primaryType: "Score",
      message: Object.fromEntries(
        Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
      ),
      signature,
      signer: this.address,
    };
  }
}
