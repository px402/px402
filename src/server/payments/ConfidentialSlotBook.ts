import { randomBytes } from "node:crypto";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";
import type { ConfidentialEncryptionPubKey } from "../../shared/x402SolanaConfidential";

/**
 * Durable pool of payee-provisioned one-time confidential receive slots
 * (spec-confidential-x402.md §5.2-P).
 *
 * WHY A POOL AT ALL — measured on devnet, not assumed. A Token-2022 confidential
 * transfer can only land in an account that has already been CONFIGURED, and
 * `ConfigureConfidentialTransferAccount` fails with `Missing required signature`
 * unless the account's OWNER signs. The owner of a one-time stealth address is
 * the payee, so the payer can never bootstrap its own destination. A one-shot
 * "pay a meta-address the payee has never seen" confidential flow is therefore
 * impossible.
 *
 * The escape is that nothing in DKSAP requires the PAYER to pick the ephemeral
 * key. So the payee picks `R` itself, derives its own one-time address,
 * configures a confidential account for each (signing, as it must), and
 * registers the resulting `(stealthAddress, R, P)` triples here. The server
 * hands out exactly one per payment and never reuses one — which preserves the
 * per-payment unlinkability that stealth exists for, with zero round trips at
 * pay time.
 *
 * LOSING A RECORD LOSES FUNDS. `R` is the only way the payee can re-derive the
 * one-time key `kSpend + H(kView·R)` — without it the money in that slot cannot
 * be located, let alone spent. So this book is durable, encrypted, `failClosed`,
 * and it stays loaded even when the feature flag is off, exactly like
 * `InboundAnnouncementBook`.
 *
 * Convention note: this is deliberately a sibling of `InboundAnnouncementBook`
 * (generation CAS, typed conflict error, forgiving versioned migration,
 * ledger-supplied `accountId`, multi-guard reap) rather than of
 * `DepositAddressBook`, whose CAS is status-only. A status-only CAS is safe only
 * while every mutation changes the status, and slot reservation deliberately
 * does not always do that.
 */

export type ConfidentialSlotStatus =
  /** Configured on-chain by the payee and available to hand out. */
  | "available"
  /** Handed to exactly one payment; not yet known to have been paid. */
  | "reserved"
  /** A payment settled into it. */
  | "consumed"
  /** The payee moved the value out. */
  | "swept"
  /** Rent reclaimed via EmptyAccount + CloseAccount. Terminal, reapable. */
  | "closed";

/**
 * A slot we could not prove is safe to reuse or reclaim. Sticky and never
 * reaped, on the same reasoning as `InboundAnnouncementAnomaly`: the record is
 * the only evidence an operator has.
 */
export type ConfidentialSlotAnomaly =
  /** Reserved, then the payment neither settled nor released. */
  | "reservation-orphaned"
  /** Observed funded while still `available` — someone paid an unissued slot. */
  | "unexpected-credit";

export interface ConfidentialSlotRecord {
  id: string;
  /** From `privateLedger.accountReference()`. Never derived here — see the class doc. */
  accountId: string;
  network: string;
  caip2: string;
  /** Token-2022 mint carrying the ConfidentialTransferMint extension. */
  mint: string;
  /** The one-time address owning the configured confidential account. */
  stealthAddress: string;
  /** THE announcement `R`. Losing this loses the funds in this slot. */
  ephemeralPubKey: string;
  /** The destination ElGamal key the payer encrypts to. Branded, never an address. */
  encryptionPubKey: ConfidentialEncryptionPubKey;
  /** The configured confidential token account (an ATA of `stealthAddress`). */
  tokenAccount: string;
  status: ConfidentialSlotStatus;
  /**
   * Bumped by the book on every mutation. Two callers holding clones of the
   * same `available` slot would otherwise both hand it out.
   */
  generation: number;
  anomaly: ConfidentialSlotAnomaly | null;
  /** The payment holding this slot; the reservation's idempotency key. */
  reservedFor: string | null;
  createdAt: number;
  reservedAt: number | null;
  consumedAt: number | null;
  sweptAt: number | null;
  closedAt: number | null;
}

export interface ConfidentialSlotBookFile {
  version: 1;
  records: ConfidentialSlotRecord[];
}

export type NewConfidentialSlot = Pick<
  ConfidentialSlotRecord,
  | "accountId" | "network" | "caip2" | "mint"
  | "stealthAddress" | "ephemeralPubKey" | "encryptionPubKey" | "tokenAccount"
>;

/**
 * Raised only when a CAS loses, so a caller can tell "somebody else got there
 * first" (retryable, benign) from "this record is broken" (not retryable).
 */
export class ConfidentialSlotConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfidentialSlotConflictError";
  }
}

export interface ConfidentialSlotBookOptions {
  encryptionKey: string;
  /** Delay after `closed` before a record may be reaped. */
  retentionMs: number;
}

const EMPTY_BOOK = (): ConfidentialSlotBookFile => ({ version: 1, records: [] });
const ACCOUNT_ID = /^acct_[a-f0-9]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Forgiving, in place, never drops a record. A book that throws on its own next
 * version is an outage; fields get added, and losing a slot record loses funds.
 */
const migrateRecord = (record: ConfidentialSlotRecord): boolean => {
  const raw = record as unknown as Record<string, unknown>;
  let changed = false;
  if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || (raw.generation as number) < 0) {
    raw.generation = 0;
    changed = true;
  }
  if (raw.anomaly !== "reservation-orphaned" && raw.anomaly !== "unexpected-credit" && raw.anomaly !== null) {
    raw.anomaly = null;
    changed = true;
  }
  return changed;
};

export class ConfidentialSlotBook {
  private readonly file: EncryptedJsonFile<ConfidentialSlotBookFile>;
  private state = EMPTY_BOOK();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, private readonly options: ConfidentialSlotBookOptions) {
    if (!options.encryptionKey) {
      throw new Error("Confidential slot book requires an encryption key");
    }
    if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) {
      throw new Error("Confidential slot retention must be a non-negative duration");
    }
    this.file = new EncryptedJsonFile(filePath, options.encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_BOOK());
    if (stored.version !== 1 || !Array.isArray(stored.records)) {
      throw new Error("Confidential slot book file is invalid");
    }
    let migrated = false;
    for (const record of stored.records) if (migrateRecord(record)) migrated = true;
    this.state = stored;
    for (const record of this.state.records) this.assertRecord(record);
    if (migrated || this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  /**
   * Register slots the payee has already configured on-chain.
   *
   * MUST complete before any of them can be handed out. Idempotent on
   * `(network, stealthAddress)`, and a duplicate returns the existing record
   * rather than throwing, so a retried provisioning batch is a silent success.
   */
  addMany(entries: NewConfidentialSlot[]): Promise<ConfidentialSlotRecord[]> {
    return this.serialize(async () => {
      const added: ConfidentialSlotRecord[] = [];
      let dirty = false;
      for (const entry of entries) {
        const existing = this.state.records.find((candidate) =>
          candidate.network === entry.network
          && candidate.stealthAddress === entry.stealthAddress);
        if (existing) {
          added.push(structuredClone(existing));
          continue;
        }
        const record: ConfidentialSlotRecord = {
          ...structuredClone(entry),
          id: `slot-${randomBytes(12).toString("hex")}`,
          status: "available",
          generation: 0,
          anomaly: null,
          reservedFor: null,
          createdAt: Date.now(),
          reservedAt: null,
          consumedAt: null,
          sweptAt: null,
          closedAt: null,
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

  /**
   * Take exactly one available slot for a payment, durably, before it is
   * disclosed to anyone.
   *
   * This is the double-issue guard, and it is why the whole selection happens
   * INSIDE the write lock. The tempting shape — read an available slot, then
   * reserve it — is unsafe: reads are unserialized and return clones, so two
   * callers can pick the same slot and both believe they own it. Handing one
   * slot to two payments means the second payment lands in an account the first
   * payer can decrypt.
   *
   * Idempotent on `reservedFor`: a retried request gets its own slot back
   * rather than burning a second one.
   */
  reserve(reservedFor: string, network: string, now = Date.now()): Promise<ConfidentialSlotRecord | undefined> {
    return this.serialize(async () => {
      const already = this.state.records.find((record) =>
        record.reservedFor === reservedFor && record.network === network);
      if (already) return structuredClone(already);
      const slot = this.state.records.find((record) =>
        record.status === "available" && record.network === network && record.anomaly === null);
      if (!slot) return undefined; // pool exhausted — a liveness condition, not an error
      slot.status = "reserved";
      slot.reservedFor = reservedFor;
      slot.reservedAt = now;
      slot.generation += 1;
      this.assertRecord(slot);
      await this.persist();
      return structuredClone(slot);
    });
  }

  /**
   * Generation-fenced transition. The book owns the bump, applied AFTER the
   * mutator, so a mutator cannot forge it.
   */
  transition(
    id: string,
    expectedFrom: ConfidentialSlotStatus,
    expectedGeneration: number,
    mutate: (record: ConfidentialSlotRecord) => void,
  ): Promise<ConfidentialSlotRecord> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record) throw new Error("Confidential slot record not found");
      if (record.status !== expectedFrom) {
        throw new ConfidentialSlotConflictError(
          `Confidential slot CAS failed: expected ${expectedFrom}, got ${record.status}`,
        );
      }
      if (record.generation !== expectedGeneration) {
        throw new ConfidentialSlotConflictError(
          `Confidential slot generation CAS failed: expected ${expectedGeneration}, got ${record.generation}`,
        );
      }
      // Captured BEFORE the mutator and ASSIGNED after, not incremented after.
      // `generation += 1` would build on whatever the mutator left behind, so a
      // mutator that writes `generation = 999` yields 1000 and the fence is
      // forgeable by the very code it is meant to fence.
      const nextGeneration = record.generation + 1;
      mutate(record);
      record.generation = nextGeneration;
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  /**
   * Return an unused reservation to the pool. A reservation whose payment never
   * settled is released rather than stranded, so a failed payment costs no rent.
   * Never releases a slot that already took value.
   */
  release(id: string, expectedGeneration: number): Promise<ConfidentialSlotRecord | undefined> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record || record.status !== "reserved") return undefined; // double-release is a no-op
      if (record.generation !== expectedGeneration) {
        throw new ConfidentialSlotConflictError("Confidential slot generation CAS failed on release");
      }
      record.status = "available";
      record.reservedFor = null;
      record.reservedAt = null;
      record.generation += 1;
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Sticky, never reaped afterwards — the record is the only evidence. */
  flagAnomaly(id: string, anomaly: ConfidentialSlotAnomaly): Promise<void> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record || record.anomaly !== null) return;
      record.anomaly = anomaly;
      record.generation += 1;
      console.warn(`CONFIDENTIAL_SLOT_ANOMALY ${anomaly} id=${record.id} network=${record.network}`);
      await this.persist();
    });
  }

  /**
   * Reap only what provably cannot hold value or evidence: `closed` past
   * retention. Everything else is retained.
   *
   * `available` is never reaped even when ancient — it is configured on-chain
   * and holds rent, and dropping it loses both the rent and the `R` needed to
   * reclaim it. Anomalous records are kept indefinitely. This matters more than
   * usual here because `EncryptedJsonFile` rewrites the WHOLE file per write,
   * so an unreaped book makes every subsequent write more expensive.
   */
  reap(now = Date.now()): Promise<number> {
    return this.serialize(async () => {
      const before = this.state.records.length;
      this.state.records = this.state.records.filter((record) => {
        if (record.anomaly !== null) return true;
        if (record.status !== "closed") return true;
        return record.closedAt === null || record.closedAt + this.options.retentionMs > now;
      });
      const removed = before - this.state.records.length;
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  byId(id: string): ConfidentialSlotRecord | undefined {
    const record = this.state.records.find((entry) => entry.id === id);
    return record ? structuredClone(record) : undefined;
  }

  /** Pool depth per network — the number an operator must watch. */
  availableCount(network: string): number {
    return this.state.records.filter((record) =>
      record.status === "available" && record.network === network && record.anomaly === null).length;
  }

  all(): ConfidentialSlotRecord[] {
    return structuredClone(this.state.records);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
  }

  private async persist(): Promise<void> {
    await this.file.write(this.state);
  }

  private assertRecord(record: ConfidentialSlotRecord) {
    if (!record.id.startsWith("slot-")
      || !ACCOUNT_ID.test(record.accountId)
      || !record.network
      || !BASE58.test(record.mint)
      || !BASE58.test(record.stealthAddress)
      || !BASE58.test(record.ephemeralPubKey)
      || !BASE58.test(record.encryptionPubKey)
      || !BASE58.test(record.tokenAccount)) {
      throw new Error("Confidential slot record is invalid");
    }
    if (!Number.isInteger(record.generation) || record.generation < 0) {
      throw new Error("Confidential slot generation must be a non-negative integer");
    }
    // A reserved slot without an owner is unreleasable and unattributable.
    if (record.status === "reserved" && !record.reservedFor) {
      throw new Error("A reserved confidential slot must record who holds it");
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Confidential slot book is closed"));
    const execute = async () => {
      const previous = structuredClone(this.state);
      try {
        return await operation();
      } catch (error) {
        this.state = previous; // memory never diverges from a failed persist
        throw error;
      }
    };
    const result = this.writeQueue.then(execute, execute);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
