import { createHash } from "node:crypto";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

export interface ReconciliationEntry {
  recordId: string;
  reason: "zero-without-receipt" | "overpayment" | "late-uncredited" | "key-mismatch";
  network: string;
  stealthAddress: string;
  observedAmountAtomic: string;
  expectedAmountAtomic: string;
  at: number;
}

interface ReconciliationFile {
  version: 1;
  entries: ReconciliationEntry[];
}

const EMPTY_QUEUE = (): ReconciliationFile => ({ version: 1, entries: [] });

export class DepositReconciliationQueue {
  private readonly file: EncryptedJsonFile<ReconciliationFile>;
  private readonly encryptionKeyBuffer: Buffer;
  private state = EMPTY_QUEUE();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, encryptionKey: string) {
    if (!encryptionKey.trim()) {
      throw new Error("Deposit reconciliation queue requires PX402_DATA_ENCRYPTION_KEY");
    }
    this.file = new EncryptedJsonFile(filePath, encryptionKey, {
      failClosed: true,
      durable: true,
    });
    this.encryptionKeyBuffer = createHash("sha256").update(encryptionKey).digest();
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_QUEUE());
    if (stored.version !== 1 || !Array.isArray(stored.entries)) {
      throw new Error("Deposit reconciliation queue file is invalid");
    }
    this.state = stored;
    if (this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  enqueue(entry: ReconciliationEntry): Promise<void> {
    return this.serialize(async () => {
      if (!this.state.entries.some((existing) =>
        existing.recordId === entry.recordId && existing.reason === entry.reason)) {
        this.state.entries.push(structuredClone(entry));
        await this.persist();
      }
    });
  }

  list(): readonly ReconciliationEntry[] {
    return this.state.entries.map((entry) => structuredClone(entry));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
    this.encryptionKeyBuffer.fill(0);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Deposit reconciliation queue is closed"));
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }
}
