/**
 * Offline smoke for the confidential slot pool (spec-confidential-x402.md §5.2-P).
 *
 * The invariant under test is double-issue: handing one slot to two payments
 * means the second payment lands in an account the FIRST payer can decrypt.
 * Everything else here is secondary to that.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import {
  ConfidentialSlotBook,
  ConfidentialSlotConflictError,
} from "../src/server/payments/ConfidentialSlotBook.ts";

const root = await mkdtemp(join(tmpdir(), "confidential-slot-smoke-"));
const KEY = randomBytes(32).toString("hex");
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
  assert(actual === expected, `${message} (got ${actual}, expected ${expected})`);

let seq = 0;
const newBook = async (options = {}) => {
  seq += 1;
  const path = join(root, `slots-${seq}.json`);
  const book = await new ConfidentialSlotBook(path, {
    encryptionKey: KEY,
    retentionMs: 900_000,
    ...options,
  }).load();
  return { book, path };
};

const accountFor = (agentId) =>
  `acct_${createHmac("sha256", "test-account-key").update(agentId).digest("hex")}`;

// Base58 fixtures from the real devnet run.
const MINT = "FocYWf7ju8kFjjtzZpEuhz642GNbG2wBH7MmRLMRohq8";
const ADDRS = [
  "2kM4UaSTVQoxJgE4X3KdnNnd3uh4uFp9mHn7nD4mMGKj",
  "FJ1xdFewSUY6uYzR9P1XobrMBmPuCFpdij8vjMATQioD",
  "FQLCT1vEuGyc5r3Tb8bW8gK7HWcGdwMbzbxYXRW4RsDq",
  "498MUJCn17w8YMP6SagFS5karaVn2jXNK5PbjtqgNFTb",
];
const slot = (index, overrides = {}) => ({
  accountId: accountFor("payee"),
  network: "solana",
  caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  mint: MINT,
  stealthAddress: ADDRS[index % ADDRS.length],
  ephemeralPubKey: ADDRS[(index + 1) % ADDRS.length],
  encryptionPubKey: ADDRS[(index + 2) % ADDRS.length],
  tokenAccount: ADDRS[(index + 3) % ADDRS.length],
  ...overrides,
});

/* ───────────── the double-issue guard ───────────── */

await check("§5.2-P — concurrent reservations NEVER hand out the same slot", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0), slot(1)]);
  // Fire both without awaiting between them: the unsafe read-then-reserve shape
  // would let both pick the same record, because reads are unserialized clones.
  const [a, b] = await Promise.all([
    book.reserve("payment-a", "solana"),
    book.reserve("payment-b", "solana"),
  ]);
  assert(a && b, "both reservations should succeed with two slots available");
  assert(a.id !== b.id,
    "THE invariant: one slot handed to two payments lets the first payer decrypt the second payment");
  eq(book.availableCount("solana"), 0, "both slots are now held");
});

await check("§5.2-P — an exhausted pool returns undefined, it does not throw or reuse", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0)]);
  const first = await book.reserve("payment-a", "solana");
  assert(first, "first reservation succeeds");
  const second = await book.reserve("payment-b", "solana");
  eq(second, undefined, "exhaustion is a liveness condition, never a silent reuse");
});

await check("§5.2-P — reservation is idempotent on the payment id", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0), slot(1)]);
  const first = await book.reserve("payment-a", "solana");
  const retry = await book.reserve("payment-a", "solana");
  eq(retry.id, first.id, "a retried request gets its own slot back");
  eq(book.availableCount("solana"), 1, "and does not burn a second slot");
});

/* ───────────── generation CAS ───────────── */

await check("a stale generation loses the CAS with a typed conflict error", async () => {
  const { book } = await newBook();
  const [added] = await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  assert(reserved.generation > added.generation, "reserving bumps the generation");
  let threw;
  try {
    await book.transition(reserved.id, "reserved", added.generation, (r) => { r.status = "consumed"; });
  } catch (error) {
    threw = error;
  }
  assert(threw instanceof ConfidentialSlotConflictError,
    `expected ConfidentialSlotConflictError, got ${threw?.constructor?.name}`);
});

await check("the book owns the generation bump — a mutator cannot forge it", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  const consumed = await book.transition(reserved.id, "reserved", reserved.generation, (r) => {
    r.status = "consumed";
    r.generation = 999; // forged
  });
  eq(consumed.generation, reserved.generation + 1, "the book's bump is applied after the mutator");
});

/* ───────────── release ───────────── */

await check("an unsettled reservation is released back, costing no rent", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  eq(book.availableCount("solana"), 0, "held");
  const released = await book.release(reserved.id, reserved.generation);
  eq(released.status, "available", "returned to the pool");
  eq(released.reservedFor, null, "and no longer attributed");
  eq(book.availableCount("solana"), 1, "available again");
});

await check("a double release is a no-op, not an error", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  const released = await book.release(reserved.id, reserved.generation);
  const again = await book.release(reserved.id, released.generation);
  eq(again, undefined, "releasing an available slot does nothing");
});

await check("a slot that took value is NEVER released back to the pool", async () => {
  const { book } = await newBook();
  await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  const consumed = await book.transition(reserved.id, "reserved", reserved.generation, (r) => {
    r.status = "consumed";
    r.consumedAt = Date.now();
  });
  const released = await book.release(consumed.id, consumed.generation);
  eq(released, undefined, "a consumed slot holds funds and must not be re-issued");
});

/* ───────────── reap ───────────── */

await check("reap drops only closed slots past retention", async () => {
  const { book } = await newBook({ retentionMs: 0 });
  await book.addMany([slot(0), slot(1)]);
  const reserved = await book.reserve("payment-a", "solana");
  const consumed = await book.transition(reserved.id, "reserved", reserved.generation, (r) => { r.status = "consumed"; });
  const swept = await book.transition(consumed.id, "consumed", consumed.generation, (r) => { r.status = "swept"; });
  await book.transition(swept.id, "swept", swept.generation, (r) => {
    r.status = "closed";
    r.closedAt = Date.now();
  });
  const removed = await book.reap(Date.now() + 10_000);
  eq(removed, 1, "only the closed slot reaps");
  eq(book.availableCount("solana"), 1, "the untouched available slot survives");
});

await check("an ANCIENT available slot is never reaped (it holds rent and R)", async () => {
  const { book } = await newBook({ retentionMs: 0 });
  await book.addMany([slot(0)]);
  const removed = await book.reap(Date.now() + 365 * 86_400_000);
  eq(removed, 0, "dropping it would lose both the rent and the R needed to reclaim it");
});

await check("an anomalous slot is retained indefinitely", async () => {
  const { book } = await newBook({ retentionMs: 0 });
  const [added] = await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  const consumed = await book.transition(reserved.id, "reserved", reserved.generation, (r) => { r.status = "consumed"; });
  const swept = await book.transition(consumed.id, "consumed", consumed.generation, (r) => { r.status = "swept"; });
  await book.transition(swept.id, "swept", swept.generation, (r) => {
    r.status = "closed";
    r.closedAt = Date.now();
  });
  await book.flagAnomaly(added.id, "reservation-orphaned");
  const removed = await book.reap(Date.now() + 10 * 86_400_000);
  eq(removed, 0, "the record is the only evidence an operator has");
});

/* ───────────── durability + validation ───────────── */

await check("slots survive a reopen with their announcement intact", async () => {
  const { book, path } = await newBook();
  await book.addMany([slot(0)]);
  const reserved = await book.reserve("payment-a", "solana");
  await book.close();
  const reopened = await new ConfidentialSlotBook(path, {
    encryptionKey: KEY, retentionMs: 900_000,
  }).load();
  const found = reopened.byId(reserved.id);
  assert(found, "slot survived the restart");
  eq(found.ephemeralPubKey, reserved.ephemeralPubKey, "R survived — without it the funds are unreachable");
  eq(found.status, "reserved", "and so did its reservation");
  await reopened.close();
});

await check("registration is idempotent on (network, stealthAddress)", async () => {
  const { book } = await newBook();
  const [first] = await book.addMany([slot(0)]);
  const [again] = await book.addMany([slot(0)]);
  eq(again.id, first.id, "a retried provisioning batch is a silent success");
  eq(book.all().length, 1, "and does not duplicate the slot");
});

await check("a malformed record is refused rather than stored", async () => {
  const { book } = await newBook();
  let threw = false;
  try {
    await book.addMany([slot(0, { ephemeralPubKey: "not-base58!" })]);
  } catch {
    threw = true;
  }
  assert(threw, "a slot whose R is malformed describes funds nobody can reach");
  eq(book.all().length, 0, "and nothing was persisted");
});

await check("a wrong encryption key fails CLOSED rather than starting empty", async () => {
  const { book, path } = await newBook();
  await book.addMany([slot(0)]);
  await book.close();
  let threw = false;
  try {
    await new ConfidentialSlotBook(path, {
      encryptionKey: randomBytes(32).toString("hex"),
      retentionMs: 900_000,
    }).load();
  } catch {
    threw = true;
  }
  assert(threw, "silently starting empty would re-provision slots that already exist on-chain");
});

await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
