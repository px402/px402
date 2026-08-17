// Phase 1 of spec-stealth-inbox: the payee-facing announcement index.
//
// The defect under test (D1): a stealth one-time key is kSpend + H(kView*R).
// Without R the payee cannot derive it OR EVEN LOCATE THE ADDRESS, and the
// payout ACK carrying R goes to the PAYER. So without this index, money paid to
// a payee is unreachable by them forever.
//
//   npm run test:stealth:inbox
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { BASE_USDC } from "../src/shared/x402.ts";
import {
  addressForPrivateKey,
  computeStealthPrivateKey,
  deriveStealthAddress,
  generateStealthKeys,
} from "../src/shared/stealth.ts";
import {
  legacyPrivateLedgerDepositIntentMessage,
  privateLedgerDepositIntentMessage,
  stealthInboxIntentMessage,
} from "../src/shared/x402AgentIntent.ts";
import { InboundAnnouncementBook } from "../src/server/payments/InboundAnnouncementBook.ts";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";

const root = await mkdtemp(join(tmpdir(), "stealth-inbox-smoke-"));
const KEY = randomBytes(32).toString("hex");
const tests = [];
let passed = 0;
let failed = 0;

const test = (name, run) => tests.push({ name, run });
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};
const rejects = async (operation, pattern) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `expected /${pattern.source}/, got: ${message}`);
    return;
  }
  throw new Error("expected rejection but the call resolved");
};

let bookSeq = 0;
const newBook = async (options = {}) => {
  bookSeq += 1;
  const path = join(root, `book-${bookSeq}.json`);
  const book = await new InboundAnnouncementBook(path, {
    retentionMs: 900_000,
    dormantMs: 86_400_000,
    encryptionKey: KEY,
    ...options,
  }).load();
  return { book, path };
};

const accountFor = (agentId) =>
  `acct_${createHmac("sha256", "test-account-key").update(agentId).digest("hex")}`;

const announcement = (overrides = {}) => ({
  accountId: accountFor("payee"),
  network: "base",
  caip2: BASE_USDC.caip2,
  tokenAddress: BASE_USDC.address.toLowerCase(),
  stealthAddress: Wallet.createRandom().address,
  ephemeralPubKey: `0x${randomBytes(33).toString("hex")}`,
  expectedAmountAtomic: "200000",
  source: "pool-payout",
  sourceRef: `group-${randomBytes(8).toString("hex")}:0`,
  ...overrides,
});

// ---------------------------------------------------------------- book

test("addMany persists the announcement and is idempotent per (network, sourceRef)", async () => {
  const { book } = await newBook();
  const entry = announcement();
  const first = await book.addMany([entry]);
  const second = await book.addMany([entry]);
  assert(first.length === 1 && second.length === 1);
  assert(first[0].id === second[0].id, "retry created a duplicate record");
  assert(book.all().length === 1, "book holds a duplicate");
  assert(first[0].ephemeralPubKey === entry.ephemeralPubKey);
  assert(first[0].status === "announced");
  await book.close();
});

test("an announcement survives a restart (this is the whole point)", async () => {
  const { book, path } = await newBook();
  const entry = announcement();
  await book.addMany([entry]);
  await book.close();

  const reopened = await new InboundAnnouncementBook(path, {
    retentionMs: 900_000,
    dormantMs: 86_400_000,
    encryptionKey: KEY,
  }).load();
  const records = reopened.forAccount(entry.accountId);
  assert(records.length === 1, "announcement did not survive restart");
  assert(records[0].ephemeralPubKey === entry.ephemeralPubKey, "announcement was corrupted");
  assert(records[0].stealthAddress === entry.stealthAddress);
  await reopened.close();
});

test("the book is encrypted at rest and does not leak the announcement", async () => {
  const { book, path } = await newBook();
  const entry = announcement();
  await book.addMany([entry]);
  await book.close();
  const raw = await (await import("node:fs/promises")).readFile(path, "utf8");
  const payload = JSON.parse(raw);
  assert(payload.algorithm === "aes-256-gcm", "book is not encrypted");
  assert(!raw.includes(entry.ephemeralPubKey), "announcement leaked in plaintext");
  assert(!raw.includes(entry.stealthAddress), "stealth address leaked in plaintext");
});

test("a funded record is NEVER reaped", async () => {
  const { book } = await newBook({ dormantMs: 0, retentionMs: 0 });
  const [record] = await book.addMany([announcement()]);
  await book.observe(record.id, 200_000n);
  const removed = await book.reap(Date.now() + 10 * 86_400_000);
  assert(removed === 0, "reaped a record that still holds funds");
  assert(book.byId(record.id) !== undefined, "funded record disappeared");
  await book.close();
});

test("a never-observed record is NEVER reaped (it could still hold funds)", async () => {
  const { book } = await newBook({ dormantMs: 0, retentionMs: 0 });
  const [record] = await book.addMany([announcement()]);
  await book.reap(Date.now() + 10 * 86_400_000);
  assert(book.byId(record.id) !== undefined, "reaped an unchecked record");
  await book.close();
});

test("a confirmed-empty record goes dormant and only then reaps", async () => {
  const { book } = await newBook({ dormantMs: 0 });
  const [record] = await book.addMany([announcement()]);
  const observed = await book.observe(record.id, 0n);
  assert(observed.status === "dormant", `expected dormant, got ${observed.status}`);
  const removed = await book.reap(Date.now() + 1000);
  assert(removed === 1, "confirmed-empty dormant record was not reaped");
  await book.close();
});

/* ── B3 (spec-confidential-x402.md) — a confidential output must never be reaped ── */

test("B3: a confidential output reads zero forever and NEVER goes dormant", async () => {
  const { book } = await newBook({ dormantMs: 0 }); // dormancy grace already elapsed
  const [record] = await book.addMany([announcement({ confidentiality: "confidential" })]);
  // The plaintext balance of a confidential output is 0 by construction, forever.
  const observed = await book.observe(record.id, 0n);
  assert(observed.status === "announced",
    `a zero read is not evidence of emptiness for a confidential output (got ${observed.status})`);
  assert(observed.anomaly === null, "and it must not be misread as a drain");
  await book.close();
});

test("B3: a confidential output survives reap past the dormancy grace (fund loss)", async () => {
  const { book } = await newBook({ dormantMs: 0, retentionMs: 0 });
  const [confidential] = await book.addMany([announcement({ confidentiality: "confidential" })]);
  const [plain] = await book.addMany([announcement()]);
  await book.observe(confidential.id, 0n);
  await book.observe(plain.id, 0n);
  const removed = await book.reap(Date.now() + 10 * 86_400_000);
  assert(removed === 1, `only the plain record may reap (removed ${removed})`);
  assert(book.byId(confidential.id) !== undefined,
    "the confidential record is the only copy of R — reaping it loses the funds forever");
  assert(book.byId(plain.id) === undefined, "the plain confirmed-empty record still reaps");
  await book.close();
});

test("B3: confidentiality defaults to plain, so existing records migrate unchanged", async () => {
  const { book } = await newBook();
  const [record] = await book.addMany([announcement()]);
  assert(record.confidentiality === "plain", `expected plain, got ${record.confidentiality}`);
  await book.close();
});

test("B3: an unrecognised confidentiality value fails SAFE (treated as confidential)", async () => {
  const { book, path } = await newBook({ dormantMs: 0, retentionMs: 0 });
  const [record] = await book.addMany([announcement()]);
  await book.close();
  // Corrupt the persisted value the way a bad migration or a downgrade would.
  const file = new EncryptedJsonFile(path, KEY, { failClosed: true, durable: true });
  const stored = await file.read({ version: 2, records: [] });
  stored.records.find((entry) => entry.id === record.id).confidentiality = "something-else";
  await file.write(stored);
  const reopened = await new InboundAnnouncementBook(path, {
    retentionMs: 0, dormantMs: 0, encryptionKey: KEY,
  }).load();
  assert(reopened.byId(record.id).confidentiality === "confidential",
    "an unknown value must not silently become reapable");
  await reopened.observe(record.id, 0n);
  const removed = await reopened.reap(Date.now() + 10 * 86_400_000);
  assert(removed === 0, "and it must survive reaping");
  await reopened.close();
});

test("observing a funded record flips announced -> observed", async () => {
  const { book } = await newBook();
  const [record] = await book.addMany([announcement()]);
  const observed = await book.observe(record.id, 500_000n);
  assert(observed.status === "observed");
  assert(observed.observedAmountAtomic === "500000");
  await book.close();
});

// ------------------------------------------------------- crypto round-trip

test("the indexed announcement actually reconstructs a spendable key", async () => {
  const keys = generateStealthKeys();
  const derived = deriveStealthAddress(keys.meta);

  const { book } = await newBook();
  const [record] = await book.addMany([announcement({
    stealthAddress: derived.stealthAddress,
    ephemeralPubKey: derived.ephemeralPubKey,
  })]);

  // The payee holds only kSpend + kView. Everything else comes from the book.
  const stealthPrivateKey = computeStealthPrivateKey({
    ephemeralPubKey: record.ephemeralPubKey,
    viewingKey: keys.viewingKey,
    spendingKey: keys.spendingKey,
  });
  assert(
    addressForPrivateKey(stealthPrivateKey) === record.stealthAddress,
    "the indexed announcement does not yield the key controlling the address",
  );
  await book.close();
});

// ------------------------------------------------------------- registry

const IDENTITY = Wallet.createRandom();
const OTHER_IDENTITY = Wallet.createRandom();

const buildRegistry = async () => {
  const { book } = await newBook();
  const rail = {
    kind: "evm",
    network: "base",
    tokenConfig: BASE_USDC,
    balanceCalls: 0,
    async observedBalanceAtomic() {
      this.balanceCalls += 1;
      return 200_000n;
    },
  };
  const ledger = { accountReference: (agentId) => accountFor(agentId) };
  const registry = new PrivateAgentRegistry([
    {
      agentId: "payee",
      label: "payee",
      vpnIp: "10.77.2.10",
      walletAddress: Wallet.createRandom().address,
      identityAddress: IDENTITY.address,
      sharedSecret: "s".repeat(32),
      credits: 0,
      inventory: [],
    },
    {
      agentId: "intruder",
      label: "intruder",
      vpnIp: "10.77.1.10",
      walletAddress: Wallet.createRandom().address,
      identityAddress: OTHER_IDENTITY.address,
      sharedSecret: "t".repeat(32),
      credits: 0,
      inventory: [],
    },
  ], {
    privateLedger: ledger,
    rails: new Map([["base", rail]]),
    inboundAnnouncements: book,
  });
  return { registry, book, rail };
};

const signedInbox = async (signer, { agentId = "payee", network = "base" } = {}) => {
  const intentNonce = randomBytes(16).toString("hex");
  const agentSignature = await signer.signMessage(
    stealthInboxIntentMessage({ agentId, network, intentNonce }),
  );
  return { agentId, network, intentNonce, agentSignature };
};

test("the payee can read their own inbox and gets the announcement back", async () => {
  const { registry, book, rail } = await buildRegistry();
  const keys = generateStealthKeys();
  const derived = deriveStealthAddress(keys.meta);
  await book.addMany([announcement({
    accountId: accountFor("payee"),
    stealthAddress: derived.stealthAddress,
    ephemeralPubKey: derived.ephemeralPubKey,
  })]);

  const inbox = await registry.stealthInbox(await signedInbox(IDENTITY), "10.77.2.10");
  assert(inbox.entries.length === 1, "inbox did not return the announcement");
  assert(inbox.entries[0].ephemeralPubKey === derived.ephemeralPubKey);
  assert(inbox.entries[0].observedAmountAtomic === "200000", "balance was not refreshed");
  assert(inbox.totalObservedAtomic === "200000");
  assert(rail.balanceCalls === 1);
  assert(inbox.entries[0].sourceRef === undefined, "sourceRef must not be exposed");
  await book.close();
});

test("a wrong VPN peer cannot read the inbox", async () => {
  const { registry, book } = await buildRegistry();
  await book.addMany([announcement()]);
  // an unregistered peer, and the OTHER registered agent's peer
  for (const peer of ["10.77.9.9", "10.77.1.10"]) {
    const body = await signedInbox(IDENTITY);
    await rejects(() => registry.stealthInbox(body, peer), /VPN peer mismatch/);
  }
  await book.close();
});

test("a valid peer with someone else's signature cannot read the inbox", async () => {
  const { registry, book } = await buildRegistry();
  await book.addMany([announcement()]);
  const body = await signedInbox(OTHER_IDENTITY);
  await rejects(
    () => registry.stealthInbox(body, "10.77.2.10"),
    /signer does not match registered identity/,
  );
  await book.close();
});

test("an unsigned inbox request is rejected even though the peer is right", async () => {
  const { registry, book } = await buildRegistry();
  await book.addMany([announcement()]);
  await rejects(
    () => registry.stealthInbox({
      agentId: "payee",
      network: "base",
      intentNonce: randomBytes(16).toString("hex"),
      agentSignature: "",
    }, "10.77.2.10"),
    /signature required/,
  );
  await book.close();
});

test("a replayed inbox nonce is rejected", async () => {
  const { registry, book } = await buildRegistry();
  await book.addMany([announcement()]);
  const body = await signedInbox(IDENTITY);
  await registry.stealthInbox(body, "10.77.2.10");
  await rejects(() => registry.stealthInbox(body, "10.77.2.10"), /Replayed agent intent nonce/);
  await book.close();
});

test("one agent never sees another agent's announcements", async () => {
  const { registry, book } = await buildRegistry();
  await book.addMany([announcement({ accountId: accountFor("payee") })]);
  await book.addMany([announcement({ accountId: accountFor("intruder") })]);
  const inbox = await registry.stealthInbox(await signedInbox(IDENTITY), "10.77.2.10");
  assert(inbox.entries.length === 1, "inbox leaked another account's announcement");
  await book.close();
});

// ------------------------------------------------------------------ D5

test("Solana deposit intents bind case (two case-variants sign differently)", () => {
  const base = {
    agentId: "payee",
    amountAtomic: "200000",
    network: "solana",
    intentNonce: "abc",
  };
  const upper = privateLedgerDepositIntentMessage({
    ...base,
    fromAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  });
  const lower = privateLedgerDepositIntentMessage({
    ...base,
    fromAddress: "epjfwdd5aufqssqem2qn1xzybapc8g4wegGkZwyTDt1v",
  });
  assert(upper !== lower, "Solana sender case is still flattened by the signed intent");
  assert(
    upper.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    "Solana sender was not preserved verbatim",
  );
});

test("EVM deposit intent bytes are unchanged (no signature break)", () => {
  const fields = {
    agentId: "payee",
    fromAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
    amountAtomic: "200000",
    network: "base",
    intentNonce: "abc",
  };
  assert(
    privateLedgerDepositIntentMessage(fields) === legacyPrivateLedgerDepositIntentMessage(fields),
    "the fix changed EVM signed bytes; every existing EVM depositor would break",
  );
});

// ------------------------------------------------------------------ run

for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

await rm(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
