import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import { BASE_USDC } from "../src/shared/x402.ts";

const ephemeralBase = process.env.PX402_PRIVATE_LEDGER_EPHEMERAL_DIR ?? tmpdir();
const directory = await mkdtemp(join(ephemeralBase, "runtime-proof-"));
const epochDirectory = join(directory, "epochs");
const ledgerPath = join(directory, "ledger.json");
const encryptionKey = randomBytes(32).toString("hex");
const baseAssetKey = privateLedgerAssetKey("base", BASE_USDC.address);

try {
  const ledger = await new PrivatePaymentLedger(ledgerPath, encryptionKey, {
    journal: new EphemeralPaymentJournal(epochDirectory, {
      requireMemoryBacked: process.platform === "linux",
    }),
    retentionMs: 0,
  }).load({ runtimePayer: "10", runtimePayee: "0" });

  await ledger.transfer({
    payerAgentId: "runtimePayer",
    payeeAgentId: "runtimePayee",
    amountAtomic: "3",
    assetKey: baseAssetKey,
    authorizationNonce: randomBytes(32).toString("hex"),
    resourceHash: `0x${randomBytes(32).toString("hex")}`,
  });
  const artifactsBefore = await readdir(epochDirectory);
  const batch = await ledger.createSettlementBatch({ assetKey: baseAssetKey, network: "base", tokenAddress: BASE_USDC.address });
  if (!batch) throw new Error("Runtime proof did not create a settlement batch");
  await ledger.markBatchCommitted(batch.id, `0x${randomBytes(32).toString("hex")}`);
  const burn = await ledger.burnExpired(Date.now() + 1);
  const artifactsAfter = await readdir(epochDirectory);
  const state = await new EncryptedJsonFile(ledgerPath, encryptionKey, { failClosed: true }).read({});
  const serialized = JSON.stringify(state);
  const safe = artifactsBefore.some((name) => name.endsWith(".key"))
    && artifactsBefore.some((name) => name.endsWith(".jsonl"))
    && artifactsAfter.length === 0
    && burn.transfersRemoved === 1
    && burn.epochsBurned === 1
    && ledger.balance("runtimePayer", baseAssetKey) === "7"
    && ledger.balance("runtimePayee", baseAssetKey) === "3"
    && state.version === 4
    && state.transfers.length === 0
    && !serialized.includes("runtimePayer")
    && !serialized.includes("runtimePayee")
    && !serialized.includes("postings")
    && !serialized.includes("salt");
  ledger.close();

  console.log(JSON.stringify({
    safe,
    epochArtifactsCreated: artifactsBefore.length,
    epochArtifactsRemaining: artifactsAfter.length,
    transfersRemoved: burn.transfersRemoved,
    epochsBurned: burn.epochsBurned,
    balancesPreserved: state.version === 4 && state.transfers.length === 0,
  }));
  if (!safe) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
