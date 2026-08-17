// One-shot REAL x402 settle on Robinhood Chain mainnet (chainId 4663), between
// the wallets in .env.x402.local (same keys => same addresses on every EVM chain).
// Guarded: it checks balances and will NOT broadcast unless the wallets are
// funded AND you pass --confirm.
//
//   npm run x402:rh:settle-live                       # pre-flight only
//   npm run x402:rh:settle-live -- --seed --confirm   # seed payer from settler if short, then settle
//   npm run x402:rh:settle-live -- --confirm          # settle only (payer must hold the USDG)
//
// Funds needed (Robinhood Chain mainnet):
//   SETTLER  -> a little ETH for gas (RH gas is ~0.05 gwei; one settle costs dust)
//   PAYER    -> the USDG being sent (default 0.10 USDG; override X402_AMOUNT_USDG)
//   --seed moves X402_RH_SEED_USDG (default 1 USDG) settler -> payer when the
//   payer is short; the settler pays its own gas for that plain ERC-20 transfer.
import { readFileSync } from "node:fs";
import { Wallet, JsonRpcProvider, Contract, formatEther, formatUnits } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, ROBINHOOD_USDG } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

console.warn(`!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.`);

const ENV_FILE = ".env.x402.local";
const ETH_FLOOR = 5_000_000_000_000n; // 0.000005 ETH — plenty at RH's ~0.05 gwei gas
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";

const loadEnv = () => {
  let raw;
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new Error(`${ENV_FILE} not found — generate the wallets first.`);
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
};

const run = async () => {
  const confirm = process.argv.includes("--confirm");
  const seed = process.argv.includes("--seed");
  const env = loadEnv();
  const rpc = env.PX402_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  for (const k of ["PX402_BASE_X402_SETTLER_KEY", "X402_PAYER_KEY", "X402_PAYEE_KEY"]) {
    if (!env[k]) throw new Error(`${k} missing from ${ENV_FILE}`);
  }
  const amountUsdg = Number(process.env.X402_AMOUNT_USDG ?? "0.10");
  const amountAtomic = usdcAtomic(amountUsdg, ROBINHOOD_USDG.decimals);
  const seedUsdg = Number(process.env.X402_RH_SEED_USDG ?? "1");
  const seedAtomic = BigInt(usdcAtomic(seedUsdg, ROBINHOOD_USDG.decimals));

  const provider = new JsonRpcProvider(rpc, ROBINHOOD_USDG.chainId);
  const settler = new Wallet(env.PX402_BASE_X402_SETTLER_KEY, provider);
  const payer = new Wallet(env.X402_PAYER_KEY);
  const payee = new Wallet(env.X402_PAYEE_KEY);
  const usdg = new Contract(
    ROBINHOOD_USDG.address,
    ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
    provider
  );

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== ROBINHOOD_USDG.chainId) {
    throw new Error(`RPC chainId ${net.chainId} != expected ${ROBINHOOD_USDG.chainId}`);
  }

  const settlerEth = await provider.getBalance(settler.address);
  const settlerUsdg = await usdg.balanceOf(settler.address);
  let payerUsdg = await usdg.balanceOf(payer.address);
  const payeeUsdg = await usdg.balanceOf(payee.address);

  console.log("=== x402 live settle pre-flight (Robinhood Chain mainnet) ===");
  console.log(`amount:  ${amountUsdg} USDG (${amountAtomic} atomic)`);
  console.log(`SETTLER  ${settler.address}  ETH=${formatEther(settlerEth)}  USDG=${formatUnits(settlerUsdg, 6)}`);
  console.log(`PAYER    ${payer.address}  USDG=${formatUnits(payerUsdg, 6)}`);
  console.log(`PAYEE    ${payee.address}  USDG=${formatUnits(payeeUsdg, 6)}`);

  const payerShort = payerUsdg < BigInt(amountAtomic);
  const canSeed = seed && payerShort && settlerUsdg >= seedAtomic;

  const needs = [];
  if (settlerEth < ETH_FLOOR) needs.push(`  fund SETTLER ${settler.address} with a little ETH on Robinhood Chain (gas)`);
  if (payerShort && !canSeed) {
    needs.push(
      seed
        ? `  SETTLER holds only ${formatUnits(settlerUsdg, 6)} USDG — cannot seed ${seedUsdg}; fund settler or lower X402_RH_SEED_USDG`
        : `  fund PAYER ${payer.address} with >= ${amountUsdg} USDG on Robinhood Chain (or pass --seed to move ${seedUsdg} USDG from the settler)`
    );
  }
  if (needs.length) {
    console.log("\nNOT READY — fix these on Robinhood Chain mainnet, then re-run:\n" + needs.join("\n"));
    process.exitCode = 0;
    return;
  }

  if (!confirm) {
    console.log(
      `\nREADY${canSeed ? ` (will seed ${seedUsdg} USDG settler -> payer first)` : ""}. This is a REAL mainnet transfer.\nRe-run with --confirm to broadcast:\n  npm run x402:rh:settle-live -- ${seed ? "--seed " : ""}--confirm`
    );
    process.exitCode = 0;
    return;
  }

  // ---- optional seed: plain ERC-20 transfer settler -> payer, settler pays gas ----
  if (canSeed) {
    console.log(`\nseeding ${seedUsdg} USDG settler -> payer…`);
    const seedTx = await usdg.connect(settler).transfer(payer.address, seedAtomic);
    console.log("seed tx:", seedTx.hash);
    console.log("explorer:", EXPLORER + seedTx.hash);
    const seedReceipt = await seedTx.wait(1, 120000);
    if (seedReceipt.status !== 1) throw new Error("seed transfer reverted");
    payerUsdg = await usdg.balanceOf(payer.address);
    console.log(`seed OK — PAYER now holds ${formatUnits(payerUsdg, 6)} USDG`);
  }

  // ---- live x402 broadcast ----
  const ts = (await provider.getBlock("latest")).timestamp;
  const fac = new X402Facilitator({ rpcUrl: rpc, settlerPrivateKey: env.PX402_BASE_X402_SETTLER_KEY, token: ROBINHOOD_USDG });
  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: amountAtomic, resource: "x402-rh-live-proof", token: ROBINHOOD_USDG, nowSeconds: ts });
  const payload = await createPaymentPayload({ payerPrivateKey: env.X402_PAYER_KEY, requirements: req, token: ROBINHOOD_USDG, nowSeconds: ts });

  console.log("\nbroadcasting x402 settle…");
  const settlement = await fac.verifyAndSettle(payload, req, ts);
  console.log("tx:", settlement.transactionHash);
  console.log("explorer:", EXPLORER + settlement.transactionHash);
  const receipt = await provider.waitForTransaction(settlement.transactionHash, 1, 120000);

  const afterPayer = await usdg.balanceOf(payer.address);
  const afterPayee = await usdg.balanceOf(payee.address);
  console.log(`status: ${receipt.status === 1 ? "SUCCESS" : "FAILED"}  gasUsed: ${receipt.gasUsed}`);
  console.log(`PAYER  ${formatUnits(payerUsdg, 6)} -> ${formatUnits(afterPayer, 6)} USDG`);
  console.log(`PAYEE  ${formatUnits(payeeUsdg, 6)} -> ${formatUnits(afterPayee, 6)} USDG`);
  const ok = receipt.status === 1 && afterPayee - payeeUsdg === BigInt(amountAtomic);
  console.log(ok ? "\nPASS: real on-chain x402 USDG settle on Robinhood Chain mainnet." : "\nFAIL: settle did not move USDG as expected.");
  process.exitCode = ok ? 0 : 1;
};

run().catch((e) => {
  console.error("x402 rh live settle error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
