import { existsSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  concat,
  getBytes,
  hexlify,
  sha256,
  toUtf8Bytes,
} from "ethers";
import {
  computeKeysetId,
  hashManifestEntry,
  nullifierOf,
  proveDleq,
  signBlinded,
  sumAtomic,
  verifyDleq,
  verifyManifestEntry,
  verifyRedeemProof,
  type BlindSignature,
  type BlindVoucherOutput,
  type KeysetDenominationPub,
  type ManifestCheckpoint,
  type ManifestEntry,
  type SignedManifestEntry,
} from "../../shared/blindVoucher";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

export interface MintDenominationKey {
  denomAtomic: string;
  k: string;
  K: string;
}

export interface MintKeyset {
  keysetId: string;
  asset: string;
  epoch: number;
  status: "active" | "retired" | "frozen";
  activatesAt: number;
  retiredAt?: number;
  redeemUntil: number | null;
  denominations: MintDenominationKey[];
}

export interface PublicKeyset {
  keysetId: string;
  asset: string;
  epoch: number;
  status: MintKeyset["status"];
  activatesAt: number;
  retiredAt?: number;
  redeemUntil: number | null;
  denominations: KeysetDenominationPub[];
}

export interface BlindVoucherMintOptions {
  keysetFilePath: string;
  nullifierFilePath: string;
  encryptionKey: string;
  mintIdentityKey: string;
  denominationsAtomic: readonly string[];
  keysetGraceMs: number;
  maxOutputsPerRequest: number;
  maxProofsPerRequest: number;
  assets: readonly string[];
}

export interface MintSignResult {
  keysetId: string;
  signatures: BlindSignature[];
}

interface KeysetFile {
  version: 1;
  mintIdentityKeyFingerprint: string;
  manifestByAsset: Record<string, SignedManifestEntry[]>;
  keysets: MintKeyset[];
}

interface NullifierFile {
  version: 1;
  spent: Record<string, Record<string, string>>;
}

const EMPTY_KEYSETS = (fingerprint: string): KeysetFile => ({
  version: 1,
  mintIdentityKeyFingerprint: fingerprint,
  manifestByAsset: {},
  keysets: [],
});

const EMPTY_NULLIFIERS = (): NullifierFile => ({
  version: 1,
  spent: {},
});

export class BlindVoucherMint {
  private readonly keysetFile: EncryptedJsonFile<KeysetFile>;
  private readonly nullifierFile: EncryptedJsonFile<NullifierFile>;
  private readonly identityKey: Uint8Array;
  private readonly identityPubKey: string;
  private readonly identityFingerprint: string;
  private readonly denominationsAtomic: string[];
  private readonly assets: string[];
  private readonly maxOutputsPerRequest: number;
  private readonly maxProofsPerRequest: number;
  private readonly keysetFilePath: string;
  private readonly nullifierFilePath: string;
  private keysets: KeysetFile;
  private nullifiers: NullifierFile = EMPTY_NULLIFIERS();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(options: BlindVoucherMintOptions) {
    if (!options.encryptionKey.trim()) {
      throw new Error("Blind voucher mint requires PX402_DATA_ENCRYPTION_KEY");
    }
    this.identityKey = parseIdentityKey(options.mintIdentityKey);
    this.identityPubKey = hexlify(secp256k1.getPublicKey(this.identityKey, true));
    this.identityFingerprint = sha256(getBytes(this.identityPubKey));
    this.denominationsAtomic = canonicalDenominations(options.denominationsAtomic);
    this.assets = [...new Set(options.assets)];
    if (this.assets.length === 0 || this.assets.some((asset) => !asset || !asset.includes(":"))) {
      throw new Error("Blind voucher mint assets are invalid");
    }
    if (!Number.isFinite(options.keysetGraceMs)
      || !Number.isSafeInteger(options.keysetGraceMs)
      || options.keysetGraceMs < 0) {
      throw new Error("Blind voucher keyset grace must be a finite non-negative duration");
    }
    assertPositiveLimit(options.maxOutputsPerRequest, "max outputs");
    assertPositiveLimit(options.maxProofsPerRequest, "max proofs");
    this.maxOutputsPerRequest = options.maxOutputsPerRequest;
    this.maxProofsPerRequest = options.maxProofsPerRequest;
    this.keysetFilePath = options.keysetFilePath;
    this.nullifierFilePath = options.nullifierFilePath;
    this.keysetFile = new EncryptedJsonFile(options.keysetFilePath, options.encryptionKey, {
      failClosed: true,
      durable: true,
    });
    this.nullifierFile = new EncryptedJsonFile(
      options.nullifierFilePath,
      options.encryptionKey,
      { failClosed: true, durable: true },
    );
    this.keysets = EMPTY_KEYSETS(this.identityFingerprint);
  }

  async load(): Promise<this> {
    const keysetsExist = existsSync(this.keysetFilePath);
    const nullifiersExist = existsSync(this.nullifierFilePath);
    if (keysetsExist !== nullifiersExist) {
      throw new Error("Blind voucher mint durable stores are incomplete");
    }
    const [keysets, nullifiers] = await Promise.all([
      this.keysetFile.read(EMPTY_KEYSETS(this.identityFingerprint)),
      this.nullifierFile.read(EMPTY_NULLIFIERS()),
    ]);
    assertKeysetFile(keysets, this.identityPubKey);
    assertNullifierFile(nullifiers);
    if (keysets.mintIdentityKeyFingerprint !== this.identityFingerprint) {
      throw new Error("Blind voucher mint identity key does not match durable state");
    }
    this.keysets = keysets;
    this.nullifiers = nullifiers;
    let changed = this.keysetFile.shouldRewriteEncrypted()
      || this.nullifierFile.shouldRewriteEncrypted();
    if (!keysetsExist) {
      for (const asset of this.assets) this.bootstrapKeyset(asset);
      changed = true;
    } else {
      for (const asset of this.assets) {
        const active = this.keysets.keysets.filter(
          (keyset) => keyset.asset === asset && keyset.status === "active",
        );
        if (active.length !== 1) {
          throw new Error(`Blind voucher mint requires exactly one active keyset for ${asset}`);
        }
      }
    }
    if (changed) {
      await this.keysetFile.write(this.keysets);
      await this.nullifierFile.write(this.nullifiers);
    }
    this.loaded = true;
    return this;
  }

  mintIdentityPubKey(): string {
    this.assertLoaded();
    return this.identityPubKey;
  }

  publicManifest(asset: string): SignedManifestEntry[] {
    this.assertLoaded();
    this.assertAsset(asset);
    return structuredClone(this.keysets.manifestByAsset[asset] ?? []);
  }

  checkpoint(asset: string): ManifestCheckpoint {
    this.assertLoaded();
    const manifest = this.keysets.manifestByAsset[asset];
    if (!manifest?.length) throw new Error(`Blind voucher manifest is missing for ${asset}`);
    const head = manifest[manifest.length - 1];
    const checkpoint: ManifestCheckpoint = {
      headSeq: head.entry.seq,
      headEntryHash: head.entryHash,
      signature: "",
    };
    checkpoint.signature = signHash(
      checkpointMessageHash(checkpoint.headSeq, checkpoint.headEntryHash),
      this.identityKey,
    );
    return checkpoint;
  }

  publicKeysets(asset: string): PublicKeyset[] {
    this.assertLoaded();
    this.assertAsset(asset);
    return this.keysets.keysets
      .filter((keyset) => keyset.asset === asset)
      .map(publicKeyset);
  }

  activeKeyset(asset: string): PublicKeyset | undefined {
    this.assertLoaded();
    const keyset = this.keysets.keysets.find(
      (candidate) => candidate.asset === asset && candidate.status === "active",
    );
    return keyset ? publicKeyset(keyset) : undefined;
  }

  sign(input: {
    asset: string;
    keysetId: string;
    outputs: BlindVoucherOutput[];
  }): MintSignResult {
    this.assertLoaded();
    if (input.outputs.length === 0 || input.outputs.length > this.maxOutputsPerRequest) {
      throw new Error("Blind voucher output limit exceeded");
    }
    const keyset = this.requireKeyset(input.asset, input.keysetId);
    if (keyset.status !== "active") throw new Error("Blind voucher keyset is not active");
    const signatures = input.outputs.map((output) => {
      const denomination = keyset.denominations.find(
        (candidate) => candidate.denomAtomic === output.denomAtomic,
      );
      if (!denomination) throw new Error("Blind voucher denomination is not in the active keyset");
      const C_ = signBlinded({ B_: output.B_, k: denomination.k });
      const dleq = proveDleq({
        B_: output.B_,
        C_,
        k: denomination.k,
        K: denomination.K,
      });
      if (!verifyDleq({ B_: output.B_, C_, K: denomination.K, dleq })) {
        throw new Error("Blind voucher mint DLEQ self-verification failed");
      }
      return { denomAtomic: output.denomAtomic, C_, dleq };
    });
    return { keysetId: keyset.keysetId, signatures };
  }

  verifyAndReserveNullifiers(input: {
    asset: string;
    keysetId: string;
    redeemKey: string;
    proofs: { denomAtomic: string; secret: string; C: string }[];
  }): Promise<{ valueAtomic: string; duplicate: boolean }> {
    return this.serialize(async () => {
      if (input.proofs.length === 0 || input.proofs.length > this.maxProofsPerRequest) {
        throw new Error("Blind voucher proof limit exceeded");
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(input.redeemKey)) {
        throw new Error("Blind voucher redeem key is invalid");
      }
      const keyset = this.requireKeyset(input.asset, input.keysetId);
      if (keyset.status === "frozen") throw new Error("Blind voucher keyset is frozen");
      const prepared = input.proofs.map((proof) => {
        const denomination = keyset.denominations.find(
          (candidate) => candidate.denomAtomic === proof.denomAtomic,
        );
        if (!denomination) throw new Error("Blind voucher denomination is not in the keyset");
        return {
          ...proof,
          denomination,
          nullifier: nullifierOf(proof.secret),
        };
      });
      const distinct = new Set(prepared.map((proof) => proof.nullifier));
      if (distinct.size !== prepared.length) throw new Error("duplicate voucher proof");
      for (const proof of prepared) {
        if (!verifyRedeemProof({
          secret: proof.secret,
          C: proof.C,
          k: proof.denomination.k,
        })) {
          throw new Error("invalid voucher proof");
        }
      }
      const valueAtomic = sumAtomic(prepared.map((proof) => proof.denomAtomic));
      const spent = this.nullifiers.spent[input.keysetId] ?? {};
      const existing = prepared.map((proof) => spent[proof.nullifier]);
      if (existing.every((redeemKey) => redeemKey === input.redeemKey)) {
        return { valueAtomic, duplicate: true };
      }
      if (existing.some((redeemKey) => redeemKey !== undefined)) {
        throw new Error("double_spend");
      }
      const previous = structuredClone(this.nullifiers);
      const reserved = { ...spent };
      for (const proof of prepared) reserved[proof.nullifier] = input.redeemKey;
      this.nullifiers.spent[input.keysetId] = reserved;
      try {
        await this.nullifierFile.write(this.nullifiers);
      } catch (error) {
        this.nullifiers = previous;
        throw error;
      }
      return { valueAtomic, duplicate: false };
    });
  }

  rotateKeyset(asset: string): Promise<PublicKeyset> {
    return this.serialize(async () => {
      this.assertAsset(asset);
      const previous = structuredClone(this.keysets);
      const now = Date.now();
      const active = this.keysets.keysets.filter(
        (keyset) => keyset.asset === asset && keyset.status === "active",
      );
      if (active.length !== 1) {
        throw new Error(`Blind voucher mint requires exactly one active keyset for ${asset}`);
      }
      active[0].status = "retired";
      active[0].retiredAt = now;
      const epoch = Math.max(...this.keysets.keysets
        .filter((keyset) => keyset.asset === asset)
        .map((keyset) => keyset.epoch), -1) + 1;
      const created = this.createKeyset(asset, epoch, now, null);
      this.keysets.keysets.push(created);
      this.appendManifest(created);
      try {
        await this.keysetFile.write(this.keysets);
      } catch (error) {
        this.keysets = previous;
        throw error;
      }
      return publicKeyset(created);
    });
  }

  freezeExpiredKeysets(now = Date.now()): Promise<{ asset: string; keysetId: string }[]> {
    return this.serialize(async () => {
      if (!Number.isFinite(now)) throw new Error("Blind voucher freeze time is invalid");
      const previous = structuredClone(this.keysets);
      const frozen: { asset: string; keysetId: string }[] = [];
      for (const keyset of this.keysets.keysets) {
        if (keyset.status === "retired"
          && keyset.redeemUntil !== null
          && keyset.redeemUntil <= now) {
          keyset.status = "frozen";
          frozen.push({ asset: keyset.asset, keysetId: keyset.keysetId });
        }
      }
      if (frozen.length > 0) {
        try {
          await this.keysetFile.write(this.keysets);
        } catch (error) {
          this.keysets = previous;
          throw error;
        }
      }
      return frozen;
    });
  }

  eraseKeyset(asset: string, keysetId: string): Promise<void> {
    return this.serialize(async () => {
      const keyset = this.requireKeyset(asset, keysetId);
      if (keyset.status !== "frozen") {
        throw new Error("Blind voucher keyset must be frozen before erasure");
      }

      // M5 ordering: persist key erasure before nullifier pruning. A crash
      // between these writes leaves harmless spent tombstones, never live keys
      // without their double-spend evidence.
      const previousKeysets = structuredClone(this.keysets);
      this.zeroKeyset(keyset);
      this.keysets.keysets = this.keysets.keysets.filter(
        (candidate) => candidate.keysetId !== keysetId,
      );
      try {
        await this.keysetFile.write(this.keysets);
      } catch (error) {
        this.keysets = previousKeysets;
        throw error;
      }

      const previousNullifiers = structuredClone(this.nullifiers);
      delete this.nullifiers.spent[keysetId];
      try {
        await this.nullifierFile.write(this.nullifiers);
      } catch (error) {
        this.nullifiers = previousNullifiers;
        throw error;
      }
    });
  }

  close(): void {
    this.identityKey.fill(0);
    for (const keyset of this.keysets.keysets) this.zeroKeyset(keyset);
  }

  private bootstrapKeyset(asset: string) {
    const keyset = this.createKeyset(asset, 0, Date.now(), null);
    this.keysets.keysets.push(keyset);
    this.appendManifest(keyset);
  }

  private createKeyset(
    asset: string,
    epoch: number,
    activatesAt: number,
    redeemUntil: number | null,
  ): MintKeyset {
    const denominations = this.denominationsAtomic.map((denomAtomic) => {
      const key = secp256k1.utils.randomSecretKey();
      return {
        denomAtomic,
        k: hexlify(key),
        K: hexlify(secp256k1.getPublicKey(key, true)),
      };
    });
    const keysetId = computeKeysetId({ asset, epoch, denominations });
    return {
      keysetId,
      asset,
      epoch,
      status: "active",
      activatesAt,
      redeemUntil,
      denominations,
    };
  }

  private appendManifest(keyset: MintKeyset) {
    const manifest = this.keysets.manifestByAsset[keyset.asset] ?? [];
    const entry: ManifestEntry = {
      seq: manifest.length,
      asset: keyset.asset,
      epoch: keyset.epoch,
      keysetId: keyset.keysetId,
      denominations: keyset.denominations.map(({ denomAtomic, K }) => ({ denomAtomic, K })),
      activatesAt: keyset.activatesAt,
      redeemUntil: keyset.redeemUntil,
      prevEntryHash: manifest.length > 0
        ? manifest[manifest.length - 1].entryHash
        : `0x${"00".repeat(32)}`,
    };
    const entryHash = hashManifestEntry(entry);
    manifest.push({
      entry,
      entryHash,
      signature: signHash(entryHash, this.identityKey),
    });
    this.keysets.manifestByAsset[keyset.asset] = manifest;
  }

  private requireKeyset(asset: string, keysetId: string): MintKeyset {
    this.assertAsset(asset);
    const keyset = this.keysets.keysets.find(
      (candidate) => candidate.asset === asset && candidate.keysetId === keysetId,
    );
    if (!keyset) throw new Error("Blind voucher keyset is unknown or erased");
    return keyset;
  }

  private assertAsset(asset: string) {
    if (!this.assets.includes(asset)) throw new Error(`Blind voucher asset is not configured: ${asset}`);
  }

  private assertLoaded() {
    if (!this.loaded) throw new Error("Blind voucher mint is not loaded");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.assertLoaded();
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private zeroKeyset(keyset: MintKeyset) {
    for (const denomination of keyset.denominations) {
      denomination.k = `0x${"00".repeat(32)}`;
    }
  }
}

const publicKeyset = (keyset: MintKeyset): PublicKeyset => ({
  keysetId: keyset.keysetId,
  asset: keyset.asset,
  epoch: keyset.epoch,
  status: keyset.status,
  activatesAt: keyset.activatesAt,
  ...(keyset.retiredAt === undefined ? {} : { retiredAt: keyset.retiredAt }),
  redeemUntil: keyset.redeemUntil,
  denominations: keyset.denominations.map(({ denomAtomic, K }) => ({ denomAtomic, K })),
});

const assertKeysetFile: (
  value: unknown,
  mintPubKey: string,
) => asserts value is KeysetFile = (value, mintPubKey) => {
  if (!isRecord(value)
    || value.version !== 1
    || !isHash(value.mintIdentityKeyFingerprint)
    || !isRecord(value.manifestByAsset)
    || !Array.isArray(value.keysets)) {
    throw new Error("Blind voucher keyset file is invalid");
  }
  for (const [asset, manifest] of Object.entries(value.manifestByAsset)) {
    if (!Array.isArray(manifest)) throw new Error("Blind voucher manifest is invalid");
    let previous = `0x${"00".repeat(32)}`;
    for (let index = 0; index < manifest.length; index += 1) {
      const signed = manifest[index];
      if (!isRecord(signed)
        || !isRecord(signed.entry)
        || signed.entry.asset !== asset
        || signed.entry.seq !== index
        || signed.entry.prevEntryHash !== previous
        || !verifyManifestEntry(signed as unknown as SignedManifestEntry, mintPubKey)) {
        throw new Error("Blind voucher manifest is invalid");
      }
      previous = signed.entryHash as string;
    }
  }
  for (const raw of value.keysets) {
    assertMintKeyset(raw);
    const computed = computeKeysetId({
      asset: raw.asset,
      epoch: raw.epoch,
      denominations: raw.denominations,
    });
    if (computed !== raw.keysetId) throw new Error("Blind voucher keyset id is invalid");
    for (const denomination of raw.denominations) {
      const expected = hexlify(secp256k1.getPublicKey(getBytes(denomination.k), true));
      if (expected !== denomination.K) throw new Error("Blind voucher denomination key is invalid");
    }
  }
};

const assertMintKeyset: (value: unknown) => asserts value is MintKeyset = (value) => {
  if (!isRecord(value)
    || !isHash(value.keysetId)
    || typeof value.asset !== "string"
    || !Number.isSafeInteger(value.epoch)
    || !["active", "retired", "frozen"].includes(String(value.status))
    || !Number.isSafeInteger(value.activatesAt)
    || (value.retiredAt !== undefined && !Number.isSafeInteger(value.retiredAt))
    || (value.redeemUntil !== null && !Number.isSafeInteger(value.redeemUntil))
    || !Array.isArray(value.denominations)
    || value.denominations.length === 0) {
    throw new Error("Blind voucher keyset is invalid");
  }
  for (const denomination of value.denominations) {
    if (!isRecord(denomination)
      || !isAtomic(denomination.denomAtomic)
      || !isScalar(denomination.k)
      || !isPoint(denomination.K)) {
      throw new Error("Blind voucher denomination key is invalid");
    }
  }
};

const assertNullifierFile: (value: unknown) => asserts value is NullifierFile = (value) => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.spent)) {
    throw new Error("Blind voucher nullifier file is invalid");
  }
  for (const [keysetId, spent] of Object.entries(value.spent)) {
    if (!isHash(keysetId) || !isRecord(spent)) {
      throw new Error("Blind voucher nullifier partition is invalid");
    }
    for (const [nullifier, redeemKey] of Object.entries(spent)) {
      if (!isHash(nullifier) || !isHash(redeemKey)) {
        throw new Error("Blind voucher nullifier entry is invalid");
      }
    }
  }
};

const parseIdentityKey = (value: string): Uint8Array => {
  const bytes = getBytes(value);
  if (bytes.length !== 32 || !secp256k1.utils.isValidSecretKey(bytes)) {
    throw new Error("Blind voucher mint identity key must be a nonzero secp256k1 private key");
  }
  return Uint8Array.from(bytes);
};

const canonicalDenominations = (values: readonly string[]): string[] => {
  const canonical = values.map((value) => {
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Blind voucher denomination is invalid");
    const parsed = BigInt(value);
    if (parsed > 10n ** 18n) throw new Error("Blind voucher denomination exceeds the maximum");
    return parsed.toString();
  }).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  if (canonical.length === 0 || new Set(canonical).size !== canonical.length) {
    throw new Error("Blind voucher denominations must be nonempty and unique");
  }
  return canonical;
};

const signHash = (hash: string, privateKey: Uint8Array) =>
  hexlify(secp256k1.sign(getBytes(hash), privateKey, { lowS: true }).toCompactRawBytes());

const checkpointMessageHash = (headSeq: number, headEntryHash: string) =>
  sha256(concat([
    lp(toUtf8Bytes("px402-blind-voucher/checkpoint/v1")),
    lp(uint64Be(BigInt(headSeq))),
    lp(getBytes(headEntryHash)),
  ]));

const lp = (value: Uint8Array | string) => {
  const bytes = getBytes(value);
  return concat([uint32Be(bytes.length), bytes]);
};

const uint32Be = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

const uint64Be = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, false);
  return bytes;
};

const assertPositiveLimit = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Blind voucher ${label} must be an integer >= 1`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHash = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

const isScalar = isHash;

const isPoint = (value: unknown) =>
  typeof value === "string" && /^0x0[23][0-9a-fA-F]{64}$/.test(value);

const isAtomic = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value);
