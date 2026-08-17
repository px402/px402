import { once } from "node:events";
import { Wallet } from "ethers";
import { createPayerPool } from "../src/shared/payerRotation.ts";
import { generateStealthKeys } from "../src/shared/stealth.ts";
import { requestPrivateLedgerQuote, requestPrivateX402Quote, prepareRotatingX402Payment, submitPrivateX402Payment } from "../src/shared/privateX402Client.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { createPrivateAgentServer } from "../src/server/agents/createPrivateAgentServer.ts";
import { BASE_USDC, ROBINHOOD_USDG, usdcAtomic } from "../src/shared/x402.ts";

let pass = 0;
let fail = 0;
const ok = (condition, message) => (condition ? (pass += 1, console.log("PASS", message)) : (fail += 1, console.log("FAIL", message)));
const payerIdentity = Wallet.createRandom();
const payeeIdentity = Wallet.createRandom();
const stealth = generateStealthKeys();
const registry = new PrivateAgentRegistry([
  { agentId: "payer", label: "Payer", vpnIp: "127.0.0.1", walletAddress: Wallet.createRandom().address, identityAddress: payerIdentity.address, sharedSecret: "payer", credits: 0, inventory: [] },
  { agentId: "payee", label: "Payee", vpnIp: "127.0.0.1", walletAddress: Wallet.createRandom().address, identityAddress: payeeIdentity.address, sharedSecret: "payee", credits: 0, inventory: [], stealthMeta: stealth.meta, stealthViewingKey: stealth.viewingKey }
], { privateLedger: {} });
const server = createPrivateAgentServer({
  registry,
  facilitator: new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC }),
  ledger: {},
  deposits: new Map([["robinhood", {
    recipient: Wallet.createRandom().address,
    asset: ROBINHOOD_USDG.address,
    verifier: { verifyErc20Transfer: async (proof) => proof }
  }]])
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Private test server did not expose a TCP port");
  const rpcUrl = `http://127.0.0.1:${address.port}`;
  const missingSignature = await fetch(`${rpcUrl}/private/a2a/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payeeAgentId: "payee", payerAgentId: "payer", amountAtomic: usdcAtomic(0.25), resource: "missing-signature" })
  });
  ok(missingSignature.status === 400, "private quote rejects a request without the payee identity signature");
  const robinhoodLedgerRequirements = await requestPrivateLedgerQuote({
    rpcUrl,
    payeeAgentId: "payee",
    payerAgentId: "payer",
    amountAtomic: "250000",
    resource: "robinhood-ledger-client-smoke",
    network: "eip155:4663",
    identitySigner: payeeIdentity
  });
  ok(robinhoodLedgerRequirements.network === ROBINHOOD_USDG.caip2
    && robinhoodLedgerRequirements.asset.toLowerCase() === ROBINHOOD_USDG.address.toLowerCase(), "private-ledger client signs and requests the Robinhood network intent");
  const requirements = await requestPrivateX402Quote({ rpcUrl, payeeAgentId: "payee", payerAgentId: "payer", amountAtomic: usdcAtomic(0.25), resource: "client-smoke", identitySigner: payeeIdentity });
  const prepared = await prepareRotatingX402Payment({
    payerPool: createPayerPool(),
    requirements,
    nowSeconds: Math.floor(Date.now() / 1000)
  });
  ok(prepared.payerIndex === 0 && prepared.nextPayerPool.nextIndex === 1, "payer client advances its rotation index before submit");
  ok(prepared.payerAddress.toLowerCase() !== payerIdentity.address.toLowerCase(), "payer client does not expose the identity wallet on-chain");
  ok(prepared.stealth?.stealthAddress.toLowerCase() !== payeeIdentity.address.toLowerCase(), "payer client derives a one-time stealth recipient");
  const response = await submitPrivateX402Payment({ rpcUrl, prepared, payerAgentId: "payer", payeeAgentId: "payee", identitySigner: payerIdentity });
  ok(response.mode === "dry-run" && response.receipt.route === "wireguard-x402", "payer client completes the private quote/pay transport");
  ok(response.receipt.settlement.from.toLowerCase() === prepared.payerAddress.toLowerCase(), "settlement is authorized by the rotated payer");
  ok(response.receipt.settlement.to.toLowerCase() === prepared.stealth?.stealthAddress.toLowerCase(), "settlement targets the derived stealth address");
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
