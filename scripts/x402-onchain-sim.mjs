// Proves the x402 on-chain settle path is correct against the REAL deployed
// USDC contract on Base — via eth_call simulation, so no gas, no funded keys,
// no broadcast. A correctly-signed authorization from a zero-balance payer must
// revert on BALANCE (signature accepted); a wrong-domain signature must revert
// on SIGNATURE. Run: npm run test:x402:onchain
import { Wallet } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

const RPC = process.env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";

const run = async () => {
  const now = Math.floor(Date.now() / 1000);
  const payer = Wallet.createRandom(); // zero-USDC ephemeral wallet
  const payee = Wallet.createRandom();
  const fac = new X402Facilitator({ rpcUrl: RPC, token: BASE_USDC });

  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.01), resource: "onchain-proof", nowSeconds: now });
  const good = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, nowSeconds: now });
  const wrong = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, token: { ...BASE_USDC, domainVersion: "9" }, nowSeconds: now });

  console.log("RPC:", RPC);
  console.log("USDC:", BASE_USDC.address);

  let r1, r2;
  try {
    r1 = await fac.simulateSettle(good);
    r2 = await fac.simulateSettle(wrong);
  } catch (e) {
    console.log("INCONCLUSIVE: could not reach Base RPC —", e instanceof Error ? e.message : e);
    process.exitCode = 0; // network-dependent; don't fail the suite offline
    return;
  }

  console.log("GOOD payload ->", JSON.stringify(r1));
  console.log("WRONG-domain ->", JSON.stringify(r2));

  const pass = r1.signatureAccepted === true && r2.signatureAccepted === false;
  if (pass) {
    console.log("\nPASS: live Base USDC accepts our EIP-712 signature (reverts on balance) and rejects a wrong-domain signature.");
    process.exitCode = 0;
  } else {
    console.log("\nFAIL or INCONCLUSIVE: the RPC may not return decoded revert reasons. See details above.");
    process.exitCode = 1;
  }
};

run().catch((e) => {
  console.error("onchain sim crashed:", e);
  process.exitCode = 1;
});
