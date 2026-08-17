// Operator recovery for a deposit sweep that landed on-chain but was recorded as
// `reserve-mismatch` / `zero-without-receipt`.
//
// That happens when the sweep is rebroadcast at the same settler nonce: the
// replacement mines and empties the address, but the record still holds the
// dropped hash, so the next pass sees an empty address with no receipt for the
// hash it knows and quarantines a sweep that actually succeeded. One such record
// makes reserveOk() false for the whole asset, which blocks every pool payout on
// that network.
//
// This does NOT trust the operator. It re-derives the evidence from the chain and
// refuses unless a confirmed Transfer(stealthAddress -> pool) of at least the
// observed amount exists. Run with the app STOPPED: the service keeps the book in
// memory and would overwrite an edit made underneath it.
//
//   node scripts/deposit-resolve-swept.mjs --record <id> [--confirm]
//
// Plain node by design (crypto + fetch only) so it can run on the VPS, where the
// encrypted book lives and node_modules does not.
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const ENV_PATH = argValue("--env") ?? ".env";
const BOOK_PATH = argValue("--book") ?? "data/private-deposit-addresses.json";
const recordId = argValue("--record");
const confirm = process.argv.includes("--confirm");
if (!recordId) throw new Error("--record <id> is required");

const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()])
);

const keyMaterial = env.PX402_DATA_ENCRYPTION_KEY;
if (!keyMaterial) throw new Error("PX402_DATA_ENCRYPTION_KEY is required");
const deriveKey = (value) => {
  const trimmed = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(trimmed).digest();
};
const key = deriveKey(keyMaterial);

const payload = JSON.parse(readFileSync(BOOK_PATH, "utf8"));
if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") {
  throw new Error("deposit book is not an encrypted v1 payload");
}
const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
const book = JSON.parse(
  Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8")
);

const record = book.records.find((entry) => entry.id === recordId);
if (!record) throw new Error(`record ${recordId} not found`);
if (record.status !== "reserve-mismatch" || record.quarantineReason !== "zero-without-receipt") {
  throw new Error(`record is ${record.status}/${record.quarantineReason}, refusing (expected reserve-mismatch/zero-without-receipt)`);
}

const RPC_BY_NETWORK = {
  base: env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org",
  robinhood: env.PX402_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
};
const POOL_BY_NETWORK = {
  base: env.PX402_BASE_TREASURY,
  robinhood: env.PX402_RH_TREASURY ?? env.PX402_BASE_TREASURY
};
const rpcUrl = RPC_BY_NETWORK[record.network];
const pool = POOL_BY_NETWORK[record.network];
if (!rpcUrl) throw new Error(`no RPC configured for network ${record.network}`);
if (!pool) throw new Error(`no pool/treasury configured for network ${record.network}`);

const rpc = async (method, params) => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicFor = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const expected = BigInt(record.observedAmountAtomic ?? record.expectedAmountAtomic);

console.log("=== deposit sweep resolution ===");
console.log(`RECORD  ${record.id}`);
console.log(`ADDRESS ${record.stealthAddress} -> POOL ${pool}`);
console.log(`EXPECT  >= ${expected} atomic of ${record.tokenAddress}`);
console.log(`STORED  sweepTxHash=${record.sweepTxHash} (believed dropped)`);

// The address must actually be empty; if it still holds funds the sweep did not
// land and this is not the situation this tool resolves.
const balanceHex = await rpc("eth_call", [
  { to: record.tokenAddress, data: `0x70a08231${record.stealthAddress.slice(2).toLowerCase().padStart(64, "0")}` },
  "latest"
]);
if (BigInt(balanceHex) !== 0n) {
  throw new Error(`stealth address still holds ${BigInt(balanceHex)} atomic; sweep did not land`);
}

const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
// Public RPCs cap eth_getLogs at a 10k block range, so walk backwards in windows
// rather than asking for one wide span (which fails outright instead of
// truncating). Newest-first with an early exit keeps the common case to one call.
const WINDOW = 9_000;
const MAX_WINDOWS = 40;
let landing;
for (let index = 0; index < MAX_WINDOWS && !landing; index += 1) {
  const toBlock = latest - index * WINDOW;
  const fromBlock = Math.max(0, toBlock - WINDOW + 1);
  const logs = await rpc("eth_getLogs", [
    {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: record.tokenAddress,
      topics: [TRANSFER_TOPIC, topicFor(record.stealthAddress), topicFor(pool)]
    }
  ]);
  landing = logs.filter((log) => BigInt(log.data) >= expected).pop();
  if (fromBlock === 0) break;
}
if (!landing) throw new Error("no confirmed Transfer(stealthAddress -> pool) of at least the observed amount");

const receipt = await rpc("eth_getTransactionReceipt", [landing.transactionHash]);
if (!receipt || receipt.status !== "0x1") throw new Error("landing transaction is not a confirmed success");
const confirmations = latest - Number(BigInt(receipt.blockNumber)) + 1;
const minConfirmations = Number(env.PX402_DEPOSIT_SWEEP_CONFIRMATIONS ?? 2);
if (confirmations < minConfirmations) {
  throw new Error(`landing has ${confirmations} confirmations, need ${minConfirmations}`);
}

console.log(`LANDED  ${landing.transactionHash}`);
console.log(`        value=${BigInt(landing.data)} block=${Number(BigInt(receipt.blockNumber))} confirmations=${confirmations}`);
console.log(`VERDICT sweep succeeded under a replacement hash; record may be marked swept`);

if (!confirm) {
  console.log("READY: re-run with --confirm to write (app must be stopped).");
  process.exit(0);
}

record.status = "swept";
record.sweepTxHash = landing.transactionHash;
record.sweptAt = Date.now();
record.quarantineReason = null;
record.nextRetryAt = null;

const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(book), "utf8"), cipher.final()]);
const next = {
  version: 1,
  algorithm: "aes-256-gcm",
  iv: iv.toString("base64"),
  tag: cipher.getAuthTag().toString("base64"),
  ciphertext: ciphertext.toString("base64")
};
// write-then-rename so a crash cannot leave a half-written book
writeFileSync(`${BOOK_PATH}.tmp`, JSON.stringify(next, null, 2));
chmodSync(`${BOOK_PATH}.tmp`, 0o600);
renameSync(`${BOOK_PATH}.tmp`, BOOK_PATH);
console.log(`PASS record ${record.id} marked swept with ${landing.transactionHash}`);
