import { secp256k1 } from "@noble/curves/secp256k1";
import {
  concat,
  getBytes,
  hexlify,
  randomBytes,
  sha256,
  toUtf8Bytes,
  type BytesLike,
} from "ethers";

const { ProjectivePoint } = secp256k1;
const N = secp256k1.CURVE.n;
type Point = InstanceType<typeof ProjectivePoint>;

const ZERO_HASH = `0x${"00".repeat(32)}`;
const H2C_DOMAIN = toUtf8Bytes("Secp256k1_HashToCurve_Cashu_");
const DLEQ_DOMAIN = toUtf8Bytes("px402-blind-voucher/dleq/v1");
const DLEQ_NONCE_DOMAIN = toUtf8Bytes("px402-blind-voucher/dleq-nonce/v1");
const KEYSET_DOMAIN = toUtf8Bytes("px402-blind-voucher/keyset/v1");
const MELT_DOMAIN = toUtf8Bytes("px402-blind-voucher/melt/v1");
const REDEEM_DOMAIN = toUtf8Bytes("px402-blind-voucher/redeem/v1");
const MANIFEST_DOMAIN = toUtf8Bytes("px402-blind-voucher/manifest-entry/v1");
const CHECKPOINT_DOMAIN = toUtf8Bytes("px402-blind-voucher/checkpoint/v1");

export interface BlindVoucherOutput {
  denomAtomic: string;
  B_: string;
}

export interface DleqProof {
  e: string;
  s: string;
}

export interface BlindSignature {
  denomAtomic: string;
  C_: string;
  dleq: DleqProof;
}

/** Transferable bearer token. `r` is retained for offline verification and is never sent to the mint. */
export interface BlindVoucher {
  id: string;
  asset: string;
  keysetId: string;
  denomAtomic: string;
  secret: string;
  C: string;
  r: string;
  dleq: DleqProof;
}

export interface BlindingContext {
  secret: string;
  r: string;
  denomAtomic: string;
  Y: string;
  B_: string;
}

export interface KeysetDenominationPub {
  denomAtomic: string;
  K: string;
}

export interface ManifestEntry {
  seq: number;
  asset: string;
  epoch: number;
  keysetId: string;
  denominations: KeysetDenominationPub[];
  activatesAt: number;
  redeemUntil: number | null;
  prevEntryHash: string;
}

export interface SignedManifestEntry {
  entry: ManifestEntry;
  entryHash: string;
  signature: string;
}

export interface ManifestCheckpoint {
  headSeq: number;
  headEntryHash: string;
  signature: string;
}

export const hashToCurve = (secret: BytesLike): Point => {
  const message = getBytes(sha256(concat([H2C_DOMAIN, getBytes(secret)])));
  for (let counter = 0; counter <= 65_535; counter += 1) {
    const candidate = getBytes(sha256(concat([message, uint32Le(counter)])));
    try {
      const point = ProjectivePoint.fromHex(
        getBytes(concat([Uint8Array.of(0x02), candidate])),
      );
      point.assertValidity();
      return point;
    } catch {
      // Cashu NUT-00 deliberately uses try-and-increment.
    }
  }
  throw new Error("hashToCurve exhausted");
};

export const nullifierOf = (secret: BytesLike): string =>
  sha256(concat([
    toUtf8Bytes("px402-blind-voucher/nullifier/v1"),
    getBytes(secret),
  ]));

export const randomSecret = (): string => hexlify(randomBytes(32));

export const randomScalar = (): string => {
  for (;;) {
    const candidate = bytesToBigInt(randomBytes(32)) % N;
    if (candidate !== 0n) return scalarHex(candidate);
  }
};

export const blindSecret = (secret: BytesLike, rHex?: string): BlindingContext => {
  const secretBytes = getBytes(secret);
  if (secretBytes.length !== 32) throw new Error("Blind voucher secret must be 32 bytes");
  const r = scalarFromHex(rHex ?? randomScalar(), "blinding scalar");
  const Y = hashToCurve(secretBytes);
  const B_ = Y.add(ProjectivePoint.BASE.multiply(r));
  B_.assertValidity();
  return {
    secret: hexlify(secretBytes),
    r: scalarHex(r),
    denomAtomic: "",
    Y: pointHex(Y),
    B_: pointHex(B_),
  };
};

export const unblindSignature = (input: { C_: string; r: string; K: string }): string => {
  const r = scalarFromHex(input.r, "blinding scalar");
  const C = pointFrom(input.C_, "blind signature")
    .subtract(pointFrom(input.K, "denomination public key").multiply(r));
  C.assertValidity();
  return pointHex(C);
};

export const verifyDleq = (input: {
  B_: string;
  C_: string;
  K: string;
  dleq: DleqProof;
}): boolean => {
  try {
    const B_ = pointFrom(input.B_, "blinded point");
    const C_ = pointFrom(input.C_, "blind signature");
    const K = pointFrom(input.K, "denomination public key");
    const e = scalarFromHex(input.dleq.e, "DLEQ challenge");
    const s = scalarFromHex(input.dleq.s, "DLEQ response");
    const R1 = ProjectivePoint.BASE.multiply(s).subtract(K.multiply(e));
    const R2 = B_.multiply(s).subtract(C_.multiply(e));
    return dleqChallenge(R1, R2, K, C_) === e;
  } catch {
    return false;
  }
};

export const verifyTransferredVoucher = (input: {
  secret: string;
  C: string;
  r: string;
  dleq: DleqProof;
  K: string;
}): boolean => {
  try {
    const secret = getBytes(input.secret);
    if (secret.length !== 32) return false;
    const r = scalarFromHex(input.r, "blinding scalar");
    const K = pointFrom(input.K, "denomination public key");
    const Y = hashToCurve(secret);
    const C = pointFrom(input.C, "unblinded signature");
    const B_ = Y.add(ProjectivePoint.BASE.multiply(r));
    const C_ = C.add(K.multiply(r));
    return verifyDleq({
      B_: pointHex(B_),
      C_: pointHex(C_),
      K: pointHex(K),
      dleq: input.dleq,
    });
  } catch {
    return false;
  }
};

export const signBlinded = (input: { B_: string; k: string }): string => {
  const k = scalarFromHex(input.k, "mint denomination key");
  const C_ = pointFrom(input.B_, "blinded point").multiply(k);
  C_.assertValidity();
  return pointHex(C_);
};

export const proveDleq = (input: {
  B_: string;
  C_: string;
  k: string;
  K: string;
}): DleqProof => {
  const B_ = pointFrom(input.B_, "blinded point");
  const C_ = pointFrom(input.C_, "blind signature");
  const K = pointFrom(input.K, "denomination public key");
  const k = scalarFromHex(input.k, "mint denomination key");
  if (!ProjectivePoint.BASE.multiply(k).equals(K) || !B_.multiply(k).equals(C_)) {
    throw new Error("DLEQ transcript does not match mint key");
  }
  for (let counter = 0; counter <= 0xffff_ffff; counter += 1) {
    const w = dleqNonce(k, B_, C_, K, counter);
    if (w === undefined) continue;
    const R1 = ProjectivePoint.BASE.multiply(w);
    const R2 = B_.multiply(w);
    const e = dleqChallenge(R1, R2, K, C_);
    if (e === 0n) continue;
    const s = modN(w + e * k);
    if (s === 0n) continue;
    return { e: scalarHex(e), s: scalarHex(s) };
  }
  throw new Error("DLEQ nonce derivation exhausted");
};

export const verifyRedeemProof = (input: {
  secret: string;
  C: string;
  k: string;
}): boolean => {
  try {
    const secret = getBytes(input.secret);
    if (secret.length !== 32) return false;
    const k = scalarFromHex(input.k, "mint denomination key");
    return hashToCurve(secret).multiply(k).equals(pointFrom(input.C, "voucher signature"));
  } catch {
    return false;
  }
};

export const decomposeAmount = (
  amountAtomic: string,
  denomsAtomic: readonly string[],
): string[] => {
  let remaining = positiveAtomic(amountAtomic, "voucher amount");
  const denoms = [...new Set(denomsAtomic.map((value) =>
    positiveAtomic(value, "voucher denomination").toString()))]
    .map(BigInt)
    .sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  if (denoms.length === 0) throw new Error("Voucher denominations are required");
  const result: string[] = [];
  for (const denomination of denoms) {
    while (remaining >= denomination) {
      result.push(denomination.toString());
      remaining -= denomination;
    }
  }
  if (remaining !== 0n) throw new Error("Voucher amount is not exactly representable");
  return result;
};

export const sumAtomic = (values: readonly string[]): string =>
  values.reduce((sum, value) => sum + positiveAtomic(value, "voucher denomination"), 0n).toString();

export const meltFingerprint = (input: {
  asset: string;
  keysetId: string;
  outputs: readonly BlindVoucherOutput[];
  totalAtomic: string;
}): string => {
  const outputs = [...input.outputs]
    .map((output) => ({
      denomAtomic: positiveAtomic(output.denomAtomic, "voucher denomination").toString(),
      B_: canonicalPointHex(output.B_, "blinded point"),
    }))
    .sort(compareDenominationAndHex);
  return sha256(concat([
    lp(MELT_DOMAIN),
    lp(toUtf8Bytes(input.asset)),
    lp(hashBytes(input.keysetId, "keyset id")),
    lp(uint64Be(positiveAtomic(input.totalAtomic, "voucher amount"))),
    lp(concat(outputs.map((output) => concat([
      lp(toUtf8Bytes(output.denomAtomic)),
      lp(getBytes(output.B_)),
    ])))),
  ]));
};

export const redeemKeyOf = (input: {
  asset: string;
  recipientAgentId: string;
  keysetId: string;
  proofs: readonly { denomAtomic: string; nullifier: string }[];
}): string => {
  const proofs = [...input.proofs]
    .map((proof) => ({
      denomAtomic: positiveAtomic(proof.denomAtomic, "voucher denomination").toString(),
      nullifier: hashHex(proof.nullifier, "voucher nullifier"),
    }))
    .sort(compareDenominationAndNullifier);
  return sha256(concat([
    lp(REDEEM_DOMAIN),
    lp(toUtf8Bytes(input.asset)),
    lp(toUtf8Bytes(input.recipientAgentId)),
    lp(hashBytes(input.keysetId, "keyset id")),
    lp(concat(proofs.map((proof) => concat([
      lp(toUtf8Bytes(proof.denomAtomic)),
      lp(getBytes(proof.nullifier)),
    ])))),
  ]));
};

export const computeKeysetId = (input: {
  asset: string;
  epoch: number;
  denominations: readonly KeysetDenominationPub[];
}): string => {
  const denominations = canonicalDenominations(input.denominations);
  return sha256(concat([
    lp(KEYSET_DOMAIN),
    lp(toUtf8Bytes(input.asset)),
    lp(uint64Be(safeUint(input.epoch, "keyset epoch"))),
    lp(encodeDenominations(denominations)),
  ]));
};

export const hashManifestEntry = (entry: ManifestEntry): string => {
  const denominations = canonicalDenominations(entry.denominations);
  const keysetId = hashHex(entry.keysetId, "keyset id");
  const expectedKeysetId = computeKeysetId({
    asset: entry.asset,
    epoch: entry.epoch,
    denominations,
  });
  if (keysetId !== expectedKeysetId) throw new Error("Manifest keyset id mismatch");
  const redeemUntil = entry.redeemUntil === null
    ? 0xffff_ffff_ffff_ffffn
    : safeUint(entry.redeemUntil, "redeemUntil");
  return sha256(concat([
    lp(MANIFEST_DOMAIN),
    lp(uint64Be(safeUint(entry.seq, "manifest sequence"))),
    lp(toUtf8Bytes(entry.asset)),
    lp(uint64Be(safeUint(entry.epoch, "keyset epoch"))),
    lp(getBytes(keysetId)),
    lp(encodeDenominations(denominations)),
    lp(uint64Be(safeUint(entry.activatesAt, "activatesAt"))),
    lp(uint64Be(redeemUntil)),
    lp(hashBytes(entry.prevEntryHash, "previous entry hash")),
  ]));
};

export const verifyManifestEntry = (
  signed: SignedManifestEntry,
  mintPubKey: string,
): boolean => {
  try {
    const entryHash = hashManifestEntry(signed.entry);
    if (entryHash !== hashHex(signed.entryHash, "manifest entry hash")) return false;
    if (signed.entry.seq === 0 && signed.entry.prevEntryHash !== ZERO_HASH) return false;
    return secp256k1.verify(
      getBytes(signed.signature),
      getBytes(entryHash),
      getBytes(canonicalPointHex(mintPubKey, "mint identity public key")),
      { lowS: true },
    );
  } catch {
    return false;
  }
};

export const verifyCheckpoint = (
  checkpoint: ManifestCheckpoint,
  mintPubKey: string,
): boolean => {
  try {
    return secp256k1.verify(
      getBytes(checkpoint.signature),
      getBytes(checkpointHash(checkpoint.headSeq, checkpoint.headEntryHash)),
      getBytes(canonicalPointHex(mintPubKey, "mint identity public key")),
      { lowS: true },
    );
  } catch {
    return false;
  }
};

const checkpointHash = (headSeq: number, headEntryHash: string) =>
  sha256(concat([
    lp(CHECKPOINT_DOMAIN),
    lp(uint64Be(safeUint(headSeq, "checkpoint sequence"))),
    lp(hashBytes(headEntryHash, "checkpoint entry hash")),
  ]));

const dleqChallenge = (R1: Point, R2: Point, K: Point, C_: Point): bigint =>
  bytesToBigInt(getBytes(sha256(concat([
    DLEQ_DOMAIN,
    Uint8Array.of(0),
    R1.toBytes(true),
    R2.toBytes(true),
    K.toBytes(true),
    C_.toBytes(true),
  ])))) % N;

const dleqNonce = (
  k: bigint,
  B_: Point,
  C_: Point,
  K: Point,
  counter: number,
): bigint | undefined => {
  const digest = getBytes(sha256(concat([
    lp(DLEQ_NONCE_DOMAIN),
    lp(getBytes(scalarHex(k))),
    lp(B_.toBytes(true)),
    lp(C_.toBytes(true)),
    lp(K.toBytes(true)),
    lp(uint32Be(counter)),
  ])));
  const value = bytesToBigInt(digest);
  if (value >= 1n && value < N) return value;
  return undefined;
};

const canonicalDenominations = (
  denominations: readonly KeysetDenominationPub[],
): KeysetDenominationPub[] => {
  const result = denominations.map((denomination) => ({
    denomAtomic: positiveAtomic(denomination.denomAtomic, "voucher denomination").toString(),
    K: canonicalPointHex(denomination.K, "denomination public key"),
  })).sort(compareDenominationAndKey);
  const seen = new Set<string>();
  for (const denomination of result) {
    if (seen.has(denomination.denomAtomic)) throw new Error("Duplicate voucher denomination");
    seen.add(denomination.denomAtomic);
  }
  if (result.length === 0) throw new Error("Voucher denominations are required");
  return result;
};

const encodeDenominations = (denominations: readonly KeysetDenominationPub[]) =>
  concat(denominations.map((denomination) => concat([
    lp(toUtf8Bytes(denomination.denomAtomic)),
    lp(getBytes(denomination.K)),
  ])));

const compareDenominationAndHex = (
  a: { denomAtomic: string; B_: string },
  b: { denomAtomic: string; B_: string },
) => compareAtomicThenHex(a.denomAtomic, a.B_, b.denomAtomic, b.B_);

const compareDenominationAndNullifier = (
  a: { denomAtomic: string; nullifier: string },
  b: { denomAtomic: string; nullifier: string },
) => compareAtomicThenHex(a.denomAtomic, a.nullifier, b.denomAtomic, b.nullifier);

const compareDenominationAndKey = (
  a: KeysetDenominationPub,
  b: KeysetDenominationPub,
) => compareAtomicThenHex(a.denomAtomic, a.K, b.denomAtomic, b.K);

const compareAtomicThenHex = (
  aAtomic: string,
  aHex: string,
  bAtomic: string,
  bHex: string,
) => {
  const a = BigInt(aAtomic);
  const b = BigInt(bAtomic);
  if (a !== b) return a < b ? -1 : 1;
  return aHex.localeCompare(bHex);
};

const pointFrom = (value: string, label: string): Point => {
  const bytes = getBytes(value);
  if (bytes.length !== 33) throw new Error(`${label} must be a compressed secp256k1 point`);
  const point = ProjectivePoint.fromHex(bytes);
  point.assertValidity();
  return point;
};

const pointHex = (point: Point) => hexlify(point.toBytes(true));

const canonicalPointHex = (value: string, label: string) => pointHex(pointFrom(value, label));

const scalarFromHex = (value: string, label: string): bigint => {
  const bytes = getBytes(value);
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes`);
  const scalar = bytesToBigInt(bytes);
  if (scalar <= 0n || scalar >= N) throw new Error(`${label} must be nonzero and below curve order`);
  return scalar;
};

const scalarHex = (value: bigint) => hexlify(uint256Be(value));

const modN = (value: bigint) => ((value % N) + N) % N;

const positiveAtomic = (value: string, label: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be canonical atomic units`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${label} must be positive`);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} exceeds uint64`);
  return parsed;
};

const safeUint = (value: number, label: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe unsigned integer`);
  return BigInt(value);
};

const lp = (value: BytesLike): Uint8Array => {
  const bytes = getBytes(value);
  if (bytes.length > 0xffff_ffff) throw new Error("Length-prefixed value is too large");
  return getBytes(concat([uint32Be(bytes.length), bytes]));
};

const uint32Be = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("uint32 value is out of range");
  }
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
};

const uint32Le = (value: number): Uint8Array => {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
};

const uint64Be = (value: bigint): Uint8Array => {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error("uint64 value is out of range");
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, false);
  return result;
};

const uint256Be = (value: bigint): Uint8Array => {
  if (value < 0n || value >= (1n << 256n)) throw new Error("uint256 value is out of range");
  return getBytes(`0x${value.toString(16).padStart(64, "0")}`);
};

const bytesToBigInt = (value: Uint8Array): bigint =>
  BigInt(hexlify(value));

const hashBytes = (value: string, label: string): Uint8Array =>
  getBytes(hashHex(value, label));

const hashHex = (value: string, label: string): string => {
  const bytes = getBytes(value);
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return hexlify(bytes);
};
