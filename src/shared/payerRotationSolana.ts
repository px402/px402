import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { Keypair } from "@solana/web3.js";

interface Slip10Node {
  key: Uint8Array;
  chain: Uint8Array;
}

export interface SolanaPayerPool {
  seed: string;
  nextIndex: number;
}

export const createSolanaPayerPool = (): SolanaPayerPool => ({
  seed: bytesToHex(ed25519.utils.randomPrivateKey()),
  nextIndex: 0
});

export const restoreSolanaPayerPool = (seed: string, nextIndex = 0): SolanaPayerPool => {
  assertIndex(nextIndex);
  normalizeSeed(seed);
  return { seed: seed.replace(/^0x/, "").toLowerCase(), nextIndex };
};

export const deriveSolanaPayerSeed = (seed: string | Uint8Array, index: number): Uint8Array => {
  assertIndex(index);
  let node = master(normalizeSeed(seed));
  for (const component of [44, 501, index, 0]) node = ckd(node, component);
  return node.key;
};

export const deriveSolanaPayerKeypair = (seed: string | Uint8Array, index: number): Keypair =>
  Keypair.fromSeed(deriveSolanaPayerSeed(seed, index));

export const nextSolanaPayerKeypair = (pool: SolanaPayerPool): {
  keypair: Keypair;
  index: number;
  pool: SolanaPayerPool;
} => {
  const index = pool.nextIndex;
  return {
    keypair: deriveSolanaPayerKeypair(pool.seed, index),
    index,
    pool: { ...pool, nextIndex: index + 1 }
  };
};

const master = (seed: Uint8Array): Slip10Node => splitNode(hmac(sha512, utf8ToBytes("ed25519 seed"), seed));

const ckd = (node: Slip10Node, index: number): Slip10Node => {
  assertIndex(index);
  const hardened = (index | 0x80000000) >>> 0;
  return splitNode(hmac(sha512, node.chain, concatBytes(new Uint8Array([0]), node.key, ser32BE(hardened))));
};

const splitNode = (bytes: Uint8Array): Slip10Node => ({ key: bytes.slice(0, 32), chain: bytes.slice(32, 64) });
const normalizeSeed = (seed: string | Uint8Array) => {
  const bytes = typeof seed === "string" ? hexToBytes(seed.replace(/^0x/, "")) : new Uint8Array(seed);
  if (bytes.length < 16) throw new Error("Solana payer rotation seed must be at least 128 bits");
  return bytes;
};
const assertIndex = (index: number) => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("Solana payer rotation index must be a non-negative hardened child index");
  }
};
const ser32BE = (value: number) => new Uint8Array([
  value >>> 24,
  value >>> 16,
  value >>> 8,
  value
]);
const concatBytes = (...arrays: Uint8Array[]) => {
  const output = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
};
