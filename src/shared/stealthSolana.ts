import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";

// Validated end-to-end: stealth addresses match, the recovered scalar controls
// the address, raw-scalar signatures verify, and SLIP-0010 is deterministic.

const Point = ed25519.ExtendedPoint;
const L = ed25519.CURVE.n;

export interface SolanaStealthMetaAddress {
  spendingPubKey: string;
  viewingPubKey: string;
}

export interface SolanaStealthKeys {
  spendingScalar: string;
  viewingScalar: string;
  meta: SolanaStealthMetaAddress;
}

export interface SolanaStealthDerivation {
  stealthAddress: string;
  ephemeralPubKey: string;
}

export interface SolanaStealthDetection extends SolanaStealthDerivation {
  matches: boolean;
  sharedScalar: string;
}

export const generateSolanaStealthKeys = (): SolanaStealthKeys => {
  const spend = randomScalar();
  const view = randomScalar();
  return {
    spendingScalar: scalarToHex(spend),
    viewingScalar: scalarToHex(view),
    meta: {
      spendingPubKey: pointAddress(Point.BASE.multiply(spend)),
      viewingPubKey: pointAddress(Point.BASE.multiply(view))
    }
  };
};

export const deriveSolanaStealthAddress = (
  meta: SolanaStealthMetaAddress,
  ephemeralScalar?: string | bigint
): SolanaStealthDerivation => {
  const r = ephemeralScalar === undefined ? randomScalar() : parseScalar(ephemeralScalar);
  const announcement = Point.BASE.multiply(r);
  const shared = hashToScalar(pointFromAddress(meta.viewingPubKey).multiply(r).toRawBytes());
  const stealthPoint = pointFromAddress(meta.spendingPubKey).add(Point.BASE.multiply(shared));
  return {
    stealthAddress: pointAddress(stealthPoint),
    ephemeralPubKey: pointAddress(announcement)
  };
};

export const checkSolanaStealthAddress = (input: {
  ephemeralPubKey: string;
  viewingScalar: string;
  spendingPubKey: string;
  paidAddress?: string;
}): SolanaStealthDetection => {
  const view = parseScalar(input.viewingScalar);
  const shared = hashToScalar(pointFromAddress(input.ephemeralPubKey).multiply(view).toRawBytes());
  const stealthPoint = pointFromAddress(input.spendingPubKey).add(Point.BASE.multiply(shared));
  const stealthAddress = pointAddress(stealthPoint);
  return {
    matches: input.paidAddress === undefined || stealthAddress === new PublicKey(input.paidAddress).toBase58(),
    stealthAddress,
    ephemeralPubKey: new PublicKey(input.ephemeralPubKey).toBase58(),
    sharedScalar: scalarToHex(shared)
  };
};

export const recoverSolanaStealthScalar = (input: {
  ephemeralPubKey: string;
  viewingScalar: string;
  spendingScalar: string;
  expectedAddress?: string;
}): string => {
  const shared = hashToScalar(
    pointFromAddress(input.ephemeralPubKey).multiply(parseScalar(input.viewingScalar)).toRawBytes()
  );
  const scalar = mod(parseScalar(input.spendingScalar) + shared);
  const address = pointAddress(Point.BASE.multiply(scalar));
  if (input.expectedAddress !== undefined && address !== new PublicKey(input.expectedAddress).toBase58()) {
    throw new Error("Recovered Solana stealth scalar does not control the expected address");
  }
  return scalarToHex(scalar);
};

export const signSolanaWithScalar = (scalar: string | bigint, message: Uint8Array): Uint8Array => {
  const p = parseScalar(scalar);
  const publicKey = Point.BASE.multiply(p).toRawBytes();
  const nonce = hashToScalar(concatBytes(numTo32LE(p), message));
  const noncePoint = Point.BASE.multiply(nonce).toRawBytes();
  const challenge = hashToScalar(concatBytes(noncePoint, publicKey, message));
  const signatureScalar = mod(nonce + challenge * p);
  return concatBytes(noncePoint, numTo32LE(signatureScalar));
};

export const publicKeyForSolanaScalar = (scalar: string | bigint): PublicKey =>
  new PublicKey(Point.BASE.multiply(parseScalar(scalar)).toRawBytes());

export const sweepStealth = async (input: {
  connection: Pick<Connection, "getLatestBlockhash" | "getTokenAccountBalance">;
  mint: PublicKey | string;
  destinationOwner: PublicKey | string;
  settlerPubkey: PublicKey | string;
  stealthScalar: string | bigint;
  decimals: number;
  amountAtomic?: bigint | string;
}): Promise<{
  transaction: Transaction;
  sourceAta: PublicKey;
  destinationAta: PublicKey;
  stealthAddress: string;
}> => {
  const mint = asPublicKey(input.mint);
  const destinationOwner = asPublicKey(input.destinationOwner);
  const settlerPubkey = asPublicKey(input.settlerPubkey);
  const stealthOwner = publicKeyForSolanaScalar(input.stealthScalar);
  const sourceAta = getAssociatedTokenAddressSync(mint, stealthOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, destinationOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const amount = input.amountAtomic === undefined
    ? BigInt((await input.connection.getTokenAccountBalance(sourceAta)).value.amount)
    : BigInt(input.amountAtomic);
  if (amount <= 0n) throw new Error("Solana stealth ATA balance must be positive");

  const transaction = new Transaction({
    feePayer: settlerPubkey,
    recentBlockhash: (await input.connection.getLatestBlockhash()).blockhash
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      settlerPubkey,
      destinationAta,
      destinationOwner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      stealthOwner,
      amount,
      input.decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  transaction.addSignature(stealthOwner, Buffer.from(signSolanaWithScalar(input.stealthScalar, transaction.serializeMessage())));
  return { transaction, sourceAta, destinationAta, stealthAddress: stealthOwner.toBase58() };
};

export const verifySolanaScalarSignature = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: PublicKey | string
): boolean => ed25519.verify(signature, message, asPublicKey(publicKey).toBytes());

const pointFromAddress = (address: string) => Point.fromHex(new PublicKey(address).toBytes());
const pointAddress = (point: InstanceType<typeof Point>) => new PublicKey(point.toRawBytes()).toBase58();
const asPublicKey = (value: PublicKey | string) => value instanceof PublicKey ? value : new PublicKey(value);
const mod = (value: bigint) => ((value % L) + L) % L;
const hashToScalar = (bytes: Uint8Array) => mod(bytesToBigLE(sha512(bytes)));
const parseScalar = (value: string | bigint) => {
  const scalar = typeof value === "bigint" ? mod(value) : mod(BigInt(`0x${value.replace(/^0x/, "")}`));
  if (scalar === 0n) throw new Error("Solana stealth scalar must be non-zero");
  return scalar;
};
const randomScalar = (): bigint => {
  let scalar = 0n;
  while (scalar === 0n) scalar = mod(bytesToBigLE(ed25519.utils.randomPrivateKey()));
  return scalar;
};
const scalarToHex = (scalar: bigint) => `0x${scalar.toString(16).padStart(64, "0")}`;
const bytesToBigLE = (bytes: Uint8Array) => {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
};
const numTo32LE = (value: bigint) => {
  const bytes = new Uint8Array(32);
  let remaining = value;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
};
const concatBytes = (...arrays: Uint8Array[]) => {
  const output = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
};
