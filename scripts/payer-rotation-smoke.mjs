// Phase 2: payer-side address rotation, and combined stealth+rotation so a
// payment links no persistent sender NOR recipient on-chain. Run: npm run test:rotation
import { Wallet } from "ethers";
import { createPayerPool, nextPayerWallet, derivePayerWallet, derivePayerWallets } from "../src/shared/payerRotation.ts";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { generateStealthKeys, deriveStealthAddress, computeStealthPrivateKey, addressForPrivateKey } from "../src/shared/stealth.ts";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("PASS", m)) : (fail++, console.log("FAIL", m)));

const run = async () => {
  const now = Math.floor(Date.now() / 1000);

  // 1) rotation: fresh address per payment, deterministic + recoverable
  const pool0 = createPayerPool();
  const a = nextPayerWallet(pool0);
  const b = nextPayerWallet(a.pool);
  ok(a.wallet.address !== b.wallet.address && a.index === 0 && b.index === 1, "each payment uses a fresh payer address");
  ok(derivePayerWallet(pool0.mnemonic, 0).address === a.wallet.address, "addresses are deterministic from the seed (recoverable to sweep)");
  ok(derivePayerWallets(pool0.mnemonic, 2).map(w => w.address).join() === [a.wallet.address, b.wallet.address].join(), "agent can re-derive every rotated address from one seed");

  // 2) the agent's identity wallet never appears as the on-chain `from`
  const agentIdentity = Wallet.createRandom();
  ok(a.wallet.address !== agentIdentity.address && b.wallet.address !== agentIdentity.address, "rotated payer addresses are not the agent identity wallet");

  // 3) x402 settle from a rotated address works (dry-run)
  const fac = new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC });
  const payee = Wallet.createRandom();
  const req = buildPaymentRequirements({ payTo: payee.address, maxAmountRequired: usdcAtomic(0.25), resource: "rot", nowSeconds: now });
  const payload = await createPaymentPayload({ payerPrivateKey: a.wallet.privateKey, requirements: req, nowSeconds: now });
  const s = await fac.verifyAndSettle(payload, req, now);
  ok(s.from.toLowerCase() === a.wallet.address.toLowerCase(), "x402 payment's on-chain sender IS the rotated address");

  // 4) FULL privacy: rotated payer + stealth payee over the private channel
  const stealth = generateStealthKeys();
  const identityPayer = Wallet.createRandom();   // the agent's registered identity (never used on-chain)
  const identityPayee = Wallet.createRandom();
  const reg = new PrivateAgentRegistry([
    { agentId: "buyer", label: "B", vpnIp: "127.0.0.1", walletAddress: identityPayer.address, sharedSecret: "x", credits: 0, inventory: [] },
    { agentId: "seller", label: "S", vpnIp: "127.0.0.1", walletAddress: identityPayee.address, sharedSecret: "y", credits: 0, inventory: [], stealthMeta: stealth.meta, stealthViewingKey: stealth.viewingKey }
  ], { requireIdentitySignatures: false });
  const rfac = new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC });
  const quote = await reg.quoteX402({ payeeAgentId: "seller", payerAgentId: "buyer", amountAtomic: usdcAtomic(0.25), resource: "private" }, "127.0.0.1", BASE_USDC, now);
  const freshPayer = nextPayerWallet(createPayerPool()).wallet;          // rotated sender
  const sd = deriveStealthAddress(quote.stealthMetaAddress);            // stealth recipient
  const pay = await createPaymentPayload({ payerPrivateKey: freshPayer.privateKey, requirements: { ...quote, payTo: sd.stealthAddress }, nowSeconds: now });
  const rcpt = await reg.payX402({ payment: pay, ephemeralPubKey: sd.ephemeralPubKey }, "127.0.0.1", rfac, now);
  const onchainFrom = rcpt.settlement.from.toLowerCase();
  const onchainTo = rcpt.settlement.to.toLowerCase();
  ok(onchainFrom === freshPayer.address.toLowerCase() && onchainFrom !== identityPayer.address.toLowerCase(), "on-chain sender is a fresh rotated address, NOT the buyer identity");
  ok(onchainTo === sd.stealthAddress.toLowerCase() && onchainTo !== identityPayee.address.toLowerCase(), "on-chain recipient is a fresh stealth address, NOT the seller identity");
  const swept = addressForPrivateKey(computeStealthPrivateKey({ ephemeralPubKey: rcpt.ephemeralPubKey, viewingKey: stealth.viewingKey, spendingKey: stealth.spendingKey }));
  ok(swept === sd.stealthAddress, "seller can still recover + sweep the stealth funds");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
};
run().catch((e) => { console.error("rotation smoke crashed:", e); process.exitCode = 1; });
