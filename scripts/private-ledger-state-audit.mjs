import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const filePath = process.argv[2] ?? "/app/data/private-payment-ledger.json";
const keyMaterial = process.env.PX402_DATA_ENCRYPTION_KEY?.trim();
if (!keyMaterial) throw new Error("PX402_DATA_ENCRYPTION_KEY is required");

const envelope = JSON.parse(await readFile(filePath, "utf8"));
if (envelope.algorithm !== "aes-256-gcm") throw new Error("Ledger is not AES-256-GCM encrypted");

const key = deriveKey(keyMaterial);
const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
const plaintext = Buffer.concat([
  decipher.update(Buffer.from(envelope.ciphertext, "base64")),
  decipher.final(),
]).toString("utf8");
key.fill(0);

const state = JSON.parse(plaintext);
const accountIds = Object.keys(state.accounts ?? {});
const accountBalances = Object.values(state.accounts ?? {});
const forbidden = ["postings", "netPositions", "salt", "payerAgentId", "payeeAgentId", "resourceHash"];
const forbiddenFieldsPresent = forbidden.filter((field) => plaintext.includes(`"${field}"`));
const safe = state.version === 4
  && accountIds.every((id) => /^acct_[0-9a-f]{64}$/.test(id))
  && accountBalances.every((balances) => Object.entries(balances).every(([assetKey, balance]) =>
    assetKey.includes(":") && typeof balance?.availableAtomic === "string"))
  && Array.isArray(state.transfers)
  && state.transfers.every((transfer) => typeof transfer.asset === "string" && transfer.asset.includes(":"))
  && Array.isArray(state.batches)
  && state.batches.every((batch) => typeof batch.network === "string"
    && typeof batch.tokenAddress === "string"
    && batch.asset === `${batch.network}:${batch.tokenAddress.toLowerCase()}`)
  && Array.isArray(state.consumedDepositHashes)
  && forbiddenFieldsPresent.length === 0;

console.log(JSON.stringify({
  safe,
  version: state.version,
  accountIdsHmacDerived: accountIds.every((id) => /^acct_[0-9a-f]{64}$/.test(id)),
  assetBalanceCount: accountBalances.reduce((count, balances) => count + Object.keys(balances).length, 0),
  pendingCommitmentCount: Array.isArray(state.transfers) ? state.transfers.length : -1,
  batchProofCount: Array.isArray(state.batches) ? state.batches.length : -1,
  forbiddenFieldsPresent,
}));
process.exitCode = safe ? 0 : 1;

function deriveKey(value) {
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(value).digest();
}
