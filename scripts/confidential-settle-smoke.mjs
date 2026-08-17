/**
 * Offline proof for the confidential settle path
 * (spec-confidential-x402.md §15.2).
 *
 * Uses REAL `VersionedTransaction` bytes against a stubbed `Connection`, because
 * every bug this file is defending against lives in wire parsing or in the order
 * of operations — neither of which a mocked transaction would exercise.
 *
 * The three failures that matter, in order of cost:
 *   1. Broadcasting before the announcement is durable  -> funds unspendable, forever.
 *   2. Failing a transfer without closing proof accounts -> 8,539,920 lamports, silently.
 *   3. Trusting a caller-declared close set             -> closing another payment's accounts.
 */
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  SolanaConfidentialSettler,
  ZK_ELGAMAL_PROOF_PROGRAM,
  deriveProofContextAccounts,
  describeSolanaError,
  bigintSafeReplacer,
} from "../src/server/rails/SolanaConfidentialSettler.ts";

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

const SETTLER = Keypair.generate();
const OTHER_AUTHORITY = Keypair.generate();
const MINT = Keypair.generate().publicKey;
const DEST_ATA = Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";

/** A `VerifyProof*` instruction: [contextState (w), contextStateAuthority (ro)]. */
const verifyProofIx = (contextState, authority) =>
  new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [
      { pubkey: contextState, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([7]), // any nonzero discriminator is a verify
  });

/** `CloseContextState` is discriminator 0 — never a context account to reclaim. */
const closeIx = (contextState, authority) =>
  new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [
      { pubkey: contextState, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([0]),
  });

/** A touch instruction so an account appears among the static keys. */
const touchIx = (pubkey) =>
  new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [{ pubkey, isSigner: false, isWritable: false }],
    data: Buffer.alloc(0),
  });

const buildTx = (feePayer, instructions) => {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
};

const wire = (tx) => Buffer.from(tx.serialize()).toString("base64");

/** The measured 5-transaction shape: 3 proof contexts, then transfer + closes. */
const CTX = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
const validPlan = () => [
  wire(buildTx(SETTLER.publicKey, [verifyProofIx(CTX[0], SETTLER.publicKey)])),
  wire(buildTx(SETTLER.publicKey, [verifyProofIx(CTX[1], SETTLER.publicKey)])),
  wire(buildTx(SETTLER.publicKey, [verifyProofIx(CTX[2], SETTLER.publicKey)])),
  wire(buildTx(SETTLER.publicKey, [touchIx(MINT)])),
  wire(buildTx(SETTLER.publicKey, [
    touchIx(DEST_ATA),
    closeIx(CTX[0], SETTLER.publicKey),
    closeIx(CTX[1], SETTLER.publicKey),
    closeIx(CTX[2], SETTLER.publicKey),
  ])),
];

/**
 * A stubbed chain. `simulateErrAt` / `sendErrAt` inject a failure at a chosen
 * transaction index so the cleanup path can be driven deterministically.
 */
const stubConnection = ({ simulateErrAt = -1, sendErrAt = -1, liveAccounts = [], closeThrows = false } = {}) => {
  const log = { simulated: 0, sent: [], closes: 0, accountReads: [] };
  return {
    log,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
    getAccountInfo: async (pubkey) => {
      log.accountReads.push(pubkey.toBase58());
      return liveAccounts.some((a) => a.equals(pubkey)) ? { lamports: 2_846_640, data: Buffer.alloc(0) } : null;
    },
    simulateTransaction: async () => {
      const index = log.simulated;
      log.simulated += 1;
      return index === simulateErrAt
        // The exact shape kit's own formatter chokes on.
        ? { value: { err: { InstructionError: [0, { Custom: 26n }] }, logs: ["Program log: ElGamal public key mismatch"] } }
        : { value: { err: null, logs: [] } };
    },
    sendRawTransaction: async (raw) => {
      const tx = VersionedTransaction.deserialize(raw);
      // A CLEANUP transaction is close instructions and nothing else. The plan's
      // own final transaction also carries closes — beside the transfer — so
      // "contains a close" would misclassify the happy path as a cleanup.
      const isCleanup = tx.message.compiledInstructions.every(
        (ix) => tx.message.staticAccountKeys[ix.programIdIndex].equals(ZK_ELGAMAL_PROOF_PROGRAM)
          && ix.data[0] === 0,
      );
      if (isCleanup) {
        log.closes += 1;
        if (closeThrows) throw new Error("cleanup broadcast rejected");
        return `close-sig-${log.closes}`;
      }
      const index = log.sent.length;
      if (index === sendErrAt) throw new Error(`send rejected at ${index}`);
      log.sent.push(index);
      return `sig-${index}`;
    },
    getSignatureStatuses: async (sigs) => ({
      value: sigs.map(() => ({ err: null, confirmationStatus: "confirmed" })),
    }),
  };
};

const newSettler = (connection, { withKey = true } = {}) =>
  new SolanaConfidentialSettler({
    connection,
    settlerPubkey: SETTLER.publicKey,
    settler: withKey ? SETTLER : undefined,
    confirmTimeoutMs: 500,
    pollIntervalMs: 1,
  });

const settleInput = (overrides = {}) => ({
  transactions: validPlan(),
  expectedDestinationTokenAccount: DEST_ATA.toBase58(),
  expectedMint: MINT.toBase58(),
  writeAheadAnnouncement: async () => {},
  ...overrides,
});

/* ───────────── the close set is DERIVED, never declared ───────────── */

await check("the close set is read off the wire, not taken from the caller", async () => {
  const settler = newSettler(stubConnection());
  const { contextAccounts } = settler.decodePlan(settleInput());
  eq(contextAccounts.length, 3, "the measured plan stands up three proof contexts");
  for (const ctx of CTX) {
    assert(contextAccounts.includes(ctx.toBase58()), `missing ${ctx.toBase58()}`);
  }
});

await check("a context account owned by ANOTHER authority is never in the close set", async () => {
  // The griefing case: every in-flight context account shares one authority, so
  // acting on an account we do not control would mean closing someone else's
  // proof mid-payment. Refusing to even look at it is the guard.
  const plan = [
    wire(buildTx(SETTLER.publicKey, [verifyProofIx(CTX[0], OTHER_AUTHORITY.publicKey)])),
    wire(buildTx(SETTLER.publicKey, [touchIx(MINT), touchIx(DEST_ATA)])),
  ];
  const settler = newSettler(stubConnection());
  const { contextAccounts } = settler.decodePlan(settleInput({ transactions: plan }));
  eq(contextAccounts.length, 0, "an account we are not the authority for is not ours to close");
});

await check("a CloseContextState instruction is not mistaken for a context to reclaim", async () => {
  const plan = [
    wire(buildTx(SETTLER.publicKey, [
      touchIx(MINT), touchIx(DEST_ATA), closeIx(CTX[0], SETTLER.publicKey),
    ])),
  ];
  const settler = newSettler(stubConnection());
  const { contextAccounts } = settler.decodePlan(settleInput({ transactions: plan }));
  eq(contextAccounts.length, 0, "discriminator 0 is a close, not a create");
});

/* ───────────── binding: the payload is transport, not truth ───────────── */

await check("a plan that does not name the settler as fee payer is refused", async () => {
  const rogue = wire(buildTx(OTHER_AUTHORITY.publicKey, [touchIx(MINT), touchIx(DEST_ATA)]));
  const settler = newSettler(stubConnection());
  let threw;
  try { settler.decodePlan(settleInput({ transactions: [rogue] })); } catch (e) { threw = e; }
  assert(threw, "we would otherwise pay fees and rent for a transaction we never shaped");
  assert(/fee payer/.test(threw.message), threw.message);
});

await check("a plan that never credits the QUOTED destination is refused", async () => {
  const plan = [wire(buildTx(SETTLER.publicKey, [touchIx(MINT)]))];
  const settler = newSettler(stubConnection());
  let threw;
  try { settler.decodePlan(settleInput({ transactions: plan })); } catch (e) { threw = e; }
  assert(threw, "the destination is derived from the quote; a plan paying elsewhere is not this payment");
  assert(/destination token account/.test(threw.message), threw.message);
});

await check("a plan on the wrong mint is refused", async () => {
  const plan = [wire(buildTx(SETTLER.publicKey, [touchIx(DEST_ATA)]))];
  const settler = newSettler(stubConnection());
  let threw;
  try { settler.decodePlan(settleInput({ transactions: plan })); } catch (e) { threw = e; }
  assert(threw && /mint/.test(threw.message), threw?.message);
});

await check("an undecodable transaction is refused rather than skipped", async () => {
  const settler = newSettler(stubConnection());
  let threw;
  try { settler.decodePlan(settleInput({ transactions: ["not-base64-at-all!!"] })); } catch (e) { threw = e; }
  assert(threw, "a plan we cannot parse is a plan we must not co-sign");
});

/* ───────────── requirement 3: durable BEFORE broadcastable ───────────── */

await check("the announcement is written BEFORE the first broadcast", async () => {
  const connection = stubConnection();
  const settler = newSettler(connection);
  let wroteAt = -1;
  await settler.settle(settleInput({
    writeAheadAnnouncement: async () => { wroteAt = connection.log.sent.length; },
  }));
  eq(wroteAt, 0, "R must be durable before anything can land — losing it strands the funds forever");
});

await check("a failed announcement write broadcasts NOTHING", async () => {
  const connection = stubConnection();
  const settler = newSettler(connection);
  let threw;
  try {
    await settler.settle(settleInput({
      writeAheadAnnouncement: async () => { throw new Error("disk full"); },
    }));
  } catch (e) { threw = e; }
  assert(threw, "the write-ahead failure must propagate");
  eq(connection.log.sent.length, 0, "the payer keeps its money rather than losing it to an unlocatable address");
});

await check("a full plan settles and reports the transfer signature last", async () => {
  const connection = stubConnection();
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  eq(outcome.status, "settled", "the happy path settles");
  eq(outcome.signatures.length, 5, "all five plan transactions land");
  eq(connection.log.closes, 0, "the plan closed its own contexts; no cleanup was needed");
});

/* ───────────── requirement 2: the failure path pays the rent back ───────────── */

await check("a transfer that FAILS simulation reclaims the three proof accounts", async () => {
  // The measured shape: txs 0-3 land, tx 4 fails. The closes rode in tx 4 and
  // died with it, so 8,539,920 lamports are sitting in accounts nobody will
  // free unless we do it here.
  const connection = stubConnection({ simulateErrAt: 4, liveAccounts: CTX });
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  eq(outcome.status, "refused", "a failed transfer is a refusal");
  eq(outcome.cleanup.status, "reclaimed", "the leaked rent is recovered");
  eq(outcome.cleanup.contextAccounts.length, 3, "all three accounts reclaimed");
  eq(connection.log.closes, 1, "one cleanup transaction closes all three");
});

await check("a transfer that fails to BROADCAST also reclaims", async () => {
  const connection = stubConnection({ sendErrAt: 4, liveAccounts: CTX });
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  eq(outcome.status, "refused", "refused");
  eq(outcome.cleanup.status, "reclaimed", "a send failure leaks exactly the same rent as a simulate failure");
});

await check("cleanup only touches accounts that still exist", async () => {
  // Failing on transaction 0 means the later contexts were never created.
  const connection = stubConnection({ simulateErrAt: 0, liveAccounts: [CTX[0]] });
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  eq(outcome.cleanup.contextAccounts.length, 1, "only the live account is closed");
});

await check("cleanup needing nothing reports so instead of sending an empty close", async () => {
  const connection = stubConnection({ simulateErrAt: 0, liveAccounts: [] });
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  eq(outcome.cleanup.status, "not-needed", "no accounts exist, so there is nothing to reclaim");
  eq(connection.log.closes, 0, "and no pointless transaction is broadcast");
});

await check("a cleanup that fails still returns a refusal, with the stranded amount", async () => {
  // A throwing cleanup must never convert the refusal into an exception — the
  // refusal is the answer the payer is owed. The lamports become an operator
  // problem, and an operator needs the number.
  const connection = stubConnection({ simulateErrAt: 4, liveAccounts: CTX, closeThrows: true });
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  eq(outcome.status, "refused", "still a refusal");
  eq(outcome.cleanup.status, "failed", "and the failure is reported, not swallowed");
  eq(outcome.cleanup.strandedLamports, "8539920", "the exact float an operator must go reclaim");
});

/* ───────────── requirement 1: the error survives serialization ───────────── */

await check("a `{ Custom: 26n }` program error reaches the caller intact", async () => {
  // kit's own formatter throws `TypeError: Do not know how to serialize a
  // BigInt` on exactly this value, replacing the program error with a generic
  // wrapper. That already produced one false conclusion in this repo.
  const connection = stubConnection({ simulateErrAt: 4, liveAccounts: CTX });
  const settler = newSettler(connection);
  const outcome = await settler.settle(settleInput());
  assert(outcome.detail.includes("26"), `the program error code is lost: ${outcome.detail}`);
  assert(outcome.detail.includes("ElGamal public key mismatch"), "the program log is lost");
});

await check("the bigint replacer does not throw on the value that breaks kit", () => {
  const encoded = JSON.stringify({ InstructionError: [0, { Custom: 26n }] }, bigintSafeReplacer);
  assert(encoded.includes('"26"'), encoded);
});

await check("a thrown simulate is NOT reported as a program verdict", () => {
  // Our own ReferenceError once got reported as the chain's answer. The text has
  // to say which one it is.
  const described = describeSolanaError(new ReferenceError("aesKey is not defined"));
  assert(described.includes("ReferenceError"), described);
});

await check("error walking reaches a nested cause and its logs", () => {
  const inner = new Error("Program failed");
  inner.logs = ["Program log: ElGamal public key mismatch"];
  const outer = new Error("Transaction failed to land");
  outer.cause = inner;
  const described = describeSolanaError(outer);
  assert(described.includes("ElGamal public key mismatch"), described);
});

/* ───────────── dry-run ───────────── */

await check("a settler keypair disagreeing with the configured pubkey is refused", () => {
  // Otherwise every binding check asserts against a different key than the one
  // that actually signs.
  let threw;
  try {
    new SolanaConfidentialSettler({
      connection: stubConnection(),
      settlerPubkey: OTHER_AUTHORITY.publicKey,
      settler: SETTLER,
    });
  } catch (e) { threw = e; }
  assert(threw, "the mismatch must be refused at construction");
});

await check("dry-run still validates bindings rather than throwing", async () => {
  // Dry-run is the DEFAULT state of this rail, so it has to be a working mode:
  // the binding checks need only the settler PUBKEY, never its secret.
  const settler = newSettler(stubConnection(), { withKey: false });
  const { contextAccounts } = settler.decodePlan(settleInput());
  eq(contextAccounts.length, 3, "the close set is derivable without a signing key");
});

await check("with no settler key nothing broadcasts and no announcement is written", async () => {
  const connection = stubConnection();
  const settler = newSettler(connection, { withKey: false });
  let wrote = false;
  const outcome = await settler.settle(settleInput({
    writeAheadAnnouncement: async () => { wrote = true; },
  }));
  eq(outcome.status, "refused", "dry-run never claims settlement");
  eq(outcome.cleanup.status, "dry-run", "and never claims to have cleaned up");
  eq(connection.log.sent.length, 0, "nothing broadcast");
  assert(!wrote, "nothing was created, so there is nothing for the payee to sweep");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
