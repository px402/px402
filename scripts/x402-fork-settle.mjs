// Gold-standard proof: a REAL on-chain x402 settle against forked Base mainnet
// (the actual deployed USDC bytecode), asserting USDC balances move. No real
// funds — the payer's USDC balance is set directly in fork storage.
//
// Prerequisite: an anvil fork of Base mainnet on 127.0.0.1:8545 (chain-id 8453):
//   anvil --fork-url https://mainnet.base.org --chain-id 8453 --port 8545
// Then: npm run test:x402:fork
//
// Note: USDC's SignatureChecker routes addresses WITH code (smart accounts,
// EIP-7702 delegations) to EIP-1271. x402 EIP-3009 here is for plain EOAs —
// which our custodial agent wallets are. The payer below is a fresh EOA.
import { Wallet, JsonRpcProvider, Contract, keccak256, AbiCoder, zeroPadValue, toBeHex } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

const RPC = process.env.PX402_FORK_RPC_URL ?? "http://127.0.0.1:8545";
// anvil dev account 0 — pre-funded with ETH on the fork; pays gas to broadcast.
const SETTLER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const run = async () => {
  const provider = new JsonRpcProvider(RPC, 8453);
  try {
    await provider.getBlockNumber();
  } catch {
    console.log(`INCONCLUSIVE: no fork RPC at ${RPC}. Start anvil first:\n  anvil --fork-url https://mainnet.base.org --chain-id 8453 --port 8545`);
    process.exitCode = 0;
    return;
  }

  const usdc = new Contract(BASE_USDC.address, ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], provider);
  try {
    if ((await usdc.symbol()) !== "USDC") throw new Error("not USDC");
  } catch {
    console.log(`INCONCLUSIVE: ${RPC} is not a Base mainnet fork (USDC not found).`);
    process.exitCode = 0;
    return;
  }

  const payer = Wallet.createRandom();
  const payee = Wallet.createRandom();

  // fund the payer with 1 USDC by writing fork storage (slot 9 = balances)
  const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [payer.address, 9]));
  try {
    await provider.send("anvil_setStorageAt", [BASE_USDC.address, slot, zeroPadValue(toBeHex(1_000_000n), 32)]);
  } catch (e) {
    console.log("INCONCLUSIVE: RPC does not support anvil_setStorageAt —", e instanceof Error ? e.message : e);
    process.exitCode = 0;
    return;
  }

  const ts = (await provider.getBlock("latest")).timestamp;
  const fac = new X402Facilitator({ rpcUrl: RPC, settlerPrivateKey: SETTLER, token: BASE_USDC });

  const beforePayer = await usdc.balanceOf(payer.address);
  const beforePayee = await usdc.balanceOf(payee.address);

  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.25), resource: "fork-live-fire", nowSeconds: ts });
  const payload = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, nowSeconds: ts });
  const settlement = await fac.verifyAndSettle(payload, req, ts);
  await provider.waitForTransaction(settlement.transactionHash, 1, 30000);

  const afterPayer = await usdc.balanceOf(payer.address);
  const afterPayee = await usdc.balanceOf(payee.address);

  console.log(`mode=${fac.mode} tx=${settlement.transactionHash}`);
  console.log(`payer ${beforePayer} -> ${afterPayer}   payee ${beforePayee} -> ${afterPayee}`);

  const moved = beforePayer - afterPayer === 250000n && afterPayee - beforePayee === 250000n && settlement.settlement === "onchain";
  if (moved) {
    console.log("\nPASS: real on-chain x402 settle — 0.25 USDC moved payer->payee via EIP-3009 transferWithAuthorization.");
    process.exitCode = 0;
  } else {
    console.log("\nFAIL: USDC balances did not move as expected.");
    process.exitCode = 1;
  }
};

run().catch((e) => {
  console.error("fork settle crashed:", e);
  process.exitCode = 1;
});
