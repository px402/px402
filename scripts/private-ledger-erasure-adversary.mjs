import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import { BASE_USDC } from "../src/shared/x402.ts";

const ephemeralBase = process.env.PX402_PRIVATE_LEDGER_EPHEMERAL_DIR ?? tmpdir();
const directory = await mkdtemp(join(ephemeralBase, "erasure-adversary-"));
const epochDirectory = join(directory, "epochs");
const ledgerPath = join(directory, "ledger.json");
const encryptionKey = randomBytes(32).toString("hex");
const resourceHash = `0x${"42".repeat(32)}`;
const baseAssetKey = privateLedgerAssetKey("base", BASE_USDC.address);

let exfiltratedKey;
let exfiltratedCiphertext;

try {
  const journal = new EphemeralPaymentJournal(epochDirectory, {
    requireMemoryBacked: process.platform === "linux",
  });
  const ledger = await new PrivatePaymentLedger(ledgerPath, encryptionKey, {
    journal,
    retentionMs: 0,
  }).load({ adversaryPayer: "10", adversaryPayee: "0" });

  await ledger.transfer({
    payerAgentId: "adversaryPayer",
    payeeAgentId: "adversaryPayee",
    amountAtomic: "3",
    assetKey: baseAssetKey,
    authorizationNonce: randomBytes(32).toString("hex"),
    resourceHash,
  });

  const stateBeforeBurn = await new EncryptedJsonFile(ledgerPath, encryptionKey, {
    failClosed: true,
  }).read({});
  const durableBeforeText = JSON.stringify(stateBeforeBurn);
  const epochId = stateBeforeBurn.transfers?.[0]?.epochId;
  if (typeof epochId !== "string") throw new Error("Active epoch was not indexed");

  const liveDetail = await journal.read(epochId);
  const liveHostCanReadActiveEpoch = liveDetail.length === 1
    && liveDetail[0].payer === "adversaryPayer"
    && liveDetail[0].payee === "adversaryPayee"
    && liveDetail[0].amountAtomic === "3"
    && liveDetail[0].resourceHash === resourceHash;

  const durableSnapshotContainsDetail = durableBeforeText.includes("adversaryPayer")
    || durableBeforeText.includes("adversaryPayee")
    || durableBeforeText.includes(resourceHash)
    || durableBeforeText.includes("postings")
    || durableBeforeText.includes('"salt"');

  // This models a root-level attacker copying both files during the live epoch.
  // Cryptographic erasure cannot revoke bytes already exfiltrated from the host.
  exfiltratedKey = Buffer.from(await readFile(join(epochDirectory, `${epochId}.key`)));
  exfiltratedCiphertext = Buffer.from(
    await readFile(join(epochDirectory, `${epochId}.jsonl`)),
  );

  const batch = await ledger.createSettlementBatch({ assetKey: baseAssetKey, network: "base", tokenAddress: BASE_USDC.address });
  if (!batch) throw new Error("Adversarial proof did not create a batch");
  await ledger.markBatchCommitted(batch.id, `0x${randomBytes(32).toString("hex")}`);
  const burn = await ledger.burnExpired(Date.now() + 1);

  let postBurnJournalRecovery = false;
  try {
    await journal.read(epochId);
    postBurnJournalRecovery = true;
  } catch {
    postBurnJournalRecovery = false;
  }

  const artifactsAfterBurn = await readdir(epochDirectory);
  ledger.close();

  const restarted = await new PrivatePaymentLedger(ledgerPath, encryptionKey, {
    journal: new EphemeralPaymentJournal(epochDirectory, {
      requireMemoryBacked: process.platform === "linux",
    }),
    retentionMs: 0,
  }).load();
  const stateAfterRestart = await new EncryptedJsonFile(ledgerPath, encryptionKey, {
    failClosed: true,
  }).read({});
  const postRestartText = JSON.stringify(stateAfterRestart);
  const restartRecoversOnlyBalances = restarted.balance("adversaryPayer", baseAssetKey) === "7"
    && restarted.balance("adversaryPayee", baseAssetKey) === "3"
    && stateAfterRestart.transfers.length === 0
    && !postRestartText.includes("adversaryPayer")
    && !postRestartText.includes("adversaryPayee")
    && !postRestartText.includes(resourceHash);
  restarted.close();

  const stolenRecord = JSON.parse(exfiltratedCiphertext.toString("utf8").trim().split("\n")[0]);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    exfiltratedKey,
    Buffer.from(stolenRecord.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(stolenRecord.tag, "base64"));
  const stolenPlaintext = Buffer.concat([
    decipher.update(Buffer.from(stolenRecord.ciphertext, "base64")),
    decipher.final(),
  ]);
  const stolenDetail = JSON.parse(stolenPlaintext.toString("utf8"));
  const preBurnExfiltrationSurvivesBurn = stolenDetail.payer === "adversaryPayer"
    && stolenDetail.payee === "adversaryPayee"
    && stolenDetail.amountAtomic === "3"
    && stolenDetail.resourceHash === resourceHash;
  stolenPlaintext.fill(0);

  const safe = liveHostCanReadActiveEpoch
    && !durableSnapshotContainsDetail
    && !postBurnJournalRecovery
    && artifactsAfterBurn.length === 0
    && restartRecoversOnlyBalances
    && preBurnExfiltrationSurvivesBurn
    && burn.transfersRemoved === 1
    && burn.epochsBurned === 1;

  console.log(JSON.stringify({
    safe,
    liveHostCanReadActiveEpoch,
    durableSnapshotContainsDetail,
    postBurnJournalRecovery,
    epochArtifactsRemaining: artifactsAfterBurn.length,
    restartRecoversOnlyBalances,
    preBurnExfiltrationSurvivesBurn,
  }));
  if (!safe) process.exitCode = 1;
} finally {
  exfiltratedKey?.fill(0);
  exfiltratedCiphertext?.fill(0);
  await rm(directory, { recursive: true, force: true });
}
