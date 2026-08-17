// Gaslessly moves Base USDC out of the disposable x402 proof wallets, which
// hold USDC but no ETH.
//
// USDC on Base implements EIP-3009, so the holder only SIGNS a
// `transferWithAuthorization` and the settler broadcasts and pays gas. Two uses:
//
//   consolidation  — sweep leftovers back into the pool (default destination)
//   ledger funding — pay a one-time private-ledger deposit address, which is
//                    what actually credits an agent balance
//
//   npm run x402:gasless-send                                    # all sources -> pool, full balance
//   npm run x402:gasless-send -- --to 0xDEPOSIT --amount 500000 --from X402_PAYEE_KEY
//
// Guarded: preflight + live simulation by default, --confirm to broadcast.
//
// The funding edge this writes is public. That is fine for these wallets (they
// are already linked to the pool by the earlier proofs) but it is exactly the
// documented Phase-2 residual — do not use it to fund a payer you need
// unlinkable.
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, getAddress } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

console.warn(`!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.`);

const readEnv = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].trim()])
  );

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const env = readEnv(".env.x402.local");
if (!env.PX402_BASE_X402_SETTLER_KEY) {
  throw new Error("PX402_BASE_X402_SETTLER_KEY is required in .env.x402.local");
}

const rpcUrl = env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";
const provider = new JsonRpcProvider(rpcUrl, 8453);
const settler = new Wallet(env.PX402_BASE_X402_SETTLER_KEY);
const pool = getAddress(settler.address);
const destination = getAddress(argValue("--to") ?? pool);
const amountOverride = argValue("--amount");
if (amountOverride !== undefined && BigInt(amountOverride) <= 0n) {
  throw new Error("--amount must be positive atomic units");
}

const requestedSource = argValue("--from");
const SOURCE_KEYS = requestedSource ? [requestedSource] : ["X402_PAYER_KEY", "X402_PAYEE_KEY"];
if (requestedSource && !env[requestedSource]) throw new Error(`${requestedSource} not found in .env.x402.local`);
// An explicit --amount with several sources would silently send it from each.
if (amountOverride !== undefined && SOURCE_KEYS.length > 1) {
  throw new Error("--amount requires a single --from source");
}

const sources = SOURCE_KEYS.filter((name) => env[name]).map((name) => ({ name, privateKey: env[name] }));
if (sources.length === 0) throw new Error(`no source keys found (looked for ${SOURCE_KEYS.join(", ")})`);

const usdc = new Contract(BASE_USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);
const facilitator = new X402Facilitator({
  rpcUrl,
  settlerPrivateKey: env.PX402_BASE_X402_SETTLER_KEY,
  token: BASE_USDC
});
const confirm = process.argv.includes("--confirm");

const settlerEth = await provider.getBalance(pool);
const destinationBefore = await usdc.balanceOf(destination);

console.log("=== gasless Base USDC send ===");
console.log(`SETTLER ${pool} ETH=${formatEther(settlerEth)}  (pays gas, broadcasts)`);
console.log(`DEST    ${destination} USDC=${formatUnits(destinationBefore, 6)}${destination === pool ? "  (pool)" : ""}`);
if (settlerEth === 0n) throw new Error("Settler has no ETH for Base gas; it cannot broadcast");

const plan = [];
for (const source of sources) {
  const wallet = new Wallet(source.privateKey);
  const address = getAddress(wallet.address);
  const [balance, code] = await Promise.all([usdc.balanceOf(address), provider.getCode(address)]);
  const value = amountOverride === undefined ? balance : BigInt(amountOverride);
  // EIP-3009 here is raw ECDSA. USDC routes addresses WITH code through EIP-1271,
  // which this path does not satisfy, so a contract account would silently fail.
  const skip =
    value === 0n ? "nothing to send"
    : code !== "0x" ? "not an EOA (EIP-1271 required)"
    : balance < value ? `balance ${formatUnits(balance, 6)} < requested ${formatUnits(value, 6)}`
    : null;
  console.log(
    `SOURCE  ${source.name} ${address} USDC=${formatUnits(balance, 6)} send=${formatUnits(value, 6)}${skip ? `  SKIP: ${skip}` : ""}`
  );
  if (!skip) plan.push({ ...source, address, value });
}

const total = plan.reduce((sum, item) => sum + item.value, 0n);
console.log(`SEND    ${plan.length} transfer(s), ${formatUnits(total, 6)} USDC -> ${destination}`);
if (plan.length === 0) {
  console.log("Nothing to send.");
  process.exit(0);
}

// Simulate every leg first (eth_call: no gas, no broadcast). A signature the live
// contract would reject surfaces here instead of as a burnt transaction.
const nowSeconds = (await provider.getBlock("latest")).timestamp;
for (const item of plan) {
  const requirements = buildPaymentRequirements({
    payTo: destination,
    maxAmountRequired: item.value.toString(),
    resource: "x402-gasless-send",
    nowSeconds
  });
  const payment = await createPaymentPayload({ payerPrivateKey: item.privateKey, requirements, nowSeconds });
  const simulation = await facilitator.simulateSettle(payment);
  console.log(
    `SIM     ${item.name} wouldSettle=${simulation.wouldSettle} signatureAccepted=${simulation.signatureAccepted} :: ${simulation.detail}`
  );
  if (!simulation.wouldSettle) throw new Error(`${item.name} would not settle: ${simulation.detail}`);
}

if (!confirm) {
  console.log("READY: re-run with --confirm to broadcast.");
  process.exit(0);
}

// Sequential, never parallel: every leg is broadcast by the SAME settler EOA, so
// concurrent sends would collide on one nonce.
let sent = 0n;
for (const item of plan) {
  const blockTime = (await provider.getBlock("latest")).timestamp;
  const requirements = buildPaymentRequirements({
    payTo: destination,
    maxAmountRequired: item.value.toString(),
    resource: "x402-gasless-send",
    nowSeconds: blockTime
  });
  const payment = await createPaymentPayload({ payerPrivateKey: item.privateKey, requirements, nowSeconds: blockTime });
  const settlement = await facilitator.verifyAndSettle(payment, requirements, blockTime);
  if (!settlement.transactionHash) throw new Error(`${item.name} did not enter on-chain settlement mode`);
  console.log(`TX      ${item.name} ${settlement.transactionHash}`);
  console.log(`        https://basescan.org/tx/${settlement.transactionHash}`);
  const receipt = await provider.waitForTransaction(settlement.transactionHash, 1, 180_000);
  if (!receipt || receipt.status !== 1) throw new Error(`${item.name} transaction did not succeed`);
  sent += item.value;
  console.log(`OK      ${item.name} sent ${formatUnits(item.value, 6)} USDC`);
}

const destinationAfter = await usdc.balanceOf(destination);
const delta = destinationAfter - destinationBefore;
console.log(`DEST    USDC ${formatUnits(destinationBefore, 6)} -> ${formatUnits(destinationAfter, 6)} (+${formatUnits(delta, 6)})`);
if (delta !== sent) throw new Error(`destination delta ${formatUnits(delta, 6)} does not match sent ${formatUnits(sent, 6)}`);
console.log(`PASS sent ${formatUnits(sent, 6)} USDC to ${destination}`);
