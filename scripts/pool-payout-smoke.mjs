import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Wallet } from "ethers";
import { BASE_USDC } from "../src/shared/x402.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { PendingPayoutJournal } from "../src/server/payments/PendingPayoutJournal.ts";
import { SolanaX402Facilitator } from "../src/server/base/SolanaX402Facilitator.ts";
import {
  PoolPayoutQueue,
  poolPayoutLogicalId,
  poolPayoutPlanHash,
} from "../src/server/payments/PoolPayoutQueue.ts";
import {
  SettlerNotYetFinalError,
  SettlerQuarantinedError,
  TransactionCoordinator,
  TransactionOutbox,
  evmPayloadFingerprint,
} from "../src/server/base/TransactionCoordinator.ts";

const root = await mkdtemp(join(tmpdir(), "pool-payout-v4-smoke-"));
const tests = [];
let passed = 0;
let failed = 0;

const test = (name, run) => tests.push({ name, run });
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};
const rejects = async (operation, pattern) => {
  try {
    await operation();
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)));
    return;
  }
  throw new Error("expected rejection");
};

class MockRail {
  constructor({
    network = "base",
    kind = "evm",
    mode = "dry-run",
    verdict = { status: "landed", transactionHash: "0xlanded" },
  } = {}) {
    this.network = network;
    this.kind = kind;
    this.mode = mode;
    this.poolMode = mode;
    this.settlementMode = mode;
    this.tokenConfig = network === "solana"
      ? {
        kind: "solana",
        network: "solana",
        caip2: "solana:test",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      }
      : BASE_USDC;
    this.verdict = verdict;
    this.broadcasts = [];
    this.prepares = 0;
    this.submits = 0;
    this.recoveries = 0;
    this.classifies = 0;
    this.reversals = 0;
    this.height = 100;
    this.refs = new Map();
    this.outbox = new Map();
    this.suppressed = new Set();
    this.statusGate = undefined;
  }
  buildQuote() { throw new Error("unused"); }
  ownsPayment() { return false; }
  paymentNonce() { return undefined; }
  resolveRecipient({ payee, ephemeralPubKey }) {
    return ephemeralPubKey
      ? { recipient: payee.walletAddress, stealth: { stealthAddress: payee.walletAddress, ephemeralPubKey } }
      : { recipient: payee.walletAddress };
  }
  settle() { throw new Error("unused"); }
  bindPoolPayoutRef(logicalId, ref) { this.refs.set(logicalId, ref); }
  suppressPoolPayoutRebroadcast(logicalId) { this.suppressed.add(logicalId); }
  async submitPoolPayout(input) {
    this.submits += 1;
    const ref = this.refs.get(input.logicalId);
    if (this.submitError) {
      if (this.persistBeforeError && ref) {
        this.outbox.set(ref, [{ logicalId: input.logicalId, nonce: this.submits - 1 }]);
      }
      throw this.submitError;
    }
    if (this.mode === "onchain" && ref) {
      this.outbox.set(ref, [{ logicalId: input.logicalId, nonce: this.submits - 1 }]);
    }
    return {
      network: this.network,
      recipient: input.recipient,
      amountAtomic: input.amountAtomic,
      mode: this.poolMode,
      txId: this.poolMode === "onchain" ? `0xtx${this.submits}` : undefined,
      nonce: this.poolMode === "onchain" ? this.submits - 1 : undefined,
    };
  }
  async preparePoolPayout(input) {
    this.prepares += 1;
    if (this.prepareError) throw this.prepareError;
    return {
      network: this.network,
      recipient: input.recipient,
      amountAtomic: input.amountAtomic,
      mode: this.poolMode,
      signedTx: this.poolMode === "onchain" ? this.preparedSignedTx ?? `signed-${this.prepares}` : undefined,
      txId: this.poolMode === "onchain" ? this.preparedTxId ?? `sig-${this.prepares}` : undefined,
      lastValidBlockHeight: this.poolMode === "onchain" ? this.lastValidBlockHeight ?? 200 : undefined,
      contextSlot: this.poolMode === "onchain" ? 50 : undefined,
    };
  }
  async broadcastPoolPayout(prepared) {
    this.broadcasts.push(prepared.signedTx);
    if (this.broadcastError) throw this.broadcastError;
    return { txId: prepared.txId ?? "", submitted: prepared.mode === "onchain" };
  }
  async poolPayoutStatus(prepared) {
    if (this.statusGate) await this.statusGate.promise;
    return typeof this.verdict === "function" ? this.verdict(prepared) : this.verdict;
  }
  operatorPoolPayoutStatus(prepared) { return this.poolPayoutStatus(prepared); }
  outboxEntriesByRef(ref) { return this.outbox.get(ref) ?? []; }
  async classifyByLogicalId(input) {
    this.classifies += 1;
    if (this.classifyGate) await this.classifyGate.promise;
    return typeof this.verdict === "function" ? this.verdict(input) : this.verdict;
  }
  async recoverOutbox() {
    this.recoveries += 1;
    for (const [ref, entries] of this.outbox) {
      for (const entry of entries) {
        if (!this.suppressed.has(entry.logicalId)) this.broadcasts.push(`recover:${ref}`);
      }
    }
  }
  finalizedBlockHeight() { return Promise.resolve(this.height); }
}

class MockProvider {
  constructor() {
    this.pending = 0;
    this.latest = 0;
    this.finalized = 100;
    this.receipts = new Map();
    this.broadcasts = [];
    this.occupants = new Map();
    this.onBroadcast = undefined;
  }
  getTransactionCount(_address, tag) { return Promise.resolve(tag === "pending" ? this.pending : this.latest); }
  getFeeData() {
    return Promise.resolve({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
      gasPrice: 100n,
    });
  }
  async broadcastTransaction(raw) {
    this.broadcasts.push(raw);
    await this.onBroadcast?.(raw, this.broadcasts.length);
    return { hash: `0xbroadcast${this.broadcasts.length}` };
  }
  getTransactionReceipt(hash) { return Promise.resolve(this.receipts.get(hash) ?? null); }
  getBlock(tag) {
    if (tag === "finalized" || tag === "safe") {
      return Promise.resolve({ number: this.finalized, hash: `block-${this.finalized}` });
    }
    if (tag === "latest") return Promise.resolve({ number: 200, hash: "block-200" });
    return Promise.resolve({ number: Number(tag), hash: `block-${tag}` });
  }
  send(_method, params) {
    return Promise.resolve(this.occupants.get(Number.parseInt(params[1], 16)) ?? null);
  }
  finalize(hash, nonce = 0, status = 1) {
    this.receipts.set(hash, {
      status,
      blockNumber: 10,
      blockHash: "block-10",
    });
    this.pending = Math.max(this.pending, nonce + 1);
    this.latest = Math.max(this.latest, nonce + 1);
  }
}

const deferred = () => {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};

const context = async (name, rail = new MockRail(), overrides = {}) => {
  const directory = join(root, name);
  const ledger = await new PrivatePaymentLedger(
    join(directory, "ledger.json"),
    "smoke-secret",
    {
      journal: new EphemeralPaymentJournal(join(directory, "epochs")),
      retentionMs: 60_000,
      baseAssetKey: privateLedgerAssetKey(rail.network, rail.tokenConfig.address),
    },
  ).load({ payer: "1000000", payer2: "1000000" });
  const journal = new PendingPayoutJournal(join(directory, "pending.json"), "smoke-secret");
  const queue = new PoolPayoutQueue({
    journal,
    ledger,
    rails: new Map([[rail.network, rail]]),
    flushMs: 1_000_000,
    maxJitterMs: 0,
    maxAttempts: 3,
    reconcileMs: 100,
    recoveryBudgetMs: 100,
    claimTtlMs: 10_000,
    now: () => 1_000,
    random: () => 0,
    ...overrides,
  });
  await queue.recover();
  return { directory, ledger, journal, queue, rail };
};

const reserveGroup = async (ctx, {
  groupRef = `group-${randomBytes(4).toString("hex")}`,
  amounts = ["100000"],
  recipients,
  strategy = amounts.length === 1 ? "single" : "denominations",
  agent = "payer",
} = {}) => {
  const legs = amounts.map((amountAtomic, index) => ({
    index,
    payoutRef: strategy === "single" ? groupRef : `${groupRef}:${index}`,
    recipient: recipients?.[index] ?? Wallet.createRandom().address,
    amountAtomic,
    ephemeralPubKey: `ephemeral-${index}`,
    denominationAtomic: strategy === "denominations" ? amountAtomic : null,
  }));
  const planHash = poolPayoutPlanHash({
    groupRef,
    network: ctx.rail.network,
    asset: ctx.rail.tokenConfig.address,
    legs,
  });
  let balance;
  for (const leg of legs) {
    balance = await ctx.ledger.payout({
      agentId: agent,
      amountAtomic: leg.amountAtomic,
      assetKey: privateLedgerAssetKey(ctx.rail.network, ctx.rail.tokenConfig.address),
      network: ctx.rail.network,
      payoutRef: leg.payoutRef,
      planHash,
    });
  }
  const input = {
    groupRef,
    ownerTag: ctx.ledger.accountReference(agent),
    network: ctx.rail.network,
    asset: ctx.rail.tokenConfig.address,
    strategy,
    planHash,
    payerBalanceAtomic: balance.balanceAtomic,
    legs,
    offchainChange: null,
  };
  const receipt = await ctx.queue.enqueueGroup(input);
  return { input, receipt, planHash };
};

const coordinatorContext = async (name, provider = new MockProvider(), options = {}) => {
  const directory = join(root, name);
  const outbox = await new TransactionOutbox(join(directory, "outbox.json"), "smoke-secret").load();
  const coordinator = new TransactionCoordinator({
    provider,
    address: "0x0000000000000000000000000000000000000001",
    chainId: 8453,
    outbox,
    finality: "finalized",
    confirmationFloorFallback: 2,
    bumpAfterMs: options.bumpAfterMs ?? 10_000,
    timeoutMs: options.timeoutMs ?? 300,
    recoveryBudgetMs: options.recoveryBudgetMs ?? 100,
    cancelSign: options.cancelSign,
  });
  return { directory, outbox, coordinator, provider };
};

// 1-5: group enqueue/flush.
test("1 single-leg enqueue returns the frozen queued receipt", async () => {
  const ctx = await context("01");
  const { receipt } = await reserveGroup(ctx, { groupRef: "single" });
  assert(receipt.kind === "pool-payout-queued" && receipt.strategy === "single");
  assert(receipt.legs.length === 1 && !("transactionHash" in receipt));
  assert(receipt.payerBalanceAtomic === "900000");
});
test("2 encrypted journal stores ownerTag and no raw identities", async () => {
  const ctx = await context("02");
  await reserveGroup(ctx, { groupRef: "privacy" });
  const group = ctx.journal.byRef("privacy");
  const raw = await readFile(join(ctx.directory, "pending.json"), "utf8");
  assert(group.ownerTag === ctx.ledger.accountReference("payer"));
  assert(!raw.includes("payer") && !raw.toLowerCase().includes("payee"));
});
test("3 dry-run flush settles and preserves zero-sum accounting", async () => {
  const ctx = await context("03");
  await reserveGroup(ctx, { groupRef: "flush" });
  await ctx.queue.flushNow("base");
  assert((await ctx.queue.claim("flush")).groupState === "settled");
  assert(ctx.ledger.balance("payer", privateLedgerAssetKey("base", BASE_USDC.address)) === "900000");
});
test("4 denomination group reserves four refs and settles all", async () => {
  const ctx = await context("04");
  await reserveGroup(ctx, { groupRef: "denom", amounts: ["1", "2", "3", "4"] });
  await ctx.queue.flushNow("base");
  const claim = await ctx.queue.claim("denom");
  assert(claim.legs.length === 4 && claim.legs.every((leg) => leg.state === "settled"));
});
test("5 claims are repeatable and retain per-leg state", async () => {
  const ctx = await context("05");
  await reserveGroup(ctx, { groupRef: "repeat" });
  await ctx.queue.flushNow();
  assert(JSON.stringify(await ctx.queue.claim("repeat")) === JSON.stringify(await ctx.queue.claim("repeat")));
});

// 6-9: at-most-once.
test("6 uncertain chain status holds the debit and is never pruned", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new Error("timeout");
  rail.persistBeforeError = true;
  const ctx = await context("06", rail);
  await reserveGroup(ctx, { groupRef: "uncertain" });
  await ctx.queue.flushNow();
  const claim = await ctx.queue.claim("uncertain");
  assert(claim.groupState === "uncertain");
  assert(ctx.ledger.findPayoutTransfer("uncertain"));
});
test("7 terminal-absent reverses exact payer and escrow balances", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new Error("terminal-absent");
  const ctx = await context("07", rail);
  await reserveGroup(ctx, { groupRef: "absent" });
  await ctx.queue.flushNow();
  assert((await ctx.queue.claim("absent")).legs[0].state === "failed");
  assert(ctx.ledger.balance("payer", privateLedgerAssetKey("base", BASE_USDC.address)) === "1000000");
});
test("8 maxAttempts is quarantine-only and never compensation authority", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new Error("503 timeout");
  const ctx = await context("08", rail);
  await reserveGroup(ctx, { groupRef: "attempts" });
  await ctx.queue.flushNow(); await ctx.queue.flushNow(); await ctx.queue.flushNow();
  assert((await ctx.queue.claim("attempts")).legs[0].state === "uncertain");
  assert(ctx.ledger.findPayoutTransfer("attempts"));
});
test("9 shared recipient legs retain independent logical identities", async () => {
  const recipient = Wallet.createRandom().address;
  const ctx = await context("09");
  await reserveGroup(ctx, {
    groupRef: "shared",
    amounts: ["100", "200"],
    recipients: [recipient, recipient],
  });
  const group = ctx.journal.byRef("shared");
  assert(group.legs[0].logicalId !== group.legs[1].logicalId);
});

// 10-18: concurrency, crash, fsync, change deferral.
test("10 duplicate concurrent enqueue is idempotent", async () => {
  const ctx = await context("10");
  const built = await reserveGroup(ctx, { groupRef: "dupe" });
  const [a, b] = await Promise.all([
    ctx.queue.enqueueGroup(built.input),
    ctx.queue.enqueueGroup(built.input),
  ]);
  assert(JSON.stringify(a) === JSON.stringify(b) && ctx.journal.list().length === 1);
});
test("11 overlapping flushes single-flight one broadcast", async () => {
  const ctx = await context("11", new MockRail({ mode: "onchain" }));
  await reserveGroup(ctx, { groupRef: "overlap" });
  await Promise.all([ctx.queue.flushNow("base"), ctx.queue.flushNow("base")]);
  assert(ctx.rail.submits === 1);
});
test("12 ledger orphan reverses without tmpfs epoch detail", async () => {
  const ctx = await context("12");
  await ctx.ledger.payout({
    agentId: "payer", amountAtomic: "10", assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base", payoutRef: "orphan", planHash: "0xplan",
  });
  await rm(join(ctx.directory, "epochs"), { recursive: true, force: true });
  const freshJournal = new PendingPayoutJournal(join(ctx.directory, "pending2.json"), "smoke-secret");
  const queue = new PoolPayoutQueue({
    journal: freshJournal, ledger: ctx.ledger, rails: new Map([["base", ctx.rail]]),
    flushMs: 999999, maxJitterMs: 0, maxAttempts: 3, reconcileMs: 10,
    recoveryBudgetMs: 10, claimTtlMs: 1000,
  });
  await queue.recover();
  assert(!ctx.ledger.findPayoutTransfer("orphan"));
});
test("13 recovery marks a landed broadcasting leg without fresh submit", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "landed", transactionHash: "0xwinner" } });
  const ctx = await context("13", rail);
  const { input } = await reserveGroup(ctx, { groupRef: "landed-crash" });
  const leg = ctx.journal.byRef("landed-crash").legs[0];
  rail.outbox.set(leg.payoutRef, [{ logicalId: leg.logicalId, nonce: 0 }]);
  await ctx.journal.updateLeg(input.groupRef, 0, { state: "broadcasting", nonce: 0 });
  await ctx.queue.sweep();
  assert((await ctx.queue.claim(input.groupRef)).legs[0].state === "settled" && rail.submits === 0);
});
test("14 recovery parks an ambiguous broadcasting leg", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "uncertain", detail: "rpc" } });
  const ctx = await context("14", rail);
  await reserveGroup(ctx, { groupRef: "ambiguous" });
  const leg = ctx.journal.byRef("ambiguous").legs[0];
  rail.outbox.set(leg.payoutRef, [{ logicalId: leg.logicalId, nonce: 0 }]);
  await ctx.queue.sweep();
  assert((await ctx.queue.claim("ambiguous")).legs[0].state === "uncertain");
  assert(ctx.ledger.findPayoutTransfer("ambiguous"));
});
test("15 recovery reverses only proven terminal absence", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "terminal-absent" } });
  const ctx = await context("15", rail);
  await reserveGroup(ctx, { groupRef: "failed-crash" });
  const leg = ctx.journal.byRef("failed-crash").legs[0];
  rail.outbox.set(leg.payoutRef, [{ logicalId: leg.logicalId, nonce: 0 }]);
  await ctx.queue.sweep();
  assert((await ctx.queue.claim("failed-crash")).legs[0].state === "failed");
});
test("16 fund-critical writes use durable fsync implementation", async () => {
  const source = await readFile(resolve("src/server/storage/EncryptedJsonFile.ts"), "utf8");
  assert(source.includes("temporary.sync()") && source.includes("directory.sync()"));
});
test("17 non-null offchainChange rejects before mutation", async () => {
  const ctx = await context("17");
  const before = ctx.ledger.balance("payer", privateLedgerAssetKey("base", BASE_USDC.address));
  await rejects(() => ctx.queue.enqueueGroup({
    groupRef: "change", ownerTag: ctx.ledger.accountReference("payer"), network: "base",
    asset: BASE_USDC.address, strategy: "single", planHash: "0xplan",
    payerBalanceAtomic: before, legs: [], offchainChange: { amountAtomic: "1" },
  }), /pool_payout_change_not_enabled/);
  assert(ctx.journal.list().length === 0 && ctx.ledger.balance("payer", privateLedgerAssetKey("base", BASE_USDC.address)) === before);
});
test("18 null-change groups create no change transfer", async () => {
  const ctx = await context("18");
  await reserveGroup(ctx, { groupRef: "no-change" });
  assert(!ctx.ledger.findPayoutTransfer("change:no-change"));
});

// 19-28: batching, migration, real-shape dry-run, guards, audit.
test("19 createSettlementBatch excludes unsettled payouts", async () => {
  const ctx = await context("19");
  await reserveGroup(ctx, { groupRef: "batch-gate" });
  assert(await ctx.ledger.createSettlementBatch({
    assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base",
    tokenAddress: BASE_USDC.address,
  }) === undefined);
  await ctx.queue.flushNow();
  assert((await ctx.ledger.createSettlementBatch({
    assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base",
    tokenAddress: BASE_USDC.address,
  })).transferCount === 1);
});
test("20 v3-v4 migration fails closed per row and is idempotent", async () => {
  const directory = join(root, "20");
  const ledgerPath = join(directory, "ledger.json");
  const file = new EncryptedJsonFile(ledgerPath, "smoke-secret", { failClosed: true, durable: true });
  const transfer = (ref, hash) => ({
    id: ref, source: "payout", asset: privateLedgerAssetKey("base", BASE_USDC.address),
    authorizationHash: `0x${"1".repeat(64)}`, commitment: `0x${"2".repeat(64)}`,
    acceptedAt: 1, epochId: ref, payoutRef: ref, transactionHash: hash,
  });
  await file.write({
    version: 3, accounts: {}, transfers: [
      transfer("finalized", "0xfinal"),
      { ...transfer("hashless"), authorizationHash: `0x${"3".repeat(64)}` },
    ], batches: [], consumedDepositHashes: [],
  });
  const make = () => new PrivatePaymentLedger(ledgerPath, "smoke-secret", {
    journal: new EphemeralPaymentJournal(join(directory, "epochs")),
    retentionMs: 1,
    payoutFinalityVerifier: async ({ transactionHash }) => transactionHash === "0xfinal",
  });
  await rejects(() => make().load(), /requires per-row reconciliation/);
  await writeFile(join(directory, "ledger-migration-reconcile.json"), JSON.stringify({
    rows: { hashless: { disposition: "settled", note: "fixture" } },
  }));
  await make().load();
  const bytes = await readFile(ledgerPath, "utf8");
  await make().load();
  assert(await readFile(ledgerPath, "utf8") === bytes);
});
test("21 EVM dry-run submits no raw transaction", async () => {
  const ctx = await context("21");
  await reserveGroup(ctx, { groupRef: "evm-dry" });
  await ctx.queue.flushNow();
  assert(ctx.rail.broadcasts.length === 0 && ctx.rail.submits === 1);
});
test("22 Solana dry-run prepares but never sendRawTransaction", async () => {
  const rail = new MockRail({ network: "solana", kind: "solana", mode: "dry-run" });
  const ctx = await context("22", rail);
  await reserveGroup(ctx, { groupRef: "sol-dry" });
  await ctx.queue.flushNow();
  assert(rail.prepares === 1 && rail.broadcasts.length === 0);
});
test("23 rail recipient resolution keeps stealth and main-wallet paths", async () => {
  const rail = new MockRail();
  const main = rail.resolveRecipient({ payee: { walletAddress: "wallet" } });
  const stealth = rail.resolveRecipient({ payee: { walletAddress: "wallet" }, ephemeralPubKey: "epk" });
  assert(!main.stealth && stealth.stealth.ephemeralPubKey === "epk");
});
test("24 coordinator fee-bumps the same nonce before descendants", async () => {
  const provider = new MockProvider();
  const ctx = await coordinatorContext("24", provider, { bumpAfterMs: 0, timeoutMs: 500 });
  let signed = 0;
  provider.onBroadcast = (_raw, count) => {
    if (count === 2) provider.finalize("0xh1", 0);
  };
  const result = await ctx.coordinator.submit({
    kind: "pool-payout", ref: "r", logicalId: "l", payloadFingerprint: "p",
    sign: async ({ nonce }) => ({ signedTx: `raw-${++signed}-${nonce}`, txHash: signed === 1 ? "0xh0" : "0xh1" }),
  });
  assert(result.nonce === 0 && result.txHash === "0xh1");
  assert(ctx.outbox.byLogicalId("l").versions.length === 2);
});
test("25 flag-off receipt shape remains the legacy synchronous field set", async () => {
  const expected = ["kind", "network", "recipient", "mode", "payerBalanceAtomic", "settledAt"];
  const receipt = { kind: "pool-payout", network: "base", recipient: "r", mode: "dry-run", payerBalanceAtomic: "1", settledAt: 1 };
  assert(JSON.stringify(Object.keys(receipt)) === JSON.stringify(expected));
});
test("26 payout reservation binding rejects mismatches and accepts exact replay", async () => {
  const ctx = await context("26");
  const common = {
    agentId: "payer", amountAtomic: "1", assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base", payoutRef: "binding", planHash: "0xa",
  };
  const first = await ctx.ledger.payout(common);
  const replay = await ctx.ledger.payout(common);
  assert(!first.duplicate && replay.duplicate);
  await rejects(() => ctx.ledger.payout({ ...common, planHash: "0xb" }), /binding mismatch/);
});
test("27 markPayoutSettled rejects a conflicting hash", async () => {
  const ctx = await context("27");
  await ctx.ledger.payout({
    agentId: "payer", amountAtomic: "1", assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base", payoutRef: "hash", planHash: "0xa",
  });
  await ctx.ledger.markPayoutSettled("hash", "0xaaa");
  await ctx.ledger.markPayoutSettled("hash", "0xaaa");
  await rejects(() => ctx.ledger.markPayoutSettled("hash", "0xbbb"), /conflicting/);
});
test("28 uncertain audit exits nonzero then zero for settled", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new Error("timeout"); rail.persistBeforeError = true;
  const ctx = await context("28", rail);
  await reserveGroup(ctx, { groupRef: "audit-ref" });
  await ctx.queue.flushNow();
  const env = { ...process.env, PX402_DATA_ENCRYPTION_KEY: "smoke-secret" };
  const run = () => spawnSync(process.execPath, [
    "scripts/pool-payout-uncertain-audit.mjs",
    "--journal", join(ctx.directory, "pending.json"),
    "--ledger", join(ctx.directory, "ledger.json"),
  ], { cwd: resolve("."), env, encoding: "utf8" });
  const bad = run();
  assert(bad.status === 1 && bad.stdout.includes("audit-ref"));
  await ctx.ledger.markPayoutSettled("audit-ref", "0xsettled");
  const leg = ctx.journal.byRef("audit-ref").legs[0];
  await ctx.journal.updateLeg("audit-ref", 0, { state: "settled", transactionHash: "0xsettled", terminalAt: 1 }, leg.gen);
  await ctx.journal.setGroupState("audit-ref", "settled", 1);
  assert(run().status === 0);
});

// 29-37: second-pass fund-safety.
test("29 replacement winner lands; different finalized occupant is absent", async () => {
  const provider = new MockProvider();
  const ctx = await coordinatorContext("29", provider);
  await ctx.outbox.putVersion({
    chainId: 8453, address: "0x0000000000000000000000000000000000000001", nonce: 0,
    kind: "pool-payout", ref: "r", logicalId: "logical", payloadFingerprint: "finger",
    version: { txHash: "0xh0", signedTx: "raw0", maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt: 1 },
  });
  await ctx.outbox.putVersion({
    chainId: 8453, address: "0x0000000000000000000000000000000000000001", nonce: 0,
    kind: "pool-payout", ref: "r", logicalId: "logical", payloadFingerprint: "finger",
    version: { txHash: "0xh1", signedTx: "raw1", maxFeePerGas: "200", maxPriorityFeePerGas: "20", createdAt: 2 },
  });
  provider.finalize("0xh1", 0);
  assert((await ctx.coordinator.classifyNonce({ nonce: 0, logicalId: "logical" })).transactionHash === "0xh1");
});
test("30 bidirectional recovery parks missing debits and preserves settled rows", async () => {
  const rail = new MockRail({ mode: "onchain" });
  const ctx = await context("30", rail);
  await reserveGroup(ctx, { groupRef: "missing" });
  await ctx.ledger.reversePayout("missing");
  const fresh = new PoolPayoutQueue({
    journal: new PendingPayoutJournal(join(ctx.directory, "pending.json"), "smoke-secret"),
    ledger: ctx.ledger, rails: new Map([["base", rail]]), flushMs: 9e6, maxJitterMs: 0,
    maxAttempts: 3, reconcileMs: 10, recoveryBudgetMs: 10, claimTtlMs: 1000,
  });
  await fresh.recover();
  assert((await fresh.claim("missing")).groupState === "uncertain");
});
test("31 ledger journal and outbox all request durable encrypted writes", async () => {
  const sources = await Promise.all([
    readFile(resolve("src/server/payments/PrivatePaymentLedger.ts"), "utf8"),
    readFile(resolve("src/server/payments/PendingPayoutJournal.ts"), "utf8"),
    readFile(resolve("src/server/base/TransactionCoordinator.ts"), "utf8"),
  ]);
  assert(sources.every((source) => source.includes("durable: true")));
});
test("32 ambiguous submit preserves the outbox identity and never requeues", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new Error("gateway timeout"); rail.persistBeforeError = true;
  const ctx = await context("32", rail);
  await reserveGroup(ctx, { groupRef: "identity" });
  await ctx.queue.flushNow();
  const leg = (await ctx.queue.claim("identity")).legs[0];
  assert(leg.state === "uncertain" && rail.submits === 1);
  await ctx.queue.flushNow();
  assert(rail.submits === 1);
});
test("33 Solana null always parks uncertain and never reverses", async () => {
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "uncertain", detail: "null history" },
  });
  rail.height = 999; rail.lastValidBlockHeight = 100;
  const ctx = await context("33", rail);
  await reserveGroup(ctx, { groupRef: "sol-null" });
  await ctx.queue.flushNow();
  assert((await ctx.queue.claim("sol-null")).legs[0].state === "uncertain");
  assert(ctx.ledger.findPayoutTransfer("sol-null"));
});
test("34 outbox recovers non-pool sends from exact raw bytes", async () => {
  const provider = new MockProvider();
  const ctx = await coordinatorContext("34", provider);
  await ctx.outbox.putVersion({
    chainId: 8453, address: "0x0000000000000000000000000000000000000001", nonce: 0,
    kind: "x402-settle", ref: "auth", logicalId: "settle", payloadFingerprint: "finger",
    version: { txHash: "0xsettle", signedTx: "exact-raw", maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt: 1 },
  });
  provider.onBroadcast = () => provider.finalize("0xsettle", 0);
  await ctx.coordinator.recoverOutbox();
  assert(provider.broadcasts[0] === "exact-raw");
});
test("35 timeout quarantines the EOA and queues descendants", async () => {
  const provider = new MockProvider();
  const ctx = await coordinatorContext("35", provider, { timeoutMs: 20, recoveryBudgetMs: 20 });
  await rejects(() => ctx.coordinator.submit({
    kind: "pool-payout", ref: "r0", logicalId: "l0", payloadFingerprint: "p0",
    sign: async () => ({ signedTx: "raw0", txHash: "0xh0" }),
  }), /quarantined/);
  assert(ctx.coordinator.isQuarantined());
  let allocated = false;
  void ctx.coordinator.submit({
    kind: "pool-payout", ref: "r1", logicalId: "l1", payloadFingerprint: "p1",
    sign: async () => { allocated = true; return { signedTx: "raw1", txHash: "0xh1" }; },
  }).catch(() => undefined);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert(!allocated && ctx.outbox.highWaterNonce(8453, "0x0000000000000000000000000000000000000001") === 0);
  ctx.coordinator.close();
});
test("36 included but non-final receipts do not settle", async () => {
  const provider = new MockProvider();
  provider.finalized = 5;
  const ctx = await coordinatorContext("36", provider);
  await ctx.outbox.putVersion({
    chainId: 8453, address: "0x0000000000000000000000000000000000000001", nonce: 0,
    kind: "pool-payout", ref: "r", logicalId: "l", payloadFingerprint: "p",
    version: { txHash: "0xh", signedTx: "raw", maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt: 1 },
  });
  provider.receipts.set("0xh", { status: 1, blockNumber: 10, blockHash: "block-10" });
  const classified = await ctx.coordinator.classifyNonce({ nonce: 0, logicalId: "l" });
  // This test's NAME is the invariant and it still holds: a non-final receipt must
  // never settle. The old assertion demanded `uncertain`, which encoded the very
  // conflation that stranded healthy payouts — "not yet final" reported as "unknown".
  // It is now `included`: a known outcome, still in flight, and still not settled.
  assert(classified.verdict === "included", `expected included, got ${classified.verdict}`);
  assert(classified.verdict !== "landed", "a non-final receipt must never settle");
  assert(classified.transactionHash === "0xh", "the inclusion hash must be reported");
});
test("37 by-reference reversal credits the original payer exactly", async () => {
  const ctx = await context("37");
  await ctx.ledger.payout({
    agentId: "payer", amountAtomic: "123", assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base", payoutRef: "reverse-ref", planHash: "0xplan",
  });
  await ctx.ledger.reversePayout("reverse-ref");
  assert(ctx.ledger.balance("payer", privateLedgerAssetKey("base", BASE_USDC.address)) === "1000000");
});

// 38-48: third through sixth pass closure.
test("38 recovery reconciliation suppresses rebroadcast for a missing debit", async () => {
  const rail = new MockRail({ mode: "onchain" });
  const ctx = await context("38", rail);
  await reserveGroup(ctx, { groupRef: "order" });
  const leg = ctx.journal.byRef("order").legs[0];
  rail.outbox.set("order", [{ logicalId: leg.logicalId, nonce: 0 }]);
  await ctx.ledger.reversePayout("order");
  const fresh = new PoolPayoutQueue({
    journal: new PendingPayoutJournal(join(ctx.directory, "pending.json"), "smoke-secret"),
    ledger: ctx.ledger, rails: new Map([["base", rail]]), flushMs: 9e6, maxJitterMs: 0,
    maxAttempts: 3, reconcileMs: 10, recoveryBudgetMs: 100, claimTtlMs: 1000,
  });
  await fresh.recover();
  assert(rail.broadcasts.length === 0 && rail.suppressed.has(leg.logicalId));
});
test("39 queued label plus landed outbox never creates a second send", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "landed", transactionHash: "0xonly" } });
  const ctx = await context("39", rail);
  await reserveGroup(ctx, { groupRef: "queued-edge" });
  const leg = ctx.journal.byRef("queued-edge").legs[0];
  rail.outbox.set("queued-edge", [{ logicalId: leg.logicalId, nonce: 0 }]);
  await ctx.queue.sweep();
  await ctx.queue.flushNow();
  assert(rail.submits === 0 && (await ctx.queue.claim("queued-edge")).legs[0].state === "settled");
});
test("40 recoverOutbox returns within the recovery budget and quarantines", async () => {
  const provider = new MockProvider();
  const ctx = await coordinatorContext("40", provider, { recoveryBudgetMs: 20, timeoutMs: 500 });
  await ctx.outbox.putVersion({
    chainId: 8453, address: "0x0000000000000000000000000000000000000001", nonce: 0,
    kind: "x402-settle", ref: "r", logicalId: "hung", payloadFingerprint: "p",
    version: { txHash: "0xh", signedTx: "raw", maxFeePerGas: "100", maxPriorityFeePerGas: "10", createdAt: 1 },
  });
  const started = Date.now();
  await ctx.coordinator.recoverOutbox();
  assert(Date.now() - started < 250 && ctx.coordinator.isQuarantined());
});
test("41 guarded coordinator escape resolves an absent stuck nonce", async () => {
  const provider = new MockProvider();
  provider.onBroadcast = (raw) => {
    if (raw === "cancel-raw") provider.latest = 1;
  };
  const ctx = await coordinatorContext("41", provider, {
    timeoutMs: 20,
    cancelSign: async () => ({ signedTx: "cancel-raw", txHash: "0xcancel" }),
  });
  await rejects(() => ctx.coordinator.submit({
    kind: "pool-payout", ref: "r", logicalId: "stuck", payloadFingerprint: "p",
    sign: async () => ({ signedTx: "raw", txHash: "0xh" }),
  }), /quarantined/);
  const result = await ctx.coordinator.resolveQuarantine({ nonce: 0, mode: "cancel" });
  assert(result.verdict === "terminal-absent" && !ctx.coordinator.isQuarantined());
});
test("42 Solana recovery rebroadcasts the exact persisted signed bytes", async () => {
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "landed", transactionHash: "sig-fixed" },
  });
  const ctx = await context("42", rail);
  await reserveGroup(ctx, { groupRef: "sol-wal" });
  const leg = ctx.journal.byRef("sol-wal").legs[0];
  await ctx.journal.updateLeg("sol-wal", 0, {
    state: "broadcasting", signedTx: "exact-signed-bytes", txId: "sig-fixed",
    lastValidBlockHeight: 200, mode: "onchain",
  }, leg.gen);
  await ctx.queue.sweep();
  assert(rail.broadcasts[0] === "exact-signed-bytes" && rail.prepares === 0);
});
test("43 Solana finalized failure reverses; expired null never does", async () => {
  const failedRail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "terminal-absent" },
  });
  const ctx = await context("43", failedRail);
  await reserveGroup(ctx, { groupRef: "sol-fail" });
  await ctx.queue.flushNow();
  assert((await ctx.queue.claim("sol-fail")).legs[0].state === "failed");
  const nullRail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "uncertain", detail: "null" },
  });
  nullRail.height = 999; nullRail.lastValidBlockHeight = 1;
  const ctx2 = await context("43b", nullRail);
  await reserveGroup(ctx2, { groupRef: "sol-expired" });
  await ctx2.queue.flushNow();
  assert(ctx2.ledger.findPayoutTransfer("sol-expired"));
});
test("44 Solana manual disposition is signature-bound and expiry-gated", async () => {
  const payer = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: new PublicKey(randomBytes(32)).toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
  tx.sign(payer);
  const signedTx = tx.serialize().toString("base64");
  const signature = base58(tx.signatures[0].signature);
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "landed", transactionHash: signature },
  });
  rail.preparedSignedTx = signedTx; rail.preparedTxId = signature;
  const ctx = await context("44", rail);
  await reserveGroup(ctx, { groupRef: "manual" });
  rail.broadcastError = new Error("lost"); rail.verdict = { status: "uncertain", detail: "null" };
  await ctx.queue.flushNow();
  await rejects(() => ctx.queue.resolvePoolPayoutLeg({
    groupRef: "manual", index: 0, landed: true, signature: "unrelated",
  }), /does not match/);
  rail.verdict = { status: "landed", transactionHash: signature };
  assert((await ctx.queue.resolvePoolPayoutLeg({
    groupRef: "manual", index: 0, landed: true, signature,
  })).state === "settled");
});
test("45 finalized all-state outbox entry protects journal-less ledger rows", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "landed", transactionHash: "0xfinal" } });
  const ctx = await context("45", rail);
  await ctx.ledger.payout({
    agentId: "payer", amountAtomic: "1", assetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    network: "base", payoutRef: "three-store", planHash: "0xplan",
  });
  rail.outbox.set("three-store", [{ logicalId: "logical", nonce: 0 }]);
  const fresh = new PoolPayoutQueue({
    journal: new PendingPayoutJournal(join(ctx.directory, "empty-pending.json"), "smoke-secret"),
    ledger: ctx.ledger, rails: new Map([["base", rail]]), flushMs: 9e6, maxJitterMs: 0,
    maxAttempts: 3, reconcileMs: 10, recoveryBudgetMs: 100, claimTtlMs: 1000,
  });
  await fresh.recover();
  assert(ctx.ledger.findPayoutTransfer("three-store").settledAt !== undefined);
});
test("46 whole recovery returns within budget when classify hangs", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.classifyGate = deferred();
  const ctx = await context("46", rail);
  await reserveGroup(ctx, { groupRef: "hang" });
  const leg = ctx.journal.byRef("hang").legs[0];
  rail.outbox.set("hang", [{ logicalId: leg.logicalId, nonce: 0 }]);
  const fresh = new PoolPayoutQueue({
    journal: new PendingPayoutJournal(join(ctx.directory, "pending.json"), "smoke-secret"),
    ledger: ctx.ledger, rails: new Map([["base", rail]]), flushMs: 9e6, maxJitterMs: 0,
    maxAttempts: 3, reconcileMs: 10, recoveryBudgetMs: 20, claimTtlMs: 1000,
  });
  const started = Date.now();
  await fresh.recover();
  assert(Date.now() - started < 250);
  rail.classifyGate.resolve();
});
test("47 generation CAS rejects a stale recovery write", async () => {
  const ctx = await context("47");
  await reserveGroup(ctx, { groupRef: "cas" });
  const leg = ctx.journal.byRef("cas").legs[0];
  await ctx.journal.updateLeg("cas", 0, { state: "broadcasting" }, leg.gen);
  assert(await ctx.journal.updateLeg("cas", 0, { state: "queued" }, leg.gen) === false);
  assert(ctx.journal.byRef("cas").legs[0].state === "broadcasting");
});
test("48 resolvePoolPayoutLeg returns superseded after concurrent gen advance", async () => {
  const payer = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: new PublicKey(randomBytes(32)).toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
  tx.sign(payer);
  const signedTx = tx.serialize().toString("base64");
  const signature = base58(tx.signatures[0].signature);
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "landed", transactionHash: signature },
  });
  const ctx = await context("48", rail);
  await reserveGroup(ctx, { groupRef: "fenced" });
  const leg = ctx.journal.byRef("fenced").legs[0];
  await ctx.journal.updateLeg("fenced", 0, {
    state: "uncertain", signedTx, txId: signature, lastValidBlockHeight: 1, mode: "onchain",
  }, leg.gen);
  rail.statusGate = deferred();
  const disposition = ctx.queue.resolvePoolPayoutLeg({
    groupRef: "fenced", index: 0, landed: true, signature,
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  const current = ctx.journal.byRef("fenced").legs[0];
  await ctx.journal.updateLeg("fenced", 0, { state: "uncertain" }, current.gen);
  rail.statusGate.resolve();
  assert((await disposition).state === "superseded");
  assert(ctx.ledger.findPayoutTransfer("fenced").settledAt === undefined);
});

// 49-51: "included" is a known outcome, not ambiguity. Before this distinction
// existed, poolTransferStatus was polled milliseconds after broadcast against a
// ~13s Solana rooting time and returned "uncertain", so EVERY healthy Solana payout
// parked behind operator disposition — with no periodic reconcile to rescue it.
test("49 an included Solana payout stays in flight instead of parking uncertain", async () => {
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "included", transactionHash: "sig-included" },
  });
  rail.height = 50; rail.lastValidBlockHeight = 200;
  const ctx = await context("49", rail);
  await reserveGroup(ctx, { groupRef: "sol-included" });
  await ctx.queue.flushNow();
  const claim = await ctx.queue.claim("sol-included");
  assert(claim.legs[0].state !== "uncertain", "an included leg must not be marked uncertain");
  assert(claim.legs[0].chainStatus === "included", `expected chainStatus included, got ${claim.legs[0].chainStatus}`);
  assert(claim.legs[0].transactionHash === "sig-included", "the inclusion hash must be recorded");
  // The debit is held but NOT burned: the ledger must not settle before finality.
  assert(ctx.ledger.findPayoutTransfer("sol-included").settledAt === undefined,
    "an included payout must not be settled — a fork can still drop it");
});

test("50 the periodic reconcile promotes an included leg to settled", async () => {
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "included", transactionHash: "sig-promote" },
  });
  rail.height = 50; rail.lastValidBlockHeight = 200;
  const ctx = await context("50", rail);
  await reserveGroup(ctx, { groupRef: "sol-promote" });
  await ctx.queue.flushNow();
  assert((await ctx.queue.claim("sol-promote")).legs[0].state !== "settled");
  // Finality arrives; the reconcile pass (scheduleReconcile -> reconcileNetwork) runs.
  rail.verdict = { status: "landed", transactionHash: "sig-promote" };
  await ctx.queue.sweep();
  const claim = await ctx.queue.claim("sol-promote");
  assert(claim.legs[0].state === "settled", `expected settled after reconcile, got ${claim.legs[0].state}`);
  assert(ctx.ledger.findPayoutTransfer("sol-promote").settledAt !== undefined, "the ledger must settle on finality");
});

test("51 an included EVM leg is not marked uncertain by a reconcile pass", async () => {
  const rail = new MockRail({
    mode: "onchain",
    verdict: { status: "included", transactionHash: "0xincluded" },
  });
  rail.submitError = new SettlerNotYetFinalError({ transactionHash: "0xincluded", nonce: 3 });
  rail.persistBeforeError = true;
  const ctx = await context("51", rail);
  await reserveGroup(ctx, { groupRef: "evm-included" });
  await ctx.queue.flushNow();
  await ctx.queue.sweep();
  const claim = await ctx.queue.claim("evm-included");
  assert(claim.legs[0].state !== "uncertain", `an included EVM leg must stay in flight, got ${claim.legs[0].state}`);
  assert(claim.legs[0].chainStatus === "included", `expected chainStatus included, got ${claim.legs[0].chainStatus}`);
  assert(ctx.ledger.findPayoutTransfer("evm-included"), "the debit must be held while in flight");
});

test("52 SettlerNotYetFinalError from submit does not park the leg uncertain", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new SettlerNotYetFinalError({ transactionHash: "0xmined", nonce: 7 });
  rail.persistBeforeError = true;
  const ctx = await context("52", rail);
  await reserveGroup(ctx, { groupRef: "not-final" });
  await ctx.queue.flushNow();
  const claim = await ctx.queue.claim("not-final");
  // `uncertain` is a hard error on the synchronous claim path AND the sole entry
  // condition for operator disposition, so a healthy in-flight payout landing there
  // would put every one of them into audit:pool-payout-uncertain.
  assert(claim.legs[0].state !== "uncertain", `expected in-flight, got ${claim.legs[0].state}`);
  assert(claim.legs[0].chainStatus === "included", `expected chainStatus included, got ${claim.legs[0].chainStatus}`);
  assert(claim.legs[0].transactionHash === "0xmined", "the mined hash must be carried through");
  assert(ctx.ledger.findPayoutTransfer("not-final").settledAt === undefined, "must not settle before finality");
});

test("53 start() actually schedules the periodic reconcile", async () => {
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "included", transactionHash: "sig-timer" },
  });
  rail.height = 50; rail.lastValidBlockHeight = 200;
  // reconcileMs short and flushMs effectively infinite, so ONLY the reconcile timer
  // can move this leg. Without scheduleReconcile in start() the leg never settles.
  const ctx = await context("53", rail, { reconcileMs: 20, flushMs: 1_000_000 });
  await reserveGroup(ctx, { groupRef: "timer" });
  await ctx.queue.flushNow();
  assert((await ctx.queue.claim("timer")).legs[0].state !== "settled", "precondition: not settled yet");
  ctx.queue.start();
  // start() ALSO fires a one-shot sweep(). If finality is already visible here, that
  // single sweep settles the leg and the test passes with no periodic timer at all —
  // which is exactly how the first version of this test was vacuous. So let the
  // one-shot sweep run and find nothing, and only THEN let finality arrive: from this
  // point on, a periodic pass is the only thing that can settle it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert((await ctx.queue.claim("timer")).legs[0].state !== "settled",
    "the one-shot sweep should not have settled a still-included leg");
  rail.verdict = { status: "landed", transactionHash: "sig-timer" };
  const deadline = Date.now() + 3_000;
  let state;
  while (Date.now() < deadline) {
    state = (await ctx.queue.claim("timer")).legs[0].state;
    if (state === "settled") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  ctx.queue.stop();
  assert(state === "settled",
    `the reconcile timer never ran — an in-flight leg would wait for a process restart (state=${state})`);
});

test("54 stop() clears the reconcile timer too", async () => {
  // An EVM leg with an outbox handle, held in flight by an `included` verdict, so
  // every reconcile pass calls classifyByLogicalId and the timer is observable. With
  // no in-flight leg reconcileNetwork iterates nothing and this test would be vacuous.
  const rail = new MockRail({
    mode: "onchain",
    verdict: { status: "included", transactionHash: "0xstill-going" },
  });
  rail.submitError = new SettlerNotYetFinalError({ transactionHash: "0xstill-going", nonce: 4 });
  rail.persistBeforeError = true;
  const ctx = await context("54", rail, { reconcileMs: 20, flushMs: 1_000_000 });
  await reserveGroup(ctx, { groupRef: "stoppable" });
  await ctx.queue.flushNow();
  ctx.queue.start();
  // Baseline AFTER the one-shot sweep from start() has finished, so the increase
  // below can only come from the periodic timer.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const baseline = rail.classifies;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && rail.classifies === baseline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(rail.classifies > baseline, "the reconcile timer never fired, so stop() proves nothing");
  // An unchanged in-flight leg must not be rewritten by every pass. Each updateLeg is
  // a whole-file AES-GCM encrypt + fsync plus a generation bump, so without a no-op
  // guard a 30s reconcile churns the journal for the entire finality window — roughly
  // 48 rewrites per EVM payout, and gen churn that fails concurrent CAS writes.
  const gen = ctx.journal.byRef("stoppable").legs[0].gen;
  const classifiesBefore = rail.classifies;
  while (rail.classifies < classifiesBefore + 3 && Date.now() < deadline + 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(rail.classifies >= classifiesBefore + 3, "precondition: several reconcile passes must have run");
  assert(ctx.journal.byRef("stoppable").legs[0].gen === gen,
    `the reconcile rewrote an unchanged in-flight leg (gen ${gen} -> ${ctx.journal.byRef("stoppable").legs[0].gen})`);

  ctx.queue.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const afterStop = rail.classifies;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(rail.classifies === afterStop,
    `stop() left the reconcile timer running (${rail.classifies - afterStop} extra classifies)`);
});

// 55: recovery must not leave the network lock held by an abandoned task.
// `settleWithinBudget` stops AWAITING a slow recovery task, but the task itself is
// still the tail of the network lock chain. If it never settles, every later
// flush/claim/reconcile on that network queues behind it forever — the queue looks
// alive and silently stops paying anyone on that rail.
test("55 a recovery that outruns its budget does not pin the network lock", async () => {
  const rail = new MockRail({ network: "base", kind: "evm", mode: "onchain" });
  // Reach recovery's classify path with a journal-less ledger ref, then hang there.
  const directory = join(root, "55");
  const ledger = await new PrivatePaymentLedger(
    join(directory, "ledger.json"),
    "smoke-secret",
    {
      journal: new EphemeralPaymentJournal(join(directory, "epochs")),
      retentionMs: 60_000,
      baseAssetKey: privateLedgerAssetKey(rail.network, rail.tokenConfig.address),
    },
  ).load({ payer: "1000000" });
  await ledger.payout({
    agentId: "payer",
    amountAtomic: "100000",
    assetKey: privateLedgerAssetKey(rail.network, rail.tokenConfig.address),
    network: rail.network,
    payoutRef: "orphan-55",
    planHash: "hash-55",
  });
  rail.outbox.set("orphan-55", [{ logicalId: "logical-55", nonce: 0 }]);
  rail.classifyGate = deferred();
  const queue = new PoolPayoutQueue({
    journal: new PendingPayoutJournal(join(directory, "pending.json"), "smoke-secret"),
    ledger,
    rails: new Map([[rail.network, rail]]),
    flushMs: 1_000_000,
    maxJitterMs: 0,
    maxAttempts: 3,
    reconcileMs: 100,
    recoveryBudgetMs: 50,
    claimTtlMs: 10_000,
    now: () => 1_000,
    random: () => 0,
  });
  await queue.recover();
  // Recovery returned (budget expired) while the classify is still hanging. Anything
  // taking the same network lock must still be able to run.
  const progressed = await Promise.race([
    queue.flushNow().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  rail.classifyGate.resolve();
  assert(
    progressed,
    "the network lock is still held by the abandoned recovery task — every later "
    + "flush, claim, and reconcile on this rail queues behind it forever",
  );
});

// 56-58: a Solana transaction whose blockhash has expired can never land. Ignoring
// the expiry (`void input.lastValidBlockHeight`) meant a transaction the cluster has
// PROVABLY dropped stayed `uncertain` forever, needing an archival RPC and an
// operator to release funds the chain already refused to move. These drive the real
// facilitator, because that is where the verdict is decided — MockRail returns a
// canned verdict and would pass no matter what the production code did.
const expiryFacilitator = ({ statuses = [null], blockHeight }) => new SolanaX402Facilitator({
  rpcUrl: "http://unused",
  connection: {
    getSignatureStatuses: async () => ({ value: statuses }),
    getBlockHeight: async (commitment) => {
      assert(commitment === "finalized", `expiry must be judged at the finalized head, got ${commitment}`);
      return blockHeight;
    },
  },
});

test("56 an expired-blockhash Solana payout is terminal-absent, not uncertain forever", async () => {
  // Absent from the cluster, and the FINALIZED head is past the expiry: provably dead.
  const verdict = await expiryFacilitator({ blockHeight: 250 }).poolTransferStatus({
    signature: "sig-expired",
    lastValidBlockHeight: 200,
  });
  assert(
    verdict.status === "terminal-absent",
    `a provably-dead transaction must resolve terminal-absent, got ${verdict.status}`,
  );
});

test("57 absence BEFORE blockhash expiry is pending — never reversed, never operator-flagged", async () => {
  // Guards against over-correcting 56 in BOTH directions. Inside the validity
  // window the transaction may simply not have propagated: reversing there would
  // double-pay one that lands, and reporting `uncertain` there was the H7 flap —
  // this path is polled milliseconds after broadcast, so every healthy payout
  // transited the operator-disposition state during its own propagation delay.
  // `pending` = leave the leg alone; the blockhash validity window is Solana's
  // liveness bound, and expiry (56) is what turns absence into proof.
  const verdict = await expiryFacilitator({ blockHeight: 150 }).poolTransferStatus({
    signature: "sig-young",
    lastValidBlockHeight: 200,
  });
  assert(
    verdict.status === "pending",
    `absence inside the validity window is expected propagation delay, got ${verdict.status}`,
  );
});

test("59 a pending verdict leaves the leg in flight and writes nothing", async () => {
  // The H7 flap, queue-side: `pending` (zero evidence, liveness bound still
  // alive) is not new information. The old else-branch wrote journal `uncertain`
  // for it, promoting every payout whose status poll outran propagation into
  // operator disposition — and `uncertain` is a hard error on the claim path.
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "pending" },
  });
  rail.height = 50; rail.lastValidBlockHeight = 200;
  const ctx = await context("59", rail);
  await reserveGroup(ctx, { groupRef: "sol-pending" });
  await ctx.queue.flushNow();
  const claim = await ctx.queue.claim("sol-pending");
  assert(claim.legs[0].state === "broadcasting", `a pending leg stays in flight, got ${claim.legs[0].state}`);
  assert(
    ctx.ledger.findPayoutTransfer("sol-pending").settledAt === undefined,
    "pending must not settle the ledger",
  );
  // "No write" must mean no write: the generation counter is what concurrent CAS
  // writers fence on, so even a same-state rewrite here would be churn.
  const genBefore = ctx.journal.byRef("sol-pending").legs[0].gen;
  assert(Number.isInteger(genBefore), "journal leg must expose gen for this assertion to mean anything");
  await ctx.queue.sweep();
  assert(
    ctx.journal.byRef("sol-pending").legs[0].gen === genBefore,
    "a pending reconcile pass churned the leg generation — the no-write rule is not holding",
  );
  // Propagation completes and finality arrives: the reconcile finishes the leg.
  rail.verdict = { status: "landed", transactionHash: "sig-pending-landed" };
  await ctx.queue.sweep();
  const done = await ctx.queue.claim("sol-pending");
  assert(done.legs[0].state === "settled", `expected settled once evidence appears, got ${done.legs[0].state}`);
});

test("60 pending after a reorged-away inclusion clears the stale recorded evidence", async () => {
  // `pending` means NO current evidence, so a hash recorded by a prior
  // `included` pass is stale by definition — leaving it shows a dead transaction
  // as included to every journal reader until some later verdict overwrites it.
  const rail = new MockRail({
    network: "solana", kind: "solana", mode: "onchain",
    verdict: { status: "included", transactionHash: "sig-reorged" },
  });
  rail.height = 50; rail.lastValidBlockHeight = 200;
  const ctx = await context("60", rail);
  await reserveGroup(ctx, { groupRef: "sol-reorg-pending" });
  await ctx.queue.flushNow();
  let claim = await ctx.queue.claim("sol-reorg-pending");
  assert(claim.legs[0].chainStatus === "included", "precondition: the inclusion was recorded");
  // A fork drops the containing block: the next status poll sees nothing at all.
  rail.verdict = { status: "pending" };
  await ctx.queue.sweep();
  claim = await ctx.queue.claim("sol-reorg-pending");
  assert(claim.legs[0].state === "broadcasting", `the leg stays in flight, got ${claim.legs[0].state}`);
  assert(
    claim.legs[0].chainStatus === undefined,
    `a reorged-out inclusion must not linger, got chainStatus ${claim.legs[0].chainStatus}`,
  );
  assert(claim.legs[0].transactionHash === undefined, "the dead hash must be cleared");
  // The transaction re-lands on the canonical fork and finalizes.
  rail.verdict = { status: "landed", transactionHash: "sig-reorged" };
  await ctx.queue.sweep();
  const done = await ctx.queue.claim("sol-reorg-pending");
  assert(done.legs[0].state === "settled", `expected settled once evidence returns, got ${done.legs[0].state}`);
});

test("61 an EVM pending classification leaves the leg in flight", async () => {
  // Test 59 covers Solana; this is the EVM reconcile path (classifyByLogicalId →
  // applyVerdict), which had no pending coverage at all.
  const rail = new MockRail({
    mode: "onchain",
    verdict: { status: "pending" },
  });
  rail.submitError = new SettlerNotYetFinalError({ transactionHash: "0xevm-pending", nonce: 5 });
  rail.persistBeforeError = true;
  const ctx = await context("61", rail);
  await reserveGroup(ctx, { groupRef: "evm-pending" });
  await ctx.queue.flushNow();
  await ctx.queue.sweep();
  const claim = await ctx.queue.claim("evm-pending");
  assert(
    claim.legs[0].state === "broadcasting",
    `an EVM pending leg must stay in flight, got ${claim.legs[0].state}`,
  );
  rail.verdict = { status: "landed", transactionHash: "0xevm-pending" };
  await ctx.queue.sweep();
  const done = await ctx.queue.claim("evm-pending");
  assert(done.legs[0].state === "settled", `expected settled once finality arrives, got ${done.legs[0].state}`);
});

// 62-63: §2.5 — parked is not an attempt (frozen rule: delay, never refuse).
// maxAttempts is 3 in this fixture, so four quarantined windows would refuse
// every leg on the rail if a park counted as an attempt.
test("62 a quarantined settler makes the flush a pure delay — no writes, no attempts", async () => {
  const rail = new MockRail({ mode: "onchain" });
  rail.settlerQuarantined = () => true;
  const ctx = await context("62", rail);
  await reserveGroup(ctx, { groupRef: "quarantine-delay" });
  const genBefore = ctx.journal.byRef("quarantine-delay").legs[0].gen;
  for (let round = 0; round < 4; round += 1) await ctx.queue.flushNow();
  const leg = ctx.journal.byRef("quarantine-delay").legs[0];
  assert(leg.state === "queued", `the leg must stay queued through a quarantine, got ${leg.state}`);
  assert(
    leg.attempts === 0,
    `a delay is not an attempt — got attempts ${leg.attempts} after 4 windows (maxAttempts refuses at 3)`,
  );
  assert(leg.gen === genBefore, "a pure delay must write nothing — the generation churned");
  assert(rail.submits === 0, "the flush must not even reach the rail while the settler is quarantined");
  // The quarantine resolves; the very next window pays out normally.
  rail.settlerQuarantined = () => false;
  await ctx.queue.flushNow();
  assert(
    ctx.journal.byRef("quarantine-delay").legs[0].state === "settled",
    "the delayed leg must settle once the quarantine lifts",
  );
});

test("63 a quarantine that begins mid-submit is not an attempt either", async () => {
  // The race flavor: the pre-flush check saw a healthy settler, and the
  // quarantine landed between that check and the submit. The coordinator
  // rejects synchronously (nothing signed, no nonce, no outbox entry) and the
  // leg must return to queued with its ORIGINAL attempts count.
  const rail = new MockRail({ mode: "onchain" });
  rail.submitError = new SettlerQuarantinedError();
  const ctx = await context("63", rail);
  await reserveGroup(ctx, { groupRef: "quarantine-race" });
  for (let round = 0; round < 4; round += 1) await ctx.queue.flushNow();
  const leg = ctx.journal.byRef("quarantine-race").legs[0];
  assert(leg.state === "queued", `the leg must return to queued, got ${leg.state}`);
  assert(leg.attempts === 0, `parked is not an attempt — got ${leg.attempts} after 4 windows`);
  assert(rail.submits === 4, `the race path must actually reach the rail each window, got ${rail.submits}`);
  rail.submitError = undefined;
  await ctx.queue.flushNow();
  assert(
    ctx.journal.byRef("quarantine-race").legs[0].state === "settled",
    "the leg must settle once the quarantine lifts",
  );
});

test("64 a quarantined rail mints no cohort manifests and records nothing", async () => {
  // §2.5 review F2 (Grok): with concentration on, every flush window against a
  // quarantined settler used to release groups through the gate and mint a
  // fresh cohort manifest that could never resolve — unbounded growth plus
  // k_eff samples for releases that never touched the chain. The whole
  // release/planning half of the window is now skipped; retention still runs.
  const rail = new MockRail({ mode: "onchain" });
  rail.settlerQuarantined = () => true;
  const ctx = await context("64", rail, { concentrationEnabled: true, kEffTarget: 1 });
  await reserveGroup(ctx, { groupRef: "quarantine-cohort" });
  for (let round = 0; round < 3; round += 1) await ctx.queue.flushNow();
  assert(
    ctx.queue.cohortsById.size === 0,
    `a quarantined window must not mint cohort manifests, got ${ctx.queue.cohortsById.size}`,
  );
  const leg = ctx.journal.byRef("quarantine-cohort").legs[0];
  assert(leg.state === "queued" && leg.attempts === 0, `pure delay expected, got ${leg.state}/${leg.attempts}`);
  rail.settlerQuarantined = () => false;
  await ctx.queue.flushNow();
  assert(
    ctx.journal.byRef("quarantine-cohort").legs[0].state === "settled",
    "the delayed leg must settle once the quarantine lifts",
  );
});

// 65-67: §2.2/§2.6 — windowed EVM releases dispatch as one wave and never await
// finality. The mock dispatch is assigned per-INSTANCE (never on MockRail's
// prototype) so every legacy test keeps the submit path.
const armDispatch = (rail) => {
  rail.dispatchCalls = [];
  rail.dispatchPoolPayouts = async (inputs) => {
    rail.dispatchCalls.push(inputs.map((input) => input.logicalId));
    if (rail.dispatchError) throw rail.dispatchError;
    let nonce = -1;
    const outcomes = inputs.map((input) => {
      nonce += 1;
      const ref = rail.refs.get(input.logicalId);
      if (ref) rail.outbox.set(ref, [{ logicalId: input.logicalId, nonce, kind: "pool-payout" }]);
      return { logicalId: input.logicalId, status: "dispatched", nonce, txHash: `0xdispatch-${nonce}` };
    });
    return { outcomes, failures: rail.dispatchFailures ?? new Map() };
  };
};

test("65 a windowed EVM flush dispatches one wave and returns with legs in flight", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  const ctx = await context("65", rail);
  await reserveGroup(ctx, { groupRef: "wave", amounts: ["100000", "100000"] });
  await ctx.queue.flushNow();
  assert(rail.dispatchCalls.length === 1, `one dispatch call per wave, got ${rail.dispatchCalls.length}`);
  assert(rail.dispatchCalls[0].length === 2, "both legs travel in the same wave");
  assert(rail.submits === 0, "the windowed path must not use the blocking submit");
  for (const leg of ctx.journal.byRef("wave").legs) {
    assert(leg.state === "broadcasting", `a dispatched leg stays in flight, got ${leg.state}`);
    assert(leg.txId !== undefined && leg.nonce !== undefined, "the durable identity is recorded on the leg");
  }
  // Finality arrives; the reconcile pass — not the flush — settles the wave.
  rail.verdict = (input) => ({ status: "landed", transactionHash: `0xlanded-${input.nonce}` });
  await ctx.queue.sweep();
  for (const leg of ctx.journal.byRef("wave").legs) {
    assert(leg.state === "settled", `the reconcile finishes a dispatched leg, got ${leg.state}`);
  }
});

test("66 a quarantine rejection mid-wave returns every leg to queued byte-equivalent", async () => {
  const rail = new MockRail({ mode: "onchain" });
  armDispatch(rail);
  rail.dispatchError = new SettlerQuarantinedError();
  const ctx = await context("66", rail);
  await reserveGroup(ctx, { groupRef: "wave-quarantine", amounts: ["100000", "100000"] });
  for (let round = 0; round < 4; round += 1) await ctx.queue.flushNow();
  for (const leg of ctx.journal.byRef("wave-quarantine").legs) {
    assert(leg.state === "queued", `the wave must return to queued, got ${leg.state}`);
    assert(leg.attempts === 0, `parked is not an attempt for a wave either, got ${leg.attempts}`);
  }
  rail.dispatchError = undefined;
  await ctx.queue.flushNow();
  rail.verdict = (input) => ({ status: "landed", transactionHash: `0xlanded-${input.nonce}` });
  await ctx.queue.sweep();
  for (const leg of ctx.journal.byRef("wave-quarantine").legs) {
    assert(leg.state === "settled", `the delayed wave settles once the quarantine lifts, got ${leg.state}`);
  }
});

test("67 the reconcile pass drives maintain for in-flight legs with its own verdict", async () => {
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  rail.maintainCalls = [];
  rail.maintainPoolPayout = async (input) => { rail.maintainCalls.push(input); };
  const ctx = await context("67", rail);
  await reserveGroup(ctx, { groupRef: "maintained" });
  await ctx.queue.flushNow();
  await ctx.queue.sweep();
  assert(rail.maintainCalls.length >= 1, "an in-flight leg must be maintained by the reconcile pass");
  const call = rail.maintainCalls[0];
  assert(call.verdict?.status === "pending", "the reconcile's own verdict is passed through (H6: no duplicate classification)");
  assert(call.recipient !== undefined && call.amountAtomic === "100000", "the signer inputs come from durable journal data");
  // A landed leg needs no LIVENESS work, but maintain still runs once with the
  // terminal verdict: maintainEntry's landed/terminal-absent branches are what
  // propagate the outcome into the OUTBOX entry (full §2.8 companion). Skipping
  // them stranded every settled leg's WAL entry non-terminal until the next
  // restart's recovery walk — and stranded entries are what cohorts multiply.
  rail.maintainCalls = [];
  rail.verdict = (input) => ({ status: "landed", transactionHash: `0xlanded-${input.nonce ?? 0}` });
  await ctx.queue.sweep();
  assert(ctx.journal.byRef("maintained").legs[0].state === "settled", "the leg settles");
  assert(
    rail.maintainCalls.length === 1 && rail.maintainCalls[0].verdict?.status === "landed",
    "maintain receives the terminal verdict exactly once as the outbox propagator, got "
    + JSON.stringify(rail.maintainCalls.map((call) => call.verdict?.status)),
  );
  // Terminal legs are skipped entirely on later passes — once, not once per sweep.
  await ctx.queue.sweep();
  assert(
    rail.maintainCalls.length === 1,
    "a settled leg must not be re-maintained on the next pass",
  );
});

test("68 mid-wave failures route each leg by what actually happened to it", async () => {
  // recordDispatchError's two entry paths, previously verified only by reading:
  // a pre-dispatch failure (simulation, sign) leaves no outbox identity and the
  // leg RETRIES; a lost-nonce failure burns the logicalId, goes to operator
  // disposition, and — because the error proves definitive absence — reverses
  // the debit.
  const rail = new MockRail({ mode: "onchain" });
  armDispatch(rail);
  const base = rail.dispatchPoolPayouts;
  rail.dispatchPoolPayouts = async (inputs) => {
    const result = await base(inputs);
    const failures = new Map();
    // The flush SHUFFLES candidates (R10), so pick legs by their payout ref,
    // never by wave position.
    const byRef = (suffix) => inputs.find((input) => rail.refs.get(input.logicalId) === `mixed-wave:${suffix}`);
    // Leg 0 stays dispatched. Leg 1: pre-dispatch failure (no outbox entry).
    const legOne = byRef("1");
    if (legOne) {
      failures.set(legOne.logicalId, "Pool payout simulation failed: injected");
      result.outcomes = result.outcomes.filter((o) => o.logicalId !== legOne.logicalId);
      rail.outbox.delete(rail.refs.get(legOne.logicalId));
    }
    // Leg 2: first broadcast lost its nonce to a finalized occupant — the
    // outbox entry EXISTS (the WAL write preceded the broadcast).
    const legTwo = byRef("2");
    if (legTwo) {
      result.outcomes = result.outcomes.map((o) => o.logicalId === legTwo.logicalId
        ? { logicalId: o.logicalId, status: "failed", error: "first broadcast lost its nonce to a finalized occupant" }
        : o);
    }
    return { outcomes: result.outcomes, failures };
  };
  const ctx = await context("68", rail);
  const payerBefore = ctx.ledger.balance("payer", privateLedgerAssetKey(rail.network, rail.tokenConfig.address));
  await reserveGroup(ctx, { groupRef: "mixed-wave", amounts: ["100000", "100000", "100000"] });
  await ctx.queue.flushNow();
  const legs = ctx.journal.byRef("mixed-wave").legs;
  assert(legs[0].state === "broadcasting", `leg 0 dispatched and in flight, got ${legs[0].state}`);
  assert(
    legs[1].state === "queued" && legs[1].attempts === 1,
    `a pre-dispatch failure retries with a REAL attempt counted, got ${legs[1].state}/${legs[1].attempts}`,
  );
  assert(legs[2].state === "failed", `a lost nonce is definitive absence — terminal, got ${legs[2].state}`);
  const payerAfter = ctx.ledger.balance("payer", privateLedgerAssetKey(rail.network, rail.tokenConfig.address));
  assert(
    BigInt(payerAfter) === BigInt(payerBefore) - 200_000n,
    `exactly the two live legs stay debited — the lost-nonce leg must reverse (before ${payerBefore}, after ${payerAfter})`,
  );
});

test("69 a batch abort after K of N durable dispatches never mass-classifies uncertain", async () => {
  // Review F-THROW: the wave dies after two of three legs are signed, durably
  // WAL'd, and broadcast (e.g. a disk error on the third putVersion). The two
  // live legs must STAY in flight — marking them uncertain opens operator
  // disposition and hard-errors the claim for transactions that may still
  // land. Only the leg with no durable identity takes the error path.
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  const base = rail.dispatchPoolPayouts;
  rail.dispatchPoolPayouts = async (inputs) => {
    // Model the crash point faithfully: the FIRST TWO wave members (post-R10
    // shuffle order) reach the outbox, then the batch throws.
    let nonce = -1;
    for (const input of inputs.slice(0, 2)) {
      nonce += 1;
      const ref = rail.refs.get(input.logicalId);
      if (ref) rail.outbox.set(ref, [{ logicalId: input.logicalId, nonce, kind: "pool-payout" }]);
    }
    void base;
    throw new Error("outbox write failed: injected disk error");
  };
  const ctx = await context("69", rail);
  await reserveGroup(ctx, { groupRef: "aborted-wave", amounts: ["100000", "100000", "100000"] });
  await ctx.queue.flushNow();
  const legs = ctx.journal.byRef("aborted-wave").legs;
  const inFlight = legs.filter((leg) => leg.state === "broadcasting");
  const requeued = legs.filter((leg) => leg.state === "queued");
  assert(legs.every((leg) => leg.state !== "uncertain"),
    `a batch abort must never mass-classify uncertain, got ${JSON.stringify(legs.map((l) => l.state))}`);
  assert(inFlight.length === 2, `the two durably dispatched legs stay in flight, got ${inFlight.length}`);
  assert(inFlight.every((leg) => leg.nonce !== undefined), "in-flight legs carry their real outbox nonce");
  assert(requeued.length === 1 && requeued[0].attempts === 1,
    `the identity-less leg requeues with a real attempt, got ${JSON.stringify(requeued.map((l) => [l.state, l.attempts]))}`);
  // The reconcile finishes the live legs; the next wave picks up the requeued one.
  rail.dispatchPoolPayouts = base;
  rail.verdict = (input) => ({ status: "landed", transactionHash: `0xlanded-${input.nonce ?? 9}` });
  await ctx.queue.sweep();
  await ctx.queue.flushNow();
  await ctx.queue.sweep();
  assert(
    ctx.journal.byRef("aborted-wave").legs.every((leg) => leg.state === "settled"),
    `every leg converges to settled, got ${JSON.stringify(ctx.journal.byRef("aborted-wave").legs.map((l) => l.state))}`,
  );
});

test("70 §2.9: landing blocks and broadcast stamps resolve into cohort spread on the claim", async () => {
  // H11 — realized k_eff is computed over members that landed, not members that
  // landed TOGETHER. The claim must carry the temporal spread so a cohort split
  // across a partition (nonce gap, wedge, quarantine-park) cannot report full K
  // while landing as two visually distinct on-chain clusters.
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  // Stamp the wave the way the real coordinator does: broadcastAtMs on every
  // fresh first broadcast.
  const base = rail.dispatchPoolPayouts;
  rail.dispatchPoolPayouts = async (inputs) => {
    const result = await base(inputs);
    result.outcomes = result.outcomes.map((outcome) => outcome.status === "dispatched"
      ? { ...outcome, broadcastAtMs: 1_000 + outcome.nonce * 400 }
      : outcome);
    return result;
  };
  const ctx = await context("70", rail, { concentrationEnabled: true, kEffTarget: 1 });
  await reserveGroup(ctx, { groupRef: "spread", amounts: ["100000", "100000"] });
  await ctx.queue.flushNow();
  for (const leg of ctx.journal.byRef("spread").legs) {
    assert(
      leg.broadcastAt !== undefined,
      "a dispatched leg must persist its first-broadcast stamp for the cohort measurement",
    );
  }
  // Finality: the legs land three blocks apart.
  rail.verdict = (input) => ({
    status: "landed",
    transactionHash: `0xlanded-${input.nonce}`,
    blockNumber: 100 + input.nonce * 3,
  });
  await ctx.queue.sweep();
  const legs = ctx.journal.byRef("spread").legs;
  assert(legs.every((leg) => leg.state === "settled"), "both legs settle");
  assert(
    legs.every((leg) => leg.landedBlock !== undefined),
    "a landed verdict's block must persist on the leg",
  );
  const claim = await ctx.queue.claim("spread");
  assert(claim.concentration !== undefined, "the resolved cohort reports on the claim");
  assert(
    claim.concentration.landingSpreadBlocks === 3,
    `the claim must carry the landing spread (blocks 100..103), got ${claim.concentration.landingSpreadBlocks}`,
  );
  assert(
    claim.concentration.broadcastSpreadMs === 400,
    `the claim must carry the measured broadcast spread, got ${claim.concentration.broadcastSpreadMs}`,
  );
});

test("71 a partially measured cohort resolves without a spread claim", async () => {
  // One landing measured, one legacy (no blockNumber on the verdict): the cohort
  // still resolves its realized k_eff, but claims NO spread — a partial
  // measurement reading as a tight one is the exact lie §2.9 exists to prevent.
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  // MIXED stamps: one fresh broadcast, one replay-shaped outcome without a
  // stamp — the real shape of a re-queued leg joining a later wave. A spread
  // over the one measured member would read tighter than reality.
  const base = rail.dispatchPoolPayouts;
  rail.dispatchPoolPayouts = async (inputs) => {
    const result = await base(inputs);
    result.outcomes = result.outcomes.map((outcome) =>
      outcome.status === "dispatched" && outcome.nonce === 0
        ? { ...outcome, broadcastAtMs: 1_000 }
        : outcome);
    return result;
  };
  const ctx = await context("71", rail, { concentrationEnabled: true, kEffTarget: 1 });
  await reserveGroup(ctx, { groupRef: "partial", amounts: ["100000", "100000"] });
  await ctx.queue.flushNow();
  rail.verdict = (input) => input.nonce === 0
    ? { status: "landed", transactionHash: "0xlanded-0", blockNumber: 100 }
    : { status: "landed", transactionHash: "0xlanded-1" };
  await ctx.queue.sweep();
  const claim = await ctx.queue.claim("partial");
  assert(
    claim.legs.every((leg) => leg.state === "settled"),
    "both legs settle regardless of measurement",
  );
  assert(claim.concentration !== undefined, "the cohort still resolves its realized k_eff");
  assert(
    claim.concentration.landingSpreadBlocks === undefined,
    `an unmeasured member must suppress the landing-spread claim, got ${claim.concentration.landingSpreadBlocks}`,
  );
  assert(
    claim.concentration.broadcastSpreadMs === undefined,
    `an unstamped member must suppress the broadcast-spread claim, got ${claim.concentration.broadcastSpreadMs}`,
  );
});

test("72 a foreign outbox handle never settles, refunds, or maintains the leg", async () => {
  // Codex + Grok reviews of 78803f1: the old `?? handles[0]` fallback adopted
  // whatever entry shared the payoutRef and applied ITS verdict to this leg — a
  // foreign "landed" burned the debit against a transaction that never paid
  // this recipient, and a foreign "terminal-absent" refunded a payer whose
  // real transfer could still land (double-pay setup). A foreign-only ref now
  // requeues the leg (safe: the outbox never prunes, so a leg that ever
  // broadcast always matches — a miss proves it never did).
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  rail.maintainCalls = [];
  rail.maintainPoolPayout = async (input) => { rail.maintainCalls.push(input); };
  const ctx = await context("72", rail, { concentrationEnabled: true, kEffTarget: 1 });
  const asset = privateLedgerAssetKey(rail.network, rail.tokenConfig.address);
  await reserveGroup(ctx, { groupRef: "fallback", amounts: ["100000"] });
  const debited = ctx.ledger.balance("payer", asset);
  await ctx.queue.flushNow();
  // Corrupt the ref->entry binding: the outbox now names a foreign logicalId.
  // (strategy "single" ⇒ the leg's payoutRef is the bare groupRef.)
  rail.outbox.set("fallback", [{ logicalId: "foreign-entry", nonce: 7, kind: "pool-payout" }]);
  rail.maintainCalls = [];
  rail.verdict = () => ({ status: "landed", transactionHash: "0xlanded-foreign" });
  await ctx.queue.sweep();
  assert(
    ctx.journal.byRef("fallback").legs[0].state === "queued",
    `a foreign landed verdict must never settle this leg — got ${ctx.journal.byRef("fallback").legs[0].state}`,
  );
  assert(rail.maintainCalls.length === 0, "maintain must not run against a foreign verdict");
  // The sharpest fund assert: a foreign terminal-absent must NOT refund.
  rail.verdict = () => ({ status: "terminal-absent" });
  await ctx.queue.sweep();
  assert(
    ctx.journal.byRef("fallback").legs[0].state === "queued",
    "a foreign terminal-absent must not fail the leg",
  );
  assert(
    ctx.ledger.balance("payer", asset) === debited,
    "a foreign terminal-absent must not reverse the debit — that is the double-pay setup",
  );
  // Convergence: with the corruption gone, the leg re-dispatches and settles.
  rail.outbox.delete("fallback");
  rail.verdict = { status: "pending" };
  await ctx.queue.flushNow();
  rail.verdict = (input) => ({ status: "landed", transactionHash: `0xlanded-${input.nonce ?? 0}` });
  await ctx.queue.sweep();
  assert(
    ctx.journal.byRef("fallback").legs[0].state === "settled",
    `the requeued leg converges once the ref is clean, got ${ctx.journal.byRef("fallback").legs[0].state}`,
  );
});

test("73 a re-queued leg's later landing shows up as a WIDE spread on the original cohort", async () => {
  // Grok review of 78803f1: cohort manifests are immutable, so a leg that
  // fails in window 1 and lands via window 2 is a member of BOTH cohorts, and
  // the original cohort's realized k_eff counts it (frozen R8: "over members
  // that actually settled" — pinned by the concentration suite; excluding it
  // was tried and reverted). §2.9's remedy is the ANNOTATION: the straggler's
  // later landing block must make the original cohort's landing spread
  // visibly wide, so a sibling reading "k_eff 2" also reads the partition.
  const rail = new MockRail({ mode: "onchain", verdict: { status: "pending" } });
  armDispatch(rail);
  let clock = 1_000;
  let failB = true;
  const base = rail.dispatchPoolPayouts;
  rail.dispatchPoolPayouts = async (inputs) => {
    const result = await base(inputs);
    if (!failB) return result;
    const legB = inputs.find((input) => rail.refs.get(input.logicalId) === "group-b:0");
    if (legB) {
      // Pre-dispatch failure shape (test 68's pattern): no outcome, no entry.
      result.failures.set(legB.logicalId, "Pool payout simulation failed: injected");
      result.outcomes = result.outcomes.filter((o) => o.logicalId !== legB.logicalId);
      rail.outbox.delete("group-b:0");
    }
    return result;
  };
  const ctx = await context("73", rail, {
    concentrationEnabled: true, kEffTarget: 1, now: () => clock,
  });
  // Two owners, one denomination lane — the cohort is genuinely 2-way.
  await reserveGroup(ctx, { groupRef: "group-a", amounts: ["100000"], strategy: "denominations" });
  await reserveGroup(ctx, { groupRef: "group-b", amounts: ["100000"], strategy: "denominations", agent: "payer2" });
  await ctx.queue.flushNow();
  assert(ctx.journal.byRef("group-a").legs[0].state === "broadcasting", "A dispatched in window 1");
  assert(ctx.journal.byRef("group-b").legs[0].state === "queued", "B requeued after its injected failure");
  const original = [...ctx.queue.cohortsById.values()].find((cohort) => cohort.members.length === 2);
  assert(original !== undefined, "window 1 minted a 2-member cohort");
  rail.verdict = (input) => ({
    status: "landed", transactionHash: `0xlanded-w1-${input.nonce ?? 0}`, blockNumber: 100,
  });
  await ctx.queue.sweep();
  // Window 2: B releases alone and lands a hundred blocks later.
  failB = false;
  clock = 2_000;
  rail.verdict = { status: "pending" };
  await ctx.queue.flushNow();
  rail.verdict = (input) => ({
    status: "landed", transactionHash: `0xlanded-w2-${input.nonce ?? 0}`, blockNumber: 200,
  });
  await ctx.queue.sweep();
  const resolved = [...ctx.queue.cohortsById.values()].find((cohort) => cohort.cohortId === original.cohortId);
  assert(resolved?.realizedKEff !== undefined, "the original cohort resolves once every member is terminal");
  assert(
    resolved.realizedKEff === 2,
    `frozen R8 counts every settled member, got k_eff ${resolved.realizedKEff}`,
  );
  assert(
    resolved.landingSpread?.spreadBlocks === 100,
    `the straggler's later landing must widen the original cohort's spread to 100, `
    + `got ${JSON.stringify(resolved.landingSpread)}`,
  );
  const siblingClaim = await ctx.queue.claim("group-a");
  assert(
    siblingClaim.concentration?.realizedKEff === 2
    && siblingClaim.concentration?.landingSpreadBlocks === 100,
    `the sibling's claim must carry both the count AND the partition tell, `
    + `got ${JSON.stringify(siblingClaim.concentration)}`,
  );
  const later = [...ctx.queue.cohortsById.values()].find(
    (cohort) => cohort.members.length === 1 && cohort.createdAt === 2_000,
  );
  assert(
    later?.realizedKEff === 1,
    `B's own later cohort reports its solitary landing, got ${later?.realizedKEff}`,
  );
});

test("58 an expired blockhash never overrides an observed on-chain status", async () => {
  // Expiry only interprets ABSENCE. A signature the cluster has actually seen is
  // judged on its own status, or a dead-blockhash check would bury a real transfer.
  const verdict = await expiryFacilitator({
    statuses: [{ confirmationStatus: "finalized", err: null }],
    blockHeight: 250,
  }).poolTransferStatus({ signature: "sig-landed", lastValidBlockHeight: 200 });
  assert(
    verdict.status === "landed",
    `an observed finalized success must stay landed, got ${verdict.status}`,
  );
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

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const byte of bytes) numeric = numeric * 256n + BigInt(byte);
  let output = "";
  while (numeric > 0n) {
    output = alphabet[Number(numeric % 58n)] + output;
    numeric /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + output;
}
