import { createHash } from "node:crypto";
import type { ChainRail, ChainRailSweepResult } from "../rails/ChainRail";
import type { PrivatePaymentLedger } from "./PrivatePaymentLedger";
import {
  type DepositAddressRecord,
  type DepositAddressStatus,
  DepositAddressBook,
} from "./DepositAddressBook";
import {
  DepositReconciliationQueue,
  type ReconciliationEntry,
} from "./DepositReconciliationQueue";

export interface DepositConsolidationOptions {
  minAgeMs: number;
  maxPerRun: number;
  unpaidGraceMs: number;
  confirmations: number;
  backoffMs: number;
  maxAttempts: number;
  ledger?: Pick<PrivatePaymentLedger, "ledgerLiability">;
  creditProofVerified?: (record: DepositAddressRecord) => Promise<void>;
}

export interface DepositConsolidationResult {
  swept: number;
  quarantined: number;
  reaped: number;
  retried: number;
  failures: number;
}

const EMPTY_RESULT = (): DepositConsolidationResult => ({
  swept: 0,
  quarantined: 0,
  reaped: 0,
  retried: 0,
  failures: 0,
});

export class DepositConsolidationService {
  private active: Promise<DepositConsolidationResult> | undefined;

  constructor(
    private readonly book: DepositAddressBook,
    private readonly queue: DepositReconciliationQueue,
    private readonly rails: ReadonlyMap<string, ChainRail>,
    private readonly options: DepositConsolidationOptions,
  ) {
    if (!Number.isFinite(options.minAgeMs) || options.minAgeMs < 0
      || !Number.isFinite(options.unpaidGraceMs) || options.unpaidGraceMs <= 0
      || !Number.isFinite(options.backoffMs) || options.backoffMs <= 0
      || !Number.isInteger(options.maxPerRun) || options.maxPerRun < 1
      || !Number.isInteger(options.confirmations) || options.confirmations < 1
      || !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error("Invalid deposit consolidation options");
    }
  }

  reconcileOnStartup(now = Date.now()): Promise<DepositConsolidationResult> {
    return this.singleFlight(() => this.reconcile(now));
  }

  runOnce(now = Date.now()): Promise<DepositConsolidationResult> {
    if (this.active) return Promise.resolve(EMPTY_RESULT());
    return this.singleFlight(() => this.run(now));
  }

  async waitForIdle(): Promise<void> {
    await this.active;
  }

  async reserveOk(assetKey: string): Promise<boolean> {
    if (!this.options.ledger) return false;
    const records = this.book.reserveRecordsForAsset(assetKey);
    const network = assetKey.slice(0, assetKey.indexOf(":"));
    const rail = this.rails.get(network);
    if (!rail?.poolAddress) return false;
    if (this.book.all().some((record) =>
      record.status === "reserve-mismatch"
      && `${record.network}:${record.tokenAddress.toLowerCase()}` === assetKey.toLowerCase())) {
      return false;
    }
    try {
      const balances = await Promise.all([
        rail.observedBalanceAtomic({ stealthAddress: rail.poolAddress }),
        ...records.map((record) =>
          rail.observedBalanceAtomic({ stealthAddress: record.stealthAddress })),
      ]);
      const reserve = balances.reduce((sum, value) => sum + value, 0n);
      return reserve >= this.options.ledger.ledgerLiability(assetKey);
    } catch {
      return false;
    }
  }

  backlog(): {
    oldestCreditedAgeMs: number | null;
    counts: Record<DepositAddressStatus, number>;
  } {
    const records = this.book.all();
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as
      Record<DepositAddressStatus, number>;
    let oldestCreditedAt: number | undefined;
    for (const record of records) {
      counts[record.status] += 1;
      if (record.status === "credited" && record.creditedAt !== null) {
        oldestCreditedAt = oldestCreditedAt === undefined
          ? record.creditedAt
          : Math.min(oldestCreditedAt, record.creditedAt);
      }
    }
    return {
      oldestCreditedAgeMs: oldestCreditedAt === undefined
        ? null
        : Math.max(0, Date.now() - oldestCreditedAt),
      counts,
    };
  }

  private singleFlight(
    operation: () => Promise<DepositConsolidationResult>,
  ): Promise<DepositConsolidationResult> {
    if (this.active) return this.active;
    const active = operation().catch((error) => {
      console.error(
        `DEPOSIT_CONSOLIDATION_FAILED reason=${safeReason(error)}`,
      );
      return { ...EMPTY_RESULT(), failures: 1 };
    }).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    this.active = active;
    return active;
  }

  private async reconcile(now: number): Promise<DepositConsolidationResult> {
    const result = EMPTY_RESULT();
    for (const record of this.book.reverifiable(this.options.maxPerRun)) {
      try {
        if (!this.options.creditProofVerified) {
          throw new Error("proof credit replay callback is not configured");
        }
        await this.options.creditProofVerified(record);
        const credited = await this.book.transition(record.id, "proof-verified", (current) => {
          current.status = "credited";
          current.creditedAt = now;
          current.nextRetryAt = null;
          if (current.overpaymentAtomic && BigInt(current.overpaymentAtomic) > 0n) {
            current.quarantineReason = "overpayment";
          }
        });
        if (credited.quarantineReason === "overpayment") {
          await this.queue.enqueue({
            recordId: credited.id,
            reason: "overpayment",
            network: credited.network,
            stealthAddress: credited.stealthAddress,
            observedAmountAtomic: credited.observedAmountAtomic
              ?? credited.expectedAmountAtomic,
            expectedAmountAtomic: credited.expectedAmountAtomic,
            at: now,
          });
          this.log(credited.id, "overpayment");
        }
        result.retried += 1;
      } catch (error) {
        result.failures += 1;
        this.log(record.id, safeReason(error));
      }
    }
    await this.processSubmitted(result, now);
    await this.processCredited(result, now, true);
    await this.processUnpaid(result, now);
    result.reaped += await this.book.reapSwept(now);
    return result;
  }

  private async run(now: number): Promise<DepositConsolidationResult> {
    const result = EMPTY_RESULT();
    result.reaped += await this.book.reapSwept(now);
    await this.processSubmitted(result, now);
    await this.processCredited(result, now, false);
    await this.processUnpaid(result, now);
    return result;
  }

  private async processSubmitted(
    result: DepositConsolidationResult,
    now: number,
  ) {
    for (const record of this.book.resumableSubmitted(this.options.maxPerRun)) {
      const rail = this.rails.get(record.network);
      if (!rail) {
        await this.failAttempt(record, result, now, "missing-rail");
        continue;
      }
      try {
        if (record.sweepTxHash) {
          const status = await rail.sweepTxStatus({
            transactionHash: record.sweepTxHash,
          });
          if (status.state === "confirmed-success") {
            await this.finishSubmitted(record, result, now);
            continue;
          }
          if (status.state === "pending") continue;
        }
        const sweep = await this.driveSweep(record, rail, now);
        await this.applySweepResult(record, sweep, result, now);
      } catch (error) {
        await this.failAttempt(record, result, now, safeReason(error));
      }
    }
  }

  private async processCredited(
    result: DepositConsolidationResult,
    now: number,
    startup: boolean,
  ) {
    const minAge = startup ? 0 : this.options.minAgeMs;
    for (const record of this.book.consolidatable(
      minAge,
      this.options.maxPerRun,
      now,
    )) {
      try {
        const rail = this.requireRail(record.network);
        const sweepNonce = record.sweepNonce ?? deterministicSweepNonce(record);
        const submitted = await this.book.transition(record.id, "credited", (current) => {
          current.status = "sweep-submitted";
          current.sweepNonce = sweepNonce;
          current.sweepTxHash = null;
          current.sweepSubmittedAt = now;
          current.nextRetryAt = null;
        });
        const sweep = await this.driveSweep(submitted, rail, now);
        await this.applySweepResult(submitted, sweep, result, now);
      } catch (error) {
        const current = this.book.byId(record.id);
        if (current?.status === "sweep-submitted") {
          await this.failAttempt(current, result, now, safeReason(error));
        } else {
          result.failures += 1;
          this.log(record.id, safeReason(error));
        }
      }
    }
  }

  private async processUnpaid(
    result: DepositConsolidationResult,
    now: number,
  ) {
    for (const record of this.book.unpaidStale(
      this.options.unpaidGraceMs,
      this.options.maxPerRun,
      now,
    )) {
      try {
        const rail = this.requireRail(record.network);
        const observed = await rail.observedBalanceAtomic({
          stealthAddress: record.stealthAddress,
        });
        if (observed === 0n) {
          if (record.status === "awaiting-payment") await this.book.toDormant(record.id);
          continue;
        }
        const sweepNonce = record.sweepNonce ?? deterministicSweepNonce(record);
        const submitted = await this.book.transition(record.id, record.status, (current) => {
          current.status = "sweep-submitted";
          current.observedAmountAtomic = observed.toString();
          current.sweepNonce = sweepNonce;
          current.sweepTxHash = null;
          current.sweepSubmittedAt = now;
          current.quarantineReason = "late-uncredited";
          current.nextRetryAt = null;
        });
        const sweep = await this.driveSweep(submitted, rail, now);
        await this.applySweepResult(submitted, sweep, result, now);
      } catch (error) {
        const current = this.book.byId(record.id);
        if (current?.status === "sweep-submitted") {
          await this.failAttempt(current, result, now, safeReason(error));
        } else {
          result.failures += 1;
          this.log(record.id, safeReason(error));
        }
      }
    }
  }

  private driveSweep(
    record: DepositAddressRecord,
    rail: ChainRail,
    now: number,
  ) {
    return rail.sweepDeposit({
      derivationIndex: record.derivationIndex,
      keyVersion: record.keyVersion,
      caip2: record.caip2,
      tokenAddress: record.tokenAddress,
      expectedStealthAddress: record.stealthAddress,
      poolAddress: rail.poolAddress,
      nowSeconds: Math.floor(now / 1000),
      confirmations: this.options.confirmations,
      reuseSweepNonce: record.sweepNonce ?? undefined,
    });
  }

  private async applySweepResult(
    record: DepositAddressRecord,
    sweep: ChainRailSweepResult,
    result: DepositConsolidationResult,
    now: number,
  ) {
    if (sweep.outcome === "not-capable") {
      throw new Error("deposit rail is not recovery-capable");
    }
    if (sweep.outcome === "empty") {
      await this.quarantine(
        record,
        result,
        now,
        record.quarantineReason === "late-uncredited"
          ? "late-uncredited"
          : record.quarantineReason === "overpayment"
            ? "overpayment"
            : "zero-without-receipt",
        sweep.observedAmountAtomic,
      );
      return;
    }
    const current = await this.book.transition(record.id, "sweep-submitted", (entry) => {
      entry.sweepNonce = sweep.sweepNonce ?? entry.sweepNonce;
      entry.sweepTxHash = sweep.transactionHash ?? entry.sweepTxHash;
      entry.observedAmountAtomic = sweep.observedAmountAtomic;
      entry.nextRetryAt = null;
    });
    if (sweep.outcome === "submitted-unconfirmed") return;
    await this.finishSubmitted(current, result, now);
  }

  private async finishSubmitted(
    record: DepositAddressRecord,
    result: DepositConsolidationResult,
    now: number,
  ) {
    if (record.quarantineReason === "late-uncredited"
      || record.quarantineReason === "overpayment") {
      await this.quarantine(
        record,
        result,
        now,
        record.quarantineReason,
        record.observedAmountAtomic ?? "0",
      );
      return;
    }
    await this.book.transition(record.id, "sweep-submitted", (current) => {
      current.status = "swept";
      current.sweptAt = now;
      current.nextRetryAt = null;
      current.quarantineReason = null;
    });
    result.swept += 1;
  }

  private async failAttempt(
    record: DepositAddressRecord,
    result: DepositConsolidationResult,
    now: number,
    reason: string,
  ) {
    const attempts = record.attemptCount + 1;
    if (attempts >= this.options.maxAttempts) {
      await this.book.transition(record.id, "sweep-submitted", (current) => {
        current.status = "reserve-mismatch";
        current.attemptCount = attempts;
        current.nextRetryAt = null;
        current.quarantineReason = "sweep-max-attempts";
      });
      result.quarantined += 1;
      this.log(record.id, "sweep-max-attempts");
      return;
    }
    await this.book.transition(record.id, "sweep-submitted", (current) => {
      current.attemptCount = attempts;
      current.nextRetryAt = now + this.options.backoffMs * (2 ** Math.min(attempts - 1, 10));
      current.quarantineReason = reason.includes("keyVersion") || reason.includes("recovery key")
        ? "key-mismatch"
        : current.quarantineReason;
    });
    result.retried += 1;
    result.failures += 1;
    this.log(record.id, reason);
  }

  private async quarantine(
    record: DepositAddressRecord,
    result: DepositConsolidationResult,
    now: number,
    reason: ReconciliationEntry["reason"],
    observedAmountAtomic: string,
  ) {
    await this.book.transition(record.id, "sweep-submitted", (current) => {
      current.status = "reserve-mismatch";
      current.quarantineReason = reason;
      current.nextRetryAt = null;
    });
    await this.queue.enqueue({
      recordId: record.id,
      reason,
      network: record.network,
      stealthAddress: record.stealthAddress,
      observedAmountAtomic,
      expectedAmountAtomic: record.expectedAmountAtomic,
      at: now,
    });
    result.quarantined += 1;
    this.log(record.id, reason);
  }

  private requireRail(network: string) {
    const rail = this.rails.get(network);
    if (!rail) throw new Error(`No deposit consolidation rail for ${network}`);
    return rail;
  }

  private log(recordId: string, reason: string) {
    console.error(`DEPOSIT_RECONCILIATION record=${recordId} reason=${reasonCode(reason)}`);
  }
}

const STATUSES: readonly DepositAddressStatus[] = [
  "awaiting-payment",
  "proof-verified",
  "credited",
  "sweep-submitted",
  "swept",
  "reserve-mismatch",
  "dormant",
];

const deterministicSweepNonce = (record: DepositAddressRecord) =>
  `0x${createHash("sha256")
    .update("px402-deposit-sweep/v1\0")
    .update(record.network)
    .update("\0")
    .update(record.id)
    .update("\0")
    .update(String(record.derivationIndex))
    .digest("hex")}`;

const safeReason = (error: unknown) =>
  error instanceof Error ? error.message : "unknown";

const reasonCode = (reason: string) =>
  reason.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 80) || "unknown";
