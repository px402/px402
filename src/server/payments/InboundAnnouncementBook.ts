import { randomBytes } from "node:crypto";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

/**
 * Durable index of stealth announcements owed to a PAYEE.
 *
 * A stealth one-time key is `kSpend + H(kView * R)`. Without `R` — the ephemeral
 * pubkey, the "announcement" — a payee cannot derive the key and cannot even
 * locate the address, so the funds are unreachable forever. `R` is freshly
 * random per payment and is deliberately never published to a public ERC-5564
 * Announcer, and the payout ACK carrying it goes to the PAYER. Without this book
 * a payee therefore has no in-protocol way to learn about, let alone spend,
 * money paid to them. See spec-stealth-inbox.md D1.
 *
 * This adds no trust assumption: the server already holds every payee's
 * viewing key and already computes these addresses in `rail.resolveRecipient`.
 * The book persists what the server necessarily already knows so the payee can
 * be told.
 *
 * Durable and encrypted, NOT tmpfs: it backs live claimable value, same as the
 * blind-voucher stores.
 */

export type InboundAnnouncementStatus =
  | "announced" // indexed write-ahead; nothing observed on-chain yet
  | "observed" // the stealth address holds a nonzero balance
  | "sweeping" // a sweep-to-pool deposit intent is outstanding (phase 2)
  | "swept" // consolidated into the pool and credited (phase 2)
  | "dormant"; // confirmed empty long after announcement

/**
 * A previously-funded output fell to zero without our sweep path having moved
 * it — i.e. somebody else spent it, or the one-time key leaked. Surfaced, never
 * hidden, and never reaped.
 */
export type InboundAnnouncementAnomaly = "unexplained-drain";

/**
 * Whether this output's value is readable from the chain at all
 * (spec-confidential-x402.md B3 — a P0 fund-loss guard).
 *
 * A CONFIDENTIAL output's plaintext on-chain balance is **zero by construction**:
 * the value lives in ElGamal ciphertext, and `token.amount`/`balanceOf` read 0
 * forever. Feed that to the dormancy logic below and the record is observed at
 * zero, marked `dormant`, and then REAPED — destroying the only copy of `R` and
 * making the funds permanently unreachable, silently, ~24 h after creation. The
 * `unexplained-drain` guard does not catch it either, because that only fires
 * from `status === "observed"`, which requires a prior NONZERO observation a
 * confidential output can never produce.
 *
 * So dormancy means "provably holds nothing", and for a confidential output that
 * proof does not exist. Such records are never dormant and never reaped except
 * through `swept`.
 */
export type InboundAnnouncementConfidentiality = "plain" | "confidential";

export interface InboundAnnouncementRecord {
  id: string;
  accountId: string;
  network: string;
  caip2: string;
  tokenAddress: string;
  stealthAddress: string;
  /** THE announcement. Losing this loses the funds. */
  ephemeralPubKey: string;
  expectedAmountAtomic: string | null;
  observedAmountAtomic: string | null;
  source: "pool-payout" | "x402-direct" | "simulated";
  /** `<groupRef>:<index>`, or the quote nonce. Unique per network. */
  sourceRef: string;
  status: InboundAnnouncementStatus;
  /** Defaults to `"plain"`, so every pre-existing record migrates unchanged. */
  confidentiality: InboundAnnouncementConfidentiality;
  /**
   * Bumped on every mutation. Two claims that both read a clone of the same
   * `observed` record would otherwise both proceed; a writer that presents a
   * stale generation loses instead.
   */
  generation: number;
  anomaly: InboundAnnouncementAnomaly | null;
  sweepIntentId: string | null;
  sweepTxHash: string | null;
  createdAt: number;
  observedAt: number | null;
  sweptAt: number | null;
}

export interface InboundAnnouncementBookFile {
  version: 2;
  records: InboundAnnouncementRecord[];
}

/**
 * Raised only when a `transition` loses the compare-and-swap, so a caller can
 * tell "somebody else got there first" (retryable, benign) apart from "this
 * record is broken" (not retryable).
 */
export class InboundAnnouncementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundAnnouncementConflictError";
  }
}

export interface InboundAnnouncementBookOptions {
  retentionMs: number;
  dormantMs: number;
  encryptionKey: string;
}

export type NewInboundAnnouncement = Pick<
  InboundAnnouncementRecord,
  | "accountId"
  | "network"
  | "caip2"
  | "tokenAddress"
  | "stealthAddress"
  | "ephemeralPubKey"
  | "expectedAmountAtomic"
  | "source"
  | "sourceRef"
> & Partial<Pick<InboundAnnouncementRecord, "confidentiality">>;

const EMPTY_BOOK = (): InboundAnnouncementBookFile => ({ version: 2, records: [] });

const ACCOUNT_ID = /^acct_[a-f0-9]{64}$/;

/**
 * v1 had no `generation` and no `anomaly`. The migration fills them in place
 * and never drops a record: this file holds the only copy of every `R`, so a
 * migration that discards anything it does not recognise loses real money.
 */
const migrateRecord = (record: InboundAnnouncementRecord): boolean => {
  const raw = record as unknown as Record<string, unknown>;
  let changed = false;
  if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || (raw.generation as number) < 0) {
    raw.generation = 0;
    changed = true;
  }
  if (raw.anomaly !== "unexplained-drain" && raw.anomaly !== null) {
    raw.anomaly = null;
    changed = true;
  }
  // B3 — every record written before confidential outputs existed is plain, and
  // an unrecognised value must fail SAFE (treated as confidential ⇒ never reaped)
  // rather than silently becoming reapable.
  if (raw.confidentiality !== "plain" && raw.confidentiality !== "confidential") {
    raw.confidentiality = raw.confidentiality === undefined ? "plain" : "confidential";
    changed = true;
  }
  return changed;
};

export class InboundAnnouncementBook {
  private readonly file: EncryptedJsonFile<InboundAnnouncementBookFile>;
  private state = EMPTY_BOOK();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, private readonly options: InboundAnnouncementBookOptions) {
    if (!options.encryptionKey.trim()) {
      throw new Error("Inbound announcement book requires PX402_DATA_ENCRYPTION_KEY");
    }
    if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) {
      throw new Error("Inbound announcement retention must be a non-negative duration");
    }
    if (!Number.isFinite(options.dormantMs) || options.dormantMs < 0) {
      throw new Error("Inbound announcement dormancy grace must be a non-negative duration");
    }
    this.file = new EncryptedJsonFile(filePath, options.encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_BOOK());
    const version = (stored as { version: number }).version;
    if ((version !== 1 && version !== 2) || !Array.isArray(stored.records)) {
      throw new Error("Inbound announcement book file is invalid");
    }
    let migrated = version !== 2;
    for (const record of stored.records) {
      if (migrateRecord(record)) migrated = true;
    }
    stored.version = 2;
    this.state = stored;
    for (const record of this.state.records) this.assertRecord(record);
    if (migrated || this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  /**
   * Write-ahead the announcements for one payout group in a single fsync.
   *
   * MUST complete before the legs become broadcastable. A crash between
   * broadcast and index-write would strand the funds permanently, which is the
   * defect this book exists to close. Idempotent on `(network, sourceRef)` so a
   * retried enqueue does not duplicate.
   */
  addMany(entries: NewInboundAnnouncement[]): Promise<InboundAnnouncementRecord[]> {
    return this.serialize(async () => {
      const added: InboundAnnouncementRecord[] = [];
      let dirty = false;
      for (const entry of entries) {
        const existing = this.state.records.find((candidate) =>
          candidate.network === entry.network && candidate.sourceRef === entry.sourceRef);
        if (existing) {
          added.push(structuredClone(existing));
          continue;
        }
        const record: InboundAnnouncementRecord = {
          ...structuredClone(entry),
          id: `inbound-${randomBytes(12).toString("hex")}`,
          status: "announced",
          confidentiality: entry.confidentiality ?? "plain",
          generation: 0,
          anomaly: null,
          observedAmountAtomic: null,
          sweepIntentId: null,
          sweepTxHash: null,
          createdAt: Date.now(),
          observedAt: null,
          sweptAt: null,
        };
        this.assertRecord(record);
        this.state.records.push(record);
        added.push(structuredClone(record));
        dirty = true;
      }
      if (dirty) await this.persist();
      return added;
    });
  }

  forAccount(accountId: string, network?: string): InboundAnnouncementRecord[] {
    return this.state.records
      .filter((record) => record.accountId === accountId
        && (network === undefined || record.network === network))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => structuredClone(record));
  }

  byId(id: string): InboundAnnouncementRecord | undefined {
    const record = this.state.records.find((entry) => entry.id === id);
    return record ? structuredClone(record) : undefined;
  }

  /**
   * The least-recently-checked records worth re-observing, capped.
   *
   * `forAccount` sorts newest-first, so refreshing a fixed head of that list
   * re-checks the same recent records forever: an account with more records
   * than the cap never re-observes its oldest, which are exactly the ones most
   * likely to be holding funds nobody has looked for. Ordering by observation
   * age instead makes the window rotate — a record checked now sinks to the
   * back and the next call picks up the next oldest. Never-observed records
   * sort first for the same reason.
   *
   * `simulated` records are excluded: no chain ever funded their address, so a
   * live `balanceOf` returns 0 and would erase the simulated amount.
   */
  refreshable(accountId: string, network: string | undefined, limit: number): InboundAnnouncementRecord[] {
    return this.state.records
      .filter((record) => record.accountId === accountId
        && (network === undefined || record.network === network)
        && record.status !== "sweeping"
        && record.status !== "swept"
        && record.source !== "simulated")
      .sort((left, right) => (left.observedAt ?? 0) - (right.observedAt ?? 0))
      .slice(0, Math.max(0, Math.floor(limit)))
      .map((record) => structuredClone(record));
  }

  /**
   * Compare-and-swap on both status and generation, then mutate.
   *
   * Callers read a `structuredClone`, so two of them racing on one record would
   * otherwise both see `observed` and both proceed to spend the same output.
   * The generation is owned here and bumped after `mutate`, so a mutator cannot
   * forge one.
   */
  transition(
    id: string,
    expectedFrom: InboundAnnouncementStatus,
    expectedGeneration: number,
    mutate: (record: InboundAnnouncementRecord) => void,
  ): Promise<InboundAnnouncementRecord> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record) throw new Error("Inbound announcement record not found");
      if (record.status !== expectedFrom || record.generation !== expectedGeneration) {
        throw new InboundAnnouncementConflictError(
          `Inbound announcement CAS failed: expected ${expectedFrom}@${expectedGeneration}, got ${record.status}@${record.generation}`,
        );
      }
      mutate(record);
      record.generation += 1;
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  /**
   * Record an on-chain balance observation. `announced -> observed` when funded;
   * a confirmed-empty record past the dormancy grace becomes `dormant`. Never
   * moves a funded record to dormant.
   *
   * A record we have positively seen funded that now reads zero, without having
   * passed through `sweeping`/`swept`, was drained by somebody else. Before
   * this comparison existed a drained output was indistinguishable from one
   * that was never funded, so the loss was silent. The flag is sticky and the
   * record is never reaped afterwards — it is the only evidence.
   *
   * Deliberately NOT treated as a drain: a first observation of zero on a
   * record with a nonzero `expectedAmountAtomic`. That is the normal state of
   * every announcement written ahead of its own broadcast, and firing there
   * would make the signal noise.
   */
  observe(id: string, observedAmountAtomic: bigint, now = Date.now()): Promise<InboundAnnouncementRecord> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record) throw new Error("Inbound announcement record not found");
      if (record.status === "sweeping" || record.status === "swept") {
        return structuredClone(record);
      }
      // B3 — a confidential output reads zero forever, so a zero observation is
      // neither evidence of a drain nor evidence of emptiness. It can never go
      // dormant, and therefore can never be reaped out from under its funds.
      const confidential = record.confidentiality === "confidential";
      const drained = !confidential && record.status === "observed" && observedAmountAtomic === 0n;
      record.observedAmountAtomic = observedAmountAtomic.toString();
      record.observedAt = now;
      record.status = observedAmountAtomic > 0n
        ? "observed"
        : confidential || record.createdAt + this.options.dormantMs > now
          ? "announced"
          : "dormant";
      if (drained && record.anomaly === null) {
        record.anomaly = "unexplained-drain";
        // The id is kept here, unlike the routine refresh log: this is a rare
        // loss-of-funds event and an operator cannot act on it without one.
        console.warn(
          `STEALTH_INBOX_ANOMALY unexplained-drain id=${record.id} network=${record.network} expected=${record.expectedAmountAtomic ?? "null"}`,
        );
        // TODO(phase-4b): enqueue { recordId, reason: "zero-without-receipt" }
        // onto DepositReconciliationQueue here. The queue is claim-path wiring
        // the registry owns, so 4a surfaces the anomaly and does not enqueue.
      }
      record.generation += 1;
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  byStealthAddress(network: string, stealthAddress: string): InboundAnnouncementRecord | undefined {
    const wanted = stealthAddress.toLowerCase();
    const record = this.state.records.find((entry) =>
      entry.network === network && entry.stealthAddress.toLowerCase() === wanted);
    return record ? structuredClone(record) : undefined;
  }

  /**
   * A sweep-to-pool deposit is outstanding for this output. Holds the record
   * out of dormancy and out of reaping until the sweep resolves.
   */
  markSweeping(id: string, sweepIntentId: string): Promise<InboundAnnouncementRecord> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record) throw new Error("Inbound announcement record not found");
      if (record.status === "swept") throw new Error("Inbound announcement is already swept");
      record.status = "sweeping";
      record.sweepIntentId = sweepIntentId;
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  markSwept(id: string, sweepTxHash: string, now = Date.now()): Promise<InboundAnnouncementRecord> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record) throw new Error("Inbound announcement record not found");
      record.status = "swept";
      record.sweepTxHash = sweepTxHash;
      record.sweptAt = now;
      record.observedAmountAtomic = "0";
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Release a sweep reservation whose relay never landed. */
  releaseSweeping(id: string): Promise<InboundAnnouncementRecord | undefined> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record || record.status !== "sweeping") return undefined;
      record.status = "observed";
      record.sweepIntentId = null;
      await this.persist();
      return structuredClone(record);
    });
  }

  /**
   * Reap only what provably cannot hold value: swept records past retention, and
   * confirmed-empty dormant records past the grace. Anything with a nonzero
   * observed balance, or never observed at all, is retained — an unchecked
   * record could still hold funds, and dropping it destroys the only copy of the
   * announcement.
   *
   * A drained record reads as confirmed-empty and would otherwise reap on the
   * dormancy path, destroying the evidence of the loss along with the `R` an
   * operator needs to investigate it. Anomalous records are kept indefinitely.
   */
  reap(now = Date.now()): Promise<number> {
    return this.serialize(async () => {
      const before = this.state.records.length;
      this.state.records = this.state.records.filter((record) => {
        if (record.anomaly !== null) return true;
        // B3, belt and braces. `observe` already refuses to mark a confidential
        // record dormant, so this is unreachable today — but the cost of the
        // invariant being wrong is permanent, silent loss of funds, so it is
        // asserted at the deletion site too and not only at the transition.
        if (record.confidentiality === "confidential" && record.status !== "swept") return true;
        if (record.status === "swept") {
          return record.sweptAt === null || record.sweptAt + this.options.retentionMs > now;
        }
        if (record.status === "dormant") {
          const confirmedEmpty = record.observedAt !== null && record.observedAmountAtomic === "0";
          return !confirmedEmpty || record.createdAt + this.options.dormantMs > now;
        }
        return true;
      });
      const removed = before - this.state.records.length;
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  all(): readonly InboundAnnouncementRecord[] {
    return this.state.records.map((record) => structuredClone(record));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Inbound announcement book is closed"));
    const execute = async () => {
      const previous = structuredClone(this.state);
      try {
        return await operation();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    };
    const result = this.writeQueue.then(execute, execute);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }

  private assertRecord(record: InboundAnnouncementRecord) {
    if (!record.id.startsWith("inbound-")
      || !ACCOUNT_ID.test(record.accountId)
      || !record.network
      || !record.stealthAddress
      || !record.ephemeralPubKey
      || !record.sourceRef) {
      throw new Error("Inbound announcement record is invalid");
    }
    if (!Number.isInteger(record.generation) || record.generation < 0) {
      throw new Error("Inbound announcement generation must be a non-negative integer");
    }
    if (record.confidentiality !== "plain" && record.confidentiality !== "confidential") {
      throw new Error("Inbound announcement confidentiality must be plain or confidential");
    }
    if (record.expectedAmountAtomic !== null && BigInt(record.expectedAmountAtomic) <= 0n) {
      throw new Error("Inbound announcement expected amount must be positive when present");
    }
    if (record.observedAmountAtomic !== null && BigInt(record.observedAmountAtomic) < 0n) {
      throw new Error("Inbound announcement observed amount must not be negative");
    }
  }
}
