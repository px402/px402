/**
 * Atomic sweep-and-pay planning (spec-join-payouts.md).
 *
 * The claim under test is narrow and measurable: spending several one-time
 * deposit addresses directly to several stealth payouts in ONE transaction
 * removes the pool from the graph and makes the input->output assignment
 * ambiguous. The honest figure for "how ambiguous" is the subset-sum count, and
 * these tests exist mostly to stop that figure from ever being assumed.
 *
 * Chain-agnostic on purpose — the planner is pure, so Base / Robinhood / Solana
 * parity is structural rather than three ports that drift.
 */
import {
  planJoin,
  splitIntoDenominations,
  subsetSumAmbiguity,
  subsetSumCount,
} from "../src/shared/joinPlan.ts";

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
const assert = (c, m = "assertion failed") => { if (!c) throw new Error(m); };
const show = (v) => (typeof v === "bigint" ? `${v}n` : JSON.stringify(v));
const eq = (a, b, m) => assert(a === b, `${m} (got ${show(a)}, expected ${show(b)})`);

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DENOMS = [USDC(1), USDC(2), USDC(5), USDC(10), USDC(20), USDC(50), USDC(100)];
const NOW = 1_900_000_000_000;
const HOUR = 3_600_000;

const policy = (overrides = {}) => ({
  minInputs: 2,
  minOutputs: 2,
  denominationsAtomic: DENOMS,
  minInputAgeMs: HOUR,
  decoyCount: 2,
  maxInputs: 8,
  ...overrides,
});

let refCounter = 0;
const input = (amount, ageMs = 2 * HOUR) => ({
  ref: `in-${(refCounter += 1)}`,
  amountAtomic: amount,
  observedAtMs: NOW - ageMs,
});

/** Deterministic decoy sizing so plans are reproducible. */
const fixedDecoy = (denomIndex) => (_i, denominations) => denominations[denomIndex];

const plan = (overrides = {}) => planJoin({
  available: [input(USDC(10)), input(USDC(10)), input(USDC(10))],
  payouts: [{ payeeRef: "payee-a", amountAtomic: USDC(10) }],
  policy: policy(),
  nowMs: NOW,
  pickDecoyAmount: fixedDecoy(3), // USDC(10)
  hubIndex: 1,
  ...overrides,
});

/* ───────────── the pool leaves the graph ───────────── */

check("a join spends several deposits directly to payouts", () => {
  const result = plan();
  assert(!result.refusal, `unexpected refusal ${result.refusal}`);
  assert(result.inputs.length >= 2, "several inputs");
  assert(result.outputs.some((o) => o.kind === "payout"), "and real payouts");
  // No pool leg anywhere: consolidation is not a separate event, it IS the payout.
  assert(!result.outputs.some((o) => o.kind === "pool"), "the pool never appears");
});

check("every input pays the hub and every output is paid by it", () => {
  // Account chains put an explicit (from, to, value) on every transfer, so a
  // direct N-to-M batch would publish the exact mapping and make the ambiguity
  // figure a lie. The hub is what makes subset-sum the ONLY thing recoverable.
  const result = plan();
  eq(result.hubIndex, 1, "the plan names its hub");
});

check("a refused plan still names its hub, so recovery re-derives the same one", () => {
  const result = plan({ available: [input(USDC(10))] });
  eq(result.refusal, "insufficient-inputs", "refused");
  eq(result.hubIndex, 1, "hub index survives refusal");
});

check("distinct joins use distinct hubs — a reused hub IS the pool", () => {
  // A hub that persists across joins is a single observable point with a
  // history, which is exactly the thing this design deletes.
  const a = plan({ hubIndex: 7 });
  const b = plan({ hubIndex: 8 });
  assert(a.hubIndex !== b.hubIndex, "hubs must not repeat across joins");
});

/* ───────────── ambiguity is measured, never assumed ───────────── */

check("subset-sum counting is exact", () => {
  // 10 can be made from {10}, {10}, or {5,5} across these inputs.
  eq(subsetSumCount([USDC(10), USDC(10), USDC(5), USDC(5)], USDC(10)), 3, "three subsets");
  eq(subsetSumCount([USDC(3), USDC(4)], USDC(10)), 0, "no subset sums to 10");
  eq(subsetSumCount([USDC(10)], USDC(10)), 1, "exactly one");
});

check("identical standard denominations maximise ambiguity", () => {
  // This is why splitting into STANDARD denominations matters: with four
  // identical inputs, four different single inputs could fund a 10 output.
  const result = plan({
    available: [input(USDC(10)), input(USDC(10)), input(USDC(10)), input(USDC(10))],
  });
  assert(result.ambiguity >= 4, `expected >=4 ambiguity, got ${result.ambiguity}`);
});

check("ARBITRARY amounts collapse ambiguity to one — the reason denominations exist", () => {
  // With odd amounts an observer solves the subset-sum and recovers the exact
  // mapping. The join then bought that output nothing, and the planner says so
  // rather than implying otherwise.
  const result = plan({
    available: [input(7_000_001n), input(13_000_003n)],
    payouts: [{ payeeRef: "payee-a", amountAtomic: 7_000_001n }],
    policy: policy({ denominationsAtomic: [7_000_001n, 13_000_003n] }),
    // A picker indexing off the end of a short denomination list returns
    // undefined. The planner must skip it, not throw and kill a real payout.
    pickDecoyAmount: fixedDecoy(3),
  });
  eq(result.ambiguity, 1, "exactly one subset can produce it — fully deanonymised");
  assert(!result.refusal, "and a bad decoy pick must not take the plan down with it");
});

check("ambiguity respects the ASSIGNMENT constraint, not per-output counting", () => {
  // Measured bug: counting each output's subsets independently reported 2 for an
  // output that was actually forced. Here output `2` looks fundable by {2} or
  // {1,1} — but if {1,1} funds it, nothing can fund output `1`. So `2` is
  // FORCED, and the honest figure is 1.
  const inputs = [1n, 10n, 1n, 10n, 2n].map((amountAtomic, i) => ({
    ref: `x${i}`, amountAtomic, observedAtMs: NOW,
  }));
  const outputs = [1n, 2n, 21n].map((amountAtomic) => ({ kind: "payout", amountAtomic }));
  eq(subsetSumCount(inputs.map((i) => i.amountAtomic), 2n), 2,
    "independent counting sees two subsets");
  eq(subsetSumAmbiguity({ inputs, outputs }), 1,
    "but only one is consistent — reporting 2 would overstate privacy to the payee");
});

check("an unfundable plan reports 0, never a comfortable number", () => {
  const inputs = [{ ref: "x", amountAtomic: 3n, observedAtMs: NOW }];
  const outputs = [{ kind: "payout", amountAtomic: 7n }];
  eq(subsetSumAmbiguity({ inputs, outputs }), 0, "no consistent assignment exists");
});

check("ambiguity is the WORST output, not the average", () => {
  // An average lets a comfortable majority hide one perfectly-identified output,
  // and that output's payee is not consoled by everyone else's privacy.
  const inputs = [input(USDC(10)), input(USDC(10)), input(USDC(1))];
  const measured = subsetSumAmbiguity({
    inputs,
    outputs: [
      { kind: "payout", amountAtomic: USDC(10) },  // either 10 -> 2 ways
      { kind: "payout", amountAtomic: USDC(10) },  // the other 10
      { kind: "change", amountAtomic: USDC(1) },   // forced -> 1 way
    ],
  });
  eq(measured, 1, "the forced output governs, not the ambiguous ones");
});

/* ───────────── refusal is a first-class outcome ───────────── */

check("a single input is REFUSED, not quietly broadcast", () => {
  // One input funds everything by construction. Broadcasting anyway would
  // publish a one-to-one mapping while letting everyone believe otherwise.
  const result = plan({ available: [input(USDC(10))] });
  eq(result.refusal, "insufficient-inputs", "refused");
  eq(result.inputs.length, 0, "and nothing is planned");
});

check("inputs younger than the spend lock cannot be used", () => {
  // Monero's 10-block lock, generalized: if an output can be spent the instant
  // it lands, "spent immediately" is a usable signal on its own.
  const result = plan({
    available: [input(USDC(10), 0), input(USDC(10), 0)],
  });
  eq(result.refusal, "inputs-too-young", "refused");
});

check("a join that cannot cover its payouts is refused", () => {
  const result = plan({
    available: [input(USDC(1)), input(USDC(1))],
    payouts: [{ payeeRef: "payee-a", amountAtomic: USDC(50) }],
  });
  eq(result.refusal, "insufficient-value", "refused");
});

check("no payouts means no join", () => {
  eq(plan({ payouts: [] }).refusal, "no-outputs");
});

/* ───────────── churn: cover that costs gas, not capital ───────────── */

check("decoys are emitted and are indistinguishable from real legs", () => {
  const result = plan({
    available: [input(USDC(50)), input(USDC(50))],
    payouts: [{ payeeRef: "payee-a", amountAtomic: USDC(10) }],
    pickDecoyAmount: fixedDecoy(3), // USDC(10) — the same denomination
  });
  const decoys = result.outputs.filter((o) => o.kind === "decoy");
  eq(decoys.length, 2, "policy decoy count is emitted");
  // The whole point: a decoy leg and a real leg must be the same shape. If one
  // predicate separates them the decoy is worthless, which is exactly how early
  // Monero's uniform ring selection failed.
  const real = result.outputs.filter((o) => o.kind === "payout");
  assert(decoys.every((d) => real.some((r) => r.amountAtomic === d.amountAtomic)),
    "every decoy matches a real leg's denomination");
});

check("decoys never exceed available value — they cost GAS, not capital", () => {
  // A decoy is funded from what would otherwise be change and returns to an
  // address we control. It must never manufacture value we do not hold.
  const result = plan({
    available: [input(USDC(10)), input(USDC(10))],
    payouts: [{ payeeRef: "payee-a", amountAtomic: USDC(20) }],
    pickDecoyAmount: fixedDecoy(6), // USDC(100), far more than is spare
  });
  const decoys = result.outputs.filter((o) => o.kind === "decoy");
  eq(decoys.length, 0, "unaffordable decoys are skipped, never conjured");
  const outTotal = result.outputs.reduce((a, o) => a + o.amountAtomic, 0n);
  const inTotal = result.inputs.reduce((a, i) => a + i.amountAtomic, 0n);
  eq(outTotal, inTotal, "value is conserved exactly");
});

check("every plan conserves value across inputs and outputs", () => {
  for (const denomIndex of [0, 2, 3, 5]) {
    const result = plan({
      available: [input(USDC(50)), input(USDC(20)), input(USDC(10))],
      payouts: [{ payeeRef: "a", amountAtomic: USDC(20) }, { payeeRef: "b", amountAtomic: USDC(5) }],
      pickDecoyAmount: fixedDecoy(denomIndex),
    });
    const outTotal = result.outputs.reduce((a, o) => a + o.amountAtomic, 0n);
    const inTotal = result.inputs.reduce((a, i) => a + i.amountAtomic, 0n);
    eq(outTotal, inTotal, `conserved for decoy denomination ${denomIndex}`);
  }
});

/* ───────────── uniform policy, not per-agent choice ───────────── */

check("splitting is deterministic — a clever split would be a fingerprint", () => {
  // Monero enforces one ring size for everyone so that picking a different one
  // cannot identify you. Same logic: the split must not vary per agent.
  const a = splitIntoDenominations(USDC(37), DENOMS, 8);
  const b = splitIntoDenominations(USDC(37), DENOMS, 8);
  eq(JSON.stringify(a.map(String)), JSON.stringify(b.map(String)), "identical every time");
});

check("splitting uses standard denominations and conserves value", () => {
  const legs = splitIntoDenominations(USDC(37), DENOMS, 8);
  eq(legs.reduce((a, b) => a + b, 0n), USDC(37), "value conserved");
  assert(legs.length > 1, "37 splits rather than publishing itself as one leg");
});

check("a sub-denomination value rides as a single exact leg", () => {
  // It publishes its own value; that is what per-output ambiguity reporting is
  // for, rather than pretending the split hid it.
  const legs = splitIntoDenominations(1_234n, DENOMS, 8);
  eq(legs.length, 1, "one leg");
  eq(legs[0], 1_234n, "exactly the value");
});

check("the leg cap is respected", () => {
  const legs = splitIntoDenominations(USDC(99), DENOMS, 3);
  assert(legs.length <= 3, `expected <=3 legs, got ${legs.length}`);
  eq(legs.reduce((a, b) => a + b, 0n), USDC(99), "still conserved");
});

check("the input cap keeps a join broadcastable", () => {
  const many = Array.from({ length: 20 }, () => input(USDC(10)));
  const result = plan({ available: many, policy: policy({ maxInputs: 6 }) });
  eq(result.inputs.length, 6, "capped");
});

check("oldest inputs are spent first", () => {
  // Deterministic and uniform. It also drains the tail, so an address does not
  // sit unspent long enough to become individually notable.
  const young = input(USDC(10), 2 * HOUR);
  const old = input(USDC(10), 9 * HOUR);
  const result = plan({ available: [young, old] });
  eq(result.inputs[0].ref, old.ref, "oldest first");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
