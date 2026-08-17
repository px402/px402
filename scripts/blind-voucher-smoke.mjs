import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  concat,
  getBytes,
  hexlify,
  sha256,
  toUtf8Bytes,
  Wallet,
} from "ethers";
import {
  assertCheckpointAgreement,
  discoverMint,
  meltToBlindVouchers,
  recoverMelt,
  redeemBlindVouchers,
} from "../src/shared/blindVoucherClient.ts";
import {
  blindSecret,
  computeKeysetId,
  decomposeAmount,
  hashManifestEntry,
  hashToCurve,
  meltFingerprint,
  nullifierOf,
  proveDleq,
  randomSecret,
  redeemKeyOf,
  signBlinded,
  unblindSignature,
  verifyDleq,
  verifyManifestEntry,
  verifyRedeemProof,
  verifyTransferredVoucher,
} from "../src/shared/blindVoucher.ts";
import { BlindVoucherWalletFile } from "../src/node/blindVoucherWalletFile.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { createPrivateAgentServer } from "../src/server/agents/createPrivateAgentServer.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { BlindVoucherMint } from "../src/server/payments/BlindVoucherMint.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { parseDenoms, parseSafeMs } from "../src/server/config.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import { BASE_USDC } from "../src/shared/x402.ts";
import { blindVoucherIssueIntentMessage } from "../src/shared/x402AgentIntent.ts";

let pass = 0;
let fail = 0;
const failures = [];
const check = async (name, test) => {
  try {
    await test();
    pass += 1;
    console.log("PASS", name);
  } catch (error) {
    fail += 1;
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log("FAIL", name);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const expectReject = async (operation, includes) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (includes && !message.includes(includes)) {
      throw new Error(`Expected rejection containing "${includes}", received "${message}"`);
    }
    return message;
  }
  throw new Error(`Expected rejection${includes ? ` containing "${includes}"` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "px402-blind-vouchers-"));
const encryptionKey = "blind-voucher-smoke-encryption-key";
const mintIdentity = Wallet.createRandom();
const asset = privateLedgerAssetKey("base", BASE_USDC.address);
const token = BASE_USDC;
const endpointNames = [
  "payer", "payee", "link-alpha-CANARY", "link-beta-CANARY",
  "recipient-alpha-CANARY", "recipient-beta-CANARY",
  "double", "winner-a", "winner-b", "duplicate", "dup-recipient",
  "crash", "crash-recipient", "member", "member-recipient",
];
const identities = new Map(endpointNames.map((name) => [name, Wallet.createRandom()]));
const balances = {
  payer: "3000000",
  "link-alpha-CANARY": "1000000",
  "link-beta-CANARY": "1000000",
  double: "1000000",
  duplicate: "1000000",
  crash: "1000000",
  member: "1000000",
};
const endpoints = endpointNames.map((agentId) => ({
  agentId,
  label: agentId,
  vpnIp: "127.0.0.1",
  walletAddress: Wallet.createRandom().address,
  identityAddress: identities.get(agentId).address,
  sharedSecret: `shared-${agentId}`,
  credits: 0,
  inventory: [],
}));
const journal = new EphemeralPaymentJournal(join(root, "epochs"));
const ledgerPath = join(root, "ledger.json");
const ledger = await new PrivatePaymentLedger(ledgerPath, encryptionKey, {
  journal,
  retentionMs: 60_000,
}).load(balances);
const keysetPath = join(root, "keysets.json");
const nullifierPath = join(root, "nullifiers.json");
const mint = await new BlindVoucherMint({
  keysetFilePath: keysetPath,
  nullifierFilePath: nullifierPath,
  encryptionKey,
  mintIdentityKey: mintIdentity.privateKey,
  denominationsAtomic: ["100000", "1000000", "10000000", "100000000"],
  keysetGraceMs: 7 * 24 * 60 * 60 * 1000,
  maxOutputsPerRequest: 64,
  maxProofsPerRequest: 64,
  assets: [asset],
}).load();
const registry = new PrivateAgentRegistry(endpoints, { privateLedger: ledger, mint });
const deposits = new Map([[
  "base",
  {
    recipient: Wallet.createRandom().address,
    asset: BASE_USDC.address,
    verifier: { verifyErc20Transfer: async (proof) => proof },
  },
]]);
const server = createPrivateAgentServer({ registry, ledger, mint, deposits });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Blind voucher smoke server has no port");
const rpcUrl = `http://127.0.0.1:${address.port}`;
const walletFiles = new Map();
const walletFor = (agentId) => {
  const existing = walletFiles.get(agentId);
  if (existing) return existing;
  const key = nodeRandomBytes(32).toString("hex");
  const wallet = new BlindVoucherWalletFile(join(root, `wallet-${safeName(agentId)}.json`), key);
  walletFiles.set(agentId, wallet);
  return wallet;
};

let discovered;
let issueRoundTripVouchers = [];
let oldCheckpoint;
const capturedLogs = [];

try {
  discovered = await discoverMint({
    rpcUrl,
    network: "base",
    pinnedMintPubKey: mint.mintIdentityPubKey(),
  });
  oldCheckpoint = discovered.checkpoint;

  await check("1 algebraic KATs, BDHKE, DLEQ, encodings, and manifest", async () => {
    const kats = [
      ["0x" + "00".repeat(32), "0x024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725", 0],
      ["0x" + "00".repeat(31) + "01", "0x022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf", 3],
      ["0x" + "00".repeat(31) + "02", "0x026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f", 3],
    ];
    for (const [secret, expectedPoint, expectedCounter] of kats) {
      assert(hexlify(hashToCurve(secret).toBytes(true)) === expectedPoint, "hashToCurve KAT point mismatch");
      assert(hashToCurveCounter(secret) === expectedCounter, "hashToCurve KAT counter mismatch");
    }

    for (const denomAtomic of ["100000", "1000000", "10000000", "100000000"]) {
      const kBytes = secp256k1.utils.randomSecretKey();
      const k = hexlify(kBytes);
      const K = hexlify(secp256k1.getPublicKey(kBytes, true));
      const context = { ...blindSecret(randomSecret()), denomAtomic };
      const C_ = signBlinded({ B_: context.B_, k });
      const dleq = proveDleq({ B_: context.B_, C_, k, K });
      assert(verifyDleq({ B_: context.B_, C_, K, dleq }), "valid DLEQ rejected");
      const C = unblindSignature({ C_, r: context.r, K });
      assert(verifyRedeemProof({ secret: context.secret, C, k }), "BDHKE redeem proof failed");
      assert(verifyTransferredVoucher({
        secret: context.secret, C, r: context.r, dleq, K,
      }), "transferred voucher offline verification failed");
      const wrongR = hexlify(secp256k1.utils.randomSecretKey());
      assert(!verifyTransferredVoucher({
        secret: context.secret, C, r: wrongR, dleq, K,
      }), "wrong blinding scalar passed offline verification");
      const tampered = { ...dleq, e: flipHex(dleq.e) };
      assert(!verifyDleq({ B_: context.B_, C_, K, dleq: tampered }), "tampered DLEQ passed");

      const mutantKey = secp256k1.utils.randomSecretKey();
      const mutantK = hexlify(secp256k1.getPublicKey(mutantKey, true));
      const mutantC = signBlinded({ B_: context.B_, k: hexlify(mutantKey) });
      const mutantProof = proveDleq({
        B_: context.B_, C_: mutantC, k: hexlify(mutantKey), K: mutantK,
      });
      assert(!verifyDleq({
        B_: context.B_, C_: mutantC, K, dleq: mutantProof,
      }), "tagging mutant k' with real K passed DLEQ");
    }
    await expectReject(
      async () => blindSecret(randomSecret(), "0x" + "00".repeat(32)),
      "nonzero",
    );

    const active = discovered.keysets.find((keyset) => keyset.status === "active");
    assert(active, "active keyset missing");
    const keysetId = computeKeysetId(active);
    assert(keysetId === active.keysetId && keysetId.length === 66, "full keyset id mismatch");
    const output = { denomAtomic: "100000", B_: blindSecret(randomSecret()).B_ };
    const fp = meltFingerprint({ asset, keysetId, outputs: [output], totalAtomic: "100000" });
    assert(fp === meltFingerprint({ asset, keysetId, outputs: [output], totalAtomic: "100000" }), "melt fingerprint nondeterministic");
    const nullifier = nullifierOf(randomSecret());
    const redeem = redeemKeyOf({
      asset, recipientAgentId: "payee", keysetId, proofs: [{ denomAtomic: "100000", nullifier }],
    });
    const alternateKeyset = "0x" + "11".repeat(32);
    assert(redeem !== redeemKeyOf({
      asset, recipientAgentId: "payee", keysetId: alternateKeyset,
      proofs: [{ denomAtomic: "100000", nullifier }],
    }), "redeem key collided across keysets");
    const signed = discovered.manifest[0];
    assert(verifyManifestEntry(signed, discovered.mintIdentityPubKey), "valid manifest rejected");
    assert(!verifyManifestEntry({
      ...signed,
      entry: { ...signed.entry, activatesAt: signed.entry.activatesAt + 1 },
    }, discovered.mintIdentityPubKey), "tampered manifest accepted");
  });

  await check("2 issue/redeem round-trip and per-keyset liability zero-sum", async () => {
    issueRoundTripVouchers = await meltToBlindVouchers({
      rpcUrl,
      payerAgentId: "payer",
      amountAtomic: "3000000",
      network: "base",
      mint: discovered,
      identitySigner: identities.get("payer"),
      wallet: walletFor("payer"),
    });
    assert(issueRoundTripVouchers.length === 3, "expected three 1.0 vouchers");
    assert(ledger.balance("payer", asset) === "0", "payer was not debited exactly");
    assert(ledger.voucherLiability(asset, discovered.keysets.find((k) => k.status === "active").keysetId) === "3000000", "per-keyset liability mismatch");
    const result = await redeemBlindVouchers({
      rpcUrl,
      recipientAgentId: "payee",
      vouchers: issueRoundTripVouchers,
      network: "base",
    });
    assert(result.valueAtomic === "3000000", "redeem value mismatch");
    assert(ledger.balance("payee", asset) === "3000000", "payee credit mismatch");
    assert(ledger.voucherLiability(asset, issueRoundTripVouchers[0].keysetId) === "0", "liability did not return to zero");
  });

  await check("3 unlinkability data-flow under permuted same-denomination redemptions", async () => {
    const alpha = await meltToBlindVouchers({
      rpcUrl, payerAgentId: "link-alpha-CANARY", amountAtomic: "1000000",
      mint: discovered, identitySigner: identities.get("link-alpha-CANARY"),
      wallet: walletFor("link-alpha-CANARY"),
    });
    const beta = await meltToBlindVouchers({
      rpcUrl, payerAgentId: "link-beta-CANARY", amountAtomic: "1000000",
      mint: discovered, identitySigner: identities.get("link-beta-CANARY"),
      wallet: walletFor("link-beta-CANARY"),
    });
    await redeemBlindVouchers({
      rpcUrl, recipientAgentId: "recipient-beta-CANARY", vouchers: alpha,
    });
    await redeemBlindVouchers({
      rpcUrl, recipientAgentId: "recipient-alpha-CANARY", vouchers: beta,
    });
    const durableAndLogs = [
      await readFile(keysetPath, "utf8"),
      await readFile(nullifierPath, "utf8"),
      await readFile(ledgerPath, "utf8"),
      capturedLogs.join("\n"),
    ];
    assert(!durableAndLogs.some((body) =>
      body.includes("link-alpha-CANARY") && body.includes("recipient-beta-CANARY")),
    "alpha melt/redeem linkage canaries co-occurred durably");
    assert(!durableAndLogs.some((body) =>
      body.includes("link-beta-CANARY") && body.includes("recipient-alpha-CANARY")),
    "beta melt/redeem linkage canaries co-occurred durably");
  });

  await check("4 signed-manifest equivocation and signature tamper rejection", async () => {
    const alternate = await new BlindVoucherMint({
      keysetFilePath: join(root, "equiv-keysets.json"),
      nullifierFilePath: join(root, "equiv-nullifiers.json"),
      encryptionKey,
      mintIdentityKey: mintIdentity.privateKey,
      denominationsAtomic: ["100000", "1000000", "10000000", "100000000"],
      keysetGraceMs: 1,
      maxOutputsPerRequest: 64,
      maxProofsPerRequest: 64,
      assets: [asset],
    }).load();
    const checkpoint = alternate.checkpoint(asset);
    assert(checkpoint.headSeq === oldCheckpoint.headSeq
      && checkpoint.headEntryHash !== oldCheckpoint.headEntryHash,
    "equivocation fixture did not create divergent same-sequence heads");
    await expectReject(async () => assertCheckpointAgreement(oldCheckpoint, checkpoint), "equivocation");
    const signed = alternate.publicManifest(asset)[0];
    assert(!verifyManifestEntry({ ...signed, signature: flipHex(signed.signature) }, alternate.mintIdentityPubKey()), "manifest signature tamper accepted");
    alternate.close();
  });

  await check("5 serialized concurrent double-spend credits exactly one recipient", async () => {
    const vouchers = await meltToBlindVouchers({
      rpcUrl, payerAgentId: "double", amountAtomic: "1000000",
      mint: discovered, identitySigner: identities.get("double"),
      wallet: walletFor("double"),
    });
    const proof = toProofs(vouchers);
    const settled = await Promise.allSettled([
      registry.redeemBlindVouchers({
        recipientAgentId: "winner-a", keysetId: vouchers[0].keysetId, proofs: proof,
      }, "127.0.0.1", token, nowSeconds()),
      registry.redeemBlindVouchers({
        recipientAgentId: "winner-b", keysetId: vouchers[0].keysetId, proofs: proof,
      }, "127.0.0.1", token, nowSeconds()),
    ]);
    assert(settled.filter((entry) => entry.status === "fulfilled").length === 1, "double spend did not produce exactly one winner");
    assert(settled.filter((entry) => entry.status === "rejected"
      && String(entry.reason?.message).includes("double_spend")).length === 1,
    "double spend loser was not rejected");
    assert(BigInt(ledger.balance("winner-a", asset)) + BigInt(ledger.balance("winner-b", asset)) === 1000000n, "double spend credited more or less than once");
    const nullifierFile = await new EncryptedJsonFile(nullifierPath, encryptionKey, { failClosed: true }).read(null);
    const reserved = nullifierFile.spent[vouchers[0].keysetId][nullifierOf(vouchers[0].secret)];
    assert(typeof reserved === "string" && reserved.startsWith("0x"), "winning redeem key was not durably reserved");
  });

  await check("6 intra-request duplicate proof is rejected without state change", async () => {
    const vouchers = await meltToBlindVouchers({
      rpcUrl, payerAgentId: "duplicate", amountAtomic: "1000000",
      mint: discovered, identitySigner: identities.get("duplicate"),
      wallet: walletFor("duplicate"),
    });
    const before = ledger.balance("dup-recipient", asset);
    const proof = toProofs(vouchers)[0];
    await expectReject(() => registry.redeemBlindVouchers({
      recipientAgentId: "dup-recipient",
      keysetId: vouchers[0].keysetId,
      proofs: [proof, proof],
    }, "127.0.0.1", token, nowSeconds()), "duplicate voucher proof");
    assert(ledger.balance("dup-recipient", asset) === before, "duplicate proof changed recipient balance");
    assert(ledger.voucherLiability(asset, vouchers[0].keysetId) === "1000000", "duplicate proof changed liability");
  });

  await check("7 crash-idempotent issue recovery uses fresh nonce and one debit", async () => {
    const active = discovered.keysets.find((keyset) => keyset.status === "active");
    const blinded = blindSecret(randomSecret());
    const pending = {
      fingerprint: "",
      asset,
      keysetId: active.keysetId,
      createdAt: Date.now(),
      contexts: [{
        denomAtomic: "1000000",
        secret: blinded.secret,
        r: blinded.r,
        B_: blinded.B_,
      }],
    };
    const outputs = pending.contexts.map(({ denomAtomic, B_ }) => ({ denomAtomic, B_ }));
    pending.fingerprint = meltFingerprint({
      asset, keysetId: active.keysetId, outputs, totalAtomic: "1000000",
    });
    const crashWallet = walletFor("crash");
    await crashWallet.savePending(pending);
    const intentNonce = hexlify(nodeRandomBytes(32));
    const agentSignature = await identities.get("crash").signMessage(
      blindVoucherIssueIntentMessage({
        payerAgentId: "crash",
        network: "base",
        keysetId: active.keysetId,
        outputsFingerprint: pending.fingerprint,
        totalAtomic: "1000000",
        intentNonce,
      }),
    );
    const request = {
      payerAgentId: "crash", network: "base", keysetId: active.keysetId,
      outputs, totalAtomic: "1000000", intentNonce, agentSignature,
    };
    const first = await post(rpcUrl, "/private/a2a/voucher-issue", request);
    assert(first.status === 201, "initial lost-response issuance failed");
    const sameNonce = await post(rpcUrl, "/private/a2a/voucher-issue", request);
    assert(sameNonce.status === 400
      && String(sameNonce.body.error).includes("Replayed"), "same-nonce retry was not rejected");
    const recovered = await recoverMelt({
      rpcUrl, payerAgentId: "crash", pending, mint: discovered,
      identitySigner: identities.get("crash"), wallet: crashWallet,
    });
    const K = active.denominations.find((d) => d.denomAtomic === "1000000").K;
    const expectedC = unblindSignature({
      C_: first.body.result.signatures[0].C_,
      r: pending.contexts[0].r,
      K,
    });
    assert(recovered[0].C === expectedC, "fresh-nonce recovery changed deterministic signature");
    assert(ledger.balance("crash", asset) === "0"
      && ledger.voucherLiability(asset, active.keysetId) === "2000000",
    "issue recovery double-debited or changed liability incorrectly");
  });

  await check("8 crash-idempotent redeem completes once after reserve-before-credit", async () => {
    const crashVouchers = (await walletFor("crash").loadVouchers());
    const voucher = crashVouchers[0];
    const proofs = toProofs([voucher]);
    const redeemKey = redeemKeyOf({
      asset,
      recipientAgentId: "crash-recipient",
      keysetId: voucher.keysetId,
      proofs: [{ denomAtomic: voucher.denomAtomic, nullifier: nullifierOf(voucher.secret) }],
    });
    await mint.verifyAndReserveNullifiers({
      asset, keysetId: voucher.keysetId, redeemKey, proofs,
    });
    const first = await registry.redeemBlindVouchers({
      recipientAgentId: "crash-recipient", keysetId: voucher.keysetId, proofs,
    }, "127.0.0.1", token, nowSeconds());
    const second = await registry.redeemBlindVouchers({
      recipientAgentId: "crash-recipient", keysetId: voucher.keysetId, proofs,
    }, "127.0.0.1", token, nowSeconds());
    assert(first.valueAtomic === "1000000" && second.valueAtomic === "1000000", "idempotent redeem response mismatch");
    assert(ledger.balance("crash-recipient", asset) === "1000000", "crash retry credited more or less than once");
  });

  await check("9 bad DLEQ cannot debit payer and pending value remains recoverable", async () => {
    const badDir = join(root, "bad-dleq");
    const badJournal = new EphemeralPaymentJournal(join(badDir, "epochs"));
    const badLedger = await new PrivatePaymentLedger(join(badDir, "ledger.json"), encryptionKey, {
      journal: badJournal, retentionMs: 60_000,
    }).load({ bad: "100000" });
    const badIdentity = Wallet.createRandom();
    const denomKey = secp256k1.utils.randomSecretKey();
    const badContext = blindSecret(randomSecret());
    const badKeysetId = "0x" + "44".repeat(32);
    const publicKeyset = {
      keysetId: badKeysetId, asset, epoch: 0, status: "active",
      activatesAt: Date.now(), redeemUntil: null,
      denominations: [{ denomAtomic: "100000", K: hexlify(secp256k1.getPublicKey(denomKey, true)) }],
    };
    const badMint = {
      activeKeyset: () => publicKeyset,
      sign: ({ outputs }) => ({
        keysetId: badKeysetId,
        signatures: outputs.map((output) => ({
          denomAtomic: output.denomAtomic,
          C_: signBlinded({ B_: output.B_, k: hexlify(denomKey) }),
          dleq: { e: "0x" + "01".padStart(64, "0"), s: "0x" + "01".padStart(64, "0") },
        })),
      }),
    };
    const badRegistry = new PrivateAgentRegistry([{
      agentId: "bad", label: "bad", vpnIp: "127.0.0.1",
      walletAddress: Wallet.createRandom().address,
      identityAddress: badIdentity.address, sharedSecret: "bad", credits: 0, inventory: [],
    }], { privateLedger: badLedger, mint: badMint });
    const outputs = [{ denomAtomic: "100000", B_: badContext.B_ }];
    const fingerprint = meltFingerprint({
      asset, keysetId: badKeysetId, outputs, totalAtomic: "100000",
    });
    const intentNonce = hexlify(nodeRandomBytes(32));
    const signature = await badIdentity.signMessage(blindVoucherIssueIntentMessage({
      payerAgentId: "bad", network: "base", keysetId: badKeysetId,
      outputsFingerprint: fingerprint, totalAtomic: "100000", intentNonce,
    }));
    await expectReject(() => badRegistry.issueBlindVouchers({
      payerAgentId: "bad", keysetId: badKeysetId, outputs, totalAtomic: "100000",
      intentNonce, agentSignature: signature,
    }, "127.0.0.1", token, nowSeconds()), "DLEQ");
    assert(badLedger.balance("bad", asset) === "100000"
      && badLedger.voucherLiability(asset, badKeysetId) === "0",
    "bad DLEQ debited payer or created liability");
    badLedger.close();
  });

  await check("10 retirement freezes, exact-reclaims, then erases without live-liability loss", async () => {
    const system = await createDirectSystem(root, "retire", { retire: "200000" }, ["retire", "retire-recipient"]);
    const active = system.mint.activeKeyset(asset);
    commitExpiryForTest(system.mint, active.keysetId, Date.now() + 10_000);
    const issued = await issueDirect(system, "retire", "200000");
    await system.mint.rotateKeyset(asset);
    await system.registry.redeemBlindVouchers({
      recipientAgentId: "retire-recipient",
      keysetId: issued.vouchers[0].keysetId,
      proofs: toProofs([issued.vouchers[0]]),
    }, "127.0.0.1", token, nowSeconds());
    assert(system.ledger.voucherLiability(asset, active.keysetId) === "100000", "retired live liability fixture mismatch");
    await expectReject(() => system.mint.eraseKeyset(asset, active.keysetId), "frozen");
    const frozen = await system.mint.freezeExpiredKeysets(Date.now() + 20_000);
    assert(frozen.some((entry) => entry.keysetId === active.keysetId), "committed expiry did not freeze keyset");
    assert(system.ledger.voucherLiability(asset, active.keysetId) === "100000", "freeze changed liability");
    const reclaimed = await system.ledger.reclaimRetiredKeyset({ assetKey: asset, keysetId: active.keysetId });
    assert(reclaimed.reclaimedAtomic === "100000"
      && system.ledger.voucherLiability(asset, active.keysetId) === "0",
    "retirement did not reclaim exact liability");
    const beforeErase = await new EncryptedJsonFile(
      system.ledgerPath, encryptionKey, { failClosed: true },
    ).read(null);
    assert(active.keysetId in beforeErase.consumedVoucherRefs,
      "ledger tombstones pruned before key erasure");
    await system.mint.eraseKeyset(asset, active.keysetId);
    await system.ledger.reclaimRetiredKeyset({ assetKey: asset, keysetId: active.keysetId });
    await expectReject(() => system.mint.verifyAndReserveNullifiers({
      asset, keysetId: active.keysetId, redeemKey: "0x" + "55".repeat(32),
      proofs: toProofs([issued.vouchers[1]]),
    }), "unknown or erased");
    system.mint.close();
    system.ledger.close();
  });

  await check("11 keyset, nullifier, and wallet stores fail closed under four corruptions", async () => {
    await assertMintStoreFailClosed("keyset", keysetPath, nullifierPath, "wrong-key");
    await assertMintStoreFailClosed("keyset", keysetPath, nullifierPath, "truncated");
    await assertMintStoreFailClosed("keyset", keysetPath, nullifierPath, "bad-tag");
    await assertMintStoreFailClosed("keyset", keysetPath, nullifierPath, "malformed");
    await assertMintStoreFailClosed("nullifier", keysetPath, nullifierPath, "wrong-key");
    await assertMintStoreFailClosed("nullifier", keysetPath, nullifierPath, "truncated");
    await assertMintStoreFailClosed("nullifier", keysetPath, nullifierPath, "bad-tag");
    await assertMintStoreFailClosed("nullifier", keysetPath, nullifierPath, "malformed");

    const walletSource = join(root, "fail-wallet-source.json");
    const walletKey = nodeRandomBytes(32).toString("hex");
    const wallet = new BlindVoucherWalletFile(walletSource, walletKey);
    const context = blindSecret(randomSecret());
    await wallet.savePending({
      fingerprint: "0x" + "66".repeat(32),
      asset,
      keysetId: discovered.keysets[0].keysetId,
      createdAt: Date.now(),
      contexts: [{
        denomAtomic: "100000", secret: context.secret, r: context.r, B_: context.B_,
      }],
    });
    for (const mode of ["wrong-key", "truncated", "bad-tag", "malformed"]) {
      const path = join(root, `wallet-${mode}.json`);
      await copyFile(walletSource, path);
      let key = walletKey;
      if (mode === "wrong-key") key = nodeRandomBytes(32).toString("hex");
      if (mode === "truncated") await writeFile(path, "{\"version\":1");
      if (mode === "bad-tag") await corruptTag(path);
      if (mode === "malformed") {
        await new EncryptedJsonFile(path, walletKey, { failClosed: true }).write({
          version: 1, pending: "not-an-array", vouchers: [],
        });
      }
      await expectReject(() => new BlindVoucherWalletFile(path, key).loadPending());
    }
  });

  await check("12 bearer redeem requires VPN membership but no identity signature", async () => {
    const vouchers = await meltToBlindVouchers({
      rpcUrl, payerAgentId: "member", amountAtomic: "1000000",
      mint: discovered, identitySigner: identities.get("member"),
      wallet: walletFor("member"),
    });
    await expectReject(() => registry.redeemBlindVouchers({
      recipientAgentId: "member-recipient", keysetId: vouchers[0].keysetId,
      proofs: toProofs(vouchers),
    }, "10.77.99.99", token, nowSeconds()), "Unregistered VPN peer");
    const result = await registry.redeemBlindVouchers({
      recipientAgentId: "member-recipient", keysetId: vouchers[0].keysetId,
      proofs: toProofs(vouchers),
    }, "127.0.0.1", token, nowSeconds());
    assert(result.status === "redeemed"
      && ledger.balance("member-recipient", asset) === "1000000",
    "membership-only bearer redeem failed");
  });

  await check("13 strict config, exact denomination, request limits, and flag-off 503", async () => {
    await expectReject(async () => parseDenoms("[\"01\",\"1\"]"), "duplicate");
    await expectReject(async () => parseSafeMs("Infinity", 1), "finite integer");
    await expectReject(async () => decomposeAmount("150000", ["100000", "1000000"]), "exactly representable");
    const output = { denomAtomic: "100000", B_: blindSecret(randomSecret()).B_ };
    await expectReject(async () => mint.sign({
      asset,
      keysetId: mint.activeKeyset(asset).keysetId,
      outputs: Array.from({ length: 65 }, () => output),
    }), "limit");
    await expectReject(() => mint.verifyAndReserveNullifiers({
      asset,
      keysetId: mint.activeKeyset(asset).keysetId,
      redeemKey: "0x" + "77".repeat(32),
      proofs: Array.from({ length: 65 }, () => ({
        denomAtomic: "100000", secret: randomSecret(), C: output.B_,
      })),
    }), "limit");
    const off = createPrivateAgentServer({ registry, ledger, deposits });
    off.listen(0, "127.0.0.1");
    await once(off, "listening");
    const offAddress = off.address();
    const response = await fetch(`http://127.0.0.1:${offAddress.port}/private/a2a/mint-keys?network=base`);
    off.close();
    assert(response.status === 503, "flag-off mint route did not return 503");
  });

  await check("14 per-keyset growth partitions prune after reclaim and erase", async () => {
    const system = await createDirectSystem(root, "growth", { growth: "500000" }, ["growth", "growth-recipient"]);
    const keysetId = system.mint.activeKeyset(asset).keysetId;
    for (let index = 0; index < 5; index += 1) {
      const issued = await issueDirect(system, "growth", "100000");
      await system.registry.redeemBlindVouchers({
        recipientAgentId: "growth-recipient", keysetId,
        proofs: toProofs(issued.vouchers),
      }, "127.0.0.1", token, nowSeconds());
    }
    const before = await new EncryptedJsonFile(system.ledgerPath, encryptionKey, { failClosed: true }).read(null);
    assert(before.consumedVoucherRefs[keysetId].length === 10, "voucher tombstone partition did not grow as expected");
    await system.mint.rotateKeyset(asset);
    system.mint.keysets.keysets.find((keyset) => keyset.keysetId === keysetId).status = "frozen";
    await system.mint.eraseKeyset(asset, keysetId);
    await system.ledger.reclaimRetiredKeyset({ assetKey: asset, keysetId });
    const after = await new EncryptedJsonFile(system.ledgerPath, encryptionKey, { failClosed: true }).read(null);
    assert(!(keysetId in after.consumedVoucherRefs), "ledger retained erased-keyset tombstones");
    const nullifiers = await new EncryptedJsonFile(system.nullifierPath, encryptionKey, { failClosed: true }).read(null);
    assert(!(keysetId in nullifiers.spent), "mint retained erased-keyset nullifiers");
    system.mint.close();
    system.ledger.close();
  });

  await check("15 leak-injection meta-test proves each detector fails closed", async () => {
    const detectors = {
      sharedCheckpoint: (a, b) => {
        try { assertCheckpointAgreement(a, b); return true; } catch { return false; }
      },
      nonzeroR: (r) => {
        try { blindSecret(randomSecret(), r); return true; } catch { return false; }
      },
      redeemBody: (body) => body.proofs.every((proof) => !("r" in proof)),
      durableLink: (body, meltCanary, redeemCanary) =>
        !(body.includes(meltCanary) && body.includes(redeemCanary)),
      cleanLogs: (logs, canary) => !logs.some((line) => line.includes(canary)),
    };
    const divergent = { ...oldCheckpoint, headEntryHash: "0x" + "88".repeat(32) };
    assert(!detectors.sharedCheckpoint(oldCheckpoint, divergent), "per-payer keyset mutant escaped detector");
    assert(!detectors.nonzeroR("0x" + "00".repeat(32)), "r=0 mutant escaped detector");
    assert(!detectors.redeemBody({ proofs: [{ denomAtomic: "1", secret: "redacted", C: "redacted", r: "LEAK" }] }), "redeem-r mutant escaped detector");
    assert(!detectors.durableLink("MELT_CANARY B_->payer REDEEM_CANARY", "MELT_CANARY", "REDEEM_CANARY"), "persisted linkage mutant escaped detector");
    assert(!detectors.cleanLogs(["ordinary", "LOG_CANARY token body"], "LOG_CANARY"), "log canary mutant escaped detector");
  });
} finally {
  mint.close();
  ledger.close();
  server.close();
  await rm(root, { recursive: true, force: true });
}

console.log(`BLIND_VOUCHER_SMOKE_RESULT ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const failure of failures) console.log("DETAIL", failure);
  process.exitCode = 1;
}

function safeName(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toProofs(vouchers) {
  return vouchers.map((voucher) => ({
    denomAtomic: voucher.denomAtomic,
    secret: voucher.secret,
    C: voucher.C,
  }));
}

function flipHex(value) {
  const bytes = getBytes(value);
  bytes[bytes.length - 1] ^= 1;
  return hexlify(bytes);
}

function hashToCurveCounter(secret) {
  const domain = toUtf8Bytes("Secp256k1_HashToCurve_Cashu_");
  const message = getBytes(sha256(concat([domain, getBytes(secret)])));
  for (let counter = 0; counter <= 65_535; counter += 1) {
    const littleEndian = new Uint8Array(4);
    new DataView(littleEndian.buffer).setUint32(0, counter, true);
    const candidate = getBytes(sha256(concat([message, littleEndian])));
    try {
      secp256k1.ProjectivePoint.fromHex(
        getBytes(concat([Uint8Array.of(0x02), candidate])),
      );
      return counter;
    } catch {
      // pinned NUT-00 try-and-increment
    }
  }
  throw new Error("hashToCurve counter exhausted");
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function createDirectSystem(parent, name, initialBalances, agents) {
  const directory = join(parent, name);
  const identity = Wallet.createRandom();
  const agentIdentities = new Map(agents.map((agent) => [agent, Wallet.createRandom()]));
  const directLedgerPath = join(directory, "ledger.json");
  const directNullifierPath = join(directory, "nullifiers.json");
  const directLedger = await new PrivatePaymentLedger(directLedgerPath, encryptionKey, {
    journal: new EphemeralPaymentJournal(join(directory, "epochs")),
    retentionMs: 60_000,
  }).load(initialBalances);
  const directMint = await new BlindVoucherMint({
    keysetFilePath: join(directory, "keysets.json"),
    nullifierFilePath: directNullifierPath,
    encryptionKey,
    mintIdentityKey: identity.privateKey,
    denominationsAtomic: ["100000", "1000000", "10000000", "100000000"],
    keysetGraceMs: 1000,
    maxOutputsPerRequest: 64,
    maxProofsPerRequest: 64,
    assets: [asset],
  }).load();
  const directRegistry = new PrivateAgentRegistry(agents.map((agentId) => ({
    agentId, label: agentId, vpnIp: "127.0.0.1",
    walletAddress: Wallet.createRandom().address,
    identityAddress: agentIdentities.get(agentId).address,
    sharedSecret: agentId, credits: 0, inventory: [],
  })), { privateLedger: directLedger, mint: directMint });
  return {
    ledger: directLedger,
    ledgerPath: directLedgerPath,
    mint: directMint,
    nullifierPath: directNullifierPath,
    registry: directRegistry,
    identities: agentIdentities,
  };
}

async function issueDirect(system, payerAgentId, amountAtomic) {
  const active = system.mint.activeKeyset(asset);
  const denominations = decomposeAmount(
    amountAtomic,
    active.denominations.map((denomination) => denomination.denomAtomic),
  );
  const contexts = denominations.map((denomAtomic) => ({
    ...blindSecret(randomSecret()),
    denomAtomic,
  }));
  const outputs = contexts.map(({ denomAtomic, B_ }) => ({ denomAtomic, B_ }));
  const fingerprint = meltFingerprint({
    asset, keysetId: active.keysetId, outputs, totalAtomic: amountAtomic,
  });
  const intentNonce = hexlify(nodeRandomBytes(32));
  const agentSignature = await system.identities.get(payerAgentId).signMessage(
    blindVoucherIssueIntentMessage({
      payerAgentId, network: "base", keysetId: active.keysetId,
      outputsFingerprint: fingerprint, totalAtomic: amountAtomic, intentNonce,
    }),
  );
  const result = await system.registry.issueBlindVouchers({
    payerAgentId, keysetId: active.keysetId, outputs, totalAtomic: amountAtomic,
    intentNonce, agentSignature,
  }, "127.0.0.1", token, nowSeconds());
  const vouchers = result.signatures.map((signature, index) => {
    const context = contexts[index];
    const K = active.denominations.find((denomination) =>
      denomination.denomAtomic === context.denomAtomic).K;
    return {
      id: `direct-${nameSafeRandom()}`,
      asset,
      keysetId: active.keysetId,
      denomAtomic: context.denomAtomic,
      secret: context.secret,
      C: unblindSignature({ C_: signature.C_, r: context.r, K }),
      r: context.r,
      dleq: signature.dleq,
    };
  });
  return { result, vouchers };
}

function nameSafeRandom() {
  return nodeRandomBytes(8).toString("hex");
}

function commitExpiryForTest(testMint, keysetId, redeemUntil) {
  const keyset = testMint.keysets.keysets.find((candidate) => candidate.keysetId === keysetId);
  keyset.redeemUntil = redeemUntil;
  const signed = testMint.keysets.manifestByAsset[asset].find(
    (candidate) => candidate.entry.keysetId === keysetId,
  );
  signed.entry.redeemUntil = redeemUntil;
  signed.entryHash = hashManifestEntry(signed.entry);
  signed.signature = hexlify(
    secp256k1.sign(getBytes(signed.entryHash), testMint.identityKey, { lowS: true })
      .toCompactRawBytes(),
  );
  assert(verifyManifestEntry(signed, testMint.mintIdentityPubKey()), "test expiry commitment is invalid");
}

async function assertMintStoreFailClosed(store, sourceKeysets, sourceNullifiers, mode) {
  const directory = join(root, `fail-${store}-${mode}`);
  await mkdir(directory, { recursive: true });
  const testKeysets = join(directory, "keysets.json");
  const testNullifiers = join(directory, "nullifiers.json");
  await copyFile(sourceKeysets, testKeysets);
  await copyFile(sourceNullifiers, testNullifiers);
  let key = encryptionKey;
  const target = store === "keyset" ? testKeysets : testNullifiers;
  if (mode === "wrong-key") key = "wrong-blind-voucher-encryption-key";
  if (mode === "truncated") await writeFile(target, "{\"version\":1");
  if (mode === "bad-tag") await corruptTag(target);
  if (mode === "malformed") {
    const malformed = store === "keyset"
      ? { version: 1, mintIdentityKeyFingerprint: "bad", manifestByAsset: {}, keysets: [] }
      : { version: 1, spent: [] };
    await new EncryptedJsonFile(target, encryptionKey, { failClosed: true }).write(malformed);
  }
  const candidate = new BlindVoucherMint({
    keysetFilePath: testKeysets,
    nullifierFilePath: testNullifiers,
    encryptionKey: key,
    mintIdentityKey: mintIdentity.privateKey,
    denominationsAtomic: ["100000", "1000000", "10000000", "100000000"],
    keysetGraceMs: 1,
    maxOutputsPerRequest: 64,
    maxProofsPerRequest: 64,
    assets: [asset],
  });
  await expectReject(() => candidate.load());
}

async function corruptTag(path) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  payload.tag = Buffer.alloc(16, 0).toString("base64");
  await writeFile(path, JSON.stringify(payload));
}
