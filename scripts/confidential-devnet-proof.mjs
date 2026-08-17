/**
 * LIVE devnet proof of the confidential rail, end to end, through the
 * PRODUCTION code paths (spec-confidential-x402.md §15.3).
 *
 * This is deliberately not the research spike that preceded it (see
 * spec-confidential-x402.md §14.2; the spike tree is not part of this repo).
 * That spike proved the MECHANISM: variant-B transfers land, a wrong
 * destination key is rejected by the program, the amount is absent from the
 * wire. It proved nothing about `src/`, because it reimplemented every step
 * inline and ran payer and payee in one process.
 *
 * What runs here is the shipped code:
 *   assertConfidentialMint · deriveSlotDrafts · PrivateAgentRegistry
 *   .provisionConfidentialSlots / .quoteX402 / .payX402 ·
 *   SolanaConfidentialChainRail · SolanaConfidentialSettler · ConfidentialSlotBook
 *   · InboundAnnouncementBook
 *
 * The payee's kSpend/kView live in a closure that the payer's arguments are
 * grepped against, so "the payer never sees a payee secret" is asserted
 * structurally rather than asserted by comment.
 *
 * Run: npm run test:confidential:devnet     (needs devnet SOL; ~0.02 SOL/run)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  createTransactionPlanExecutor,
  createTransactionPlanner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
// The confidential helpers live on a separate subpath, and it matters: this one
// pulls in `@solana/zk-sdk/bundler`. Importing `/node` anywhere in the same
// process creates a SECOND WASM instance whose cross-instance calls do not
// throw — they read the wrong heap and return plausible values (§5.3).
import {
  decryptConfidentialTransferBalance,
  getConfidentialTransferInstructionPlan,
  getCreateConfidentialTransferAccountInstructionPlan,
} from "@solana-program/token-2022/confidential";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/bundler";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { assertConfidentialMint } from "../src/server/rails/confidentialMint.ts";
import { SolanaConfidentialSettler } from "../src/server/rails/SolanaConfidentialSettler.ts";
import { SolanaConfidentialChainRail } from "../src/server/rails/SolanaChainRail.ts";
import { SolanaX402Facilitator } from "../src/server/base/SolanaX402Facilitator.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { ConfidentialSlotBook } from "../src/server/payments/ConfidentialSlotBook.ts";
import { InboundAnnouncementBook } from "../src/server/payments/InboundAnnouncementBook.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import {
  deriveSlotDrafts,
  publishableSlots,
  assertNoScalarLeaked,
} from "../src/server/rails/confidentialSlotProvisioner.ts";
import {
  generateSolanaStealthKeys,
  recoverSolanaStealthScalar,
  signSolanaWithScalar,
  publicKeyForSolanaScalar,
} from "../src/shared/stealthSolana.ts";
import { SOLANA_USDC } from "../src/shared/x402.ts";

/* ─────────────────────────── harness ─────────────────────────── */

const RPC_HTTP = process.env.HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : "https://api.devnet.solana.com";
const rpc = createSolanaRpc(RPC_HTTP);
const connection = new Connection(RPC_HTTP, "confirmed");

/** Reused from the two-party run: creating a mint costs SOL and proves nothing new. */
const MINT = process.env.CONFIDENTIAL_MINT ?? "Ha3XxvEWfSZAaDmvvynM3UckVJdeES7gCgKx3Hj2w6Xy";
const DECIMALS = 6;
const TRANSFER_AMOUNT = 41_000_000n;
const PAYER_KEYFILE = process.env.CONFIDENTIAL_PAYER_KEY
  ?? join(process.cwd(), "spikes", "solana-confidential", "payer.json");

let passed = 0;
const failures = [];
const ok = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
};
const step = (s) => console.log(`\n${"=".repeat(72)}\n${s}\n${"=".repeat(72)}`);
const b58 = (bytes) => new PublicKey(Buffer.from(bytes)).toBase58();

/**
 * Signs with a RAW stealth SCALAR. A one-time key is `kSpend + H(kView·R)` — a
 * scalar with no ed25519 seed behind it — so `Keypair.fromSecretKey` cannot
 * represent it and every standard signer API is unusable.
 */
const stealthSigner = (scalar, addr) => ({
  address: address(addr),
  signTransactions: async (transactions) =>
    transactions.map((t) =>
      Object.freeze({ [address(addr)]: signSolanaWithScalar(scalar, new Uint8Array(t.messageBytes)) })),
});

/** ElGamal + AE for a slot, from the one-time scalar alone (§5.2). */
const confidentialKeysForStealth = (scalar, stealthAddress, mint) => {
  const seed = Buffer.concat([
    Buffer.from(new PublicKey(stealthAddress).toBytes()),
    Buffer.from(new PublicKey(mint).toBytes()),
  ]);
  return {
    elgamal: ElGamalKeypair.fromSignature(
      signSolanaWithScalar(scalar, ElGamalKeypair.signerMessage(new Uint8Array(seed)))),
    ae: AeKey.fromSignature(
      signSolanaWithScalar(scalar, AeKey.signerMessage(new Uint8Array(seed)))),
  };
};

/**
 * Turns an InstructionPlan into ORDERED, PARTIALLY-signed wire transactions.
 *
 * The settler is a NOOP signer here, which is the whole point: in production the
 * server holds that key and the counterparty does not, so the plan must survive
 * being built with the settler's signature slot left empty and co-signed later.
 * Signing it locally would prove nothing about the real topology.
 */
const buildWirePlan = async (plan, feePayer) => {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        // No compute-budget instruction: the batched range proof needs ~1071
        // free bytes and a CU instruction leaves 1056, so the planner cannot
        // fit it (measured in the spike).
      ),
  });
  const txPlan = await planner(plan, { transactionMessageBytesLimit: 1232 });

  // The plan tree is walked directly rather than run through
  // `createTransactionPlanExecutor`, because the executor calls
  // `getSignatureFromTransaction` on each result and that THROWS while the fee
  // payer's slot is empty. Empty is the point: in production the settler holds
  // that key and the counterparty does not.
  const messages = [];
  const walk = (node) => {
    if (!node) return;
    if (node.kind === "single") { messages.push(node.message); return; }
    for (const child of node.plans ?? []) walk(child);
  };
  walk(txPlan);

  const wire = [];
  for (const message of messages) {
    wire.push(getBase64EncodedWireTransaction(
      await partiallySignTransactionMessageWithSigners(message)));
  }
  return wire;
};

/* ───────────── the payee party — kSpend/kView never leave ───────────── */

const makePayee = (mint) => {
  const keys = generateSolanaStealthKeys();
  return {
    meta: keys.meta,
    viewingScalar: keys.viewingScalar,
    secretMaterial: () => [keys.spendingScalar, keys.viewingScalar],

    /** Builds the slots + the owner-signed configure plan. Publishes neither key. */
    async provision(count, settlerAddress) {
      const drafts = deriveSlotDrafts({
        keys,
        mint,
        count,
        deriveEncryptionPubKey: ({ stealthScalar, stealthAddress }) =>
          b58(new Uint8Array(
            confidentialKeysForStealth(stealthScalar, stealthAddress, mint).elgamal.pubkey().toBytes())),
        deriveTokenAccount: () => "11111111111111111111111111111111", // replaced below
      });
      const transactions = [];
      const slots = [];
      for (const draft of drafts) {
        const { elgamal, ae } = confidentialKeysForStealth(
          draft.stealthScalar, draft.stealthAddress, mint);
        const [ata] = await findAssociatedTokenPda({
          mint: address(mint),
          owner: address(draft.stealthAddress),
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        const plan = await getCreateConfidentialTransferAccountInstructionPlan({
          payer: createNoopSigner(address(settlerAddress)),
          owner: stealthSigner(draft.stealthScalar, draft.stealthAddress),
          mint: address(mint),
          rpc,
          elgamalKeypair: elgamal,
          aesKey: ae,
        });
        transactions.push(...await buildWirePlan(plan, createNoopSigner(address(settlerAddress))));
        slots.push({ ...draft, tokenAccount: String(ata) });
      }
      return { drafts: slots, transactions };
    },

    /** STEP 4: re-derives EVERYTHING from (R, kView, kSpend) + public data. */
    decryptFromScratch(ephemeralPubKey, mintAddr, accountData) {
      const scalar = recoverSolanaStealthScalar({
        ephemeralPubKey,
        viewingScalar: keys.viewingScalar,
        spendingScalar: keys.spendingScalar,
      });
      const stealthAddress = publicKeyForSolanaScalar(scalar).toBase58();
      const { elgamal, ae } = confidentialKeysForStealth(scalar, stealthAddress, mintAddr);
      const balance = decryptConfidentialTransferBalance({
        tokenAccount: accountData, elgamalSecretKey: elgamal.secret(), aesKey: ae,
      });
      return { stealthAddress, pending: balance.pendingBalance, available: balance.availableBalance };
    },
  };
};

/* ─────────────────────────── main ─────────────────────────── */

const root = await mkdtemp(join(tmpdir(), "confidential-devnet-"));
const KEY = randomBytes(32).toString("hex");

try {
  step("0. settler / fee payer");
  if (!existsSync(PAYER_KEYFILE)) throw new Error(`payer keyfile missing: ${PAYER_KEYFILE}`);
  const secret = Uint8Array.from(JSON.parse(readFileSync(PAYER_KEYFILE, "utf8")));
  const settlerKeypair = Keypair.fromSecretKey(secret);
  const settlerSigner = await createKeyPairSignerFromBytes(secret);
  const settlerAddress = settlerKeypair.publicKey.toBase58();
  const balance = await connection.getBalance(settlerKeypair.publicKey, "confirmed");
  console.log(`settler ${settlerAddress}  ${balance / 1e9} SOL`);
  if (balance < 200_000_000) throw new Error(`insufficient devnet SOL on ${settlerAddress}`);

  step("1. PRODUCTION mint assertion (auditor must be null — it is a decryption backdoor)");
  const verdict = await assertConfidentialMint({ rpc, mint: MINT });
  ok("assertConfidentialMint accepts the live mint", verdict.capable,
    verdict.capable ? `${MINT} decimals=${verdict.decimals}` : `reason=${verdict.reason} ${verdict.detail ?? ""}`);
  if (!verdict.capable) throw new Error("mint is not confidential-capable");

  step("2. wire up the PRODUCTION rail + registry");
  const facilitator = new SolanaX402Facilitator({
    rpcUrl: RPC_HTTP,
    connection,
    settlerSecretKey: undefined,
    settlerPubkey: settlerKeypair.publicKey,
    token: { ...SOLANA_USDC, address: MINT },
  });
  const settler = new SolanaConfidentialSettler({
    connection,
    settlerPubkey: settlerKeypair.publicKey,
    settler: settlerKeypair,
    confirmTimeoutMs: 120_000,
    pollIntervalMs: 1_500,
  });
  const rail = new SolanaConfidentialChainRail({
    facilitator,
    confidentialMint: MINT,
    confidentialEnabled: true,
    settler,
  });
  await rail.assertCapability(rpc);
  ok("rail resolves confidentialMode=onchain after the async assertion",
    rail.confidentialMode === "onchain", `mode=${rail.confidentialMode}`);

  const ledger = await new PrivatePaymentLedger(join(root, "ledger.json"), KEY, {
    journal: new EphemeralPaymentJournal(join(root, "epochs")),
    retentionMs: 60_000,
  }).load({});
  const slotBook = await new ConfidentialSlotBook(join(root, "slots.json"), {
    encryptionKey: KEY, retentionMs: 900_000,
  }).load();
  const announcements = await new InboundAnnouncementBook(join(root, "inbox.json"), {
    encryptionKey: KEY, retentionMs: 900_000, dormantMs: 86_400_000,
  }).load();

  const payee = makePayee(MINT);
  const registry = new PrivateAgentRegistry([
    { agentId: "payer", label: "P", vpnIp: "127.0.0.1", walletAddress: settlerAddress, sharedSecret: "p", credits: 0, inventory: [] },
    {
      agentId: "payee", label: "R", vpnIp: "127.0.0.1",
      walletAddress: payee.meta.spendingPubKey, sharedSecret: "r", credits: 0, inventory: [],
      solanaStealthMeta: payee.meta,
      solanaStealthViewingKey: payee.viewingScalar,
    },
  ], {
    requireIdentitySignatures: false,
    privateLedger: ledger,
    inboundAnnouncements: announcements,
    confidentialSlots: slotBook,
    rails: new Map([["solana", rail]]),
  });

  step("3. PAYEE provisions a slot (it owner-signs; the settler funds the rent)");
  const { drafts, transactions } = await payee.provision(1, settlerAddress);
  const published = publishableSlots(drafts);
  console.log("published:", JSON.stringify(published, null, 2));
  assertNoScalarLeaked(published, drafts);
  ok("the published batch carries NO spending scalar", true, `${published.length} slot(s)`);

  const provisioned = await registry.provisionConfidentialSlots({
    payeeAgentId: "payee",
    network: "solana",
    slots: published,
    transactions,
    intentNonce: `prov-${randomBytes(8).toString("hex")}`,
    agentSignature: "unused",
  }, "127.0.0.1");
  console.log("provision result:", JSON.stringify({ ...provisioned }, null, 2));
  ok("PRODUCTION provisionConfidentialSlots lands the configure plan on devnet",
    provisioned.status === "provisioned", provisioned.detail ?? "");
  ok("the slot is registered only after the chain agreed on address, ATA and P",
    provisioned.registered === 1, `registered=${provisioned.registered} rejected=${JSON.stringify(provisioned.rejected ?? [])}`);
  ok("pool depth is observable", registry.confidentialSlotDepth("solana")?.available === 1);

  step("4. PRODUCTION quote — the server hands out the slot");
  const requirements = await registry.quoteX402({
    payeeAgentId: "payee", payerAgentId: "payer",
    amountAtomic: String(TRANSFER_AMOUNT),
    resource: "px402:confidential-devnet",
    intentNonce: `q-${randomBytes(8).toString("hex")}`,
    agentSignature: "unused",
    scheme: "confidential",
  }, "127.0.0.1", { ...SOLANA_USDC, address: MINT }, Math.floor(Date.now() / 1000));
  ok("quote advertises scheme=confidential", requirements.scheme === "confidential");
  ok("quote publishes the payee-chosen R", requirements.ephemeralPubKey === drafts[0].ephemeralPubKey);
  ok("quote publishes P and the destination ATA",
    requirements.encryptionPubKey === drafts[0].encryptionPubKey
    && requirements.destinationTokenAccount === drafts[0].tokenAccount);
  // The payer gets ONLY this. Grep it for payee secrets.
  assertNoScalarLeaked(requirements, drafts);
  ok("the QUOTE the payer receives contains no payee secret", true);

  step("5. PAYER builds the transfer plan against the quote (variant B)");
  const senderSeed = Buffer.concat([
    Buffer.from(new PublicKey(settlerAddress).toBytes()),
    Buffer.from(new PublicKey(MINT).toBytes()),
  ]).subarray(0, 32);
  const senderElgamal = ElGamalKeypair.fromSeed(new Uint8Array(senderSeed));
  const senderAe = AeKey.fromSeed(new Uint8Array(senderSeed));
  const [senderAta] = await findAssociatedTokenPda({
    mint: address(MINT), owner: address(settlerAddress), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const sourceAccount = await fetchToken(rpc, senderAta, { commitment: "confirmed" });
  const available = decryptConfidentialTransferBalance({
    tokenAccount: sourceAccount.data, elgamalSecretKey: senderElgamal.secret(), aesKey: senderAe,
  }).availableBalance;
  console.log("sender confidential available:", available);
  if (available < TRANSFER_AMOUNT) {
    throw new Error(`sender has ${available}, needs ${TRANSFER_AMOUNT} — top up via the spike`);
  }

  const transferPlan = await getConfidentialTransferInstructionPlan({
    sourceToken: senderAta,
    mint: address(MINT),
    destinationToken: address(requirements.destinationTokenAccount),
    sourceTokenAccount: sourceAccount.data,
    // VARIANT B: the destination key comes from the QUOTE, and nothing is read
    // from the destination account.
    destinationElgamalPubkey: address(requirements.encryptionPubKey),
    authority: settlerSigner,
    amount: TRANSFER_AMOUNT,
    sourceElgamalKeypair: senderElgamal,
    aesKey: senderAe,
    // Same INSTANCE as `authority`, not a noop signer: the funded confidential
    // source account belongs to the settler in this run, and kit refuses two
    // distinct signer instances for one address.
    //
    // So on this leg the payer and the settler are the same key. That is a
    // property of the FIXTURE, not of the rail — and it is why the provisioning
    // leg above deliberately uses a true noop fee payer with a separate stealth
    // owner, which is where the "server co-signs a plan it did not build" claim
    // actually gets tested. Variant B reads nothing from the destination, so a
    // distinct payer changes no instruction here.
    payer: settlerSigner,
    rpc,
  });
  const planWire = await buildWirePlan(transferPlan, settlerSigner);
  ok("the transfer plan is a MULTI-transaction plan, as measured",
    planWire.length > 1, `${planWire.length} transactions`);

  step("6. is the plaintext amount anywhere in the plan?");
  const le = Buffer.alloc(8); le.writeBigUInt64LE(TRANSFER_AMOUNT);
  const be = Buffer.alloc(8); be.writeBigUInt64BE(TRANSFER_AMOUNT);
  const ascii = Buffer.from(String(TRANSFER_AMOUNT), "ascii");
  let scanned = 0;
  const hits = [];
  for (const [index, w] of planWire.entries()) {
    const bytes = Buffer.from(w, "base64");
    scanned += bytes.length;
    for (const [label, needle] of [["LE-u64", le], ["BE-u64", be], ["ascii", ascii]]) {
      if (bytes.includes(needle)) hits.push(`tx${index}:${label}`);
    }
  }
  ok("the amount appears in NO encoding across the whole plan",
    hits.length === 0, `${scanned} bytes scanned; hits=${JSON.stringify(hits)}`);

  step("7. PRODUCTION payX402 — routes by the QUOTE's scheme and settles");
  const receipt = await registry.payX402({
    payment: {
      x402Version: 1, scheme: "confidential", network: "solana",
      asset: MINT, payer: settlerAddress,
      transactions: planWire,
      ephemeralPubKey: requirements.ephemeralPubKey,
      destinationTokenAccount: requirements.destinationTokenAccount,
    },
    requirementsNonce: requirements.nonce,
    agentSignature: "unused",
  }, "127.0.0.1", facilitator, Math.floor(Date.now() / 1000));
  console.log("receipt:", JSON.stringify(receipt.settlement, null, 2));
  ok("PRODUCTION settleConfidential broadcast the plan on devnet",
    receipt.settlement.settlement === "onchain",
    receipt.settlement.reason ?? receipt.settlement.transactionHash ?? "");

  step("8. B3 — the announcement is indexed as CONFIDENTIAL");
  const record = announcements.all().find((r) => r.stealthAddress === requirements.payTo);
  ok("the announcement was write-ahead indexed", Boolean(record));
  ok("and marked confidential, so the reaper can never take its R",
    record?.confidentiality === "confidential", `confidentiality=${record?.confidentiality}`);
  ok("with no claimed amount — a confidential leg has none to claim",
    record?.expectedAmountAtomic === null);

  step("9. the PAYEE decrypts, from (R, kView, kSpend) and public data alone");
  const destAccount = await fetchToken(rpc, address(requirements.destinationTokenAccount), {
    commitment: "confirmed",
  });
  const decrypted = payee.decryptFromScratch(requirements.ephemeralPubKey, MINT, destAccount.data);
  console.log("payee decrypted:", JSON.stringify({
    stealthAddress: decrypted.stealthAddress,
    pending: String(decrypted.pending),
    available: String(decrypted.available),
  }, null, 2));
  ok("the payee re-derives the same one-time address from R alone",
    decrypted.stealthAddress === requirements.payTo);
  ok("and reads the amount the chain never published",
    decrypted.pending === TRANSFER_AMOUNT,
    `pending=${decrypted.pending} expected=${TRANSFER_AMOUNT}`);

  step("10. the destination's PLAINTEXT balance is still zero");
  const state = await facilitator.confidentialAccountState({
    owner: requirements.payTo, mint: MINT,
  });
  ok("plaintext amount is 0 — which is exactly why B3 exists",
    state.amountAtomic === 0n, `plaintext=${state.amountAtomic}`);
  ok("observeConfidential reports ciphertext-present, never a balance",
    (await rail.observeConfidential({ stealthAddress: requirements.payTo })).kind === "ciphertext-present");
  ok("the stored ElGamal key is the P the quote published",
    state.encryptionPubKey === requirements.encryptionPubKey);

  step("11. the slot is consumed and cannot be handed out twice");
  const slot = slotBook.all().find((s) => s.stealthAddress === requirements.payTo);
  ok("the slot is no longer available", slot?.status !== "available", `status=${slot?.status}`);
  ok("pool depth reflects it", registry.confidentialSlotDepth("solana")?.available === 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
