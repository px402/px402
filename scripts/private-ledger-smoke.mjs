import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Keypair } from "@solana/web3.js";
import { confirmPrivateLedgerDeposit, requestPrivateLedgerDepositIntent, requestPrivateLedgerQuote, preparePrivateLedgerVoucher, submitPrivateLedgerVoucher } from "../src/shared/privateX402Client.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { createPrivateAgentServer } from "../src/server/agents/createPrivateAgentServer.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import { BASE_USDC, ROBINHOOD_USDG, SOLANA_USDC } from "../src/shared/x402.ts";

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? (pass++, console.log("PASS", message)) : (fail++, console.log("FAIL", message));
const directory = await mkdtemp(join(tmpdir(), "px402-private-ledger-"));
const file = join(directory, "ledger.json");
const encryptionKey = "test-encryption-key-that-never-ships";
const epochDirectory = join(directory, "epochs");
const payerIdentity = Wallet.createRandom();
const payeeIdentity = Wallet.createRandom();
const baseOnlyIdentity = Wallet.createRandom();
const baseAssetKey = privateLedgerAssetKey("base", BASE_USDC.address);
const robinhoodAssetKey = privateLedgerAssetKey("robinhood", ROBINHOOD_USDG.address);
const solanaAssetKey = privateLedgerAssetKey("solana", SOLANA_USDC.address);
const journal = new EphemeralPaymentJournal(epochDirectory);
const ledger = await new PrivatePaymentLedger(file, encryptionKey, {
  journal,
  retentionMs: 100,
}).load({ payer: "1000000", payee: "0", baseOnly: "500000" });
const registry = new PrivateAgentRegistry([
  { agentId: "payer", label: "Payer", vpnIp: "127.0.0.1", walletAddress: Wallet.createRandom().address, identityAddress: payerIdentity.address, sharedSecret: "payer", credits: 0, inventory: [] },
  { agentId: "payee", label: "Payee", vpnIp: "127.0.0.1", walletAddress: Wallet.createRandom().address, identityAddress: payeeIdentity.address, sharedSecret: "payee", credits: 0, inventory: [] },
  { agentId: "baseOnly", label: "Base only", vpnIp: "127.0.0.1", walletAddress: Wallet.createRandom().address, identityAddress: baseOnlyIdentity.address, sharedSecret: "base-only", credits: 0, inventory: [] }
], { privateLedger: ledger });
const baseDepositHash = `0x${"ab".repeat(32)}`;
const robinhoodDepositHash = `0x${"bc".repeat(32)}`;
const solanaDepositHash = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const solanaFrom = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const solanaTreasury = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const solanaBatchSignature = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
let solanaProofPreserved = false;
let committedSolanaBatch;
const verifier = {
  verifyErc20Transfer: async (proof) => {
    const validBase = proof.transactionHash === baseDepositHash
      && proof.tokenAddress.toLowerCase() === BASE_USDC.address.toLowerCase()
      && proof.amountAtomic === "100000";
    const validRobinhood = proof.transactionHash === robinhoodDepositHash
      && proof.tokenAddress.toLowerCase() === ROBINHOOD_USDG.address.toLowerCase()
      && proof.amountAtomic === "400000";
    const validSolana = proof.transactionHash === solanaDepositHash
      && proof.tokenAddress === SOLANA_USDC.address
      && proof.fromAddress === solanaFrom
      && proof.recipient === solanaTreasury
      && proof.amountAtomic === "300000";
    if (validSolana) solanaProofPreserved = true;
    if (!validBase && !validRobinhood && !validSolana) throw new Error("mock deposit proof mismatch");
    return proof;
  }
};
const solanaCommitter = {
  commit: async (batch) => {
    if (batch.tokenAddress !== SOLANA_USDC.address) throw new Error("Solana batch mint case was not preserved");
    committedSolanaBatch = batch;
    return { transactionHash: solanaBatchSignature, alreadyCommitted: false };
  }
};
const server = createPrivateAgentServer({
  registry,
  ledger,
  facilitator: new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC }),
  settlementAdminToken: "settlement-test-token",
  deposits: new Map([
    ["base", { recipient: Wallet.createRandom().address, asset: BASE_USDC.address, verifier }],
    ["robinhood", { recipient: Wallet.createRandom().address, asset: ROBINHOOD_USDG.address, verifier }],
    ["solana", { recipient: solanaTreasury, asset: SOLANA_USDC.address, verifier }]
  ]),
  batchCommitters: new Map([["solana", solanaCommitter]])
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  const rpcUrl = `http://127.0.0.1:${address.port}`;
  const requirements = await requestPrivateLedgerQuote({
    rpcUrl,
    payeeAgentId: "payee",
    payerAgentId: "payer",
    amountAtomic: "250000",
    resource: "resource:dataset-42",
    identitySigner: payeeIdentity
  });
  ok(requirements.scheme === "px402-private-batch" && requirements.resourceHash.startsWith("0x"), "private quote exposes a hash, not resource metadata");
  const voucher = await preparePrivateLedgerVoucher({ requirements, identitySigner: payerIdentity });
  const response = await submitPrivateLedgerVoucher({ rpcUrl, voucher });
  ok(response.payment.status === "accepted" && response.payment.payerBalanceAtomic === "750000", "signed voucher atomically debits the payer");
  ok(!("receipt" in response) && !JSON.stringify(response).includes("payee"), "payment response contains no receipt or counterparty identity");
  let wrongPeerRejected = false;
  try { registry.privateBalance("payer", "10.77.99.99"); } catch { wrongPeerRejected = true; }
  ok(wrongPeerRejected, "balance lookup is scoped to the registered WireGuard peer");

  const depositFrom = Wallet.createRandom().address;
  const { intent } = await requestPrivateLedgerDepositIntent({ rpcUrl, agentId: "payer", fromAddress: depositFrom, amountAtomic: "100000", identitySigner: payerIdentity });
  const deposit = await confirmPrivateLedgerDeposit({ rpcUrl, agentId: "payer", depositId: intent.depositId, transactionHash: baseDepositHash, identitySigner: payerIdentity });
  ok(deposit.payment.status === "credited" && deposit.payment.balanceAtomic === "850000", "verified Base escrow deposit credits the encrypted balance");

  const { intent: robinhoodIntent } = await requestPrivateLedgerDepositIntent({
    rpcUrl,
    agentId: "payer",
    fromAddress: depositFrom,
    amountAtomic: "400000",
    network: "robinhood",
    identitySigner: payerIdentity
  });
  const robinhoodDeposit = await confirmPrivateLedgerDeposit({
    rpcUrl,
    agentId: "payer",
    depositId: robinhoodIntent.depositId,
    transactionHash: robinhoodDepositHash,
    network: "eip155:4663",
    identitySigner: payerIdentity
  });
  ok(robinhoodDeposit.payment.balanceAtomic === "400000"
    && ledger.balance("payer", robinhoodAssetKey) === "400000"
    && ledger.balance("payer", baseAssetKey) === "850000", "USDG deposit credits only the Robinhood asset-key balance");

  const { intent: solanaIntent } = await requestPrivateLedgerDepositIntent({
    rpcUrl,
    agentId: "payer",
    fromAddress: solanaFrom,
    amountAtomic: "300000",
    network: "solana",
    identitySigner: payerIdentity
  });
  ok(solanaIntent.asset === SOLANA_USDC.address
    && solanaIntent.recipient === solanaTreasury,
  "Solana deposit intent preserves the exact mixed-case mint and base58 treasury");
  const solanaDeposit = await confirmPrivateLedgerDeposit({
    rpcUrl,
    agentId: "payer",
    depositId: solanaIntent.depositId,
    transactionHash: solanaDepositHash,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    identitySigner: payerIdentity
  });
  ok(solanaProofPreserved
    && solanaDeposit.payment.balanceAtomic === "300000"
    && ledger.balance("payer", solanaAssetKey) === "300000"
    && ledger.balance("payer", baseAssetKey) === "850000"
    && ledger.balance("payer", robinhoodAssetKey) === "400000",
  "case-preserved USDC-SPL verification credits only the Solana asset-key balance");

  const robinhoodRequirements = await requestPrivateLedgerQuote({
    rpcUrl,
    payeeAgentId: "payee",
    payerAgentId: "payer",
    amountAtomic: "150000",
    resource: "item:robinhood-only",
    network: "robinhood",
    identitySigner: payeeIdentity
  });
  const robinhoodVoucher = await preparePrivateLedgerVoucher({ requirements: robinhoodRequirements, identitySigner: payerIdentity });
  const robinhoodPayment = await submitPrivateLedgerVoucher({ rpcUrl, voucher: robinhoodVoucher });
  ok(robinhoodPayment.payment.payerBalanceAtomic === "250000"
    && ledger.balance("payer", robinhoodAssetKey) === "250000"
    && ledger.balance("payer", baseAssetKey) === "850000", "Robinhood voucher debits only the USDG balance");

  const solanaRequirements = await requestPrivateLedgerQuote({
    rpcUrl,
    payeeAgentId: "payee",
    payerAgentId: "payer",
    amountAtomic: "100000",
    resource: "item:solana-only",
    network: "solana",
    identitySigner: payeeIdentity
  });
  ok(privateLedgerAssetKey("solana", solanaRequirements.asset) === solanaAssetKey,
    "Solana deposit and private-quote paths resolve the same opaque asset key");
  const solanaVoucher = await preparePrivateLedgerVoucher({ requirements: solanaRequirements, identitySigner: payerIdentity });
  const solanaPayment = await submitPrivateLedgerVoucher({ rpcUrl, voucher: solanaVoucher });
  ok(solanaPayment.payment.payerBalanceAtomic === "200000"
    && ledger.balance("payer", solanaAssetKey) === "200000"
    && ledger.balance("payee", solanaAssetKey) === "100000",
  "Solana private voucher debits only the USDC-SPL balance");

  const solanaCrossAssetRequirements = await requestPrivateLedgerQuote({
    rpcUrl,
    payeeAgentId: "payee",
    payerAgentId: "baseOnly",
    amountAtomic: "1",
    resource: "item:solana-cross-asset-rejected",
    network: "solana",
    identitySigner: payeeIdentity
  });
  const solanaCrossAssetVoucher = await preparePrivateLedgerVoucher({ requirements: solanaCrossAssetRequirements, identitySigner: baseOnlyIdentity });
  let solanaCrossAssetRejected = false;
  try { await submitPrivateLedgerVoucher({ rpcUrl, voucher: solanaCrossAssetVoucher }); } catch { solanaCrossAssetRejected = true; }
  ok(solanaCrossAssetRejected
    && ledger.balance("baseOnly", baseAssetKey) === "500000"
    && ledger.balance("baseOnly", solanaAssetKey) === "0",
  "Base-only funds cannot overspend a Solana voucher");

  const crossAssetRequirements = await requestPrivateLedgerQuote({
    rpcUrl,
    payeeAgentId: "payee",
    payerAgentId: "baseOnly",
    amountAtomic: "1",
    resource: "item:cross-asset-rejected",
    network: "robinhood",
    identitySigner: payeeIdentity
  });
  const crossAssetVoucher = await preparePrivateLedgerVoucher({ requirements: crossAssetRequirements, identitySigner: baseOnlyIdentity });
  let crossAssetRejected = false;
  try { await submitPrivateLedgerVoucher({ rpcUrl, voucher: crossAssetVoucher }); } catch { crossAssetRejected = true; }
  ok(crossAssetRejected
    && ledger.balance("baseOnly", baseAssetKey) === "500000"
    && ledger.balance("baseOnly", robinhoodAssetKey) === "0", "Base-only funds cannot overspend a Robinhood voucher");

  const receiptHistory = await fetch(`${rpcUrl}/private/a2a/x402-receipts`);
  ok(receiptHistory.status === 404, "payment receipt history is disabled");
  const deniedBatch = await fetch(`${rpcUrl}/private/settlement/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset: BASE_USDC.address }) });
  ok(deniedBatch.status === 404, "settlement batches are hidden without the admin bearer token");
  const batchResponse = await fetch(`${rpcUrl}/private/settlement/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer settlement-test-token" },
    body: JSON.stringify({ asset: BASE_USDC.address })
  });
  const { batch } = await batchResponse.json();
  ok(batchResponse.status === 201 && batch.transferCount === 2 && /^0x[0-9a-f]{64}$/.test(batch.merkleRoot), "settlement worker creates a deterministic aggregate commitment");
  const robinhoodBatchResponse = await fetch(`${rpcUrl}/private/settlement/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer settlement-test-token" },
    body: JSON.stringify({ network: "robinhood" })
  });
  const { batch: robinhoodBatch } = await robinhoodBatchResponse.json();
  ok(robinhoodBatchResponse.status === 201
    && robinhoodBatch.network === "robinhood"
    && robinhoodBatch.asset === robinhoodAssetKey
    && robinhoodBatch.transferCount === 2
    && robinhoodBatch.merkleRoot !== batch.merkleRoot, "separate asset-key batches produce distinct aggregate roots");
  const solanaBatchResponse = await fetch(`${rpcUrl}/private/settlement/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer settlement-test-token" },
    body: JSON.stringify({ network: "solana" })
  });
  const { batch: solanaBatch } = await solanaBatchResponse.json();
  ok(solanaBatchResponse.status === 201
    && solanaBatch.status === "chain-committed"
    && solanaBatch.network === "solana"
    && solanaBatch.asset === solanaAssetKey
    && solanaBatch.tokenAddress === SOLANA_USDC.address
    && solanaBatch.transferCount === 2
    && solanaBatch.merkleRoot !== batch.merkleRoot
    && solanaBatch.merkleRoot !== robinhoodBatch.merkleRoot
    && committedSolanaBatch?.tokenAddress === SOLANA_USDC.address
    && solanaBatch.transactionHash === solanaBatchSignature,
  "Solana batch has a distinct root and stores the case-preserved Memo transaction signature");

  const raw = await readFile(file, "utf8");
  ok(raw.includes('"algorithm": "aes-256-gcm"') && !raw.includes("payer") && !raw.includes("dataset-42"), "ledger is AES-256-GCM encrypted without plaintext payment metadata");

  const storedBeforeBurn = await new EncryptedJsonFile(file, encryptionKey, { failClosed: true }).read({});
  const storedText = JSON.stringify(storedBeforeBurn);
  ok(storedBeforeBurn.version === 4
    && Object.keys(storedBeforeBurn.accounts).every((id) => /^acct_[0-9a-f]{64}$/.test(id))
    && !storedText.includes("payer")
    && !storedText.includes("payee")
    && !storedText.includes("postings")
    && !storedText.includes("netPositions")
    && !storedText.includes('"salt"'), "durable v3 state keeps only pseudonymous per-asset balances and commitments");
  const epochFilesBeforeBurn = await readdir(epochDirectory);
  const epochRaw = await Promise.all(epochFilesBeforeBurn.filter((name) => name.endsWith(".jsonl")).map((name) => readFile(join(epochDirectory, name), "utf8")));
  ok(epochFilesBeforeBurn.some((name) => name.endsWith(".key"))
    && epochRaw.every((value) => !value.includes("payer") && !value.includes("250000")), "transaction detail is encrypted under a per-epoch key in the ephemeral journal");

  await ledger.markBatchCommitted(batch.id, `0x${"cd".repeat(32)}`);
  await ledger.markBatchCommitted(robinhoodBatch.id, `0x${"de".repeat(32)}`);
  const burn = await ledger.burnExpired(Date.now() + 1000);
  ok(burn.transfersRemoved === 6 && burn.epochsBurned === 3 && (await readdir(epochDirectory)).length === 0, "settlement retention expiry destroys the epoch keys and ciphertext");
  const storedAfterBurn = await new EncryptedJsonFile(file, encryptionKey, { failClosed: true }).read({});
  ok(storedAfterBurn.transfers.length === 0
    && storedAfterBurn.batches.length === 3
    && storedAfterBurn.batches[0].merkleRoot === batch.merkleRoot, "burn retains only current balances and public settlement proof");

  const reloaded = await new PrivatePaymentLedger(file, encryptionKey, {
    journal: new EphemeralPaymentJournal(epochDirectory),
    retentionMs: 100,
  }).load();
  ok(reloaded.balance("payer", baseAssetKey) === "850000"
    && reloaded.balance("payee", baseAssetKey) === "250000"
    && reloaded.balance("payer", robinhoodAssetKey) === "250000"
    && reloaded.balance("payee", robinhoodAssetKey) === "150000"
    && reloaded.balance("payer", solanaAssetKey) === "200000"
    && reloaded.balance("payee", solanaAssetKey) === "100000", "encrypted per-asset balances survive restart");
  let wrongKeyRejected = false;
  try {
    await new PrivatePaymentLedger(file, "wrong-key", {
      journal: new EphemeralPaymentJournal(join(directory, "wrong-key-epochs")),
      retentionMs: 100,
    }).load();
  } catch { wrongKeyRejected = true; }
  ok(wrongKeyRejected, "wrong encryption key fails closed instead of resetting balances");

  let replayedDepositRejected = false;
  try {
    await reloaded.creditDeposit({
      agentId: "payer",
      amountAtomic: "100000",
      network: "base",
      assetKey: baseAssetKey,
      transactionHash: baseDepositHash,
    });
  } catch { replayedDepositRejected = true; }
  ok(replayedDepositRejected && reloaded.balance("payer", baseAssetKey) === "850000", "deposit hash tombstone prevents re-credit after detail erasure");

  const raceFile = join(directory, "race.json");
  const raceLedger = await new PrivatePaymentLedger(raceFile, "race-test-key", {
    journal: new EphemeralPaymentJournal(join(directory, "race-epochs")),
    retentionMs: 100,
  }).load({ payer: "1000000", payee: "0" });
  const attempts = await Promise.allSettled([
    raceLedger.transfer({ payerAgentId: "payer", payeeAgentId: "payee", amountAtomic: "700000", assetKey: baseAssetKey, authorizationNonce: "race-a", resourceHash: "0x01" }),
    raceLedger.transfer({ payerAgentId: "payer", payeeAgentId: "payee", amountAtomic: "700000", assetKey: baseAssetKey, authorizationNonce: "race-b", resourceHash: "0x02" })
  ]);
  ok(attempts.filter((entry) => entry.status === "fulfilled").length === 1 && raceLedger.balance("payer", baseAssetKey) === "300000", "serialized journal prevents concurrent overspend");

  const legacyFile = join(directory, "legacy.json");
  const legacyKey = "legacy-test-key";
  await new EncryptedJsonFile(legacyFile, legacyKey, { failClosed: true }).write({
    version: 1,
    accounts: { payer: { availableAtomic: "9" }, payee: { availableAtomic: "1" } },
    transfers: [{
      id: "legacy-transfer",
      source: "voucher",
      asset: BASE_USDC.address,
      authorizationHash: `0x${"11".repeat(32)}`,
      commitment: `0x${"22".repeat(32)}`,
      salt: "legacy-secret-salt",
      postings: [
        { accountId: "payer", deltaAtomic: "-1" },
        { accountId: "payee", deltaAtomic: "1" },
      ],
      acceptedAt: 1,
    }],
    batches: [],
  });
  const migrated = await new PrivatePaymentLedger(legacyFile, legacyKey, {
    journal: new EphemeralPaymentJournal(join(directory, "legacy-epochs")),
    retentionMs: 100,
  }).load();
  const migratedState = await new EncryptedJsonFile(legacyFile, legacyKey, { failClosed: true }).read({});
  ok(migrated.balance("payer", baseAssetKey) === "9"
    && migratedState.version === 4
    && !JSON.stringify(migratedState).includes("legacy-secret-salt")
    && !JSON.stringify(migratedState).includes("postings"), "v1 ledgers chain-migrate without retaining historical postings or salts");

  const v2File = join(directory, "v2.json");
  const v2Key = "v2-migration-test-key";
  const v2AccountKey = createHash("sha256")
    .update("px402-private-ledger/account-index/v2\0")
    .update(v2Key)
    .digest();
  const v2PayerAccountId = `acct_${createHmac("sha256", v2AccountKey).update("payer").digest("hex")}`;
  const v2DepositHash = `0x${"ef".repeat(32)}`;
  const v2AuthorizationHash = `0x${createHash("sha256").update(`deposit:${v2DepositHash}`).digest("hex")}`;
  await new EncryptedJsonFile(v2File, v2Key, { failClosed: true }).write({
    version: 2,
    accounts: { [v2PayerAccountId]: { availableAtomic: "77" } },
    transfers: [{
      id: "v2-voucher",
      source: "voucher",
      asset: BASE_USDC.address,
      authorizationHash: `0x${"55".repeat(32)}`,
      commitment: `0x${"33".repeat(32)}`,
      acceptedAt: 2,
      epochId: "legacy-v2-voucher"
    }],
    batches: [{
      id: "v2-batch",
      asset: BASE_USDC.address,
      merkleRoot: `0x${"44".repeat(32)}`,
      transferCount: 1,
      createdAt: 3
    }],
    consumedDepositHashes: [v2AuthorizationHash]
  });
  const v2Migrated = await new PrivatePaymentLedger(v2File, v2Key, {
    journal: new EphemeralPaymentJournal(join(directory, "v2-epochs")),
    retentionMs: 100,
  }).load();
  const v3State = await new EncryptedJsonFile(v2File, v2Key, { failClosed: true }).read({});
  let legacyHashReplayRejected = false;
  try {
    await v2Migrated.creditDeposit({
      agentId: "payer",
      amountAtomic: "1",
      network: "base",
      assetKey: baseAssetKey,
      transactionHash: v2DepositHash
    });
  } catch { legacyHashReplayRejected = true; }
  const voucherCompatFile = join(directory, "voucher-compat-v3.json");
  const voucherCompatKey = "voucher-compat-test-key";
  await new EncryptedJsonFile(voucherCompatFile, voucherCompatKey, { failClosed: true }).write({
    version: 3,
    accounts: {},
    transfers: [],
    batches: [],
    consumedDepositHashes: [],
  });
  const voucherCompatLedger = await new PrivatePaymentLedger(
    voucherCompatFile,
    voucherCompatKey,
    {
      journal: new EphemeralPaymentJournal(join(directory, "voucher-compat-epochs")),
      retentionMs: 100,
    },
  ).load({ compatAgent: "1" });
  const voucherDefaultedState = await new EncryptedJsonFile(
    voucherCompatFile,
    voucherCompatKey,
    { failClosed: true },
  ).read({});
  const compatKeysetId = `0x${"77".repeat(32)}`;
  await voucherCompatLedger.meltToVouchers({
    agentId: "compatAgent",
    amountAtomic: "1",
    assetKey: baseAssetKey,
    keysetId: compatKeysetId,
    meltKey: `0x${"88".repeat(32)}`,
  });
  const voucherRoundTripState = await new EncryptedJsonFile(
    voucherCompatFile,
    voucherCompatKey,
    { failClosed: true },
  ).read({});
  ok(v2Migrated.balance("payer", baseAssetKey) === "77"
    && v3State.version === 4
    && v3State.transfers[0].asset === baseAssetKey
    && v3State.batches[0].asset === baseAssetKey
    && v3State.batches[0].network === "base"
    && Object.keys(voucherDefaultedState.consumedVoucherRefs).length === 0
    && voucherRoundTripState.consumedVoucherRefs[compatKeysetId].length === 1
    && legacyHashReplayRejected, "v2 migration preserves Base balances, asset keys, and legacy deposit replay protection");
  voucherCompatLedger.close();

  const baseOnlyServer = createPrivateAgentServer({
    registry,
    ledger,
    deposits: new Map([["base", { recipient: Wallet.createRandom().address, asset: BASE_USDC.address, verifier }]])
  });
  baseOnlyServer.listen(0, "127.0.0.1");
  await once(baseOnlyServer, "listening");
  const baseOnlyAddress = baseOnlyServer.address();
  if (!baseOnlyAddress || typeof baseOnlyAddress === "string") throw new Error("Base-only server did not expose a TCP port");
  let unsupportedNetworkRejected = false;
  try {
    await requestPrivateLedgerQuote({
      rpcUrl: `http://127.0.0.1:${baseOnlyAddress.port}`,
      payeeAgentId: "payee",
      payerAgentId: "payer",
      amountAtomic: "1",
      resource: "unsupported-ledger-network",
      network: "robinhood",
      identitySigner: payeeIdentity
    });
  } catch { unsupportedNetworkRejected = true; }
  ok(unsupportedNetworkRejected, "private-ledger quote rejects a network without a deposit configuration");
  baseOnlyServer.close();
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
