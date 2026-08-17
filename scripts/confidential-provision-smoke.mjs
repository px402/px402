/**
 * Slot provisioning — the two-signature ceremony
 * (spec-confidential-x402.md §5.2-P, §15.3 step 2).
 *
 * The server funds rent for accounts it did not build, on the say-so of an
 * agent, so every claim the payee makes is re-derived before a lamport is spent
 * or a slot is registered. Those re-derivations are what this file tests:
 *
 *   1. The address really derives from THIS payee's meta-address (else we fund
 *      accounts for someone else, or for nobody).
 *   2. The ATA is the one WE derive for (address, mint) — a payee-supplied
 *      account is where payments would land.
 *   3. `P` equals what the PROGRAM stored, read back after confirmation. The
 *      server can never compute `P` (`s⁻¹·H`, and it holds only a viewing key),
 *      so read-back is the only available check — and a complete one, since
 *      that stored key is exactly what the program enforces on a later transfer.
 *
 * Plus the thing that must never happen: the spending scalar leaving the payee.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { ConfidentialSlotBook } from "../src/server/payments/ConfidentialSlotBook.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { confidentialSlotProvisionIntentMessage } from "../src/shared/x402AgentIntent.ts";
import {
  deriveSlotDrafts,
  publishableSlots,
  assertNoScalarLeaked,
} from "../src/server/rails/confidentialSlotProvisioner.ts";
import { generateSolanaStealthKeys } from "../src/shared/stealthSolana.ts";
import { SOLANA_USDC } from "../src/shared/x402.ts";

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
};
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};
const eq = (actual, expected, message) =>
  assert(actual === expected, `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
const rejectsWith = async (fn, needle) => {
  try {
    await fn();
  } catch (error) {
    assert(String(error.message).includes(needle), `expected "${needle}", got: ${error.message}`);
    return;
  }
  throw new Error(`expected a refusal containing "${needle}", but it resolved`);
};

const root = await mkdtemp(join(tmpdir(), "confidential-provision-"));
const KEY = randomBytes(32).toString("hex");
const MINT = Keypair.generate().publicKey.toBase58();
const payeeKeys = generateSolanaStealthKeys();
const otherKeys = generateSolanaStealthKeys();

/**
 * Deterministic stand-ins for the WASM-backed derivations. The real ones live
 * behind `@solana/zk-sdk/bundler`; the contract under test here is the server's
 * verification, which treats both as opaque strings.
 */
const fakeElGamal = (draft) =>
  new PublicKey(
    Buffer.from(
      randomBytesFrom(`elgamal:${draft.stealthAddress}:${draft.mint}`),
    ),
  ).toBase58();
const fakeAta = ({ owner, mint }) =>
  new PublicKey(Buffer.from(randomBytesFrom(`ata:${owner}:${mint}`))).toBase58();

/** A deterministic 32 bytes from a label, so fixtures are reproducible. */
function randomBytesFrom(label) {
  const out = new Uint8Array(32);
  let hash = 2166136261;
  for (let i = 0; i < 32; i += 1) {
    for (const ch of `${label}:${i}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    out[i] = hash & 0xff;
  }
  return out;
}

let seq = 0;
/**
 * A rail stub standing in for the chain. `onchainOverride` lets a test make the
 * chain disagree with the payee's claim, which is the whole point.
 */
const stubRail = ({ provisionStatus = "provisioned", onchainOverride } = {}) => ({
  network: "solana",
  kind: "solana",
  tokenConfig: SOLANA_USDC,
  settlementMode: "dry-run",
  poolMode: "dry-run",
  poolAddress: "",
  depositCapable: false,
  confidentialMode: "onchain",
  confidentialMint: MINT,
  resolveConfidentialRecipient: () => { throw new Error("unused"); },
  ensureConfidentialAccount: async () => {},
  verifyConfidential: async () => ({ ok: true }),
  simulateConfidential: async () => ({ ok: true }),
  settleConfidential: async () => { throw new Error("unused"); },
  observeConfidential: async () => ({ kind: "ciphertext-present" }),
  provisionConfidentialSlots: async ({ addresses }) => {
    if (provisionStatus !== "provisioned") {
      return { status: "refused", signatures: [], detail: "simulated failure", onchain: [] };
    }
    return {
      status: "provisioned",
      signatures: ["sig-configure"],
      onchain: addresses.map((stealthAddress) => {
        const draft = draftsByAddress.get(stealthAddress);
        const base = {
          stealthAddress,
          tokenAccount: draft?.tokenAccount,
          encryptionPubKey: draft?.encryptionPubKey,
        };
        return onchainOverride ? onchainOverride(base) : base;
      }),
    };
  },
});

const draftsByAddress = new Map();

const newFixture = async ({ rail = stubRail(), withStealth = true, withPool = true } = {}) => {
  seq += 1;
  const ledger = await new PrivatePaymentLedger(join(root, `ledger-${seq}.json`), KEY, {
    journal: new EphemeralPaymentJournal(join(root, `epochs-${seq}`)),
    retentionMs: 60_000,
  }).load({});
  const slotBook = await new ConfidentialSlotBook(join(root, `slots-${seq}.json`), {
    encryptionKey: KEY,
    retentionMs: 900_000,
  }).load();
  const registry = new PrivateAgentRegistry([
    {
      agentId: "payee", label: "R", vpnIp: "127.0.0.1",
      walletAddress: payeeKeys.meta.spendingPubKey, sharedSecret: "r", credits: 0, inventory: [],
      ...(withStealth
        ? { solanaStealthMeta: payeeKeys.meta, solanaStealthViewingKey: payeeKeys.viewingScalar }
        : {}),
    },
  ], {
    requireIdentitySignatures: false,
    privateLedger: ledger,
    rails: new Map([["solana", rail]]),
    ...(withPool ? { confidentialSlots: slotBook } : {}),
  });
  return { registry, slotBook };
};

const makeDrafts = (keys = payeeKeys, count = 3) => {
  const drafts = deriveSlotDrafts({
    keys, mint: MINT, count,
    deriveEncryptionPubKey: fakeElGamal,
    deriveTokenAccount: fakeAta,
  });
  for (const draft of drafts) draftsByAddress.set(draft.stealthAddress, draft);
  return drafts;
};

const provision = (registry, slots, overrides = {}) => registry.provisionConfidentialSlots({
  payeeAgentId: "payee",
  network: "solana",
  slots,
  transactions: ["AQAAAA=="],
  intentNonce: `n-${randomBytes(8).toString("hex")}`,
  agentSignature: "unused",
  ...overrides,
}, "127.0.0.1");

/* ───────────── the payee half never leaks the spending key ───────────── */

await check("the published batch carries NO spending scalar", () => {
  const drafts = makeDrafts();
  const published = publishableSlots(drafts);
  assertNoScalarLeaked(published, drafts); // throws if any scalar appears
  for (const slot of published) {
    assert(!("stealthScalar" in slot), "the scalar must not survive projection");
  }
  eq(Object.keys(published[0]).length, 4, "exactly the four published fields");
});

await check("each slot gets a DISTINCT one-time address", () => {
  // Two slots sharing an address lets the first payer decrypt the second.
  const drafts = makeDrafts(payeeKeys, 8);
  eq(new Set(drafts.map((d) => d.stealthAddress)).size, 8, "no repeats");
  eq(new Set(drafts.map((d) => d.ephemeralPubKey)).size, 8, "distinct announcements too");
});

await check("a zero or negative batch count is refused", () => {
  for (const count of [0, -1, 1.5]) {
    let threw = false;
    try {
      deriveSlotDrafts({
        keys: payeeKeys, mint: MINT, count,
        deriveEncryptionPubKey: fakeElGamal, deriveTokenAccount: fakeAta,
      });
    } catch { threw = true; }
    assert(threw, `count ${count} must be refused`);
  }
});

/* ───────────── (1) the address must be THIS payee's ───────────── */

await check("a slot derived from ANOTHER payee's keys is refused before any rent", async () => {
  // Otherwise an agent has us fund accounts it does not own.
  const { registry } = await newFixture();
  const foreign = publishableSlots(makeDrafts(otherKeys, 2));
  await rejectsWith(() => provision(registry, foreign), "does not derive from this payee");
});

await check("a slot with a tampered address is refused", async () => {
  const { registry } = await newFixture();
  const slots = publishableSlots(makeDrafts(payeeKeys, 1));
  slots[0].stealthAddress = Keypair.generate().publicKey.toBase58();
  await rejectsWith(() => provision(registry, slots), "does not derive from this payee");
});

await check("a payee with no stealth meta-address cannot provision", async () => {
  const { registry } = await newFixture({ withStealth: false });
  await rejectsWith(() => provision(registry, publishableSlots(makeDrafts())), "confidential_requires_stealth");
});

await check("no slot pool configured ⇒ refused", async () => {
  const { registry } = await newFixture({ withPool: false });
  await rejectsWith(() => provision(registry, publishableSlots(makeDrafts())), "confidential_not_supported");
});

await check("an oversized batch is refused rather than funded", async () => {
  const { registry } = await newFixture();
  await rejectsWith(() => provision(registry, publishableSlots(makeDrafts(payeeKeys, 20))), "slot batch size");
});

await check("an empty batch is refused", async () => {
  const { registry } = await newFixture();
  await rejectsWith(() => provision(registry, []), "slot batch size");
});

/* ───────────── the happy path ───────────── */

await check("a verified batch registers and becomes available", async () => {
  const { registry, slotBook } = await newFixture();
  const drafts = makeDrafts(payeeKeys, 3);
  const result = await provision(registry, publishableSlots(drafts));
  eq(result.status, "provisioned", "provisioned");
  eq(result.registered, 3, "all three registered");
  eq(result.available, 3, "and all three are available to quote");
  for (const draft of drafts) {
    const stored = slotBook.all().find((s) => s.stealthAddress === draft.stealthAddress);
    assert(stored, `slot ${draft.stealthAddress} was not stored`);
    eq(stored.ephemeralPubKey, draft.ephemeralPubKey, "R stored — funds are unreachable without it");
    eq(stored.status, "available", "available");
  }
});

await check("re-submitting the same batch does not duplicate slots", async () => {
  const { registry, slotBook } = await newFixture();
  const slots = publishableSlots(makeDrafts(payeeKeys, 2));
  await provision(registry, slots);
  const second = await provision(registry, slots);
  eq(second.registered, 2, "idempotent registration still reports the batch");
  eq(slotBook.all().length, 2, "but the pool did not grow");
});

/* ───────────── (2) and (3): the chain overrules the payee ───────────── */

await check("an ATA that disagrees with OUR derivation is rejected", async () => {
  // A payee-supplied token account is where payments would land.
  const rail = stubRail({
    onchainOverride: (entry) => ({ ...entry, tokenAccount: Keypair.generate().publicKey.toBase58() }),
  });
  const { registry, slotBook } = await newFixture({ rail });
  const result = await provision(registry, publishableSlots(makeDrafts(payeeKeys, 2)));
  eq(result.registered, 0, "nothing registered");
  eq(slotBook.all().length, 0, "the pool stays empty");
  assert(result.rejected?.every((r) => r.endsWith("ata-mismatch")), JSON.stringify(result.rejected));
});

await check("an ElGamal key that disagrees with the PROGRAM is rejected", async () => {
  // The server cannot compute P, so what landed on-chain is the only authority.
  // Registering the claimed key instead would encrypt funds to a key nobody
  // holds — with no error anywhere.
  const rail = stubRail({
    onchainOverride: (entry) => ({ ...entry, encryptionPubKey: Keypair.generate().publicKey.toBase58() }),
  });
  const { registry, slotBook } = await newFixture({ rail });
  const result = await provision(registry, publishableSlots(makeDrafts(payeeKeys, 1)));
  eq(result.registered, 0, "nothing registered");
  eq(slotBook.all().length, 0, "the pool stays empty");
  assert(result.rejected?.[0]?.endsWith("elgamal-mismatch"), JSON.stringify(result.rejected));
});

await check("an account that never got configured is rejected", async () => {
  const rail = stubRail({ onchainOverride: (entry) => ({ ...entry, encryptionPubKey: undefined }) });
  const { registry } = await newFixture({ rail });
  const result = await provision(registry, publishableSlots(makeDrafts(payeeKeys, 1)));
  eq(result.registered, 0, "an unconfigured account cannot receive a confidential transfer");
  assert(result.rejected?.[0]?.endsWith("not-configured"), JSON.stringify(result.rejected));
});

await check("a batch is registered per-slot, not all-or-nothing", async () => {
  // One bad slot must not discard the good ones whose rent we already paid.
  const drafts = makeDrafts(payeeKeys, 3);
  const bad = drafts[1].stealthAddress;
  const rail = stubRail({
    onchainOverride: (entry) => entry.stealthAddress === bad
      ? { ...entry, encryptionPubKey: Keypair.generate().publicKey.toBase58() }
      : entry,
  });
  const { registry, slotBook } = await newFixture({ rail });
  const result = await provision(registry, publishableSlots(drafts));
  eq(result.registered, 2, "the two good slots survive");
  eq(result.rejected?.length, 1, "the bad one is reported");
  assert(!slotBook.all().some((s) => s.stealthAddress === bad), "and never stored");
});

await check("a failed broadcast registers nothing", async () => {
  const { registry, slotBook } = await newFixture({ rail: stubRail({ provisionStatus: "refused" }) });
  const result = await provision(registry, publishableSlots(makeDrafts(payeeKeys, 2)));
  eq(result.status, "refused", "refused");
  eq(result.registered, 0, "a slot registered before confirmation is one a payer could pay into a void");
  eq(slotBook.all().length, 0, "pool untouched");
});

/* ───────────── the signed intent binds the addresses ───────────── */

await check("the provisioning intent BINDS the addresses, not just a count", () => {
  // We pay rent per account, so a swappable address list means funding accounts
  // for a payee that never asked.
  const base = {
    payeeAgentId: "payee", network: "solana", mint: MINT, intentNonce: "n",
    stealthAddresses: ["addr-a", "addr-b"],
  };
  const swapped = { ...base, stealthAddresses: ["addr-a", "addr-c"] };
  assert(
    confidentialSlotProvisionIntentMessage(base) !== confidentialSlotProvisionIntentMessage(swapped),
    "an unbound address list lets a transport redirect the rent we fund",
  );
});

/* ───────────── pool depth ───────────── */

await check("pool depth is observable so exhaustion can be seen coming", async () => {
  const { registry } = await newFixture();
  eq(registry.confidentialSlotDepth("solana").available, 0, "starts empty");
  await provision(registry, publishableSlots(makeDrafts(payeeKeys, 3)));
  const depth = registry.confidentialSlotDepth("solana");
  eq(depth.available, 3, "available");
  eq(depth.total, 3, "total");
});

await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
