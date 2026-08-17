/**
 * Solana `confidential` x402 wire types (spec-confidential-x402.md §3, §5).
 *
 * SPL Token-2022 confidential transfers hide the AMOUNT (ElGamal ciphertext +
 * ZK range proofs); our DKSAP one-time stealth address hides the RECEIVER. The
 * join between them is that the one-time stealth SCALAR signs the
 * domain-separated ElGamal/AE seed messages, so the confidential-balance keys
 * are derivable by exactly one party — and nothing beyond the ephemeral pubkey
 * `R` we already carry in the announcement is transmitted. Proven live on
 * devnet (spec-confidential-x402.md §14.2; the research spike tree is not part
 * of this repo).
 *
 * DELIBERATELY DEPENDENCY-FREE. This module imports only types. The confidential
 * runtime stack is WASM-backed and server-only, and nothing under `src/client`
 * may pull it in — so the wire contract
 * lives here where it is safe to import from anywhere, and the heavy work lives
 * in the rail.
 */
import type { SolanaStealthMetaAddress } from "./stealthSolana";
import type { PayoutPolicyAdvertisement } from "./payoutPlan";

/**
 * Quote for a confidential Solana payment.
 *
 * `stealthMetaAddress` is REQUIRED, unlike the `exact` requirements where it is
 * optional (§3.2). Confidential-without-stealth hides the value but pays a
 * persistent, reusable address — which publishes exactly the linkage the rest of
 * the stack exists to remove, and buys a false sense of privacy while doing it.
 * It is refused at quote time rather than at pay time so a payer never builds
 * proofs for a payment we would reject.
 */
export interface SolanaConfidentialRequirements {
  x402Version: 1;
  scheme: "confidential";
  network: "solana";
  /** Token-2022 mint carrying the `ConfidentialTransferMint` extension. */
  asset: string;
  /** The one-time stealth address that will own the confidential account. */
  payTo: string;
  /**
   * Atomic units. Both parties to a payment necessarily know the amount — the
   * property being bought is that it never reaches the CHAIN. Keeping it in the
   * quote is what lets the payer build the range proof.
   */
  maxAmountRequired: string;
  resource: string;
  description?: string;
  nonce: string;
  validForSeconds: number;
  stealthMetaAddress: SolanaStealthMetaAddress;
  /**
   * The announcement `R`, chosen by the PAYEE — the one place this rail inverts
   * the `exact` flow.
   *
   * Nothing in DKSAP requires the payer to pick `R`, and here it cannot: only
   * the owner of a confidential account may configure it (measured on devnet —
   * `Missing required signature for instruction #2`), so the payee has to derive
   * the one-time address and stand the account up itself, before any payer
   * exists. The quote therefore publishes a slot the payee already provisioned
   * rather than describing one the payer is about to create.
   */
  ephemeralPubKey: string;
  /**
   * The slot's ElGamal encryption key `P`, base58 of `ElGamalPubkey.toBytes()`.
   *
   * NOT the stealth address and not derivable from it: `P = s⁻¹·H` on
   * Ristretto255 while the address is `s·G` on ed25519, so recovering one from
   * the other is a discrete log. They are nonetheless both bare 32-byte values,
   * which is why the rail brands this the moment it leaves the wire.
   */
  encryptionPubKey: string;
  /** The slot's confidential token account — the ATA this payment credits. */
  destinationTokenAccount: string;
  payoutPolicy?: PayoutPolicyAdvertisement;
}

export interface SolanaConfidentialPayload {
  x402Version: 1;
  scheme: "confidential";
  network: "solana";
  asset: string;
  payer: string;
  /**
   * The ORDERED plan, base64, each partially signed by the payer.
   *
   * Not a single transaction — measured at FIVE on devnet. A confidential
   * transfer's ZK proofs do not fit beside the transfer, so the plan stands up
   * three proof-context accounts across four transactions and only then
   * transfers and closes them. The order is load-bearing: transaction N+1 reads
   * accounts transaction N creates, which is also why the server simulates each
   * one immediately before its own broadcast rather than all of them up front.
   *
   * The settler is fee payer on every one and co-signs, so the stealth recipient
   * never needs SOL — and, because the plan builder defaults the proof-context
   * authority to the fee payer, the settler can also reclaim the context rent
   * alone when a transfer fails.
   */
  transactions: string[];
  /**
   * THE announcement. The payee's one-time key is `kSpend + H(kView·R)`, so
   * without `R` they cannot derive it or even locate the address. This must be
   * write-ahead indexed into `InboundAnnouncementBook` BEFORE the transfer can
   * broadcast — a crash in between strands the funds permanently.
   */
  ephemeralPubKey: string;
  /** The recipient's confidential ATA this transfer credits. */
  destinationTokenAccount: string;
}

const isBase58 = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/**
 * Upper bound on plan length. The measured confidential transfer plan is five
 * transactions; this leaves headroom for a proof layout change without letting a
 * malformed payload hand the settler an unbounded batch to decode and co-sign.
 */
export const MAX_CONFIDENTIAL_PLAN_TRANSACTIONS = 12;

/**
 * A destination ElGamal encryption key — **nominally distinct from an address.**
 *
 * This brand exists because of a measured footgun, not for tidiness.
 * `@solana-program/token-2022`'s `getElGamalPubkeyFromAddress` is literally
 * `ElGamalPubkey.fromBytes(getAddressEncoder().encode(value))`, so it reuses
 * kit's `Address` type as a bare 32-byte container. To TypeScript, a Solana
 * address and an ElGamal pubkey are the SAME TYPE, and passing a stealth
 * address where `destinationElgamalPubkey` belongs type-checks cleanly.
 *
 * It is not caught at runtime either: feeding 200 genuine ed25519 point
 * encodings to `ElGamalPubkey.fromBytes` rejected 198 and **silently accepted
 * 2**. So roughly 1% of the time that mistake produces a valid-looking key that
 * nobody holds the secret for — funds encrypted to nothing, unrecoverable, with
 * no error anywhere.
 *
 * The two are also mathematically unrelated: a stealth address is `s·G` on
 * ed25519, while an ElGamal pubkey is `s⁻¹·H` on Ristretto255 with `H` a fixed
 * Pedersen generator (measured, §5 correction). One can never stand in for the
 * other.
 */
export type ConfidentialEncryptionPubKey = string & {
  readonly __confidentialEncryptionPubKey: unique symbol;
};

/**
 * The ONLY way to obtain a `ConfidentialEncryptionPubKey`. Callers must pass
 * bytes that came from `ElGamalPubkey.toBytes()`, never an address — the brand
 * makes that intent explicit at every call site and un-inferrable by accident.
 */
export const asConfidentialEncryptionPubKey = (
  base58: string,
): ConfidentialEncryptionPubKey => {
  if (!isBase58(base58)) {
    throw new ConfidentialPaymentError("confidential_malformed", "encryption pubkey");
  }
  return base58 as ConfidentialEncryptionPubKey;
};

/** Every reason a confidential payment can be refused, as opaque codes. */
export type ConfidentialRejection =
  | "confidential_not_supported"
  | "confidential_requires_stealth"
  | "confidential_scheme_mismatch"
  | "confidential_malformed"
  | "confidential_amount_invalid";

export class ConfidentialPaymentError extends Error {
  constructor(readonly code: ConfidentialRejection, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ConfidentialPaymentError";
  }
}

/**
 * Validates a confidential quote. Pure — no chain access, no crypto — so it can
 * run on either side of the channel and in tests.
 */
export const assertSolanaConfidentialRequirements = (
  value: unknown,
): SolanaConfidentialRequirements => {
  const r = value as Partial<SolanaConfidentialRequirements>;
  if (r?.scheme !== "confidential" || r.network !== "solana" || r.x402Version !== 1) {
    throw new ConfidentialPaymentError("confidential_scheme_mismatch");
  }
  if (!isBase58(r.asset) || !isBase58(r.payTo)) {
    throw new ConfidentialPaymentError("confidential_malformed", "asset/payTo");
  }
  // §3.2 — the rule that makes this rail worth shipping at all.
  const meta = r.stealthMetaAddress;
  if (!meta || !isBase58(meta.spendingPubKey) || !isBase58(meta.viewingPubKey)) {
    throw new ConfidentialPaymentError("confidential_requires_stealth");
  }
  // The published §5.2-P slot. A quote missing any of these describes a payment
  // the payer cannot build and the payee could never locate.
  if (!isBase58(r.ephemeralPubKey)) {
    throw new ConfidentialPaymentError("confidential_requires_stealth", "ephemeralPubKey");
  }
  if (!isBase58(r.encryptionPubKey)) {
    throw new ConfidentialPaymentError("confidential_malformed", "encryptionPubKey");
  }
  if (!isBase58(r.destinationTokenAccount)) {
    throw new ConfidentialPaymentError("confidential_malformed", "destinationTokenAccount");
  }
  let amount: bigint;
  try {
    amount = BigInt(r.maxAmountRequired as string);
  } catch {
    throw new ConfidentialPaymentError("confidential_amount_invalid", "not an integer");
  }
  if (amount <= 0n) {
    throw new ConfidentialPaymentError("confidential_amount_invalid", "must be positive");
  }
  if (typeof r.nonce !== "string" || !r.nonce) {
    throw new ConfidentialPaymentError("confidential_malformed", "nonce");
  }
  if (!Number.isFinite(r.validForSeconds) || (r.validForSeconds as number) <= 0) {
    throw new ConfidentialPaymentError("confidential_malformed", "validForSeconds");
  }
  return r as SolanaConfidentialRequirements;
};

/**
 * Validates a confidential payment envelope. Deliberately does NOT decode the
 * transaction — that needs the Token-2022 stack and belongs in the rail, which
 * re-derives every binding from the QUOTE rather than trusting this payload.
 */
export const assertSolanaConfidentialPayload = (
  value: unknown,
): SolanaConfidentialPayload => {
  const p = value as Partial<SolanaConfidentialPayload>;
  if (p?.scheme !== "confidential" || p.network !== "solana" || p.x402Version !== 1) {
    throw new ConfidentialPaymentError("confidential_scheme_mismatch");
  }
  if (!isBase58(p.asset) || !isBase58(p.payer)) {
    throw new ConfidentialPaymentError("confidential_malformed", "asset/payer");
  }
  if (!Array.isArray(p.transactions) || p.transactions.length === 0) {
    throw new ConfidentialPaymentError("confidential_malformed", "transactions");
  }
  // A cheap ceiling so a malformed payload cannot make the settler decode an
  // unbounded batch. The measured plan is 5; the rail re-checks this too.
  if (p.transactions.length > MAX_CONFIDENTIAL_PLAN_TRANSACTIONS) {
    throw new ConfidentialPaymentError("confidential_malformed", "transactions: over plan cap");
  }
  if (p.transactions.some((tx) => typeof tx !== "string" || tx.length === 0)) {
    throw new ConfidentialPaymentError("confidential_malformed", "transactions: empty entry");
  }
  if (!isBase58(p.ephemeralPubKey)) {
    // Losing this loses the funds — it is not an optional field.
    throw new ConfidentialPaymentError("confidential_malformed", "ephemeralPubKey");
  }
  if (!isBase58(p.destinationTokenAccount)) {
    throw new ConfidentialPaymentError("confidential_malformed", "destinationTokenAccount");
  }
  return p as SolanaConfidentialPayload;
};

/**
 * The ElGamal/AE keypair seed for a confidential account (§5.2).
 *
 * Both halves are PUBLIC (`stealthAddress ‖ mint`); the secrecy comes entirely
 * from who can sign the resulting message with the one-time stealth scalar. This
 * is why the payee needs nothing beyond `R` to take control of the balance, and
 * why no long-lived key ever touches the wire.
 */
export const confidentialKeySeedParts = (input: {
  stealthAddress: string;
  mint: string;
}): { stealthAddress: string; mint: string } => {
  if (!isBase58(input.stealthAddress) || !isBase58(input.mint)) {
    throw new ConfidentialPaymentError("confidential_malformed", "seed parts");
  }
  return { stealthAddress: input.stealthAddress, mint: input.mint };
};
