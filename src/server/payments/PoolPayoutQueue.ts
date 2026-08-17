import { createHash, randomBytes } from "node:crypto";
import { Interface } from "ethers";
import { solanaSignatureFromSignedTransaction } from "../base/SolanaX402Facilitator";
import {
  coordinatorLogicalId,
  evmPayloadFingerprint,
  SettlerNotYetFinalError,
  SettlerQuarantinedError,
  type DispatchOutcome,
} from "../base/TransactionCoordinator";
import type {
  ChainRail,
  ChainRailPayoutVerdict,
  ChainRailPreparedPayout,
} from "../rails/ChainRail";
import type { PrivatePaymentLedger } from "./PrivatePaymentLedger";
import {
  type GroupState,
  type LegState,
  type PendingPayoutGroup,
  type PendingPayoutJournal,
  type PendingPayoutLeg,
} from "./PendingPayoutJournal";
import {
  adaptiveKEffTarget,
  anonymityByLane,
  type ConcentrationGroup,
  type ConcentrationLeg,
  computeKEff,
  type KEffSample,
  kEffHistogram,
  laneKeyFor,
  planWindowRelease,
} from "../../shared/payoutConcentration";
import {
  deriveScheduleJitter,
  epochOf,
  epochSeed,
  scheduleCommitment,
  scheduleSlot,
} from "../../shared/payoutScheduleCommitment";
import { CohortBook, type CohortKind, type CohortRecord } from "./CohortBook";
import { ConcentrationStateStore } from "./ConcentrationStateStore";

export interface PoolPayoutLegInput {
  index: number;
  payoutRef: string;
  recipient: string;
  amountAtomic: string;
  ephemeralPubKey?: string;
  denominationAtomic?: string | null;
}

export interface EnqueueGroupInput {
  groupRef: string;
  ownerTag: string;
  network: string;
  asset: string;
  strategy: "single" | "denominations";
  planHash: string;
  payerBalanceAtomic: string;
  legs: PoolPayoutLegInput[];
  offchainChange: null;
  /** Signed client-declared release cap (§5); clamped to the server ceiling by the gate. */
  maxHoldMs?: number;
}

export interface QueuedGroupReceipt {
  kind: "pool-payout-queued";
  groupRef: string;
  network: string;
  strategy: "single" | "denominations";
  legs: {
    index: number;
    recipient: string;
    amountAtomic: string;
    ephemeralPubKey?: string;
  }[];
  offchainChangeAtomic: string;
  state: "queued";
  payerBalanceAtomic: string;
  estimatedSubmitBeforeMs: number;
}

export interface PayoutGroupClaim {
  groupRef: string;
  groupState: GroupState | "unknown";
  network?: string;
  legs: {
    index: number;
    state: LegState;
    chainStatus?: "included" | "finalized";
    mode?: "dry-run" | "onchain";
    transactionHash?: string;
    recipient?: string;
    amountAtomic?: string;
    terminalAt?: number;
  }[];
  offchainChange: null;
  /**
   * Realized concentration for the window this group's legs were released in
   * (spec-payout-concentration.md §7). Present only when the gate is enabled and the
   * group has been released; returned exclusively over this owner-bound claim so an
   * agent learns its ACTUAL anonymity set — and can detect operator isolation (A1).
   */
  concentration?: {
    realizedKEff: number;
    heldMs: number;
    /**
     * §2.9 H11 — worst landing-block spread over the cohorts this group's legs
     * were in, so an agent can see when its "K-way" cohort actually landed as
     * two visually distinct on-chain clusters. Absent = unmeasured (a legacy
     * cohort or a member without a landing coordinate), never = tight.
     */
    landingSpreadBlocks?: number;
    /** Worst measured first-to-last broadcast spread, same absence rule. */
    broadcastSpreadMs?: number;
  };
}

interface QueueOptions {
  journal: PendingPayoutJournal;
  ledger: PrivatePaymentLedger;
  rails: ReadonlyMap<string, ChainRail>;
  flushMs: number;
  maxJitterMs: number;
  maxAttempts: number;
  /**
   * Cadence of the periodic reconcile pass that promotes in-flight legs to a
   * terminal state. Without it the ONLY reconciles are `recover()` at startup and a
   * single `sweep()` from `start()` — the flush timer selects `queued` legs only, so
   * a leg that is mined but not yet final would sit in flight until the next process
   * restart. That is not hypothetical: an EVM leg outlives its confirm budget on
   * every real chain, and a Solana leg is status-polled milliseconds after broadcast
   * against a ~13s rooting time, so both need a later pass to ever settle.
   */
  reconcileMs: number;
  recoveryBudgetMs: number;
  claimTtlMs: number;
  // Payout concentration (spec-payout-concentration.md §4/§8). Optional so existing
  // callers stay gate-off (kEffTarget 1 is inert even when enabled).
  concentrationEnabled?: boolean;
  kEffTarget?: number;
  maxHoldMs?: number;
  // §14 adaptive target. Off ⇒ the static kEffTarget is used unchanged. On ⇒ the
  // target is derived from observed concurrency and is 1 until there is evidence,
  // so a low-user-count deployment is never held.
  kEffAdaptive?: boolean;
  kEffCeiling?: number;
  kEffAdaptiveWindowMs?: number;
  kEffAdaptiveMinSamples?: number;
  kEffAdaptiveQuantile?: number;
  // §6 committed schedule: a per-network master secret makes each window's jitter
  // deterministic and later verifiable. Absent ⇒ jitter falls back to `random`.
  scheduleMasterSeed?: string;
  scheduleEpochMs?: number;
  /**
   * §4 (Codex F3) — durable home for the adaptive evidence and the §6 master secret.
   * Absent ⇒ both stay in memory and a restart resets the deployment's privacy
   * posture, which is the operator lever this closes. Optional so existing callers
   * and the offline smokes construct unchanged.
   */
  concentrationStore?: ConcentrationStateStore;
  /**
   * §5 R9 — durable cohort manifests. Absent ⇒ manifests are held in memory only
   * and a claim made after a restart reports nothing. Optional so existing callers
   * construct unchanged; the server always supplies one when concentration is on.
   */
  cohortBook?: CohortBook;
  // §7 aggregate publication of realized k_eff (default off).
  kEffPublishEnabled?: boolean;
  now?: () => number;
  random?: () => number;
}

export class PoolPayoutQueue {
  private readonly journal: PendingPayoutJournal;
  private readonly ledger: PrivatePaymentLedger;
  private readonly rails: ReadonlyMap<string, ChainRail>;
  private readonly flushMs: number;
  private readonly maxJitterMs: number;
  private readonly maxAttempts: number;
  private readonly reconcileMs: number;
  private readonly recoveryBudgetMs: number;
  private readonly claimTtlMs: number;
  private readonly concentrationEnabled: boolean;
  private readonly kEffTarget: number;
  private readonly maxHoldMs: number;
  private readonly kEffAdaptive: boolean;
  private readonly kEffCeiling: number;
  private readonly kEffAdaptiveWindowMs: number;
  private readonly kEffAdaptiveMinSamples: number;
  private readonly kEffAdaptiveQuantile: number;
  // §14 — PRE-gate window k_eff observations, the evidence the adaptive target is
  // derived from. Distinct from `kEffSamples` (post-gate realized, for §7 publication).
  //
  // Keyed BY NETWORK. A single shared pool let one rail's concurrency raise the hold
  // target on every other rail: Base demonstrating k_eff=4 would hold a lone Solana
  // or Robinhood withdrawer to maxHoldMs on evidence those rails never produced.
  // Adaptive evidence is only meaningful where it was observed (spec-exit-rounds.md
  // §4, invariant 1), and it is keyed by LANE — `network:asset:denominationAtomic` —
  // so a busy denomination cannot raise the hold target for a quiet one beside it on
  // the same rail.
  private concurrencySamples = new Map<string, KEffSample[]>();
  private scheduleMasterSeed?: string;
  private readonly scheduleEpochMs: number;
  private readonly concentrationStore?: ConcentrationStateStore;
  private readonly kEffPublishEnabled: boolean;
  // Per-window realized k_eff samples for the lagged aggregate (§7). Bounded.
  private kEffSamples: KEffSample[] = [];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly networkLocks = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  // §5 — cohort manifests, keyed by id. This is the working copy; `cohortBook` is
  // its durable mirror and rehydrates it at startup, so there is exactly ONE read
  // path for a claim whether or not the deployment persists.
  private readonly cohortsById = new Map<string, CohortRecord>();
  private readonly cohortBook?: CohortBook;
  private stopped = true;
  private recovered = false;

  constructor(options: QueueOptions) {
    validateDuration("flushMs", options.flushMs);
    validateDuration("maxJitterMs", options.maxJitterMs);
    validateDuration("reconcileMs", options.reconcileMs);
    validateDuration("recoveryBudgetMs", options.recoveryBudgetMs);
    validateDuration("claimTtlMs", options.claimTtlMs);
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error("Pool payout maxAttempts must be an integer >= 1");
    }
    const kEffTarget = options.kEffTarget ?? 1;
    if (!Number.isInteger(kEffTarget) || kEffTarget < 1) {
      throw new Error("Pool payout kEffTarget must be an integer >= 1");
    }
    // §4.2 R3 — the hold is mandatory, finite, and bounded. Validate at construction
    // so no configuration can produce an unbounded hold.
    const maxHoldMs = options.maxHoldMs ?? 900_000;
    if (!Number.isFinite(maxHoldMs) || maxHoldMs <= 0) {
      throw new Error("Pool payout maxHoldMs must be a positive finite number");
    }
    this.journal = options.journal;
    this.ledger = options.ledger;
    this.rails = options.rails;
    this.flushMs = options.flushMs;
    this.maxJitterMs = options.maxJitterMs;
    this.maxAttempts = options.maxAttempts;
    this.reconcileMs = options.reconcileMs;
    this.recoveryBudgetMs = options.recoveryBudgetMs;
    this.claimTtlMs = options.claimTtlMs;
    // §14 adaptive target. The ceiling is the only value an operator sets to raise
    // the ambition; it is never itself a target, so a fresh deployment with adaptive
    // ON and no traffic still runs at target 1.
    const kEffCeiling = options.kEffCeiling ?? 8;
    if (!Number.isInteger(kEffCeiling) || kEffCeiling < 1) {
      throw new Error("Pool payout kEffCeiling must be an integer >= 1");
    }
    const kEffAdaptiveWindowMs = options.kEffAdaptiveWindowMs ?? 21_600_000;
    if (!Number.isFinite(kEffAdaptiveWindowMs) || kEffAdaptiveWindowMs <= 0) {
      throw new Error("Pool payout kEffAdaptiveWindowMs must be a positive finite number");
    }
    const kEffAdaptiveMinSamples = options.kEffAdaptiveMinSamples ?? 20;
    if (!Number.isInteger(kEffAdaptiveMinSamples) || kEffAdaptiveMinSamples < 1) {
      throw new Error("Pool payout kEffAdaptiveMinSamples must be an integer >= 1");
    }
    const kEffAdaptiveQuantile = options.kEffAdaptiveQuantile ?? 0.5;
    if (!Number.isFinite(kEffAdaptiveQuantile)
      || kEffAdaptiveQuantile < 0
      || kEffAdaptiveQuantile > 1) {
      throw new Error("Pool payout kEffAdaptiveQuantile must be between 0 and 1");
    }
    this.concentrationEnabled = options.concentrationEnabled ?? false;
    this.kEffTarget = kEffTarget;
    this.maxHoldMs = maxHoldMs;
    this.kEffAdaptive = options.kEffAdaptive ?? false;
    this.kEffCeiling = kEffCeiling;
    this.kEffAdaptiveWindowMs = kEffAdaptiveWindowMs;
    this.kEffAdaptiveMinSamples = kEffAdaptiveMinSamples;
    this.kEffAdaptiveQuantile = kEffAdaptiveQuantile;
    const scheduleEpochMs = options.scheduleEpochMs ?? 3_600_000;
    if (!Number.isFinite(scheduleEpochMs) || scheduleEpochMs <= 0) {
      throw new Error("Pool payout scheduleEpochMs must be a positive finite number");
    }
    this.scheduleMasterSeed = options.scheduleMasterSeed;
    this.scheduleEpochMs = scheduleEpochMs;
    this.concentrationStore = options.concentrationStore;
    this.cohortBook = options.cohortBook;
    this.kEffPublishEnabled = options.kEffPublishEnabled ?? false;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async enqueueGroup(input: EnqueueGroupInput): Promise<QueuedGroupReceipt> {
    if ((input as { offchainChange: unknown }).offchainChange !== null) {
      throw new Error("pool_payout_change_not_enabled");
    }
    if (input.legs.length === 0) throw new Error("Pool payout group must have at least one leg");
    const existing = this.journal.byRef(input.groupRef);
    if (existing) return this.queuedReceipt(input);
    const rail = this.requireRail(input.network);
    const indexes = new Set<number>();
    const refs = new Set<string>();
    const legs: PendingPayoutLeg[] = input.legs.map((leg) => {
      if (indexes.has(leg.index) || refs.has(leg.payoutRef)) {
        throw new Error("Pool payout group has duplicate leg indexes or refs");
      }
      indexes.add(leg.index);
      refs.add(leg.payoutRef);
      if (BigInt(leg.amountAtomic) <= 0n) throw new Error("Pool payout leg amount must be positive");
      const logicalId = poolPayoutLogicalId({
        payoutRef: leg.payoutRef,
        recipient: leg.recipient,
        amountAtomic: leg.amountAtomic,
        network: input.network,
        tokenAddress: rail.tokenConfig.address,
        chainId: rail.tokenConfig.chainId,
      });
      rail.bindPoolPayoutRef(logicalId, leg.payoutRef);
      return {
        ...leg,
        logicalId,
        state: "queued",
        attempts: 0,
        gen: 0,
      };
    });
    const group: PendingPayoutGroup = {
      groupRef: input.groupRef,
      ownerTag: input.ownerTag,
      network: input.network,
      asset: normalizeAsset(input.network, input.asset),
      strategy: input.strategy,
      planHash: input.planHash,
      legs,
      offchainChange: null,
      groupState: "queued",
      createdAt: this.now(),
      ...(input.maxHoldMs !== undefined ? { maxHoldMs: input.maxHoldMs } : {}),
    };
    await this.journal.putGroup(group);
    return this.queuedReceipt(input);
  }

  async claim(groupRef: string): Promise<PayoutGroupClaim> {
    const group = this.journal.byRef(groupRef);
    if (!group) {
      return { groupRef, groupState: "unknown", legs: [], offchainChange: null };
    }
    return {
      groupRef,
      groupState: group.groupState,
      network: group.network,
      legs: group.legs.map((leg) => ({
        index: leg.index,
        state: leg.state,
        chainStatus: leg.chainStatus,
        mode: leg.mode,
        transactionHash: leg.transactionHash,
        recipient: leg.recipient,
        amountAtomic: leg.amountAtomic,
        terminalAt: leg.terminalAt,
      })),
      offchainChange: null,
      concentration: this.concentrationFor(groupRef),
    };
  }

  ownerTag(groupRef: string): string | undefined {
    return this.journal.byRef(groupRef)?.ownerTag;
  }

  async recover(): Promise<void> {
    if (this.recovered) throw new Error("Pool payout queue recovery may run only once");
    this.recovered = true;
    await this.journal.load();
    await this.restoreConcentrationState();
    // R9 — rehydrate cohort manifests, so a claim made after a restart still reports
    // what its cohort achieved instead of falling silent.
    if (this.cohortBook) {
      for (const cohort of (await this.cohortBook.load()).all()) {
        this.cohortsById.set(cohort.cohortId, cohort);
      }
    }

    const knownRefs = this.journal.knownRefs();
    const protectedOrphans = new Set<string>();
    const journalLessClassifications: {
      rail: ChainRail;
      ref: string;
      logicalId: string;
      nonce: number;
    }[] = [];
    for (const ref of this.ledger.pendingPayoutRefs()) {
      if (knownRefs.has(ref)) continue;
      for (const rail of this.rails.values()) {
        for (const handle of rail.outboxEntriesByRef(ref)) {
          protectedOrphans.add(ref);
          rail.suppressPoolPayoutRebroadcast(handle.logicalId);
          journalLessClassifications.push({ rail, ref, ...handle });
        }
      }
    }
    await this.ledger.reverseOrphanPayouts(new Set([...knownRefs, ...protectedOrphans]));

    for (const group of this.journal.list()) {
      for (const leg of group.legs) {
        if (isTerminalLeg(leg.state)) continue;
        this.requireRail(group.network).bindPoolPayoutRef(leg.logicalId, leg.payoutRef);
        const transfer = this.ledger.findPayoutTransfer(leg.payoutRef);
        const matches = transfer
          && transfer.asset === groupAssetKey(group)
          && transfer.reversalAccountRef === group.ownerTag
          && transfer.reversalAmountAtomic === leg.amountAtomic;
        if (!matches) {
          this.requireRail(group.network).suppressPoolPayoutRebroadcast(leg.logicalId);
          await this.journal.updateLeg(group.groupRef, leg.index, {
            state: "uncertain",
          }, leg.gen);
          await this.deriveGroupState(group.groupRef);
        }
      }
    }

    const deadline = this.now() + this.recoveryBudgetMs;
    const tasks: Promise<void>[] = [];
    for (const network of this.rails.keys()) {
      const task = this.withNetworkLock(network, async () => {
        for (const item of journalLessClassifications.filter((entry) => entry.rail.network === network)) {
          if (this.now() >= deadline) return;
          // Bounded, because the network lock is released when this TASK finishes,
          // not when `settleWithinBudget` stops awaiting it. An RPC that never
          // answers would therefore keep the lock chained forever and every later
          // flush, claim, and reconcile on this rail would queue behind it — the
          // queue looks alive while silently paying no one. Classification is
          // read-only, so abandoning a late answer is safe; the reconcile below is
          // NOT bounded here, because abandoning it mid-write while releasing the
          // lock would reintroduce exactly the concurrent-write race the lock exists
          // to prevent. It is bounded internally by its own per-leg deadline checks.
          const verdict = await withDeadline(
            item.rail.classifyByLogicalId(item),
            Math.max(0, deadline - this.now()),
          );
          if (!verdict) return;
          if (verdict.status === "landed") {
            await this.ledger.markPayoutSettled(item.ref, verdict.transactionHash);
          } else if (verdict.status === "terminal-absent") {
            await this.ledger.reversePayout(item.ref);
          }
        }
        await this.reconcileNetwork(network, true);
        if (this.now() < deadline) await this.requireRail(network).recoverOutbox();
      });
      tasks.push(task);
    }
    await Promise.all(tasks.map((task) => settleWithinBudget(task, Math.max(0, deadline - this.now()))));
    for (const group of this.journal.list()) await this.deriveGroupState(group.groupRef);
  }

  start(): void {
    if (!this.recovered) throw new Error("Pool payout queue must recover before start");
    if (!this.stopped) return;
    this.stopped = false;
    for (const network of this.rails.keys()) {
      this.schedule(network);
      this.scheduleReconcile(network);
    }
    void this.sweep().catch((error) => {
      console.error("POOL_PAYOUT_SWEEP_FAILED", error instanceof Error ? error.message : "unknown");
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  flushNow(network?: string): Promise<void> {
    const networks = network ? [network] : [...this.rails.keys()];
    return Promise.all(networks.map((item) => this.withNetworkLock(item, () => this.flushNetwork(item))))
      .then(() => undefined);
  }

  flushGroup(groupRef: string): Promise<void> {
    const group = this.journal.byRef(groupRef);
    if (!group) throw new Error("Pending payout group not found");
    return this.withNetworkLock(group.network, () => this.flushNetwork(group.network, groupRef));
  }

  sweep(network?: string): Promise<void> {
    const networks = network ? [network] : [...this.rails.keys()];
    return Promise.all(networks.map((item) => this.withNetworkLock(
      item,
      () => this.reconcileNetwork(item, true),
    ))).then(() => undefined);
  }

  async resolvePoolPayoutLeg(
    input: { groupRef: string; index: number }
      & ({ landed: true; signature: string } | { absent: true; attestation: string }),
  ): Promise<{ state: "settled" | "failed" | "superseded" }> {
    const snapshot = this.requireLeg(input.groupRef, input.index);
    if (snapshot.leg.state !== "uncertain") throw new Error("Pool payout leg is not uncertain");
    const capturedGen = snapshot.leg.gen;
    const rail = this.requireRail(snapshot.group.network);

    let verdict: "landed" | "terminal-absent";
    let transactionHash: string | undefined;
    if ("landed" in input) {
      if (rail.kind === "solana") {
        if (!snapshot.leg.signedTx || !snapshot.leg.txId) {
          throw new Error("Solana disposition lacks persisted signed transaction");
        }
        const derived = solanaSignatureFromSignedTransaction(snapshot.leg.signedTx);
        if (input.signature !== snapshot.leg.txId || derived !== snapshot.leg.txId) {
          throw new Error("Solana disposition signature does not match persisted transaction");
        }
        const status = await rail.operatorPoolPayoutStatus(this.preparedFromLeg(snapshot.group, snapshot.leg));
        if (status.status !== "landed" || status.transactionHash !== input.signature) {
          throw new Error("Solana landed disposition is not finalized-canonical");
        }
      } else {
        if (snapshot.leg.nonce === undefined) throw new Error("EVM disposition lacks a pinned nonce");
        const status = await rail.classifyByLogicalId({
          logicalId: snapshot.leg.logicalId,
          nonce: snapshot.leg.nonce,
        });
        if (status.status !== "landed" || status.transactionHash !== input.signature) {
          throw new Error("EVM landed disposition is not finalized-canonical");
        }
      }
      verdict = "landed";
      transactionHash = input.signature;
    } else {
      if (!input.attestation.trim()) throw new Error("Archival absence attestation is required");
      if (rail.kind === "solana") {
        if (snapshot.leg.lastValidBlockHeight === undefined) {
          throw new Error("Solana disposition lacks blockhash expiry");
        }
        const height = await rail.finalizedBlockHeight();
        if (height === undefined || height <= snapshot.leg.lastValidBlockHeight) {
          throw new Error("Solana payout blockhash is not expired at the finalized head");
        }
      } else {
        if (snapshot.leg.nonce === undefined) throw new Error("EVM disposition lacks a pinned nonce");
        const status = await rail.classifyByLogicalId({
          logicalId: snapshot.leg.logicalId,
          nonce: snapshot.leg.nonce,
        });
        if (status.status !== "terminal-absent") {
          throw new Error("EVM payout absence is not finalized-authoritative");
        }
      }
      verdict = "terminal-absent";
    }

    return this.withNetworkLock(snapshot.group.network, async () => {
      const current = this.requireLeg(input.groupRef, input.index);
      if (current.leg.gen !== capturedGen || current.leg.state !== "uncertain") {
        return { state: "superseded" as const };
      }
      const claimed = await this.journal.updateLeg(input.groupRef, input.index, {
        state: "uncertain",
      }, capturedGen);
      if (!claimed) return { state: "superseded" as const };
      if (verdict === "landed") {
        await this.ledger.markPayoutSettled(current.leg.payoutRef, transactionHash);
        await this.journal.updateLeg(input.groupRef, input.index, {
          state: "settled",
          chainStatus: "finalized",
          transactionHash,
          terminalAt: this.now(),
        }, capturedGen + 1);
        await this.deriveGroupState(input.groupRef);
        return { state: "settled" as const };
      }
      await this.ledger.reversePayout(current.leg.payoutRef);
      await this.journal.updateLeg(input.groupRef, input.index, {
        state: "failed",
        terminalAt: this.now(),
      }, capturedGen + 1);
      await this.deriveGroupState(input.groupRef);
      return { state: "failed" as const };
    });
  }

  private async flushNetwork(network: string, onlyGroupRef?: string) {
    const rail = this.requireRail(network);
    const candidates = this.journal.list()
      .filter((group) => group.network === network
        && (!onlyGroupRef || group.groupRef === onlyGroupRef))
      .flatMap((group) => group.legs
        .filter((leg) => leg.state === "queued")
        .map((leg) => ({ group, leg })));
    shuffle(candidates, this.random);
    // A quarantined settler means nothing in this window can broadcast, so skip
    // release AND cohort planning — not just the per-leg check inside flushLeg.
    // Without this, every window against a quarantined rail released groups
    // through the concentration gate, minted a fresh cohort manifest that could
    // never resolve, and recorded k_eff samples for releases that never touched
    // the chain: unbounded manifest growth plus histogram pollution across a
    // long quarantine. The retention/cohort-resolution tail below still runs —
    // a quarantine must not also stall reaping of pre-quarantine terminals.
    if (!rail.settlerQuarantined?.()) {
      let releasable = candidates;
      if (this.concentrationEnabled && candidates.length > 0) {
        if (onlyGroupRef) {
          // §4.2 R5 — targeted/recovery flushes bypass the gate; gating a single-group
          // flush would deadlock it (a lone group can never reach its own k_eff target).
          console.warn(`POOL_PAYOUT_CONCENTRATION_UNGATED ${network} groupRef=${onlyGroupRef}`);
        } else {
          releasable = await this.applyConcentrationGate(network, candidates);
        }
      }
      // §2.2/§2.6: WINDOWED releases on an on-chain EVM rail dispatch as one
      // wave and never await finality — the reconcile finishes the legs. The
      // TARGETED flush (onlyGroupRef — the flag-off synchronous path) keeps the
      // awaited submit deliberately: its external contract is a one-leg receipt
      // that resolves at finality, and that contract is frozen.
      const dispatchCapable = rail.kind === "evm"
        && rail.poolMode === "onchain"
        && !onlyGroupRef
        && typeof rail.dispatchPoolPayouts === "function";
      if (dispatchCapable && releasable.length > 0) {
        await this.dispatchLegs(rail, releasable);
      } else {
        for (const candidate of releasable) {
          await this.flushLeg(rail, candidate.group, candidate.leg);
        }
      }
    }
    for (const group of this.journal.list().filter((item) => item.network === network)) {
      await this.deriveGroupState(group.groupRef);
    }
    // R8 — resolve cohorts BEFORE the prune, while every member's final leg state
    // is still readable. After the prune a settled member is indistinguishable from
    // one that never resolved.
    await this.settleCohorts(network);
    const horizon = this.now() - this.claimTtlMs;
    await this.journal.prune(horizon);
    await this.pruneCohorts(horizon);
  }

  /**
   * §4 flush gate — decide which queued legs may broadcast this window. Held legs
   * are simply excluded from the returned set; they NEVER reach `flushLeg`, so a
   * privacy hold cannot increment `attempts` or start a confirmation timer (§4.2
   * R1/R2), and a held leg stays an ordinary `queued` leg on disk — indistinguishable
   * from a never-flushed one on restart (§4.2 R4). No journal write, no CAS.
   */
  private async applyConcentrationGate(
    network: string,
    candidates: { group: PendingPayoutGroup; leg: PendingPayoutLeg }[],
  ): Promise<{ group: PendingPayoutGroup; leg: PendingPayoutLeg }[]> {
    // spec-exit-rounds.md §3 / R11 — an exact (null-denomination) leg is its own
    // degenerate lane of width one. It can NEVER gain cover, so holding it delays
    // it for nothing; and because k_eff is the MINIMUM over the window, letting it
    // in would drag the whole window to 1 and hold every standard-denomination leg
    // sharing that flush — one non-tiling withdrawal stalling everyone else's, and
    // zeroing the adaptive evidence for the network at the same time.
    //
    // So it is separated here: released immediately, reported honestly as 1, and
    // excluded from both the gate decision and the evidence. Groups are homogeneous
    // (`strategy:"single"` is exactly one exact leg; `denominations` legs all carry
    // one), so this partitions cleanly at group level.
    const exact = candidates.filter((candidate) => candidate.leg.denominationAtomic == null);
    const denominated = candidates.filter((candidate) => candidate.leg.denominationAtomic != null);
    const nowMs = this.now();
    if (denominated.length === 0) {
      // R11 — exact legs are their own cohort even when they are the whole window.
      if (exact.length > 0) await this.planCohort(network, "exact", exact, 1, 1, nowMs);
      return exact;
    }

    const groups = new Map<string, ConcentrationGroup>();
    // The journal rows behind the views, so the evidence rule below can read each
    // group's `evidenceCountedAt` marker without a second journal scan.
    const byRef = new Map<string, PendingPayoutGroup>();
    for (const { group, leg } of denominated) {
      byRef.set(group.groupRef, group);
      let view = groups.get(group.groupRef);
      if (!view) {
        view = {
          groupRef: group.groupRef,
          // Anonymity is counted over paying ACCOUNTS. `ownerTag` is the ledger
          // account reference; `groupRef` is only a quote nonce, and an agent may
          // mint arbitrarily many of those (see `anonymityByLeg`).
          ownerRef: group.ownerTag,
          createdAt: group.createdAt,
          // §5 — the group's signed client cap, clamped to the server ceiling. A
          // shorter client cap only shortens its own hold; it can never widen past
          // the ceiling, and absence falls back to the ceiling.
          maxHoldMs: group.maxHoldMs !== undefined
            ? Math.min(group.maxHoldMs, this.maxHoldMs)
            : this.maxHoldMs,
          legs: [],
        };
        groups.set(group.groupRef, view);
      }
      view.legs.push({
        groupRef: group.groupRef,
        ownerRef: group.ownerTag,
        denominationAtomic: leg.denominationAtomic,
        // The lane carries the ASSET, not just the denomination: 1000000 of USDC and
        // 1000000 of USDG are not interchangeable to an observer, and a
        // denomination-only tally would merge them and overstate k_eff.
        laneKey: laneKeyFor({
          network: group.network,
          asset: group.asset,
          denominationAtomic: leg.denominationAtomic,
        }),
      });
    }
    const now = nowMs;
    // §14 — resolve targets BEFORE this window is measured, so a window can never
    // raise the bar it is itself judged against. §4 — resolved PER LANE, and
    // memoized so the same lane cannot be sampled twice at different values within
    // one evaluation.
    const laneTargets = new Map<string, number>();
    const targetForLane = (laneKey: string): number => {
      let target = laneTargets.get(laneKey);
      if (target === undefined) {
        target = this.effectiveKEffTarget(now, laneKey);
        laneTargets.set(laneKey, target);
      }
      return target;
    };
    const windowLegs = [...groups.values()].flatMap((view) => view.legs);
    const laneAnonymity = anonymityByLane(windowLegs);
    for (const laneKey of laneAnonymity.keys()) targetForLane(laneKey);
    const kEffTarget = laneTargets.size > 0 ? Math.max(...laneTargets.values()) : this.kEffTarget;
    const decision = planWindowRelease([...groups.values()], {
      kEffTarget,
      targetForLane,
      now,
    });
    // §4 (Codex B2) — evidence counts FRESH ARRIVALS ONLY, each group exactly once.
    //
    // The gate above is judged on the whole window, which is right: a held group is
    // genuinely present and genuinely provides cover. But evidence is a different
    // question — "how much concurrency does this lane actually attract?" — and
    // re-counting the same held backlog every 60 s answers it with an echo. Four
    // groups arriving once and then held for fifteen minutes would deposit fifteen
    // identical observations, satisfy `minSamples` on their own, and ratchet the
    // lane's target to 4 *because they were held* — the gate manufacturing its own
    // justification, and then holding the next lone withdrawer on the strength of
    // traffic that stopped a quarter of an hour ago.
    //
    // Counting arrivals systematically UNDER-estimates concurrency (a fresh group
    // landing beside three held ones records 1, not 4). That direction is deliberate:
    // an under-estimate only ever releases sooner, and "delay, never refuse" makes a
    // premature release the cheap error.
    const freshRefs = [...groups.keys()].filter(
      (ref) => byRef.get(ref)?.evidenceCountedAt === undefined,
    );
    if (freshRefs.length > 0) {
      // Persist the marker BEFORE recording the sample. A crash between the two loses
      // one observation; the reverse order would re-count the group after restart,
      // which is the exact defect this rule exists to prevent. Marking is advisory —
      // a failure must never stop a payout — so it is logged and swallowed, and an
      // unmarked group is simply counted again next window.
      const marked = await this.journal
        .markEvidenceCounted(freshRefs, now)
        .catch((error: unknown) => {
          console.warn(
            "POOL_PAYOUT_EVIDENCE_MARK_FAILED",
            network,
            error instanceof Error ? error.message : "unknown",
          );
          return [] as string[];
        });
      if (marked.length > 0) {
        const fresh = new Set(marked);
        for (const [laneKey, anonymity] of anonymityByLane(
          windowLegs.filter((leg) => fresh.has(leg.groupRef)),
        )) {
          this.recordConcurrencySample(laneKey, now, anonymity);
        }
        // Awaited, not fired-and-forgotten. The marker is already durable at this
        // point, so an unwritten sample is a group that will never be counted at
        // all — and the window most likely to be interrupted by a restart is the
        // one that just ran. Bounded local write, same class as the marker above.
        await this.persistConcentrationState();
      }
    }
    const release = new Set(decision.releaseGroupRefs);
    const releasedDenominated = denominated.filter(
      (candidate) => release.has(candidate.group.groupRef),
    );
    // §5 PLAN — the manifest is persisted here, BEFORE anything is broadcastable.
    // R11 keeps the three release kinds in separate manifests with separate ids:
    // a complete cohort, stragglers force-released at their cap, and exact legs
    // that never had cover to begin with. Merging them would report the complete
    // cohort's members at the window minimum — 1 whenever a single exact leg shared
    // the flush — and report the stragglers as though they had the cohort's cover.
    if (exact.length > 0) await this.planCohort(network, "exact", exact, 1, 1, now);
    if (releasedDenominated.length > 0) {
      await this.planCohort(
        network,
        decision.gated ? "forced" : "cohort",
        releasedDenominated,
        kEffTarget,
        decision.realizedKEff,
        now,
      );
    }
    // §7 — one realized-k_eff sample per window that actually released, retained
    // only long enough to age past the publication lag before it is dropped.
    if (release.size > 0) this.recordKEffSample(now, decision.realizedKEff);
    // R10 — the pre-gate shuffle at the call site only survives because filtering
    // preserves order. Concatenating the two partitions does not: it would emit
    // every exact leg as one contiguous block, and broadcast order is the settler's
    // public, strictly-increasing nonce sequence. Re-shuffle the merged release.
    const merge = (released: typeof candidates) => {
      const all = [...exact, ...released];
      shuffle(all, this.random);
      return all;
    };
    if (!decision.gated) return merge(denominated);
    console.warn(
      `POOL_PAYOUT_CONCENTRATION_HOLD ${network} k_eff=${decision.windowKEff}`
      + ` target=${kEffTarget}${this.kEffAdaptive ? " (adaptive)" : ""}`
      + ` released=${decision.releaseGroupRefs.length}`
      + ` held=${decision.heldGroupRefs.length} realized_k_eff=${decision.realizedKEff}`
      + ` exact_released=${exact.length}`,
    );
    // Held groups stay `queued` and are simply absent from the returned set; the
    // exact legs still go out, because holding one buys nothing.
    return merge(denominated.filter((candidate) => release.has(candidate.group.groupRef)));
  }

  /**
   * §5 PLAN — record who is releasing together, before any of them can broadcast.
   *
   * `plannedKEff` is retained deliberately even though it is never reported to the
   * agent: keeping it beside the realized value is what makes a divergence visible
   * to an operator reviewing a cohort that under-delivered.
   */
  /**
   * Drop resolved cohorts past the claim horizon, mirroring the journal's prune so
   * the working map cannot grow without bound. Unresolved cohorts are kept forever
   * on purpose: one means members that never reached a terminal state, and that is
   * evidence, not garbage.
   */
  private async pruneCohorts(before: number): Promise<void> {
    await this.cohortBook?.prune(before);
    for (const [cohortId, cohort] of this.cohortsById) {
      if (cohort.terminalAt !== undefined && cohort.terminalAt <= before) {
        this.cohortsById.delete(cohortId);
      }
    }
  }

  private async planCohort(
    network: string,
    kind: CohortKind,
    members: { group: PendingPayoutGroup; leg: PendingPayoutLeg }[],
    targetK: number,
    plannedKEff: number,
    nowMs: number,
  ): Promise<void> {
    const record: CohortRecord = {
      // Random rather than a counter: a counter restarts at zero and would collide
      // with manifests already on disk, and `put` rejects a duplicate id — which
      // would surface as a failed flush rather than a mangled metric.
      cohortId: `${network}:${randomBytes(8).toString("hex")}`,
      network,
      kind,
      targetK,
      plannedKEff,
      createdAt: nowMs,
      members: members.map(({ group, leg }) => ({
        groupRef: group.groupRef,
        legIndex: leg.index,
        ownerRef: group.ownerTag,
        laneKey: laneKeyFor({
          network: group.network,
          asset: group.asset,
          denominationAtomic: leg.denominationAtomic,
        }),
        heldMs: nowMs - group.createdAt,
      })),
    };
    await this.cohortBook?.put(record);
    this.cohortsById.set(record.cohortId, record);
  }

  /**
   * §5 REPORT / R8 — resolve every cohort whose members have all reached a terminal
   * state, computing `k_eff` over the ones that actually SETTLED.
   *
   * This is the ordering fix. The realized value used to be written from the release
   * decision, before submission began, so it described the cohort that was planned.
   * A member that failed, was quarantined, or simply never resolved left the number
   * untouched — the payer was told it had cover that did not exist. Now a lost
   * member lowers it, and a cohort where nothing landed resolves to 0.
   *
   * Called after every flush and every reconcile, because on a real chain a leg
   * reaches finality long after the window that released it — routinely after a
   * restart, which is why the manifest is durable.
   */
  private async settleCohorts(network: string): Promise<void> {
    // Known and DELIBERATE (Grok review of 78803f1): a leg that fails in one
    // window and re-queues becomes a member of a later cohort while staying a
    // member of its original one forever, and its eventual landing counts as
    // "settled" in BOTH — so the original cohort's realized k_eff includes a
    // member that never broadcast beside its siblings. Excluding it was tried
    // and reverted: the frozen R8 definition is "over members that actually
    // settled", pinned by the concentration suite, and §2.9's prescribed
    // remedy for temporal partitions is the ANNOTATION, not a redefinition.
    // The honesty channel works: the straggler's own claim min()s across its
    // cohorts to the weakest cover, and its later landedBlock makes the
    // original cohort's landingSpread visibly wide — the tell the siblings'
    // claims carry (pool-payout test 73).
    for (const cohort of [...this.cohortsById.values()]) {
      if (cohort.network !== network || cohort.realizedKEff !== undefined) continue;
      const settled: ConcentrationLeg[] = [];
      const settledLegs: PendingPayoutLeg[] = [];
      let allTerminal = true;
      for (const member of cohort.members) {
        const group = this.journal.byRef(member.groupRef);
        const leg = group?.legs.find((entry) => entry.index === member.legIndex);
        if (!leg || !isTerminalLeg(leg.state)) {
          // A member whose group has been pruned counts as unresolved rather than
          // settled. `settleCohorts` runs before `journal.prune` precisely so this
          // is a crash artifact and not the normal path, and guessing "it probably
          // landed" is the exact optimism R8 exists to remove.
          allTerminal = false;
          continue;
        }
        if (leg.state !== "settled") continue;
        settled.push({
          groupRef: member.groupRef,
          ownerRef: member.ownerRef,
          denominationAtomic: leg.denominationAtomic ?? null,
          laneKey: member.laneKey,
        });
        settledLegs.push(leg);
      }
      if (!allTerminal) continue;
      const realizedKEff = computeKEff(settled);
      const terminalAt = this.now();
      // §2.9 H11 — annotate the realized value with the temporal spread it
      // cannot see. Both measurements follow one rule: recorded only when EVERY
      // settled member measured (a partial measurement reads as tighter than
      // reality on exactly the partitioned windows this exists to expose), and
      // computed over settled members only — a member that never landed is
      // already accounted for by realized k_eff itself.
      let landingSpread: CohortRecord["landingSpread"];
      if (settledLegs.length > 0 && settledLegs.every((leg) => leg.landedBlock !== undefined)) {
        const blocks = settledLegs.map((leg) => leg.landedBlock as number);
        const minBlock = Math.min(...blocks);
        const maxBlock = Math.max(...blocks);
        landingSpread = { minBlock, maxBlock, spreadBlocks: maxBlock - minBlock };
      }
      let broadcastSpreadMs: number | undefined;
      if (settledLegs.length > 0 && settledLegs.every((leg) => leg.broadcastAt !== undefined)) {
        const stamps = settledLegs.map((leg) => leg.broadcastAt as number);
        broadcastSpreadMs = Math.max(...stamps) - Math.min(...stamps);
      }
      await this.cohortBook?.resolve(cohort.cohortId, realizedKEff, terminalAt, {
        landingSpread,
        broadcastSpreadMs,
      });
      this.cohortsById.set(cohort.cohortId, {
        ...cohort,
        realizedKEff,
        terminalAt,
        ...(landingSpread ? { landingSpread } : {}),
        ...(broadcastSpreadMs !== undefined ? { broadcastSpreadMs } : {}),
      });
    }
  }

  /**
   * What a claim reports (§7). A group's legs can end up in more than one cohort
   * when a leg fails and is re-queued into a later window, so the honest answer is
   * the WEAKEST cover any of its legs got — a single leg released alone is a leg
   * released alone, whatever the others achieved.
   */
  private concentrationFor(groupRef: string): {
    realizedKEff: number;
    heldMs: number;
    landingSpreadBlocks?: number;
    broadcastSpreadMs?: number;
  } | undefined {
    let realizedKEff: number | undefined;
    let heldMs: number | undefined;
    let landingSpreadBlocks: number | undefined;
    let broadcastSpreadMs: number | undefined;
    for (const cohort of this.cohortsById.values()) {
      const member = cohort.members.find((entry) => entry.groupRef === groupRef);
      if (!member) continue;
      // Unresolved cohort ⇒ no number yet. Reporting the planned value here is the
      // defect R8 names; silence is the honest interim answer.
      if (cohort.realizedKEff === undefined) return undefined;
      realizedKEff = realizedKEff === undefined
        ? cohort.realizedKEff
        : Math.min(realizedKEff, cohort.realizedKEff);
      heldMs = heldMs === undefined ? member.heldMs : Math.max(heldMs, member.heldMs);
      // §2.9 H11 — the claim reports the WEAKEST cover, so spreads take the
      // maximum (most partitioned) across the group's cohorts. An unmeasured
      // cohort contributes silence, not zero — max over measured values only.
      if (cohort.landingSpread) {
        landingSpreadBlocks = landingSpreadBlocks === undefined
          ? cohort.landingSpread.spreadBlocks
          : Math.max(landingSpreadBlocks, cohort.landingSpread.spreadBlocks);
      }
      if (cohort.broadcastSpreadMs !== undefined) {
        broadcastSpreadMs = broadcastSpreadMs === undefined
          ? cohort.broadcastSpreadMs
          : Math.max(broadcastSpreadMs, cohort.broadcastSpreadMs);
      }
    }
    return realizedKEff === undefined || heldMs === undefined
      ? undefined
      : {
        realizedKEff,
        heldMs,
        ...(landingSpreadBlocks !== undefined ? { landingSpreadBlocks } : {}),
        ...(broadcastSpreadMs !== undefined ? { broadcastSpreadMs } : {}),
      };
  }

  /**
   * §2.2/§2.6 — the windowed EVM release path. Every released leg goes through
   * ONE rail dispatch (one settler-lease acquisition, one broadcast wave) and
   * this method RETURNS without awaiting finality: dispatched legs stay in
   * flight, the reconcile pass classifies them (H7's `pending` keeps the young
   * window quiet), and maintainPoolPayout keeps them live. This is the R12 fix:
   * the network lock is held for the dispatch call, never for a finality wait.
   *
   * R13: every journal write here is generation-fenced. Within one lock hold
   * the fence cannot fail today — the network lock is the outer exclusivity —
   * but a leg's LIFECYCLE now spans many lock acquisitions (flush → reconcile
   * passes → settle), and the fence is what keeps a stale writer from
   * resurrecting a superseded state. Stated invariant: the lock must be held
   * from the moment a leg is selected until its bookkeeping write lands.
   */
  private async dispatchLegs(
    rail: ChainRail,
    candidates: { group: PendingPayoutGroup; leg: PendingPayoutLeg }[],
  ) {
    const dispatchable: { group: PendingPayoutGroup; leg: PendingPayoutLeg; gen: number }[] = [];
    for (const { group, leg } of candidates) {
      const transfer = this.ledger.findPayoutTransfer(leg.payoutRef);
      if (!transfer
        || transfer.asset !== groupAssetKey(group)
        || transfer.reversalAccountRef !== group.ownerTag
        || transfer.reversalAmountAtomic !== leg.amountAtomic) {
        rail.suppressPoolPayoutRebroadcast(leg.logicalId);
        await this.journal.updateLeg(group.groupRef, leg.index, { state: "uncertain" }, leg.gen);
        continue;
      }
      rail.bindPoolPayoutRef(leg.logicalId, leg.payoutRef);
      const claimed = await this.journal.updateLeg(group.groupRef, leg.index, {
        state: "broadcasting",
        attempts: leg.attempts + 1,
      }, leg.gen);
      if (!claimed) continue;
      dispatchable.push({ group, leg, gen: leg.gen + 1 });
    }
    if (dispatchable.length === 0) return;
    let result;
    try {
      result = await rail.dispatchPoolPayouts!(dispatchable.map((item) => ({
        logicalId: item.leg.logicalId,
        recipient: item.leg.recipient,
        amountAtomic: item.leg.amountAtomic,
        nowSeconds: Math.floor(this.now() / 1000),
      })));
    } catch (error) {
      if (error instanceof SettlerQuarantinedError) {
        // §2.5: a quarantine that began mid-window is a delay for the WHOLE
        // wave — every leg returns to queued with its original attempts.
        for (const item of dispatchable) {
          await this.journal.updateLeg(item.group.groupRef, item.leg.index, {
            state: "queued",
            attempts: item.leg.attempts,
          }, item.gen);
        }
        return;
      }
      // A batch abort is NOT a per-leg verdict (review F-THROW): if the wave
      // died after K of N legs already reached the durable outbox, those K are
      // signed, broadcast, and possibly live in a mempool — classifying them
      // `uncertain` would open operator disposition and hard-error the claim
      // for transactions that may still land. A leg WITH a durable identity
      // stays in flight (the reconcile + maintain own it, exactly as if the
      // wave had returned); only legs with NO identity take the error path.
      for (const item of dispatchable) {
        const handle = rail.outboxEntriesByRef(item.leg.payoutRef)
          .find((entry) => entry.logicalId === item.leg.logicalId);
        if (handle) {
          await this.journal.updateLeg(item.group.groupRef, item.leg.index, {
            state: "broadcasting",
            mode: "onchain",
            nonce: handle.nonce,
          }, item.gen);
        } else {
          await this.recordDispatchError(rail, item, error);
        }
      }
      return;
    }
    const byId = new Map(result.outcomes.map((outcome) => [outcome.logicalId, outcome]));
    for (const item of dispatchable) {
      const failureDetail = result.failures.get(item.leg.logicalId);
      if (failureDetail !== undefined) {
        await this.recordDispatchError(rail, item, new Error(failureDetail));
        continue;
      }
      const outcome = byId.get(item.leg.logicalId);
      if (!outcome) {
        await this.recordDispatchError(rail, item, new Error("dispatch returned no outcome for this leg"));
        continue;
      }
      if (outcome.status === "failed") {
        await this.recordDispatchError(rail, item, new Error(outcome.error));
        continue;
      }
      if (outcome.status === "finalized") {
        // Idempotent replay of an operation that already reached finality.
        await this.ledger.markPayoutSettled(item.leg.payoutRef, outcome.txHash);
        await this.journal.updateLeg(item.group.groupRef, item.leg.index, {
          state: "settled",
          mode: "onchain",
          nonce: outcome.nonce,
          txId: outcome.txHash,
          transactionHash: outcome.txHash,
          chainStatus: "finalized",
          terminalAt: this.now(),
        }, item.gen);
        continue;
      }
      // dispatched: durable identity recorded, leg stays IN FLIGHT.
      await this.journal.updateLeg(item.group.groupRef, item.leg.index, {
        state: "broadcasting",
        mode: "onchain",
        nonce: outcome.nonce,
        txId: outcome.txHash,
        // §2.9 H11 — conditional so an idempotent re-dispatch (no fresh
        // broadcast, no timestamp) cannot erase the original wave's value.
        ...(outcome.broadcastAtMs !== undefined ? { broadcastAt: outcome.broadcastAtMs } : {}),
      }, item.gen);
    }
    // §2.9 measurement (the deploy-gate item): the spec's landing-tightness
    // statement (~0.5–2.5 s / 1–2 Base blocks for 8 legs) is a MODEL until a
    // real wave measures it. This logs the first-to-last first-broadcast spread
    // of every wave with at least two fresh broadcasts, so production measures
    // itself on the first real cohort and the claim can cite a number.
    const stamps = result.outcomes
      .filter((outcome): outcome is Extract<DispatchOutcome, { status: "dispatched" }> =>
        outcome.status === "dispatched")
      .map((outcome) => outcome.broadcastAtMs)
      .filter((at): at is number => at !== undefined);
    if (stamps.length >= 2) {
      console.warn(
        `POOL_PAYOUT_WAVE_SPREAD ${rail.network} legs=${result.outcomes.length}`
        + ` fresh=${stamps.length} spread_ms=${Math.max(...stamps) - Math.min(...stamps)}`,
      );
    }
  }

  /** Mirrors flushLeg's error tail, generation-fenced (R13). */
  private async recordDispatchError(
    rail: ChainRail,
    item: { group: PendingPayoutGroup; leg: PendingPayoutLeg; gen: number },
    error: unknown,
  ) {
    const attempts = item.leg.attempts + 1;
    const outbox = rail.outboxEntriesByRef(item.leg.payoutRef);
    if (outbox.length > 0 || attempts >= this.maxAttempts) {
      await this.journal.updateLeg(item.group.groupRef, item.leg.index, {
        state: "uncertain",
        attempts,
      }, item.gen);
    } else {
      await this.journal.updateLeg(item.group.groupRef, item.leg.index, {
        state: "queued",
        attempts,
      }, item.gen);
    }
    if (error instanceof Error && /terminal-absent|finalized occupant/.test(error.message)) {
      const current = this.requireLeg(item.group.groupRef, item.leg.index);
      await this.applyVerdict(current.group, current.leg, { status: "terminal-absent" }, false);
    }
  }

  private async flushLeg(rail: ChainRail, group: PendingPayoutGroup, leg: PendingPayoutLeg) {
    const transfer = this.ledger.findPayoutTransfer(leg.payoutRef);
    if (!transfer
      || transfer.asset !== groupAssetKey(group)
      || transfer.reversalAccountRef !== group.ownerTag
      || transfer.reversalAmountAtomic !== leg.amountAtomic) {
      rail.suppressPoolPayoutRebroadcast(leg.logicalId);
      await this.journal.updateLeg(group.groupRef, leg.index, { state: "uncertain" });
      return;
    }
    rail.bindPoolPayoutRef(leg.logicalId, leg.payoutRef);
    // §2.5 (frozen rule: delay, never refuse). A quarantined settler means every
    // submission on this rail is going to park behind operator disposition —
    // that is a DELAY, not a failed attempt. Skip before the attempts write, so
    // the leg stays queued literally byte-identical with zero journal churn:
    // counting these windows toward maxAttempts would convert a three-window
    // quarantine into operator-disposition `uncertain` for every queued leg on
    // the rail — a refusal by another name.
    if (rail.settlerQuarantined?.()) return;
    const attempts = leg.attempts + 1;
    await this.journal.updateLeg(group.groupRef, leg.index, {
      state: "broadcasting",
      attempts,
    });
    try {
      if (rail.kind === "evm") {
        const prepared = await rail.submitPoolPayout({
          recipient: leg.recipient,
          amountAtomic: leg.amountAtomic,
          nowSeconds: Math.floor(this.now() / 1000),
          logicalId: leg.logicalId,
        });
        await this.settlePrepared(group, leg, prepared);
        return;
      }

      const prepared = await rail.preparePoolPayout({
        recipient: leg.recipient,
        amountAtomic: leg.amountAtomic,
        nowSeconds: Math.floor(this.now() / 1000),
        logicalId: leg.logicalId,
      });
      if (prepared.mode === "dry-run") {
        await this.settlePrepared(group, leg, prepared);
        return;
      }
      if (!prepared.signedTx
        || !prepared.txId
        || prepared.lastValidBlockHeight === undefined) {
        throw new Error("Solana prepare omitted durable transaction identity");
      }
      await this.journal.updateLeg(group.groupRef, leg.index, {
        state: "broadcasting",
        mode: "onchain",
        signedTx: prepared.signedTx,
        txId: prepared.txId,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        contextSlot: prepared.contextSlot,
      });
      try {
        await rail.broadcastPoolPayout(prepared);
      } catch {
        // An accepted-but-lost RPC response is ambiguous. The persisted bytes
        // remain the sole identity and are classified below, never rebuilt.
      }
      const verdict = await rail.poolPayoutStatus(prepared);
      await this.applyVerdict(group, leg, verdict, false);
    } catch (error) {
      if (error instanceof SettlerQuarantinedError) {
        // The quarantine began between the check above and the submit — the
        // race window. Nothing was signed, no nonce allocated, no outbox entry
        // written, so the pre-call attempts write is reverted to the leg's
        // original values: parked is not an attempt (§2.5), and the leg goes
        // back to queued for the next window.
        //
        // Accepted residual: a crash BETWEEN the pre-call attempts write and
        // this revert leaks one attempts increment across the restart (recovery
        // resets the state but deliberately not the counter, because for
        // genuine pre-outbox failures the counter is real signal). Bounded by
        // actual crashes inside an already-rare race window; the worst case is
        // an early maxAttempts trip to `uncertain`, which is operator-
        // recoverable disposition, not fund loss.
        await this.journal.updateLeg(group.groupRef, leg.index, {
          state: "queued",
          attempts: leg.attempts,
        });
        return;
      }
      if (error instanceof SettlerNotYetFinalError) {
        // The transfer mined and is canonical; only finality is outstanding. Falling
        // through to the `uncertain` branch below would undo the point of the fix:
        // `uncertain` is a hard error on the flag-off synchronous claim path, and it
        // is the sole entry condition for operator disposition — so every healthy
        // in-flight payout would surface in `audit:pool-payout-uncertain` demanding
        // manual review. Record it as in-flight and let the reconcile finish it.
        await this.applyVerdict(group, leg, {
          status: "included",
          transactionHash: error.transactionHash,
        }, false);
        return;
      }
      const outbox = rail.outboxEntriesByRef(leg.payoutRef);
      if (outbox.length > 0 || rail.kind === "solana") {
        await this.journal.updateLeg(group.groupRef, leg.index, {
          state: "uncertain",
          attempts,
        });
      } else if (attempts >= this.maxAttempts) {
        await this.journal.updateLeg(group.groupRef, leg.index, {
          state: "uncertain",
          attempts,
        });
      } else {
        await this.journal.updateLeg(group.groupRef, leg.index, {
          state: "queued",
          attempts,
        });
      }
      if (error instanceof Error && /terminal-absent/.test(error.message)) {
        await this.applyVerdict(group, leg, { status: "terminal-absent" }, false);
      }
    }
  }

  private async settlePrepared(
    group: PendingPayoutGroup,
    leg: PendingPayoutLeg,
    prepared: ChainRailPreparedPayout,
  ) {
    await this.ledger.markPayoutSettled(leg.payoutRef, prepared.txId);
    await this.journal.updateLeg(group.groupRef, leg.index, {
      state: "settled",
      mode: prepared.mode,
      nonce: prepared.nonce,
      txId: prepared.txId,
      transactionHash: prepared.txId,
      chainStatus: "finalized",
      terminalAt: this.now(),
    });
  }

  private async reconcileNetwork(network: string, recoveryWrite: boolean) {
    const rail = this.requireRail(network);
    for (const group of this.journal.list().filter((item) => item.network === network)) {
      for (const leg of group.legs) {
        if (isTerminalLeg(leg.state)) continue;
        const transfer = this.ledger.findPayoutTransfer(leg.payoutRef);
        if (!transfer) continue;
        const gen = leg.gen;
        if (rail.kind === "evm") {
          const handles = rail.outboxEntriesByRef(leg.payoutRef);
          // The leg's OWN entry only — the old `?? handles[0]` fallback adopted
          // whatever entry shared the payoutRef and applied ITS verdict to this
          // leg (Grok review of 78803f1): a foreign "landed" would settle this
          // leg's debit against a transaction that never paid its recipient,
          // and a foreign "terminal-absent" would refund a payer whose real
          // transfer could still land. Dropping the fallback is safe because
          // the outbox NEVER prunes (H14): any leg that ever gained an outbox
          // identity matches here forever, so a miss proves this leg never
          // broadcast — and requeueing a never-broadcast leg cannot double-pay.
          const handle = handles.find((item) => item.logicalId === leg.logicalId);
          if (!handle) {
            if (handles.length > 0) {
              // A ref carrying only foreign entries is an anomaly worth eyes:
              // it means a ref collision or store corruption, not a normal miss.
              console.warn(
                `POOL_PAYOUT_FOREIGN_HANDLE ${group.network} group=${group.groupRef}`
                + ` leg=${leg.index} — ref carries ${handles.length} entr(y/ies) with foreign logicalIds`,
              );
            }
            if (leg.state !== "queued") {
              await this.journal.updateLeg(group.groupRef, leg.index, {
                state: "queued",
                signedTx: undefined,
                txId: undefined,
                nonce: undefined,
              }, recoveryWrite ? gen : undefined);
            }
            continue;
          }
          const verdict = await rail.classifyByLogicalId(handle);
          await this.applyVerdict(group, { ...leg, nonce: handle.nonce }, verdict, recoveryWrite);
          // §2.3: the reconcile pass is maintain's heartbeat — the liveness
          // owner of a dispatched-but-unfinished leg. The verdict is passed
          // through so classification is not duplicated (H6), and the signer
          // is rebuilt from durable journal data, so a restart loses nothing.
          //
          // Terminal verdicts go through maintain too (full §2.8 companion):
          // maintainEntry's landed/terminal-absent branches are what propagate
          // the outcome into the OUTBOX entry. Skipping them left every settled
          // leg's entry stranded non-terminal until the next restart's recovery
          // walk — and stranded entries are exactly what cohorts multiply. The
          // verdict always belongs to the leg's own entry here: the foreign-
          // handle fallback is gone (Grok review of 78803f1), so `handle` IS
          // the leg's logicalId by construction.
          await rail.maintainPoolPayout?.({
            logicalId: leg.logicalId,
            recipient: leg.recipient,
            amountAtomic: leg.amountAtomic,
            nowSeconds: Math.floor(this.now() / 1000),
            verdict,
          });
          continue;
        }

        if (!leg.signedTx || !leg.txId || leg.lastValidBlockHeight === undefined) {
          if (leg.state !== "queued") {
            await this.journal.updateLeg(group.groupRef, leg.index, {
              state: "queued",
            }, recoveryWrite ? gen : undefined);
          }
          continue;
        }
        const prepared = this.preparedFromLeg(group, leg);
        const height = await rail.finalizedBlockHeight();
        if (height !== undefined && height <= leg.lastValidBlockHeight) {
          try {
            await rail.broadcastPoolPayout(prepared);
          } catch {
            // Exact-byte rebroadcast may race prior acceptance; classification decides.
          }
        }
        const verdict = await rail.poolPayoutStatus(prepared);
        await this.applyVerdict(group, leg, verdict, recoveryWrite);
      }
      await this.deriveGroupState(group.groupRef);
    }
    // R8 — the reconcile is where legs on a real chain actually reach finality, so
    // it is the pass that most often completes a cohort. Without this hook a cohort
    // would only ever resolve on the next flush of its network, and a rail whose
    // flush timer is blocked would never report at all.
    await this.settleCohorts(network);
  }

  private async applyVerdict(
    group: PendingPayoutGroup,
    leg: PendingPayoutLeg,
    verdict: ChainRailPayoutVerdict,
    expectGen: boolean,
  ) {
    let terminalExpectGen: number | undefined;
    const terminal = verdict.status === "landed" || verdict.status === "terminal-absent";
    if (expectGen && terminal) {
      const claimed = await this.journal.updateLeg(group.groupRef, leg.index, {
        state: leg.state,
      }, leg.gen);
      if (!claimed) return;
      terminalExpectGen = leg.gen + 1;
    }
    if (verdict.status === "landed") {
      await this.ledger.markPayoutSettled(leg.payoutRef, verdict.transactionHash);
      await this.journal.updateLeg(group.groupRef, leg.index, {
        state: "settled",
        chainStatus: "finalized",
        mode: "onchain",
        transactionHash: verdict.transactionHash,
        txId: verdict.transactionHash,
        nonce: leg.nonce,
        terminalAt: this.now(),
        // §2.9 H11 — persist the landing coordinate when the verdict measured
        // one. The key is included conditionally because updateLeg assigns the
        // patch verbatim: an explicit `undefined` would erase a value a prior
        // pass recorded.
        ...(verdict.blockNumber !== undefined ? { landedBlock: verdict.blockNumber } : {}),
      }, terminalExpectGen);
    } else if (verdict.status === "terminal-absent") {
      await this.ledger.reversePayout(leg.payoutRef);
      await this.journal.updateLeg(group.groupRef, leg.index, {
        state: "failed",
        terminalAt: this.now(),
      }, terminalExpectGen);
    } else if (verdict.status === "included") {
      // Nothing changed since the last pass, so do not write. Every updateLeg is a
      // whole-file AES-GCM encrypt + fsync on a process-wide queue plus a generation
      // bump; without this guard a 30s reconcile rewrote the journal once per
      // in-flight leg for the whole finality window — roughly 48 rewrites per EVM
      // payout, and a gen churn that makes concurrent CAS writes fail for no reason.
      if (leg.state === "broadcasting"
        && leg.chainStatus === "included"
        && leg.transactionHash === verdict.transactionHash
        && leg.mode === "onchain") {
        return;
      }
      // Mined, canonical, successful — only finality is outstanding. The leg stays
      // IN FLIGHT and a later reconcile promotes it to settled. Writing `uncertain`
      // here is what stranded every healthy payout: `uncertain` is never pruned, is
      // a hard error on the synchronous claim path, and is the sole entry condition
      // for operator disposition. Do not settle either — the ledger must not burn
      // the balance until the transfer is final.
      await this.journal.updateLeg(group.groupRef, leg.index, {
        state: "broadcasting",
        mode: "onchain",
        chainStatus: "included",
        transactionHash: verdict.transactionHash,
      }, expectGen ? leg.gen : undefined);
    } else if (verdict.status === "pending") {
      // Zero evidence inside the leg's own liveness bound (EVM dispatch grace /
      // Solana blockhash validity) — the ordinary mine latency, not new
      // information. Leave the leg byte-identical: writing `uncertain` here was
      // the H7 flap (`uncertain` is never pruned, is a hard error on the claim
      // path, and is the sole entry to operator disposition), and even a same-
      // state write would churn the generation and fsync the whole journal. The
      // state self-resolves: evidence appears, or the bound expires and the next
      // classification returns a verdict that DOES write.
      //
      // ONE exception writes: a prior pass may have recorded `included` evidence
      // that a reorg has since erased. `pending` means there is NO current
      // evidence, so a recorded hash is stale by definition — leaving it would
      // show a dead transaction as included to any journal reader until some
      // later verdict happens to overwrite it. Reorgs are rare, so this write
      // carries none of the churn the no-write rule exists to prevent.
      if (leg.chainStatus === "included" || leg.transactionHash !== undefined) {
        await this.journal.updateLeg(group.groupRef, leg.index, {
          state: "broadcasting",
          chainStatus: undefined,
          transactionHash: undefined,
        }, expectGen ? leg.gen : undefined);
      }
      return;
    } else {
      await this.journal.updateLeg(group.groupRef, leg.index, {
        state: "uncertain",
      }, expectGen ? leg.gen : undefined);
    }
  }

  private async deriveGroupState(groupRef: string) {
    const group = this.journal.byRef(groupRef);
    if (!group) return;
    const states = group.legs.map((leg) => leg.state);
    let state: GroupState;
    if (states.some((item) => item === "uncertain")) state = "uncertain";
    else if (states.every((item) => item === "settled")) state = "settled";
    else if (states.every((item) => item === "failed")) state = "failed";
    else if (states.every(isTerminalLeg) && states.some((item) => item === "failed")) state = "partial";
    else if (states.some((item) => item === "broadcasting")) state = "in-flight";
    else state = "queued";
    const terminalAt = state === "settled" || state === "partial" || state === "failed"
      ? Math.max(...group.legs.map((leg) => leg.terminalAt ?? this.now()))
      : undefined;
    await this.journal.setGroupState(groupRef, state, terminalAt);
  }

  private preparedFromLeg(
    group: PendingPayoutGroup,
    leg: PendingPayoutLeg,
  ): ChainRailPreparedPayout {
    return {
      network: group.network,
      recipient: leg.recipient,
      amountAtomic: leg.amountAtomic,
      mode: leg.mode ?? "onchain",
      signedTx: leg.signedTx,
      txId: leg.txId,
      nonce: leg.nonce,
      lastValidBlockHeight: leg.lastValidBlockHeight,
      contextSlot: leg.contextSlot,
    };
  }

  private queuedReceipt(input: EnqueueGroupInput): QueuedGroupReceipt {
    return {
      kind: "pool-payout-queued",
      groupRef: input.groupRef,
      network: input.network,
      strategy: input.strategy,
      legs: input.legs.map((leg) => ({
        index: leg.index,
        recipient: leg.recipient,
        amountAtomic: leg.amountAtomic,
        ephemeralPubKey: leg.ephemeralPubKey,
      })),
      offchainChangeAtomic: "0",
      state: "queued",
      payerBalanceAtomic: input.payerBalanceAtomic,
      estimatedSubmitBeforeMs: this.now() + this.flushMs + this.maxJitterMs,
    };
  }

  /**
   * Commitment for the epoch a timestamp falls in (§6). Published up front so the
   * operator cannot later change that epoch's jitter draws undetectably. Returns
   * undefined when no committed schedule is configured.
   */
  scheduleCommitment(nowMs = this.now()): { epoch: number; epochMs: number; commitment: string } | undefined {
    if (!this.scheduleMasterSeed) return undefined;
    const epoch = epochOf(nowMs, this.scheduleEpochMs);
    return {
      epoch,
      epochMs: this.scheduleEpochMs,
      commitment: scheduleCommitment(epochSeed(this.scheduleMasterSeed, epoch), epoch),
    };
  }

  /**
   * Reveal the seed for a CLOSED epoch (§6), so anyone can recompute its jitter
   * draws and verify realized landings. Refuses the current or future epoch —
   * revealing an open epoch would let the operator still steer the remaining
   * windows. Per-epoch derivation means this leaks neither the master nor any
   * other epoch's seed.
   */
  revealSchedule(epoch: number, nowMs = this.now()): string | undefined {
    if (!this.scheduleMasterSeed) return undefined;
    if (!Number.isInteger(epoch) || epoch >= epochOf(nowMs, this.scheduleEpochMs)) return undefined;
    return epochSeed(this.scheduleMasterSeed, epoch);
  }

  private scheduleJitter(network: string): number {
    if (!this.scheduleMasterSeed) {
      return Math.floor(this.random() * (this.maxJitterMs + 1));
    }
    const nowMs = this.now();
    const epoch = epochOf(nowMs, this.scheduleEpochMs);
    // §4 (Codex F3) — the slot is an ABSOLUTE function of the clock, not a mutable
    // per-network cursor. A cursor rewinds to 0 on restart and replays the epoch's
    // opening draws, so restarting was a silent way to re-roll release timing that
    // no external verifier could distinguish from the committed schedule. A slot
    // derived from wall time cannot be rewound without moving the clock, and the
    // flush period is >= flushMs so at most one draw ever falls in a slot.
    const index = scheduleSlot(nowMs, this.scheduleEpochMs, this.flushMs);
    return deriveScheduleJitter(
      epochSeed(this.scheduleMasterSeed, epoch),
      network,
      epoch,
      index,
      this.maxJitterMs,
    );
  }

  /**
   * Lag before a settled window may appear in the aggregate (§7): the claim TTL
   * plus one equal retention period. Nothing inside this window is ever published.
   */
  private get kEffPublishLagMs(): number {
    return this.claimTtlMs * 2;
  }

  /**
   * §14 — the target this window is judged against. Static unless adaptive is on,
   * in which case it is derived from observed concurrency and is 1 until there is
   * enough evidence. That is the "correct at user #1" guarantee: with no history
   * the gate is inert and adds no latency, and it tightens by itself as real
   * concurrent traffic appears — with no operator action and no redeploy.
   */
  private effectiveKEffTarget(nowMs: number, laneOrNetwork: string): number {
    if (!this.kEffAdaptive) return this.kEffTarget;
    return adaptiveKEffTarget({
      // Only THIS lane's observations (§4 invariant 1). A lane with no evidence of
      // its own stays at target 1 no matter how busy another lane, denomination, or
      // rail is — which is also what keeps user #1 from ever being held.
      samples: this.concurrencySamples.get(laneOrNetwork) ?? [],
      nowMs,
      windowMs: this.kEffAdaptiveWindowMs,
      minSamples: this.kEffAdaptiveMinSamples,
      quantile: this.kEffAdaptiveQuantile,
      ceiling: this.kEffCeiling,
    });
  }

  /**
   * Restore adaptive state from disk (§4, Codex F3), and resolve the §6 master
   * secret. Without a store this is a no-op and behaviour is exactly as before:
   * empty evidence, and whatever seed the caller injected.
   */
  private async restoreConcentrationState(): Promise<void> {
    const store = this.concentrationStore;
    if (!store) return;
    const state = await store.load(this.now(), this.kEffAdaptiveWindowMs);
    this.concurrencySamples = new Map(Object.entries(state.lanes));
    // An explicitly injected seed wins, so tests stay deterministic. Otherwise the
    // durable one is used — minted once and reused forever, so a commitment
    // published before a restart is still revealable after it.
    if (!this.scheduleMasterSeed && this.concentrationEnabled) {
      this.scheduleMasterSeed = await store.resolveMasterSeed();
    }
  }

  /**
   * Flush evidence to disk. Fire-and-forget from the gate: a write failure must
   * never delay or fail a payout, and the worst case is that the last window's
   * observations are lost on restart — which under-counts, the safe direction.
   */
  private persistConcentrationState(): Promise<void> {
    const store = this.concentrationStore;
    if (!store) return Promise.resolve();
    return store.saveLanes(this.concurrencySamples).catch((error: unknown) => {
      console.warn(
        "POOL_PAYOUT_CONCENTRATION_PERSIST_FAILED",
        error instanceof Error ? error.message : "unknown",
      );
    });
  }

  /** Bounded per-lane evidence buffer for §14. Same retention as `kEffSamples`. */
  private recordConcurrencySample(network: string, atMs: number, kEff: number): void {
    if (kEff <= 0) return;
    const samples = this.concurrencySamples.get(network) ?? [];
    samples.push({ atMs, kEff });
    const horizon = atMs - this.kEffAdaptiveWindowMs;
    this.concurrencySamples.set(
      network,
      samples.length > 4096 || samples[0].atMs < horizon
        ? samples.filter((sample) => sample.atMs >= horizon)
        : samples,
    );
  }

  /**
   * The resolved target for one lane. Test-only surface: the production gate
   * resolves lane targets internally, and there is no operator-facing per-lane
   * report — a per-lane target is per-denomination traffic detail, which §7 keeps
   * off the public surface.
   */
  laneTargetForTest(laneKey: string, nowMs = this.now()): number {
    return this.effectiveKEffTarget(nowMs, laneKey);
  }

  /** Lanes that belong to a network. Lane keys are `network:asset:denomination`. */
  private lanesOf(network: string): string[] {
    const prefix = `${network}:`;
    return [...this.concurrencySamples.keys()].filter((lane) => lane.startsWith(prefix));
  }

  /**
   * Live observation count across ALL lanes of one network, within the adaptive
   * evidence window. Evidence is lane-local (§4), so a network's count is the sum of
   * its lanes — reported for operator visibility only. Nothing is ever GATED on this
   * aggregate: gating a quiet lane on a busy sibling's evidence is precisely the
   * cross-contamination invariant 1 forbids.
   */
  private observationCount(nowMs: number, network: string): number {
    const cutoff = nowMs - this.kEffAdaptiveWindowMs;
    let total = 0;
    for (const lane of this.lanesOf(network)) {
      total += (this.concurrencySamples.get(lane) ?? [])
        .filter((sample) => sample.atMs >= cutoff).length;
    }
    return total;
  }

  /**
   * Strongest target currently in force anywhere on a network — the max over its
   * lanes. Reporting only; see `observationCount` on why this never gates.
   */
  private networkTarget(nowMs: number, network: string): number {
    const lanes = this.lanesOf(network);
    if (lanes.length === 0) return this.kEffAdaptive ? 1 : this.kEffTarget;
    return Math.max(...lanes.map((lane) => this.effectiveKEffTarget(nowMs, lane)));
  }

  /**
   * Operator/transparency view of the gate's CURRENT resolved posture (§14). Reports
   * the effective target rather than the configured one, because with adaptive on
   * the configured ceiling is not what any window is actually judged against.
   * Carries no per-group, per-agent, or per-window detail.
   */
  concentrationStatus(nowMs = this.now()): {
    enabled: boolean;
    adaptive: boolean;
    effectiveTarget: number;
    staticTarget: number;
    ceiling: number;
    observations: number;
    inertReason?: string;
    aggregation: string;
    byNetwork: Record<string, {
      effectiveTarget: number;
      observations: number;
      inertReason?: string;
    }>;
  } {
    const reasonFor = (target: number, observations: number): string | undefined => {
      if (!this.concentrationEnabled) return "gate-disabled";
      if (target > 1) return undefined;
      return this.kEffAdaptive && observations < this.kEffAdaptiveMinSamples
        ? "insufficient-observations"
        : "target-is-1";
    };
    // Targets are per-network, so there is no single honest scalar. The rollup
    // reports the STRONGEST hold in force anywhere (and the total evidence), while
    // `byNetwork` carries the value each rail is actually judged against — a rail
    // with no evidence of its own stays at 1 even while another is elevated.
    const byNetwork: Record<string, {
      effectiveTarget: number; observations: number; inertReason?: string;
    }> = {};
    let effectiveTarget = 0;
    let observations = 0;
    for (const network of this.rails.keys()) {
      const networkObservations = this.observationCount(nowMs, network);
      const networkTarget = this.networkTarget(nowMs, network);
      const networkReason = reasonFor(networkTarget, networkObservations);
      byNetwork[network] = {
        effectiveTarget: networkTarget,
        observations: networkObservations,
        ...(networkReason ? { inertReason: networkReason } : {}),
      };
      effectiveTarget = Math.max(effectiveTarget, networkTarget);
      observations += networkObservations;
    }
    if (effectiveTarget === 0) effectiveTarget = this.kEffAdaptive ? 1 : this.kEffTarget;
    // Inert overall only when EVERY rail is inert — and the reason is taken from
    // the rails themselves, never recomputed from the SUMMED evidence. Recomputing
    // is actively wrong: with minSamples 20, three rails holding 10/10/0
    // observations are each individually "insufficient-observations", but their sum
    // is 20, which would report "target-is-1" — announcing that evidence was
    // sufficient and merely resolved to 1, when no rail had enough.
    const reasons = Object.values(byNetwork).map((entry) => entry.inertReason);
    const inertReason = reasons.length > 0 && reasons.every((reason) => reason !== undefined)
      ? (reasons.every((reason) => reason === reasons[0]) ? reasons[0] : "mixed")
      : undefined;
    return {
      enabled: this.concentrationEnabled,
      adaptive: this.kEffAdaptive,
      effectiveTarget,
      staticTarget: this.kEffTarget,
      ceiling: this.kEffCeiling,
      observations,
      ...(inertReason ? { inertReason } : {}),
      // Names the rollup so no caller mistakes it for a per-rail value. `byNetwork`
      // is the authoritative view; these scalars exist for the pre-existing shape.
      aggregation: "max-target/sum-observations",
      byNetwork,
    };
  }

  /**
   * The view safe to serve on the UNAUTHENTICATED `/api/privacy`.
   *
   * `concentrationStatus()` is operator telemetry and must not be published: every
   * traffic-derived field in it is a live activity oracle. `observations` ticks the
   * moment a window is gate-evaluated, so polling the endpoint tells an outside
   * observer WHEN a payout was requested — and, once broken out `byNetwork`, on WHICH
   * RAIL. Against a lone withdrawer that is a direct time-and-network correlation with
   * the victim's request, on the exact boundary this whole mechanism exists to blur.
   * `effectiveTarget` leaks the same way in reverse: it announces when a rail's hold
   * expectation drops, i.e. when cover has evaporated.
   *
   * So the public surface carries CONFIGURATION posture only — what an operator has
   * turned on, which is static — and never evidence. Agents still learn their real
   * anonymity set: realized k_eff is returned on the owner-bound authenticated claim,
   * which is the correct channel because it is scoped to the agent that paid for it.
   */
  publicConcentrationStatus(): {
    enabled: boolean;
    adaptive: boolean;
    staticTarget: number;
    ceiling: number;
    evidence: "operator-only";
  } {
    return {
      enabled: this.concentrationEnabled,
      adaptive: this.kEffAdaptive,
      staticTarget: this.kEffTarget,
      ceiling: this.kEffCeiling,
      evidence: "operator-only",
    };
  }

  private recordKEffSample(atMs: number, kEff: number): void {
    this.kEffSamples.push({ atMs, kEff });
    // Keep only what the histogram could still count: samples younger than the lag
    // plus one day of publishable history.
    const horizon = atMs - (this.kEffPublishLagMs + 86_400_000);
    if (this.kEffSamples.length > 4096 || this.kEffSamples[0].atMs < horizon) {
      this.kEffSamples = this.kEffSamples.filter((sample) => sample.atMs >= horizon);
    }
  }

  /**
   * Aggregate realized-k_eff histogram over settled, lagged windows (§7). Returns
   * undefined unless publication is explicitly enabled. Buckets by k_eff value
   * only — never per-group, per-agent, or per-window, and never live thinness (A3).
   */
  kEffHistogram(nowMs = this.now()): { lagMs: number; buckets: Record<string, number> } | undefined {
    if (!this.kEffPublishEnabled) return undefined;
    return {
      lagMs: this.kEffPublishLagMs,
      buckets: kEffHistogram(this.kEffSamples, nowMs, this.kEffPublishLagMs),
    };
  }

  private schedule(network: string) {
    if (this.stopped) return;
    const delay = this.flushMs + this.scheduleJitter(network);
    const timer = setTimeout(() => {
      this.timers.delete(network);
      void this.flushNow(network)
        .catch((error) => {
          console.error("POOL_PAYOUT_FLUSH_FAILED", network, error instanceof Error ? error.message : "unknown");
        })
        .finally(() => this.schedule(network));
    }, delay);
    timer.unref();
    this.timers.set(network, timer);
  }

  /**
   * The pass that actually finishes payouts. `schedule()` only ever calls `flushNow`,
   * which selects `state === "queued"` legs, so nothing it does can advance a leg that
   * is already in flight. Before this timer existed the only reconciles were
   * `recover()` at startup and one `sweep()` from `start()`, which meant a leg that
   * was mined but not yet final stayed in flight until the process restarted.
   *
   * Deliberately a separate timer from the flush: a reconcile must keep running at its
   * own cadence even while a flush is being held by the concentration gate, and the
   * two have unrelated correct periods (flush is a privacy window, reconcile tracks
   * chain finality).
   */
  private scheduleReconcile(network: string) {
    if (this.stopped) return;
    const key = `reconcile:${network}`;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.withNetworkLock(network, () => this.reconcileNetwork(network, true))
        .catch((error) => {
          console.error(
            "POOL_PAYOUT_RECONCILE_FAILED",
            network,
            error instanceof Error ? error.message : "unknown",
          );
        })
        .finally(() => this.scheduleReconcile(network));
    }, this.reconcileMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  private withNetworkLock<T>(network: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.networkLocks.get(network) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    this.networkLocks.set(network, result.then(() => undefined, () => undefined));
    return result;
  }

  private requireRail(network: string): ChainRail {
    const rail = this.rails.get(network);
    if (!rail) throw new Error(`Pool payout rail not configured for network ${network}`);
    return rail;
  }

  private requireLeg(groupRef: string, index: number) {
    const group = this.journal.byRef(groupRef);
    if (!group) throw new Error("Pending payout group not found");
    const leg = group.legs.find((item) => item.index === index);
    if (!leg) throw new Error("Pending payout leg not found");
    return { group, leg };
  }
}

export const poolPayoutPlanHash = (input: {
  groupRef: string;
  network: string;
  asset: string;
  legs: Pick<PoolPayoutLegInput, "index" | "payoutRef" | "recipient" | "amountAtomic" | "denominationAtomic">[];
}) => `0x${createHash("sha256").update(JSON.stringify({
  version: 1,
  groupRef: input.groupRef,
  network: input.network,
  asset: normalizeAsset(input.network, input.asset),
  legs: [...input.legs].sort((a, b) => a.index - b.index),
})).digest("hex")}`;

export const poolPayoutLogicalId = (input: {
  payoutRef: string;
  recipient: string;
  amountAtomic: string;
  network: string;
  tokenAddress?: string;
  chainId?: number;
}) => {
  if (input.chainId !== undefined && input.tokenAddress) {
    const data = new Interface([
      "function transfer(address to,uint256 value) returns (bool)",
    ]).encodeFunctionData("transfer", [input.recipient, input.amountAtomic]);
    return coordinatorLogicalId({
      kind: "pool-payout",
      ref: input.payoutRef,
      payloadFingerprint: evmPayloadFingerprint({
        to: input.tokenAddress,
        data,
        value: 0n,
        chainId: input.chainId,
      }),
    });
  }
  const payloadFingerprint = `0x${createHash("sha256").update(JSON.stringify({
    recipient: input.recipient,
    amountAtomic: input.amountAtomic,
    network: input.network,
  })).digest("hex")}`;
  return coordinatorLogicalId({
    kind: "pool-payout",
    ref: input.payoutRef,
    payloadFingerprint,
  });
};

const normalizeAsset = (network: string, asset: string) => (
  network === "solana" ? asset : asset.toLowerCase()
);
const groupAssetKey = (group: PendingPayoutGroup) => `${group.network}:${normalizeAsset(group.network, group.asset)}`.toLowerCase();
const isTerminalLeg = (state: LegState) => state === "settled" || state === "failed";
const validateDuration = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Pool payout ${name} must be non-negative`);
};
const shuffle = <T>(values: T[], random: () => number) => {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [values[index], values[selected]] = [values[selected], values[index]];
  }
};
/**
 * Resolves to the promise's value, or `undefined` if the budget expires first.
 * Only safe for READ-ONLY work: the underlying call keeps running, so anything
 * that mutates shared state must not be abandoned this way.
 */
const withDeadline = async <T>(work: Promise<T>, budgetMs: number): Promise<T | undefined> => {
  if (budgetMs <= 0) {
    void work.catch(() => undefined);
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work.catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
};
const settleWithinBudget = async (task: Promise<void>, budgetMs: number) => {
  if (budgetMs <= 0) {
    void task.catch(() => undefined);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
};
