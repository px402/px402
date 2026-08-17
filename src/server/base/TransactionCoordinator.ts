import { createHash } from "node:crypto";
import type { JsonRpcProvider, TransactionReceipt } from "ethers";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

export type SettlerSendKind =
  | "pool-payout"
  | "x402-settle"
  | "batch-commit"
  | "deposit-sweep"
  // depositor-signed EIP-3009 the settler broadcasts on their behalf, so a
  // stealth output can be swept without ever being funded with native gas
  | "deposit-relay";
export type OutboxState =
  | "signing"
  | "broadcasting"
  | "included"
  | "finalized"
  | "failed"
  | "uncertain";

export interface OutboxVersion {
  txHash: string;
  signedTx: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  createdAt: number;
}

export interface OutboxEntry {
  chainId: number;
  address: string;
  nonce: number;
  kind: SettlerSendKind;
  ref?: string;
  logicalId: string;
  payloadFingerprint: string;
  versions: OutboxVersion[];
  state: OutboxState;
  winningHash?: string;
}

interface OutboxFile {
  version: 1;
  entries: OutboxEntry[];
  quarantines: Record<string, { nonce: number; logicalId?: string; since: number }>;
}

const EMPTY_OUTBOX = (): OutboxFile => ({ version: 1, entries: [], quarantines: {} });

export class TransactionOutbox {
  private readonly file: EncryptedJsonFile<OutboxFile>;
  private state = EMPTY_OUTBOX();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptionKey: string) {
    if (!encryptionKey.trim()) {
      throw new Error("Transaction outbox requires PX402_DATA_ENCRYPTION_KEY");
    }
    this.file = new EncryptedJsonFile(filePath, encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_OUTBOX());
    if (stored.version !== 1 || !Array.isArray(stored.entries) || !stored.quarantines) {
      throw new Error("Settler transaction outbox file is invalid");
    }
    this.state = stored;
    if (this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  putVersion(entry: {
    chainId: number;
    address: string;
    nonce: number;
    kind: SettlerSendKind;
    ref?: string;
    logicalId: string;
    payloadFingerprint: string;
    version: OutboxVersion;
  }): Promise<void> {
    return this.serialize(async () => {
      const existing = this.state.entries.find((item) => item.logicalId === entry.logicalId);
      if (existing) {
        if (existing.chainId !== entry.chainId
          || lc(existing.address) !== lc(entry.address)
          || existing.nonce !== entry.nonce
          || existing.kind !== entry.kind
          || existing.ref !== entry.ref
          || existing.payloadFingerprint !== entry.payloadFingerprint) {
          throw new Error("Outbox logicalId replay has a conflicting immutable binding");
        }
        if (existing.versions.some((version) => version.txHash === entry.version.txHash)) return;
        const previousFee = existing.versions[existing.versions.length - 1];
        if (previousFee
          && (BigInt(entry.version.maxFeePerGas) <= BigInt(previousFee.maxFeePerGas)
            || BigInt(entry.version.maxPriorityFeePerGas) <= BigInt(previousFee.maxPriorityFeePerGas))) {
          throw new Error("Outbox replacement fees must increase");
        }
        existing.versions.push(structuredClone(entry.version));
        existing.state = "broadcasting";
      } else {
        this.state.entries.push({
          chainId: entry.chainId,
          address: lc(entry.address),
          nonce: entry.nonce,
          kind: entry.kind,
          ref: entry.ref,
          logicalId: entry.logicalId,
          payloadFingerprint: entry.payloadFingerprint,
          versions: [structuredClone(entry.version)],
          state: "broadcasting",
        });
      }
      await this.persist();
    });
  }

  setState(logicalId: string, state: OutboxState, winningHash?: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.state.entries.find((item) => item.logicalId === logicalId);
      if (!entry) throw new Error("Outbox logicalId not found");
      if (winningHash
        && !entry.versions.some((version) => lc(version.txHash) === lc(winningHash))) {
        throw new Error("Outbox winning hash is not in the replacement lineage");
      }
      entry.state = state;
      entry.winningHash = winningHash;
      await this.persist();
    });
  }

  setQuarantine(chainId: number, address: string, nonce: number | null): Promise<void> {
    return this.serialize(async () => {
      const key = quarantineKey(chainId, address);
      if (nonce === null) {
        delete this.state.quarantines[key];
      } else {
        const entry = this.state.entries.find(
          (item) => item.chainId === chainId && lc(item.address) === lc(address) && item.nonce === nonce,
        );
        this.state.quarantines[key] = {
          nonce,
          logicalId: entry?.logicalId,
          since: Date.now(),
        };
      }
      await this.persist();
    });
  }

  /**
   * Lowest-nonce-wins quarantine write. There is ONE record per settler, and with
   * polls running outside the lease several stranded nonces can time out together;
   * the check-and-set must happen inside the serialized write queue or two
   * proposers can both read "no existing record" and the last writer wins.
   */
  proposeQuarantine(chainId: number, address: string, nonce: number): Promise<void> {
    return this.serialize(async () => {
      const key = quarantineKey(chainId, address);
      const existing = this.state.quarantines[key];
      if (existing && existing.nonce <= nonce) return;
      const entry = this.state.entries.find(
        (item) => item.chainId === chainId && lc(item.address) === lc(address) && item.nonce === nonce,
      );
      this.state.quarantines[key] = { nonce, logicalId: entry?.logicalId, since: Date.now() };
      await this.persist();
    });
  }

  /** Clears the quarantine only if the record still names `nonce` — atomically. */
  clearQuarantineForNonce(chainId: number, address: string, nonce: number): Promise<void> {
    return this.serialize(async () => {
      const key = quarantineKey(chainId, address);
      if (this.state.quarantines[key]?.nonce !== nonce) return;
      delete this.state.quarantines[key];
      await this.persist();
    });
  }

  quarantine(chainId: number, address: string) {
    const value = this.state.quarantines[quarantineKey(chainId, address)];
    return value ? structuredClone(value) : undefined;
  }

  nonterminalNoncesAscending(chainId: number, address: string): OutboxEntry[] {
    return this.state.entries
      .filter((entry) => entry.chainId === chainId
        && lc(entry.address) === lc(address)
        && !isTerminal(entry.state))
      .sort((a, b) => a.nonce - b.nonce)
      .map((entry) => structuredClone(entry));
  }

  byLogicalId(logicalId: string): OutboxEntry | undefined {
    const entry = this.state.entries.find((item) => item.logicalId === logicalId);
    return entry ? structuredClone(entry) : undefined;
  }

  entriesByRef(ref: string): OutboxEntry[] {
    return this.state.entries
      .filter((entry) => entry.ref === ref)
      .map((entry) => structuredClone(entry));
  }

  byTransactionHash(transactionHash: string): OutboxEntry | undefined {
    const entry = this.state.entries.find((candidate) =>
      candidate.versions.some((version) => lc(version.txHash) === lc(transactionHash)));
    return entry ? structuredClone(entry) : undefined;
  }

  highWaterNonce(chainId: number, address: string): number | undefined {
    const values = this.state.entries
      .filter((entry) => entry.chainId === chainId && lc(entry.address) === lc(address))
      .map((entry) => entry.nonce);
    return values.length > 0 ? Math.max(...values) : undefined;
  }

  close(): void {
    // EncryptedJsonFile keeps no open descriptor between operations.
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }
}

/**
 * Process-local serializer for non-EVM rails whose durable transaction identity
 * is persisted by their own WAL before `send` is entered. EVM sends use
 * TransactionCoordinator's nonce lease and durable outbox instead.
 */
export class SettlerSendMutex {
  private lease: Promise<void> = Promise.resolve();

  send<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lease.then(operation, operation);
    this.lease = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface CoordinatorSubmitInput {
  kind: SettlerSendKind;
  ref?: string;
  logicalId: string;
  payloadFingerprint: string;
  // How a quarantined settler treats this submission. "park" (default) suspends
  // the promise until the quarantine resolves — right for one-shot callers with
  // no state of their own. "reject" throws SettlerQuarantinedError synchronously
  // — right for callers that OWN a durable queue (the pool payout journal): for
  // them a suspended promise is the wrong park, because it pins their locks for
  // the quarantine's whole lifetime (R12) and turns their retry accounting into
  // a refusal (spec-cohort-dispatch.md §2.5); they re-queue on their own
  // schedule instead.
  onQuarantine?: "park" | "reject";
  sign: (input: {
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }) => Promise<{ signedTx: string; txHash: string }>;
}

/**
 * The settler is quarantined and the caller asked for rejection over parking.
 * This is a DELAY signal, not a failure: nothing was signed, no nonce was
 * allocated, no outbox entry exists. The frozen rule is delay-never-refuse, so
 * a catcher must not count this toward any attempt or failure budget.
 */
export class SettlerQuarantinedError extends Error {
  constructor() {
    super("Settler is quarantined; submission rejected for caller-side re-queue");
    this.name = "SettlerQuarantinedError";
  }
}

export interface CoordinatorResult {
  txHash: string;
  nonce: number;
  state: "finalized";
}

/**
 * Per-input result of `dispatchMany` (spec-cohort-dispatch.md §2.1/§2.2).
 * "dispatched" means the operation has a durable outbox identity and its first
 * broadcast was attempted — NOT that it mined, and NOT that it is final. The
 * caller's reconcile pass finishes it; `maintainEntry` keeps it live.
 */
export type DispatchOutcome =
  // `broadcastAtMs` is set only when THIS call handed the bytes to the RPC (a
  // fresh first broadcast, or an alreadyKnown that proves they are in a mempool).
  // It is the §2.9 measurement input for the wave's first-to-last broadcast
  // spread — the honest-landing-tightness deploy gate — so an idempotent replay
  // or a refused broadcast must not stamp one: a replay's time is not the wave's,
  // and a refused broadcast never reached a mempool at all.
  | { logicalId: string; status: "dispatched"; nonce: number; txHash: string; broadcastAtMs?: number }
  | { logicalId: string; status: "finalized"; nonce: number; txHash: string }
  | { logicalId: string; status: "failed"; error: string };

/** Consecutive non-benign FIRST-broadcast failures before dispatch fail-stops.
 *  v1's design deleted this and was rejected for it: with the settler out of
 *  gas, legs would allocate N..N+7, all fail to broadcast, and pile up
 *  unbounded, where submit() quarantines at its budget. Reset by any
 *  successful broadcast. */
const DISPATCH_FIRST_BROADCAST_FAILSTOP = 8;

/** Backstop on replacement signing per entry — the per-entry deadline
 *  (timeoutMs from versions[0].createdAt) normally fires first (~3 bumps at
 *  defaults); this exists so a misconfigured deadline can never sign bump #200,
 *  each of which is a whole-file fsync at escalating fees. */
const MAINTAIN_VERSION_CAP = 10;

/**
 * The settler transaction mined into a canonical block and succeeded, but the
 * configured finality criterion has not reached it inside the budget.
 *
 * This is deliberately an error and not a `CoordinatorResult`: every caller of
 * `submit()` treats a resolved result as "landed" — `PoolPayoutQueue.settlePrepared`
 * marks the ledger settled off it — so resolving on a non-final transaction would
 * silently downgrade the guarantee at five call sites at once. Callers that can
 * safely act on inclusion must opt in by catching this explicitly.
 *
 * Unlike a finality TIMEOUT, this does not quarantine the settler: the nonce is
 * consumed and the outcome is known, so the pipeline may advance.
 */
export class SettlerNotYetFinalError extends Error {
  readonly transactionHash: string;
  readonly nonce: number;

  constructor(input: { transactionHash: string; nonce: number }) {
    super("Settler transaction is included but not yet final");
    this.name = "SettlerNotYetFinalError";
    this.transactionHash = input.transactionHash;
    this.nonce = input.nonce;
  }
}

interface CoordinatorProvider {
  getTransactionCount(address: string, blockTag?: string): Promise<number>;
  getFeeData(): Promise<{
    maxFeePerGas?: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
    gasPrice?: bigint | null;
  }>;
  broadcastTransaction(signedTx: string): Promise<{ hash: string }>;
  getTransactionReceipt(hash: string): Promise<TransactionReceipt | null>;
  getBlock(blockTag: string | number): Promise<{
    number: number;
    hash?: string | null;
  } | null>;
  send(method: string, params: unknown[]): Promise<unknown>;
}

/**
 * Returned by the in-lease quarantine check to mean "park this submission" WITHOUT
 * parking it from inside the lease. `withLease` adopts whatever the operation
 * returns (`this.lease = result.then(...)`), so returning a promise that only
 * settles when the quarantine clears pins the lease forever — and both admin
 * escapes, `recoverOutbox` and `resolveQuarantine`, acquire that same lease. The
 * sentinel lets the lease settle immediately and the caller park outside it.
 */
const PARK_OUTSIDE_LEASE: unique symbol = Symbol("coordinator-park-outside-lease");

export class TransactionCoordinator {
  private readonly provider: CoordinatorProvider;
  private readonly address: string;
  private readonly chainId: number;
  private readonly outbox: TransactionOutbox;
  private readonly finality: "finalized" | "safe";
  private readonly confirmationFloorFallback: number;
  private readonly bumpAfterMs: number;
  private readonly timeoutMs: number;
  private readonly recoveryBudgetMs: number;
  private readonly dispatchGraceMs: number;
  private readonly cancelSign?: (input: {
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }) => Promise<{ signedTx: string; txHash: string }>;
  private lease: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly suppressedPoolLogicalIds = new Set<string>();
  private readonly activePolls = new Map<string, Promise<CoordinatorResult>>();
  private recoveryFollowUpTimer?: ReturnType<typeof setTimeout>;
  private consecutiveDispatchBroadcastFailures = 0;
  private leaseBusy = false;
  private readonly pendingSubmissions: {
    input: CoordinatorSubmitInput;
    resolve: (value: CoordinatorResult) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  private backgroundReconcileActive = false;

  constructor(input: {
    provider: JsonRpcProvider;
    address: string;
    chainId: number;
    outbox: TransactionOutbox;
    finality: "finalized" | "safe";
    confirmationFloorFallback: number;
    bumpAfterMs: number;
    timeoutMs: number;
    recoveryBudgetMs: number;
    // H7 grace age (spec-cohort-dispatch.md §2.4): how long a signed-and-broadcast
    // entry with ZERO on-chain evidence classifies as `pending` rather than
    // `uncertain`. Anchored to the durable versions[0].createdAt, so it survives
    // restart. Default 90s = two default fee-bump intervals with no evidence.
    dispatchGraceMs?: number;
    cancelSign?: (input: {
      nonce: number;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    }) => Promise<{ signedTx: string; txHash: string }>;
  }) {
    this.provider = input.provider as unknown as CoordinatorProvider;
    this.address = lc(input.address);
    this.chainId = input.chainId;
    this.outbox = input.outbox;
    this.finality = input.finality;
    this.confirmationFloorFallback = input.confirmationFloorFallback;
    this.bumpAfterMs = input.bumpAfterMs;
    this.timeoutMs = input.timeoutMs;
    this.recoveryBudgetMs = input.recoveryBudgetMs;
    this.dispatchGraceMs = input.dispatchGraceMs ?? 90_000;
    this.cancelSign = input.cancelSign;
  }

  private park(input: CoordinatorSubmitInput): Promise<CoordinatorResult> {
    // `close()` drains `pendingSubmissions` once. A submission that parks AFTER that
    // drain would sit in the list forever with nothing left to reject it, so a closed
    // coordinator must refuse to park at all rather than enqueue.
    if (this.closed) return Promise.reject(new Error("Transaction coordinator is closed"));
    return new Promise<CoordinatorResult>((resolve, reject) => {
      this.pendingSubmissions.push({ input, resolve, reject });
    });
  }

  /**
   * The lease-held half of a submission (spec-cohort-dispatch.md v2 §2.1): resolve
   * the logical operation to a durable outbox entry — replay checks, nonce
   * allocation, sign, WAL write — and stop there.
   *
   * Extracted from `submit` with NO behaviour change, so that exactly one
   * implementation of nonce allocation and replay checking exists once dispatch
   * lands. Three reviewers independently named a second, hand-copied allocation
   * path as the likeliest way this work introduces a duplicate-nonce bug.
   *
   * MUST be called through `this.withLease` — the same lease field `submit` uses.
   * A private lease "for isolation" would let two callers read the same high-water
   * mark and both write the same nonce.
   */
  private async acquireEntry(input: CoordinatorSubmitInput): Promise<
    { kind: "entry"; entry: OutboxEntry }
    | { kind: "finalized"; result: CoordinatorResult }
    | typeof PARK_OUTSIDE_LEASE
  > {
    if (this.closed) throw new Error("Transaction coordinator is closed");
    // A quarantine that began while this submission waited for the lease must be
    // parked by the CALLER, after the lease settles — see PARK_OUTSIDE_LEASE.
    if (this.isQuarantined()) return PARK_OUTSIDE_LEASE;
    const existing = this.outbox.byLogicalId(input.logicalId);
    if (existing) {
      if (existing.payloadFingerprint !== input.payloadFingerprint
        || existing.kind !== input.kind
        || existing.ref !== input.ref) {
        throw new Error("Coordinator logicalId replay has a conflicting binding");
      }
      if (existing.state === "finalized" && existing.winningHash) {
        return {
          kind: "finalized",
          result: { txHash: existing.winningHash, nonce: existing.nonce, state: "finalized" },
        };
      }
      if (existing.state === "failed") {
        throw new Error("Coordinator logical operation is terminal-absent");
      }
      return { kind: "entry", entry: existing };
    }

    const nonce = await this.allocateNextNonce();
    const fees = await this.initialFees();
    const version = await input.sign({ nonce, ...fees });
    await this.outbox.putVersion({
      chainId: this.chainId,
      address: this.address,
      nonce,
      kind: input.kind,
      ref: input.ref,
      logicalId: input.logicalId,
      payloadFingerprint: input.payloadFingerprint,
      version: { ...version, ...fees, createdAt: Date.now() },
    });
    const entry = this.outbox.byLogicalId(input.logicalId);
    if (!entry) throw new Error("Coordinator outbox write was lost");
    return { kind: "entry", entry };
  }

  submit(input: CoordinatorSubmitInput): Promise<CoordinatorResult> {
    if (this.isQuarantined()) {
      if (input.onQuarantine === "reject") return Promise.reject(new SettlerQuarantinedError());
      return this.park(input);
    }
    // The lease covers exactly the durable-identity work — replay check, nonce
    // allocation, sign, WAL write — and releases BEFORE the finality wait
    // (spec-cohort-dispatch.md v2 §2.1, R14). The wait used to run in-lease, which
    // made every settler transaction on a network strictly serial THROUGH FINALITY:
    // an x402 settle held the lease for up to timeoutMs while a cohort's legs
    // queued behind it, splitting the cohort. The external contract is unchanged —
    // the returned promise still resolves only on finality — so all five call
    // sites keep their guarantees while no longer serializing each other's waits.
    return this.withLease(() => this.acquireEntry(input)).then((acquired) => {
      if (acquired === PARK_OUTSIDE_LEASE) {
        // The quarantine began while this submission waited for the lease — the
        // race the sentinel exists for. A reject-mode caller gets the same
        // synchronous answer here as on the pre-lease check.
        if (input.onQuarantine === "reject") throw new SettlerQuarantinedError();
        return this.park(input);
      }
      if (acquired.kind === "finalized") return acquired.result;
      return this.pollOutsideLease(acquired.entry, input.sign);
    });
  }

  /**
   * One poll per logicalId, however many submits arrive. Without single-flight, a
   * duplicate submit joins the SAME outbox entry and starts a second poll loop;
   * both fee-bump on schedule and race `putVersion`'s increasing-fee check, so one
   * of them throws on the retry path that is supposed to be idempotent. The lease
   * used to provide this serialization as a side effect; out-of-lease it must be
   * explicit. The joiner's `sign` closure is silently discarded — safe only
   * because acquireEntry enforces payloadFingerprint equality on replay, so both
   * closures sign the same logical payload.
   */
  private pollOutsideLease(
    entry: OutboxEntry,
    sign: CoordinatorSubmitInput["sign"],
  ): Promise<CoordinatorResult> {
    const active = this.activePolls.get(entry.logicalId);
    if (active) return active;
    const poll = this.resumeEntry(entry, sign, this.timeoutMs)
      .finally(() => { this.activePolls.delete(entry.logicalId); });
    this.activePolls.set(entry.logicalId, poll);
    return poll;
  }

  /**
   * §2.2 — the cohort dispatch primitive. Takes the settler lease ONCE for the
   * whole batch: one quarantine check, one nonce read, one fee read, N signs,
   * N durable outbox writes, N first broadcasts, release. This is what makes a
   * cohort's legs land as one wave instead of one-per-lease-acquisition, and it
   * moves any lease contention to before-or-after the cohort instead of inside
   * it.
   *
   * Contract, from the reviewed design:
   * - Uses the SAME lease as submit() — a private lease would let two callers
   *   read one high-water mark and allocate duplicate nonces.
   * - NEVER parks and never enters pendingSubmissions: the caller is the pool
   *   payout queue, which owns a durable journal; a quarantine rejects
   *   synchronously (SettlerQuarantinedError) and the queue re-queues.
   * - An existing non-terminal entry is rebroadcast once and reported
   *   "dispatched" — never resumeEntry, which is the blocking path this method
   *   exists to remove.
   * - "dispatched" is NOT success: the reconcile pass promotes the leg via
   *   classification, and maintainEntry keeps it live (rebroadcast/fee-bump)
   *   until then. A dispatched entry always has an owner.
   * - Non-benign FIRST-broadcast failures are classified outside the lease and
   *   feed a fail-stop: after DISPATCH_FIRST_BROADCAST_FAILSTOP consecutive
   *   failures the failing entry quarantines, because with a broken settler
   *   (out of gas, dead RPC) every window would otherwise allocate and strand
   *   another run of nonces unbounded.
   */
  async dispatchMany(inputs: CoordinatorSubmitInput[]): Promise<DispatchOutcome[]> {
    if (inputs.length === 0) return [];
    if (this.closed) throw new Error("Transaction coordinator is closed");
    if (this.isQuarantined()) throw new SettlerQuarantinedError();
    const firstBroadcastFailures: { entry: OutboxEntry; index: number }[] = [];
    const outcomes = await this.withLease(async (): Promise<DispatchOutcome[]> => {
      if (this.closed) throw new Error("Transaction coordinator is closed");
      // The quarantine may have begun while this batch waited for the lease.
      if (this.isQuarantined()) throw new SettlerQuarantinedError();
      const results: DispatchOutcome[] = [];
      const fees = await this.initialFees();
      let nextNonce = await this.allocateNextNonce();
      for (const input of inputs) {
        const existing = this.outbox.byLogicalId(input.logicalId);
        if (existing) {
          if (existing.payloadFingerprint !== input.payloadFingerprint
            || existing.kind !== input.kind
            || existing.ref !== input.ref) {
            results.push({
              logicalId: input.logicalId,
              status: "failed",
              error: "Coordinator logicalId replay has a conflicting binding",
            });
            continue;
          }
          if (existing.state === "finalized" && existing.winningHash) {
            results.push({
              logicalId: input.logicalId,
              status: "finalized",
              nonce: existing.nonce,
              txHash: existing.winningHash,
            });
            continue;
          }
          if (existing.state === "failed") {
            results.push({
              logicalId: input.logicalId,
              status: "failed",
              error: "Coordinator logical operation is terminal-absent",
            });
            continue;
          }
          // Idempotent re-dispatch: rebroadcast the newest signed version once.
          // No fresh sign — a second sign would race putVersion's increasing-fee
          // check on exactly the retry path that must be safe.
          const latest = existing.versions[existing.versions.length - 1];
          if (latest) {
            try {
              await this.provider.broadcastTransaction(latest.signedTx);
            } catch {
              // alreadyKnown / nonceTooLow are benign on a REbroadcast; anything
              // else is settled by the next classification.
            }
          }
          results.push({
            logicalId: input.logicalId,
            status: "dispatched",
            nonce: existing.nonce,
            txHash: latest?.txHash ?? "",
          });
          continue;
        }
        const nonce = nextNonce;
        let version: { signedTx: string; txHash: string };
        try {
          version = await input.sign({ nonce, ...fees });
        } catch (error) {
          // Nothing was written: the nonce is NOT consumed, so the next input
          // reuses it and the sequence stays gapless.
          results.push({
            logicalId: input.logicalId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        nextNonce += 1;
        await this.outbox.putVersion({
          chainId: this.chainId,
          address: this.address,
          nonce,
          kind: input.kind,
          ref: input.ref,
          logicalId: input.logicalId,
          payloadFingerprint: input.payloadFingerprint,
          version: { ...version, ...fees, createdAt: Date.now() },
        });
        const entry = this.outbox.byLogicalId(input.logicalId);
        if (!entry) {
          results.push({ logicalId: input.logicalId, status: "failed", error: "Coordinator outbox write was lost" });
          continue;
        }
        let broadcastAtMs: number | undefined;
        try {
          await this.provider.broadcastTransaction(version.signedTx);
          this.consecutiveDispatchBroadcastFailures = 0;
          broadcastAtMs = Date.now();
        } catch (error) {
          if (isAlreadyKnown(error)) {
            this.consecutiveDispatchBroadcastFailures = 0;
            // alreadyKnown proves the bytes are in a mempool NOW, so the wave
            // measurement still has an honest timestamp for this leg.
            broadcastAtMs = Date.now();
          } else {
            // A FIRST-broadcast failure is not benign (unlike a rebroadcast):
            // nonceTooLow means allocation was wrong, and a refused broadcast
            // means the transaction may never have reached a mempool. Classified
            // outside the lease below rather than reported as plain success.
            firstBroadcastFailures.push({ entry, index: results.length });
          }
        }
        results.push({ logicalId: input.logicalId, status: "dispatched", nonce, txHash: version.txHash, broadcastAtMs });
      }
      return results;
    });
    for (const failure of firstBroadcastFailures) {
      this.consecutiveDispatchBroadcastFailures += 1;
      const classified = await this.classifyNonce({
        nonce: failure.entry.nonce,
        logicalId: failure.entry.logicalId,
      });
      if (classified.verdict === "terminal-absent") {
        // The nonce is finally occupied by a DIFFERENT payload: this dispatch
        // can never mine and must not be reported as in flight.
        await this.outbox.setState(failure.entry.logicalId, "failed");
        outcomes[failure.index] = {
          logicalId: failure.entry.logicalId,
          status: "failed",
          error: "first broadcast lost its nonce to a finalized occupant",
        };
      }
      // landed/included/pending/uncertain keep the "dispatched" outcome: the
      // entry has a durable identity and an owner (reconcile + maintainEntry).
      // The counter still advances — an entry can be individually fine while
      // the settler is systemically unable to broadcast.
      if (this.consecutiveDispatchBroadcastFailures >= DISPATCH_FIRST_BROADCAST_FAILSTOP) {
        await this.quarantine(failure.entry);
        this.startBackgroundReconcile();
        break;
      }
    }
    return outcomes;
  }

  /**
   * §2.3 maintain — the owner of every dispatched-but-unfinished entry. Called
   * from the queue's reconcile pass (which holds the NETWORK lock), one entry
   * per call, with the reconcile's own verdict passed through so classification
   * is not duplicated (H6).
   *
   * - Fully inert while quarantined: bumping a nonce whose disposition an
   *   operator is deciding turns the escape hatch into a bidding war.
   * - Skips suppressed and active-poll entries — both already have owners.
   * - Rebroadcasts the newest version unconditionally (an exact-byte rebroadcast
   *   is always safe); bumps only with a signer, only under a TRY-lease (never
   *   blocking the network lock on the settler lease), and only below
   *   MAINTAIN_VERSION_CAP.
   * - Per-entry deadline from durable versions[0].createdAt, so it survives
   *   restart: zero evidence past the confirm budget quarantines via the same
   *   path resumeEntry's budget expiry uses.
   */
  async maintainEntry(input: {
    logicalId: string;
    sign?: CoordinatorSubmitInput["sign"];
    verdict?: {
      verdict: "landed" | "included" | "terminal-absent" | "uncertain" | "pending";
      transactionHash?: string;
    };
  }): Promise<void> {
    if (this.closed) return;
    // Inertness is per-SETTLER, and waves amplify that (review M1, accepted):
    // one aged zero-evidence leg quarantining stops fee-bumps for every other
    // in-flight leg on the rail until the operator resolves it. Deliberate —
    // those siblings cannot mine behind the stuck nonce anyway on EVM, and a
    // bump that outbids the operator's cancel is worse than a stalled bump.
    if (this.isQuarantined()) return;
    const entry = this.outbox.byLogicalId(input.logicalId);
    if (!entry || isTerminal(entry.state)) return;
    if (entry.kind === "pool-payout" && this.suppressedPoolLogicalIds.has(entry.logicalId)) return;
    if (this.activePolls.has(entry.logicalId)) return;
    const classified = input.verdict
      ?? await this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId });
    if (classified.verdict === "landed" && classified.transactionHash) {
      await this.outbox.setState(entry.logicalId, "finalized", classified.transactionHash);
      await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
      this.schedulePendingDrain();
      return;
    }
    if (classified.verdict === "terminal-absent") {
      await this.outbox.setState(entry.logicalId, "failed");
      return;
    }
    if (classified.verdict === "included") {
      // Mined and canonical: the nonce is consumed, every replacement is dead
      // on arrival, and rebroadcasting is pointless. Record and stop.
      if (entry.state !== "included" && classified.transactionHash) {
        await this.outbox.setState(entry.logicalId, "included", classified.transactionHash);
      }
      return;
    }
    // pending / uncertain: the entry needs liveness work.
    //
    // Known window (review finding, accepted): the JOURNAL shows `uncertain`
    // once the entry passes dispatchGraceMs (default 90s), but this deadline —
    // the spec's "same path resumeEntry's budget expiry uses" — fires at
    // timeoutMs (default 120s). For the difference (~30s at defaults, bounded
    // by the startup grace<=timeout throw) an operator sees the alarm while
    // resolveQuarantine still answers "not yet escalated": the remaining fee
    // bumps in that window are deliberate, and the next reconcile pass closes
    // the gap on its own.
    const first = entry.versions[0];
    if (first && Date.now() - first.createdAt >= this.timeoutMs) {
      await this.quarantine(entry);
      this.startBackgroundReconcile();
      return;
    }
    const latest = entry.versions[entry.versions.length - 1];
    if (!latest) return;
    try {
      await this.provider.broadcastTransaction(latest.signedTx);
    } catch {
      // The next classification decides; rebroadcast is best-effort.
    }
    if (!input.sign) return;
    if (entry.versions.length >= MAINTAIN_VERSION_CAP) {
      await this.quarantine(entry);
      this.startBackgroundReconcile();
      return;
    }
    if (Date.now() - latest.createdAt < this.bumpAfterMs) return;
    const sign = input.sign;
    await this.tryWithLease(async () => {
      const current = this.outbox.byLogicalId(entry.logicalId);
      if (!current || isTerminal(current.state) || this.isQuarantined()) return;
      const newest = current.versions[current.versions.length - 1];
      if (!newest || Date.now() - newest.createdAt < this.bumpAfterMs) return;
      const fees = bumpFees(newest);
      const replacement = await sign({ nonce: current.nonce, ...fees });
      await this.outbox.putVersion({
        chainId: current.chainId,
        address: current.address,
        nonce: current.nonce,
        kind: current.kind,
        ref: current.ref,
        logicalId: current.logicalId,
        payloadFingerprint: current.payloadFingerprint,
        version: { ...replacement, ...fees, createdAt: Date.now() },
      });
    });
  }

  /**
   * `pending` (H7, spec-cohort-dispatch.md §2.4) means ZERO on-chain evidence for
   * an entry younger than the dispatch grace: no receipt anywhere and the nonce
   * unconsumed, milliseconds-to-seconds after broadcast. That is the EXPECTED
   * state of every healthy transaction during its mine latency, and it is the one
   * state a classifier polled on a cadence will observe constantly. It must never
   * be conflated with `uncertain` — journal writers treat `uncertain` as the entry
   * condition for operator disposition, so the conflation flaps every healthy
   * window into the audit queue. `pending` self-resolves: evidence appears, or the
   * entry ages past the grace and the same inputs become `uncertain`.
   */
  async classifyNonce(input: { nonce: number; logicalId: string }): Promise<{
    verdict: "landed" | "included" | "terminal-absent" | "uncertain" | "pending";
    transactionHash?: string;
    // §2.9 H11 — the landing coordinate, present only on `landed` and only when
    // the finality-covered receipt reported one. Consumers treat absence as
    // "unmeasured", never as evidence of tightness.
    blockNumber?: number;
  }> {
    const entry = this.outbox.byLogicalId(input.logicalId);
    if (!entry || entry.nonce !== input.nonce) return { verdict: "uncertain" };
    let included: string | undefined;
    for (const version of entry.versions) {
      const receipt = await this.provider.getTransactionReceipt(version.txHash);
      if (!receipt) continue;
      const standing = await this.receiptStanding(receipt);
      if (standing === "reorged") continue;
      if (standing === "included") {
        // Remember it and keep scanning: a later version of the same logical
        // operation may already be final, and "final" always outranks "included".
        // A non-final REVERT is deliberately not recorded — we will not reverse a
        // payout on a receipt that a reorg could still erase.
        if (Number(receipt.status) === 1) included ??= version.txHash;
        continue;
      }
      if (Number(receipt.status) === 1) {
        const blockNumber = Number(receipt.blockNumber);
        return {
          verdict: "landed",
          transactionHash: version.txHash,
          ...(Number.isFinite(blockNumber) ? { blockNumber } : {}),
        };
      }
      return { verdict: "terminal-absent" };
    }
    if (included) return { verdict: "included", transactionHash: included };

    const consumed = await this.provider.getTransactionCount(this.address, "latest");
    if (consumed <= input.nonce) {
      return { verdict: this.withinDispatchGrace(entry) ? "pending" : "uncertain" };
    }
    const occupant = await this.finalizedNonceOccupant(input.nonce);
    if (!occupant) {
      // Consumed but unidentifiable: when young this can be our own transaction
      // mined moments ago with the receipt not yet served — grace applies. Past
      // the grace it is genuine ambiguity.
      return { verdict: this.withinDispatchGrace(entry) ? "pending" : "uncertain" };
    }
    if (occupant.payloadFingerprint !== entry.payloadFingerprint) {
      return { verdict: "terminal-absent" };
    }
    return { verdict: "uncertain" };
  }

  /** Age is anchored to the FIRST version's durable createdAt — the dispatch time —
   *  so a fee bump does not reset the clock and the judgment survives restart. */
  private withinDispatchGrace(entry: OutboxEntry): boolean {
    const first = entry.versions[0];
    if (!first) return false;
    const age = Date.now() - first.createdAt;
    // A createdAt in the FUTURE (a forward clock jump at write time, later
    // corrected) would make the age negative and therefore "young" until the
    // wall clock catches up — a permanently-pending entry that recovery would
    // skip for the whole skew. Corrupt evidence gets the noisy answer
    // (uncertain), never the silent one.
    return age >= 0 && age < this.dispatchGraceMs;
  }

  outboxEntryFor(logicalId: string): OutboxEntry | undefined {
    return this.outbox.byLogicalId(logicalId);
  }

  outboxEntriesByRef(ref: string): OutboxEntry[] {
    // Scoped to THIS coordinator's (chainId, settler), because the outbox WAL
    // is one SHARED instance across every EVM network (src/server/index.ts
    // passes the same TransactionOutbox to the Base and Robinhood
    // coordinators). An unscoped ref lookup makes the ref-collision surface
    // cross-network: a payoutRef string reused on the other chain would hand
    // this rail a handle whose transaction lives on a different network
    // entirely, classified against the wrong provider (Grok review of
    // 78803f1). nonterminalNoncesAscending and highWaterNonce already scope;
    // these two lookups now match.
    return this.outbox.entriesByRef(ref)
      .filter((entry) => entry.chainId === this.chainId && lc(entry.address) === this.address);
  }

  async classifyTransactionHash(transactionHash: string): Promise<{
    verdict: "landed" | "included" | "terminal-absent" | "uncertain" | "pending";
    transactionHash?: string;
    blockNumber?: number;
  }> {
    const entry = this.outbox.byTransactionHash(transactionHash);
    // Same cross-network scoping as outboxEntriesByRef: a hash recorded by the
    // other chain's coordinator must not be classified against THIS provider.
    if (!entry || entry.chainId !== this.chainId || lc(entry.address) !== this.address) {
      return { verdict: "uncertain" };
    }
    return this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId });
  }

  suppressPoolPayoutRebroadcast(logicalId: string): void {
    this.suppressedPoolLogicalIds.add(logicalId);
  }

  isQuarantined(): boolean {
    return Boolean(this.outbox.quarantine(this.chainId, this.address));
  }

  quarantineDetail() {
    return this.outbox.quarantine(this.chainId, this.address);
  }

  recoverOutbox(): Promise<void> {
    return this.withLease(async () => {
      const deadline = Date.now() + this.recoveryBudgetMs;
      // Only a quarantine that predates this walk may be lifted by it. A poller
      // can propose a NEW record while the walk runs (polls are out-of-lease),
      // and the old unconditional clear at the end would have wiped it, unparking
      // submissions behind an unresolved ambiguity.
      const staleQuarantine = this.quarantineDetail();
      // The stale record may only be lifted if the walk actually RESOLVED (or
      // deliberately suppressed) the entry it names. Skipping that entry — because
      // a live poll owns it, or because it is young enough to classify `pending` —
      // is not resolution, and lifting the operator flag on a skip would hide an
      // ambiguity that is still open.
      let liftStaleQuarantine = staleQuarantine !== undefined;
      const skippedRecordedEntry = (entry: OutboxEntry) => {
        if (staleQuarantine?.logicalId === entry.logicalId) liftStaleQuarantine = false;
      };
      // A pending skip leaves the entry with NO owner: EVM reconcile only
      // classifies (it never rebroadcasts, unlike Solana's), applyVerdict(pending)
      // writes nothing, and the skip never quarantines — so a transaction the
      // mempool dropped after a restart would gap-stick the nonce pipeline
      // forever, with no cancel tooling reachable because that tooling hangs off
      // the quarantine record. Every young skip therefore extends a follow-up
      // deadline just past its remaining grace, and the walk schedules ONE
      // deferred re-run of recovery, where the aged entry takes the full
      // resumeEntry path and ownership (rebroadcast, quarantine, operator
      // escape) is restored.
      let followUpDelayMs = -1;
      const skippedYoungEntry = (entry: OutboxEntry) => {
        skippedRecordedEntry(entry);
        const first = entry.versions[0];
        const remainingGrace = first
          ? Math.max(0, this.dispatchGraceMs - (Date.now() - first.createdAt))
          : 0;
        followUpDelayMs = Math.max(followUpDelayMs, remainingGrace + 250);
      };
      const entries = this.outbox.nonterminalNoncesAscending(this.chainId, this.address);
      for (const entry of entries) {
        if (entry.kind === "pool-payout" && this.suppressedPoolLogicalIds.has(entry.logicalId)) {
          // Suppression abandons the entry deliberately, but it is still not a
          // RESOLUTION of a quarantine that happens to name it.
          skippedRecordedEntry(entry);
          continue;
        }
        // A live out-of-lease poll owns this entry's lifecycle. Recovery exists
        // for entries with NO owner (post-restart); running a second resumeEntry
        // here would race the live poll's fee bumps against putVersion's
        // increasing-fee check, and — worse — recovery's budget expiring on an
        // entry that is merely mid-wait would quarantine a healthy settler while
        // its owner is still polling. The startup call sites run before any
        // listener binds, so in production this skip is vacuous today; it is the
        // invariant that makes recoverOutbox safe to call at ANY time.
        if (this.activePolls.has(entry.logicalId)) {
          skippedRecordedEntry(entry);
          continue;
        }
        const budgetLeft = deadline - Date.now();
        if (budgetLeft <= 0) {
          // Exhausted before this entry got a turn. The age check is LOCAL — no
          // RPC — so a young entry is skipped rather than quarantined: freezing
          // the settler over an entry recovery never even examined is the exact
          // healthy-restart incident H8 exists to prevent. An old entry keeps the
          // exhaustion quarantine — past the grace, "no time to look" really is
          // unresolved ambiguity.
          if (this.withinDispatchGrace(entry)) {
            skippedYoungEntry(entry);
            continue;
          }
          // Full §2.8: an aged POOL entry on exhaustion skips too, because "no
          // time to look" is not unresolved ambiguity when something else is
          // going to look — recoverOutbox is only reachable from the payout
          // queue (its recover() and the follow-up timer this walk schedules),
          // so a pool entry always has a live reconcile+maintain owner that
          // classifies it within one reconcile cadence and quarantines via the
          // per-entry deadline if the ambiguity is real. Non-pool kinds have no
          // owner after a restart (their submit() caller died with the process),
          // so for them exhaustion past the grace keeps the quarantine.
          if (entry.kind === "pool-payout") {
            skippedRecordedEntry(entry);
            continue;
          }
          await this.quarantine(entry);
          this.startBackgroundReconcile();
          return;
        }
        // H8 minimal (spec-cohort-dispatch.md §2.8): with the finality wait outside
        // the lease, several `broadcasting` entries in flight is the healthy steady
        // state, and a restart mid-burst used to feed them all into resumeEntry
        // under ONE shared budget — budget exhaustion quarantined a healthy settler
        // and abandoned the rest of the walk. A young entry with zero evidence is
        // classified ONCE, rebroadcast once so it re-enters the mempool, and
        // skipped. It is finished by whatever classifies it next — and if nothing
        // does, by the follow-up recovery run this walk schedules for just past
        // the grace (see skippedYoungEntry above), so the skip always has an
        // eventual owner.
        //
        // The classification is raced against the remaining budget: it holds the
        // settler lease, so a hung RPC here would stall every submit and the
        // operator escape with it. Classification is read-only, so abandoning a
        // late answer is safe (the queue's startup pass documents the same
        // precedent). On timeout the provider is evidently unhealthy, so the
        // young-skip below deliberately does NOT attempt its rebroadcast RPC.
        const classified = await Promise.race([
          this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId }),
          delay(budgetLeft).then(() => undefined),
        ]);
        if (!classified) {
          if (this.withinDispatchGrace(entry)) {
            skippedYoungEntry(entry);
            continue;
          }
          // Same ownership argument as the exhaustion branch above: a hung
          // classification RPC on an aged pool entry is the provider's problem,
          // and the queue's reconcile retries it on its own cadence.
          if (entry.kind === "pool-payout") {
            skippedRecordedEntry(entry);
            continue;
          }
          await this.quarantine(entry);
          this.startBackgroundReconcile();
          return;
        }
        if (classified.verdict === "pending") {
          skippedYoungEntry(entry);
          const latest = entry.versions[entry.versions.length - 1];
          if (latest) {
            try {
              await this.provider.broadcastTransaction(latest.signedTx);
            } catch {
              // Rebroadcast is best-effort; the next classification decides.
            }
          }
          continue;
        }
        if (entry.kind === "pool-payout") {
          // Full §2.8 (cohort-aware recovery): a pool entry is never
          // resumeEntry-polled to completion. Under cohorts, 8 in-flight entries
          // at a routine deploy is the healthy steady state, and the old path —
          // each entry polled under ONE shared budget — made budget exhaustion
          // the likely outcome and quarantined a healthy settler. Every pool
          // entry has a durable journal leg whose reconcile+maintain owner
          // rebuilds its signer from durable data, so recovery's whole job here
          // is what a cold maintain cannot do for itself: apply the cheap
          // terminal transitions to the OUTBOX (the journal/ledger side belongs
          // to the queue, whose startup reconcile ran before this walk), and put
          // the signed bytes back into the post-restart mempool.
          if (classified.verdict === "landed" && classified.transactionHash) {
            await this.outbox.setState(entry.logicalId, "finalized", classified.transactionHash);
            await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
            this.schedulePendingDrain();
            continue;
          }
          if (classified.verdict === "terminal-absent") {
            // Matches backgroundReconcile's precedent: terminal-absent is a
            // RESOLUTION (the nonce is finally occupied by another payload), so
            // a quarantine naming this nonce lifts and the pipeline advances.
            // The debit reversal is the queue's applyVerdict, never done here.
            await this.outbox.setState(entry.logicalId, "failed");
            await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
            this.schedulePendingDrain();
            continue;
          }
          if (classified.verdict === "included" && classified.transactionHash) {
            // Mined and canonical: record the evidence so the pipeline is free,
            // but this is knowledge of an outcome still short of finality — not
            // a resolution that may lift a stale quarantine naming this entry.
            //
            // Judged against the LIVE entry, never the walk-start snapshot
            // (Codex review of 78803f1): the walk's per-entry RPCs take real
            // time, and the queue's reconcile+maintain runs concurrently on its
            // own cadence — it can finalize this exact entry between the
            // snapshot and this write, and `included` written over `finalized`
            // REGRESSES evidence that was already stronger, resurrecting the
            // entry into every later non-terminal walk.
            const live = this.outbox.byLogicalId(entry.logicalId);
            if (live && !isTerminal(live.state) && live.state !== "included") {
              await this.outbox.setState(entry.logicalId, "included", classified.transactionHash);
            }
            skippedRecordedEntry(entry);
            continue;
          }
          // Aged with zero evidence (`uncertain`). Rebroadcast so the bytes
          // re-enter the mempool, then leave the leg to its owner: the queue's
          // next reconcile classifies it, and maintainEntry's per-entry deadline
          // quarantines if the ambiguity persists past the confirm budget.
          // Quarantining HERE would freeze the settler at every restart that
          // follows more than dispatchGraceMs of downtime — the aged twin of the
          // healthy-restart incident H8 exists to prevent.
          skippedRecordedEntry(entry);
          const latest = entry.versions[entry.versions.length - 1];
          if (latest) {
            try {
              await this.provider.broadcastTransaction(latest.signedTx);
            } catch {
              // Best-effort; the owner's next classification decides.
            }
          }
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await this.quarantine(entry);
          this.startBackgroundReconcile();
          return;
        }
        try {
          await this.resumeEntry(entry, undefined, remaining);
        } catch (error) {
          // A shutdown mid-recovery is not an ambiguous outcome; quarantining
          // here would freeze the settler on the NEXT boot for no reason.
          if (this.closed) return;
          if (error instanceof SettlerNotYetFinalError) {
            // Mined, canonical, nonce consumed — this entry does not block the
            // pipeline, and unblocking the pipeline is the entire job of recovery.
            // The bare catch-all used to quarantine here, which meant any restart
            // inside the finality window froze the settler and ABANDONED every
            // remaining entry via the `return` below. On Base that window is ~20
            // minutes wide, so it was the likely outcome of a restart, not an edge.
            continue;
          }
          await this.quarantine(entry);
          this.startBackgroundReconcile();
          return;
        }
      }
      if (staleQuarantine && liftStaleQuarantine) {
        await this.outbox.clearQuarantineForNonce(this.chainId, this.address, staleQuarantine.nonce);
      }
      if (followUpDelayMs >= 0) this.scheduleRecoveryFollowUp(followUpDelayMs);
      this.schedulePendingDrain();
    });
  }

  /**
   * One deferred re-run of recovery, owed to entries a walk pending-skipped. By
   * fire time they have aged past the grace, so the re-run gives them the full
   * resumeEntry treatment (rebroadcast, fee-visibility, quarantine on genuine
   * ambiguity) that the skip deliberately withheld. One timer at a time; a
   * re-run that skips again (a NEW young entry) schedules its own successor, so
   * this converges. Unref'd — a scheduled follow-up never holds the process
   * open — and cancelled by close().
   */
  private scheduleRecoveryFollowUp(delayMs: number): void {
    if (this.recoveryFollowUpTimer || this.closed) return;
    const timer = setTimeout(() => {
      this.recoveryFollowUpTimer = undefined;
      if (this.closed) return;
      void this.recoverOutbox().catch(() => {
        // Recovery's own failure paths quarantine; nothing more to do here.
      });
    }, delayMs);
    timer.unref();
    this.recoveryFollowUpTimer = timer;
  }

  resolveQuarantine(
    input:
      | { nonce: number; mode: "cancel" }
      | { nonce: number; mode: "disposition"; landedHash?: string; absent?: boolean },
  ): Promise<{ verdict: "landed" | "terminal-absent"; transactionHash?: string }> {
    return this.withLease(async () => {
      const detail = this.quarantineDetail();
      if (!detail || detail.nonce !== input.nonce) {
        throw new Error(
          "Coordinator nonce is not quarantined. If the journal already shows this leg as"
          + " uncertain, the entry is still inside its confirm budget and has not escalated"
          + " yet — the next reconcile pass quarantines it; retry then.",
        );
      }
      const entry = detail.logicalId ? this.outbox.byLogicalId(detail.logicalId) : undefined;
      if (!entry) throw new Error("Quarantined outbox entry not found");

      if (input.mode === "disposition") {
        if (input.landedHash) {
          const version = entry.versions.find((item) => lc(item.txHash) === lc(input.landedHash as string));
          if (!version) throw new Error("Landed hash is not in the quarantined replacement lineage");
          const receipt = await this.provider.getTransactionReceipt(version.txHash);
          if (!receipt || Number(receipt.status) !== 1 || !(await this.isCanonicalFinal(receipt))) {
            throw new Error("Landed disposition is not finalized-canonical");
          }
          await this.outbox.setState(entry.logicalId, "finalized", version.txHash);
          // Conditional, not unconditional: a poller can replace the record with a
          // LOWER nonce while this disposition's RPCs are in flight, and clearing
          // the replacement would unpark submissions behind an unresolved root.
          await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
          this.schedulePendingDrain();
          return { verdict: "landed", transactionHash: version.txHash };
        }
        if (!input.absent) throw new Error("Disposition requires landedHash or absent");
        const classified = await this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId });
        if (classified.verdict !== "terminal-absent") {
          throw new Error("Absent disposition is not proven at the finalized head");
        }
        await this.outbox.setState(entry.logicalId, "failed");
        await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
        this.schedulePendingDrain();
        return { verdict: "terminal-absent" };
      }

      const before = await this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId });
      if (before.verdict === "landed") {
        await this.outbox.setState(entry.logicalId, "finalized", before.transactionHash);
        await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
        this.schedulePendingDrain();
        return { verdict: "landed", transactionHash: before.transactionHash };
      }
      if (!this.cancelSign) throw new Error("Coordinator cancel signer is not configured");
      const latest = entry.versions[entry.versions.length - 1];
      if (!latest) throw new Error("Quarantined outbox has no signed version");
      const fees = bumpFees({
        maxFeePerGas: latest.maxFeePerGas,
        maxPriorityFeePerGas: latest.maxPriorityFeePerGas,
      });
      const cancel = await this.cancelSign({ nonce: entry.nonce, ...fees });
      try {
        await this.provider.broadcastTransaction(cancel.signedTx);
      } catch (error) {
        if (!isAlreadyKnown(error)) {
          const afterError = await this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId });
          if (afterError.verdict === "landed") {
            // The original landed while we tried to cancel it. This is a RESOLVED
            // quarantine, not just a return value: without the state write and
            // clear, the settler stayed quarantined and the outbox stayed
            // `uncertain` while the operator was told "landed" — a false
            // resolution that parked all traffic until someone noticed.
            await this.outbox.setState(entry.logicalId, "finalized", afterError.transactionHash);
            await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
            this.schedulePendingDrain();
            return { verdict: "landed", transactionHash: afterError.transactionHash };
          }
          throw error;
        }
      }
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const classified = await this.classifyNonce({ nonce: entry.nonce, logicalId: entry.logicalId });
        if (classified.verdict === "landed") {
          await this.outbox.setState(entry.logicalId, "finalized", classified.transactionHash);
          await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
          this.schedulePendingDrain();
          return { verdict: "landed", transactionHash: classified.transactionHash };
        }
        const consumed = await this.provider.getTransactionCount(this.address, "latest");
        if (consumed > entry.nonce) {
          await this.outbox.setState(entry.logicalId, "failed");
          await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
          this.schedulePendingDrain();
          return { verdict: "terminal-absent" };
        }
        await delay(100);
      }
      throw new Error("Coordinator cancel did not resolve before timeout");
    });
  }

  close(): void {
    this.closed = true;
    if (this.recoveryFollowUpTimer) {
      clearTimeout(this.recoveryFollowUpTimer);
      this.recoveryFollowUpTimer = undefined;
    }
    for (const pending of this.pendingSubmissions.splice(0)) {
      pending.reject(new Error("Transaction coordinator is closed"));
    }
    this.outbox.close();
  }

  private async resumeEntry(
    initial: OutboxEntry,
    sign: CoordinatorSubmitInput["sign"] | undefined,
    timeoutMs: number,
  ): Promise<CoordinatorResult> {
    const deadline = Date.now() + timeoutMs;
    let entry = initial;
    let lastBroadcastAt = 0;
    let includedHash: string | undefined;
    while (Date.now() < deadline) {
      // Out-of-lease polls must honor close(): without this check an orphaned
      // poll keeps broadcasting and writing to the outbox after shutdown began.
      // The entry stays `broadcasting` in the WAL, which is exactly what the next
      // boot's recovery expects to find — shutdown is not ambiguity.
      if (this.closed) throw new Error("Transaction coordinator is closed");
      const classified = await this.classifyNonce({
        nonce: entry.nonce,
        logicalId: entry.logicalId,
      });
      if (classified.verdict === "landed" && classified.transactionHash) {
        await this.outbox.setState(entry.logicalId, "finalized", classified.transactionHash);
        // Clear the quarantine only when it refers to THIS nonce. Polls now run
        // outside the lease, so an unrelated submission can land while some other
        // nonce sits quarantined; the old unconditional clear would erase that
        // record and unpark every pending submission behind an outcome that is
        // still ambiguous.
        await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
        this.schedulePendingDrain();
        return { txHash: classified.transactionHash, nonce: entry.nonce, state: "finalized" };
      }
      if (classified.verdict === "terminal-absent") {
        await this.outbox.setState(entry.logicalId, "failed");
        throw new Error("Settler transaction is terminal-absent");
      }
      // Reflect the MOST RECENT classification, never a remembered one. An inclusion
      // can be undone: if the block holding the receipt stops being canonical, the
      // next pass returns `uncertain`, and carrying the old hash forward would write
      // a stale `included` at the deadline, skip the quarantine, and free the nonce
      // pipeline on an outcome that is once again ambiguous.
      includedHash = classified.verdict === "included" ? classified.transactionHash : undefined;
      if (classified.verdict === "included" && classified.transactionHash) {
        // Mined and canonical; only finality is outstanding. Record the hash, then
        // keep polling WITHOUT rebroadcasting or fee-bumping: the nonce is already
        // consumed, so every replacement is dead on arrival, and at a 45s bump
        // interval against a ~20min finality tag we would otherwise sign ~25 useless
        // replacements per transaction, each an fsync and each forced to escalate
        // fees (putVersion rejects a non-increasing replacement).
        includedHash = classified.transactionHash;
        // Without a signer there is no fee-bump and no replacement to attempt, so
        // waiting can only pay off if finality happens to arrive inside the budget —
        // against a ~20min tag and a 15s recovery budget, never. Recovery walks
        // entries under ONE shared budget, so burning it here starves every later
        // entry and ends in the budget-exhaustion quarantine.
        if (!sign) break;
        await delay(100);
        continue;
      }

      const current = entry.versions[entry.versions.length - 1];
      if (!current) throw new Error("Outbox entry has no signed transaction");
      if (lastBroadcastAt === 0 || Date.now() - lastBroadcastAt >= Math.min(this.bumpAfterMs, 1_000)) {
        try {
          await this.provider.broadcastTransaction(current.signedTx);
        } catch (error) {
          if (!isAlreadyKnown(error) && !isNonceTooLow(error)) {
            await this.outbox.setState(entry.logicalId, "uncertain");
          }
        }
        lastBroadcastAt = Date.now();
      }

      // No fee-bumps while a quarantine records a nonce at or below ours: a
      // transaction behind an unmined nonce cannot mine no matter what it pays,
      // so every replacement is a wasted sign+fsync — and a SAME-nonce bump would
      // outbid the operator's cancel, the §2.3 bidding war. A record ABOVE our
      // nonce does not gate us: our mining does not depend on it. Rebroadcasts
      // continue either way; only replacements are suppressed.
      const quarantineRecord = this.quarantineDetail();
      const stuckBehindQuarantine = quarantineRecord !== undefined && quarantineRecord.nonce <= entry.nonce;
      if (sign && !stuckBehindQuarantine && Date.now() - current.createdAt >= this.bumpAfterMs) {
        const fees = bumpFees(current);
        const replacement = await sign({ nonce: entry.nonce, ...fees });
        await this.outbox.putVersion({
          chainId: entry.chainId,
          address: entry.address,
          nonce: entry.nonce,
          kind: entry.kind,
          ref: entry.ref,
          logicalId: entry.logicalId,
          payloadFingerprint: entry.payloadFingerprint,
          version: { ...replacement, ...fees, createdAt: Date.now() },
        });
        entry = this.outbox.byLogicalId(entry.logicalId) ?? entry;
      }
      await delay(100);
    }
    if (includedHash) {
      // The budget expired on a transaction we KNOW mined into a canonical block.
      // Quarantining here would be a category error: quarantine exists to freeze the
      // nonce pipeline when an outcome is AMBIGUOUS, and this outcome is not. It also
      // would not be recoverable in practice — on Base and Robinhood the finality tag
      // trails by far more than any budget an operator would set, so a quarantine on
      // "not yet final" fires on every single settler transaction.
      // The nonce is consumed, so the pipeline is free to advance. Recovery, or the
      // caller's next reconcile pass, promotes `included` to `finalized`.
      await this.outbox.setState(entry.logicalId, "included", includedHash);
      this.schedulePendingDrain();
      throw new SettlerNotYetFinalError({ transactionHash: includedHash, nonce: entry.nonce });
    }
    await this.quarantine(entry);
    this.startBackgroundReconcile();
    throw new Error("Settler transaction finality timeout; coordinator quarantined");
  }

  private async quarantine(entry: OutboxEntry) {
    await this.outbox.setState(entry.logicalId, "uncertain");
    // With polls outside the lease, a stuck nonce N strands every nonce above it
    // and they all time out together. The operator's cancel/disposition tooling
    // only acts on the recorded nonce, and the lowest is the root blocker —
    // resolving it is what can unstick the rest — so a higher nonce never
    // overwrites a lower one (enforced atomically inside the outbox write queue).
    await this.outbox.proposeQuarantine(this.chainId, this.address, entry.nonce);
  }

  // Reconciles whatever entry the quarantine record CURRENTLY names, re-read every
  // pass, rather than an entry captured at start: the record can be replaced by a
  // lower nonce mid-loop, and a loop keyed to the old entry would spin on a nonce
  // the operator tooling no longer points at.
  private startBackgroundReconcile() {
    if (this.backgroundReconcileActive) return;
    this.backgroundReconcileActive = true;
    void (async () => {
      try {
        while (!this.closed && this.isQuarantined()) {
          const detail = this.quarantineDetail();
          const entry = detail?.logicalId ? this.outbox.byLogicalId(detail.logicalId) : undefined;
          // No resolvable outbox identity: operator disposition is the only path.
          if (!entry) return;
          try {
          const classified = await this.classifyNonce({
            nonce: entry.nonce,
            logicalId: entry.logicalId,
          });
          // Nonce-conditional clears: the record can be replaced by a lower nonce
          // while this pass's classification RPCs were in flight, and clearing the
          // replacement would unpark submissions behind an unresolved ambiguity.
          // `continue`, not `return`: if the clear was skipped because the record
          // was replaced, the loop must go on and reconcile the NEW record; if the
          // clear applied, `isQuarantined()` is false and the loop exits normally.
          if (classified.verdict === "landed" && classified.transactionHash) {
            await this.outbox.setState(entry.logicalId, "finalized", classified.transactionHash);
            await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
            this.schedulePendingDrain();
            continue;
          }
          if (classified.verdict === "terminal-absent") {
            await this.outbox.setState(entry.logicalId, "failed");
            await this.outbox.clearQuarantineForNonce(this.chainId, this.address, entry.nonce);
            this.schedulePendingDrain();
            continue;
          }
          const current = this.outbox.byLogicalId(entry.logicalId)?.versions;
          const latest = current?.[current.length - 1];
          if (latest) {
            try {
              await this.provider.broadcastTransaction(latest.signedTx);
            } catch (error) {
              if (!isAlreadyKnown(error) && !isNonceTooLow(error)) {
                // Keep the WAL identity parked; the next pass reclassifies.
              }
            }
          }
          } catch {
            // A dead RPC must not terminate the background reconciliation loop.
          }
          await unrefDelay(Math.max(250, Math.min(this.bumpAfterMs, 5_000)));
        }
      } finally {
        this.backgroundReconcileActive = false;
      }
    })();
  }

  /**
   * The ONE nonce-allocation formula. d696a56 extracted allocation into a single
   * implementation because three reviewers independently named a second,
   * hand-copied path as the likeliest duplicate-nonce bug — and the dispatch
   * increment then inlined a copy anyway (caught in review). MUST be called
   * inside `this.withLease` only: the never-pruned outbox makes `highWater`
   * monotonic, and the lease is what makes read-then-allocate atomic.
   */
  private async allocateNextNonce(): Promise<number> {
    const chainPending = await this.provider.getTransactionCount(this.address, "pending");
    const highWater = this.outbox.highWaterNonce(this.chainId, this.address);
    return Math.max(chainPending, highWater === undefined ? chainPending : highWater + 1);
  }

  private async initialFees() {
    const feeData = await this.provider.getFeeData();
    const priority = feeData.maxPriorityFeePerGas ?? 1_000_000_000n;
    const max = feeData.maxFeePerGas ?? feeData.gasPrice ?? priority * 2n;
    return {
      maxFeePerGas: max.toString(),
      maxPriorityFeePerGas: priority.toString(),
    };
  }

  /**
   * Three distinct standings, deliberately not two:
   *   "final"     — canonical AND covered by the configured finality criterion.
   *   "included"  — mined into a block that is still canonical, but the finality
   *                 tag has not reached it yet. This is the ORDINARY state of every
   *                 transaction for its first finality interval (measured 2026-07-31:
   *                 ~1462s on Base, ~1062s on Robinhood). It is a known outcome, not
   *                 an ambiguous one, and must never be treated as ambiguity.
   *   "reorged"   — the block that held this receipt is no longer canonical.
   */
  private async receiptStanding(
    receipt: TransactionReceipt,
  ): Promise<"final" | "included" | "reorged"> {
    const canonical = await this.provider.getBlock(receipt.blockNumber);
    if (!canonical?.hash || lc(canonical.hash) !== lc(receipt.blockHash)) return "reorged";
    try {
      const finalized = await this.provider.getBlock(this.finality);
      if (finalized) return receipt.blockNumber <= finalized.number ? "final" : "included";
    } catch {
      // Fall back only on chains whose RPC does not implement safe/finalized tags.
    }
    const latest = await this.provider.getBlock("latest");
    return latest && latest.number - receipt.blockNumber + 1 >= this.confirmationFloorFallback
      ? "final"
      : "included";
  }

  private async isCanonicalFinal(receipt: TransactionReceipt): Promise<boolean> {
    return (await this.receiptStanding(receipt)) === "final";
  }

  private async finalizedNonceOccupant(nonce: number): Promise<{
    payloadFingerprint: string;
  } | undefined> {
    try {
      const raw = await this.provider.send("eth_getTransactionBySenderAndNonce", [
        this.address,
        `0x${nonce.toString(16)}`,
      ]) as {
        to?: string;
        input?: string;
        value?: string;
        blockNumber?: string;
        blockHash?: string;
      } | null;
      if (!raw?.blockNumber || !raw.blockHash) return undefined;
      const blockNumber = Number.parseInt(raw.blockNumber, 16);
      const canonical = await this.provider.getBlock(blockNumber);
      const finalized = await this.provider.getBlock(this.finality);
      if (!canonical?.hash
        || lc(canonical.hash) !== lc(raw.blockHash)
        || !finalized
        || blockNumber > finalized.number) {
        return undefined;
      }
      return {
        payloadFingerprint: evmPayloadFingerprint({
          to: raw.to ?? "",
          data: raw.input ?? "0x",
          value: raw.value ?? "0x0",
          chainId: this.chainId,
        }),
      };
    } catch {
      return undefined;
    }
  }

  private withLease<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.leaseBusy = true;
      try {
        return await operation();
      } finally {
        this.leaseBusy = false;
      }
    };
    const result = this.lease.then(run, run);
    this.lease = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * SOFT-try lease acquisition for maintainEntry's bump (§2.3): maintain runs
   * inside the queue's reconcile, which holds the NETWORK lock — blocking here
   * would chain that lock behind the settler lease (R12's shape). This is a
   * soft try, not a true try-lock (review M3, accepted): `leaseBusy` is true
   * only while an operation RUNS, so a caller that passes the check can still
   * queue briefly behind a submission chained in the same gap. Post-R14 every
   * lease hold is a short acquire/sign span, and the long-holder that matters
   * (recoverOutbox's whole walk) keeps the flag true throughout, so the wait
   * this soft try can admit is bounded by one acquire — not a finality wait.
   */
  private async tryWithLease(operation: () => Promise<void>): Promise<boolean> {
    if (this.leaseBusy) return false;
    await this.withLease(operation);
    return true;
  }

  private schedulePendingDrain() {
    queueMicrotask(() => {
      if (this.isQuarantined() || this.closed) return;
      const pending = this.pendingSubmissions.splice(0);
      for (const item of pending) {
        void this.submit(item.input).then(item.resolve, item.reject);
      }
    });
  }
}

export const evmPayloadFingerprint = (input: {
  to: string;
  data: string;
  value: string | bigint;
  chainId: number;
}) => `0x${createHash("sha256").update(JSON.stringify({
  to: lc(input.to),
  data: lc(input.data),
  value: BigInt(input.value).toString(),
  chainId: input.chainId,
})).digest("hex")}`;

export const coordinatorLogicalId = (input: {
  kind: SettlerSendKind;
  ref?: string;
  payloadFingerprint: string;
}) => `0x${createHash("sha256").update(JSON.stringify({
  kind: input.kind,
  ref: input.ref ?? null,
  payloadFingerprint: input.payloadFingerprint,
})).digest("hex")}`;

const quarantineKey = (chainId: number, address: string) => `${chainId}:${lc(address)}`;
const lc = (value: string) => value.toLowerCase();
const isTerminal = (state: OutboxState) => state === "finalized" || state === "failed";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unrefDelay = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
});
const bumpFees = (input: { maxFeePerGas: string; maxPriorityFeePerGas: string }) => ({
  maxFeePerGas: ((BigInt(input.maxFeePerGas) * 9n) / 8n + 1n).toString(),
  maxPriorityFeePerGas: ((BigInt(input.maxPriorityFeePerGas) * 9n) / 8n + 1n).toString(),
});
const errorText = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
const isAlreadyKnown = (error: unknown) => /already known|known transaction/.test(errorText(error));
const isNonceTooLow = (error: unknown) => /nonce too low|already used/.test(errorText(error));
