/**
 * Offline smoke for the confidential x402 wire contract
 * (spec-confidential-x402.md §3, §10).
 *
 * Pure validation only — no chain access, no WASM, no keys. The rail-level
 * proofs (real confidential transfer to a stealth address) are recorded in
 * spec-confidential-x402.md §14.2 and, once the rail lands,
 * `test:confidential:solana:devnet`.
 */
import { spawnSync } from "node:child_process";
import {
  assertSolanaConfidentialRequirements,
  assertSolanaConfidentialPayload,
  asConfidentialEncryptionPubKey,
  confidentialKeySeedParts,
  ConfidentialPaymentError,
} from "../src/shared/x402SolanaConfidential.ts";
import { auditorIsAbsent, autoApprovesNewAccounts, readConfidentialExtension } from "../src/server/rails/confidentialMint.ts";

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
};
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};
const rejectsWith = (fn, code) => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof ConfidentialPaymentError,
      `expected ConfidentialPaymentError, got ${error?.constructor?.name}`);
    assert(error.code === code, `expected code ${code}, got ${error.code}`);
    return;
  }
  throw new Error(`expected rejection ${code} but the call resolved`);
};

const MINT = "FocYWf7ju8kFjjtzZpEuhz642GNbG2wBH7MmRLMRohq8";
const STEALTH = "2kM4UaSTVQoxJgE4X3KdnNnd3uh4uFp9mHn7nD4mMGKj";
const EPHEMERAL = "FJ1xdFewSUY6uYzR9P1XobrMBmPuCFpdij8vjMATQioD";
const SPEND = "FQLCT1vEuGyc5r3Tb8bW8gK7HWcGdwMbzbxYXRW4RsDq";
const VIEW = "498MUJCn17w8YMP6SagFS5karaVn2jXNK5PbjtqgNFTb";
const ATA = "8ZFC86vnMumMkFLjdtp12Xp5smR4bKNr4ud1zX5x1Wuh";
/** A real published slot ElGamal pubkey from the two-party devnet run. */
const ELGAMAL = "Ekri9grn5dnDpvZswxSiRKjfNAMHWZjKcM5bati1gtmw";

const requirements = (overrides = {}) => ({
  x402Version: 1,
  scheme: "confidential",
  network: "solana",
  asset: MINT,
  payTo: STEALTH,
  maxAmountRequired: "137000000",
  resource: "px402:confidential-smoke",
  nonce: "0xdeadbeef",
  validForSeconds: 600,
  stealthMetaAddress: { spendingPubKey: SPEND, viewingPubKey: VIEW },
  // The §5.2-P published slot. The PAYEE picks R and provisions the account,
  // because only an account's owner may configure it.
  ephemeralPubKey: EPHEMERAL,
  encryptionPubKey: ELGAMAL,
  destinationTokenAccount: ATA,
  ...overrides,
});

const payload = (overrides = {}) => ({
  x402Version: 1,
  scheme: "confidential",
  network: "solana",
  asset: MINT,
  payer: STEALTH,
  // FIVE transactions, not one — the measured plan shape.
  transactions: ["AQAAAA==", "AgAAAA==", "AwAAAA==", "BAAAAA==", "BQAAAA=="],
  ephemeralPubKey: EPHEMERAL,
  destinationTokenAccount: ATA,
  ...overrides,
});

/* ───────────────────────── §3 requirements ───────────────────────── */

check("a well-formed confidential quote validates", () => {
  const r = assertSolanaConfidentialRequirements(requirements());
  assert(r.scheme === "confidential");
  assert(r.maxAmountRequired === "137000000");
});

check("§3.2 — confidential WITHOUT stealth is refused at quote time", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ stealthMetaAddress: undefined })),
    "confidential_requires_stealth",
  );
});

check("§3.2 — a malformed stealth meta-address is refused, not silently ignored", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(
      requirements({ stealthMetaAddress: { spendingPubKey: "nope", viewingPubKey: VIEW } }),
    ),
    "confidential_requires_stealth",
  );
});

check("an `exact` quote is not accepted by the confidential validator", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ scheme: "exact" })),
    "confidential_scheme_mismatch",
  );
});

check("a confidential quote for another network is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ network: "base" })),
    "confidential_scheme_mismatch",
  );
});

check("a zero or negative amount is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ maxAmountRequired: "0" })),
    "confidential_amount_invalid",
  );
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ maxAmountRequired: "-1" })),
    "confidential_amount_invalid",
  );
});

check("a non-integer amount is refused rather than coerced", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ maxAmountRequired: "1.5" })),
    "confidential_amount_invalid",
  );
});

/* ───────────────────────── §3 payload ───────────────────────── */

check("a well-formed confidential payload validates", () => {
  const p = assertSolanaConfidentialPayload(payload());
  assert(p.ephemeralPubKey === EPHEMERAL);
});

check("a payload missing the announcement is refused (losing R loses the funds)", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(payload({ ephemeralPubKey: undefined })),
    "confidential_malformed",
  );
});

check("a payload with a malformed announcement is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(payload({ ephemeralPubKey: "0xnot-base58" })),
    "confidential_malformed",
  );
});

check("a payload missing the destination account is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(payload({ destinationTokenAccount: undefined })),
    "confidential_malformed",
  );
});

check("an empty transaction plan is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(payload({ transactions: [] })),
    "confidential_malformed",
  );
});

check("a plan carrying an empty transaction entry is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(payload({ transactions: ["AQAAAA==", ""] })),
    "confidential_malformed",
  );
});

check("a plan over the transaction cap is refused rather than decoded", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(
      payload({ transactions: Array.from({ length: 40 }, () => "AQAAAA==") }),
    ),
    "confidential_malformed",
  );
});

check("§5.2-P — a quote without the payee-published slot key is refused", () => {
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ encryptionPubKey: undefined })),
    "confidential_malformed",
  );
});

check("§5.2-P — a quote without the announcement R is refused", () => {
  // Without R the payee can neither derive its one-time key nor even LOCATE the
  // address, so a quote missing it describes funds nobody could ever spend.
  rejectsWith(
    () => assertSolanaConfidentialRequirements(requirements({ ephemeralPubKey: undefined })),
    "confidential_requires_stealth",
  );
});

check("a downgraded `exact` payload cannot pass as confidential", () => {
  rejectsWith(
    () => assertSolanaConfidentialPayload(payload({ scheme: "exact" })),
    "confidential_scheme_mismatch",
  );
});

/* ───────────────────────── §5.2 key seed ───────────────────────── */

check("§5.2 — the key seed is built from two PUBLIC values", () => {
  const parts = confidentialKeySeedParts({ stealthAddress: STEALTH, mint: MINT });
  assert(parts.stealthAddress === STEALTH && parts.mint === MINT,
    "the seed carries no secret; secrecy is in who can sign it with the one-time scalar");
});

check("§5.2 — a malformed seed part is refused", () => {
  rejectsWith(
    () => confidentialKeySeedParts({ stealthAddress: "bad", mint: MINT }),
    "confidential_malformed",
  );
});

/* ───────────────────────── error hygiene ───────────────────────── */

check("rejection codes are opaque and carry no agent-existence signal", () => {
  const codes = new Set();
  for (const bad of [
    requirements({ stealthMetaAddress: undefined }),
    requirements({ scheme: "exact" }),
    requirements({ asset: "bad" }),
  ]) {
    try {
      assertSolanaConfidentialRequirements(bad);
    } catch (error) {
      codes.add(error.code);
      assert(!/agent|account|balance/i.test(error.message),
        `error text leaked context: ${error.message}`);
    }
  }
  assert(codes.size === 3, "distinct failures still map to distinct stable codes");
});

/* ────── §5.1 auditor rule — the fail-SAFE direction is the point ────── */

check("§5.1 — mainnet PYUSD/USDG shape is REJECTED: the issuer must approve every account", () => {
  // Both carry ConfidentialTransferMint with a null auditor and look perfect on
  // every other axis, but set autoApproveNewAccounts:false. §5.2-P provisions a
  // fresh one-time slot per payment, so "the issuer signs for each account" is
  // not a hurdle — it is a contradiction. Without this check the rail goes
  // onchain, burns real rent on slots that can never receive, and every payment
  // into them fails.
  assert(!autoApprovesNewAccounts({
    __kind: "ConfidentialTransferMint", auditorElgamalPubkey: { __option: "None" },
    autoApproveNewAccounts: false,
  }), "manual-approval mints must be refused");
});

check("§5.1 — auto-approval must be POSITIVELY true, never merely absent", () => {
  // Same failure direction as the auditor check: an unrecognised shape is not
  // permission.
  for (const value of [undefined, null, 0, "true", {}, { __option: "Some" }]) {
    assert(!autoApprovesNewAccounts({
      __kind: "ConfidentialTransferMint", autoApproveNewAccounts: value,
    }), `autoApproveNewAccounts=${JSON.stringify(value)} must not read as approval`);
  }
  assert(autoApprovesNewAccounts({
    __kind: "ConfidentialTransferMint", autoApproveNewAccounts: true,
  }), "an explicit true is the only accepted value");
});

check("§5.1 — a null / None auditor is recognised as absent", () => {
  assert(auditorIsAbsent({ __kind: "ConfidentialTransferMint", auditorElgamalPubkey: null }));
  assert(auditorIsAbsent({ __kind: "ConfidentialTransferMint" }));
  assert(auditorIsAbsent({ __kind: "ConfidentialTransferMint", auditorElgamalPubkey: { __option: "None" } }));
});

check("§5.1 — a present auditor is rejected (it decrypts every amount on the mint)", () => {
  assert(!auditorIsAbsent({
    __kind: "ConfidentialTransferMint",
    auditorElgamalPubkey: { __option: "Some", value: new Uint8Array(32) },
  }), "a Some auditor is a universal decryption backdoor");
});

check("§5.1 — an UNRECOGNISED auditor shape fails SAFE (treated as present)", () => {
  // The failure direction is the whole design. Refusing to serve a mint we
  // cannot vet is free; serving one that has a backdoor is not. A decoder
  // version change must not silently flip this to "capable".
  for (const weird of ["", "0x00", 0, [], {}, { __option: "Maybe" }, new Uint8Array(32)]) {
    assert(!auditorIsAbsent({ __kind: "ConfidentialTransferMint", auditorElgamalPubkey: weird }),
      `unrecognised auditor shape ${JSON.stringify(weird)} must NOT read as absent`);
  }
});

check("§5.1 — the extension reader ignores a mint with no extensions", () => {
  assert(readConfidentialExtension({ extensions: { __option: "None" } }) === undefined);
  assert(readConfidentialExtension({ extensions: undefined }) === undefined);
  assert(readConfidentialExtension({
    extensions: { __option: "Some", value: [{ __kind: "TransferFeeConfig" }] },
  }) === undefined, "a different extension is not a confidential mint");
});

/* ────── §5 nominal encryption-key brand (measured footgun defence) ────── */

check("an address cannot be used as an encryption pubkey without an explicit cast", () => {
  // A Solana address and an ElGamal pubkey are both bare 32-byte values, so a
  // plain string type would let this through with a clean typecheck -- and
  // ~1% of ed25519 points are SILENTLY accepted by ElGamalPubkey.fromBytes,
  // encrypting funds to a key nobody holds. Runtime shape check plus the brand.
  const key = asConfidentialEncryptionPubKey(STEALTH);
  assert(typeof key === "string", "brand is erased at runtime, by design");
  rejectsWith(() => asConfidentialEncryptionPubKey("not-base58!"), "confidential_malformed");
  rejectsWith(() => asConfidentialEncryptionPubKey(""), "confidential_malformed");
});

/* ───────────────── §9 config guards (subprocess: env is read at import) ───────────────── */

const configProbe = (env) => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e",
      "import('./src/server/config.ts').then(m => { m.resolveConfidentialNetworks(); console.log('OK'); })"
       + ".catch(e => { console.log('THROW:' + e.message); })"],
    { encoding: "utf8", env: { ...process.env, ...env }, cwd: process.cwd() },
  );
  return `${result.stdout}${result.stderr}`.trim();
};

check("§9 — flag OFF with no config at all is valid (nothing advertised)", () => {
  const out = configProbe({
    PX402_CONFIDENTIAL_X402_ENABLED: "false",
    PX402_CONFIDENTIAL_NETWORKS: "[]",
  });
  assert(out.includes("OK"), `expected OK, got: ${out}`);
});

check("§9 — enabling confidential solana WITHOUT a mint is refused at startup", () => {
  const out = configProbe({
    PX402_CONFIDENTIAL_X402_ENABLED: "true",
    PX402_CONFIDENTIAL_NETWORKS: '["solana"]',
    PX402_SOLANA_CONFIDENTIAL_MINT: "",
  });
  assert(/THROW:.*SOLANA_CONFIDENTIAL_MINT/.test(out),
    `a half-configured rail must not silently advertise a capability: ${out}`);
});

check("§9 — enabling confidential solana WITH a mint validates", () => {
  const out = configProbe({
    PX402_CONFIDENTIAL_X402_ENABLED: "true",
    PX402_CONFIDENTIAL_NETWORKS: '["solana"]',
    PX402_SOLANA_CONFIDENTIAL_MINT: MINT,
  });
  assert(out.includes("OK"), `expected OK, got: ${out}`);
});

check("§6.4 — an EVM confidential contract without a verifying-key hash is refused", () => {
  const out = configProbe({
    PX402_CONFIDENTIAL_X402_ENABLED: "true",
    PX402_CONFIDENTIAL_NETWORKS: '["base"]',
    PX402_BASE_CONFIDENTIAL_CONTRACT: "0x000000000000000000000000000000000000dEaD",
    PX402_CONFIDENTIAL_VERIFYING_KEY_HASH: "",
  });
  assert(/THROW:.*VERIFYING_KEY_HASH/.test(out),
    `an unverified verifying key is a contract that can mint: ${out}`);
});

check("§9 — an unsupported network id is refused rather than ignored", () => {
  const out = configProbe({
    PX402_CONFIDENTIAL_X402_ENABLED: "true",
    PX402_CONFIDENTIAL_NETWORKS: '["dogecoin"]',
  });
  assert(/THROW:.*unsupported network/.test(out), `expected refusal, got: ${out}`);
});

check("§9 — malformed NETWORKS json is refused", () => {
  const out = configProbe({
    PX402_CONFIDENTIAL_X402_ENABLED: "true",
    PX402_CONFIDENTIAL_NETWORKS: "not-json",
  });
  assert(/THROW:.*JSON array/.test(out), `expected refusal, got: ${out}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
