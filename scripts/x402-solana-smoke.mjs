import { request as httpRequest } from "node:http";
import { Keypair, Transaction } from "@solana/web3.js";
import { SolanaX402Facilitator } from "../src/server/base/SolanaX402Facilitator.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { createPrivateAgentServer } from "../src/server/agents/createPrivateAgentServer.ts";
import { createSolanaPayerPool } from "../src/shared/payerRotationSolana.ts";
import { prepareRotatingSolanaX402Payment } from "../src/shared/privateX402Client.ts";
import {
  generateSolanaStealthKeys,
  recoverSolanaStealthScalar,
  publicKeyForSolanaScalar
} from "../src/shared/stealthSolana.ts";
import { SOLANA_USDC, resolveX402Network } from "../src/shared/x402.ts";
import {
  buildSolanaPaymentRequirements,
  createSolanaPaymentPayload,
  verifySolanaPayment
} from "../src/shared/x402Solana.ts";

let pass = 0, fail = 0;
const ok = (condition, message) => condition
  ? (pass += 1, console.log("PASS", message))
  : (fail += 1, console.log("FAIL", message));
const rejects = async (action) => {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
};

const blockhash = Keypair.generate().publicKey.toBase58();
const mockConnection = {
  getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
  getAccountInfo: async () => null,
  simulateTransaction: async () => ({
    context: { slot: 1 },
    value: { err: null, logs: ["Program log: mock success"], accounts: null, unitsConsumed: 1, returnData: null }
  })
};

const httpJson = (port, path, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" }
  }, (response) => {
    let responseBody = "";
    response.on("data", (chunk) => { responseBody += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(responseBody) }));
  });
  request.on("error", reject);
  request.write(data);
  request.end();
});

const run = async () => {
  const now = 1_900_000_000;
  const payer = Keypair.generate();
  const payee = Keypair.generate();
  const settler = Keypair.generate();
  const requirements = buildSolanaPaymentRequirements({
    payTo: payee.publicKey.toBase58(),
    maxAmountRequired: "250000",
    resource: "solana-offer",
    token: SOLANA_USDC
  });
  ok(requirements.network === "solana" && requirements.asset === SOLANA_USDC.address, "requirements carry Solana mainnet USDC-SPL");
  ok(resolveX402Network("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp").network === "solana", "Solana CAIP-2 alias resolves");

  const payload = await createSolanaPaymentPayload({
    payerKeypair: payer,
    requirements,
    settlerPubkey: settler.publicKey,
    connection: mockConnection,
    token: SOLANA_USDC,
    nowSeconds: now
  });
  const verified = verifySolanaPayment({ payload, requirements, settlerPubkey: settler.publicKey, token: SOLANA_USDC, nowSeconds: now });
  ok(verified.ok && verified.payer === payer.publicKey.toBase58(), "valid payload recovers the payer authority");
  ok(verified.payTo === payee.publicKey.toBase58() && verified.value === "250000", "valid payload binds destination and exact amount");
  ok(verified.transaction.instructions.length === 2, "missing recipient ATA adds only idempotent ATA creation plus transferChecked");

  ok(await rejects(() => verifySolanaPayment({
    payload: { ...payload, asset: Keypair.generate().publicKey.toBase58() }, requirements, settlerPubkey: settler.publicKey
  })), "rejects wrong mint");
  ok(await rejects(() => verifySolanaPayment({
    payload, requirements: { ...requirements, maxAmountRequired: "250001" }, settlerPubkey: settler.publicKey
  })), "rejects wrong amount");
  ok(await rejects(() => verifySolanaPayment({
    payload, requirements: { ...requirements, payTo: Keypair.generate().publicKey.toBase58() }, settlerPubkey: settler.publicKey
  })), "rejects wrong destination");
  ok(await rejects(() => verifySolanaPayment({
    payload, requirements, settlerPubkey: Keypair.generate().publicKey
  })), "rejects wrong fee payer");

  const unsigned = Transaction.from(Buffer.from(payload.transaction, "base64"));
  const payerSlot = unsigned.signatures.find(({ publicKey }) => publicKey.equals(payer.publicKey));
  payerSlot.signature = null;
  const missingSignature = {
    ...payload,
    transaction: unsigned.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64")
  };
  ok(await rejects(() => verifySolanaPayment({
    payload: missingSignature, requirements, settlerPubkey: settler.publicKey
  })), "rejects a missing payer signature");

  const extraInstruction = Transaction.from(Buffer.from(payload.transaction, "base64"));
  extraInstruction.instructions.push(extraInstruction.instructions.at(-1));
  const extraPayload = {
    ...payload,
    transaction: extraInstruction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64")
  };
  ok(await rejects(() => verifySolanaPayment({
    payload: extraPayload, requirements, settlerPubkey: settler.publicKey
  })), "rejects extra value-moving instructions");

  const facilitator = new SolanaX402Facilitator({
    rpcUrl: "http://unused",
    settlerPubkey: settler.publicKey,
    connection: mockConnection,
    token: SOLANA_USDC
  });
  const settlement = await facilitator.verifyAndSettle(payload, requirements, now);
  ok(facilitator.mode === "dry-run" && settlement.settlement === "dry-run", "facilitator labels no-key settlement as dry-run");
  ok(settlement.from === payer.publicKey.toBase58() && settlement.to === payee.publicKey.toBase58(), "dry-run settlement reports the verified parties");
  ok(await rejects(() => facilitator.verifyAndSettle(payload, requirements, now)), "facilitator rejects a replayed quote nonce");

  const stealthKeys = generateSolanaStealthKeys();
  const stealthRequirements = {
    ...buildSolanaPaymentRequirements({
      payTo: stealthKeys.meta.spendingPubKey,
      maxAmountRequired: "500000",
      resource: "private-stealth"
    }),
    stealthMetaAddress: stealthKeys.meta
  };
  const prepared = await prepareRotatingSolanaX402Payment({
    payerPool: createSolanaPayerPool(),
    requirements: stealthRequirements,
    settlerPubkey: settler.publicKey,
    connection: mockConnection,
    nowSeconds: now
  });
  ok(prepared.payerAddress !== payer.publicKey.toBase58() && prepared.payerIndex === 0, "client rotates to a fresh SLIP-0010 payer");
  ok(prepared.requirements.payTo === prepared.stealth.stealthAddress, "client replaces payTo with a one-time ed25519 stealth address");
  const recovered = recoverSolanaStealthScalar({
    ephemeralPubKey: prepared.ephemeralPubKey,
    viewingScalar: stealthKeys.viewingScalar,
    spendingScalar: stealthKeys.spendingScalar,
    expectedAddress: prepared.stealth.stealthAddress
  });
  ok(publicKeyForSolanaScalar(recovered).toBase58() === prepared.stealth.stealthAddress, "payee recovers the scalar controlling the paid address");
  const privacyFacilitator = new SolanaX402Facilitator({
    rpcUrl: "http://unused",
    settlerPubkey: settler.publicKey,
    connection: mockConnection
  });
  const privacySettlement = await privacyFacilitator.verifyAndSettle(prepared.payment, prepared.requirements, now);
  ok(privacySettlement.to === prepared.stealth.stealthAddress, "full privacy payment simulates to the stealth recipient");

  const registry = new PrivateAgentRegistry([
    { agentId: "payer", label: "P", vpnIp: "127.0.0.1", walletAddress: payer.publicKey.toBase58(), sharedSecret: "p", credits: 0, inventory: [] },
    {
      agentId: "payee",
      label: "R",
      vpnIp: "127.0.0.1",
      walletAddress: stealthKeys.meta.spendingPubKey,
      sharedSecret: "r",
      credits: 0,
      inventory: [],
      solanaStealthMeta: stealthKeys.meta,
      solanaStealthViewingKey: stealthKeys.viewingScalar
    }
  ], { requireIdentitySignatures: false });
  const serverFacilitator = new SolanaX402Facilitator({
    rpcUrl: "http://unused",
    settlerPubkey: settler.publicKey,
    connection: mockConnection
  });
  const server = createPrivateAgentServer({ registry, solanaFacilitator: serverFacilitator });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const quoteResponse = await httpJson(port, "/private/a2a/quote", {
    payeeAgentId: "payee",
    payerAgentId: "payer",
    amountAtomic: "750000",
    resource: "wireguard-solana",
    network: "solana",
    intentNonce: "unused",
    agentSignature: ""
  });
  ok(quoteResponse.status === 201 && quoteResponse.json.requirements.network === "solana", "WireGuard quote route selects the Solana facilitator");
  const wirePrepared = await prepareRotatingSolanaX402Payment({
    payerPool: createSolanaPayerPool(),
    requirements: quoteResponse.json.requirements,
    settlerPubkey: settler.publicKey,
    connection: mockConnection,
    nowSeconds: Math.floor(Date.now() / 1000)
  });
  const payResponse = await httpJson(port, "/private/a2a/pay", {
    payment: wirePrepared.payment,
    requirementsNonce: wirePrepared.requirementsNonce,
    ephemeralPubKey: wirePrepared.ephemeralPubKey,
    agentSignature: ""
  });
  ok(payResponse.status === 201 && payResponse.json.receipt.settlement.network === "solana", "WireGuard pay route settles through the quote-bound Solana facilitator");
  ok(payResponse.json.receipt.stealthAddress === wirePrepared.stealth.stealthAddress, "WireGuard receipt preserves the Solana stealth announcement result");
  await new Promise((resolve) => server.close(resolve));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
};

run().catch((error) => {
  console.error("Solana x402 smoke crashed:", error);
  process.exitCode = 1;
});
