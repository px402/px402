/**
 * The confidential rail wired into PrivateAgentRegistry
 * (spec-confidential-x402.md §15.3 step 1).
 *
 * Three properties are worth a test here, and the rest is plumbing:
 *   1. A downgrade is REFUSED, never silently served as `exact`. A payer that
 *      believes it bought confidentiality and gets a plaintext quote is worse
 *      off than one that got an error, because it will pay.
 *   2. Two payments never receive the same slot — sharing one lets the first
 *      payer decrypt the second.
 *   3. The announcement is written with `confidentiality: "confidential"` (B3).
 *      Without it the inbox reads the by-construction zero as "provably
 *      drained" and reaps the only copy of `R` about a day later, silently.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { ConfidentialSlotBook } from "../src/server/payments/ConfidentialSlotBook.ts";
import { InboundAnnouncementBook } from "../src/server/payments/InboundAnnouncementBook.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { x402QuoteIntentMessage } from "../src/shared/x402AgentIntent.ts";
import {
  generateSolanaStealthKeys,
  deriveSolanaStealthAddress,
} from "../src/shared/stealthSolana.ts";
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
const rejectsWith = async (fn, code) => {
  try {
    await fn();
  } catch (error) {
    assert(String(error.message).includes(code), `expected ${code}, got: ${error.message}`);
    return;
  }
  throw new Error(`expected a refusal with ${code}, but it resolved`);
};

const root = await mkdtemp(join(tmpdir(), "confidential-wiring-"));
const KEY = randomBytes(32).toString("hex");
const MINT = Keypair.generate().publicKey.toBase58();
const NOW = 1_900_000_000;
const payeeKeys = generateSolanaStealthKeys();

let seq = 0;
const b58 = () => Keypair.generate().publicKey.toBase58();

/** A slot as the payee would publish it after provisioning on-chain. */
const provisionedSlot = (accountId) => {
  const derived = deriveSolanaStealthAddress(payeeKeys.meta);
  return {
    accountId,
    network: "solana",
    caip2: SOLANA_USDC.caip2,
    mint: MINT,
    stealthAddress: derived.stealthAddress,
    ephemeralPubKey: derived.ephemeralPubKey,
    encryptionPubKey: b58(),
    tokenAccount: b58(),
  };
};

/** A minimal confidential-capable rail: only what the registry actually calls. */
const stubConfidentialRail = ({ settleResult, onWriteAhead } = {}) => {
  const log = { ensured: 0, settled: 0, writeAheadBeforeSettle: null };
  return {
    log,
    network: "solana",
    kind: "solana",
    tokenConfig: SOLANA_USDC,
    settlementMode: "dry-run",
    poolMode: "dry-run",
    poolAddress: "",
    depositCapable: false,
    confidentialMode: "onchain",
    resolveConfidentialRecipient: ({ requirements }) => ({
      recipient: requirements.payTo,
      stealth: {
        stealthAddress: requirements.payTo,
        ephemeralPubKey: requirements.ephemeralPubKey,
      },
      confidential: { encryptionPubKey: requirements.encryptionPubKey },
    }),
    ensureConfidentialAccount: async () => { log.ensured += 1; },
    verifyConfidential: async () => ({ ok: true }),
    simulateConfidential: async () => ({ ok: true }),
    observeConfidential: async () => ({ kind: "ciphertext-present" }),
    settleConfidential: async ({ requirements, writeAheadAnnouncement }) => {
      log.writeAheadBeforeSettle = log.settled === 0;
      await writeAheadAnnouncement();
      if (onWriteAhead) await onWriteAhead();
      log.settled += 1;
      return settleResult ?? {
        settlement: {
          settlement: "onchain",
          network: "solana",
          asset: requirements.asset,
          from: "payer",
          to: requirements.payTo,
          value: requirements.maxAmountRequired,
          authorizationNonce: requirements.nonce,
          transactionHash: "sig-transfer",
        },
        stealth: {
          stealthAddress: requirements.payTo,
          ephemeralPubKey: requirements.ephemeralPubKey,
        },
      };
    },
  };
};

const newFixture = async ({
  rail = stubConfidentialRail(), slots = 2, withStealth = true, withSlotBook = true, payout, payoutQueue,
} = {}) => {
  seq += 1;
  const ledger = await new PrivatePaymentLedger(join(root, `ledger-${seq}.json`), KEY, {
    journal: new EphemeralPaymentJournal(join(root, `epochs-${seq}`)),
    retentionMs: 60_000,
  }).load({});
  const announcements = await new InboundAnnouncementBook(join(root, `inbox-${seq}.json`), {
    encryptionKey: KEY,
    retentionMs: 900_000,
    dormantMs: 86_400_000,
  }).load();
  const slotBook = await new ConfidentialSlotBook(join(root, `slots-${seq}.json`), {
    encryptionKey: KEY,
    retentionMs: 900_000,
  }).load();
  const accountId = ledger.accountReference("payee");
  if (slots > 0) {
    await slotBook.addMany(Array.from({ length: slots }, () => provisionedSlot(accountId)));
  }
  const registry = new PrivateAgentRegistry([
    { agentId: "payer", label: "P", vpnIp: "127.0.0.1", walletAddress: b58(), sharedSecret: "p", credits: 0, inventory: [] },
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
    inboundAnnouncements: announcements,
    rails: new Map([["solana", rail]]),
    ...(payout ? { payout } : {}),
    ...(payoutQueue ? { payoutQueue } : {}),
    ...(withSlotBook ? { confidentialSlots: slotBook } : {}),
  });
  return { registry, slotBook, announcements, ledger, rail };
};

const quote = (registry, overrides = {}) => registry.quoteX402(
  {
    payeeAgentId: "payee",
    payerAgentId: "payer",
    amountAtomic: "137000000",
    resource: "px402:confidential",
    intentNonce: `n-${randomBytes(8).toString("hex")}`,
    agentSignature: "unused",
    scheme: "confidential",
    ...overrides,
  },
  "127.0.0.1",
  SOLANA_USDC,
  NOW,
);

/* ───────────── a downgrade is refused, never served ───────────── */

await check("no confidential-capable rail ⇒ REFUSED, not silently served as exact", async () => {
  // A plain rail without settleConfidential must not answer a confidential ask.
  const plain = { ...stubConfidentialRail() };
  delete plain.settleConfidential;
  delete plain.observeConfidential;
  const { registry } = await newFixture({ rail: plain });
  await rejectsWith(() => quote(registry), "confidential_not_supported");
});

await check("no slot pool configured ⇒ refused", async () => {
  const { registry } = await newFixture({ withSlotBook: false });
  await rejectsWith(() => quote(registry), "confidential_not_supported");
});

await check("§3.2 — a payee without a stealth meta-address is refused", async () => {
  // Confidential-without-stealth hides the value but publishes a persistent,
  // reusable receiver — exactly the linkage the rest of the stack removes.
  const { registry } = await newFixture({ withStealth: false });
  await rejectsWith(() => quote(registry), "confidential_requires_stealth");
});

await check("an exhausted slot pool refuses rather than reusing a slot", async () => {
  const { registry } = await newFixture({ slots: 1 });
  await quote(registry);
  await rejectsWith(
    () => quote(registry, { resource: "second", amountAtomic: "1" }),
    "confidential_not_supported",
  );
});

/* ───────────── the quote publishes exactly the §5.2-P slot ───────────── */

await check("a confidential quote publishes R, P and the destination ATA", async () => {
  const { registry, slotBook } = await newFixture();
  const requirements = await quote(registry);
  eq(requirements.scheme, "confidential", "scheme");
  eq(requirements.network, "solana", "network");
  eq(requirements.asset, MINT, "the confidential mint, not USDC-SPL");
  const slot = slotBook.all().find((s) => s.stealthAddress === requirements.payTo);
  assert(slot, "the quote must name a real provisioned slot");
  eq(requirements.ephemeralPubKey, slot.ephemeralPubKey, "R — without it the payee cannot locate the address");
  eq(requirements.encryptionPubKey, slot.encryptionPubKey, "P");
  eq(requirements.destinationTokenAccount, slot.tokenAccount, "destination ATA");
  eq(slot.status, "reserved", "the slot is held, not still on offer");
});

await check("two quotes NEVER receive the same slot", async () => {
  // Sharing one slot lets the first payer decrypt the second payment.
  const { registry } = await newFixture({ slots: 2 });
  const first = await quote(registry, { resource: "a" });
  const second = await quote(registry, { resource: "b" });
  assert(first.payTo !== second.payTo, "THE invariant: one slot, one payment");
  assert(first.nonce !== second.nonce, "and distinct quote nonces");
});

await check("the quoted stealth address really belongs to this payee", async () => {
  const { registry, rail } = await newFixture();
  const requirements = await quote(registry);
  // The rail recomputes it from R + the viewing key; a slot that is not the
  // payee's would be refused there rather than paid.
  const recipient = rail.resolveConfidentialRecipient({ requirements, payee: {} });
  eq(recipient.recipient, requirements.payTo, "recipient matches the quote");
});

/* ───────────── the signed intent binds the scheme ───────────── */

await check("the signed quote intent BINDS the scheme (downgrade attack)", () => {
  const base = {
    payeeAgentId: "payee", payerAgentId: "payer", amountAtomic: "1",
    resource: "r", validForSeconds: 600, network: "solana", intentNonce: "n",
  };
  const asExact = x402QuoteIntentMessage(base);
  const asConfidential = x402QuoteIntentMessage({ ...base, scheme: "confidential" });
  assert(asExact !== asConfidential,
    "an unbound scheme lets a transport rewrite confidential->exact and publish the amount");
  assert(asConfidential.includes('"scheme":"confidential"'), asConfidential);
});

await check("an `exact` intent message is byte-identical to the pre-scheme format", () => {
  // Every existing signature was produced over a message with no scheme field.
  // Emitting one unconditionally would invalidate all of them.
  const base = {
    payeeAgentId: "payee", payerAgentId: "payer", amountAtomic: "1",
    resource: "r", validForSeconds: 600, network: "base", intentNonce: "n",
  };
  eq(x402QuoteIntentMessage(base), x402QuoteIntentMessage({ ...base, scheme: "exact" }),
    "absent and \"exact\" must be the same request");
  assert(!x402QuoteIntentMessage(base).includes("scheme"), "no scheme key for exact");
});

/* ───────────── pay routes by the QUOTE and writes B3 ───────────── */

await check("paying a confidential quote writes the announcement as CONFIDENTIAL (B3)", async () => {
  const { registry, announcements } = await newFixture();
  const requirements = await quote(registry);
  const receipt = await registry.payX402(
    { payment: { scheme: "confidential", transactions: ["AQ=="] }, requirementsNonce: requirements.nonce, agentSignature: "unused" },
    "127.0.0.1",
    { tokenConfig: SOLANA_USDC },
    NOW,
  );
  eq(receipt.kind, "x402", "a receipt is returned");
  eq(receipt.stealthAddress, requirements.payTo, "the receipt carries the one-time address");
  const record = announcements.all().find((r) => r.stealthAddress === requirements.payTo);
  assert(record, "the announcement was indexed");
  eq(record.confidentiality, "confidential",
    "B3: 'plain' here makes the book reap the only copy of R about a day later");
  eq(record.expectedAmountAtomic, null,
    "a confidential leg has no knowable amount; a number would be a claim the chain cannot support");
});

await check("the announcement is durable BEFORE the rail may broadcast", async () => {
  const { registry, rail } = await newFixture();
  const requirements = await quote(registry);
  await registry.payX402(
    { payment: { scheme: "confidential", transactions: ["AQ=="] }, requirementsNonce: requirements.nonce, agentSignature: "unused" },
    "127.0.0.1", { tokenConfig: SOLANA_USDC }, NOW,
  );
  eq(rail.log.writeAheadBeforeSettle, true, "ordering is enforced by settleConfidential's signature");
  eq(rail.log.ensured, 1, "the slot account was verified to exist before paying it");
});

await check("a failed announcement write aborts the payment", async () => {
  const rail = stubConfidentialRail();
  const { registry } = await newFixture({ rail });
  const requirements = await quote(registry);
  // Simulate the durable write failing inside the rail's write-ahead.
  rail.settleConfidential = async ({ writeAheadAnnouncement }) => {
    await writeAheadAnnouncement();
    throw new Error("broadcast must not have happened");
  };
  let threw = false;
  try {
    await registry.payX402(
      { payment: { scheme: "confidential", transactions: ["AQ=="] }, requirementsNonce: requirements.nonce, agentSignature: "unused" },
      "127.0.0.1", { tokenConfig: SOLANA_USDC }, NOW,
    );
  } catch { threw = true; }
  assert(threw, "the failure must propagate rather than returning a settled receipt");
});

await check("a confidential quote is one-shot", async () => {
  const { registry } = await newFixture();
  const requirements = await quote(registry);
  const pay = () => registry.payX402(
    { payment: { scheme: "confidential", transactions: ["AQ=="] }, requirementsNonce: requirements.nonce, agentSignature: "unused" },
    "127.0.0.1", { tokenConfig: SOLANA_USDC }, NOW,
  );
  await pay();
  await rejectsWith(pay, "No outstanding x402 quote");
});

await check("a confidential quote is NEVER advertised a denomination ladder", async () => {
  // The confidential scheme hides the AMOUNT, so there is nothing to split into
  // standard legs and its settlement path never builds a payout plan. But
  // buildConfidentialQuote sets a stealthMetaAddress of its own, and the ladder
  // used to be attached on that condition alone — so a confidential quote came
  // back carrying a payoutPolicy no confidential payer can use, inviting a client
  // down the pool-payout path instead (spec-exit-rounds.md §3.4).
  // A payout policy IS configured here, so removing the scheme check really does
  // attach a ladder — without this the test passes vacuously.
  const payout = {
    enabled: true,
    policyVersion: "denom/v1",
    byNetwork: new Map([["solana", { denominationsAtomic: [100_000n, 1_000_000n], maxLegs: 3 }]]),
  };
  const { registry } = await newFixture({ payout });
  const requirements = await quote(registry);
  eq(requirements.scheme, "confidential", "fixture really is confidential");
  assert(requirements.stealthMetaAddress !== undefined,
    "the quote DOES carry a stealth meta — the condition that used to attach the ladder");
  eq(requirements.payoutPolicy, undefined, "no ladder on a confidential quote");

  // Control: this registry really does have a ladder to advertise, so the absence
  // above is the scheme check doing its job rather than an unconfigured fixture.
  const advertised = registry.payoutPolicyAdvertisement("solana", "127.0.0.1");
  assert(advertised.policy !== null, "the fixture HAS a payout policy configured");
  eq(advertised.policy.maxLegs, 3, "and it is the configured one");
});

await check("the transparent pool payout path refuses a confidential quote", async () => {
  // A queue that explodes if touched, so this also proves the refusal happens BEFORE
  // any debit or enqueue — not after the money has already been reserved.
  const payoutQueue = {
    enqueueGroup: () => { throw new Error("the payout queue must never be reached"); },
    claim: () => { throw new Error("the payout queue must never be reached"); },
    flushGroup: () => { throw new Error("the payout queue must never be reached"); },
  };
  const { registry } = await newFixture({ payoutQueue });
  const requirements = await quote(registry);
  eq(requirements.scheme, "confidential", "fixture really is confidential");
  // A confidential quote carries a real maxAmountRequired and a stealth meta, so the
  // pool path would happily settle it — publishing on chain the exact amount the
  // payee demanded be hidden, burning the reserved slot, and silently downgrading the
  // scheme. payX402 already routes by the QUOTE's scheme for this reason; the pool
  // paths resolved a quote by nonce and never looked.
  let message = "";
  try {
    await registry.enqueuePoolPayout(
      {
        payerAgentId: "payer",
        payeeAgentId: "payee",
        quoteNonce: requirements.nonce,
        agentSignature: "unused",
      },
      "127.0.0.1",
      NOW,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(/refuses a confidential quote/.test(message),
    `the pool path must refuse a confidential quote by SCHEME, got: ${message || "no error"}`);
});

await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
