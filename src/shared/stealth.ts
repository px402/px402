import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, getBytes, hexlify, computeAddress, getAddress, SigningKey } from "ethers";

// EIP-5564 stealth addresses (secp256k1 scheme). Gives RECIPIENT unlinkability:
// each payment goes to a fresh one-time address that only the recipient can
// detect and spend from, and which observers cannot tie back to the recipient's
// identity. Does NOT hide the payer or the amount — those need address rotation
// on the payer side (Phase 2) and ZK (not in scope). The ephemeral pubkey
// ("announcement") is delivered privately over the WireGuard channel rather than
// posted to a public ERC-5564 Announcer, so there is no public scan surface.

const { ProjectivePoint } = secp256k1;
const N = secp256k1.CURVE.n;

export interface StealthMetaAddress {
  spendingPubKey: string; // compressed secp256k1 pubkey, 0x-hex (33 bytes)
  viewingPubKey: string; // compressed secp256k1 pubkey, 0x-hex (33 bytes)
}

export interface StealthKeys {
  spendingKey: string; // 0x-hex 32 bytes — SPEND authority, keep secret
  viewingKey: string; // 0x-hex 32 bytes — DETECT only, shareable with a scanner
  meta: StealthMetaAddress;
}

export interface StealthDerivation {
  stealthAddress: string; // checksummed address to pay
  ephemeralPubKey: string; // compressed, 0x-hex — the announcement
  viewTag: number; // 0..255 — fast scan filter (first byte of the shared-secret hash)
}

// keccak output -> a valid secp256k1 scalar in [1, n-1]
const toScalar = (hash32: string): bigint => {
  const v = BigInt(hash32) % N;
  return v === 0n ? 1n : v;
};

const pointFrom = (compressedHex: string) => ProjectivePoint.fromHex(strip0x(compressedHex));
const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

/** Recipient one-time setup: generate spend + view keypairs and the meta-address. */
export const generateStealthKeys = (): StealthKeys => {
  const spend = secp256k1.utils.randomPrivateKey();
  const view = secp256k1.utils.randomPrivateKey();
  return {
    spendingKey: hexlify(spend),
    viewingKey: hexlify(view),
    meta: {
      spendingPubKey: hexlify(secp256k1.getPublicKey(spend, true)),
      viewingPubKey: hexlify(secp256k1.getPublicKey(view, true))
    }
  };
};

/**
 * SENDER: derive a fresh one-time stealth address for a recipient's meta-address.
 * `ephemeralPriv` is injectable for deterministic tests; omit for production.
 */
export const deriveStealthAddress = (meta: StealthMetaAddress, ephemeralPriv?: string): StealthDerivation => {
  const r = ephemeralPriv ? getBytes(ephemeralPriv) : secp256k1.utils.randomPrivateKey();
  const rScalar = BigInt(hexlify(r));
  const ephemeralPubKey = hexlify(secp256k1.getPublicKey(r, true));

  const sharedSecret = pointFrom(meta.viewingPubKey).multiply(rScalar); // S = r * Pview
  const sHash = keccak256(sharedSecret.toRawBytes(true));
  const viewTag = getBytes(sHash)[0];

  const stealthPoint = pointFrom(meta.spendingPubKey).add(ProjectivePoint.BASE.multiply(toScalar(sHash))); // Pspend + sHash*G
  const stealthAddress = computeAddress("0x" + stealthPoint.toHex(false));
  return { stealthAddress, ephemeralPubKey, viewTag };
};

/**
 * RECIPIENT (detect): using the VIEWING key + SPENDING PUBKEY, recompute the
 * stealth address for an announcement. No spend authority needed — a scanner
 * (or the registry, to verify a pay-to-stealth) can run this. Caller confirms
 * by comparing `stealthAddress` to the address that actually received funds.
 */
export const checkStealthAddress = (input: {
  ephemeralPubKey: string;
  viewingKey: string;
  spendingPubKey: string;
  viewTag?: number;
}): { viewTagMatches: boolean; stealthAddress: string } => {
  const sharedSecret = pointFrom(input.ephemeralPubKey).multiply(BigInt(input.viewingKey)); // S = kView * R
  const sHash = keccak256(sharedSecret.toRawBytes(true));
  const viewTagMatches = input.viewTag === undefined ? true : getBytes(sHash)[0] === input.viewTag;
  const stealthPoint = pointFrom(input.spendingPubKey).add(ProjectivePoint.BASE.multiply(toScalar(sHash)));
  return { viewTagMatches, stealthAddress: computeAddress("0x" + stealthPoint.toHex(false)) };
};

/**
 * RECIPIENT (spend): derive the one-time private key that controls the stealth
 * address, using the SPENDING key. Needs spend authority — only the recipient
 * agent runs this, to sweep funds out of the stealth address.
 */
export const computeStealthPrivateKey = (input: { ephemeralPubKey: string; viewingKey: string; spendingKey: string }): string => {
  const sharedSecret = pointFrom(input.ephemeralPubKey).multiply(BigInt(input.viewingKey));
  const sHash = keccak256(sharedSecret.toRawBytes(true));
  const kStealth = (BigInt(input.spendingKey) + toScalar(sHash)) % N;
  return "0x" + kStealth.toString(16).padStart(64, "0");
};

/** Address controlled by a private key — convenience for verifying a swept key. */
export const addressForPrivateKey = (privateKey: string): string => getAddress(computeAddress(new SigningKey(privateKey).publicKey));
