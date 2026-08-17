// EIP-5564 stealth-address proof + x402 pay-to-stealth (recipient unlinkability).
// Run: npm run test:stealth
import { generateStealthKeys, deriveStealthAddress, checkStealthAddress, computeStealthPrivateKey, addressForPrivateKey } from "../src/shared/stealth.ts";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { Wallet } from "ethers";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("PASS", m)) : (fail++, console.log("FAIL", m)));

const run = async () => {
  const recipient = generateStealthKeys();

  // 1) sender derives a fresh stealth address; recipient detects + controls it
  const d = deriveStealthAddress(recipient.meta);
  const chk = checkStealthAddress({ ephemeralPubKey: d.ephemeralPubKey, viewingKey: recipient.viewingKey, spendingPubKey: recipient.meta.spendingPubKey, viewTag: d.viewTag });
  ok(chk.viewTagMatches, "recipient view-tag matches the announcement");
  ok(chk.stealthAddress === d.stealthAddress, "recipient derives the SAME stealth address the sender paid");
  const stealthKey = computeStealthPrivateKey({ ephemeralPubKey: d.ephemeralPubKey, viewingKey: recipient.viewingKey, spendingKey: recipient.spendingKey });
  ok(addressForPrivateKey(stealthKey) === d.stealthAddress, "recipient's derived private key CONTROLS the stealth address (can sweep)");

  // 2) unlinkability — two payments to the same meta produce different addresses
  const d2 = deriveStealthAddress(recipient.meta);
  ok(d.stealthAddress !== d2.stealthAddress && d.ephemeralPubKey !== d2.ephemeralPubKey, "two payments to same recipient are unlinkable (distinct stealth addrs)");

  // 3) a different recipient cannot detect it as theirs
  const other = generateStealthKeys();
  const otherChk = checkStealthAddress({ ephemeralPubKey: d.ephemeralPubKey, viewingKey: other.viewingKey, spendingPubKey: other.meta.spendingPubKey });
  ok(otherChk.stealthAddress !== d.stealthAddress, "a different recipient does NOT derive the paying stealth address");

  // 4) deterministic with an injected ephemeral key (test reproducibility)
  const eph = Wallet.createRandom().privateKey;
  ok(deriveStealthAddress(recipient.meta, eph).stealthAddress === deriveStealthAddress(recipient.meta, eph).stealthAddress, "derivation is deterministic given the ephemeral key");

  // 5) x402 pays the fresh stealth address; recipient controls the funds
  const now = Math.floor(Date.now() / 1000);
  const payer = Wallet.createRandom();
  const stealth = deriveStealthAddress(recipient.meta);
  const req = buildPaymentRequirements({ payTo: stealth.stealthAddress, maxAmountRequired: usdcAtomic(0.25), resource: "stealth-x402", nowSeconds: now });
  const payload = await createPaymentPayload({ payerPrivateKey: payer.privateKey, requirements: req, nowSeconds: now });
  const fac = new X402Facilitator({ rpcUrl: "http://unused", token: BASE_USDC });
  const settlement = await fac.verifyAndSettle(payload, req, now);
  ok(settlement.to.toLowerCase() === stealth.stealthAddress.toLowerCase(), "x402 payment is addressed to the one-time stealth address");
  const sk = computeStealthPrivateKey({ ephemeralPubKey: stealth.ephemeralPubKey, viewingKey: recipient.viewingKey, spendingKey: recipient.spendingKey });
  ok(addressForPrivateKey(sk) === stealth.stealthAddress, "recipient can sweep the x402-paid stealth address");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
};
run().catch((e) => { console.error("stealth smoke crashed:", e); process.exitCode = 1; });
