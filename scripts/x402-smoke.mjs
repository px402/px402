// x402 private-payment smoke test. Verifies the EIP-3009/EIP-712 sign+verify
// core, facilitator dry-run settle + replay guard, registry wallet-binding and
// VPN-peer enforcement, and a live /private/a2a/pay round trip.
// Run: npm run test:x402   (uses tsx to load the TS sources directly)
import { request as httpRequest } from "node:http";
import { Wallet } from "ethers";
import {
  buildPaymentRequirements,
  createPaymentPayload,
  verifyPayment,
  usdcAtomic,
  encodePaymentHeader,
  decodePaymentHeader,
  BASE_USDC,
  ROBINHOOD_USDG,
  resolveX402Network
} from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { createPrivateAgentServer } from "../src/server/agents/createPrivateAgentServer.ts";
import { generateStealthKeys, deriveStealthAddress, computeStealthPrivateKey, addressForPrivateKey } from "../src/shared/stealth.ts";
import { createPayerPool } from "../src/shared/payerRotation.ts";
import { prepareRotatingX402Payment } from "../src/shared/privateX402Client.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";

let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("PASS", m)) : (fail++, console.log("FAIL", m)));
const rejects = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

// raw http POST/GET with Connection: close so node has no lingering pool handle
const httpJson = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", Connection: "close" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : undefined }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

const run = async () => {
  const payer = Wallet.createRandom();
  const payee = Wallet.createRandom();
  const now = 1_900_000_000;

  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.25), resource: "offer-123", nowSeconds: now });
  ok(req.maxAmountRequired === "250000", "0.25 USDC -> 250000 atomic");
  const payload = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, nowSeconds: now });
  const v = verifyPayment({ payload, requirements: req, nowSeconds: now });
  ok(v.ok && v.signer.toLowerCase() === payer.address.toLowerCase(), "verify recovers correct payer signer");
  ok(v.value === "250000", "verify reports correct value");
  ok(JSON.stringify(decodePaymentHeader(encodePaymentHeader(payload))) === JSON.stringify(payload), "X-PAYMENT header round-trips");

  ok(await rejects(async () => verifyPayment({ payload, requirements: { ...req, maxAmountRequired: usdcAtomic(1.0) }, nowSeconds: now })), "rejects amount below required");
  const otherReq = buildPaymentRequirements({ payTo: Wallet.createRandom().address, maxAmountRequired: usdcAtomic(0.25), resource: "x", nowSeconds: now });
  ok(await rejects(async () => verifyPayment({ payload, requirements: { ...otherReq, nonce: req.nonce }, nowSeconds: now })), "rejects recipient mismatch");
  ok(await rejects(async () => verifyPayment({ payload, requirements: req, nowSeconds: now + req.validForSeconds + 10 })), "rejects expired authorization");
  const tampered = payload.signature.slice(0, 12) + (payload.signature[12] === "a" ? "b" : "a") + payload.signature.slice(13);
  ok(await rejects(async () => verifyPayment({ payload: { ...payload, signature: tampered }, requirements: req, nowSeconds: now })), "rejects tampered signature");
  ok(
    await rejects(async () =>
      verifyPayment({ payload: { ...payload, authorization: { ...payload.authorization, value: usdcAtomic(0.1) } }, requirements: { ...req, maxAmountRequired: usdcAtomic(0.1) }, nowSeconds: now })
    ),
    "rejects when authorization mutated after signing"
  );

  const fac = new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC });
  ok(fac.mode === "dry-run", "facilitator dry-run mode without settler key");
  const s = await fac.verifyAndSettle(payload, req, now);
  ok(s.settlement === "dry-run" && s.to.toLowerCase() === payee.address.toLowerCase() && s.value === "250000", "dry-run settle labeled with correct payee/value");
  ok(await rejects(async () => fac.verifyAndSettle(payload, req, now)), "facilitator rejects replayed nonce");

  const reg = new PrivateAgentRegistry([
    { agentId: "a", label: "A", vpnIp: "127.0.0.1", walletAddress: payer.address, sharedSecret: "s1", credits: 0, inventory: [] },
    { agentId: "b", label: "B", vpnIp: "127.0.0.1", walletAddress: payee.address, sharedSecret: "s2", credits: 0, inventory: [] }
  ], { requireIdentitySignatures: false });
  const fac2 = new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC });
  // payee issues the 402 challenge; payer signs + pays it
  const quote = await reg.quoteX402({ payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.25), resource: "offer-9" }, "127.0.0.1", BASE_USDC, now);
  ok(quote.payTo.toLowerCase() === payee.address.toLowerCase(), "quote forces payTo = payee wallet");
  const payQ = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: quote, nowSeconds: now });
  const rcpt = await reg.payX402({ payment: payQ }, "127.0.0.1", fac2, now);
  ok(rcpt.kind === "x402" && rcpt.route === "wireguard-x402" && rcpt.payerVpnIp === "127.0.0.1" && rcpt.payeeVpnIp === "127.0.0.1", "quote->pay records x402 receipt with both VPN IPs");
  ok(await rejects(async () => reg.payX402({ payment: payQ }, "127.0.0.1", fac2, now)), "rejects re-paying a consumed quote");
  ok(await rejects(async () => reg.quoteX402({ payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.25), resource: "z" }, "10.0.0.9", BASE_USDC, now)), "rejects quote not issued from payee VPN IP");
  // a payment with no outstanding quote is rejected (payer cannot invent requirements)
  const reqNoQuote = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.25), resource: "x", nowSeconds: now });
  const payNoQuote = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: reqNoQuote, nowSeconds: now });
  ok(await rejects(async () => reg.payX402({ payment: payNoQuote }, "127.0.0.1", fac2, now)), "rejects payment with no outstanding quote");
  const quote2 = await reg.quoteX402({ payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.25), resource: "y" }, "127.0.0.1", BASE_USDC, now);
  const payQ2 = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: quote2, nowSeconds: now });
  ok(await rejects(async () => reg.payX402({ payment: payQ2 }, "10.0.0.9", fac2, now)), "rejects payer from wrong VPN IP");

  // --- stealth quote -> pay-to-stealth (recipient unlinkability over the private channel) ---
  const stealthKeys = generateStealthKeys();
  const sreg = new PrivateAgentRegistry([
    { agentId: "a", label: "A", vpnIp: "127.0.0.1", walletAddress: payer.address, sharedSecret: "x", credits: 0, inventory: [] },
    { agentId: "b", label: "B", vpnIp: "127.0.0.1", walletAddress: payee.address, sharedSecret: "y", credits: 0, inventory: [], stealthMeta: stealthKeys.meta, stealthViewingKey: stealthKeys.viewingKey }
  ], { requireIdentitySignatures: false });
  const sfac = new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC });
  const sQuote = await sreg.quoteX402({ payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.25), resource: "stealth-offer" }, "127.0.0.1", BASE_USDC, now);
  ok(!!sQuote.stealthMetaAddress, "stealth quote publishes the payee meta-address");
  // payer derives a fresh stealth address and pays it
  const sd = deriveStealthAddress(sQuote.stealthMetaAddress);
  const sPay = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: { ...sQuote, payTo: sd.stealthAddress }, nowSeconds: now });
  const sRcpt = await sreg.payX402({ payment: sPay, ephemeralPubKey: sd.ephemeralPubKey }, "127.0.0.1", sfac, now);
  ok(sRcpt.stealthAddress?.toLowerCase() === sd.stealthAddress.toLowerCase() && sRcpt.settlement.to.toLowerCase() === sd.stealthAddress.toLowerCase(), "payment settled to the one-time stealth address, not the payee wallet");
  ok(sRcpt.stealthAddress?.toLowerCase() !== payee.address.toLowerCase(), "stealth address is NOT the payee's main wallet (unlinkable)");
  // payee can recover the spending key for the swept funds
  const recovered = addressForPrivateKey(computeStealthPrivateKey({ ephemeralPubKey: sRcpt.ephemeralPubKey, viewingKey: stealthKeys.viewingKey, spendingKey: stealthKeys.spendingKey }));
  ok(recovered === sd.stealthAddress, "payee can derive the key controlling the stealth address");
  // stealth quote without an ephemeralPubKey is rejected
  const sQuote2 = await sreg.quoteX402({ payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.25), resource: "s2" }, "127.0.0.1", BASE_USDC, now);
  const sd2 = deriveStealthAddress(sQuote2.stealthMetaAddress);
  const sPay2 = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: { ...sQuote2, payTo: sd2.stealthAddress }, nowSeconds: now });
  ok(await rejects(async () => sreg.payX402({ payment: sPay2 }, "127.0.0.1", sfac, now)), "rejects stealth payment with no ephemeralPubKey");

  // --- Robinhood Chain (eip155:4663) network: same EIP-3009 flow, USDG asset ---
  ok(resolveX402Network("robinhood").address === ROBINHOOD_USDG.address, "network registry resolves robinhood -> USDG");
  ok(resolveX402Network("eip155:4663").network === "robinhood", "CAIP-2 alias eip155:4663 resolves to robinhood");
  const rhReq = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.25), resource: "rh-offer", token: ROBINHOOD_USDG, nowSeconds: now });
  ok(rhReq.network === "robinhood" && rhReq.asset.toLowerCase() === ROBINHOOD_USDG.address.toLowerCase(), "robinhood quote carries network + USDG asset");
  const rhPayload = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: rhReq, token: ROBINHOOD_USDG, nowSeconds: now });
  const rhV = verifyPayment({ payload: rhPayload, requirements: rhReq, token: ROBINHOOD_USDG, nowSeconds: now });
  ok(rhV.ok && rhV.signer.toLowerCase() === payer.address.toLowerCase(), "USDG EIP-712 signature verifies under Global Dollar domain");
  ok(await rejects(async () => verifyPayment({ payload: rhPayload, requirements: rhReq, token: BASE_USDC, nowSeconds: now })), "base facilitator rejects a robinhood payment (network mismatch)");
  const rhFac = new X402Facilitator({ rpcUrl: "http://unused", token: ROBINHOOD_USDG });
  const rhSettle = await rhFac.verifyAndSettle(rhPayload, rhReq, now);
  ok(rhSettle.settlement === "dry-run" && rhSettle.network === "robinhood" && rhSettle.asset === ROBINHOOD_USDG.address, "robinhood dry-run settle labeled with robinhood network + USDG");
  // a base-domain signature must NOT verify as a robinhood payment
  const rhReq2 = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.25), resource: "rh-offer-2", token: ROBINHOOD_USDG, nowSeconds: now });
  const crossSigned = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: rhReq2, token: { ...ROBINHOOD_USDG, domainName: BASE_USDC.domainName, domainVersion: BASE_USDC.domainVersion, chainId: BASE_USDC.chainId }, nowSeconds: now });
  ok(await rejects(async () => rhFac.verifyAndSettle(crossSigned, rhReq2, now)), "rejects USDG payment signed under the Base USDC domain");

  // --- full privacy stack on robinhood: stealth payee + rotating payer, USDG domain ---
  const rhStealthKeys = generateStealthKeys();
  const rhReg = new PrivateAgentRegistry([
    { agentId: "a", label: "A", vpnIp: "127.0.0.1", walletAddress: payer.address, sharedSecret: "x", credits: 0, inventory: [] },
    { agentId: "b", label: "B", vpnIp: "127.0.0.1", walletAddress: payee.address, sharedSecret: "y", credits: 0, inventory: [], stealthMeta: rhStealthKeys.meta, stealthViewingKey: rhStealthKeys.viewingKey }
  ], { requireIdentitySignatures: false });
  const rhFac2 = new X402Facilitator({ rpcUrl: "http://unused", token: ROBINHOOD_USDG });
  const rhSQuote = await rhReg.quoteX402({ payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.25), resource: "rh-stealth-offer" }, "127.0.0.1", ROBINHOOD_USDG, now);
  ok(rhSQuote.network === "robinhood" && !!rhSQuote.stealthMetaAddress, "robinhood quote publishes network + stealth meta-address");
  const rhPrepared = await prepareRotatingX402Payment({ payerPool: createPayerPool(), requirements: rhSQuote, nowSeconds: now });
  ok(rhPrepared.payment.network === "robinhood" && rhPrepared.payment.asset.toLowerCase() === ROBINHOOD_USDG.address.toLowerCase(), "rotating payer signs under the robinhood USDG domain");
  ok(rhPrepared.payerAddress.toLowerCase() !== payer.address.toLowerCase(), "fresh rotated payer is not the registered wallet");
  const rhSRcpt = await rhReg.payX402({ payment: rhPrepared.payment, ephemeralPubKey: rhPrepared.ephemeralPubKey }, "127.0.0.1", rhFac2, now);
  ok(rhSRcpt.settlement.network === "robinhood" && rhSRcpt.stealthAddress?.toLowerCase() === rhPrepared.stealth.stealthAddress.toLowerCase(), "USDG settles to a one-time stealth address on robinhood");
  ok(rhSRcpt.settlement.from.toLowerCase() === rhPrepared.payerAddress.toLowerCase(), "on-chain from is the rotated payer, not the identity wallet");
  const rhRecovered = addressForPrivateKey(computeStealthPrivateKey({ ephemeralPubKey: rhSRcpt.ephemeralPubKey, viewingKey: rhStealthKeys.viewingKey, spendingKey: rhStealthKeys.spendingKey }));
  ok(rhRecovered === rhPrepared.stealth.stealthAddress, "payee can derive the spending key for the robinhood stealth address");

  const server = createPrivateAgentServer({ registry: reg, facilitator: fac2 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const nowHttp = Math.floor(Date.now() / 1000);
  // full HTTP handshake: payee quotes -> payer signs -> payer pays
  const qr = await httpJson(port, "POST", "/private/a2a/quote", { payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.5), resource: "http-offer" });
  ok(qr.status === 201 && qr.json?.requirements?.payTo?.toLowerCase() === payee.address.toLowerCase(), "POST /private/a2a/quote returns a 402 challenge for the payee");
  const payHttp = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: qr.json.requirements, nowSeconds: nowHttp });
  const pr = await httpJson(port, "POST", "/private/a2a/pay", { payment: payHttp });
  ok(pr.status === 201 && pr.json?.receipt?.kind === "x402" && pr.json?.mode === "dry-run", "POST /private/a2a/pay settles the quoted payment");
  const rr = await httpJson(port, "GET", "/private/a2a/x402-receipts");
  ok(rr.status === 404 && rr.json?.error === "receipt_storage_disabled", "x402 receipt history is disabled");
  // multi-network routing: quote network selects the facilitator; the quote (not
  // the payer's payload) decides which chain the pay settles on
  const rhQr = await httpJson(port, "POST", "/private/a2a/quote", { payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.5), resource: "rh-http-offer", network: "robinhood" });
  ok(rhQr.status === 503, "quote for an unconfigured network is refused (single-facilitator server)");
  await new Promise((r) => server.close(r));

  let privateTransferAsset;
  const privateLedger = {
    transfer: async (input) => {
      privateTransferAsset = input.assetKey;
      return { commitment: `0x${"77".repeat(32)}`, payerBalanceAtomic: "5", acceptedAt: Date.now(), duplicate: false };
    }
  };
  const mnRegistry = new PrivateAgentRegistry([
    { agentId: "a", label: "A", vpnIp: "127.0.0.1", walletAddress: payer.address, sharedSecret: "s1", credits: 0, inventory: [] },
    { agentId: "b", label: "B", vpnIp: "127.0.0.1", walletAddress: payee.address, sharedSecret: "s2", credits: 0, inventory: [] }
  ], { requireIdentitySignatures: false, privateLedger });
  const mnServer = createPrivateAgentServer({
    registry: mnRegistry,
    ledger: privateLedger,
    facilitators: new Map([
      ["base", fac2],
      ["robinhood", new X402Facilitator({ rpcUrl: "http://unused", token: ROBINHOOD_USDG })]
    ]),
    deposits: new Map([["robinhood", {
      recipient: payee.address,
      asset: ROBINHOOD_USDG.address,
      verifier: { verifyErc20Transfer: async (proof) => proof }
    }]])
  });
  await new Promise((r) => mnServer.listen(0, "127.0.0.1", r));
  const mnPort = mnServer.address().port;
  const mnNow = Math.floor(Date.now() / 1000);
  const mnQr = await httpJson(mnPort, "POST", "/private/a2a/quote", { payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.5), resource: "rh-http-offer", network: "robinhood" });
  ok(mnQr.status === 201 && mnQr.json?.requirements?.network === "robinhood" && mnQr.json.requirements.asset.toLowerCase() === ROBINHOOD_USDG.address.toLowerCase(), "HTTP quote on network=robinhood returns a USDG challenge");
  const mnPay = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: mnQr.json.requirements, token: ROBINHOOD_USDG, nowSeconds: mnNow });
  const mnPr = await httpJson(mnPort, "POST", "/private/a2a/pay", { payment: mnPay });
  ok(mnPr.status === 201 && mnPr.json?.receipt?.settlement?.network === "robinhood" && mnPr.json?.mode === "dry-run", "HTTP pay routes to the robinhood facilitator via the quoted network");
  const mnCaip = await httpJson(mnPort, "POST", "/private/a2a/quote", { payeeAgentId: "b", payerAgentId: "a", amountAtomic: usdcAtomic(0.5), resource: "rh-caip2", network: "eip155:4663" });
  ok(mnCaip.status === 201 && mnCaip.json?.requirements?.network === "robinhood", "CAIP-2 network alias accepted over HTTP");
  const privateQr = await httpJson(mnPort, "POST", "/private/a2a/private-quote", { payeeAgentId: "b", payerAgentId: "a", amountAtomic: "5", resource: "rh-private-ledger", network: "robinhood", intentNonce: "rh-private-quote", agentSignature: "" });
  ok(privateQr.status === 201
    && privateQr.json?.requirements?.network === ROBINHOOD_USDG.caip2
    && privateQr.json?.requirements?.asset.toLowerCase() === ROBINHOOD_USDG.address.toLowerCase(), "Robinhood private-ledger quote uses the configured USDG deposit asset");
  const privatePr = await httpJson(mnPort, "POST", "/private/a2a/private-pay", {
    requirements: privateQr.json.requirements,
    authorizationNonce: `0x${"88".repeat(32)}`,
    agentSignature: ""
  });
  ok(privatePr.status === 201
    && privatePr.json?.payment?.status === "accepted"
    && privateTransferAsset === privateLedgerAssetKey("robinhood", ROBINHOOD_USDG.address), "Robinhood private-ledger voucher debits the Robinhood asset key");
  const unsupportedPrivateQr = await httpJson(mnPort, "POST", "/private/a2a/private-quote", { payeeAgentId: "b", payerAgentId: "a", amountAtomic: "5", resource: "base-private-ledger", network: "base", intentNonce: "base-private-quote", agentSignature: "" });
  ok(unsupportedPrivateQr.status === 503, "private-ledger quote returns 503 when the network has no deposit configuration");
  await new Promise((r) => mnServer.close(r));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
};

run().catch((e) => {
  console.error("x402 smoke crashed:", e);
  process.exitCode = 1;
});
