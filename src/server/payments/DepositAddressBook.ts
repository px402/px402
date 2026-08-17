import { createHash, createHmac, randomBytes } from "node:crypto";
import { privateLedgerAssetKey } from "../../shared/privateLedger";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

export type DepositAddressStatus =
  | "awaiting-payment"
  | "proof-verified"
  | "credited"
  | "sweep-submitted"
  | "swept"
  | "reserve-mismatch"
  | "dormant";

export interface DepositAddressRecord {
  id: string;
  intentId: string;
  accountId: string;
  network: string;
  caip2: string;
  tokenAddress: string;
  keyVersion: string;
  derivationIndex: number;
  stealthAddress: string;
  ephemeralPubKey: string;
  fromAddress: string;
  expectedAmountAtomic: string;
  observedAmountAtomic: string | null;
  overpaymentAtomic: string | null;
  creditValidBefore: number;
  proofId: string | null;
  proofTxHash: string | null;
  proofTransferIndex: number | null;
  status: DepositAddressStatus;
  attemptCount: number;
  sweepNonce: string | null;
  sweepTxHash: string | null;
  nextRetryAt: number | null;
  quarantineReason: string | null;
  createdAt: number;
  proofVerifiedAt: number | null;
  creditedAt: number | null;
  sweepSubmittedAt: number | null;
  sweptAt: number | null;
}

export interface DepositNonceTombstone {
  key: string;
  expiresAt: number;
}

export interface DepositAddressBookFile {
  version: 1;
  records: DepositAddressRecord[];
  nextIndexByNetwork: Record<string, number>;
  nonceTombstones: DepositNonceTombstone[];
}

export interface DepositAddressBookOptions {
  retentionMs: number;
  encryptionKey: string;
}

type NewDepositAddressRecord = Omit<
  DepositAddressRecord,
  | "id"
  | "status"
  | "createdAt"
  | "attemptCount"
  | "observedAmountAtomic"
  | "overpaymentAtomic"
  | "proofId"
  | "proofTxHash"
  | "proofTransferIndex"
  | "sweepNonce"
  | "sweepTxHash"
  | "nextRetryAt"
  | "quarantineReason"
  | "proofVerifiedAt"
  | "creditedAt"
  | "sweepSubmittedAt"
  | "sweptAt"
>;

const EMPTY_BOOK = (): DepositAddressBookFile => ({
  version: 1,
  records: [],
  nextIndexByNetwork: {},
  nonceTombstones: [],
});

export class DepositAddressBook {
  private readonly file: EncryptedJsonFile<DepositAddressBookFile>;
  private readonly accountKey: Buffer;
  private readonly encryptionKeyBuffer: Buffer;
  private state = EMPTY_BOOK();
  private writeQueue: Promise<void> = Promise.resolve();
  private deferredWriteError: unknown;
  private closed = false;

  constructor(
    filePath: string,
    private readonly options: DepositAddressBookOptions,
  ) {
    if (!options.encryptionKey.trim()) {
      throw new Error("Deposit address book requires PX402_DATA_ENCRYPTION_KEY");
    }
    if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) {
      throw new Error("Deposit address retention must be a non-negative duration");
    }
    this.file = new EncryptedJsonFile(filePath, options.encryptionKey, {
      failClosed: true,
      durable: true,
    });
    this.encryptionKeyBuffer = createHash("sha256").update(options.encryptionKey).digest();
    this.accountKey = createHash("sha256")
      .update("px402-private-ledger/account-index/v2\0")
      .update(options.encryptionKey)
      .digest();
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_BOOK());
    if (stored.version !== 1
      || !Array.isArray(stored.records)
      || !stored.nextIndexByNetwork
      || !Array.isArray(stored.nonceTombstones)) {
      throw new Error("Deposit address book file is invalid");
    }
    this.state = stored;
    this.assertState();
    if (this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  accountId(agentId: string): string {
    return `acct_${createHmac("sha256", this.accountKey).update(agentId).digest("hex")}`;
  }

  nextIndex(network: string): Promise<number> {
    return this.serialize(async () => {
      const normalized = network.toLowerCase();
      const next = this.state.nextIndexByNetwork[normalized] ?? 0;
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error(`Invalid deposit derivation counter for ${normalized}`);
      }
      this.state.nextIndexByNetwork[normalized] = next + 1;
      await this.persist();
      return next;
    });
  }

  add(record: NewDepositAddressRecord): Promise<DepositAddressRecord> {
    return this.serialize(async () => {
      if (this.state.records.some((entry) => entry.intentId === record.intentId)) {
        throw new Error("Deposit intent already has a durable address record");
      }
      const next: DepositAddressRecord = {
        ...structuredClone(record),
        id: `depaddr-${randomBytes(12).toString("hex")}`,
        status: "awaiting-payment",
        createdAt: Date.now(),
        attemptCount: 0,
        observedAmountAtomic: null,
        overpaymentAtomic: null,
        proofId: null,
        proofTxHash: null,
        proofTransferIndex: null,
        sweepNonce: null,
        sweepTxHash: null,
        nextRetryAt: null,
        quarantineReason: null,
        proofVerifiedAt: null,
        creditedAt: null,
        sweepSubmittedAt: null,
        sweptAt: null,
      };
      this.state.records.push(next);
      await this.persist();
      return structuredClone(next);
    });
  }

  byIntentId(intentId: string): DepositAddressRecord | undefined {
    const record = this.state.records.find((entry) => entry.intentId === intentId);
    return record ? structuredClone(record) : undefined;
  }

  byId(id: string): DepositAddressRecord | undefined {
    const record = this.state.records.find((entry) => entry.id === id);
    return record ? structuredClone(record) : undefined;
  }

  transition(
    id: string,
    expectedFrom: DepositAddressStatus,
    mutate: (record: DepositAddressRecord) => void,
  ): Promise<DepositAddressRecord> {
    return this.serialize(async () => {
      const record = this.state.records.find((entry) => entry.id === id);
      if (!record) throw new Error("Deposit address record not found");
      if (record.status !== expectedFrom) {
        throw new Error(`Deposit address CAS failed: expected ${expectedFrom}, got ${record.status}`);
      }
      mutate(record);
      this.assertRecord(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  consolidatable(
    minAgeMs: number,
    limit: number,
    now = Date.now(),
  ): DepositAddressRecord[] {
    const selected = this.state.records
      .filter((record) => record.status === "credited"
        && record.creditedAt !== null
        && record.creditedAt + minAgeMs <= now
        && (record.nextRetryAt === null || record.nextRetryAt <= now))
      .sort((left, right) => (left.creditedAt ?? 0) - (right.creditedAt ?? 0))
      .slice(0, boundedLimit(limit))
      .map((record) => structuredClone(record));
    return shuffle(selected);
  }

  resumableSubmitted(limit: number): DepositAddressRecord[] {
    const now = Date.now();
    return this.state.records
      .filter((record) => record.status === "sweep-submitted"
        && (record.nextRetryAt === null || record.nextRetryAt <= now))
      .sort((left, right) => (left.sweepSubmittedAt ?? 0) - (right.sweepSubmittedAt ?? 0))
      .slice(0, boundedLimit(limit))
      .map((record) => structuredClone(record));
  }

  reverifiable(limit: number): DepositAddressRecord[] {
    return this.state.records
      .filter((record) => record.status === "proof-verified")
      .sort((left, right) => (left.proofVerifiedAt ?? 0) - (right.proofVerifiedAt ?? 0))
      .slice(0, boundedLimit(limit))
      .map((record) => structuredClone(record));
  }

  unpaidStale(
    unpaidGraceMs: number,
    limit: number,
    now = Date.now(),
  ): DepositAddressRecord[] {
    return this.state.records
      .filter((record) => (record.status === "awaiting-payment" || record.status === "dormant")
        && record.createdAt + unpaidGraceMs <= now
        && (record.nextRetryAt === null || record.nextRetryAt <= now))
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, boundedLimit(limit))
      .map((record) => structuredClone(record));
  }

  reapSwept(now = Date.now()): Promise<number> {
    return this.serialize(async () => {
      const before = this.state.records.length;
      this.state.records = this.state.records.filter((record) =>
        record.status !== "swept"
        || record.sweptAt === null
        || record.sweptAt + this.options.retentionMs > now);
      const removed = before - this.state.records.length;
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  async toDormant(id: string): Promise<void> {
    const record = this.byId(id);
    if (!record) throw new Error("Deposit address record not found");
    if (record.status === "dormant") return;
    await this.transition(id, "awaiting-payment", (current) => {
      current.status = "dormant";
      current.nextRetryAt = null;
    });
  }

  consumeNonce(key: string, expiresAt: number): void {
    if (!key || !Number.isFinite(expiresAt)) throw new Error("Invalid deposit nonce tombstone");
    const now = Date.now();
    this.state.nonceTombstones = this.state.nonceTombstones.filter(
      (entry) => entry.expiresAt > now,
    );
    if (this.state.nonceTombstones.some((entry) => entry.key === key)) {
      throw new Error("Replayed agent intent nonce rejected");
    }
    const previous = structuredClone(this.state);
    this.state.nonceTombstones.push({ key, expiresAt });
    this.writeQueue = this.writeQueue.then(async () => {
      await this.persist();
    }).catch((error) => {
      this.state = previous;
      this.deferredWriteError = error;
    });
  }

  reserveRecordsForAsset(assetKey: string): DepositAddressRecord[] {
    const normalized = assetKey.toLowerCase();
    return this.state.records
      .filter((record) =>
        (record.status === "credited" || record.status === "sweep-submitted")
        && privateLedgerAssetKey(record.network, record.tokenAddress) === normalized)
      .map((record) => structuredClone(record));
  }

  all(): readonly DepositAddressRecord[] {
    return this.state.records.map((record) => structuredClone(record));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
    this.accountKey.fill(0);
    this.encryptionKeyBuffer.fill(0);
    if (this.deferredWriteError) throw this.deferredWriteError;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Deposit address book is closed"));
    const execute = async () => {
      if (this.deferredWriteError) throw this.deferredWriteError;
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

  private assertState() {
    for (const record of this.state.records) this.assertRecord(record);
    for (const [network, index] of Object.entries(this.state.nextIndexByNetwork)) {
      if (!network || !Number.isSafeInteger(index) || index < 0) {
        throw new Error("Deposit address book contains an invalid derivation counter");
      }
    }
  }

  private assertRecord(record: DepositAddressRecord) {
    if (!record.id.startsWith("depaddr-")
      || !/^acct_[a-f0-9]{64}$/.test(record.accountId)
      || !Number.isSafeInteger(record.derivationIndex)
      || record.derivationIndex < 0
      || BigInt(record.expectedAmountAtomic) <= 0n) {
      throw new Error("Deposit address record is invalid");
    }
  }
}

const boundedLimit = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Deposit address query limit must be an integer >= 1");
  }
  return limit;
};

const shuffle = <T>(values: T[]) => {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
};
