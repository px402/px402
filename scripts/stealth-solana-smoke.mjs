import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import {
  checkSolanaStealthAddress,
  deriveSolanaStealthAddress,
  generateSolanaStealthKeys,
  publicKeyForSolanaScalar,
  recoverSolanaStealthScalar,
  signSolanaWithScalar,
  sweepStealth
} from "../src/shared/stealthSolana.ts";
import { SOLANA_USDC_MINT } from "../src/shared/x402.ts";

let pass = 0, fail = 0;
const ok = (condition, message) => condition
  ? (pass += 1, console.log("PASS", message))
  : (fail += 1, console.log("FAIL", message));

const run = async () => {
  const recipient = generateSolanaStealthKeys();
  ok(recipient.meta.spendingPubKey !== recipient.meta.viewingPubKey, "spend and view public keys are distinct");

  const derived = deriveSolanaStealthAddress(recipient.meta);
  const detected = checkSolanaStealthAddress({
    ephemeralPubKey: derived.ephemeralPubKey,
    viewingScalar: recipient.viewingScalar,
    spendingPubKey: recipient.meta.spendingPubKey,
    paidAddress: derived.stealthAddress
  });
  ok(detected.matches, "recipient detects the payer-derived stealth address");
  ok(detected.stealthAddress === derived.stealthAddress, "payer and payee derive the same stealth address");
  ok(derived.stealthAddress !== recipient.meta.spendingPubKey, "stealth address is unlinkable from the spend public key");

  const recovered = recoverSolanaStealthScalar({
    ephemeralPubKey: derived.ephemeralPubKey,
    viewingScalar: recipient.viewingScalar,
    spendingScalar: recipient.spendingScalar,
    expectedAddress: derived.stealthAddress
  });
  ok(publicKeyForSolanaScalar(recovered).toBase58() === derived.stealthAddress, "recovered scalar controls the stealth address");

  const message = new TextEncoder().encode("px402-solana-stealth-sweep");
  const signature = signSolanaWithScalar(recovered, message);
  ok(ed25519.verify(signature, message, publicKeyForSolanaScalar(recovered).toBytes()), "raw-scalar ed25519 signature verifies under the stealth key");

  const second = deriveSolanaStealthAddress(recipient.meta);
  ok(second.stealthAddress !== derived.stealthAddress && second.ephemeralPubKey !== derived.ephemeralPubKey, "two payments produce unlinkable addresses and announcements");
  const other = generateSolanaStealthKeys();
  ok(checkSolanaStealthAddress({
    ephemeralPubKey: derived.ephemeralPubKey,
    viewingScalar: other.viewingScalar,
    spendingPubKey: other.meta.spendingPubKey,
    paidAddress: derived.stealthAddress
  }).matches === false, "another recipient cannot detect the stealth address as theirs");

  const settler = Keypair.generate();
  const destination = Keypair.generate();
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    getTokenAccountBalance: async () => ({ value: { amount: "42", decimals: 6, uiAmount: 0.000042, uiAmountString: "0.000042" } })
  };
  const sweep = await sweepStealth({
    connection,
    mint: SOLANA_USDC_MINT,
    destinationOwner: destination.publicKey,
    settlerPubkey: settler.publicKey,
    stealthScalar: recovered,
    decimals: 6
  });
  const signer = sweep.transaction.signatures.find(({ publicKey }) => publicKey.equals(publicKeyForSolanaScalar(recovered)));
  ok(Boolean(signer?.signature), "sweep transaction carries the stealth authority signature");
  ok(ed25519.verify(signer.signature, sweep.transaction.serializeMessage(), signer.publicKey.toBytes()), "sweep transaction stealth signature is valid");
  ok(sweep.transaction.feePayer.equals(settler.publicKey), "sweep transaction uses the settler as fee payer");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
};

run().catch((error) => {
  console.error("Solana stealth smoke crashed:", error);
  process.exitCode = 1;
});
