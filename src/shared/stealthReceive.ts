import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

/**
 * The Phase 4a browser credential — and ONLY that.
 *
 * A browser that wants to watch its stealth inbox needs to authenticate every
 * read, because peer IP is not available off the WireGuard channel and a session
 * id is not a credential (it is broadcast to every client every tick). So the
 * browser holds a key. The question is which one.
 *
 * It holds `inboxIdentityKey`: 32 random bytes from the platform CSPRNG, with NO
 * derivational relationship to any spending key. Deriving it from the stealth
 * seed would be cryptographically safe — keccak is one-way, so a derived inbox
 * key leaks nothing about the seed — but it would force the seed to exist on the
 * origin merely to produce a READ credential, collapsing the 4a/4b split that is
 * the whole point of shipping the read surface first. Independence is the point.
 *
 * What this key can do: enumerate the announcements owed to one paired agent.
 * What it cannot do: derive a stealth private key, spend, or complete a claim.
 * Those need `kSpend`, which under 4a exists nowhere in the browser. See
 * spec-stealth-inbox-phase4.md §2 and SI-34/SI-36.
 *
 * Deliberately @noble-only, no `ethers`. Nothing under `src/client` imports
 * ethers today, and pulling it into a browser bundle to produce one signature
 * would be a real size regression. Interop with the
 * server's `verifyMessage` is proven by the recovery round-trip in
 * `scripts/stealth-inbox-browser-smoke.mjs`.
 */

const N = secp256k1.CURVE.n;

export const STEALTH_RECEIVE_SCHEME = "px402-stealth-receive/v1";

export interface StealthInboxIdentity {
  /** 0x-hex, 32 bytes. Read authority for one paired agent. Never spend authority. */
  inboxIdentityKey: string;
  /** EIP-55 checksummed address the server pins the pairing to. */
  inboxIdentityAddress: string;
}

const strip0x = (value: string) => (value.startsWith("0x") ? value.slice(2) : value);

const bytesToHex = (bytes: Uint8Array) => {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

const hexToBytes = (value: string) => {
  const hex = strip0x(value);
  if (hex.length % 2 !== 0) throw new Error("Odd-length hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Invalid hex string");
    out[i] = byte;
  }
  return out;
};

/**
 * EIP-55 checksum, implemented here rather than imported from ethers so this
 * module stays browser-cheap. Matches `ethers.getAddress` — asserted in the
 * smoke suite against a set of addresses rather than assumed.
 */
export const toChecksumAddress = (address: string): string => {
  const lower = strip0x(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error("Invalid address");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i += 1) {
    out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
};

/** Address controlled by a secp256k1 private key. */
export const stealthInboxAddressForKey = (privateKey: string): string => {
  const key = hexToBytes(privateKey);
  if (key.length !== 32) throw new Error("Inbox identity key must be 32 bytes");
  // Uncompressed pubkey is 0x04 || X || Y; the address is the low 20 bytes of
  // keccak over X||Y, so the leading tag byte is dropped.
  const pub = secp256k1.getPublicKey(key, false);
  return toChecksumAddress(bytesToHex(keccak_256(pub.slice(1)).slice(-20)));
};

/**
 * 4a credential generation. `crypto.getRandomValues` in the browser,
 * `webcrypto` in Node — both platform CSPRNGs, neither seeded from anything we
 * control. Rejects a key outside [1, n-1] by regenerating rather than clamping,
 * because clamping would bias the distribution.
 */
export const generateStealthInboxIdentity = (): StealthInboxIdentity => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const key = new Uint8Array(32);
    globalThis.crypto.getRandomValues(key);
    const scalar = BigInt("0x" + bytesToHex(key));
    if (scalar === 0n || scalar >= N) continue;
    const inboxIdentityKey = "0x" + bytesToHex(key);
    return { inboxIdentityKey, inboxIdentityAddress: stealthInboxAddressForKey(inboxIdentityKey) };
  }
  // Probability ~2^-256 per attempt; reaching here means the CSPRNG is broken,
  // and silently continuing would mint a predictable credential.
  throw new Error("Failed to generate a valid inbox identity key");
};

/**
 * EIP-191 personal_sign over `message`, recoverable by `ethers.verifyMessage`.
 *
 * The prefix length is the UTF-8 BYTE length, not the code-point length. Our
 * intent messages are JSON that can carry a non-ASCII agent label, so getting
 * this wrong would produce signatures that verify in ASCII tests and fail in
 * production. Covered by a Unicode case in the smoke suite.
 */
export const signStealthInboxMessage = (privateKey: string, message: string): string => {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix, 0);
  payload.set(body, prefix.length);
  const signature = secp256k1.sign(keccak_256(payload), hexToBytes(privateKey));
  // v = 27 + recovery, matching the Ethereum convention verifyMessage expects.
  return "0x" + signature.toCompactHex() + (27 + signature.recovery).toString(16).padStart(2, "0");
};
