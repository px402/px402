import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface EncryptedPayload {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedJsonFile<T> {
  private migratedPlaintext = false;

  constructor(
    private readonly filePath: string,
    private readonly keyMaterial?: string,
    private readonly options: { failClosed?: boolean; durable?: boolean } = {}
  ) {}

  get encrypted() {
    return Boolean(this.keyMaterial);
  }

  async read(fallback: T): Promise<T> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as EncryptedPayload | T;
      if (!this.keyMaterial) return isEncryptedPayload(parsed) ? fallback : parsed as T;
      if (isEncryptedPayload(parsed)) return JSON.parse(this.decrypt(parsed)) as T;
      this.migratedPlaintext = true;
      return parsed as T;
    } catch (error) {
      if (this.options.failClosed && !isMissingFile(error)) throw error;
      await mkdir(dirname(this.filePath), { recursive: true });
      return fallback;
    }
  }

  async write(value: T) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = JSON.stringify(value, null, 2);
    const payload = this.keyMaterial ? JSON.stringify(this.encrypt(body), null, 2) : body;
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, payload, { mode: 0o600 });
    if (this.options.durable) {
      const temporary = await open(temporaryPath, "r+");
      try {
        await temporary.sync();
      } finally {
        await temporary.close();
      }
    }
    await rename(temporaryPath, this.filePath);
    if (this.options.durable) {
      const directory = await open(dirname(this.filePath), "r");
      try {
        try {
          await directory.sync();
        } catch (error) {
          // Windows does not expose directory fsync. The file itself was
          // synchronously flushed above; POSIX still receives the directory
          // durability barrier.
          if (!isUnsupportedDirectorySync(error)) throw error;
        }
      } finally {
        await directory.close();
      }
    }
    this.migratedPlaintext = false;
  }

  shouldRewriteEncrypted() {
    return this.encrypted && this.migratedPlaintext;
  }

  private encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  private decrypt(payload: EncryptedPayload) {
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  }

  private key() {
    if (!this.keyMaterial) throw new Error("Missing encryption key");
    const value = this.keyMaterial.trim();
    if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, "hex");
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      // fall through to hash derivation
    }
    return createHash("sha256").update(value).digest();
  }
}

const isEncryptedPayload = (value: unknown): value is EncryptedPayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.algorithm === "aes-256-gcm";
};

const isMissingFile = (error: unknown) => (
  typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
);

const isUnsupportedDirectorySync = (error: unknown) => (
  process.platform === "win32"
  && typeof error === "object"
  && error !== null
  && "code" in error
  && ["EPERM", "EINVAL", "EBADF"].includes((error as { code?: string }).code ?? "")
);
