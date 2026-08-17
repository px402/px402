/**
 * Offline smoke for payout concentration (spec-payout-concentration.md §9).
 *
 * Deterministic via injected RNG and clock. Covers so far:
 *   §2  k_eff metric correctness (case 1)
 *   §4  release-planner decision logic + the queue-level R1/R4/R5 requirements
 *       (cases 3, 4, 6 — the highest-risk being R1: a hold must never quarantine)
 * §5 signed maxHoldMs, §7 realized-k_eff-on-claim, and full recovery (case 8)
 * arrive with their increments.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import { BASE_USDC } from "../src/shared/x402.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { PendingPayoutJournal } from "../src/server/payments/PendingPayoutJournal.ts";
import { PoolPayoutQueue, poolPayoutPlanHash } from "../src/server/payments/PoolPayoutQueue.ts";
import { computePlanHash, validatePlanAgainstPolicy } from "../src/shared/payoutPlan.ts";
import {
  adaptiveKEffTarget,
  anonymityByLane,
  computeKEff,
  distinctGroupCount,
  kEffHistogram,
  laneKeyFor,
  planWindowRelease,
} from "../src/shared/payoutConcentration.ts";
import {
  deriveScheduleJitter,
  epochOf,
  epochSeed,
  scheduleCommitment,
  scheduleSlot,
} from "../src/shared/payoutScheduleCommitment.ts";
import { CohortBook } from "../src/server/payments/CohortBook.ts";
import { ConcentrationStateStore } from "../src/server/payments/ConcentrationStateStore.ts";

const root = await mkdtemp(join(tmpdir(), "payout-concentration-smoke-"));
let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (actual, expected, message) =>
  assert(actual === expected, `${message} (got ${actual}, expected ${expected})`);

// ownerRef defaults to groupRef: the ordinary case is one group per paying
// account. Pass it explicitly to model one agent spreading a withdrawal across
// several groups — the self-inflation attack asserted below.
// laneKey is derived exactly as production does (§4, thesis 4): a lane is
// network:asset:denomination, so same-denomination legs share a lane and an exact
// leg has none. Passing it explicitly is mandatory — an absent lane reads as
// laneless and would silently collapse every leg's anonymity to 1, so the module
// throws rather than let a fixture encode that downgrade as a passing test.
const leg = (
  groupRef,
  denominationAtomic = null,
  ownerRef = groupRef,
  { network = "base", asset = "0xasset" } = {},
) => ({
  groupRef,
  ownerRef,
  denominationAtomic,
  laneKey: laneKeyFor({ network, asset, denominationAtomic }),
});

/* ───────────────────────── §2 / §9-1 — k_eff metric ───────────────────────── */

await check("an empty window has k_eff 0 (no gate, no broadcast)", () => {
  eq(computeKEff([]), 0, "empty k_eff");
  eq(distinctGroupCount([]), 0, "empty group count");
});
await check("a lone group is k_eff 1 no matter how many same-denomination legs", () => {
  eq(computeKEff([leg("g1", "100000"), leg("g1", "100000"), leg("g1", "1000000")]), 1, "lone group");
});
await check("all-same-denomination across N groups gives k_eff = N", () => {
  eq(computeKEff(["g1", "g2", "g3", "g4"].map((g) => leg(g, "100000"))), 4, "four groups");
});
await check("k_eff is the MINIMUM across denominations, not the average", () => {
  const window = [
    leg("g1", "100000"), leg("g2", "100000"), leg("g3", "100000"), leg("g4", "100000"),
    leg("g1", "1000000"), leg("g2", "1000000"),
  ];
  eq(computeKEff(window), 2, "the 1000000 legs hide among only two groups");
});
await check("duplicate legs of one denomination from the SAME group do not inflate A", () => {
  eq(computeKEff([leg("g1", "100000"), leg("g1", "100000"), leg("g2", "100000")]), 2, "distinct groups");
});
await check("one agent splitting a withdrawal across N groups CANNOT inflate k_eff", () => {
  // The self-inflation attack: `groupRef` is one x402 quote nonce and quotes are
  // unmetered, so an agent can mint as many groups as it likes. Counted over
  // groups this window would read k_eff = 4 for an anonymity set of ONE — and
  // that lie would be reported to the payer as its realized privacy AND ingested
  // as adaptive-target evidence, holding every honest withdrawer to maxHoldMs
  // waiting on concurrency that never existed.
  const sybil = ["q1", "q2", "q3", "q4"].map((q) => leg(q, "100000", "agent-A"));
  eq(computeKEff(sybil), 1, "four groups, one owner");
  // Same shape, genuinely distinct payers, still counts.
  eq(computeKEff(["a", "b", "c", "d"].map((o) => leg(`q-${o}`, "100000", o))), 4, "four owners");
  // And a sybil cannot dilute-then-hide either: three real payers plus one agent
  // wearing two group refs is three, not four.
  eq(computeKEff([
    leg("q1", "100000", "a"), leg("q2", "100000", "b"),
    leg("q3", "100000", "c"), leg("q4", "100000", "c"),
  ]), 3, "mixed real and duplicated owner");
});
await check("a single-strategy (null-denomination) leg forces k_eff = 1", () => {
  const window = [
    leg("g1", "100000"), leg("g2", "100000"), leg("g3", "100000"), leg("g4", "100000"),
    leg("g5", null),
  ];
  eq(computeKEff(window), 1, "the exact-value leg is conditioned on itself alone");
});

/* ─────────────── §4.1 — release planner (pure decision logic) ─────────────── */

const grp = (groupRef, createdAt, maxHoldMs, denoms, ownerRef = groupRef) => ({
  groupRef, ownerRef, createdAt, maxHoldMs, legs: denoms.map((d) => leg(groupRef, d, ownerRef)),
});

await check("§4.1-4 target met: proceed unchanged, nothing held", () => {
  const d = planWindowRelease(
    ["g1", "g2", "g3", "g4"].map((g) => grp(g, 0, 5_000, ["100000"])),
    { kEffTarget: 4, now: 1_000 },
  );
  eq(d.gated, false, "gate should be inert when k_eff >= target");
  eq(d.releaseGroupRefs.length, 4, "all four released");
  eq(d.heldGroupRefs.length, 0, "none held");
  eq(d.realizedKEff, 4, "realized equals window k_eff");
});
await check("§4.1-6 below target, none past hold: hold everything, realized 0", () => {
  const d = planWindowRelease([grp("g1", 1_000, 5_000, ["100000"])], { kEffTarget: 4, now: 1_000 });
  eq(d.gated, true, "gated");
  eq(d.releaseGroupRefs.length, 0, "nothing released");
  eq(d.heldGroupRefs.length, 1, "the lone group is held");
  eq(d.realizedKEff, 0, "no submitted subset");
});
await check("§4.1-5/7 mixed: only groups past maxHoldMs release; realized over subset", () => {
  // g1 aged past its 5s cap; g2 still inside it. Both are 100000 legs.
  const d = planWindowRelease(
    [grp("g1", 0, 5_000, ["100000"]), grp("g2", 4_000, 5_000, ["100000"])],
    { kEffTarget: 4, now: 6_000 },
  );
  eq(d.gated, true, "still below target so gated");
  eq(d.releaseGroupRefs.join(","), "g1", "only the aged group is force-released");
  eq(d.heldGroupRefs.join(","), "g2", "the young group stays held");
  eq(d.realizedKEff, 1, "the released subset is a single group producing 100000");
});

/* ───────── §4 — queue integration: R1 (no quarantine), R5 (bypass), case 4 ───────── */

let ctxSeq = 0;
const buildQueue = async ({
  kEffTarget, maxHoldMs, concentrationEnabled = true, clock, scheduleMasterSeed, kEffPublishEnabled,
  kEffAdaptive, kEffCeiling, kEffAdaptiveWindowMs, kEffAdaptiveMinSamples, kEffAdaptiveQuantile,
  extraNetworks = [], persist = false, dir: dirOverride,
}) => {
  // `dir` is injectable so a test can build a SECOND queue over the same files —
  // which is what "restart" means here. Nothing else models a restart.
  const dir = dirOverride ?? join(root, `q${ctxSeq += 1}`);
  const makeRail = (network) => ({
    network, kind: "evm", tokenConfig: BASE_USDC,
    refs: new Map(), suppressed: new Set(), submits: 0,
    bindPoolPayoutRef(id, ref) { this.refs.set(id, ref); },
    suppressPoolPayoutRebroadcast(id) { this.suppressed.add(id); },
    outboxEntriesByRef() { return []; },
    async submitPoolPayout(input) {
      this.submits += 1;
      return { network, recipient: input.recipient, amountAtomic: input.amountAtomic, mode: "dry-run" };
    },
  });
  const rail = makeRail("base");
  // A rail that can lose a specific leg terminally. `terminal-absent` is the one
  // verdict the queue treats as proof of non-inclusion, so it drives a member to
  // `failed` rather than leaving it queued for retry — which is what a test of
  // "a member that did not land lowers realized k_eff" needs.
  rail.failRecipients = new Set();
  // And a retryable failure, which is a DIFFERENT outcome: the leg goes back to
  // `queued` rather than terminal, so its cohort stays unresolved.
  rail.retryRecipients = new Set();
  const submit = rail.submitPoolPayout.bind(rail);
  rail.submitPoolPayout = async function submitOrLose(input) {
    if (this.failRecipients.has(input.recipient)) {
      throw new Error("pool payout terminal-absent (smoke)");
    }
    if (this.retryRecipients.has(input.recipient)) throw new Error("smoke rpc blip");
    return submit(input);
  };
  // Additional idle rails, so a test can prove one rail's concurrency does NOT
  // raise another's hold target.
  const rails = new Map([[rail.network, rail], ...extraNetworks.map((n) => [n, makeRail(n)])]);
  const ledger = await new PrivatePaymentLedger(join(dir, "ledger.json"), "smoke-secret", {
    journal: new EphemeralPaymentJournal(join(dir, "epochs")),
    retentionMs: 60_000,
    baseAssetKey: privateLedgerAssetKey(rail.network, rail.tokenConfig.address),
  }).load(Object.fromEntries([
    ["payer", "100000000"],
    // Distinct funded accounts, so a test that means "N concurrent USERS" can
    // write N of them. Concentration counts owners, not groups.
    ...Array.from({ length: 8 }, (_unused, index) => [`payer-${index}`, "100000000"]),
  ]));
  const journal = new PendingPayoutJournal(join(dir, "pending.json"), "smoke-secret");
  const queue = new PoolPayoutQueue({
    journal, ledger, rails,
    flushMs: 1_000_000, maxJitterMs: 0, maxAttempts: 3, reconcileMs: 100,
    recoveryBudgetMs: 100, claimTtlMs: 10_000,
    concentrationEnabled, kEffTarget, maxHoldMs,
    kEffAdaptive, kEffCeiling, kEffAdaptiveWindowMs, kEffAdaptiveMinSamples, kEffAdaptiveQuantile,
    scheduleMasterSeed, scheduleEpochMs: 3_600_000, kEffPublishEnabled,
    concentrationStore: persist
      ? new ConcentrationStateStore(join(dir, "concentration.json"), "smoke-secret")
      : undefined,
    cohortBook: persist ? new CohortBook(join(dir, "cohorts.json"), "smoke-secret") : undefined,
    now: () => clock.t, random: () => 0,
  });
  await queue.recover();
  return { queue, journal, ledger, rail, dir };
};

// `payer` is the OWNER. Tests modelling N concurrent users must pass N distinct
// payers — N groups from one payer is one anonymity set, not N.
const enqueueDenomGroup = async (ctx, denominationAtomic, groupMaxHoldMs, payer = "payer") => {
  const groupRef = `grp-${randomBytes(4).toString("hex")}`;
  const legs = [{
    index: 0, payoutRef: `${groupRef}:0`, recipient: Wallet.createRandom().address,
    amountAtomic: denominationAtomic, ephemeralPubKey: "eph-0", denominationAtomic,
  }];
  const planHash = poolPayoutPlanHash({ groupRef, network: "base", asset: BASE_USDC.address, legs });
  const balance = await ctx.ledger.payout({
    agentId: payer, amountAtomic: denominationAtomic,
    assetKey: privateLedgerAssetKey("base", BASE_USDC.address), network: "base",
    payoutRef: legs[0].payoutRef, planHash,
  });
  await ctx.queue.enqueueGroup({
    groupRef, ownerTag: ctx.ledger.accountReference(payer), network: "base",
    asset: BASE_USDC.address, strategy: "denominations", planHash,
    payerBalanceAtomic: balance.balanceAtomic, legs, offchainChange: null,
    ...(groupMaxHoldMs !== undefined ? { maxHoldMs: groupMaxHoldMs } : {}),
  });
  return groupRef;
};
// A `strategy:"single"` group: one leg carrying the EXACT total with
// denominationAtomic null. This is what a withdrawal that does not tile produces.
const enqueueExactGroup = async (ctx, amountAtomic, payer = "payer") => {
  const groupRef = `exact-${randomBytes(4).toString("hex")}`;
  const legs = [{
    index: 0, payoutRef: groupRef, recipient: Wallet.createRandom().address,
    amountAtomic, ephemeralPubKey: "eph-x", denominationAtomic: null,
  }];
  const planHash = poolPayoutPlanHash({ groupRef, network: "base", asset: BASE_USDC.address, legs });
  const balance = await ctx.ledger.payout({
    agentId: payer, amountAtomic,
    assetKey: privateLedgerAssetKey("base", BASE_USDC.address), network: "base",
    payoutRef: legs[0].payoutRef, planHash,
  });
  await ctx.queue.enqueueGroup({
    groupRef, ownerTag: ctx.ledger.accountReference(payer), network: "base",
    asset: BASE_USDC.address, strategy: "single", planHash,
    payerBalanceAtomic: balance.balanceAtomic, legs, offchainChange: null,
  });
  return groupRef;
};

const legOf = (ctx, groupRef) => ctx.journal.byRef(groupRef).legs[0];

await check("§4.2 R1 — a held group broadcasts nothing and NEVER increments attempts", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock });
  const ref = await enqueueDenomGroup(ctx, "100000"); // k_eff will be 1 < 4 -> held
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 0, "a held leg must not be broadcast");
  eq(legOf(ctx, ref).state, "queued", "a held leg stays queued");
  eq(legOf(ctx, ref).attempts, 0, "R1: a hold is not a failed attempt");
  // Age past the cap; now it must force-release.
  clock.t = 7_000;
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 1, "past maxHoldMs the leg force-releases");
  eq(legOf(ctx, ref).state, "settled", "the released leg settles");
  eq(legOf(ctx, ref).attempts, 1, "exactly one real attempt, well under maxAttempts=3");
});

await check("§4.1-4 case 4 — 6 concurrent groups clear in one pass, no hold", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock });
  // Six distinct PAYERS. Six groups from one payer would be k_eff 1, not 6.
  for (let i = 0; i < 6; i += 1) await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`);
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 6, "all six legs broadcast in a single window");
});

await check("§4.2 R5 — a targeted onlyGroupRef flush bypasses the gate", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 99, maxHoldMs: 5_000, clock });
  const ref = await enqueueDenomGroup(ctx, "100000"); // k_eff = 1 << 99
  await ctx.queue.flushNow("base"); // untargeted: gate holds it
  eq(ctx.rail.submits, 0, "the untargeted window holds under an unreachable target");
  await ctx.queue.flushGroup(ref); // targeted: must bypass and release immediately
  eq(ctx.rail.submits, 1, "R5: the targeted flush released despite k_eff < target");
  eq(legOf(ctx, ref).state, "settled", "targeted release settles");
});

await check("gate OFF reproduces ungated behavior (a lone group flushes immediately)", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 99, maxHoldMs: 5_000, concentrationEnabled: false, clock });
  const ref = await enqueueDenomGroup(ctx, "100000");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 1, "with the gate off a lone group broadcasts at once");
  eq(legOf(ctx, ref).state, "settled", "settled");
});

/* ───────── §5 — client-declared, signature-bound maxHoldMs ───────── */

await check("§5 — a signed client maxHoldMs shortens the hold below the server ceiling", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock }); // server ceiling 5s
  await enqueueDenomGroup(ctx, "100000", 2_000); // client-declared cap 2s
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 0, "still held at t=1000");
  clock.t = 3_200; // held 2200 >= client 2000, but well under server 5000
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 1, "released at the client cap, before the server ceiling");
});

await check("§5 — a client cap above the server ceiling is clamped to the ceiling", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock });
  await enqueueDenomGroup(ctx, "100000", 999_999); // absurd cap
  clock.t = 3_200; // 2200 < server 5000
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 0, "a huge client cap cannot delay past the ceiling either way");
  clock.t = 6_200; // 5200 >= server 5000
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 1, "released at the clamped server ceiling, not the client's 999_999");
});

// A minimal but fully valid single-strategy plan for the validation branch.
const singlePlan = (maxHoldMs) => {
  const body = {
    version: 2, groupRef: "grp", network: "base", asset: "0xasset",
    strategy: "single", policyVersion: "none", quoteRequirementsHash: "0xqrh",
    totalAtomic: "100000", onchainAtomic: "100000", offchainChangeAtomic: "0",
    legs: [{
      index: 0, payoutRef: "grp", amountAtomic: "100000", denominationAtomic: null,
      kind: "exact", recipient: "0xrecipient", ephemeralPubKey: "eph-single",
    }],
    ...(maxHoldMs !== undefined ? { maxHoldMs } : {}),
  };
  return { ...body, planHash: computePlanHash(body) };
};
const validateHold = (plan, ceiling) => validatePlanAgainstPolicy({
  plan, policy: { denominationsAtomic: [], maxLegs: 8 }, policyVersion: "denom/v1",
  asset: "0xasset", totalAtomic: "100000", quoteRequirementsHash: "0xqrh",
  maxHoldMsCeiling: ceiling, resolveRecipient: () => "0xrecipient",
});
const rejects = (fn, pattern) => {
  try { fn(); } catch (error) { return pattern.test(error instanceof Error ? error.message : String(error)); }
  return false;
};

await check("§5 — a capless plan and an in-ceiling cap both validate", () => {
  validateHold(singlePlan(undefined), 5_000);
  validateHold(singlePlan(2_000), 5_000);
});
await check("§5 — a cap above the disclosed ceiling is hard-rejected", () => {
  assert(rejects(() => validateHold(singlePlan(9_000), 5_000), /exceeds the disclosed ceiling/), "over-ceiling");
});
await check("§5 — a non-positive cap is rejected", () => {
  assert(rejects(() => validateHold(singlePlan(0), 5_000), /positive integer/), "zero cap");
});
await check("§5 — tampering with maxHoldMs after signing breaks the plan hash", () => {
  const tampered = { ...singlePlan(2_000), maxHoldMs: 4_000 }; // hash still commits to 2_000
  assert(rejects(() => validateHold(tampered, 5_000), /plan hash mismatch/i), "operator edit must fail the hash");
});

/* ───────── §7 — realized k_eff on the owner-bound claim ───────── */

await check("§7 — the claim reports realized k_eff and heldMs after a forced release", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock });
  const ref = await enqueueDenomGroup(ctx, "100000"); // k_eff 1 < 4 -> held
  await ctx.queue.flushNow("base");
  eq((await ctx.queue.claim(ref)).concentration, undefined, "no metric while still held");
  clock.t = 7_000;
  await ctx.queue.flushNow("base"); // force-release
  const claim = await ctx.queue.claim(ref);
  assert(claim.concentration, "a released group reports concentration");
  eq(claim.concentration.realizedKEff, 1, "realized over the submitted subset (a lone group)");
  eq(claim.concentration.heldMs, 6_000, "heldMs = release time - createdAt");
});

await check("§7 — a concurrent clear reports the full window k_eff, heldMs 0", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock });
  const refs = [];
  for (let i = 0; i < 6; i += 1) refs.push(await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`));
  await ctx.queue.flushNow("base"); // k_eff 6 >= 4, ungated
  const claim = await ctx.queue.claim(refs[0]);
  assert(claim.concentration, "released group reports concentration even when ungated");
  eq(claim.concentration.realizedKEff, 6, "realized equals the full window k_eff");
  eq(claim.concentration.heldMs, 0, "released in its first window");
});

await check("§7 — no realized concentration is recorded when the gate is OFF", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 99, maxHoldMs: 5_000, concentrationEnabled: false, clock });
  const ref = await enqueueDenomGroup(ctx, "100000");
  await ctx.queue.flushNow("base");
  eq((await ctx.queue.claim(ref)).concentration, undefined, "gate off records nothing");
});

/* ───────── §6 — committed-and-revealed jitter schedule ───────── */

await check("§6 — jitter is deterministic, in range, and varies by window", () => {
  const seed = epochSeed("00".repeat(32), 5);
  eq(deriveScheduleJitter(seed, "base", 5, 0, 30_000),
    deriveScheduleJitter(seed, "base", 5, 0, 30_000),
    "same inputs reproduce the same draw (a verifier can recompute it)");
  const draw = deriveScheduleJitter(seed, "base", 5, 0, 30_000);
  assert(draw >= 0 && draw <= 30_000, "draw lands in [0, maxJitterMs]");
  const varies = new Set([0, 1, 2, 3].map((w) => deriveScheduleJitter(seed, "base", 5, w, 30_000)));
  assert(varies.size > 1, "draws vary across windows");
  eq(deriveScheduleJitter(seed, "base", 5, 0, 0), 0, "zero maxJitter yields zero");
});

await check("§4/F3 — the jitter slot is absolute, so a restart cannot rewind it", () => {
  // The defect: the slot used to be an in-memory cursor incremented per draw, so a
  // restart replayed 0, 1, 2… and re-rolled release timing in a way no verifier of
  // the committed schedule could detect. An absolute slot is a pure function of the
  // clock — the same instant yields the same slot no matter how many processes have
  // started since.
  const epochMs = 3_600_000;
  const windowMs = 60_000;
  const at = epochMs * 5 + windowMs * 7 + 123;
  eq(scheduleSlot(at, epochMs, windowMs), 7, "the slot is floor(offset / windowMs)");
  eq(scheduleSlot(at, epochMs, windowMs), scheduleSlot(at, epochMs, windowMs), "pure");
  eq(scheduleSlot(epochMs * 5, epochMs, windowMs), 0, "an epoch opens at slot 0");
  eq(scheduleSlot(epochMs * 6 - 1, epochMs, windowMs), 59, "and closes at the last slot");
  eq(epochOf(at, epochMs), 5, "the epoch is the one the timestamp falls in");
});

await check("§4/F3 — two rails do NOT draw identical jitter in the same slot", () => {
  // Absolute slots introduce a hazard the per-network cursor did not have: without
  // the network in the derivation every rail draws the same value in the same slot
  // and flushes in lockstep, correlating landings across chains for free. The
  // network is public, so binding it costs a verifier nothing.
  const seed = epochSeed("11".repeat(32), 9);
  const drawn = ["base", "robinhood", "solana"]
    .map((network) => deriveScheduleJitter(seed, network, 9, 3, 30_000));
  eq(new Set(drawn).size, 3, "each rail draws independently");
});

await check("§6 — per-epoch seeds isolate reveals and bind distinct commitments", () => {
  const master = "ab".repeat(32);
  const s5 = epochSeed(master, 5);
  const s6 = epochSeed(master, 6);
  assert(s5 !== s6, "revealing one epoch's seed does not reveal another's");
  assert(scheduleCommitment(s5, 5) !== scheduleCommitment(s6, 6), "commitments are epoch-distinct");
});

await check("§6 — the queue commits per epoch and reveals only CLOSED epochs", async () => {
  const master = "cd".repeat(32);
  const clock = { t: 10 * 3_600_000 + 123 }; // epoch 10, partway in
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock, scheduleMasterSeed: master });
  const commit = ctx.queue.scheduleCommitment();
  assert(commit && commit.epoch === 10, "commitment is for the current epoch");
  eq(commit.commitment, scheduleCommitment(epochSeed(master, 10), 10), "commitment matches derivation");
  eq(ctx.queue.revealSchedule(10), undefined, "the open epoch is not revealable");
  eq(ctx.queue.revealSchedule(11), undefined, "a future epoch is not revealable");
  eq(ctx.queue.revealSchedule(9), epochSeed(master, 9),
    "a closed epoch reveals exactly the seed a verifier recomputes its draws from");
});

await check("§6 — with no master seed the queue exposes no commitment", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock }); // no scheduleMasterSeed
  eq(ctx.queue.scheduleCommitment(), undefined, "no committed schedule");
  eq(ctx.queue.revealSchedule(0), undefined, "nothing to reveal");
});

/* ───────── §7 — lagged aggregate publication ───────── */

await check("§7 — the pure histogram excludes live windows and buckets 5+ together", () => {
  const now = 1_000_000;
  const lag = 20_000;
  const h = kEffHistogram([
    { atMs: now - 30_000, kEff: 2 },
    { atMs: now - 25_000, kEff: 2 },
    { atMs: now - 25_000, kEff: 7 },
    { atMs: now - 5_000, kEff: 3 }, // inside the lag — must not appear
  ], now, lag);
  eq(h["2"], 2, "two lagged k_eff=2 windows");
  eq(h["5+"], 1, "k_eff >= 5 is bucketed together");
  eq(h["3"], undefined, "a live window is never published (A3)");
});

await check("§7 — kEffHistogram is gated off unless publication is enabled", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock }); // publish off
  eq(ctx.queue.kEffHistogram(), undefined, "no aggregate without the publish flag");
});

await check("§7 — the queue publishes a window only after it ages past the lag", async () => {
  const clock = { t: 100_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock, kEffPublishEnabled: true });
  for (let i = 0; i < 6; i += 1) await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`); // window k_eff 6
  await ctx.queue.flushNow("base");
  eq(Object.keys(ctx.queue.kEffHistogram(clock.t).buckets).length, 0, "a fresh window is not yet published");
  clock.t = 100_000 + 20_001; // claimTtl 10_000 -> lag 20_000
  const hist = ctx.queue.kEffHistogram(clock.t);
  eq(hist.lagMs, 20_000, "lag = claim TTL + one equal retention period");
  eq(hist.buckets["5+"], 1, "the aged k_eff=6 window lands in the 5+ bucket");
});

/* ───────── §9-8 — recovery: a held leg survives restart (R4) ───────── */

await check("§9-8 R4 — a held leg survives a restart as a queued leg, then releases", async () => {
  const dir = join(root, `restart-${ctxSeq += 1}`);
  const clock = { t: 1_000 };
  const openQueue = async () => {
    const rail = {
      network: "base", kind: "evm", tokenConfig: BASE_USDC,
      refs: new Map(), suppressed: new Set(), submits: 0,
      bindPoolPayoutRef(id, ref) { this.refs.set(id, ref); },
      suppressPoolPayoutRebroadcast(id) { this.suppressed.add(id); },
      outboxEntriesByRef() { return []; },
      async submitPoolPayout(input) {
        this.submits += 1;
        return { network: "base", recipient: input.recipient, amountAtomic: input.amountAtomic, mode: "dry-run" };
      },
    };
    const ledger = await new PrivatePaymentLedger(join(dir, "ledger.json"), "smoke-secret", {
      journal: new EphemeralPaymentJournal(join(dir, "epochs")),
      retentionMs: 60_000,
      baseAssetKey: privateLedgerAssetKey("base", BASE_USDC.address),
    }).load({ payer: "100000000" });
    const journal = new PendingPayoutJournal(join(dir, "pending.json"), "smoke-secret");
    const queue = new PoolPayoutQueue({
      journal, ledger, rails: new Map([["base", rail]]),
      flushMs: 1_000_000, maxJitterMs: 0, maxAttempts: 3, reconcileMs: 100,
      recoveryBudgetMs: 100, claimTtlMs: 10_000,
      concentrationEnabled: true, kEffTarget: 4, maxHoldMs: 5_000,
      now: () => clock.t, random: () => 0,
    });
    await queue.recover();
    return { rail, ledger, journal, queue };
  };

  const before = await openQueue();
  const ref = await enqueueDenomGroup(before, "100000"); // k_eff 1 < 4 -> held
  await before.queue.flushNow("base");
  eq(before.rail.submits, 0, "held before restart");
  eq(before.journal.byRef(ref).legs[0].state, "queued", "a held leg stays an ordinary queued leg");
  eq(before.journal.byRef(ref).legs[0].attempts, 0, "no attempt recorded for a hold");
  before.queue.stop();

  // Restart on the same journal + ledger.
  const after = await openQueue();
  eq(after.journal.byRef(ref).legs[0].state, "queued", "R4: indistinguishable from a never-flushed queued leg");
  clock.t = 7_000; // past the 5s cap
  await after.queue.flushNow("base");
  eq(after.rail.submits, 1, "released after restart with no duplicate broadcast");
  eq(after.journal.byRef(ref).legs[0].state, "settled", "settles cleanly post-restart");
});

/* ─────────────── §14 — adaptive k_eff target (correct at user #1) ─────────────── */

const sampleRun = (kEff, count, atMs = 1_000) =>
  Array.from({ length: count }, () => ({ atMs, kEff }));

await check("§14 — no observations at all ⇒ target 1 (the N=1 guarantee)", () => {
  eq(adaptiveKEffTarget({
    samples: [], nowMs: 10_000, windowMs: 60_000, minSamples: 20, quantile: 0.5, ceiling: 8,
  }), 1, "an empty history can never justify holding anything");
});

await check("§14 — below minSamples ⇒ target 1 even if every observation was high", () => {
  eq(adaptiveKEffTarget({
    samples: sampleRun(8, 19), nowMs: 10_000, windowMs: 60_000,
    minSamples: 20, quantile: 0.5, ceiling: 8,
  }), 1, "19 lucky windows are not evidence of sustained concurrency");
});

await check("§14 — with evidence, the target is the observed quantile", () => {
  eq(adaptiveKEffTarget({
    samples: sampleRun(4, 20), nowMs: 10_000, windowMs: 60_000,
    minSamples: 20, quantile: 0.5, ceiling: 8,
  }), 4, "median of twenty 4s is 4");
});

await check("§14 — invariant 2: the target NEVER exceeds observed concurrency", () => {
  eq(adaptiveKEffTarget({
    samples: sampleRun(2, 50), nowMs: 10_000, windowMs: 60_000,
    minSamples: 20, quantile: 1, ceiling: 64,
  }), 2, "a ceiling of 64 cannot conjure concurrency that never occurred");
});

await check("§14 — the target falls back when traffic dries up", () => {
  eq(adaptiveKEffTarget({
    samples: sampleRun(8, 50, 1_000), nowMs: 10_000_000, windowMs: 60_000,
    minSamples: 20, quantile: 0.5, ceiling: 8,
  }), 1, "observations outside the window are not evidence, so the gate goes inert again");
});

await check("§14 — adaptive ON, a lone payer is broadcast immediately (NO latency tax)", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({
    kEffTarget: 1, maxHoldMs: 5_000, clock,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 3, kEffAdaptiveQuantile: 0.5,
  });
  const ref = await enqueueDenomGroup(ctx, "100000");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 1, "user #1 is not held waiting for a crowd that does not exist");
  eq(legOf(ctx, ref).state, "settled", "settled in its first window");
  const status = ctx.queue.concentrationStatus();
  eq(status.effectiveTarget, 1, "effective target is 1 despite a ceiling of 8");
  eq(status.inertReason, "insufficient-observations", "and it says exactly why it is inert");
});

await check("§7 — the PUBLIC gate surface carries no traffic-derived evidence", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({
    kEffTarget: 1, maxHoldMs: 5_000, clock,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 3, kEffAdaptiveQuantile: 0.5,
  });
  const before = JSON.stringify(ctx.queue.publicConcentrationStatus());
  // Real traffic: enough windows that the operator view demonstrably moves.
  for (let index = 0; index < 4; index += 1) {
    await enqueueDenomGroup(ctx, "100000");
    await ctx.queue.flushNow("base");
    clock.t += 1_000;
  }
  const operator = ctx.queue.concentrationStatus();
  assert(operator.observations > 0, "precondition: the operator view must have recorded evidence");
  const after = ctx.queue.publicConcentrationStatus();
  // /api/privacy is UNAUTHENTICATED. Anything here that moves with traffic is an
  // activity oracle: a poller learns WHEN a payout was requested, and — once broken
  // out per rail — on WHICH rail, which is a direct correlation against the very
  // boundary the gate exists to blur.
  eq(JSON.stringify(after), before, "the public surface changed in response to traffic");
  const keys = Object.keys(after).sort().join(",");
  eq(keys, "adaptive,ceiling,enabled,evidence,staticTarget", "unexpected field on the public surface");
  assert(!("observations" in after), "observations is a live activity beacon");
  assert(!("effectiveTarget" in after), "effectiveTarget announces when cover evaporates");
  assert(!("byNetwork" in after), "byNetwork narrows the beacon to a single rail");
});

await check("§14 — the target rises on its own as real concurrency appears", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({
    kEffTarget: 1, maxHoldMs: 5_000, clock,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 3, kEffAdaptiveQuantile: 0.5,
  });
  // Three windows each carrying two concurrent groups of the same denomination
  // from two DIFFERENT payers — the only thing that is real concurrency.
  for (let window = 0; window < 3; window += 1) {
    await enqueueDenomGroup(ctx, "100000", undefined, "payer-0");
    await enqueueDenomGroup(ctx, "100000", undefined, "payer-1");
    await ctx.queue.flushNow("base");
  }
  eq(ctx.rail.submits, 6, "all six legs broadcast while the gate was still inert");
  const status = ctx.queue.concentrationStatus();
  eq(status.effectiveTarget, 2, "three observations of k_eff=2 raise the target to 2");
  eq(status.byNetwork.base.effectiveTarget, 2, "base is the rail that earned it");
  eq(status.observations, 3, "and the evidence count is reported honestly");
  eq(status.inertReason, undefined, "the gate is now live");

  // Same deployment, no config change, no redeploy: a lone group is now held.
  const lone = await enqueueDenomGroup(ctx, "100000");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 6, "a thin window is now held by a target the system set itself");
  eq(legOf(ctx, lone).attempts, 0, "R1 still holds: a privacy hold is not a failed attempt");
  clock.t += 6_000; // past maxHoldMs
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 7, "and it force-releases at its cap — delay, never refuse");
});

await check("§14 — adaptive OFF leaves the static target exactly as before", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 4, maxHoldMs: 5_000, clock });
  await enqueueDenomGroup(ctx, "100000");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 0, "static target 4 still holds a lone group");
  const status = ctx.queue.concentrationStatus();
  eq(status.adaptive, false, "reported as non-adaptive");
  eq(status.effectiveTarget, 4, "and the effective target is the configured one");
});

/* ───────── §5 — cohort manifests: R8 post-landing, R9 durable, R11 unmixed ───────── */

const recipientOf = async (ctx, groupRef) =>
  (await ctx.queue.claim(groupRef)).legs[0].recipient;

await check("§5/R8 — a member that never lands LOWERS realized k_eff", async () => {
  // The ordering fix, and the whole reason §5 exists. realizedConcentration was
  // written from the release DECISION, before submission began, so it described the
  // cohort that was planned. A member that failed left the number untouched and the
  // payer was told it had cover that never existed.
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 1, maxHoldMs: 60_000, clock });
  const refs = [];
  for (let i = 0; i < 4; i += 1) {
    refs.push(await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`));
  }
  ctx.rail.failRecipients.add(await recipientOf(ctx, refs[0]));
  await ctx.queue.flushNow("base");
  eq((await ctx.queue.claim(refs[0])).legs[0].state, "failed", "the doomed member is terminal");
  const survivor = await ctx.queue.claim(refs[1]);
  eq(survivor.legs[0].state, "settled", "its cohort-mates landed");
  eq(survivor.concentration.realizedKEff, 3,
    "realized counts the three that landed, not the four that were planned");
});

await check("§5/R8 — an unresolved cohort reports NOTHING, never the planned value", async () => {
  // A retryable failure leaves a member queued rather than terminal. Until it
  // resolves the cohort's realized value is unknown, and the honest answer on the
  // self-assessment channel is silence.
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 1, maxHoldMs: 60_000, clock });
  const refs = [];
  for (let i = 0; i < 3; i += 1) {
    refs.push(await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`));
  }
  const doomed = await recipientOf(ctx, refs[0]);
  ctx.rail.retryRecipients.add(doomed);
  await ctx.queue.flushNow("base");
  eq((await ctx.queue.claim(refs[0])).legs[0].state, "queued", "retryable, so not terminal");
  eq((await ctx.queue.claim(refs[1])).concentration, undefined,
    "a settled member of an unfinished cohort still has no realized number");
  // Let the straggler through; the cohort completes and every member can be told.
  ctx.rail.retryRecipients.delete(doomed);
  clock.t += 1_000;
  await ctx.queue.flushNow("base");
  eq((await ctx.queue.claim(refs[1])).concentration.realizedKEff, 3, "resolved once all landed");
});

await check("§5/R11 — an exact leg gets its own cohort, not the denominated one's", async () => {
  // Under a single window-wide manifest the null-denomination leg drags k_eff to 1
  // and every tiled member is reported at 1 — a genuinely 3-way lane described as
  // solitary. Separate manifests report each honestly.
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 1, maxHoldMs: 60_000, clock });
  const tiled = [];
  for (let i = 0; i < 3; i += 1) {
    tiled.push(await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`));
  }
  const exact = await enqueueExactGroup(ctx, "37000000", "payer-3");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 4, "everything went out — an exact leg is never held");
  eq((await ctx.queue.claim(tiled[0])).concentration.realizedKEff, 3,
    "the tiled members had three-way cover and are told so");
  eq((await ctx.queue.claim(exact)).concentration.realizedKEff, 1,
    "the exact leg had none, and is told that");
});

await check("§5/R9 — realized metrics survive a restart", async () => {
  // The claim is the only channel that tells a payer what it actually got. Held in
  // memory it answered `undefined` to anyone who claimed after a deploy.
  const clock = { t: 1_000 };
  const first = await buildQueue({ kEffTarget: 1, maxHoldMs: 60_000, clock, persist: true });
  const refs = [];
  for (let i = 0; i < 3; i += 1) {
    refs.push(await enqueueDenomGroup(first, "100000", undefined, `payer-${i}`));
  }
  await first.queue.flushNow("base");
  eq((await first.queue.claim(refs[0])).concentration.realizedKEff, 3, "resolved before restart");
  const second = await buildQueue({
    kEffTarget: 1, maxHoldMs: 60_000, clock, persist: true, dir: first.dir,
  });
  eq((await second.queue.claim(refs[0])).concentration.realizedKEff, 3,
    "and the new process reports the same realized value");
});

await check("§4/B2 — a held backlog is not new evidence, however long it is held", async () => {
  // The defect: evidence was recorded over the whole window every time the gate
  // ran, so three groups arriving ONCE and then held for fifteen minutes deposited
  // fifteen identical observations. That burst could satisfy minSamples entirely on
  // its own and pin the lane's target long after the traffic that justified it had
  // stopped — the gate holding lone withdrawers on the strength of its own echo.
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 5, maxHoldMs: 600_000, clock });
  for (let i = 0; i < 3; i += 1) await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`);
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 0, "k_eff 3 < target 5, so the burst is held");
  eq(ctx.queue.concentrationStatus().observations, 1, "the arrival is one observation");
  for (let window = 0; window < 5; window += 1) {
    clock.t += 1_000;
    await ctx.queue.flushNow("base");
  }
  eq(ctx.rail.submits, 0, "still held");
  eq(ctx.queue.concentrationStatus().observations, 1,
    "five more windows over the SAME backlog add no evidence");
  // A genuinely new arrival still counts — the rule suppresses echoes, not traffic.
  clock.t += 1_000;
  await enqueueDenomGroup(ctx, "100000", undefined, "payer-4");
  await ctx.queue.flushNow("base");
  eq(ctx.queue.concentrationStatus().observations, 2, "a fresh arrival is evidence");
});

await check("§4/B2 — a fresh arrival beside held groups records ONE, not the window", async () => {
  // The counting rule, not just the guard. When a window mixes one new arrival with
  // held backlog, evidence must record the arrival alone. Recording the window
  // instead lets the same held groups inflate every later observation, so the lane's
  // target stays elevated on traffic that arrived once.
  const clock = { t: 1_000 };
  const ctx = await buildQueue({
    kEffTarget: 1, maxHoldMs: 600_000, clock,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 2, kEffAdaptiveQuantile: 0.5,
  });
  // Two genuinely 3-way windows earn a target of 3.
  for (let window = 0; window < 2; window += 1) {
    for (let i = 0; i < 3; i += 1) {
      await enqueueDenomGroup(ctx, "100000", undefined, `payer-${window * 3 + i}`);
    }
    await ctx.queue.flushNow("base");
    clock.t += 1_000;
  }
  eq(ctx.rail.submits, 6, "both full windows released while the gate was still inert");
  eq(ctx.queue.concentrationStatus().effectiveTarget, 3, "and earned a target of 3");
  // Now two lone arrivals in consecutive windows. The second window contains two
  // groups, but only one of them is new.
  await enqueueDenomGroup(ctx, "100000", undefined, "payer-6");
  await ctx.queue.flushNow("base");
  clock.t += 1_000;
  await enqueueDenomGroup(ctx, "100000", undefined, "payer-7");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 6, "both are held below the target of 3");
  eq(ctx.queue.concentrationStatus().observations, 4, "four windows, four observations");
  // Evidence is [3, 3, 1, 1] → median 1. Counting the window would have recorded
  // [3, 3, 1, 2] → median 2, keeping the lane elevated because two groups it was
  // ALREADY holding happened to sit in the same window.
  eq(ctx.queue.concentrationStatus().effectiveTarget, 1,
    "the median falls to 1: two lone arrivals are evidence of no concurrency");
});

await check("§4/B2 — the marker is durable, so a restart cannot re-count a backlog", async () => {
  // In-memory the rule would be trivially defeatable: restart mid-hold and every
  // held group looks fresh again, which is the same echo with an extra step.
  const clock = { t: 1_000 };
  const first = await buildQueue({ kEffTarget: 5, maxHoldMs: 600_000, clock, persist: true });
  for (let i = 0; i < 3; i += 1) await enqueueDenomGroup(first, "100000", undefined, `payer-${i}`);
  await first.queue.flushNow("base");
  eq(first.queue.concentrationStatus().observations, 1, "counted once before the restart");
  const second = await buildQueue({
    kEffTarget: 5, maxHoldMs: 600_000, clock, persist: true, dir: first.dir,
  });
  eq(second.queue.concentrationStatus().observations, 1, "the observation survived the restart");
  clock.t += 1_000;
  await second.queue.flushNow("base");
  eq(second.queue.concentrationStatus().observations, 1,
    "and the same backlog is still not re-counted by the new process");
});

await check("§4/F3 — adaptive evidence and the reveal seed survive a restart", async () => {
  // Both halves of the same failure: without persistence a restart resets the
  // earned target to 1 (silently releasing everything) AND mints a new master
  // secret, so every commitment published beforehand becomes unrevealable — an
  // accountability scheme erased by a routine deploy.
  const clock = { t: 7_200_000 };
  const options = {
    kEffTarget: 1, maxHoldMs: 5_000, clock, persist: true,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 2, kEffAdaptiveQuantile: 0.5,
  };
  const first = await buildQueue(options);
  for (let window = 0; window < 2; window += 1) {
    await enqueueDenomGroup(first, "100000", undefined, "payer-0");
    await enqueueDenomGroup(first, "100000", undefined, "payer-1");
    await first.queue.flushNow("base");
    clock.t += 1_000;
  }
  eq(first.queue.concentrationStatus().effectiveTarget, 2, "two observations earn a target of 2");
  const commitment = first.queue.scheduleCommitment();
  assert(commitment !== undefined, "concentration on ⇒ a commitment is published");

  const second = await buildQueue({ ...options, dir: first.dir });
  eq(second.queue.concentrationStatus().effectiveTarget, 2,
    "the earned target survives — a restart is not a privacy reset lever");
  eq(second.queue.scheduleCommitment().commitment, commitment.commitment,
    "and the same epoch still commits to the same seed, so the reveal stays verifiable");
});

await check("§3/R11 — one exact leg cannot stall a healthy denominated window", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({ kEffTarget: 3, maxHoldMs: 60_000, clock });
  // Three distinct payers of the same denomination: a genuinely 3-way window.
  for (let i = 0; i < 3; i += 1) await enqueueDenomGroup(ctx, "100000", undefined, `payer-${i}`);
  // Plus ONE non-tiling withdrawal, which publishes its exact value and can never
  // gain cover. Under the window-MINIMUM metric it reads k_eff = 1, so before this
  // fix it dragged the whole window below target and held all three healthy legs
  // to maxHoldMs -- one agent's awkward amount taxing everyone else's latency.
  const exactRef = await enqueueExactGroup(ctx, "3714159", "payer-7");
  await ctx.queue.flushNow("base");
  eq(ctx.rail.submits, 4, "all four legs broadcast: the exact one plus the healthy three");
  // And the exact leg is told the truth about itself rather than the window's number.
  const exactClaim = await ctx.queue.claim(exactRef);
  eq(exactClaim.concentration?.realizedKEff, 1, "an exact leg hides among nothing and is told so");
});

await check("§4 — one rail's concurrency NEVER raises another rail's target", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({
    kEffTarget: 1, maxHoldMs: 5_000, clock,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 3, kEffAdaptiveQuantile: 0.5,
    extraNetworks: ["solana", "robinhood"],
  });
  // Base earns real concurrency: three windows of two distinct payers.
  for (let window = 0; window < 3; window += 1) {
    await enqueueDenomGroup(ctx, "100000", undefined, "payer-0");
    await enqueueDenomGroup(ctx, "100000", undefined, "payer-1");
    await ctx.queue.flushNow("base");
  }
  const status = ctx.queue.concentrationStatus();
  eq(status.byNetwork.base.effectiveTarget, 2, "base earned target 2 from its own traffic");
  // The whole point: the idle rails must be untouched. Sharing one evidence pool
  // would hold a lone Solana or Robinhood withdrawer to maxHoldMs waiting on
  // concurrency that only ever existed on Base.
  eq(status.byNetwork.solana.effectiveTarget, 1, "solana never observed anything, so it stays inert");
  eq(status.byNetwork.robinhood.effectiveTarget, 1, "robinhood likewise");
  eq(status.byNetwork.solana.observations, 0, "and holds no borrowed evidence");
  eq(status.byNetwork.solana.inertReason, "insufficient-observations", "reported honestly");
  // The rollup reports the strongest hold in force anywhere, not a per-rail value.
  eq(status.effectiveTarget, 2, "rollup surfaces the strongest hold");
  eq(status.inertReason, undefined, "and is not inert while any rail is live");
});

// Lane-local targets (spec-exit-rounds.md §4). The cross-RAIL case above already
// held; these are the two cases it could not reach, both inside one rail.
await check("§4 — one denomination's concurrency never raises another's target", async () => {
  const clock = { t: 1_000 };
  const ctx = await buildQueue({
    kEffTarget: 1, maxHoldMs: 5_000, clock,
    kEffAdaptive: true, kEffCeiling: 8, kEffAdaptiveWindowMs: 3_600_000,
    kEffAdaptiveMinSamples: 3, kEffAdaptiveQuantile: 0.5,
  });
  // The 100000 lane earns real concurrency on base. The 1000000 lane, same rail
  // and same asset, has never been used.
  for (let window = 0; window < 3; window += 1) {
    await enqueueDenomGroup(ctx, "100000", undefined, "payer-0");
    await enqueueDenomGroup(ctx, "100000", undefined, "payer-1");
    await ctx.queue.flushNow("base");
  }
  const asset = ctx.rail.tokenConfig.address.toLowerCase();
  const busy = ctx.queue.laneTargetForTest(`base:${asset}:100000`);
  const quiet = ctx.queue.laneTargetForTest(`base:${asset}:1000000`);
  eq(busy, 2, "the busy lane earned target 2 from its own traffic");
  // Before lane-local evidence this was 2: a single shared per-network pool meant a
  // lone withdrawer at an untouched denomination was held to maxHoldMs waiting on
  // concurrency that only ever existed at a different one.
  eq(quiet, 1, "the quiet lane never observed anything, so it stays inert");
});

await check("§4 — an exact leg no longer gates the tiled legs beside it", async () => {
  // The mechanism this whole increment exists to protect. An exact leg has no lane,
  // so under a SINGLE window-wide target its A=1 dragged k_eff to 1 and held every
  // tiled leg in the window. Lane-local targets judge each lane on its own.
  const denominated = [
    leg("g1", "100000", "owner-a"),
    leg("g2", "100000", "owner-b"),
  ];
  const exact = leg("g3", null, "owner-c");
  const groups = [
    { groupRef: "g1", ownerRef: "owner-a", createdAt: 0, maxHoldMs: 60_000, legs: [denominated[0]] },
    { groupRef: "g2", ownerRef: "owner-b", createdAt: 0, maxHoldMs: 60_000, legs: [denominated[1]] },
    { groupRef: "g3", ownerRef: "owner-c", createdAt: 0, maxHoldMs: 60_000, legs: [exact] },
  ];
  // The tiled lane has 2 distinct owners and a target of 2; the exact leg has no
  // lane and therefore no target to miss.
  const laneTarget = (lane) => (lane === laneKeyFor({
    network: "base", asset: "0xasset", denominationAtomic: "100000",
  }) ? 2 : 1);
  const decision = planWindowRelease(groups, { kEffTarget: 2, targetForLane: laneTarget, now: 1_000 });
  eq(decision.gated, false, "the tiled lane met its own target, so nothing is held");
  eq(decision.releaseGroupRefs.length, 3, "including the exact leg, which is judged on its own lane");
  // The reported window k_eff is still honestly 1 — the exact leg really does have
  // an anonymity set of one. What changed is that it no longer PENALIZES its
  // neighbours, not that it is credited with privacy it does not have.
  eq(decision.windowKEff, 1, "k_eff still reports the weakest leg honestly");
  eq(anonymityByLane(groups.flatMap((group) => group.legs)).size, 1, "the exact leg contributes no lane");
});

await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
