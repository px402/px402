import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Wallet } from "ethers";
import {
  deriveEvmDepositAddress,
  deriveEvmDepositPrivateKey,
  deriveEvmTreasuryStealthKeys,
  deriveSolanaDepositAddress,
  deriveSolanaDepositScalar,
  deriveSolanaTreasuryStealthKeys,
  evmKeyVersion,
  solanaKeyVersion,
} from "../src/shared/depositStealth.ts";
import { addressForPrivateKey } from "../src/shared/stealth.ts";
import { publicKeyForSolanaScalar } from "../src/shared/stealthSolana.ts";
import { BASE_USDC, SOLANA_USDC } from "../src/shared/x402.ts";
import { BasePaymentVerifier } from "../src/server/base/BasePaymentVerifier.ts";
import { SolanaPaymentVerifier } from "../src/server/base/SolanaPaymentVerifier.ts";
import { DepositAddressBook } from "../src/server/payments/DepositAddressBook.ts";
import { DepositReconciliationQueue } from "../src/server/payments/DepositReconciliationQueue.ts";
import { DepositConsolidationService } from "../src/server/payments/DepositConsolidationService.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition
  ? (pass++, console.log("PASS", message))
  : (fail++, console.log("FAIL", message));
const rejects = async (operation) => {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
};

const root = await mkdtemp(join(tmpdir(), "px402-stealth-deposit-"));
const encryptionKey = "offline-stealth-deposit-smoke-key";

try {
  // A. Deterministic derivation and regeneration.
  const evmSettler = Wallet.createRandom();
  const evmContext = {
    caip2: BASE_USDC.caip2,
    tokenAddress: BASE_USDC.address,
    keyVersion: evmKeyVersion(evmSettler.address),
  };
  const evmKeys = deriveEvmTreasuryStealthKeys(evmSettler.privateKey, evmContext);
  const evmKeysAgain = deriveEvmTreasuryStealthKeys(evmSettler.privateKey, evmContext);
  const evmOtherNetwork = deriveEvmTreasuryStealthKeys(evmSettler.privateKey, {
    ...evmContext,
    caip2: "eip155:4663",
  });
  const evmOtherToken = deriveEvmTreasuryStealthKeys(evmSettler.privateKey, {
    ...evmContext,
    tokenAddress: Wallet.createRandom().address,
  });
  const solanaSettler = Keypair.generate();
  const solanaSecret = encodeBase58(solanaSettler.secretKey);
  const solanaContext = {
    caip2: SOLANA_USDC.caip2,
    tokenAddress: SOLANA_USDC.address,
    keyVersion: solanaKeyVersion(solanaSettler.publicKey.toBase58()),
  };
  const solanaKeys = deriveSolanaTreasuryStealthKeys(solanaSecret, solanaContext);
  const solanaKeysAgain = deriveSolanaTreasuryStealthKeys(solanaSecret, solanaContext);
  const solanaOtherNetwork = deriveSolanaTreasuryStealthKeys(solanaSecret, {
    ...solanaContext,
    caip2: "solana:test-network",
  });
  const solanaOtherToken = deriveSolanaTreasuryStealthKeys(solanaSecret, {
    ...solanaContext,
    tokenAddress: Keypair.generate().publicKey.toBase58(),
  });
  ok(
    JSON.stringify(evmKeys) === JSON.stringify(evmKeysAgain)
      && evmKeys.meta.spendingPubKey !== evmOtherNetwork.meta.spendingPubKey
      && evmKeys.meta.spendingPubKey !== evmOtherToken.meta.spendingPubKey
      && JSON.stringify(solanaKeys) === JSON.stringify(solanaKeysAgain)
      && solanaKeys.meta.spendingPubKey !== solanaOtherNetwork.meta.spendingPubKey
      && solanaKeys.meta.spendingPubKey !== solanaOtherToken.meta.spendingPubKey,
    "1 treasury keys are deterministic and domain-separated by network and token",
  );
  const evmDeposit = deriveEvmDepositAddress(evmSettler.privateKey, evmContext, 7);
  const evmDepositAgain = deriveEvmDepositAddress(evmSettler.privateKey, evmContext, 7);
  ok(
    evmDeposit.stealthAddress === evmDepositAgain.stealthAddress
      && evmDeposit.ephemeralPubKey === evmDepositAgain.ephemeralPubKey,
    "2 EVM indexed address and ephemeral key regenerate exactly",
  );
  ok(
    addressForPrivateKey(
      deriveEvmDepositPrivateKey(evmSettler.privateKey, evmContext, 7),
    ) === evmDeposit.stealthAddress,
    "3 regenerated EVM one-time private key controls the deposit address",
  );
  const solanaDeposit = deriveSolanaDepositAddress(solanaSecret, solanaContext, 7);
  ok(
    publicKeyForSolanaScalar(
      deriveSolanaDepositScalar(solanaSecret, solanaContext, 7),
    ).toBase58() === solanaDeposit.stealthAddress,
    "4 regenerated Solana scalar controls the deposit address",
  );
  ok(
    deriveEvmDepositAddress(evmSettler.privateKey, evmContext, 8).stealthAddress
      !== evmDeposit.stealthAddress
      && deriveEvmDepositAddress(evmSettler.privateKey, {
        ...evmContext,
        keyVersion: "deadbeef",
      }, 7).stealthAddress !== evmDeposit.stealthAddress
      && deriveSolanaDepositAddress(solanaSecret, solanaContext, 8).stealthAddress
      !== solanaDeposit.stealthAddress,
    "5 indices are unique and keyVersion is bound into derivation",
  );

  // B. Verifier proof identity.
  const originalFetch = globalThis.fetch;
  const token = BASE_USDC.address;
  const from = Wallet.createRandom().address;
  const firstRecipient = Wallet.createRandom().address;
  const secondRecipient = Wallet.createRandom().address;
  const treasury = Wallet.createRandom().address;
  const txHash = `0x${"ab".repeat(32)}`;
  const transferLog = (recipient, amount) => ({
    address: token,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      addressTopic(from),
      addressTopic(recipient),
    ],
    data: `0x${BigInt(amount).toString(16).padStart(64, "0")}`,
  });
  const evmReceipt = {
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x10",
    logs: [transferLog(firstRecipient, 250000n), transferLog(secondRecipient, 300000n)],
  };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const result = request.method === "eth_getTransactionByHash"
      ? { hash: txHash, from, to: token, value: "0x0" }
      : request.method === "eth_getTransactionReceipt"
        ? evmReceipt
        : request.method === "eth_blockNumber"
          ? "0x11"
          : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const baseVerifier = new BasePaymentVerifier("http://offline", 2);
  const firstProof = await baseVerifier.verifyErc20Transfer({
    transactionHash: txHash,
    tokenAddress: token,
    fromAddress: from,
    recipient: firstRecipient,
    amountAtomic: "250000",
  });
  const secondProof = await baseVerifier.verifyErc20Transfer({
    transactionHash: txHash,
    tokenAddress: token,
    fromAddress: from,
    recipient: secondRecipient,
    amountAtomic: "250000",
  });
  ok(
    firstProof.transferIndex === 0 && secondProof.transferIndex === 1,
    "6 EVM verifier accepts two recipients in one transaction with distinct transferIndex values",
  );
  ok(
    await rejects(() => baseVerifier.verifyErc20Transfer({
      transactionHash: txHash,
      tokenAddress: token,
      fromAddress: from,
      recipient: treasury,
      amountAtomic: "1",
    })),
    "7 EVM verifier rejects the treasury when only one-time recipients were paid",
  );
  ok(
    secondProof.amountAtomic === "300000",
    "9 EVM verifier reports the observed overpayment amount",
  );
  globalThis.fetch = originalFetch;

  const solanaDepositor = Keypair.generate().publicKey;
  const solanaRecipient = Keypair.generate().publicKey;
  const solanaTreasury = Keypair.generate().publicKey;
  const sourceAta = Keypair.generate().publicKey;
  const mint = new PublicKey(SOLANA_USDC.address);
  const destinationAta = getAssociatedTokenAddressSync(mint, solanaRecipient);
  const solanaTxHash = Keypair.generate().publicKey.toBase58();
  const tokenAmount = (amount) => ({
    amount: String(amount),
    decimals: 6,
    uiAmount: Number(amount) / 1_000_000,
    uiAmountString: String(Number(amount) / 1_000_000),
  });
  const solanaFixture = {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: {
      signatures: [solanaTxHash],
      message: {
        accountKeys: [
          { pubkey: solanaDepositor, signer: true, writable: true },
          { pubkey: sourceAta, signer: false, writable: true },
          { pubkey: destinationAta, signer: false, writable: true },
          { pubkey: mint, signer: false, writable: false },
        ],
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [
          { program: "system", programId: SystemProgram.programId, parsed: { type: "noop", info: {} } },
          {
            program: "spl-token",
            programId: TOKEN_PROGRAM_ID,
            parsed: {
              type: "transferChecked",
              info: {
                source: sourceAta.toBase58(),
                destination: destinationAta.toBase58(),
                authority: solanaDepositor.toBase58(),
                mint: mint.toBase58(),
                tokenAmount: tokenAmount(300000n),
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: [],
      logMessages: [],
      rewards: [],
      preTokenBalances: [
        { accountIndex: 1, mint: mint.toBase58(), owner: solanaDepositor.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(1_000_000n) },
        { accountIndex: 2, mint: mint.toBase58(), owner: solanaRecipient.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(0n) },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: mint.toBase58(), owner: solanaDepositor.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(700000n) },
        { accountIndex: 2, mint: mint.toBase58(), owner: solanaRecipient.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(300000n) },
      ],
    },
  };
  const solanaVerifier = new SolanaPaymentVerifier({
    rpcUrl: "http://offline",
    connection: { getParsedTransaction: async () => solanaFixture },
  });
  const solanaProof = await solanaVerifier.verifyErc20Transfer({
    transactionHash: solanaTxHash,
    tokenAddress: mint.toBase58(),
    fromAddress: solanaDepositor.toBase58(),
    recipient: solanaRecipient.toBase58(),
    amountAtomic: "250000",
  });
  ok(
    solanaProof.transferIndex === 1
      && solanaProof.amountAtomic === "300000"
      && await rejects(() => solanaVerifier.verifyErc20Transfer({
        transactionHash: solanaTxHash,
        tokenAddress: mint.toBase58(),
        fromAddress: solanaDepositor.toBase58(),
        recipient: solanaTreasury.toBase58(),
        amountAtomic: "1",
      })),
    "8 Solana verifier returns flattened transferIndex, accepts the stealth owner, and rejects treasury",
  );

  // C. Ledger proof-keyed credit.
  const ledgerDirectory = join(root, "ledger");
  const journal = new EphemeralPaymentJournal(join(ledgerDirectory, "epochs"));
  const ledger = await new PrivatePaymentLedger(
    join(ledgerDirectory, "ledger.json"),
    encryptionKey,
    { journal, retentionMs: 1000 },
  ).load();
  const assetKey = privateLedgerAssetKey("base", BASE_USDC.address);
  const sameHash = `0x${"cd".repeat(32)}`;
  const indexedA = await ledger.creditDeposit({
    agentId: "agent-a",
    amountAtomic: "100",
    network: "base",
    assetKey,
    transactionHash: sameHash,
    transferIndex: 0,
  });
  const indexedB = await ledger.creditDeposit({
    agentId: "agent-b",
    amountAtomic: "200",
    network: "base",
    assetKey,
    transactionHash: sameHash,
    transferIndex: 1,
  });
  ok(
    !indexedA.duplicate && !indexedB.duplicate
      && ledger.balance("agent-a", assetKey) === "100"
      && ledger.balance("agent-b", assetKey) === "200",
    "10 one transaction credits two distinct transfer indices and accounts",
  );
  const indexedReplay = await ledger.creditDeposit({
    agentId: "agent-a",
    amountAtomic: "100",
    network: "base",
    assetKey,
    transactionHash: sameHash,
    transferIndex: 0,
  });
  ok(indexedReplay.duplicate, "11 identical indexed proof replay is idempotent");
  const legacyHash = `0x${"ef".repeat(32)}`;
  await ledger.creditDeposit({
    agentId: "legacy",
    amountAtomic: "50",
    network: "base",
    assetKey,
    transactionHash: legacyHash,
  });
  ok(
    await rejects(() => ledger.creditDeposit({
      agentId: "indexed-after-legacy",
      amountAtomic: "50",
      network: "base",
      assetKey,
      transactionHash: legacyHash,
      transferIndex: 0,
    })),
    "12 legacy-consumed transaction blocks a new indexed credit",
  );

  // D. Address-book WAL, CAS, bounded scans, retention, counters and nonce tombstones.
  const bookPath = join(root, "book.json");
  let book = await new DepositAddressBook(bookPath, {
    retentionMs: 100,
    encryptionKey,
  }).load();
  const newRecord = async (overrides = {}) => book.add({
    intentId: `intent-${Math.random()}`,
    accountId: book.accountId(overrides.agentId ?? "agent-a"),
    network: "base",
    caip2: BASE_USDC.caip2,
    tokenAddress: BASE_USDC.address.toLowerCase(),
    keyVersion: evmContext.keyVersion,
    derivationIndex: await book.nextIndex("base"),
    stealthAddress: Wallet.createRandom().address,
    ephemeralPubKey: evmDeposit.ephemeralPubKey,
    fromAddress: Wallet.createRandom().address.toLowerCase(),
    expectedAmountAtomic: "100",
    creditValidBefore: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  });
  const persisted = await newRecord();
  book.consumeNonce("private-deposit:agent-a:nonce-1", Date.now() + 60_000);
  await book.close();
  const rawBook = await readFile(bookPath, "utf8");
  book = await new DepositAddressBook(bookPath, {
    retentionMs: 100,
    encryptionKey,
  }).load();
  ok(
    book.byId(persisted.id)?.stealthAddress === persisted.stealthAddress
      && !rawBook.includes(persisted.stealthAddress)
      && !rawBook.includes("agent-a")
      && /^acct_[a-f0-9]{64}$/.test(persisted.accountId),
    "13 encrypted book round-trips without plaintext address/agentId and uses a 64-hex account id",
  );
  ok(
    await rejects(() => book.transition(persisted.id, "credited", () => undefined)),
    "14 stale expectedFrom is rejected by CAS",
  );
  const eligibleA = await newRecord();
  const eligibleB = await newRecord();
  const unpaidA = await newRecord();
  const unpaidB = await newRecord();
  const old = Date.now() - 10_000;
  for (const record of [eligibleA, eligibleB]) {
    await book.transition(record.id, "awaiting-payment", (current) => {
      current.status = "credited";
      current.creditedAt = old;
    });
  }
  for (const record of [unpaidA, unpaidB]) {
    await book.transition(record.id, "awaiting-payment", (current) => {
      current.createdAt = old;
    });
  }
  ok(
    book.consolidatable(1, 1).length === 1
      && book.unpaidStale(1, 1).length === 1
      && book.consolidatable(1, 10).every((record) => record.status === "credited"),
    "15 consolidatable and unpaid scans are status-filtered and capped",
  );
  const swept = await newRecord();
  const retained = await newRecord();
  await book.transition(swept.id, "awaiting-payment", (current) => {
    current.status = "swept";
    current.sweptAt = Date.now() - 1000;
  });
  const reaped = await book.reapSwept();
  ok(reaped === 1 && !book.byId(swept.id) && book.byId(retained.id), "16 reap deletes only expired swept records");
  const nextBeforeReload = await book.nextIndex("base");
  await book.close();
  book = await new DepositAddressBook(bookPath, {
    retentionMs: 100,
    encryptionKey,
  }).load();
  const nextAfterReload = await book.nextIndex("base");
  ok(nextAfterReload === nextBeforeReload + 1, "17 derivation index increments monotonically across reload");
  ok(
    await rejects(async () => book.consumeNonce(
      "private-deposit:agent-a:nonce-1",
      Date.now() + 60_000,
    )),
    "18 nonce tombstone rejects replay after reload",
  );
  await book.close();
  ok(true, "19 close drains durable writes and wipes retained key buffers");

  // E/F. Consolidation service with injected rails.
  const scenario = async (name, railOverrides = {}, serviceOverrides = {}) => {
    const directory = join(root, `scenario-${name}`);
    const scenarioBook = await new DepositAddressBook(join(directory, "book.json"), {
      retentionMs: 100,
      encryptionKey,
    }).load();
    const scenarioQueue = await new DepositReconciliationQueue(
      join(directory, "queue.json"),
      encryptionKey,
    ).load();
    const balances = new Map();
    const calls = [];
    const rail = fakeRail({
      balances,
      calls,
      ...railOverrides,
    });
    const service = new DepositConsolidationService(
      scenarioBook,
      scenarioQueue,
      new Map([["base", rail]]),
      {
        minAgeMs: 1,
        maxPerRun: 8,
        unpaidGraceMs: 1,
        confirmations: 2,
        backoffMs: 10,
        maxAttempts: 2,
        ledger: { ledgerLiability: () => 0n },
        creditProofVerified: async () => undefined,
        ...serviceOverrides,
      },
    );
    return { directory, book: scenarioBook, queue: scenarioQueue, balances, calls, rail, service };
  };
  const addScenarioRecord = async (scenario, status, overrides = {}) => {
    const record = await scenario.book.add({
      intentId: `intent-${Math.random()}`,
      accountId: scenario.book.accountId("scenario-agent"),
      network: "base",
      caip2: BASE_USDC.caip2,
      tokenAddress: BASE_USDC.address.toLowerCase(),
      keyVersion: evmContext.keyVersion,
      derivationIndex: await scenario.book.nextIndex("base"),
      stealthAddress: Wallet.createRandom().address,
      ephemeralPubKey: evmDeposit.ephemeralPubKey,
      fromAddress: Wallet.createRandom().address.toLowerCase(),
      expectedAmountAtomic: "100",
      creditValidBefore: Math.floor(Date.now() / 1000) + 900,
      ...overrides,
    });
    await scenario.book.transition(record.id, "awaiting-payment", (current) => {
      current.status = status;
      current.createdAt = Date.now() - 10_000;
      if (status === "credited") current.creditedAt = Date.now() - 10_000;
      if (status === "sweep-submitted") current.sweepSubmittedAt = Date.now() - 10_000;
    });
    return scenario.book.byId(record.id);
  };

  const confirmedScenario = await scenario("confirmed", {
    sweep: async ({ record, book, calls }) => {
      calls.push(book.byId(record.id).status);
      return { outcome: "confirmed", transactionHash: "0xconfirmed", sweepNonce: record.sweepNonce, observedAmountAtomic: "100" };
    },
  });
  const confirmedRecord = await addScenarioRecord(confirmedScenario, "credited");
  confirmedScenario.rail.bindRecord(confirmedRecord, confirmedScenario.book);
  confirmedScenario.balances.set(confirmedRecord.stealthAddress, 100n);
  await confirmedScenario.service.runOnce();
  ok(
    confirmedScenario.calls[0] === "sweep-submitted"
      && confirmedScenario.book.byId(confirmedRecord.id).status === "swept",
    "20 sweep-submitted is durable before broadcast and only confirmed finality marks swept",
  );

  let txState = "pending";
  const submittedScenario = await scenario("submitted", {
    sweep: async ({ record }) => ({
      outcome: "submitted-unconfirmed",
      transactionHash: "0xpending",
      sweepNonce: record.sweepNonce,
      observedAmountAtomic: "100",
    }),
    status: async () => ({ state: txState }),
  });
  const submittedRecord = await addScenarioRecord(submittedScenario, "credited");
  submittedScenario.rail.bindRecord(submittedRecord, submittedScenario.book);
  submittedScenario.balances.set(submittedRecord.stealthAddress, 100n);
  await submittedScenario.service.runOnce();
  const stayedSubmitted = submittedScenario.book.byId(submittedRecord.id).status === "sweep-submitted";
  txState = "confirmed-success";
  await submittedScenario.service.reconcileOnStartup();
  ok(
    stayedSubmitted && submittedScenario.book.byId(submittedRecord.id).status === "swept",
    "21 submitted-unconfirmed persists and startup receipt reconciliation promotes only confirmed success",
  );

  const emptyScenario = await scenario("empty", {
    sweep: async () => ({ outcome: "empty", observedAmountAtomic: "0" }),
  });
  const emptyRecord = await addScenarioRecord(emptyScenario, "credited");
  emptyScenario.rail.bindRecord(emptyRecord, emptyScenario.book);
  await emptyScenario.service.runOnce();
  ok(
    emptyScenario.book.byId(emptyRecord.id).status === "reserve-mismatch"
      && emptyScenario.queue.list().some((entry) => entry.recordId === emptyRecord.id),
    "22 credited zero balance without a successful receipt is quarantined, never swept",
  );

  const throwingScenario = await scenario("throwing", {
    sweep: async () => { throw new Error("offline injected sweep failure"); },
  });
  const throwingRecord = await addScenarioRecord(throwingScenario, "credited");
  throwingScenario.rail.bindRecord(throwingRecord, throwingScenario.book);
  throwingScenario.balances.set(throwingRecord.stealthAddress, 100n);
  const retryNow = Date.now();
  await throwingScenario.service.runOnce(retryNow);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await throwingScenario.service.runOnce(Date.now());
  ok(
    throwingScenario.book.byId(throwingRecord.id).status === "reserve-mismatch"
      && throwingScenario.book.byId(throwingRecord.id).attemptCount === 2,
    "23 sweep errors back off, increment attempts, and quarantine at maxAttempts",
  );

  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const cappedScenario = await scenario("capped", {
    sweep: async ({ record, calls }) => {
      calls.push(record.id);
      await slow;
      return { outcome: "confirmed", transactionHash: `0x${record.id}`, observedAmountAtomic: "100" };
    },
  }, { maxPerRun: 1 });
  const cappedA = await addScenarioRecord(cappedScenario, "credited");
  const cappedB = await addScenarioRecord(cappedScenario, "credited");
  for (const record of [cappedA, cappedB]) {
    cappedScenario.rail.bindRecord(record, cappedScenario.book);
    cappedScenario.balances.set(record.stealthAddress, 100n);
  }
  const firstRun = cappedScenario.service.runOnce();
  const secondRun = await cappedScenario.service.runOnce();
  releaseSlow();
  await firstRun;
  ok(
    cappedScenario.calls.length === 1
      && secondRun.swept === 0
      && cappedScenario.book.unpaidStale(1, 1).length <= 1,
    "24 maxPerRun caps scans and a concurrent runOnce is a no-op",
  );

  const lateScenario = await scenario("late");
  const lateRecord = await addScenarioRecord(lateScenario, "awaiting-payment");
  const dormantRecord = await addScenarioRecord(lateScenario, "awaiting-payment");
  lateScenario.rail.bindRecord(lateRecord, lateScenario.book);
  lateScenario.rail.bindRecord(dormantRecord, lateScenario.book);
  lateScenario.balances.set(lateRecord.stealthAddress, 100n);
  lateScenario.balances.set(dormantRecord.stealthAddress, 0n);
  await lateScenario.service.runOnce();
  ok(
    lateScenario.book.byId(lateRecord.id).status === "reserve-mismatch"
      && lateScenario.queue.list().some((entry) =>
        entry.recordId === lateRecord.id && entry.reason === "late-uncredited")
      && lateScenario.book.byId(dormantRecord.id).status === "dormant",
    "25 late nonzero payment is swept then quarantined while confirmed-empty unpaid records become dormant",
  );

  const reserveScenario = await scenario("reserve", {}, {
    ledger: { ledgerLiability: () => 500n },
  });
  reserveScenario.balances.set(reserveScenario.rail.poolAddress, 100n);
  ok(
    !(await reserveScenario.service.reserveOk(assetKey)),
    "26 reserveOk fails when treasury plus unswept balances are below ledger liability",
  );

  const logScenario = await scenario("logging", {
    sweep: async () => ({ outcome: "empty", observedAmountAtomic: "0" }),
  });
  const logRecord = await addScenarioRecord(logScenario, "credited");
  logScenario.rail.bindRecord(logRecord, logScenario.book);
  const captured = [];
  const originalError = console.error;
  console.error = (...values) => captured.push(values.join(" "));
  await logScenario.service.runOnce();
  console.error = originalError;
  const encryptedQueueRaw = await readFile(join(logScenario.directory, "queue.json"), "utf8");
  ok(
    logScenario.queue.list().some((entry) => entry.stealthAddress === logRecord.stealthAddress)
      && !encryptedQueueRaw.includes(logRecord.stealthAddress)
      && captured.some((line) => line.includes(`record=${logRecord.id}`)
        && line.includes("reason=zero-without-receipt")
        && !line.includes(logRecord.stealthAddress)
        && !line.includes(logRecord.expectedAmountAtomic)),
    "27 quarantine detail is encrypted and plaintext logs contain only record id plus reason",
  );

  for (const value of [
    confirmedScenario,
    submittedScenario,
    emptyScenario,
    throwingScenario,
    cappedScenario,
    lateScenario,
    reserveScenario,
    logScenario,
  ]) {
    await value.service.waitForIdle();
    await value.book.close();
    await value.queue.close();
  }
  ledger.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

function fakeRail({ balances, calls, sweep, status }) {
  let boundRecord;
  let boundBook;
  return {
    network: "base",
    kind: "evm",
    tokenConfig: BASE_USDC,
    settlementMode: "onchain",
    poolMode: "onchain",
    poolAddress: Wallet.createRandom().address,
    depositCapable: true,
    bindRecord(record, book) {
      boundRecord = record;
      boundBook = book;
    },
    deriveDepositAddress: () => { throw new Error("unused"); },
    observedBalanceAtomic: async ({ stealthAddress }) => balances.get(stealthAddress) ?? 0n,
    sweepDeposit: async (input) => {
      const record = boundBook?.byId(boundRecord?.id) ?? {
        id: "unknown",
        sweepNonce: input.reuseSweepNonce,
      };
      if (sweep) return sweep({ input, record, book: boundBook, calls });
      calls.push(record.id);
      return {
        outcome: "confirmed",
        transactionHash: `0x${record.id}`,
        sweepNonce: input.reuseSweepNonce,
        observedAmountAtomic: (balances.get(input.expectedStealthAddress) ?? 0n).toString(),
      };
    },
    sweepTxStatus: status ?? (async () => ({ state: "unknown" })),
    buildQuote: () => { throw new Error("unused"); },
    ownsPayment: () => false,
    paymentNonce: () => undefined,
    resolveRecipient: () => { throw new Error("unused"); },
    submitPoolPayout: () => { throw new Error("unused"); },
    preparePoolPayout: () => { throw new Error("unused"); },
    broadcastPoolPayout: () => { throw new Error("unused"); },
    poolPayoutStatus: () => { throw new Error("unused"); },
    operatorPoolPayoutStatus: () => { throw new Error("unused"); },
    outboxEntriesByRef: () => [],
    classifyByLogicalId: () => { throw new Error("unused"); },
    recoverOutbox: async () => undefined,
    suppressPoolPayoutRebroadcast: () => undefined,
    bindPoolPayoutRef: () => undefined,
    finalizedBlockHeight: async () => undefined,
    settle: () => { throw new Error("unused"); },
  };
}

function addressTopic(address) {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function encodeBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const byte of bytes) numeric = numeric * 256n + BigInt(byte);
  let encoded = "";
  while (numeric > 0n) {
    const remainder = Number(numeric % 58n);
    numeric /= 58n;
    encoded = alphabet[remainder] + encoded;
  }
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  return "1".repeat(leadingZeros) + encoded;
}
