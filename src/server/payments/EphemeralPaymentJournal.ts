import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface EpochHandle {
  id: string;
  key: Buffer;
}

interface EncryptedJournalRecord {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface PrivatePaymentJournalEntry {
  source: "deposit" | "voucher" | "payout";
  asset: string;
  payer?: string;
  payee: string;
  amountAtomic: string;
  resourceHash?: string;
  authorizationHash: string;
  commitment: string;
  salt: string;
  acceptedAt: number;
}

export class EphemeralPaymentJournal {
  private readonly activeByAsset = new Map<string, EpochHandle>();
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly rootDirectory: string,
    private readonly options: { requireMemoryBacked?: boolean } = {},
  ) {}

  async assertReady(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    if (!this.options.requireMemoryBacked || process.platform !== "linux") return;
    const filesystem = await statfs(this.rootDirectory);
    if (Number(filesystem.type) !== 0x01021994) {
      throw new Error("Private payment journal must be mounted on tmpfs");
    }
  }

  async append(asset: string, entry: PrivatePaymentJournalEntry): Promise<string> {
    const epoch = await this.ensureEpoch(asset);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", epoch.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entry), "utf8"),
      cipher.final(),
    ]);
    const record: EncryptedJournalRecord = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };

    await appendFile(this.dataPath(epoch.id), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return epoch.id;
  }

  seal(asset: string): string | undefined {
    const normalizedAsset = asset.toLowerCase();
    const epoch = this.activeByAsset.get(normalizedAsset);
    this.activeByAsset.delete(normalizedAsset);
    return epoch?.id;
  }

  async read(epochId: string): Promise<PrivatePaymentJournalEntry[]> {
    this.assertEpochId(epochId);
    const key = this.keys.get(epochId) ?? await readFile(this.keyPath(epochId));
    const serialized = await readFile(this.dataPath(epochId), "utf8");
    if (!serialized.trim()) return [];

    return serialized.trim().split("\n").map((line) => {
      const record = JSON.parse(line) as EncryptedJournalRecord;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as PrivatePaymentJournalEntry;
    });
  }

  async burn(epochIds: Iterable<string>): Promise<number> {
    let burned = 0;
    for (const epochId of new Set(epochIds)) {
      if (epochId.startsWith("legacy-")) continue;
      this.assertEpochId(epochId);

      for (const [asset, epoch] of this.activeByAsset) {
        if (epoch.id === epochId) this.activeByAsset.delete(asset);
      }
      const key = this.keys.get(epochId);
      if (key) key.fill(0);
      this.keys.delete(epochId);

      const results = await Promise.all([
        rm(this.keyPath(epochId), { force: true }),
        rm(this.dataPath(epochId), { force: true }),
      ]);
      void results;
      burned += 1;
    }
    return burned;
  }

  async burnOrphans(referencedEpochIds: ReadonlySet<string>): Promise<number> {
    await this.assertReady();
    const files = await readdir(this.rootDirectory);
    const discovered = new Set(
      files
        .map((file) => file.match(/^([a-f0-9]{32})\.(?:key|jsonl)$/)?.[1])
        .filter((value): value is string => Boolean(value)),
    );
    return this.burn([...discovered].filter((id) => !referencedEpochIds.has(id)));
  }

  close(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.activeByAsset.clear();
  }

  private async ensureEpoch(asset: string): Promise<EpochHandle> {
    const normalizedAsset = asset.toLowerCase();
    const existing = this.activeByAsset.get(normalizedAsset);
    if (existing) return existing;

    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const epoch: EpochHandle = {
      id: randomBytes(16).toString("hex"),
      key: randomBytes(32),
    };
    await writeFile(this.keyPath(epoch.id), epoch.key, {
      flag: "wx",
      mode: 0o600,
    });
    this.keys.set(epoch.id, epoch.key);
    this.activeByAsset.set(normalizedAsset, epoch);
    return epoch;
  }

  private keyPath(epochId: string): string {
    return join(this.rootDirectory, `${epochId}.key`);
  }

  private dataPath(epochId: string): string {
    return join(this.rootDirectory, `${epochId}.jsonl`);
  }

  private assertEpochId(epochId: string): void {
    if (!/^[a-f0-9]{32}$/.test(epochId)) {
      throw new Error("Invalid payment journal epoch identifier");
    }
  }
}
