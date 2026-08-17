import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const keyMaterial = process.env.PX402_DATA_ENCRYPTION_KEY;
if (!keyMaterial) {
  console.error("PX402_DATA_ENCRYPTION_KEY is required");
  process.exit(2);
}

const journalPath = resolve(args.journal ?? "data/pending-payouts.json");
const ledgerPath = resolve(args.ledger ?? "data/private-payment-ledger.json");
const [journal, ledger] = await Promise.all([
  readEncryptedJson(journalPath, keyMaterial),
  readEncryptedJson(ledgerPath, keyMaterial),
]);

const findings = [];
const ledgerByRef = new Map(
  (ledger.transfers ?? [])
    .filter((transfer) => transfer.source === "payout" && transfer.payoutRef)
    .map((transfer) => [transfer.payoutRef, transfer]),
);
const journalRefs = new Set();
for (const group of journal.groups ?? []) {
  for (const leg of group.legs ?? []) {
    journalRefs.add(leg.payoutRef);
    if (leg.state === "uncertain" || group.groupState === "uncertain") {
      findings.push({
        kind: "uncertain",
        groupRef: group.groupRef,
        legIndex: leg.index,
        amountAtomic: leg.amountAtomic,
        state: leg.state,
      });
    }
    const transfer = ledgerByRef.get(leg.payoutRef);
    if (!transfer && leg.state !== "failed") {
      findings.push({
        kind: "journal-without-ledger",
        groupRef: group.groupRef,
        legIndex: leg.index,
        amountAtomic: leg.amountAtomic,
        state: leg.state,
      });
    }
  }
}
for (const [ref, transfer] of ledgerByRef) {
  if (transfer.settledAt == null && !transfer.batchId && !journalRefs.has(ref)) {
    findings.push({
      kind: "ledger-without-journal",
      groupRef: ref,
      legIndex: null,
      amountAtomic: transfer.reversalAmountAtomic ?? "unknown",
      state: "reserved",
    });
  }
}

for (const finding of findings) {
  console.log(JSON.stringify(finding));
}
console.log(`POOL_PAYOUT_AUDIT findings=${findings.length}`);
process.exitCode = findings.length > 0 ? 1 : 0;

async function readEncryptedJson(path, material) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (payload?.version !== 1 || payload?.algorithm !== "aes-256-gcm") {
    throw new Error(`${path} is not an AES-256-GCM encrypted JSON file`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(material),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));
}

function deriveKey(value) {
  const trimmed = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(trimmed).digest();
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--journal") output.journal = values[++index];
    else if (value === "--ledger") output.ledger = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return output;
}
