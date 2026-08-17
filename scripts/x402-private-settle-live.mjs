// TRUE end-to-end private x402 on public Base mainnet: the payment is negotiated
// over the private agent RPC (the same /private/a2a/quote -> /private/a2a/pay
// WireGuard channel) with the facilitator in on-chain mode, so the private
// handshake itself triggers the real USDC settle.
//
//   npm run x402:private-live                # pre-flight only
//   npm run x402:private-live -- --confirm   # real mainnet settle via the private channel
//
// Locally the two agents talk over 127.0.0.1, so the endpoints' vpnIp is set to
// 127.0.0.1 (in deployment these are the WireGuard peer IPs, e.g. 10.77.x.x).
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Wallet, JsonRpcProvider, Contract, formatEther, formatUnits } from "ethers";
import { createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { createPrivateAgentServer } from "../src/server/agents/createPrivateAgentServer.ts";

const ENV_FILE = ".env.x402.local";
const ETH_FLOOR = 200_000_000_000_000n;

const loadEnv = () => {
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
};

const httpJson = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", Connection: "close" } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : undefined }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

const run = async () => {
  const confirm = process.argv.includes("--confirm");
  const env = loadEnv();
  const rpc = env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";
  const amountUsdc = Number(process.env.X402_AMOUNT_USDC ?? "0.25");
  const amountAtomic = usdcAtomic(amountUsdc);

  const provider = new JsonRpcProvider(rpc, 8453);
  const settlerKey = env.PX402_BASE_X402_SETTLER_KEY;
  const payer = new Wallet(env.X402_PAYER_KEY);
  const payee = new Wallet(env.X402_PAYEE_KEY);
  const usdc = new Contract(BASE_USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);

  const settlerEth = await provider.getBalance(new Wallet(settlerKey).address);
  const payerUsdc = await usdc.balanceOf(payer.address);
  const payeeUsdc = await usdc.balanceOf(payee.address);
  console.log("=== private x402 live (Base mainnet, via WireGuard quote->pay) ===");
  console.log(`amount: ${amountUsdc} USDC   SETTLER ETH=${formatEther(settlerEth)}   PAYER USDC=${formatUnits(payerUsdc, 6)}   PAYEE USDC=${formatUnits(payeeUsdc, 6)}`);

  const needs = [];
  if (settlerEth < ETH_FLOOR) needs.push(`  fund SETTLER with ~0.0005 ETH on Base`);
  if (payerUsdc < BigInt(amountAtomic)) needs.push(`  fund PAYER with >= ${amountUsdc} USDC on Base`);
  if (needs.length) { console.log("\nNOT READY:\n" + needs.join("\n")); process.exitCode = 0; return; }
  if (!confirm) { console.log("\nREADY. Re-run with --confirm to settle via the private channel:\n  npm run x402:private-live -- --confirm"); process.exitCode = 0; return; }

  // Build the private registry: buyer pays seller, both on the local VPN (127.0.0.1)
  const buyerIdentity = Wallet.createRandom();
  const sellerIdentity = Wallet.createRandom();
  const registry = new PrivateAgentRegistry([
    { agentId: "buyer", label: "Buyer", vpnIp: "127.0.0.1", walletAddress: payer.address, identityAddress: buyerIdentity.address, sharedSecret: "x", credits: 0, inventory: [] },
    { agentId: "seller", label: "Seller", vpnIp: "127.0.0.1", walletAddress: payee.address, identityAddress: sellerIdentity.address, sharedSecret: "y", credits: 0, inventory: [] }
  ]);
  const facilitator = new X402Facilitator({ rpcUrl: rpc, settlerPrivateKey: settlerKey, token: BASE_USDC });
  const server = createPrivateAgentServer({ registry, facilitator });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`private RPC up on 127.0.0.1:${port} (x402 ${facilitator.mode})`);

  // 1) seller issues the 402 challenge over the private channel
  const quoteIntent = JSON.stringify({ protocol: "px402-agent-intent/v1", action: "quote", payeeAgentId: "seller", payerAgentId: "buyer", amountAtomic, resource: "private-x402-live-proof", validForSeconds: 600, intentNonce: "0x" + "11".repeat(32) });
  const qr = await httpJson(port, "POST", "/private/a2a/quote", { payeeAgentId: "seller", payerAgentId: "buyer", amountAtomic, resource: "private-x402-live-proof", validForSeconds: 600, intentNonce: "0x" + "11".repeat(32), agentSignature: await sellerIdentity.signMessage(quoteIntent) });
  if (qr.status !== 201) throw new Error("quote failed: " + JSON.stringify(qr.json));
  console.log("seller issued 402 quote, nonce:", qr.json.requirements.nonce.slice(0, 18) + "…");

  // 2) buyer signs the EIP-3009 authorization for that quote
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payment = await createPaymentPayload({ payerPrivateKey: env.X402_PAYER_KEY, requirements: qr.json.requirements, nowSeconds });

  // 3) buyer pays over the private channel -> registry.payX402 -> on-chain settle
  console.log("buyer paying over private channel (broadcasting)…");
  const payIntent = JSON.stringify({ protocol: "px402-agent-intent/v1", action: "pay", payerAgentId: "buyer", payeeAgentId: "seller", asset: payment.asset, from: payment.authorization.from, to: payment.authorization.to, value: payment.authorization.value, validAfter: payment.authorization.validAfter, validBefore: payment.authorization.validBefore, authorizationNonce: payment.authorization.nonce });
  const pr = await httpJson(port, "POST", "/private/a2a/pay", { payment, agentSignature: await buyerIdentity.signMessage(payIntent) });
  await new Promise((r) => server.close(r));
  if (pr.status !== 201) throw new Error("pay failed: " + JSON.stringify(pr.json));

  const receipt = pr.json.receipt;
  const tx = receipt.settlement.transactionHash;
  console.log("\nx402 receipt route:", receipt.route, " settlement:", receipt.settlement.settlement);
  console.log("tx:", tx);
  console.log("BaseScan:", `https://basescan.org/tx/${tx}`);
  await provider.waitForTransaction(tx, 1, 120000);

  const afterPayee = await usdc.balanceOf(payee.address);
  console.log(`PAYEE ${formatUnits(payeeUsdc, 6)} -> ${formatUnits(afterPayee, 6)} USDC`);
  const ok = receipt.route === "wireguard-x402" && receipt.settlement.settlement === "onchain" && afterPayee - payeeUsdc === BigInt(amountAtomic);
  console.log(ok ? "\nPASS: private x402 settled on Base mainnet THROUGH the WireGuard quote->pay channel." : "\nFAIL.");
  process.exitCode = ok ? 0 : 1;
};

run().catch((e) => { console.error("private x402 live error:", e instanceof Error ? e.message : e); process.exitCode = 1; });
