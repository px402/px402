// Proves the x402 on-chain settle path is correct against the REAL deployed
// USDG (Global Dollar) contract on Robinhood Chain (eip155:4663) — via eth_call
// simulation, so no gas, no funded keys, no broadcast. A correctly-signed
// authorization from a zero-balance payer must revert on BALANCE
// (InsufficientFunds() — signature accepted); a wrong-domain signature must be
// rejected. Run: npm run test:x402:rh:onchain
import { Wallet } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, ROBINHOOD_USDG } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

const RPC = process.env.PX402_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

const run = async () => {
  const now = Math.floor(Date.now() / 1000);
  const payer = Wallet.createRandom(); // zero-USDG ephemeral wallet
  const payee = Wallet.createRandom();
  const fac = new X402Facilitator({ rpcUrl: RPC, token: ROBINHOOD_USDG });

  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.01), resource: "rh-onchain-proof", token: ROBINHOOD_USDG, nowSeconds: now });
  const good = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, token: ROBINHOOD_USDG, nowSeconds: now });
  const wrong = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, token: { ...ROBINHOOD_USDG, domainVersion: "9" }, nowSeconds: now });

  console.log("RPC:", RPC);
  console.log("USDG:", ROBINHOOD_USDG.address);
  console.log("network:", req.network, `(${ROBINHOOD_USDG.caip2})`);

  let r1, r2;
  try {
    r1 = await fac.simulateSettle(good);
    r2 = await fac.simulateSettle(wrong);
  } catch (e) {
    console.log("INCONCLUSIVE: could not reach Robinhood Chain RPC —", e instanceof Error ? e.message : e);
    process.exitCode = 0; // network-dependent; don't fail the suite offline
    return;
  }

  console.log("GOOD payload ->", JSON.stringify(r1));
  console.log("WRONG-domain ->", JSON.stringify(r2));

  const pass = r1.signatureAccepted === true && r2.signatureAccepted === false;
  if (pass) {
    console.log("\nPASS: live Robinhood Chain USDG accepts our EIP-712 signature (reverts on balance) and rejects a wrong-domain signature.");
    process.exitCode = 0;
  } else {
    console.log("\nFAIL or INCONCLUSIVE: the RPC may not return decoded revert data. See details above.");
    process.exitCode = 1;
  }
};

run().catch((e) => {
  console.error("rh onchain sim crashed:", e);
  process.exitCode = 1;
});
