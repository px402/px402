import type {
  PendingIssuance,
  VoucherWallet,
} from "../shared/blindVoucherClient";
import type { BlindVoucher } from "../shared/blindVoucher";
import { EncryptedJsonFile } from "../server/storage/EncryptedJsonFile";
import { secp256k1 } from "@noble/curves/secp256k1";

interface VoucherWalletFile {
  version: 1;
  pending: PendingIssuance[];
  vouchers: BlindVoucher[];
}

const EMPTY_WALLET = (): VoucherWalletFile => ({
  version: 1,
  pending: [],
  vouchers: [],
});

/**
 * Encrypted reference wallet for Node agents.
 *
 * The wallet key must be separate from the server data-encryption key. Deleting
 * or corrupting this file permanently destroys the bearer vouchers' value.
 */
export class BlindVoucherWalletFile implements VoucherWallet {
  private readonly file: EncryptedJsonFile<VoucherWalletFile>;
  private state?: VoucherWalletFile;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, walletKey: string) {
    assertWalletKey(walletKey);
    this.file = new EncryptedJsonFile(filePath, walletKey, {
      failClosed: true,
      durable: true,
    });
  }

  async loadPending(): Promise<PendingIssuance[]> {
    await this.ensureLoaded();
    return structuredClone(this.state!.pending);
  }

  savePending(record: PendingIssuance): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      assertPending(record);
      const previous = structuredClone(this.state!);
      const existing = this.state!.pending.findIndex(
        (candidate) => candidate.fingerprint === record.fingerprint,
      );
      if (existing >= 0) {
        this.state!.pending[existing] = structuredClone(record);
      } else {
        this.state!.pending.push(structuredClone(record));
      }
      await this.persistOrRollback(previous);
    });
  }

  finalize(fingerprint: string, vouchers: BlindVoucher[]): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const pendingIndex = this.state!.pending.findIndex(
        (candidate) => candidate.fingerprint === fingerprint,
      );
      if (pendingIndex < 0) {
        const allPresent = vouchers.every((voucher) =>
          this.state!.vouchers.some((stored) => stored.id === voucher.id));
        if (allPresent) return;
        throw new Error("Pending blind voucher issuance was not found");
      }
      for (const voucher of vouchers) assertVoucher(voucher);
      const previous = structuredClone(this.state!);
      this.state!.pending.splice(pendingIndex, 1);
      const ids = new Set(this.state!.vouchers.map((voucher) => voucher.id));
      for (const voucher of vouchers) {
        if (ids.has(voucher.id)) throw new Error("Duplicate blind voucher wallet id");
        ids.add(voucher.id);
        this.state!.vouchers.push(structuredClone(voucher));
      }
      await this.persistOrRollback(previous);
    });
  }

  async loadVouchers(): Promise<BlindVoucher[]> {
    await this.ensureLoaded();
    return structuredClone(this.state!.vouchers);
  }

  removeVouchers(ids: string[]): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
        throw new Error("Blind voucher wallet ids are invalid");
      }
      const previous = structuredClone(this.state!);
      const remove = new Set(ids);
      this.state!.vouchers = this.state!.vouchers.filter(
        (voucher) => !remove.has(voucher.id),
      );
      await this.persistOrRollback(previous);
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    const state = await this.file.read(EMPTY_WALLET());
    assertWalletState(state);
    this.state = state;
    if (this.file.shouldRewriteEncrypted()) await this.file.write(state);
  }

  private async persistOrRollback(previous: VoucherWalletFile): Promise<void> {
    try {
      await this.file.write(this.state!);
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

const assertWalletState: (value: unknown) => asserts value is VoucherWalletFile = (value) => {
  if (!isRecord(value)
    || value.version !== 1
    || !Array.isArray(value.pending)
    || !Array.isArray(value.vouchers)) {
    throw new Error("Blind voucher wallet file is invalid");
  }
  for (const pending of value.pending) assertPending(pending);
  for (const voucher of value.vouchers) assertVoucher(voucher);
};

const assertPending: (value: unknown) => asserts value is PendingIssuance = (value) => {
  if (!isRecord(value)
    || !isHash(value.fingerprint)
    || typeof value.asset !== "string"
    || !isHash(value.keysetId)
    || typeof value.createdAt !== "number"
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || !Array.isArray(value.contexts)
    || value.contexts.length === 0) {
    throw new Error("Pending blind voucher issuance is invalid");
  }
  for (const context of value.contexts) {
    if (!isRecord(context)
      || !isAtomic(context.denomAtomic)
      || !isBytes32(context.secret)
      || !isScalar(context.r)
      || !isCompressedPoint(context.B_)) {
      throw new Error("Pending blind voucher context is invalid");
    }
  }
};

const assertVoucher: (value: unknown) => asserts value is BlindVoucher = (value) => {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !value.id
    || typeof value.asset !== "string"
    || !isHash(value.keysetId)
    || !isAtomic(value.denomAtomic)
    || !isBytes32(value.secret)
    || !isCompressedPoint(value.C)
    || !isScalar(value.r)
    || !isRecord(value.dleq)
    || !isScalar(value.dleq.e)
    || !isScalar(value.dleq.s)) {
    throw new Error("Stored blind voucher is invalid");
  }
};

const assertWalletKey = (key: string) => {
  const value = key.trim();
  const validHex = /^[a-fA-F0-9]{64}$/.test(value);
  let validBase64 = false;
  try {
    validBase64 = Buffer.from(value, "base64").length === 32
      && Buffer.from(value, "base64").toString("base64").replace(/=+$/, "")
        === value.replace(/=+$/, "");
  } catch {
    validBase64 = false;
  }
  if (!validHex && !validBase64) {
    throw new Error("Blind voucher wallet key must be a separate 32-byte hex or base64 key");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHash = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

const isBytes32 = isHash;

const isCompressedPoint = (value: unknown) =>
  typeof value === "string" && /^0x0[23][0-9a-fA-F]{64}$/.test(value);

const isScalar = (value: unknown) => {
  if (!isBytes32(value)) return false;
  const scalar = BigInt(value as string);
  return scalar > 0n && scalar < secp256k1.CURVE.n;
};

const isAtomic = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value);
