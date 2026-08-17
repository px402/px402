import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha512 } from "@noble/hashes/sha512";
import {
  concat,
  getBytes,
  hexlify,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";
import {
  computeStealthPrivateKey,
  deriveStealthAddress,
  type StealthDerivation,
  type StealthKeys,
} from "./stealth";
import {
  deriveSolanaStealthAddress,
  publicKeyForSolanaScalar,
  recoverSolanaStealthScalar,
  type SolanaStealthDerivation,
  type SolanaStealthKeys,
} from "./stealthSolana";

export const DEPOSIT_STEALTH_SCHEME = "px402-deposit-stealth/v1";
export const DEPOSIT_EPHEMERAL_SCHEME = "px402-deposit-eph/v1";

const SECP256K1_ORDER = secp256k1.CURVE.n;
const ED25519_ORDER = ed25519.CURVE.n;

export interface TreasuryKeyContext {
  caip2: string;
  tokenAddress: string;
  keyVersion: string;
}

/** 8-byte big-endian encoding of a non-negative safe integer. */
export const u64be = (n: number): Uint8Array => {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("Deposit derivation index must be a non-negative safe integer");
  }
  return getBytes(zeroPadValue(toBeHex(BigInt(n)), 8));
};

export const deriveEvmTreasuryStealthKeys = (
  settlerPrivateKey: string,
  ctx: TreasuryKeyContext,
): StealthKeys => {
  const settler = privateKey32(settlerPrivateKey);
  const spendingKey = evmContextScalar(settler, ctx, "spending");
  const viewingKey = evmContextScalar(settler, ctx, "viewing");
  return {
    spendingKey: hex32(spendingKey),
    viewingKey: hex32(viewingKey),
    meta: {
      spendingPubKey: hexlify(secp256k1.getPublicKey(spendingKey, true)),
      viewingPubKey: hexlify(secp256k1.getPublicKey(viewingKey, true)),
    },
  };
};

export const deriveEvmDepositAddress = (
  settlerPrivateKey: string,
  ctx: TreasuryKeyContext,
  index: number,
): StealthDerivation => {
  const ephemeral = deriveEvmEphemeralScalar(settlerPrivateKey, ctx, index);
  return deriveStealthAddress(
    deriveEvmTreasuryStealthKeys(settlerPrivateKey, ctx).meta,
    hex32(ephemeral),
  );
};

export const deriveEvmDepositPrivateKey = (
  settlerPrivateKey: string,
  ctx: TreasuryKeyContext,
  index: number,
): string => {
  const keys = deriveEvmTreasuryStealthKeys(settlerPrivateKey, ctx);
  const derivation = deriveEvmDepositAddress(settlerPrivateKey, ctx, index);
  return computeStealthPrivateKey({
    ephemeralPubKey: derivation.ephemeralPubKey,
    viewingKey: keys.viewingKey,
    spendingKey: keys.spendingKey,
  });
};

export const deriveSolanaTreasuryStealthKeys = (
  settlerSecretKeyBase58: string,
  ctx: TreasuryKeyContext,
): SolanaStealthKeys => {
  const settler = decodeBase58(settlerSecretKeyBase58);
  if (settler.length !== 64) {
    throw new Error("Solana settler secret must decode to a 64-byte keypair");
  }
  const spending = solanaContextScalar(settler, ctx, "spending");
  const viewing = solanaContextScalar(settler, ctx, "viewing");
  return {
    spendingScalar: hex32(spending),
    viewingScalar: hex32(viewing),
    meta: {
      spendingPubKey: publicKeyForSolanaScalar(spending).toBase58(),
      viewingPubKey: publicKeyForSolanaScalar(viewing).toBase58(),
    },
  };
};

export const deriveSolanaDepositAddress = (
  settlerSecretKeyBase58: string,
  ctx: TreasuryKeyContext,
  index: number,
): SolanaStealthDerivation => deriveSolanaStealthAddress(
  deriveSolanaTreasuryStealthKeys(settlerSecretKeyBase58, ctx).meta,
  deriveSolanaEphemeralScalar(settlerSecretKeyBase58, ctx, index),
);

export const deriveSolanaDepositScalar = (
  settlerSecretKeyBase58: string,
  ctx: TreasuryKeyContext,
  index: number,
): string => {
  const keys = deriveSolanaTreasuryStealthKeys(settlerSecretKeyBase58, ctx);
  const derivation = deriveSolanaDepositAddress(settlerSecretKeyBase58, ctx, index);
  return recoverSolanaStealthScalar({
    ephemeralPubKey: derivation.ephemeralPubKey,
    viewingScalar: keys.viewingScalar,
    spendingScalar: keys.spendingScalar,
    expectedAddress: derivation.stealthAddress,
  });
};

export const evmKeyVersion = (settlerAddress: string): string =>
  keccak256(getBytes(settlerAddress)).slice(2, 10);

export const solanaKeyVersion = (settlerPubkeyBase58: string): string =>
  keccak256(decodeBase58(settlerPubkeyBase58)).slice(2, 10);

const deriveEvmEphemeralScalar = (
  settlerPrivateKey: string,
  ctx: TreasuryKeyContext,
  index: number,
) => scalarFromBigEndian(
  getBytes(keccak256(concat([
    toUtf8Bytes(DEPOSIT_EPHEMERAL_SCHEME),
    toUtf8Bytes(ctx.caip2),
    toUtf8Bytes(ctx.tokenAddress.toLowerCase()),
    toUtf8Bytes(ctx.keyVersion),
    u64be(index),
    privateKey32(settlerPrivateKey),
  ]))),
  SECP256K1_ORDER,
);

const evmContextScalar = (
  settler: Uint8Array,
  ctx: TreasuryKeyContext,
  role: "spending" | "viewing",
) => scalarFromBigEndian(
  getBytes(keccak256(concat([
    toUtf8Bytes(DEPOSIT_STEALTH_SCHEME),
    toUtf8Bytes(ctx.caip2),
    toUtf8Bytes(ctx.tokenAddress.toLowerCase()),
    toUtf8Bytes(ctx.keyVersion),
    toUtf8Bytes(role),
    settler,
  ]))),
  SECP256K1_ORDER,
);

const deriveSolanaEphemeralScalar = (
  settlerSecretKeyBase58: string,
  ctx: TreasuryKeyContext,
  index: number,
) => {
  const settler = decodeBase58(settlerSecretKeyBase58);
  if (settler.length !== 64) {
    throw new Error("Solana settler secret must decode to a 64-byte keypair");
  }
  return scalarFromBigEndian(sha512(concatBytes(
    toUtf8Bytes(DEPOSIT_EPHEMERAL_SCHEME),
    toUtf8Bytes(ctx.caip2),
    toUtf8Bytes(ctx.tokenAddress),
    toUtf8Bytes(ctx.keyVersion),
    u64be(index),
    settler,
  )), ED25519_ORDER);
};

const solanaContextScalar = (
  settler: Uint8Array,
  ctx: TreasuryKeyContext,
  role: "spending" | "viewing",
) => scalarFromBigEndian(sha512(concatBytes(
  toUtf8Bytes(DEPOSIT_STEALTH_SCHEME),
  toUtf8Bytes(ctx.caip2),
  toUtf8Bytes(ctx.tokenAddress),
  toUtf8Bytes(ctx.keyVersion),
  toUtf8Bytes(role),
  settler,
)), ED25519_ORDER);

const scalarFromBigEndian = (bytes: Uint8Array, order: bigint): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const scalar = value % order;
  return scalar === 0n ? 1n : scalar;
};

const privateKey32 = (value: string) => {
  const bytes = getBytes(value);
  if (bytes.length !== 32) throw new Error("EVM settler private key must be 32 bytes");
  return bytes;
};

const hex32 = (value: bigint) => hexlify(
  zeroPadValue(toBeHex(value), 32),
);

const concatBytes = (...values: Uint8Array[]) => {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
};

const decodeBase58 = (value: string): Uint8Array => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base58 value");
    numeric = numeric * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (numeric > 0n) {
    decoded.push(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  decoded.reverse();
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  const bytes = new Uint8Array(leadingZeros + decoded.length);
  bytes.set(decoded, leadingZeros);
  return bytes;
};
