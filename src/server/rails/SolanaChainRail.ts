import type { X402PaymentPayload, X402PaymentRequirements } from "../../shared/x402";
import { buildSolanaAgentQuote, type SolanaX402PaymentPayload, type SolanaX402PaymentRequirements } from "../../shared/x402Solana";
import { checkSolanaStealthAddress } from "../../shared/stealthSolana";
import { solanaKeyVersion, type TreasuryKeyContext } from "../../shared/depositStealth";
import {
  asConfidentialEncryptionPubKey,
  assertSolanaConfidentialPayload,
  assertSolanaConfidentialRequirements,
  ConfidentialPaymentError,
} from "../../shared/x402SolanaConfidential";
import type { SolanaX402Facilitator } from "../base/SolanaX402Facilitator";
import type { X402SettlementMode } from "../base/X402Facilitator";
import { assertConfidentialMint } from "./confidentialMint";
import { SolanaConfidentialSettler } from "./SolanaConfidentialSettler";
import type {
  ChainRail,
  ChainRailPayoutVerdict,
  ChainRailPreparedPayout,
  ChainRailRecipient,
  ChainRailSettleResult,
  ConfidentialObservation,
  ConfidentialRail,
} from "./ChainRail";

export class SolanaChainRail implements ChainRail {
  readonly kind = "solana" as const;
  protected readonly facilitator: SolanaX402Facilitator;
  protected readonly treasury: string;
  readonly poolMode: "dry-run" | "onchain";

  constructor({
    facilitator,
    treasury = "",
    poolPayoutEnabled = false
  }: {
    facilitator: SolanaX402Facilitator;
    treasury?: string;
    poolPayoutEnabled?: boolean;
  }) {
    this.facilitator = facilitator;
    this.treasury = treasury;
    const settlerMatchesTreasury = Boolean(
      treasury && facilitator.settlerPubkey.toBase58() === treasury
    );
    this.poolMode = poolPayoutEnabled && facilitator.hasSettlerKey && settlerMatchesTreasury
      ? "onchain"
      : "dry-run";
    if (poolPayoutEnabled && facilitator.hasSettlerKey && treasury && !settlerMatchesTreasury) {
      console.warn(`POOL_PAYOUT_DRY_RUN network=${facilitator.tokenConfig.network} reason=settler_pool_mismatch`);
    }
  }

  get network() {
    return this.facilitator.tokenConfig.network;
  }

  get tokenConfig() {
    return this.facilitator.tokenConfig;
  }

  get settlementMode() {
    return this.facilitator.mode;
  }

  get poolAddress() {
    return this.treasury;
  }

  get depositCapable() {
    return Boolean(
      this.facilitator.hasSettlerKey
      && this.treasury
      && this.facilitator.settlerPubkey.toBase58() === this.treasury,
    );
  }

  deriveDepositAddress(index: number) {
    if (!this.depositCapable) {
      throw new Error(`Deposit address derivation is not capable for network ${this.network}`);
    }
    const ctx = this.depositContext(
      solanaKeyVersion(this.facilitator.settlerPubkey.toBase58()),
    );
    const derived = this.facilitator.deriveDepositAddress(ctx, index);
    return {
      stealthAddress: derived.stealthAddress,
      ephemeralPubKey: derived.ephemeralPubKey,
      derivationIndex: index,
      keyVersion: ctx.keyVersion,
    };
  }

  async observedBalanceAtomic(input: { stealthAddress: string }) {
    return (await this.facilitator.stealthAtaBalance(input.stealthAddress)).amountAtomic;
  }

  async sweepDeposit(input: Parameters<ChainRail["sweepDeposit"]>[0]) {
    void input.confirmations;
    if (!this.facilitator.hasSettlerKey) {
      return {
        outcome: "not-capable" as const,
        observedAmountAtomic: "0",
      };
    }
    if (input.caip2 !== this.tokenConfig.caip2
      || input.tokenAddress !== this.tokenConfig.address
      || input.poolAddress !== this.treasury) {
      throw new Error("Solana deposit sweep immutable binding mismatch");
    }
    return this.facilitator.sweepDepositToPool({
      ctx: this.depositContext(input.keyVersion),
      derivationIndex: input.derivationIndex,
      expectedStealthAddress: input.expectedStealthAddress,
      poolOwner: input.poolAddress,
      nowSeconds: input.nowSeconds,
      reuseSweepNonce: input.reuseSweepNonce,
    });
  }

  sweepTxStatus(input: { transactionHash: string }) {
    return this.facilitator.sweepTxStatus(input.transactionHash);
  }

  buildQuote(input: Parameters<ChainRail["buildQuote"]>[0]): SolanaX402PaymentRequirements {
    return buildSolanaAgentQuote({
      payee: input.payee,
      amountAtomic: input.amountAtomic,
      resource: input.resource,
      validForSeconds: input.validForSeconds,
      token: this.tokenConfig
    });
  }

  ownsPayment(payment: X402PaymentPayload | SolanaX402PaymentPayload): payment is SolanaX402PaymentPayload {
    return "transaction" in payment;
  }

  paymentNonce(input: Parameters<ChainRail["paymentNonce"]>[0]) {
    return this.ownsPayment(input.payment) ? input.requirementsNonce : undefined;
  }

  resolveRecipient(input: Parameters<ChainRail["resolveRecipient"]>[0]): ChainRailRecipient {
    if (!("x402Version" in input.requirements)) throw new Error("Solana payment cannot satisfy an EVM quote");
    if (!input.requirements.stealthMetaAddress) {
      return { recipient: input.payee.walletAddress };
    }
    if (!input.ephemeralPubKey) throw new Error("stealth quote requires an ephemeralPubKey");
    if (!input.payee.solanaStealthViewingKey) throw new Error("payee has no Solana stealth viewing key configured");
    const recipient = checkSolanaStealthAddress({
      ephemeralPubKey: input.ephemeralPubKey,
      viewingScalar: input.payee.solanaStealthViewingKey,
      spendingPubKey: input.requirements.stealthMetaAddress.spendingPubKey
    }).stealthAddress;
    return {
      recipient,
      stealth: { stealthAddress: recipient, ephemeralPubKey: input.ephemeralPubKey }
    };
  }

  async submitPoolPayout(input: Parameters<ChainRail["submitPoolPayout"]>[0]) {
    if (this.poolMode === "onchain") {
      throw new Error("Solana on-chain payout requires prepare-persist-broadcast ordering");
    }
    return this.preparePoolPayout(input);
  }

  async preparePoolPayout(input: Parameters<ChainRail["preparePoolPayout"]>[0]) {
    void input.nowSeconds;
    void input.logicalId;
    if (!this.treasury) throw new Error(`Pool payout treasury is not configured for network ${this.network}`);
    const payout = {
      treasury: this.treasury,
      recipient: input.recipient,
      amountAtomic: input.amountAtomic
    };
    const simulation = await this.facilitator.simulatePoolTransfer(payout);
    if (this.poolMode === "dry-run") {
      if (!simulation.wouldSettle) throw new Error(`Solana pool payout simulation failed: ${simulation.detail}`);
      return {
        network: this.network,
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        mode: "dry-run" as const,
      };
    }
    if (!simulation.wouldSettle) throw new Error(`Solana pool payout simulation failed: ${simulation.detail}`);
    const prepared = await this.facilitator.preparePoolTransfer(payout);
    return {
      network: this.network,
      recipient: input.recipient,
      amountAtomic: input.amountAtomic,
      mode: "onchain" as const,
      signedTx: prepared.signedTx,
      txId: prepared.signature,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      contextSlot: prepared.contextSlot,
    };
  }

  async broadcastPoolPayout(prepared: ChainRailPreparedPayout) {
    if (prepared.mode === "dry-run") return { txId: "", submitted: false };
    if (!prepared.signedTx || !prepared.txId) {
      throw new Error("Prepared Solana payout is missing durable signed material");
    }
    const transactionHash = await this.facilitator.broadcastRawPoolTransfer(prepared.signedTx);
    if (transactionHash !== prepared.txId) {
      throw new Error("Solana RPC returned a signature different from the persisted transaction");
    }
    return { txId: transactionHash, submitted: true };
  }

  poolPayoutStatus(prepared: ChainRailPreparedPayout) {
    if (prepared.mode === "dry-run") {
      return Promise.resolve({
        status: "landed" as const,
        transactionHash: `dry-run:${this.network}:${prepared.recipient}:${prepared.amountAtomic}`,
      });
    }
    if (!prepared.txId || prepared.lastValidBlockHeight === undefined) {
      return Promise.resolve({
        status: "uncertain" as const,
        detail: "Solana payout status lacks persisted signature or blockhash expiry",
      });
    }
    return this.facilitator.poolTransferStatus({
      signature: prepared.txId,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  }

  operatorPoolPayoutStatus(prepared: ChainRailPreparedPayout) {
    if (!prepared.txId || prepared.lastValidBlockHeight === undefined) {
      return Promise.resolve({
        status: "uncertain" as const,
        detail: "Solana operator status lacks persisted signature or expiry",
      });
    }
    return this.facilitator.operatorPoolTransferStatus({
      signature: prepared.txId,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  }

  outboxEntriesByRef(_ref: string): { logicalId: string; nonce: number }[] {
    return [];
  }

  async classifyByLogicalId(
    _input: { logicalId: string; nonce: number },
  ): Promise<ChainRailPayoutVerdict> {
    throw new Error("Solana has no sequential-nonce coordinator");
  }

  recoverOutbox(): Promise<void> {
    return Promise.resolve();
  }

  suppressPoolPayoutRebroadcast(_logicalId: string): void {
    // The pending journal leg is Solana's WAL.
  }

  bindPoolPayoutRef(_logicalId: string, _payoutRef: string): void {
    // The pending journal leg already carries the payout ref.
  }

  finalizedBlockHeight(): Promise<number> {
    return this.facilitator.finalizedBlockHeight();
  }

  async settle(input: {
    payment: X402PaymentPayload | SolanaX402PaymentPayload;
    requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
    payee: Parameters<ChainRail["buildQuote"]>[0]["payee"];
    ephemeralPubKey?: string;
    nowSeconds: number;
  }): Promise<ChainRailSettleResult> {
    if (!this.ownsPayment(input.payment)) throw new Error("EVM payment cannot satisfy a Solana quote");
    if (!("x402Version" in input.requirements)) throw new Error("Solana payment cannot satisfy an EVM quote");
    if (this.facilitator.tokenConfig.kind !== "solana") throw new Error("Solana x402 facilitator mismatch");

    const resolved = this.resolveRecipient(input);
    const verifyRequirements = input.requirements.stealthMetaAddress
      ? { ...input.requirements, payTo: resolved.recipient }
      : input.requirements;
    const settlement = await this.facilitator.verifyAndSettle(input.payment, verifyRequirements, input.nowSeconds);
    return { settlement, stealth: resolved.stealth };
  }

  protected depositContext(keyVersion: string): TreasuryKeyContext {
    return {
      caip2: this.tokenConfig.caip2,
      tokenAddress: this.tokenConfig.address,
      keyVersion,
    };
  }
}

/**
 * The `confidential` scheme (spec-confidential-x402.md §5, §15.2).
 *
 * A SUBCLASS rather than optional methods on `SolanaChainRail`, because
 * `isConfidentialRail` narrows on the presence of `settleConfidential` — putting
 * it on the base class would make every Solana rail claim a capability that
 * depends on a Token-2022 mint most deployments do not have. Construct this one
 * only when a confidential mint is configured; anything else stays a plain rail
 * and is refused with a reason instead of failing somewhere deeper.
 */
export class SolanaConfidentialChainRail extends SolanaChainRail implements ConfidentialRail {
  private readonly confidentialMintAddress: string;
  private readonly settler: SolanaConfidentialSettler;
  private readonly enabled: boolean;
  /**
   * Starts `dry-run` and STAYS there until `assertCapability()` has spoken to
   * the chain. The interface forbids a promise here, but one conjunct — "this
   * mint exists, carries the extension, and its auditor key is null" — is an
   * async fact that no config value can answer. Reading `dry-run` before the
   * assertion runs is what stops an unverified mint from ever serving traffic.
   */
  private capability: X402SettlementMode = "dry-run";
  private capabilityChecked = false;

  constructor(options: {
    facilitator: SolanaX402Facilitator;
    treasury?: string;
    poolPayoutEnabled?: boolean;
    confidentialMint: string;
    confidentialEnabled: boolean;
    settler: SolanaConfidentialSettler;
  }) {
    super(options);
    this.confidentialMintAddress = options.confidentialMint;
    this.enabled = options.confidentialEnabled;
    this.settler = options.settler;
  }

  get confidentialMode(): X402SettlementMode {
    return this.capability;
  }

  get confidentialMint(): string {
    return this.confidentialMintAddress;
  }

  /**
   * Resolve the cached capability once, at startup.
   *
   * Never throws: an unreadable mint is a verdict ("stay dry-run"), not a crash,
   * because an RPC blip must not take the whole server down over a flag-off
   * rail. It is emphatically NOT treated as capable — an unread auditor field is
   * not an absent one.
   */
  async assertCapability(rpc: Parameters<typeof assertConfidentialMint>[0]["rpc"]): Promise<void> {
    this.capabilityChecked = true;
    if (!this.enabled || !this.confidentialMintAddress) {
      this.capability = "dry-run";
      return;
    }
    const verdict = await assertConfidentialMint({ rpc, mint: this.confidentialMintAddress });
    if (!verdict.capable) {
      console.warn(
        `CONFIDENTIAL_DRY_RUN network=${this.network} mint=${this.confidentialMintAddress}`
        + ` reason=${verdict.reason}${verdict.detail ? ` detail=${verdict.detail}` : ""}`,
      );
      this.capability = "dry-run";
      return;
    }
    this.capability = this.settler.hasSettlerKey ? "onchain" : "dry-run";
    if (!this.settler.hasSettlerKey) {
      console.warn(`CONFIDENTIAL_DRY_RUN network=${this.network} reason=no_settler_key`);
    }
  }

  /**
   * SYNCHRONOUS and pure — the registry depends on exactly that, because it
   * resolves once to write-ahead the announcement before settle can broadcast,
   * then lets settle recompute the same value for free.
   *
   * It can be pure because the payee already did the async work: under §5.2-P
   * the slot (address, `R`, `P`, ATA) is provisioned ahead of time and published
   * IN THE QUOTE. So this validates rather than derives — and the validation
   * that matters is that the quoted address really is this payee's, recomputed
   * from `R` and the viewing key rather than taken on the quote's word.
   */
  resolveConfidentialRecipient(input: {
    requirements: unknown;
    payee: Parameters<ChainRail["buildQuote"]>[0]["payee"];
    ephemeralPubKey?: string;
  }): ChainRailRecipient {
    const requirements = assertSolanaConfidentialRequirements(input.requirements);
    if (!input.payee.solanaStealthViewingKey) {
      throw new ConfidentialPaymentError(
        "confidential_requires_stealth",
        "payee has no Solana stealth viewing key",
      );
    }
    // `R` comes from the QUOTE, not the payer: under §5.2-P the payee picked it.
    // A payer-supplied value that disagrees is refused rather than preferred.
    if (input.ephemeralPubKey && input.ephemeralPubKey !== requirements.ephemeralPubKey) {
      throw new ConfidentialPaymentError(
        "confidential_malformed",
        "payer-supplied ephemeralPubKey contradicts the quote",
      );
    }
    const expected = checkSolanaStealthAddress({
      ephemeralPubKey: requirements.ephemeralPubKey,
      viewingScalar: input.payee.solanaStealthViewingKey,
      spendingPubKey: requirements.stealthMetaAddress.spendingPubKey,
    }).stealthAddress;
    if (expected !== requirements.payTo) {
      // The quoted slot does not belong to the meta-address it claims. Paying it
      // would send funds to an account this payee cannot derive a key for.
      throw new ConfidentialPaymentError(
        "confidential_malformed",
        "quoted stealth address does not match the payee meta-address",
      );
    }
    return {
      recipient: expected,
      stealth: { stealthAddress: expected, ephemeralPubKey: requirements.ephemeralPubKey },
      confidential: {
        encryptionPubKey: asConfidentialEncryptionPubKey(requirements.encryptionPubKey),
      },
    };
  }

  /**
   * The settler half of the slot-provisioning ceremony (§5.2-P).
   *
   * Returns the ElGamal key the PROGRAM actually stored for each address, read
   * back after confirmation. That read-back is the only check available on `P`:
   * `P = s⁻¹·H` on Ristretto255 while the address is `s·G` on ed25519, so
   * deriving one from the other is a discrete log and the server — which holds
   * only a viewing key — can never compute it. Comparing what landed against
   * what the payee claims is therefore the whole verification.
   */
  async provisionConfidentialSlots(input: {
    transactions: string[];
    addresses: string[];
  }): Promise<{
    status: "provisioned" | "refused";
    signatures: string[];
    detail?: string;
    onchain: { stealthAddress: string; tokenAccount: string; encryptionPubKey?: string }[];
  }> {
    const result = await this.settler.provision({ transactions: input.transactions });
    if (result.status !== "provisioned") {
      return { ...result, onchain: [] };
    }
    const onchain: { stealthAddress: string; tokenAccount: string; encryptionPubKey?: string }[] = [];
    for (const stealthAddress of input.addresses) {
      const state = await this.facilitator.confidentialAccountState({
        owner: stealthAddress,
        mint: this.confidentialMintAddress,
      });
      onchain.push({
        stealthAddress,
        tokenAccount: this.facilitator
          .confidentialTokenAccount({ owner: stealthAddress, mint: this.confidentialMintAddress })
          .toBase58(),
        encryptionPubKey: state.exists && state.confidential ? state.encryptionPubKey : undefined,
      });
    }
    return { ...result, onchain };
  }

  /** Verifies the pre-provisioned slot account exists; it cannot create one. */
  async ensureConfidentialAccount(input: { recipient: ChainRailRecipient }): Promise<void> {
    const observation = await this.observeConfidential({
      stealthAddress: input.recipient.recipient,
    });
    if (observation.kind === "no-account") {
      throw new ConfidentialPaymentError(
        "confidential_not_supported",
        "the quoted confidential slot has no account — the payee must provision it",
      );
    }
    if (observation.kind === "unknown") {
      throw new ConfidentialPaymentError("confidential_not_supported", "slot state unreadable");
    }
  }

  async verifyConfidential(input: {
    payload: unknown;
    requirements: unknown;
  }): Promise<{ ok: boolean; reason?: string }> {
    try {
      const payload = assertSolanaConfidentialPayload(input.payload);
      const requirements = assertSolanaConfidentialRequirements(input.requirements);
      // Every binding is re-derived from the QUOTE. The payload names the same
      // fields, and each one is a place a payer could otherwise redirect value.
      if (payload.asset !== requirements.asset) {
        return { ok: false, reason: "confidential_scheme_mismatch" };
      }
      if (payload.ephemeralPubKey !== requirements.ephemeralPubKey) {
        return { ok: false, reason: "confidential_malformed" };
      }
      if (payload.destinationTokenAccount !== requirements.destinationTokenAccount) {
        return { ok: false, reason: "confidential_malformed" };
      }
      if (requirements.asset !== this.confidentialMintAddress) {
        return { ok: false, reason: "confidential_not_supported" };
      }
      this.settler.decodePlan({
        transactions: payload.transactions,
        expectedDestinationTokenAccount: requirements.destinationTokenAccount,
        expectedMint: requirements.asset,
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof ConfidentialPaymentError ? error.code : "confidential_malformed",
      };
    }
  }

  async simulateConfidential(input: {
    payload: unknown;
    requirements: unknown;
  }): Promise<{ ok: boolean; reason?: string }> {
    const verified = await this.verifyConfidential(input);
    if (!verified.ok) return verified;
    const payload = assertSolanaConfidentialPayload(input.payload);
    const requirements = assertSolanaConfidentialRequirements(input.requirements);
    const { transactions } = this.settler.decodePlan({
      transactions: payload.transactions,
      expectedDestinationTokenAccount: requirements.destinationTokenAccount,
      expectedMint: requirements.asset,
    });
    // Only the FIRST transaction can be simulated meaningfully up front — the
    // rest read accounts their predecessors have not created yet.
    return this.settler.simulateFirst(transactions);
  }

  async settleConfidential(input: {
    payload: unknown;
    requirements: unknown;
    writeAheadAnnouncement: () => Promise<void>;
  }): Promise<ChainRailSettleResult> {
    const payload = assertSolanaConfidentialPayload(input.payload);
    const requirements = assertSolanaConfidentialRequirements(input.requirements);
    const verified = await this.verifyConfidential(input);
    if (!verified.ok) {
      throw new ConfidentialPaymentError(
        (verified.reason as never) ?? "confidential_malformed",
      );
    }
    if (!this.capabilityChecked) {
      // Serving before the mint assertion has run would mean trusting config for
      // the auditor-key question, which config cannot answer.
      throw new ConfidentialPaymentError(
        "confidential_not_supported",
        "confidential capability has not been asserted against the mint yet",
      );
    }

    const outcome = await this.settler.settle({
      transactions: payload.transactions,
      expectedDestinationTokenAccount: requirements.destinationTokenAccount,
      expectedMint: requirements.asset,
      writeAheadAnnouncement: input.writeAheadAnnouncement,
    });

    const stealth = {
      stealthAddress: requirements.payTo,
      ephemeralPubKey: requirements.ephemeralPubKey,
    };
    if (outcome.status === "settled") {
      return {
        settlement: {
          settlement: "onchain",
          network: this.network,
          asset: requirements.asset,
          from: payload.payer,
          to: requirements.payTo,
          // Both parties already know the amount; the property this rail buys is
          // that it never reaches the CHAIN. Keeping it on the private receipt
          // is not a leak — omitting it would just make our own accounting lie.
          value: requirements.maxAmountRequired,
          authorizationNonce: requirements.nonce,
          // The transfer is the last transaction of the plan.
          transactionHash: outcome.signatures[outcome.signatures.length - 1],
        },
        stealth,
      };
    }
    if (outcome.cleanup.status === "failed") {
      console.error(
        `CONFIDENTIAL_SETTLE_FAILED network=${this.network} reason=${outcome.reason}`
        + ` stranded_lamports=${outcome.cleanup.strandedLamports ?? "0"}`,
      );
    }
    return {
      settlement: {
        settlement: "dry-run",
        network: this.network,
        asset: requirements.asset,
        from: payload.payer,
        to: requirements.payTo,
        value: requirements.maxAmountRequired,
        authorizationNonce: requirements.nonce,
        reason: `${outcome.reason}: ${outcome.detail}`,
      },
      stealth,
    };
  }

  /**
   * See `ConfidentialObservation` — deliberately NOT a balance.
   *
   * A confidential account's plaintext balance is zero by construction, so there
   * is no number that honestly describes it. Returning `0n` here is precisely
   * the bug that made the inbox mark a live stealth output "provably empty" and
   * reap the only copy of its announcement (B3).
   */
  async observeConfidential(input: { stealthAddress: string }): Promise<ConfidentialObservation> {
    try {
      const account = await this.facilitator.confidentialAccountState({
        owner: input.stealthAddress,
        mint: this.confidentialMintAddress,
      });
      if (!account.exists) return { kind: "no-account" };
      return account.confidential
        ? { kind: "ciphertext-present" }
        : { kind: "plaintext", amountAtomic: account.amountAtomic };
    } catch {
      // An RPC failure is not evidence of anything, least of all emptiness.
      return { kind: "unknown" };
    }
  }
}
