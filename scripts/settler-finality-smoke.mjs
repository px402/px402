// Settler confirmation-path regression suite.
//
// Every other harness in this repo makes finality INSTANT — the unit mocks pin
// `finalized` above the receipt's block, and both anvil fork proofs run with
// `--slots-in-an-epoch 1` (and say so in their own error strings). Real chains do
// not behave that way: measured 2026-07-31, Base's `finalized` tag lagged `latest`
// by 1462s and Robinhood's by 1062s, against a 120_000ms default budget.
//
// This suite is the one place that models a transaction which MINED SUCCESSFULLY
// but is not yet covered by the finality tag — the ordinary state of every EVM
// transaction for its first ~20 minutes — and holds the line on the distinction
// that matters: INCLUDED (known, still in flight) is not UNCERTAIN (ambiguous,
// freeze the nonce pipeline).
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import {
  SettlerNotYetFinalError,
  TransactionCoordinator,
  TransactionOutbox,
} from "../src/server/base/TransactionCoordinator.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import {
  BASE_USDC,
  buildPaymentRequirements,
  createPaymentPayload,
} from "../src/shared/x402.ts";

const root = await mkdtemp(join(tmpdir(), "settler-finality-smoke-"));
const tests = [];
let passed = 0;
let failed = 0;

const test = (name, run) => tests.push({ name, run });
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};

/**
 * A provider whose `finalized` head sits BELOW the block transactions mine into.
 * Receipts are canonical and status=1: they succeeded. They are simply not final.
 */
class UnfinalizedProvider {
  constructor() {
    this.pending = 0;
    this.latest = 0;
    this.finalizedHead = 5;
    this.minedAt = 10;
    this.receipts = new Map();
    this.broadcasts = [];
    this.blockTags = [];
    /** txHash -> mine it as soon as it is broadcast (how a real chain behaves). */
    this.minesOnBroadcast = new Map();
    /** Heights whose canonical block hash no longer matches the receipts we hold. */
    this.reorgedHeights = new Set();
  }
  getTransactionCount(_address, tag) {
    return Promise.resolve(tag === "pending" ? this.pending : this.latest);
  }
  getFeeData() {
    return Promise.resolve({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gasPrice: 100n });
  }
  broadcastTransaction(signedTx) {
    this.broadcasts.push(signedTx);
    const txHash = this.minesOnBroadcast.get(signedTx);
    if (txHash) this.mine(txHash);
    return Promise.resolve({ hash: "0xbroadcast" });
  }
  getTransactionReceipt(hash) {
    return Promise.resolve(this.receipts.get(hash) ?? null);
  }
  getBlock(tag) {
    this.blockTags.push(String(tag));
    if (tag === "finalized" || tag === "safe") {
      return Promise.resolve({ number: this.finalizedHead, hash: `block-${this.finalizedHead}` });
    }
    if (tag === "latest") return Promise.resolve({ number: 200, hash: "block-200" });
    // A reorg replaces the block at a height: the receipt still names the old hash,
    // but the canonical chain now reports a different one at that number.
    if (this.reorgedHeights.has(Number(tag))) {
      return Promise.resolve({ number: Number(tag), hash: `block-${tag}-reorged` });
    }
    return Promise.resolve({ number: Number(tag), hash: `block-${tag}` });
  }
  send() { return Promise.resolve(null); }
  /** A successful, canonical receipt the finality tag does not yet cover. */
  mine(txHash) {
    this.receipts.set(txHash, {
      status: 1,
      blockNumber: this.minedAt,
      blockHash: `block-${this.minedAt}`,
    });
  }
  finalize() { this.finalizedHead = this.minedAt + 1; }
}

let seq = 0;
const coordinatorFor = async (provider, options = {}) => {
  seq += 1;
  const outbox = await new TransactionOutbox(join(root, `outbox-${seq}.json`), "smoke-secret").load();
  const coordinator = new TransactionCoordinator({
    provider,
    address: "0x0000000000000000000000000000000000000001",
    chainId: 8453,
    outbox,
    finality: options.finality ?? "finalized",
    confirmationFloorFallback: options.confirmationFloorFallback ?? 2,
    bumpAfterMs: options.bumpAfterMs ?? 10_000,
    timeoutMs: options.timeoutMs ?? 250,
    recoveryBudgetMs: options.recoveryBudgetMs ?? 100,
    dispatchGraceMs: options.dispatchGraceMs,
    cancelSign: options.cancelSign,
  });
  return { outbox, coordinator };
};

/**
 * `mines: true`  — the chain accepts and mines it (=> INCLUDED, then final).
 * `mines: false` — it never appears anywhere (=> genuinely UNCERTAIN).
 * Always returns an already-guarded promise so a rejection can never escape as an
 * unhandled rejection and kill the run.
 */
const submission = (coordinator, tag, provider, options = {}) => {
  const signedTx = `0xsigned${tag}`;
  if (options.mines !== false) provider.minesOnBroadcast.set(signedTx, `0xtx${tag}`);
  const promise = coordinator.submit({
    kind: options.kind ?? "pool-payout",
    ref: `ref-${tag}`,
    logicalId: `logical-${tag}`,
    payloadFingerprint: `fp-${tag}`,
    sign: async () => ({ signedTx, txHash: `0xtx${tag}` }),
  });
  const outcome = { settled: false, value: undefined, error: undefined };
  const guarded = promise.then(
    (value) => { outcome.settled = true; outcome.value = value; },
    (error) => { outcome.settled = true; outcome.error = error; },
  );
  return { guarded, outcome };
};

/** True if `promise` settles within `ms`, false if it is still pending. */
const settlesWithin = async (promise, ms) => {
  let done = false;
  const guarded = promise.then(() => { done = true; }, () => { done = true; });
  await Promise.race([guarded, new Promise((resolve) => setTimeout(resolve, ms))]);
  return done;
};

// 1-3: INCLUDED is a known outcome and must never be treated as ambiguity.
test("1 a mined-but-unfinalized transaction is INCLUDED, never a quarantine", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider);
  const { guarded, outcome } = submission(coordinator, "A", provider);
  await guarded;
  assert(
    outcome.error?.name === "SettlerNotYetFinalError",
    `expected SettlerNotYetFinalError, got ${outcome.error?.name}: ${outcome.error?.message ?? outcome.value}`,
  );
  assert(outcome.error.transactionHash === "0xtxA", `expected the mined hash, got ${outcome.error.transactionHash}`);
  assert(!coordinator.isQuarantined(), "inclusion is not ambiguity — it must not quarantine");
  assert(outbox.byLogicalId("logical-A").state === "included", "the outbox should record inclusion");
  coordinator.close();
});

test("2 a genuinely unknown outcome still quarantines", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  const { guarded, outcome } = submission(coordinator, "B", provider, { mines: false });
  await guarded;
  assert(/finality timeout/.test(outcome.error?.message ?? ""), `expected the ambiguous path, got: ${outcome.error?.message}`);
  assert(coordinator.isQuarantined(), "a genuinely unknown outcome must still quarantine");
  coordinator.close();
});

test("3 an included transaction is never rebroadcast or fee-bumped", async () => {
  const provider = new UnfinalizedProvider();
  // Without the short-circuit this window rebroadcasts every ~100ms and signs a
  // fee-bumped replacement every ~100ms, for the full 800ms.
  const { coordinator, outbox } = await coordinatorFor(provider, { bumpAfterMs: 100, timeoutMs: 800 });
  const { guarded } = submission(coordinator, "C", provider);
  await guarded;
  const entry = outbox.byLogicalId("logical-C");
  assert(
    entry.versions.length === 1,
    `the nonce is consumed, so replacements are dead on arrival; got ${entry.versions.length} versions`,
  );
  assert(provider.broadcasts.length === 1, `expected exactly the first broadcast, got ${provider.broadcasts.length}`);
  coordinator.close();
});

// 4: the confirmation floor is not a safety net on chains that implement the tag.
test("4 the confirmation floor is unreachable while the RPC implements the finality tag", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider, { confirmationFloorFallback: 1 });
  const { guarded } = submission(coordinator, "D", provider);
  await guarded;
  // A floor of 1 against a `latest` of 200 would pass instantly IF it were consulted.
  assert(
    !provider.blockTags.includes("latest"),
    "getBlock('latest') was called — the confirmation-floor fallback is reachable, "
    + "so this no longer proves the tag is the sole gate",
  );
  coordinator.close();
});

// 5-7: a quarantine must never pin the settler lease.
test("5 a submission quarantined while awaiting the lease parks without pinning it", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  // E never mines, so it quarantines — from its OUT-OF-LEASE poll. To exercise the
  // in-lease quarantine branch (PARK_OUTSIDE_LEASE), F must be queued behind the
  // lease when the quarantine lands: G holds the lease open via a hanging sign(),
  // F passes the pre-lease check while quarantine is still false, and reaches the
  // in-lease check only after E's poll has quarantined.
  const first = submission(coordinator, "E", provider, { mines: false });
  let releaseSign = () => {};
  const gGuarded = coordinator.submit({
    kind: "pool-payout",
    ref: "ref-G5",
    logicalId: "logical-G5",
    payloadFingerprint: "fp-G5",
    sign: () => new Promise((resolve) => {
      releaseSign = () => resolve({ signedTx: "0xsignedG5", txHash: "0xtxG5" });
    }),
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = submission(coordinator, "F", provider, { mines: false });
  await first.guarded;
  assert(coordinator.isQuarantined(), "the unknown outcome should have quarantined the settler");
  releaseSign();
  assert(!(await settlesWithin(second.guarded, 200)), "F should park while the settler is quarantined");
  assert(
    await settlesWithin(coordinator.recoverOutbox(), 1500),
    "recoverOutbox() is blocked — the lease is pinned by the in-lease quarantine branch",
  );
  coordinator.close();
  await Promise.all([second.guarded, gGuarded]);
});

test("6 resolveQuarantine stays reachable after a quarantine (the admin escape)", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  const first = submission(coordinator, "G", provider, { mines: false });
  await first.guarded;
  assert(coordinator.isQuarantined());
  const second = submission(coordinator, "H", provider, { mines: false });
  // It may reject (no cancelSign configured) — what matters is that it RETURNS.
  assert(
    await settlesWithin(coordinator.resolveQuarantine({ nonce: 0, mode: "cancel" }).catch(() => {}), 1500),
    "resolveQuarantine() is blocked — the settler lease is pinned",
  );
  coordinator.close();
  await second.guarded;
});

test("7 close() rejects parked submissions rather than leaking them", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  const first = submission(coordinator, "I", provider, { mines: false });
  await first.guarded;
  assert(coordinator.isQuarantined(), "I should have quarantined the settler");
  // Submitted AFTER the quarantine, so it parks on the pre-lease check.
  const second = submission(coordinator, "J", provider, { mines: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  coordinator.close();
  // Bounded, so a leak reports as a failure instead of hanging the whole suite.
  assert(
    await settlesWithin(second.guarded, 1500),
    "the parked submission never settled after close() — it leaked",
  );
  assert(
    /closed/.test(second.outcome.error?.message ?? ""),
    `expected a closed rejection, got: ${second.outcome.error?.message ?? second.outcome.value}`,
  );
});

// 3b: an inclusion can be UNDONE. The classifier must not remember a stale one.
test("3b a reorged-away inclusion returns to ambiguous and quarantines", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 900 });
  // Mines, is observed as included, and is then dropped by a reorg.
  setTimeout(() => {
    provider.receipts.delete("0xtxN");
    provider.minesOnBroadcast.clear();
  }, 250);
  const { guarded, outcome } = submission(coordinator, "N", provider);
  await guarded;
  assert(
    outcome.error?.name !== "SettlerNotYetFinalError",
    "a reorged-away transaction was still reported as included — the stale hash was "
    + "carried forward and the nonce pipeline freed on an ambiguous outcome",
  );
  assert(/finality timeout/.test(outcome.error?.message ?? ""), `expected the ambiguous path, got: ${outcome.error?.message}`);
  assert(coordinator.isQuarantined(), "an outcome that became ambiguous again must quarantine");
  assert(outbox.byLogicalId("logical-N").state !== "included", "the outbox must not record a reorged inclusion");
  coordinator.close();
});

test("3c a receipt in a REORGED block is not inclusion", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 900 });
  // The receipt survives and still names block-10 — but the canonical chain now has a
  // different block at height 10. That is a reorg, distinct from the receipt simply
  // disappearing (3b), and it exercises the `reorged` arm of receiptStanding, which
  // the rest of the suite never reaches: a mutation returning "included" here passed
  // every other test in both suites.
  setTimeout(() => provider.reorgedHeights.add(provider.minedAt), 250);
  const { guarded, outcome } = submission(coordinator, "P", provider);
  await guarded;
  assert(
    outcome.error?.name !== "SettlerNotYetFinalError",
    "a receipt in a non-canonical block was reported as included — the short-circuit "
    + "would then stop rebroadcasting a transaction that no longer exists",
  );
  assert(coordinator.isQuarantined(), "a reorged-out transaction is ambiguous and must quarantine");
  assert(outbox.byLogicalId("logical-P").state !== "included", "the outbox must not record a reorged block as inclusion");
  coordinator.close();
});

// 8b: recovery must not freeze the settler over a transaction that is merely young.
test("8b recoverOutbox does not quarantine over an included entry", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { recoveryBudgetMs: 2_000 });
  // Two entries at consecutive nonces, both mined, neither final — the state of the
  // outbox after any restart inside the finality window.
  for (const [index, tag] of [[0, "L"], [1, "M"]]) {
    provider.mine(`0xtx${tag}`);
    await outbox.putVersion({
      chainId: 8453,
      address: "0x0000000000000000000000000000000000000001",
      nonce: index,
      kind: "pool-payout",
      ref: `ref-${tag}`,
      logicalId: `logical-${tag}`,
      payloadFingerprint: `fp-${tag}`,
      version: {
        txHash: `0xtx${tag}`, signedTx: `0xsigned${tag}`,
        maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt: 1,
      },
    });
  }
  await coordinator.recoverOutbox();
  assert(
    !coordinator.isQuarantined(),
    "recovery quarantined the settler over a mined, canonical transaction — every restart "
    + "inside the finality window would freeze all settler traffic",
  );
  coordinator.close();
});

// 8: the ordinary happy path still works.
test("8 a transaction finalized inside the budget settles normally", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 3_000 });
  setTimeout(() => provider.finalize(), 150);
  const { guarded, outcome } = submission(coordinator, "K", provider);
  await guarded;
  assert(!outcome.error, `expected success, got ${outcome.error?.message}`);
  assert(outcome.value.state === "finalized", `expected finalized, got ${outcome.value.state}`);
  assert(outcome.value.txHash === "0xtxK", `expected the signed hash, got ${outcome.value.txHash}`);
  assert(!coordinator.isQuarantined(), "a healthy settle must not quarantine");
  coordinator.close();
});

// 9-11: an EIP-3009 authorization is single-use ON-CHAIN. Reporting failure for a
// transfer that actually landed is therefore not a recoverable error — the payer
// cannot retry (the token's authorizationState now rejects that nonce) and cannot
// re-quote without signing a SECOND authorization that moves the money again.
// So "included" must reach the caller as a receipt, and the replay guard must stay
// consumed. A genuine failure must still roll the guard back, or one transient RPC
// blip would permanently strand a payer's nonce.

/** A JSON-RPC stub that answers eth_call, so simulateSettle runs fully offline. */
const stubRpc = async (respond = () => ({ result: "0x" })) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...respond(JSON.parse(body)) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

/** A coordinator seam that reproduces exactly what test 1 proves the real one throws. */
const includedCoordinator = () => ({
  submit: async () => {
    throw new SettlerNotYetFinalError({ transactionHash: "0xincluded", nonce: 7 });
  },
  outboxEntryFor: () => undefined,
});

const facilitatorFixture = async (coordinator, rpcUrl) => {
  const payer = Wallet.createRandom();
  const payee = Wallet.createRandom();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const requirements = buildPaymentRequirements({
    payTo: payee.address,
    maxAmountRequired: "250000",
    resource: "included-settle",
    token: BASE_USDC,
    nowSeconds,
  });
  const payload = await createPaymentPayload({
    payerPrivateKey: payer.privateKey,
    requirements,
    token: BASE_USDC,
    nowSeconds,
  });
  const facilitator = new X402Facilitator({
    rpcUrl,
    settlerPrivateKey: Wallet.createRandom().privateKey,
    token: BASE_USDC,
    coordinator,
  });
  return { facilitator, payload, requirements, nowSeconds, payer, payee };
};

test("9 an x402 settle that reached inclusion returns a receipt, not a failure", async () => {
  const rpc = await stubRpc();
  try {
    const fx = await facilitatorFixture(includedCoordinator(), rpc.url);
    let settlement;
    try {
      settlement = await fx.facilitator.verifyAndSettle(fx.payload, fx.requirements, fx.nowSeconds);
    } catch (error) {
      throw new Error(
        "settle threw for a transfer that is mined and canonical: "
        + `${error instanceof Error ? error.message : error}. The payer is told it failed `
        + "while the USDC has moved, and the authorization is spent on-chain so no retry can fix it.",
      );
    }
    assert(settlement.transactionHash === "0xincluded", `expected the mined hash, got ${settlement.transactionHash}`);
    assert(settlement.standing === "included", `expected standing "included", got ${settlement.standing}`);
    // The authorization is spent on-chain; the in-process guard must agree.
    await fx.facilitator
      .verifyAndSettle(fx.payload, fx.requirements, fx.nowSeconds)
      .then(
        () => { throw new Error("the replay guard was rolled back — the same authorization settled twice"); },
        (error) => assert(
          /already used/.test(error.message),
          `expected the replay guard to hold, got: ${error.message}`,
        ),
      );
  } finally {
    rpc.close();
  }
});

test("10 a deposit relay that reached inclusion returns a receipt, not a failure", async () => {
  const rpc = await stubRpc();
  try {
    const fx = await facilitatorFixture(includedCoordinator(), rpc.url);
    const auth = fx.payload.authorization;
    let relayed;
    try {
      relayed = await fx.facilitator.relaySignedDeposit({
        payload: fx.payload,
        expectedFrom: auth.from,
        expectedTo: auth.to,
        expectedValueAtomic: auth.value,
        ref: "deposit-1",
        nowSeconds: fx.nowSeconds,
      });
    } catch (error) {
      throw new Error(
        "the relay threw for a transfer that is mined and canonical: "
        + `${error instanceof Error ? error.message : error}. The one-shot deposit slot is `
        + "released while the stealth output has already been swept on-chain.",
      );
    }
    assert(relayed.transactionHash === "0xincluded", `expected the mined hash, got ${relayed.transactionHash}`);
    assert(relayed.standing === "included", `expected standing "included", got ${relayed.standing}`);
  } finally {
    rpc.close();
  }
});

test("11 a genuine settle failure still rolls the replay guard back", async () => {
  // Over-correcting is its own bug: if EVERY error retained the guard, one transient
  // RPC failure would strand that authorization for the whole NONCE_TTL.
  const rpc = await stubRpc();
  try {
    const fx = await facilitatorFixture(
      { submit: async () => { throw new Error("broadcast refused by the RPC"); }, outboxEntryFor: () => undefined },
      rpc.url,
    );
    await fx.facilitator.verifyAndSettle(fx.payload, fx.requirements, fx.nowSeconds).then(
      () => { throw new Error("a refused broadcast must still surface as a failure"); },
      () => {},
    );
    // Same authorization, retried: it must get past the guard to reach the chain again.
    await fx.facilitator.verifyAndSettle(fx.payload, fx.requirements, fx.nowSeconds).then(
      () => { throw new Error("unexpected success"); },
      (error) => assert(
        !/already used/.test(error.message),
        "the replay guard was retained on a genuine failure — this authorization can never be retried",
      ),
    );
  } finally {
    rpc.close();
  }
});

// 12: the R14 property (spec-cohort-dispatch.md v2 §2.1). This test used to pin the
// OPPOSITE behaviour — the lease held through finality, submits strictly serial —
// "so the fix has something to invert". This is the inversion.
test("12 the finality wait releases the settler lease, so a second submit broadcasts behind it", async () => {
  const provider = new UnfinalizedProvider();
  provider.minedAt = 100;
  provider.finalizedHead = 50; // mined but NOT covered by the finality tag
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 5_000, bumpAfterMs: 60_000 });
  let releaseA = () => {};
  const held = new Promise((resolve) => { releaseA = resolve; });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  // Block A only AFTER it has mined, so it is pinned mid-finality-wait — the state
  // every settler transaction occupies for its first ~20 minutes on Base.
  provider.getTransactionReceipt = async (hash) => {
    const receipt = await receiptFor(hash);
    if (hash === "0xtxA" && receipt) await held;
    return receipt;
  };
  const a = submission(coordinator, "A", provider);
  const b = submission(coordinator, "B", provider);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(provider.broadcasts.includes("0xsignedA"), "A reached the chain");
  assert(
    provider.broadcasts.includes("0xsignedB"),
    "B never broadcast: the finality wait is still holding the settler lease, so an "
    + "unrelated wait serializes every other settler transaction on the network (R14)",
  );
  assert(!a.outcome.settled && !b.outcome.settled, "neither has finality yet — neither may resolve");
  assert(outbox.byLogicalId("logical-A").nonce === 0, "A allocated nonce 0");
  assert(outbox.byLogicalId("logical-B").nonce === 1, "B allocated the next nonce, no gap, no duplicate");
  releaseA();
  provider.finalize();
  await Promise.all([a.guarded, b.guarded]);
  assert(!a.outcome.error && a.outcome.value.state === "finalized", `A settles on finality: ${a.outcome.error?.message ?? "ok"}`);
  assert(!b.outcome.error && b.outcome.value.state === "finalized", `B settles on finality: ${b.outcome.error?.message ?? "ok"}`);
  coordinator.close();
});

// 13: the shared-coordinator trap. ONE coordinator per network is shared by
// X402Facilitator, EvmChainRail, and PrivateBatchCommitter — the reason v1's
// "leave submit() alone" design was rejected is that an unrelated x402 settle
// held the lease across a cohort's dispatch. Pin that the wait no longer
// serializes ACROSS kinds.
test("13 an x402 settle awaiting finality does not block a pool payout (cross-kind)", async () => {
  const provider = new UnfinalizedProvider();
  provider.minedAt = 100;
  provider.finalizedHead = 50;
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 5_000, bumpAfterMs: 60_000 });
  let releaseA = () => {};
  const held = new Promise((resolve) => { releaseA = resolve; });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  provider.getTransactionReceipt = async (hash) => {
    const receipt = await receiptFor(hash);
    if (hash === "0xtxX" && receipt) await held;
    return receipt;
  };
  const settle = submission(coordinator, "X", provider, { kind: "x402-settle" });
  const payout = submission(coordinator, "Y", provider, { kind: "pool-payout" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(
    provider.broadcasts.includes("0xsignedY"),
    "the pool payout never broadcast while the x402 settle waited for finality — "
    + "an unrelated settle still wedges a cohort",
  );
  releaseA();
  provider.finalize();
  await Promise.all([settle.guarded, payout.guarded]);
  coordinator.close();
});

// 14: out of the lease, duplicate submits of one logicalId must share ONE poll.
// Two independent poll loops on the same entry both fee-bump on schedule and race
// putVersion's increasing-fee check — one of them throws on the retry path that is
// supposed to be idempotent.
test("14 concurrent submits of one logicalId share a single poll (no fee-race rejection)", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 2_000, bumpAfterMs: 150 });
  let signCalls = 0;
  const minedHashes = [];
  const input = () => ({
    kind: "pool-payout",
    ref: "ref-dup",
    logicalId: "logical-dup",
    payloadFingerprint: "fp-dup",
    sign: async ({ nonce }) => {
      signCalls += 1;
      const txHash = `0xtxdup-${signCalls}`;
      minedHashes.push(txHash);
      return { signedTx: `0xsigneddup-${signCalls}`, txHash };
    },
  });
  const guard = (promise) => {
    const outcome = { value: undefined, error: undefined };
    return {
      outcome,
      guarded: promise.then((value) => { outcome.value = value; }, (error) => { outcome.error = error; }),
    };
  };
  const first = guard(coordinator.submit(input()));
  const second = guard(coordinator.submit(input()));
  // Let both polls run long enough to cross the bump interval at least twice,
  // then let the (possibly bumped) transaction land and finalize.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const hash of minedHashes) provider.mine(hash);
  provider.finalize();
  await Promise.all([first.guarded, second.guarded]);
  assert(
    !first.outcome.error && !second.outcome.error,
    "a duplicate submit rejected — two poll loops raced the increasing-fee check: "
    + `${(first.outcome.error ?? second.outcome.error)?.message}`,
  );
  assert(
    first.outcome.value.nonce === second.outcome.value.nonce,
    "both submits must resolve to the same logical operation",
  );
  assert(
    outbox.byLogicalId("logical-dup").nonce === 0,
    "one logical operation, one nonce",
  );
  coordinator.close();
});

// 15: nonce allocation under concurrent dispatch — the guarantee the lease still owns.
test("15 concurrent submits allocate consecutive nonces with no duplicate", async () => {
  const provider = new UnfinalizedProvider();
  provider.finalizedHead = 20; // instant finality once mined
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 2_000 });
  const tags = ["N1", "N2", "N3", "N4"];
  const all = tags.map((tag) => submission(coordinator, tag, provider));
  await Promise.all(all.map((item) => item.guarded));
  for (const [index, item] of all.entries()) {
    assert(!item.outcome.error, `submit ${tags[index]} failed: ${item.outcome.error?.message}`);
  }
  const nonces = tags.map((tag) => outbox.byLogicalId(`logical-${tag}`).nonce).sort((x, y) => x - y);
  assert(
    JSON.stringify(nonces) === JSON.stringify([0, 1, 2, 3]),
    `expected consecutive nonces 0-3, got ${JSON.stringify(nonces)}`,
  );
  coordinator.close();
});

// 16-17: one quarantine record, many concurrent polls — the record must stay
// truthful now that polls overlap.
test("16 an unrelated landing does not clear a live quarantine or unpark submissions", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 700 });
  let releaseB = () => {};
  const held = new Promise((resolve) => { releaseB = resolve; });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  // Pin B mid-poll (after it mines) so it is still in flight when A quarantines.
  provider.getTransactionReceipt = async (hash) => {
    const receipt = await receiptFor(hash);
    if (hash === "0xtxB16" && receipt) await held;
    return receipt;
  };
  const a = submission(coordinator, "A16", provider, { mines: false }); // nonce 0, never mines
  const b = submission(coordinator, "B16", provider);                   // nonce 1, mines
  await a.guarded;
  assert(coordinator.isQuarantined(), "A's unknown outcome should have quarantined");
  assert(coordinator.quarantineDetail().nonce === 0, "the record names A's nonce");
  const parked = submission(coordinator, "P16", provider, { mines: false });
  provider.finalize();
  releaseB();
  await b.guarded;
  assert(!b.outcome.error && b.outcome.value.state === "finalized", `B lands: ${b.outcome.error?.message ?? "ok"}`);
  assert(
    coordinator.isQuarantined(),
    "B's landing cleared A's quarantine — pending submissions are now unparked "
    + "behind an outcome that is still ambiguous",
  );
  assert(coordinator.quarantineDetail().nonce === 0, "the record still names A's nonce");
  assert(!(await settlesWithin(parked.guarded, 200)), "the parked submission must stay parked");
  coordinator.close();
  await parked.guarded;
});

test("17 concurrent timeouts converge the quarantine record on the LOWEST nonce", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 400 });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  // Slow A's poll iterations so B (the higher nonce) times out and quarantines
  // FIRST — the order that exercises the replace branch, not the decline branch.
  provider.getTransactionReceipt = async (hash) => {
    if (hash === "0xtxA17") await new Promise((resolve) => setTimeout(resolve, 200));
    return receiptFor(hash);
  };
  const a = submission(coordinator, "A17", provider, { mines: false }); // nonce 0
  const b = submission(coordinator, "B17", provider, { mines: false }); // nonce 1
  await Promise.all([a.guarded, b.guarded]);
  assert(/finality timeout/.test(a.outcome.error?.message ?? ""), `A quarantine path: ${a.outcome.error?.message}`);
  assert(/finality timeout/.test(b.outcome.error?.message ?? ""), `B quarantine path: ${b.outcome.error?.message}`);
  assert(
    coordinator.quarantineDetail().nonce === 0,
    "the quarantine record names a stranded HIGHER nonce — the operator's cancel "
    + `tooling acts on the wrong transaction (got nonce ${coordinator.quarantineDetail()?.nonce})`,
  );
  coordinator.close();
});

// 17b: the mirror ordering. In 17 the lower nonce writes LAST (exercising the
// replace branch), so a last-writer-wins mutation still passes it by coincidence.
// Here the lower nonce writes FIRST and the higher nonce's later proposal must be
// DECLINED — the branch only this ordering can distinguish.
test("17b a higher nonce quarantining later never overwrites the recorded root blocker", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 400 });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  // Slow B's poll iterations so A (the lower nonce) times out and quarantines first.
  provider.getTransactionReceipt = async (hash) => {
    if (hash === "0xtxB17b") await new Promise((resolve) => setTimeout(resolve, 200));
    return receiptFor(hash);
  };
  const a = submission(coordinator, "A17b", provider, { mines: false }); // nonce 0
  const b = submission(coordinator, "B17b", provider, { mines: false }); // nonce 1
  await a.guarded;
  assert(coordinator.quarantineDetail()?.nonce === 0, "A's timeout records nonce 0 first");
  await b.guarded;
  assert(/finality timeout/.test(b.outcome.error?.message ?? ""), `B quarantine path: ${b.outcome.error?.message}`);
  assert(
    coordinator.quarantineDetail().nonce === 0,
    "B's later timeout overwrote the record — the recorded quarantine no longer "
    + `names the root blocker (got nonce ${coordinator.quarantineDetail()?.nonce})`,
  );
  coordinator.close();
});

// 18-21: review findings on the wait-move (Grok, 2026-08-06).
test("18 recoverOutbox skips an entry a live poll owns instead of racing it", async () => {
  const provider = new UnfinalizedProvider();
  provider.minedAt = 100;
  provider.finalizedHead = 50;
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 5_000, recoveryBudgetMs: 300 });
  let releaseA = () => {};
  const held = new Promise((resolve) => { releaseA = resolve; });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  provider.getTransactionReceipt = async (hash) => {
    const receipt = await receiptFor(hash);
    if (hash === "0xtxA18" && receipt) await held;
    return receipt;
  };
  const a = submission(coordinator, "A18", provider);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(provider.broadcasts.includes("0xsignedA18"), "A is mid-poll");
  // Without the skip, recovery starts a SECOND resumeEntry on A, hangs on the
  // same gated receipt read, and either pins the lease past its budget or
  // quarantines a healthy settler whose transaction is merely mid-wait.
  assert(
    await settlesWithin(coordinator.recoverOutbox(), 1500),
    "recoverOutbox raced the live poll and hung on its entry",
  );
  assert(!coordinator.isQuarantined(), "recovery quarantined an entry a live poll owns");
  releaseA();
  provider.finalize();
  await a.guarded;
  assert(!a.outcome.error && a.outcome.value.state === "finalized", `A still lands: ${a.outcome.error?.message ?? "ok"}`);
  coordinator.close();
});

test("19 resolveQuarantine racing a lower-nonce replacement does not clear the new record", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 400 });
  const receiptFor = provider.getTransactionReceipt.bind(provider);
  // A (nonce 0) polls slowly and times out LAST; B (nonce 1) quarantines first.
  provider.getTransactionReceipt = async (hash) => {
    if (hash === "0xtxA19") await new Promise((resolve) => setTimeout(resolve, 200));
    return receiptFor(hash);
  };
  const a = submission(coordinator, "A19", provider, { mines: false });
  const b = submission(coordinator, "B19", provider, { mines: false });
  await b.guarded;
  assert(coordinator.quarantineDetail()?.nonce === 1, "B's timeout records nonce 1 first");
  // Operator starts a landed-disposition on the RECORDED nonce 1. Gate its
  // receipt read on A's timeout, so the record is replaced with nonce 0 while
  // the disposition's RPCs are in flight.
  provider.mine("0xtxB19");
  provider.finalize();
  const gate = a.guarded;
  provider.getTransactionReceipt = async (hash) => {
    if (hash === "0xtxB19") await gate;
    if (hash === "0xtxA19") await new Promise((resolve) => setTimeout(resolve, 200));
    return receiptFor(hash);
  };
  const resolved = await coordinator.resolveQuarantine({ nonce: 1, mode: "disposition", landedHash: "0xtxB19" });
  assert(resolved.verdict === "landed", `disposition should land: ${resolved.verdict}`);
  assert(outbox.byLogicalId("logical-B19").state === "finalized", "B's entry is finalized");
  assert(
    coordinator.quarantineDetail()?.nonce === 0,
    "the disposition of nonce 1 cleared the record nonce 0 acquired while it ran — "
    + "pending submissions unpark behind a still-ambiguous root",
  );
  coordinator.close();
});

test("20 a poll stuck behind a quarantined nonce stops signing fee bumps", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 700, bumpAfterMs: 150 });
  // NOT the shared `submission` helper: its sign returns a CONSTANT txHash, and
  // putVersion drops duplicate hashes, so a bump would be invisible to the
  // versions assertion and this test would measure nothing (the mutation check
  // caught exactly that). Distinct replacements per call, like a real signer.
  let signCalls = 0;
  const outcome = { error: undefined };
  const guarded = coordinator.submit({
    kind: "pool-payout",
    ref: "ref-B20",
    logicalId: "logical-B20",
    payloadFingerprint: "fp-B20",
    sign: async () => {
      signCalls += 1;
      return { signedTx: `0xsignedB20-${signCalls}`, txHash: `0xtxB20-${signCalls}` };
    },
  }).then(() => {}, (error) => { outcome.error = error; });
  // Record a quarantine at/below B's nonce while B is mid-poll, before its
  // first bump interval elapses.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await outbox.proposeQuarantine(8453, "0x0000000000000000000000000000000000000001", 0);
  await guarded;
  assert(signCalls === 1, `the poll kept signing replacements for a nonce that cannot mine behind the quarantine — the §2.3 bidding war (sign called ${signCalls} times)`);
  assert(
    outbox.byLogicalId("logical-B20").versions.length === 1,
    `expected one version, got ${outbox.byLogicalId("logical-B20").versions.length}`,
  );
  assert(
    provider.broadcasts.filter((tx) => tx === "0xsignedB20-1").length >= 1,
    "rebroadcasts of the existing version must continue",
  );
  coordinator.close();
});

test("21 a cancel that loses to the original landing finalizes state and lifts the quarantine", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    cancelSign: async () => ({ signedTx: "0xsignedCancel21", txHash: "0xcancel21" }),
  });
  const a = submission(coordinator, "A21", provider, { mines: false });
  await a.guarded;
  assert(coordinator.isQuarantined(), "A quarantined");
  // The cancel broadcast is what reveals the original actually mined (a real
  // race on-chain: the cancel loses, the original lands).
  provider.finalize();
  provider.minesOnBroadcast.set("0xsignedCancel21", "0xtxA21");
  const resolved = await coordinator.resolveQuarantine({ nonce: 0, mode: "cancel" });
  assert(resolved.verdict === "landed", `expected landed, got ${resolved.verdict}`);
  assert(
    outbox.byLogicalId("logical-A21").state === "finalized",
    "the operator was told 'landed' but the outbox still says "
    + `${outbox.byLogicalId("logical-A21").state} — a false resolution`,
  );
  assert(!coordinator.isQuarantined(), "the quarantine must lift on a landed cancel-mode resolution");
  coordinator.close();
});

test("22 close() stops an active out-of-lease poll instead of orphaning it", async () => {
  const provider = new UnfinalizedProvider();
  // Long budget: without the closed check, the orphaned poll would keep
  // broadcasting and writing to the outbox for the full 5s after close().
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 5_000 });
  const a = submission(coordinator, "A22", provider, { mines: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(provider.broadcasts.includes("0xsignedA22"), "A is mid-poll");
  coordinator.close();
  assert(
    await settlesWithin(a.guarded, 1500),
    "the poll outlived close() — it keeps the process alive and keeps writing "
    + "to the outbox after shutdown began",
  );
  assert(/closed/.test(a.outcome.error?.message ?? ""), `expected a closed rejection, got: ${a.outcome.error?.message}`);
  assert(!coordinator.isQuarantined(), "shutdown is not ambiguity — close() must not quarantine");
  assert(
    outbox.byLogicalId("logical-A22").state === "broadcasting",
    "the WAL identity must stay `broadcasting` for the next boot's recovery",
  );
});

// 30-37: §2.2 dispatchMany + §2.3 maintainEntry (spec-cohort-dispatch.md).
const dispatchInput = (tag, options = {}) => ({
  kind: "pool-payout",
  ref: `ref-${tag}`,
  logicalId: `logical-${tag}`,
  payloadFingerprint: `fp-${tag}`,
  sign: options.sign ?? (async () => ({ signedTx: `0xsigned${tag}`, txHash: `0xtx${tag}` })),
});

test("30 dispatchMany: one wave, consecutive nonces, one pending read, no finality wait", async () => {
  const provider = new UnfinalizedProvider();
  let pendingReads = 0;
  const originalCount = provider.getTransactionCount.bind(provider);
  provider.getTransactionCount = (address, tag) => {
    if (tag === "pending") pendingReads += 1;
    return originalCount(address, tag);
  };
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 60_000 });
  const started = Date.now();
  const outcomes = await coordinator.dispatchMany(
    ["D0", "D1", "D2", "D3"].map((tag) => dispatchInput(tag)),
  );
  assert(Date.now() - started < 2_000, "dispatchMany blocked — it must not wait for anything to mine");
  assert(outcomes.every((o) => o.status === "dispatched"), `all dispatched, got ${JSON.stringify(outcomes.map((o) => o.status))}`);
  assert(
    JSON.stringify(outcomes.map((o) => o.nonce)) === JSON.stringify([0, 1, 2, 3]),
    `consecutive nonces expected, got ${JSON.stringify(outcomes.map((o) => o.nonce))}`,
  );
  assert(pendingReads === 1, `one nonce read per WAVE, got ${pendingReads}`);
  for (const tag of ["D0", "D1", "D2", "D3"]) {
    assert(provider.broadcasts.includes(`0xsigned${tag}`), `${tag} must broadcast in the wave`);
    assert(outbox.byLogicalId(`logical-${tag}`).state === "broadcasting", `${tag} stays in flight`);
  }
  coordinator.close();
});

test("31 dispatchMany re-dispatch is idempotent: rebroadcast once, never a fresh sign", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 60_000 });
  let signCalls = 0;
  const input = dispatchInput("R31", {
    sign: async () => { signCalls += 1; return { signedTx: "0xsignedR31", txHash: "0xtxR31" }; },
  });
  const first = await coordinator.dispatchMany([input]);
  const second = await coordinator.dispatchMany([input]);
  assert(signCalls === 1, `a re-dispatch must not sign again (increasing-fee race on the retry path), got ${signCalls}`);
  assert(second[0].status === "dispatched" && second[0].nonce === first[0].nonce, "same identity on re-dispatch");
  assert(
    provider.broadcasts.filter((tx) => tx === "0xsignedR31").length === 2,
    "the re-dispatch rebroadcasts the existing bytes once",
  );
  assert(outbox.byLogicalId("logical-R31").versions.length === 1, "one version only");
  coordinator.close();
});

test("32 dispatchMany rejects synchronously while quarantined", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  const first = submission(coordinator, "Q32", provider, { mines: false });
  await first.guarded;
  assert(coordinator.isQuarantined());
  const outcome = {};
  const guarded = coordinator.dispatchMany([dispatchInput("D32")])
    .then(() => {}, (error) => { outcome.error = error; });
  assert(await settlesWithin(guarded, 500), "dispatchMany parked instead of rejecting");
  assert(outcome.error?.name === "SettlerQuarantinedError", `expected SettlerQuarantinedError, got ${outcome.error?.name}`);
  coordinator.close();
});

test("33 consecutive first-broadcast failures fail-stop into quarantine", async () => {
  // The v1 review's out-of-gas pile-up: every window allocates and strands
  // another run of nonces. Eight consecutive non-benign first-broadcast
  // failures must trip the fail-stop.
  const provider = new UnfinalizedProvider();
  provider.broadcastTransaction = async () => { throw new Error("insufficient funds for gas"); };
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 60_000 });
  const outcomes = await coordinator.dispatchMany(
    Array.from({ length: 8 }, (_, index) => dispatchInput(`F33-${index}`)),
  );
  assert(outcomes.length === 8, "all inputs get an outcome");
  assert(
    coordinator.isQuarantined(),
    "eight consecutive first-broadcast failures must quarantine — otherwise a broken "
    + "settler allocates and strands another run of nonces every window, unbounded",
  );
  coordinator.close();
});

test("38 a mid-wave sign failure keeps the nonce sequence gapless", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 60_000 });
  const inputs = [
    dispatchInput("G38-a"),
    dispatchInput("G38-b", { sign: async () => { throw new Error("injected signer failure"); } }),
    dispatchInput("G38-c"),
  ];
  const outcomes = await coordinator.dispatchMany(inputs);
  assert(outcomes[0].status === "dispatched" && outcomes[0].nonce === 0, `leg a nonce 0, got ${JSON.stringify(outcomes[0])}`);
  assert(outcomes[1].status === "failed", "the failed sign reports failed");
  assert(
    outcomes[2].status === "dispatched" && outcomes[2].nonce === 1,
    `the failed sign must NOT consume a nonce — leg c takes 1, got ${JSON.stringify(outcomes[2])}`,
  );
  assert(outbox.byLogicalId("logical-G38-b") === undefined, "a failed sign leaves no outbox identity");
  coordinator.close();
});

test("39 the fail-stop counter resets on any successful broadcast", async () => {
  // Partial failure is not systemic failure: four refusals followed by four
  // successes must NOT trip the eight-consecutive fail-stop, and every leg
  // keeps its durable identity either way.
  const provider = new UnfinalizedProvider();
  let broadcastCalls = 0;
  provider.broadcastTransaction = async (signedTx) => {
    broadcastCalls += 1;
    if (broadcastCalls <= 4) throw new Error("insufficient funds for gas");
    provider.broadcasts.push(signedTx);
    return { hash: "0xbroadcast" };
  };
  const { coordinator, outbox } = await coordinatorFor(provider, { timeoutMs: 60_000 });
  const outcomes = await coordinator.dispatchMany(
    Array.from({ length: 8 }, (_, index) => dispatchInput(`P39-${index}`)),
  );
  assert(outcomes.every((o) => o.status === "dispatched"), "young refused-broadcast legs stay dispatched (maintain owns them)");
  assert(
    !coordinator.isQuarantined(),
    "four failures then four successes is a transient, not a broken settler — the fail-stop must reset",
  );
  for (let index = 0; index < 8; index += 1) {
    assert(outbox.byLogicalId(`logical-P39-${index}`).state === "broadcasting", `leg ${index} keeps its durable identity`);
  }
  coordinator.close();
});

test("34 maintainEntry rebroadcasts and fee-bumps a dispatched entry", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    bumpAfterMs: 100, timeoutMs: 60_000, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox, "M34", 0, Date.now() - 500);
  let signCalls = 0;
  const sign = async () => {
    signCalls += 1;
    return { signedTx: `0xsignedM34-bump${signCalls}`, txHash: `0xtxM34-bump${signCalls}` };
  };
  await coordinator.maintainEntry({ logicalId: "logical-M34", sign });
  assert(provider.broadcasts.length >= 1, "maintain must rebroadcast the newest version");
  assert(signCalls === 1, `the stale version is past bumpAfterMs — one bump expected, got ${signCalls}`);
  assert(outbox.byLogicalId("logical-M34").versions.length === 2, "the bump is durably recorded");
  const broadcastsBefore = provider.broadcasts.length;
  await coordinator.maintainEntry({ logicalId: "logical-M34", sign });
  assert(signCalls === 1, "a fresh replacement must not bump again inside the interval");
  assert(provider.broadcasts.length > broadcastsBefore, "rebroadcast continues every pass");
  coordinator.close();
});

test("35 maintainEntry is inert under quarantine and for suppressed entries", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    bumpAfterMs: 50, timeoutMs: 60_000, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox, "M35", 0, Date.now() - 500);
  let signCalls = 0;
  const sign = async () => { signCalls += 1; return { signedTx: `0xb-${signCalls}`, txHash: `0xh-${signCalls}` }; };
  await outbox.setQuarantine(8453, "0x0000000000000000000000000000000000000001", 0);
  await coordinator.maintainEntry({ logicalId: "logical-M35", sign });
  assert(provider.broadcasts.length === 0, "fully inert while quarantined — a bump would outbid the operator cancel");
  assert(signCalls === 0, "no signing while quarantined");
  await outbox.setQuarantine(8453, "0x0000000000000000000000000000000000000001", null);
  coordinator.suppressPoolPayoutRebroadcast("logical-M35");
  await coordinator.maintainEntry({ logicalId: "logical-M35", sign });
  assert(provider.broadcasts.length === 0, "a suppressed leg's transfer was deliberately invalidated — never resurrect it");
  coordinator.close();
});

test("36 maintainEntry quarantines an entry past its durable per-entry deadline", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    timeoutMs: 500, dispatchGraceMs: 400,
  });
  await seedEntry(outbox, "M36", 0, Date.now() - 10_000);
  await coordinator.maintainEntry({ logicalId: "logical-M36" });
  assert(
    coordinator.isQuarantined(),
    "zero evidence past the confirm budget is the same ambiguity resumeEntry's expiry reports",
  );
  assert(outbox.byLogicalId("logical-M36").state === "uncertain", "the entry is parked for disposition");
  coordinator.close();
});

test("37 maintainEntry records inclusion and stops touching the consumed nonce", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    bumpAfterMs: 50, timeoutMs: 60_000,
  });
  await seedEntry(outbox, "M37", 0, Date.now() - 500);
  provider.mine("0xtxM37");
  let signCalls = 0;
  await coordinator.maintainEntry({
    logicalId: "logical-M37",
    sign: async () => { signCalls += 1; return { signedTx: "0xz", txHash: "0xzz" }; },
  });
  assert(outbox.byLogicalId("logical-M37").state === "included", "inclusion must be recorded");
  assert(provider.broadcasts.length === 0, "the nonce is consumed — rebroadcast is pointless");
  assert(signCalls === 0, "every replacement is dead on arrival");
  coordinator.close();
});

// 29: §2.5 — a caller that owns a durable queue opts into synchronous rejection
// over a suspended park, because the suspended promise pins ITS locks.
test("29 a reject-mode submission gets SettlerQuarantinedError instead of parking", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  const first = submission(coordinator, "Q29", provider, { mines: false });
  await first.guarded;
  assert(coordinator.isQuarantined(), "precondition: the settler is quarantined");
  const outcome = {};
  const rejected = coordinator.submit({
    kind: "pool-payout",
    ref: "ref-R29",
    logicalId: "logical-R29",
    payloadFingerprint: "fp-R29",
    onQuarantine: "reject",
    sign: async () => ({ signedTx: "0xsignedR29", txHash: "0xtxR29" }),
  }).then(() => {}, (error) => { outcome.error = error; });
  assert(await settlesWithin(rejected, 500), "a reject-mode submission parked anyway");
  assert(
    outcome.error?.name === "SettlerQuarantinedError",
    `expected SettlerQuarantinedError, got ${outcome.error?.name}: ${outcome.error?.message}`,
  );
  assert(
    coordinator.outboxEntryFor("logical-R29") === undefined,
    "a rejected submission must leave no outbox identity behind",
  );
  coordinator.close();
});

test("29b the mid-lease quarantine race also rejects a reject-mode submission", async () => {
  // Same structure as test 5: the quarantine lands while the submission is
  // queued behind the lease, so it reaches the PARK_OUTSIDE_LEASE branch — the
  // second of the two sites that must honor reject mode.
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider);
  const first = submission(coordinator, "E29", provider, { mines: false });
  let releaseSign = () => {};
  const gGuarded = coordinator.submit({
    kind: "pool-payout",
    ref: "ref-G29",
    logicalId: "logical-G29",
    payloadFingerprint: "fp-G29",
    sign: () => new Promise((resolve) => {
      releaseSign = () => resolve({ signedTx: "0xsignedG29", txHash: "0xtxG29" });
    }),
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const outcome = {};
  const fGuarded = coordinator.submit({
    kind: "pool-payout",
    ref: "ref-F29",
    logicalId: "logical-F29",
    payloadFingerprint: "fp-F29",
    onQuarantine: "reject",
    sign: async () => ({ signedTx: "0xsignedF29", txHash: "0xtxF29" }),
  }).then(() => {}, (error) => { outcome.error = error; });
  await first.guarded;
  assert(coordinator.isQuarantined(), "precondition: quarantined while F awaits the lease");
  releaseSign();
  assert(await settlesWithin(fGuarded, 1000), "the reject-mode submission parked in the mid-lease race");
  assert(
    outcome.error?.name === "SettlerQuarantinedError",
    `expected SettlerQuarantinedError, got ${outcome.error?.name}`,
  );
  coordinator.close();
  await gGuarded;
});

// 23-25: H7 dispatch grace + minimal H8 recovery (spec-cohort-dispatch.md §2.4/§2.8).
const seedEntry = async (outbox, tag, nonce, createdAt, kind = "pool-payout") => {
  await outbox.putVersion({
    chainId: 8453,
    address: "0x0000000000000000000000000000000000000001",
    nonce,
    kind,
    ref: `ref-${tag}`,
    logicalId: `logical-${tag}`,
    payloadFingerprint: `fp-${tag}`,
    version: {
      txHash: `0xtx${tag}`, signedTx: `0xsigned${tag}`,
      maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt,
    },
  });
};

test("23 zero evidence is `pending` inside the dispatch grace and `uncertain` past it", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { dispatchGraceMs: 60_000 });
  // Same chain state — no receipt, nonce unconsumed — judged only by entry age.
  await seedEntry(outbox, "Y23", 0, Date.now());
  await seedEntry(outbox, "O23", 1, Date.now() - 120_000);
  const young = await coordinator.classifyNonce({ nonce: 0, logicalId: "logical-Y23" });
  const old = await coordinator.classifyNonce({ nonce: 1, logicalId: "logical-O23" });
  assert(
    young.verdict === "pending",
    `a just-dispatched entry with no evidence is ordinary mine latency, got ${young.verdict}`,
  );
  assert(
    old.verdict === "uncertain",
    `the same absence past the grace is genuine ambiguity, got ${old.verdict}`,
  );
  // A createdAt in the FUTURE (forward clock jump at write time, later
  // corrected) must not read as "young forever" — corrupt evidence gets the
  // noisy answer, never the silent one.
  await seedEntry(outbox, "F23", 2, Date.now() + 3_600_000);
  const skewed = await coordinator.classifyNonce({ nonce: 2, logicalId: "logical-F23" });
  assert(
    skewed.verdict === "uncertain",
    `a future-skewed dispatch timestamp must classify uncertain, got ${skewed.verdict}`,
  );
  coordinator.close();
});

test("24 restart with a burst of young broadcasting entries recovers without quarantine", async () => {
  // The spec's §3 test 5 (unmined flavor): 8 legs broadcast, none mined, crash,
  // reboot. The old walk fed each into resumeEntry under ONE shared budget —
  // exhaustion quarantined a healthy settler and abandoned the rest of the walk.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    recoveryBudgetMs: 2_000, dispatchGraceMs: 60_000,
  });
  for (let index = 0; index < 8; index += 1) {
    await seedEntry(outbox, `R24-${index}`, index, Date.now());
  }
  assert(
    await settlesWithin(coordinator.recoverOutbox(), 1500),
    "recovery polled a young entry to completion instead of classify-once-and-skip",
  );
  assert(
    !coordinator.isQuarantined(),
    "recovery quarantined a healthy settler over entries that are merely young — "
    + "a routine restart mid-burst becomes an incident",
  );
  for (let index = 0; index < 8; index += 1) {
    assert(
      provider.broadcasts.includes(`0xsignedR24-${index}`),
      `entry ${index} was never rebroadcast — after a restart nothing else re-enters it into the mempool`,
    );
    assert(
      outbox.byLogicalId(`logical-R24-${index}`).state === "broadcasting",
      `entry ${index} must stay broadcasting for later classification`,
    );
  }
  coordinator.close();
});

test("26 budget exhaustion skips young and pool entries and quarantines only an old unowned one", async () => {
  // The exhaustion branch runs BEFORE classification, so it must judge by the
  // local clock alone: freezing the settler over an entry recovery never even
  // examined is the healthy-restart incident H8 exists to prevent.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    recoveryBudgetMs: 0, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox, "Y26", 0, Date.now());
  await coordinator.recoverOutbox();
  assert(
    !coordinator.isQuarantined(),
    "an exhausted budget quarantined a young entry it never examined",
  );
  coordinator.close();

  // Full §2.8: an AGED pool entry on exhaustion also skips — "no time to look"
  // is not unresolved ambiguity when the queue's reconcile+maintain owner is
  // going to look within one cadence and quarantines via the per-entry deadline
  // if the ambiguity is real.
  const provider2 = new UnfinalizedProvider();
  const { coordinator: pool2, outbox: outbox2 } = await coordinatorFor(provider2, {
    recoveryBudgetMs: 0, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox2, "P26", 0, Date.now() - 120_000);
  await pool2.recoverOutbox();
  assert(
    !pool2.isQuarantined(),
    "exhaustion quarantined an aged pool entry that reconcile+maintain own — every "
    + "restart after >grace downtime with a cohort in flight would freeze the settler",
  );
  pool2.close();

  // A non-pool kind has NO owner after a restart (its submit() caller died with
  // the process), so for it exhaustion past the grace keeps the quarantine.
  const provider3 = new UnfinalizedProvider();
  const { coordinator: old3, outbox: outbox3 } = await coordinatorFor(provider3, {
    recoveryBudgetMs: 0, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox3, "O26", 0, Date.now() - 120_000, "x402-settle");
  await old3.recoverOutbox();
  assert(
    old3.isQuarantined(),
    "past the grace, exhaustion on an unowned kind is unresolved ambiguity and must still quarantine",
  );
  old3.close();
});

test("27 a hung classification RPC cannot stall recovery — young entries skip at the budget", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    recoveryBudgetMs: 300, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox, "H27", 0, Date.now());
  // The classification's first RPC never answers. recoverOutbox holds the settler
  // lease, so without the budget race this hangs every submit and the operator
  // escape behind it, forever.
  provider.getTransactionReceipt = (hash) =>
    hash === "0xtxH27" ? new Promise(() => {}) : Promise.resolve(null);
  assert(
    await settlesWithin(coordinator.recoverOutbox(), 1500),
    "recovery is stalled on a hung classification RPC while holding the settler lease",
  );
  assert(!coordinator.isQuarantined(), "a young entry on an unhealthy provider is skipped, not quarantined");
  assert(
    !provider.broadcasts.includes("0xsignedH27"),
    "the provider is evidently unhealthy — the timed-out skip must not attempt the rebroadcast RPC",
  );
  coordinator.close();

  // Full §2.8: the same hung RPC on an AGED pool entry skips too — the hang is
  // the provider's problem, and the queue's reconcile retries the classification
  // on its own cadence. Quarantining here froze the settler at every restart
  // that combined >grace downtime with a slow RPC.
  const provider2 = new UnfinalizedProvider();
  const { coordinator: pool2, outbox: outbox2 } = await coordinatorFor(provider2, {
    recoveryBudgetMs: 300, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox2, "H27b", 0, Date.now() - 120_000);
  provider2.getTransactionReceipt = (hash) =>
    hash === "0xtxH27b" ? new Promise(() => {}) : Promise.resolve(null);
  assert(
    await settlesWithin(pool2.recoverOutbox(), 1500),
    "recovery is stalled on a hung classification RPC for an aged pool entry",
  );
  assert(
    !pool2.isQuarantined(),
    "a hung classification on an aged pool entry quarantined a settler whose "
    + "reconcile+maintain owner would have retried the read within one cadence",
  );
  pool2.close();
});

test("28 a pending skip has an eventual owner: recovery re-runs itself past the grace", async () => {
  // The dead-end this closes: recovery pending-skips a young entry with one
  // rebroadcast, the mempool drops it, and NOTHING else owns it — EVM reconcile
  // only classifies, applyVerdict(pending) writes nothing, and the skip never
  // quarantined, so the cancel tooling (which hangs off the quarantine record)
  // is unreachable while the gap-stuck nonce wedges the whole rail.
  //
  // A NON-pool kind, deliberately: under full §2.8 a pool entry's aged owner is
  // the queue's reconcile+maintain (test 45), and recovery never quarantines it.
  // The follow-up run is the ownership path for the kinds whose submit() caller
  // died with the process.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    timeoutMs: 250, recoveryBudgetMs: 500, dispatchGraceMs: 400,
  });
  await seedEntry(outbox, "F28", 0, Date.now(), "x402-settle");
  await coordinator.recoverOutbox();
  assert(!coordinator.isQuarantined(), "young entry is skipped, not quarantined");
  const broadcastsAfterSkip = provider.broadcasts.length;
  // The transaction never appears anywhere. Past the grace, the follow-up run
  // recovery scheduled must give the entry the full resumeEntry treatment and
  // quarantine the now-genuine ambiguity, restoring the operator escape.
  const deadline = Date.now() + 4_000;
  while (!coordinator.isQuarantined() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    coordinator.isQuarantined(),
    "the pending skip left the entry with no owner — dropped from the mempool "
    + "after a restart, it gap-sticks the nonce pipeline forever with no "
    + "quarantine and no cancel tooling reachable",
  );
  assert(
    provider.broadcasts.length > broadcastsAfterSkip,
    "the follow-up run never rebroadcast — ownership was not actually restored",
  );
  coordinator.close();
});

test("25 recovery does not lift a quarantine whose entry it skipped as pending", async () => {
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, { dispatchGraceMs: 60_000 });
  // A quarantined-but-still-young entry (possible when timeoutMs < grace): the
  // walk classifies it `pending` and skips it. Skipping is not resolving — the
  // ambiguity the operator flag records is still open, so the flag must survive.
  await seedEntry(outbox, "Q25", 0, Date.now());
  await outbox.setQuarantine(8453, "0x0000000000000000000000000000000000000001", 0);
  await coordinator.recoverOutbox();
  assert(
    coordinator.isQuarantined(),
    "recovery lifted the operator flag for an entry it did not resolve — the "
    + "ambiguity is still open but no longer visible",
  );
  assert(coordinator.quarantineDetail().nonce === 0, "the record still names the skipped entry");
  coordinator.close();
});

// 45-48: full §2.8 cohort-aware recovery + §2.9 measurement inputs.
test("45 recovery never resumeEntry-polls a pool entry: cheap transitions, no quarantine", async () => {
  // A restart after >grace downtime with a cohort in flight: three AGED pool
  // entries with mixed evidence. The old walk fed each into resumeEntry under
  // one shared budget — the zero-evidence entry burned the remainder polling
  // and quarantined a healthy settler. Now: landed finalizes the outbox entry,
  // included records the hash, zero-evidence rebroadcasts and is left to its
  // reconcile+maintain owner. Nothing quarantines and the walk is fast.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    recoveryBudgetMs: 2_000, dispatchGraceMs: 60_000,
  });
  const aged = Date.now() - 120_000;
  await seedEntry(outbox, "L45", 0, aged);
  await seedEntry(outbox, "I45", 1, aged);
  await seedEntry(outbox, "U45", 2, aged);
  // Landed: final receipt (block 3 <= finalizedHead 5). Included: canonical but
  // above the finalized head. Zero evidence for U45 — but its nonce is only
  // "unconsumed" if latest getTransactionCount covers it; latest=2 means nonces
  // 0 and 1 are consumed and 2 is not.
  provider.latest = 2;
  provider.receipts.set("0xtxL45", { status: 1, blockNumber: 3, blockHash: "block-3" });
  provider.receipts.set("0xtxI45", { status: 1, blockNumber: 10, blockHash: "block-10" });
  const started = Date.now();
  assert(
    await settlesWithin(coordinator.recoverOutbox(), 1500),
    "recovery polled an aged pool entry to completion under the shared budget",
  );
  assert(
    Date.now() - started < 1_000,
    "the walk burned its budget waiting on evidence a reconcile owner will collect",
  );
  assert(
    !coordinator.isQuarantined(),
    "recovery quarantined a healthy settler over an aged zero-evidence pool entry "
    + "that maintainEntry's per-entry deadline owns",
  );
  assert(
    outbox.byLogicalId("logical-L45").state === "finalized",
    "the landed entry's outbox state must finalize in the walk",
  );
  assert(
    outbox.byLogicalId("logical-I45").state === "included",
    "the included entry's evidence must be recorded so the pipeline is free",
  );
  assert(
    outbox.byLogicalId("logical-U45").state === "broadcasting",
    "the zero-evidence entry stays broadcasting for its owner",
  );
  assert(
    provider.broadcasts.includes("0xsignedU45"),
    "the zero-evidence entry must re-enter the post-restart mempool",
  );
  // §2.9 H11: the landed classification carries the landing block.
  const landed = await coordinator.classifyNonce({ nonce: 0, logicalId: "logical-L45" });
  assert(
    landed.verdict === "landed" && landed.blockNumber === 3,
    `the landed verdict must carry its landing block, got ${JSON.stringify(landed)}`,
  );
  coordinator.close();
});

test("46 a terminal-absent or landed pool resolution in recovery lifts its own quarantine", async () => {
  // The record appears MID-WALK — a concurrent out-of-lease poller quarantines
  // nonce 1 while recovery is classifying nonce 0. The end-of-walk stale lift is
  // scoped to the PRE-walk record (undefined here), so it cannot touch this one:
  // the resolution branch's OWN nonce-conditional clear is the only lift, and a
  // pre-walk record would mask it (the walk legitimately stale-lifts a record
  // whose entry it resolved, so the fixture would measure nothing).
  const settler = "0x0000000000000000000000000000000000000001";
  const scenario = async (tag, receiptStatus, expectedState) => {
    const provider = new UnfinalizedProvider();
    const { coordinator, outbox } = await coordinatorFor(provider, {
      recoveryBudgetMs: 2_000, dispatchGraceMs: 60_000,
    });
    const aged = Date.now() - 120_000;
    await seedEntry(outbox, `A${tag}`, 0, aged);
    await seedEntry(outbox, `R${tag}`, 1, aged);
    provider.receipts.set(`0xtxR${tag}`, {
      status: receiptStatus, blockNumber: 3, blockHash: "block-3",
    });
    // A-entry has zero evidence; classifying it calls getTransactionCount, and
    // that is the injection point for the concurrent quarantine of nonce 1.
    let injected = false;
    const originalCount = provider.getTransactionCount.bind(provider);
    provider.getTransactionCount = async (address, blockTag) => {
      if (!injected) {
        injected = true;
        await outbox.setQuarantine(8453, settler, 1);
      }
      return originalCount(address, blockTag);
    };
    await coordinator.recoverOutbox();
    assert(injected, `fixture defect: the ${tag} mid-walk quarantine was never injected`);
    assert(
      outbox.byLogicalId(`logical-R${tag}`).state === expectedState,
      `the resolved pool entry must reach ${expectedState} in the outbox, `
      + `got ${outbox.byLogicalId(`logical-R${tag}`).state}`,
    );
    assert(
      !coordinator.isQuarantined(),
      `a ${expectedState} resolution is a resolution (backgroundReconcile's precedent): `
      + "the quarantine naming its nonce must lift so the pipeline advances",
    );
    coordinator.close();
  };
  // status 0 = reverted-final = terminal-absent; status 1 = success-final = landed.
  await scenario("T46", 0, "failed");
  await scenario("L46", 1, "finalized");
});

test("47 recovery does not lift a quarantine over a pool entry it skipped as uncertain", async () => {
  // The §2.8 skip is ownership handoff, not resolution: an aged zero-evidence
  // pool entry whose nonce a quarantine records must keep the operator flag.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    recoveryBudgetMs: 2_000, dispatchGraceMs: 60_000,
  });
  await seedEntry(outbox, "S47", 0, Date.now() - 120_000);
  await outbox.setQuarantine(8453, "0x0000000000000000000000000000000000000001", 0);
  await coordinator.recoverOutbox();
  assert(
    coordinator.isQuarantined(),
    "recovery lifted the operator flag for an aged pool entry it merely skipped — "
    + "the ambiguity is still open but no longer visible",
  );
  assert(coordinator.quarantineDetail().nonce === 0, "the record still names the skipped entry");
  coordinator.close();
});

test("49 recovery's included write never downgrades a concurrently finalized entry", async () => {
  // Codex review of 78803f1: the walk snapshots its entries ONCE, then spends
  // real time in per-entry RPCs — and the queue's reconcile+maintain runs
  // concurrently on its own cadence. If maintain finalizes entry B while the
  // walk is still classifying entry A, the walk's `included` write for B (judged
  // against the stale snapshot state) would REGRESS finalized -> included,
  // resurrecting the entry into every later non-terminal walk.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider, {
    recoveryBudgetMs: 2_000, dispatchGraceMs: 60_000,
  });
  const aged = Date.now() - 120_000;
  await seedEntry(outbox, "A49", 0, aged);
  await seedEntry(outbox, "B49", 1, aged);
  provider.latest = 1;
  // B is mined-canonical above the finalized head: classifies `included`.
  provider.receipts.set("0xtxB49", { status: 1, blockNumber: 10, blockHash: "block-10" });
  // While the walk classifies A (zero evidence -> getTransactionCount), the
  // concurrent maintain finalizes B — after the walk's snapshot was taken.
  let injected = false;
  const originalCount = provider.getTransactionCount.bind(provider);
  provider.getTransactionCount = async (address, blockTag) => {
    if (!injected) {
      injected = true;
      await outbox.setState("logical-B49", "finalized", "0xtxB49");
    }
    return originalCount(address, blockTag);
  };
  await coordinator.recoverOutbox();
  assert(injected, "fixture defect: the concurrent finalize was never injected");
  assert(
    outbox.byLogicalId("logical-B49").state === "finalized",
    `the walk downgraded a finalized entry to ${outbox.byLogicalId("logical-B49").state} `
    + "from its stale snapshot — evidence regressed below what a concurrent owner already recorded",
  );
  coordinator.close();
});

test("50 ref and hash lookups are scoped to the coordinator's own chain", async () => {
  // Grok review of 78803f1: the outbox WAL is ONE shared instance across every
  // EVM network, but entriesByRef/byTransactionHash did not filter by
  // (chainId, address) the way nonterminalNoncesAscending does. A payoutRef or
  // hash recorded by the OTHER chain's coordinator must be invisible here —
  // otherwise a cross-network ref collision hands this rail a handle whose
  // transaction lives on a different chain, classified against the wrong
  // provider.
  const provider = new UnfinalizedProvider();
  const { coordinator, outbox } = await coordinatorFor(provider);
  await outbox.putVersion({
    chainId: 4663, // the other chain, same settler address, same shared WAL
    address: "0x0000000000000000000000000000000000000001",
    nonce: 0,
    kind: "pool-payout",
    ref: "ref-X50",
    logicalId: "logical-X50",
    payloadFingerprint: "fp-X50",
    version: {
      txHash: "0xtxX50", signedTx: "0xsignedX50",
      maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt: Date.now(),
    },
  });
  assert(
    coordinator.outboxEntriesByRef("ref-X50").length === 0,
    "a ref recorded by another chain's coordinator leaked into this rail's handles",
  );
  const classified = await coordinator.classifyTransactionHash("0xtxX50");
  assert(
    classified.verdict === "uncertain",
    `another chain's hash must classify uncertain here, not against this provider — got ${classified.verdict}`,
  );
  coordinator.close();
});

test("48 dispatch outcomes stamp broadcastAtMs on fresh broadcasts only", async () => {
  // §2.9 measurement input: the wave spread is computed over these stamps, so a
  // replay (whose time is not the wave's) and a refused broadcast (which never
  // reached a mempool) must not carry one.
  const provider = new UnfinalizedProvider();
  const { coordinator } = await coordinatorFor(provider, { timeoutMs: 60_000 });
  const input = dispatchInput("B48");
  const before = Date.now();
  const first = await coordinator.dispatchMany([input]);
  assert(
    first[0].status === "dispatched"
    && typeof first[0].broadcastAtMs === "number"
    && first[0].broadcastAtMs >= before,
    `a fresh first broadcast must stamp its time, got ${JSON.stringify(first[0])}`,
  );
  const replay = await coordinator.dispatchMany([input]);
  assert(
    replay[0].status === "dispatched" && replay[0].broadcastAtMs === undefined,
    `an idempotent replay must NOT stamp a wave time, got ${JSON.stringify(replay[0])}`,
  );
  const refusing = new UnfinalizedProvider();
  refusing.broadcastTransaction = async () => { throw new Error("insufficient funds for gas"); };
  const { coordinator: refused } = await coordinatorFor(refusing, { timeoutMs: 60_000 });
  const failedOutcome = await refused.dispatchMany([dispatchInput("B48f")]);
  assert(
    failedOutcome[0].status === "dispatched" && failedOutcome[0].broadcastAtMs === undefined,
    `a refused first broadcast never reached a mempool and must not stamp, got ${JSON.stringify(failedOutcome[0])}`,
  );
  coordinator.close();
  refused.close();
});

for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
await rm(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
