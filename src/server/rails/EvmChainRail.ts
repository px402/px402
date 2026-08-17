import { buildPaymentRequirements, type X402PaymentPayload, type X402PaymentRequirements } from "../../shared/x402";
import type { SolanaX402PaymentPayload, SolanaX402PaymentRequirements } from "../../shared/x402Solana";
import { checkStealthAddress } from "../../shared/stealth";
import { evmKeyVersion, type TreasuryKeyContext } from "../../shared/depositStealth";
import type { X402Facilitator } from "../base/X402Facilitator";
import { Interface } from "ethers";
import { evmPayloadFingerprint, type TransactionCoordinator } from "../base/TransactionCoordinator";
import type { ChainRail, ChainRailPayoutVerdict, ChainRailPreparedPayout, ChainRailRecipient, ChainRailSettleResult } from "./ChainRail";

export class EvmChainRail implements ChainRail {
  readonly kind = "evm" as const;
  private readonly facilitator: X402Facilitator;
  private readonly coordinator?: TransactionCoordinator;
  private readonly payoutRefs = new Map<string, string>();
  private readonly treasury: string;
  readonly poolMode: "dry-run" | "onchain";

  constructor({
    facilitator,
    treasury = "",
    poolPayoutEnabled = false,
    coordinator,
  }: {
    facilitator: X402Facilitator;
    treasury?: string;
    poolPayoutEnabled?: boolean;
    coordinator?: TransactionCoordinator;
  }) {
    this.facilitator = facilitator;
    this.coordinator = coordinator;
    this.treasury = treasury;
    const settlerMatchesTreasury = Boolean(
      facilitator.settlerAddress
      && treasury
      && lc(facilitator.settlerAddress) === lc(treasury)
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
      && this.facilitator.hasCoordinator
      && this.facilitator.settlerAddress
      && this.treasury
      && lc(this.facilitator.settlerAddress) === lc(this.treasury),
    );
  }

  deriveDepositAddress(index: number) {
    if (!this.depositCapable || !this.facilitator.settlerAddress) {
      throw new Error(`Deposit address derivation is not capable for network ${this.network}`);
    }
    const ctx = this.depositContext(evmKeyVersion(this.facilitator.settlerAddress));
    const derived = this.facilitator.deriveDepositAddress(ctx, index);
    return {
      stealthAddress: derived.stealthAddress,
      ephemeralPubKey: derived.ephemeralPubKey,
      derivationIndex: index,
      keyVersion: ctx.keyVersion,
    };
  }

  observedBalanceAtomic(input: { stealthAddress: string }) {
    return this.facilitator.tokenBalanceOf(input.stealthAddress);
  }

  relayDeposit(input: Parameters<NonNullable<ChainRail["relayDeposit"]>>[0]) {
    return this.facilitator.relaySignedDeposit(input);
  }

  async sweepDeposit(input: Parameters<ChainRail["sweepDeposit"]>[0]) {
    if (!this.facilitator.hasSettlerKey || !this.facilitator.hasCoordinator) {
      return {
        outcome: "not-capable" as const,
        observedAmountAtomic: "0",
      };
    }
    if (input.caip2 !== this.tokenConfig.caip2
      || lc(input.tokenAddress) !== lc(this.tokenConfig.address)
      || lc(input.poolAddress) !== lc(this.treasury)) {
      throw new Error("EVM deposit sweep immutable binding mismatch");
    }
    const observed = await this.observedBalanceAtomic({
      stealthAddress: input.expectedStealthAddress,
    });
    if (observed === 0n) {
      return {
        outcome: "empty" as const,
        observedAmountAtomic: "0",
        sweepNonce: input.reuseSweepNonce,
      };
    }
    return this.facilitator.sweepDepositToPool({
      ctx: this.depositContext(input.keyVersion),
      derivationIndex: input.derivationIndex,
      expectedStealthAddress: input.expectedStealthAddress,
      poolAddress: input.poolAddress,
      amountAtomic: observed.toString(),
      nowSeconds: input.nowSeconds,
      confirmations: input.confirmations,
      reuseSweepNonce: input.reuseSweepNonce,
    });
  }

  sweepTxStatus(input: { transactionHash: string }) {
    return this.facilitator.sweepTxStatus(input.transactionHash);
  }

  buildQuote(input: Parameters<ChainRail["buildQuote"]>[0]): X402PaymentRequirements {
    const requirements = buildPaymentRequirements({
      payTo: input.payee.walletAddress,
      maxAmountRequired: input.amountAtomic,
      resource: input.resource,
      validForSeconds: input.validForSeconds,
      token: this.tokenConfig,
      nowSeconds: input.nowSeconds
    });
    if (input.payee.stealthMeta) requirements.stealthMetaAddress = input.payee.stealthMeta;
    return requirements;
  }

  ownsPayment(payment: X402PaymentPayload | SolanaX402PaymentPayload): payment is X402PaymentPayload {
    return "authorization" in payment;
  }

  paymentNonce(input: Parameters<ChainRail["paymentNonce"]>[0]) {
    return this.ownsPayment(input.payment) ? input.payment.authorization?.nonce : undefined;
  }

  resolveRecipient(input: Parameters<ChainRail["resolveRecipient"]>[0]): ChainRailRecipient {
    if ("x402Version" in input.requirements) throw new Error("EVM payment cannot satisfy a Solana quote");
    if (!input.requirements.stealthMetaAddress) {
      return { recipient: input.payee.walletAddress };
    }
    if (!input.ephemeralPubKey) throw new Error("stealth quote requires an ephemeralPubKey");
    if (!input.payee.stealthViewingKey) throw new Error("payee has no stealth viewing key configured");
    const recipient = checkStealthAddress({
      ephemeralPubKey: input.ephemeralPubKey,
      viewingKey: input.payee.stealthViewingKey,
      spendingPubKey: input.requirements.stealthMetaAddress.spendingPubKey
    }).stealthAddress;
    return {
      recipient,
      stealth: { stealthAddress: recipient, ephemeralPubKey: input.ephemeralPubKey }
    };
  }

  async submitPoolPayout(input: Parameters<ChainRail["submitPoolPayout"]>[0]) {
    void input.nowSeconds;
    if (!this.treasury) throw new Error(`Pool payout treasury is not configured for network ${this.network}`);
    const simulation = await this.facilitator.simulatePoolTransfer({
      poolAddress: this.treasury,
      recipient: input.recipient,
      amountAtomic: input.amountAtomic
    });
    if (this.poolMode === "dry-run") {
      if (!simulation.wouldSettle) throw new Error(`Pool payout simulation failed: ${simulation.detail}`);
      return {
        network: this.network,
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        mode: "dry-run" as const,
      };
    }
    if (!simulation.wouldSettle) throw new Error(`Pool payout simulation failed: ${simulation.detail}`);
    if (!this.coordinator) throw new Error("EVM pool payout coordinator is not configured");
    const payloadFingerprint = this.poolTransferBinding(input.recipient, input.amountAtomic);
    const result = await this.coordinator.submit({
      kind: "pool-payout",
      ref: this.payoutRefs.get(input.logicalId),
      logicalId: input.logicalId,
      payloadFingerprint,
      // The queue owns a durable journal and re-queues on its own schedule; a
      // suspended park would pin its network lock for the quarantine's lifetime.
      onQuarantine: "reject",
      sign: this.poolTransferSigner({ ...input, payloadFingerprint }),
    });
    return {
      network: this.network,
      recipient: input.recipient,
      amountAtomic: input.amountAtomic,
      mode: "onchain" as const,
      txId: result.txHash,
      nonce: result.nonce,
    };
  }

  preparePoolPayout(input: Parameters<ChainRail["preparePoolPayout"]>[0]) {
    // Still DEAD on EVM: cohort dispatch went through dispatchPoolPayouts below
    // rather than this alias, and flushLeg's evm branch calls submitPoolPayout
    // directly. Kept because the ChainRail interface requires it.
    return this.submitPoolPayout(input);
  }

  private poolTransferBinding(recipient: string, amountAtomic: string) {
    const data = new Interface([
      "function transfer(address to,uint256 value) returns (bool)",
    ]).encodeFunctionData("transfer", [recipient, amountAtomic]);
    return evmPayloadFingerprint({
      to: this.tokenConfig.address,
      data,
      value: 0n,
      chainId: this.tokenConfig.chainId as number,
    });
  }

  private poolTransferSigner(input: {
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
    logicalId: string;
    payloadFingerprint: string;
  }) {
    return async (fees: { nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string }) => {
      const built = await this.facilitator.buildPoolTransfer({
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        ...fees,
      });
      if (built.payloadFingerprint !== input.payloadFingerprint) {
        throw new Error("Pool payout builder changed its payload fingerprint");
      }
      return { signedTx: built.signedTx, txHash: built.txHash };
    };
  }

  async dispatchPoolPayouts(inputs: {
    logicalId: string;
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
  }[]) {
    if (!this.treasury) throw new Error(`Pool payout treasury is not configured for network ${this.network}`);
    if (this.poolMode !== "onchain") throw new Error("Cohort dispatch is an on-chain path; dry-run uses submitPoolPayout");
    if (!this.coordinator) throw new Error("EVM pool payout coordinator is not configured");
    const failures = new Map<string, string>();
    const prepared: Parameters<TransactionCoordinator["dispatchMany"]>[0] = [];
    for (const input of inputs) {
      const simulation = await this.facilitator.simulatePoolTransfer({
        poolAddress: this.treasury,
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
      });
      if (!simulation.wouldSettle) {
        failures.set(input.logicalId, `Pool payout simulation failed: ${simulation.detail}`);
        continue;
      }
      const payloadFingerprint = this.poolTransferBinding(input.recipient, input.amountAtomic);
      prepared.push({
        kind: "pool-payout",
        ref: this.payoutRefs.get(input.logicalId),
        logicalId: input.logicalId,
        payloadFingerprint,
        onQuarantine: "reject",
        sign: this.poolTransferSigner({ ...input, payloadFingerprint }),
      });
    }
    const outcomes = prepared.length > 0 ? await this.coordinator.dispatchMany(prepared) : [];
    return { outcomes, failures };
  }

  async maintainPoolPayout(input: {
    logicalId: string;
    recipient: string;
    amountAtomic: string;
    nowSeconds: number;
    verdict?: ChainRailPayoutVerdict;
  }): Promise<void> {
    if (!this.coordinator) return;
    const payloadFingerprint = this.poolTransferBinding(input.recipient, input.amountAtomic);
    const verdict = input.verdict && input.verdict.status !== "uncertain"
      ? {
        verdict: input.verdict.status,
        transactionHash: "transactionHash" in input.verdict ? input.verdict.transactionHash : undefined,
      }
      : input.verdict
        ? { verdict: "uncertain" as const }
        : undefined;
    await this.coordinator.maintainEntry({
      logicalId: input.logicalId,
      verdict,
      sign: this.poolTransferSigner({ ...input, payloadFingerprint }),
    });
  }

  async broadcastPoolPayout(prepared: ChainRailPreparedPayout) {
    if (prepared.mode === "dry-run") return { txId: "", submitted: false };
    throw new Error("EVM pool payout broadcast is coordinator-owned");
  }

  async poolPayoutStatus(_prepared: ChainRailPreparedPayout) {
    return {
      status: "uncertain" as const,
      detail: "EVM payout status requires logicalId classification",
    };
  }

  operatorPoolPayoutStatus(prepared: ChainRailPreparedPayout) {
    return this.poolPayoutStatus(prepared);
  }

  outboxEntriesByRef(ref: string) {
    return this.coordinator?.outboxEntriesByRef(ref)
      .filter((entry) => entry.kind === "pool-payout")
      .map((entry) => ({ logicalId: entry.logicalId, nonce: entry.nonce })) ?? [];
  }

  async classifyByLogicalId(input: { logicalId: string; nonce: number }) {
    if (!this.coordinator) {
      return { status: "uncertain" as const, detail: "EVM coordinator is not configured" };
    }
    const result = await this.coordinator.classifyNonce(input);
    if (result.verdict === "landed") {
      return {
        status: "landed" as const,
        transactionHash: result.transactionHash as string,
        // §2.9 H11 — the landing block rides the verdict so the journal can
        // persist a per-member landing coordinate. Absent means unmeasured.
        ...(result.blockNumber !== undefined ? { blockNumber: result.blockNumber } : {}),
      };
    }
    if (result.verdict === "included") {
      return { status: "included" as const, transactionHash: result.transactionHash as string };
    }
    if (result.verdict === "pending") {
      return { status: "pending" as const };
    }
    return result.verdict === "terminal-absent"
      ? { status: "terminal-absent" as const }
      : { status: "uncertain" as const, detail: "EVM nonce outcome is ambiguous" };
  }

  recoverOutbox() {
    return this.coordinator?.recoverOutbox() ?? Promise.resolve();
  }

  settlerQuarantined(): boolean {
    return this.coordinator?.isQuarantined() ?? false;
  }

  suppressPoolPayoutRebroadcast(logicalId: string): void {
    this.coordinator?.suppressPoolPayoutRebroadcast(logicalId);
  }

  bindPoolPayoutRef(logicalId: string, payoutRef: string): void {
    const existing = this.payoutRefs.get(logicalId);
    if (existing && existing !== payoutRef) {
      throw new Error("Pool payout logicalId is already bound to another ref");
    }
    this.payoutRefs.set(logicalId, payoutRef);
  }

  async finalizedBlockHeight(): Promise<number | undefined> {
    return undefined;
  }

  async settle(input: {
    payment: X402PaymentPayload | SolanaX402PaymentPayload;
    requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
    payee: Parameters<ChainRail["buildQuote"]>[0]["payee"];
    ephemeralPubKey?: string;
    nowSeconds: number;
  }): Promise<ChainRailSettleResult> {
    if (!this.ownsPayment(input.payment)) throw new Error("Solana payment cannot satisfy an EVM quote");
    if ("x402Version" in input.requirements) throw new Error("EVM payment cannot satisfy a Solana quote");
    if (this.facilitator.tokenConfig.kind !== "evm") throw new Error("EVM x402 facilitator mismatch");

    const to = lc(input.payment.authorization.to);
    const resolved = this.resolveRecipient(input);
    let verifyRequirements = input.requirements;
    if (input.requirements.stealthMetaAddress) {
      if (to !== lc(resolved.recipient)) throw new Error("payment recipient is not a stealth address of the payee");
      verifyRequirements = { ...input.requirements, payTo: resolved.recipient };
    } else if (to !== lc(resolved.recipient)) {
      throw new Error("payment recipient must be the quoted payee wallet");
    }
    const settlement = await this.facilitator.verifyAndSettle(input.payment, verifyRequirements, input.nowSeconds);
    return { settlement, stealth: resolved.stealth };
  }

  private depositContext(keyVersion: string): TreasuryKeyContext {
    return {
      caip2: this.tokenConfig.caip2,
      tokenAddress: this.tokenConfig.address,
      keyVersion,
    };
  }
}

const lc = (value: string) => value.toLowerCase();
