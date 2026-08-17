import type { X402PaymentPayload, X402PaymentRequirements, X402TokenConfig } from "../../shared/x402";
import type { SolanaX402PaymentPayload, SolanaX402PaymentRequirements } from "../../shared/x402Solana";
import type { PrivateAgentEndpoint, X402PayInput } from "../agents/PrivateAgentRegistry";
import type { X402Settlement, X402SettlementMode } from "../base/X402Facilitator";
import type { ConfidentialEncryptionPubKey } from "../../shared/x402SolanaConfidential";

export interface ChainRailSettleResult {
  settlement: X402Settlement;
  stealth?: { stealthAddress: string; ephemeralPubKey: string };
}

export interface ChainRailRecipient {
  recipient: string;
  stealth?: { stealthAddress: string; ephemeralPubKey: string };
  /**
   * Confidential recipients need an encryption pubkey alongside the address
   * (spec-confidential-x402.md B2) — a separate field, never an overload of
   * `recipient`, so no existing caller can silently receive one.
   *
   * BRANDED on purpose. A Solana address and an ElGamal pubkey are both bare
   * 32-byte values, so a plain `string` here would let a stealth address be
   * passed as an encryption key with a clean typecheck — and ~1% of ed25519
   * points are silently ACCEPTED by `ElGamalPubkey.fromBytes`, encrypting funds
   * to a key nobody holds. The brand is the only thing standing between that
   * mistake and unrecoverable loss.
   */
  confidential?: { encryptionPubKey: ConfidentialEncryptionPubKey };
}

/**
 * What an observer of OUR OWN server can learn about a stealth output's balance
 * (spec-confidential-x402.md B2/§4).
 *
 * This is a tri-state and not a `bigint` on purpose. A confidential output's
 * plaintext on-chain balance is zero by construction, so **there is no number
 * that honestly represents it** — and encoding it as `0n` is what produced the
 * B3 fund-loss bug, where the inbox read that zero as "provably empty", marked
 * the record dormant, and reaped away the only copy of the announcement. The
 * type refuses to offer the lie.
 */
export type ConfidentialObservation =
  | { kind: "plaintext"; amountAtomic: bigint }
  /** An entry exists; its value is NOT knowable. A commitment to zero is still a commitment. */
  | { kind: "ciphertext-present" }
  /** Provably nothing was ever created here. */
  | { kind: "no-account" }
  /** RPC failure. NEVER treat as empty — it is not evidence of anything. */
  | { kind: "unknown" };

export interface ChainRailPreparedPayout {
  network: string;
  recipient: string;
  amountAtomic: string;
  mode: "dry-run" | "onchain";
  signedTx?: string;
  txId?: string;
  nonce?: number;
  lastValidBlockHeight?: number;
  contextSlot?: number;
}

export type ChainRailPayoutVerdict =
  // `blockNumber` (EVM block / Solana slot) is the §2.9 H11 landing coordinate:
  // realized k_eff is computed over members that landed, and without WHERE they
  // landed a cohort split across a temporal partition (nonce gap, cross-kind
  // wedge, quarantine-park) still reports full K. Optional because a verdict
  // recorded before this field existed — or an operator disposition without an
  // archival receipt — has no honest value to put here, and consumers must
  // treat absence as "unmeasured", never as "tight".
  | { status: "landed"; transactionHash: string; blockNumber?: number }
  // Mined into a canonical block and successful, but the chain's finality
  // criterion has not reached it yet. Distinct from "uncertain": the outcome is
  // KNOWN and the leg is simply still in flight. Collapsing the two strands a
  // healthy payout behind operator disposition.
  | { status: "included"; transactionHash: string }
  // Zero on-chain evidence, but the leg's OWN liveness bound has not expired —
  // the dispatch grace age on EVM, blockhash validity on Solana. Absence here is
  // EXPECTED (the ordinary mine latency), not ambiguous, and it is not new
  // information: consumers must leave the leg exactly as it is. Writing journal
  // `uncertain` for this state is the H7 flap (spec-cohort-dispatch.md §2.4) —
  // every reconcile pass landing inside the mine latency promotes a healthy
  // group into operator disposition. Self-resolves: evidence appears, or the
  // bound expires and the same inputs classify uncertain / terminal-absent.
  | { status: "pending" }
  | { status: "terminal-absent" }
  | { status: "uncertain"; detail: string };

export interface ChainRailDepositAddress {
  stealthAddress: string;
  ephemeralPubKey: string;
  derivationIndex: number;
  keyVersion: string;
}

export interface ChainRailSweepResult {
  outcome: "confirmed" | "empty" | "submitted-unconfirmed" | "not-capable";
  transactionHash?: string;
  sweepNonce?: string;
  observedAmountAtomic: string;
}

export interface ChainRailSweepTxStatus {
  state: "confirmed-success" | "confirmed-failed" | "pending" | "unknown";
}

export interface ChainRailRelayResult {
  mode: "dry-run" | "onchain";
  transactionHash?: string;
  /**
   * How far the broadcast got. `included` means mined and canonical but not yet
   * covered by the finality tag — a success, not a failure, and the distinction
   * matters because the depositor's EIP-3009 authorization is already spent.
   * See `X402Settlement.standing`.
   */
  standing?: "final" | "included" | "submitted";
  reason?: string;
  from: string;
  value: string;
}

export interface ChainRail {
  readonly network: string;
  readonly kind: "evm" | "solana";
  readonly tokenConfig: X402TokenConfig;
  readonly settlementMode: X402SettlementMode;
  readonly poolMode: X402SettlementMode;
  readonly poolAddress: string;
  readonly depositCapable: boolean;

  deriveDepositAddress(index: number): ChainRailDepositAddress;

  observedBalanceAtomic(input: { stealthAddress: string }): Promise<bigint>;

  /**
   * Broadcast a depositor-signed gasless authorization so a stealth output can
   * be swept without ever holding native gas. EVM-only (EIP-3009); Solana needs
   * a partially-signed transferChecked instead and is phase 3, so this is
   * optional and the caller must feature-detect it.
   */
  relayDeposit?(input: {
    payload: X402PaymentPayload;
    expectedFrom: string;
    expectedTo: string;
    expectedValueAtomic: string;
    ref: string;
    nowSeconds: number;
  }): Promise<ChainRailRelayResult>;

  sweepDeposit(input: {
    derivationIndex: number;
    keyVersion: string;
    caip2: string;
    tokenAddress: string;
    expectedStealthAddress: string;
    poolAddress: string;
    nowSeconds: number;
    confirmations: number;
    reuseSweepNonce?: string;
  }): Promise<ChainRailSweepResult>;

  sweepTxStatus(input: { transactionHash: string }): Promise<ChainRailSweepTxStatus>;

  buildQuote(input: {
    payee: PrivateAgentEndpoint;
    amountAtomic: string;
    resource: string;
    validForSeconds: number;
    nowSeconds: number;
  }): X402PaymentRequirements | SolanaX402PaymentRequirements;

  ownsPayment(payment: X402PaymentPayload | SolanaX402PaymentPayload): boolean;

  paymentNonce(input: X402PayInput): string | undefined;

  resolveRecipient(input: {
    requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
    payee: PrivateAgentEndpoint;
    ephemeralPubKey?: string;
  }): ChainRailRecipient;

  submitPoolPayout(input: {
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
    logicalId: string;
  }): Promise<ChainRailPreparedPayout>;

  preparePoolPayout(input: {
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
    logicalId: string;
  }): Promise<ChainRailPreparedPayout>;

  broadcastPoolPayout(
    prepared: ChainRailPreparedPayout,
  ): Promise<{ txId: string; submitted: boolean }>;

  poolPayoutStatus(prepared: ChainRailPreparedPayout): Promise<ChainRailPayoutVerdict>;

  operatorPoolPayoutStatus(prepared: ChainRailPreparedPayout): Promise<ChainRailPayoutVerdict>;

  outboxEntriesByRef(ref: string): { logicalId: string; nonce: number }[];

  classifyByLogicalId(input: {
    logicalId: string;
    nonce: number;
  }): Promise<ChainRailPayoutVerdict>;

  recoverOutbox(): Promise<void>;

  /**
   * §2.2 non-blocking cohort dispatch (EVM only). Signs, WAL-writes, and
   * broadcasts every input under ONE settler-lease acquisition and returns
   * WITHOUT waiting for finality — "dispatched" means durable identity plus a
   * first broadcast attempt, and the caller's reconcile pass finishes the leg.
   * Throws SettlerQuarantinedError synchronously when the settler is
   * quarantined (§2.5: delay, never a failed attempt). `failures` carries
   * per-leg pre-dispatch failures (e.g. simulation) keyed by logicalId.
   */
  dispatchPoolPayouts?(inputs: {
    logicalId: string;
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
  }[]): Promise<{
    outcomes: import("../base/TransactionCoordinator").DispatchOutcome[];
    failures: Map<string, string>;
  }>;

  /**
   * §2.3 maintain — liveness owner for a dispatched-but-unfinished EVM leg:
   * rebroadcast, fee-bump under a try-lease, per-entry deadline quarantine.
   * The reconcile's own verdict is passed through so classification is not
   * duplicated (H6). No-op on rails without a coordinator.
   */
  maintainPoolPayout?(input: {
    logicalId: string;
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
    verdict?: ChainRailPayoutVerdict;
  }): Promise<void>;

  /**
   * True when this network's settler is quarantined, meaning a submission would
   * park behind operator disposition. A caller that owns a durable queue should
   * treat this as DELAY — skip the flush entirely, zero writes, leg stays
   * byte-identical — never as a failed attempt (spec-cohort-dispatch.md §2.5;
   * the frozen rule is delay, never refuse). Optional: rails without a settler
   * quarantine concept (Solana's WAL model, dry-run) omit it.
   */
  settlerQuarantined?(): boolean;

  suppressPoolPayoutRebroadcast(logicalId: string): void;

  bindPoolPayoutRef(logicalId: string, payoutRef: string): void;

  finalizedBlockHeight(): Promise<number | undefined>;

  settle(input: {
    payment: X402PaymentPayload | SolanaX402PaymentPayload;
    requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
    payee: PrivateAgentEndpoint;
    ephemeralPubKey?: string;
    nowSeconds: number;
  }): Promise<ChainRailSettleResult>;
}

/**
 * Optional confidential-scheme capability (spec-confidential-x402.md §4).
 *
 * Optional exactly like `relayDeposit`: a rail that does not implement it is
 * REFUSED with a reason, never crashed. `confidentialMode` is resolved state —
 * dry-run until the asset is deployed, asserted, and a settler key exists — and
 * a quote never advertises `confidential` unless it is capable AND the payee
 * carries a stealth meta-address. Confidential without stealth is a half-measure
 * that publishes a persistent receiver, so it is refused at quote time.
 */
export interface ConfidentialRail {
  /**
   * Resolved capability. NOT a live per-call value — the interface forbids a
   * promise here — and NOT a plain ctor constant either, because one of the
   * conjuncts ("the mint exists and its auditor key is null") is an async RPC
   * fact. Implementations resolve it during an explicit async assertion at
   * startup and expose the cached result; before that assertion runs it MUST
   * read `dry-run`, so a mint we have not verified can never serve traffic.
   */
  readonly confidentialMode: X402SettlementMode;
  /**
   * Resolves the one-time recipient and its encryption pubkey.
   *
   * SYNCHRONOUS AND SIDE-EFFECT FREE, deliberately. `PrivateAgentRegistry`
   * relies on `resolveRecipient` having exactly that property: it resolves once
   * to write-ahead the stealth announcement BEFORE settle can broadcast, then
   * lets `settle` recompute the same value for free. An async or impure
   * resolver silently turns that into two RPCs — or two different answers — per
   * payment, and the announcement write-ahead is the load-bearing step that
   * stops a crash from stranding funds permanently. Account creation is the
   * async part and lives in `ensureConfidentialAccount`, which is why
   * `ChainRailRecipient.confidential` carries no `accountExists`.
   */
  resolveConfidentialRecipient(input: {
    requirements: unknown;
    payee: PrivateAgentEndpoint;
    ephemeralPubKey?: string;
  }): ChainRailRecipient;
  /**
   * Asserts the recipient's confidential account is usable.
   *
   * Named `ensure` to match the EVM shape, but on Solana it can only ever
   * VERIFY: configuring a confidential account requires the owner's signature
   * (measured — `Missing required signature for instruction #2`), and the owner
   * is a one-time stealth key the server does not hold. The account is stood up
   * ahead of time by the payee when it provisions the slot, so a missing account
   * here is a pool-depth problem, not something this call can repair.
   */
  ensureConfidentialAccount(input: { recipient: ChainRailRecipient }): Promise<void>;
  /**
   * Off-chain checks only — payload shape, and every binding re-derived from the
   * QUOTE rather than read from the payload.
   */
  verifyConfidential(input: {
    payload: unknown;
    requirements: unknown;
  }): Promise<{ ok: boolean; reason?: string }>;
  /** eth_call / simulateTransaction. Never spends gas; always run before broadcast. */
  simulateConfidential(input: {
    payload: unknown;
    requirements: unknown;
  }): Promise<{ ok: boolean; reason?: string }>;
  settleConfidential(input: {
    payload: unknown;
    requirements: unknown;
    /**
     * Durable announcement write, awaited before the first broadcast.
     *
     * A required parameter, not a convention the caller is trusted to observe:
     * without `R` the payee cannot derive its one-time key OR locate the
     * address, so an announcement lost between broadcast and index-write strands
     * the funds permanently. Making it an argument means the ordering cannot be
     * forgotten at a call site.
     */
    writeAheadAnnouncement: () => Promise<void>;
  }): Promise<ChainRailSettleResult>;
  /** See `ConfidentialObservation` — deliberately not a balance. */
  observeConfidential(input: { stealthAddress: string }): Promise<ConfidentialObservation>;
}

/** Narrowing helper so callers cannot reach confidential paths on an incapable rail. */
export const isConfidentialRail = (rail: ChainRail): rail is ChainRail & ConfidentialRail =>
  typeof (rail as Partial<ConfidentialRail>).settleConfidential === "function"
  && typeof (rail as Partial<ConfidentialRail>).observeConfidential === "function";

/**
 * The settler half of the slot-provisioning ceremony (§5.2-P).
 *
 * Separate from `ConfidentialRail` because a rail can be able to SETTLE
 * confidential payments without being able to provision slots — provisioning
 * needs a funded settler, settling does not.
 */
export interface ConfidentialProvisioningRail {
  /** The Token-2022 mint this rail's confidential slots belong to. */
  readonly confidentialMint: string;
  provisionConfidentialSlots(input: {
    transactions: string[];
    addresses: string[];
  }): Promise<{
    status: "provisioned" | "refused";
    signatures: string[];
    detail?: string;
    /**
     * What the CHAIN says, per address, read back after confirmation. The
     * caller compares this against the payee's claims — it must never be
     * populated from those claims.
     */
    onchain: { stealthAddress: string; tokenAccount: string; encryptionPubKey?: string }[];
  }>;
}

/**
 * Structural, not `instanceof`.
 *
 * A concrete-class check would make every rail in this system a nominal type,
 * which is precisely what the rest of the file avoids — and it silently fails
 * for any decorated, proxied, or test rail that satisfies the contract
 * perfectly well.
 */
export const isConfidentialProvisioningRail = (
  rail: ChainRail,
): rail is ChainRail & ConfidentialRail & ConfidentialProvisioningRail =>
  isConfidentialRail(rail)
  && typeof (rail as Partial<ConfidentialProvisioningRail>).provisionConfidentialSlots === "function"
  && typeof (rail as Partial<ConfidentialProvisioningRail>).confidentialMint === "string";
