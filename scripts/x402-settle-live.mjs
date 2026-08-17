// One-shot REAL x402 settle on public Base mainnet, between the wallets in
// .env.x402.local. Guarded: it checks balances and will NOT broadcast unless the
// wallets are funded AND you pass --confirm.
//
//   npm run x402:settle-live            # pre-flight only: shows balances + what to fund
//   npm run x402:settle-live -- --confirm   # actually broadcasts one settle
//
// Funds needed (Base mainnet, chainId 8453):
//   SETTLER  -> a little ETH for gas (~$0.01-0.03 per settle)
//   PAYER    -> the USDC being sent (default 0.25 USDC; override X402_AMOUNT_USDC)
import { readFileSync } from "node:fs";
import { Wallet, JsonRpcProvider, Contract, formatEther, formatUnits } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

console.warn(`!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.`);

const ENV_FILE = ".env.x402.local";
const ETH_FLOOR = 200_000_000_000_000n; // 0.0002 ETH — safety floor for one settle + headroom

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
  const env = loadEnv();
  const rpc = env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";
  for (const k of ["PX402_BASE_X402_SETTLER_KEY", "X402_PAYER_KEY", "X402_PAYEE_KEY"]) {
    if (!env[k]) throw new Error(`${k} missing from ${ENV_FILE}`);
  }
  const amountUsdc = Number(process.env.X402_AMOUNT_USDC ?? "0.25");
  const amountAtomic = usdcAtomic(amountUsdc);

  const provider = new JsonRpcProvider(rpc, 8453);
  const settler = new Wallet(env.PX402_BASE_X402_SETTLER_KEY);
  const payer = new Wallet(env.X402_PAYER_KEY);
  const payee = new Wallet(env.X402_PAYEE_KEY);
  const usdc = new Contract(BASE_USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);

  const settlerEth = await provider.getBalance(settler.address);
  const payerUsdc = await usdc.balanceOf(payer.address);
  const payeeUsdc = await usdc.balanceOf(payee.address);

  console.log("=== x402 live settle pre-flight (Base mainnet) ===");
  console.log(`amount:  ${amountUsdc} USDC (${amountAtomic} atomic)`);
  console.log(`SETTLER  ${settler.address}  ETH=${formatEther(settlerEth)}`);
  console.log(`PAYER    ${payer.address}  USDC=${formatUnits(payerUsdc, 6)}`);
  console.log(`PAYEE    ${payee.address}  USDC=${formatUnits(payeeUsdc, 6)}`);

  const needs = [];
  if (settlerEth < ETH_FLOOR) needs.push(`  fund SETTLER ${settler.address} with ~0.0005 ETH on Base (gas)`);
  if (payerUsdc < BigInt(amountAtomic)) needs.push(`  fund PAYER   ${payer.address} with >= ${amountUsdc} USDC on Base`);
  if (needs.length) {
    console.log("\nNOT READY — fund these on Base mainnet, then re-run:\n" + needs.join("\n"));
    process.exitCode = 0;
    return;
  }

  if (!confirm) {
    console.log("\nREADY (wallets funded). This is a REAL mainnet transfer.\nRe-run with --confirm to broadcast:\n  npm run x402:settle-live -- --confirm");
    process.exitCode = 0;
    return;
  }

  // ---- live broadcast ----
  const ts = (await provider.getBlock("latest")).timestamp;
  const fac = new X402Facilitator({ rpcUrl: rpc, settlerPrivateKey: env.PX402_BASE_X402_SETTLER_KEY, token: BASE_USDC });
  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: amountAtomic, resource: "x402-live-proof", nowSeconds: ts });
  const payload = await createPaymentPayload({ payerPrivateKey: env.X402_PAYER_KEY, requirements: req, nowSeconds: ts });

  console.log("\nbroadcasting…");
  const settlement = await fac.verifyAndSettle(payload, req, ts);
  console.log("tx:", settlement.transactionHash);
  console.log("BaseScan:", `https://basescan.org/tx/${settlement.transactionHash}`);
  const receipt = await provider.waitForTransaction(settlement.transactionHash, 1, 120000);

  const afterPayer = await usdc.balanceOf(payer.address);
  const afterPayee = await usdc.balanceOf(payee.address);
  console.log(`status: ${receipt.status === 1 ? "SUCCESS" : "FAILED"}  gasUsed: ${receipt.gasUsed}`);
  console.log(`PAYER  ${formatUnits(payerUsdc, 6)} -> ${formatUnits(afterPayer, 6)} USDC`);
  console.log(`PAYEE  ${formatUnits(payeeUsdc, 6)} -> ${formatUnits(afterPayee, 6)} USDC`);
  const ok = receipt.status === 1 && afterPayee - payeeUsdc === BigInt(amountAtomic);
  console.log(ok ? "\nPASS: real on-chain x402 USDC settle on Base mainnet." : "\nFAIL: settle did not move USDC as expected.");
  process.exitCode = ok ? 0 : 1;
};

run().catch((e) => {
  console.error("x402 live settle error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
