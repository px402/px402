import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Wallet, verifyMessage } from "ethers";
import {
  DEFAULT_MAX_PAYOUT_LEGS,
  DEFAULT_MAX_PAYOUT_LEGS_SOLANA,
  ENUM_CAP,
  PAYOUT_POLICY_VERSION,
  assertDenominationParity,
  decomposePayout,
  defaultDenominationsAtomic,
  largestTileableAtMost,
  parsePayoutDenominations,
} from "../src/shared/denominations.ts";
import {
  computePlanHash,
  computeQuoteRequirementsHash,
  validatePlanAgainstPolicy,
} from "../src/shared/payoutPlan.ts";
import {
  poolPayoutV2IntentMessage,
  x402QuoteIntentMessage,
} from "../src/shared/x402AgentIntent.ts";
import {
  preparePoolPayout,
  quantizeWithdrawal,
} from "../src/shared/privateX402Client.ts";
import {
  BASE_USDC,
  buildPaymentRequirements,
} from "../src/shared/x402.ts";
import {
  checkStealthAddress,
  generateStealthKeys,
} from "../src/shared/stealth.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";

let passed = 0;
const test = async (name, body) => {
  await body();
  passed += 1;
  console.log(`PASS ${name}`);
};

const sumLegs = (plan) =>
  plan.legs.reduce((sum, leg) => sum + BigInt(leg.amountAtomic), 0n);

const seededRandom = (initial) => {
  let state = initial >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
};

const defaultPolicy = {
  denominationsAtomic: defaultDenominationsAtomic(6),
  maxLegs: DEFAULT_MAX_PAYOUT_LEGS,
};

await test("distribution uses multiple exact denomination multisets", () => {
  const multisets = new Set();
  const random = seededRandom(0x51a7f00d);
  for (let index = 0; index < 200; index += 1) {
    const plan = decomposePayout({ totalAtomic: "3700000", config: defaultPolicy, random });
    assert.equal(plan.strategy, "denominations");
    assert.equal(sumLegs(plan), 3_700_000n);
    assert.ok(plan.legs.length <= defaultPolicy.maxLegs);
    for (const leg of plan.legs) {
      assert.ok(defaultPolicy.denominationsAtomic.includes(BigInt(leg.amountAtomic)));
      assert.equal(leg.denominationAtomic, leg.amountAtomic);
    }
    multisets.add(plan.legs.map((leg) => leg.amountAtomic).sort().join(","));
  }
  assert.ok(multisets.size >= 2, `expected >=2 multisets, got ${multisets.size}`);
});

await test("injected RNG is deterministic", () => {
  const left = decomposePayout({ totalAtomic: "3700000", config: defaultPolicy, random: () => 0 });
  const right = decomposePayout({ totalAtomic: "3700000", config: defaultPolicy, random: () => 0 });
  assert.deepEqual(left, right);
});

await test("dust and huge totals terminate with exact single legs", () => {
  const started = performance.now();
  const dust = decomposePayout({ totalAtomic: "1", config: defaultPolicy, random: () => 0 });
  const huge = decomposePayout({
    totalAtomic: "1000000000000000",
    config: defaultPolicy,
    random: () => 0,
  });
  assert.equal(dust.strategy, "single");
  assert.equal(huge.strategy, "single");
  assert.equal(dust.legs[0].amountAtomic, "1");
  assert.equal(huge.legs[0].amountAtomic, "1000000000000000");
  assert.ok(performance.now() - started < 5_000, "bounded decomposition exceeded 5 seconds");
});

await test("1000 varied totals preserve value and the hard leg cap", () => {
  const policy = { denominationsAtomic: [1n, 2n, 5n, 10n, 20n], maxLegs: 4 };
  const random = seededRandom(0xc0ffee);
  for (let index = 0; index < 1_000; index += 1) {
    const total = BigInt(1 + Math.floor(random() * 5_000)).toString();
    const plan = decomposePayout({ totalAtomic: total, config: policy, random });
    assert.equal(plan.totalAtomic, total);
    assert.equal(plan.onchainAtomic, total);
    assert.equal(plan.offchainChangeAtomic, "0");
    assert.equal(sumLegs(plan), BigInt(total));
    assert.ok(plan.legs.length <= policy.maxLegs);
  }
});

await test("non-tileable sub-denomination residual falls back to one exact leg", () => {
  const plan = decomposePayout({ totalAtomic: "3714159", config: defaultPolicy, random: () => 0 });
  assert.equal(plan.strategy, "single");
  assert.deepEqual(plan.legs, [{
    index: 0,
    amountAtomic: "3714159",
    denominationAtomic: null,
    kind: "exact",
  }]);
});

await test("off-chain change is hard-disabled", () => {
  assert.throws(() => decomposePayout({
    totalAtomic: "3700000",
    config: defaultPolicy,
    offchainChange: true,
  }));
});

await test("configuration parser supplies 1-2-5 defaults and per-network caps", () => {
  const parsed = parsePayoutDenominations(undefined, [
    { network: "base", decimals: 6, maxLegs: 8 },
    { network: "solana", decimals: 6, maxLegs: 3 },
  ]);
  assert.deepEqual(parsed.get("base")?.denominationsAtomic, [
    100_000n, 200_000n, 500_000n, 1_000_000n, 2_000_000n,
    5_000_000n, 10_000_000n, 20_000_000n, 50_000_000n, 100_000_000n,
  ]);
  assert.equal(parsed.get("base")?.maxLegs, 8);
  assert.equal(parsed.get("solana")?.maxLegs, 3);
});

await test("configuration parser accepts array and object forms", () => {
  const parsed = parsePayoutDenominations(JSON.stringify({
    base: ["1", "2", "5"],
    solana: { denominationsAtomic: [10, 20], maxLegs: 2 },
  }), [
    { network: "base", decimals: 6, maxLegs: 8 },
    { network: "solana", decimals: 6, maxLegs: 3 },
  ]);
  assert.deepEqual(parsed.get("base"), { denominationsAtomic: [1n, 2n, 5n], maxLegs: 8 });
  assert.deepEqual(parsed.get("solana"), { denominationsAtomic: [10n, 20n], maxLegs: 2 });
});

await test(`configuration parser rejects searches above ENUM_CAP=${ENUM_CAP}`, () => {
  assert.throws(() => parsePayoutDenominations(JSON.stringify({
    base: {
      denominationsAtomic: Array.from({ length: 20 }, (_, index) => index + 1),
      maxLegs: 20,
    },
  }), [{ network: "base", decimals: 6 }]));
});

const validationPolicy = { denominationsAtomic: [1n, 2n, 5n], maxLegs: 4 };
const quoteRequirementsHash = "0xquote";
const asset = "0xasset";
const recipientFor = (announcement) => `recipient:${announcement}`;

const makePlan = ({
  amounts = ["2", "2"],
  strategy = "denominations",
  totalAtomic = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString(),
  onchainAtomic = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString(),
  offchainChangeAtomic = "0",
  groupRef = "group",
  policyVersion = strategy === "single" ? "none" : PAYOUT_POLICY_VERSION,
} = {}) => {
  const body = {
    version: 2,
    groupRef,
    network: "base",
    asset,
    strategy,
    policyVersion,
    quoteRequirementsHash,
    totalAtomic,
    onchainAtomic,
    offchainChangeAtomic,
    legs: amounts.map((amountAtomic, index) => {
      const ephemeralPubKey = `announcement-${index}`;
      return {
        index,
        payoutRef: strategy === "single" ? groupRef : `${groupRef}:${index}`,
        amountAtomic,
        denominationAtomic: strategy === "single" ? null : amountAtomic,
        kind: strategy === "single" ? "exact" : "denomination",
        recipient: recipientFor(ephemeralPubKey),
        stealthAddress: recipientFor(ephemeralPubKey),
        ephemeralPubKey,
      };
    }),
  };
  return { ...body, planHash: computePlanHash(body) };
};

const validationInput = (plan, overrides = {}) => ({
  plan,
  policy: validationPolicy,
  policyVersion: PAYOUT_POLICY_VERSION,
  asset,
  totalAtomic: plan.totalAtomic,
  quoteRequirementsHash,
  resolveRecipient: recipientFor,
  ...overrides,
});

const rehash = (plan) => {
  const { planHash: _ignored, ...body } = plan;
  return { ...body, planHash: computePlanHash(body) };
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const validPlan = makePlan();
await test("fully valid plan passes all structural policy checks", () => {
  validatePlanAgainstPolicy(validationInput(validPlan));
});

await test("plan hash changes when an ordered leg amount changes", () => {
  const changed = clone(validPlan);
  changed.legs[0].amountAtomic = "1";
  assert.notEqual(computePlanHash(changed), validPlan.planHash);
});

await test("plan hash changes when an announcement changes", () => {
  const changed = clone(validPlan);
  changed.legs[0].ephemeralPubKey = "different";
  assert.notEqual(computePlanHash(changed), validPlan.planHash);
});

const rejectsPlan = async (name, mutate, overrides = {}) => {
  await test(name, () => {
    const changed = mutate(clone(validPlan));
    assert.throws(() => validatePlanAgainstPolicy(validationInput(changed, overrides)));
  });
};

await rejectsPlan("validator rejects bad leg sum (invariant 1)", (plan) =>
  rehash({ ...plan, onchainAtomic: "5", totalAtomic: "5" }));
await rejectsPlan("validator rejects onchain+change total mismatch (invariant 2)", (plan) =>
  rehash({ ...plan, offchainChangeAtomic: "1" }));
await rejectsPlan("validator rejects a non-denomination leg (invariant 3a)", (plan) => {
  plan.legs[0].amountAtomic = "1";
  plan.legs[0].denominationAtomic = "1";
  plan.legs[1].amountAtomic = "3";
  plan.legs[1].denominationAtomic = "3";
  return rehash(plan);
});
await test("validator rejects malformed single strategy (invariant 3b)", () => {
  const plan = makePlan({ amounts: ["2", "2"], strategy: "single" });
  assert.throws(() => validatePlanAgainstPolicy(validationInput(plan)));
});
await test("validator rejects over-maxLegs (invariant 4)", () => {
  assert.throws(() => validatePlanAgainstPolicy(validationInput(validPlan, {
    policy: { denominationsAtomic: [1n, 2n, 5n], maxLegs: 1 },
  })));
});
await rejectsPlan("validator rejects duplicate announcements (invariant 5a)", (plan) => {
  plan.legs[1].ephemeralPubKey = plan.legs[0].ephemeralPubKey;
  plan.legs[1].recipient = plan.legs[0].recipient;
  plan.legs[1].stealthAddress = plan.legs[0].stealthAddress;
  return rehash(plan);
});
await rejectsPlan("validator rejects announcement/recipient mismatch (invariant 5b)", (plan) => {
  plan.legs[0].recipient = "wrong-recipient";
  plan.legs[0].stealthAddress = "wrong-recipient";
  return rehash(plan);
});
await rejectsPlan("validator rejects a tampered planHash (invariant 6)", (plan) => {
  plan.planHash = "0xtampered";
  return plan;
});
await rejectsPlan("validator rejects a wrong quote hash (invariant 7 quote)", (plan) =>
  rehash({ ...plan, quoteRequirementsHash: "0xwrong" }));
await rejectsPlan("validator rejects a wrong asset (invariant 7 asset)", (plan) =>
  rehash({ ...plan, asset: "0xwrong" }));
await rejectsPlan("validator rejects a wrong policy version (invariant 7 policy)", (plan) =>
  rehash({ ...plan, policyVersion: "denom/wrong" }));
await test("validator rejects off-chain change even when values conserve (invariant 9)", () => {
  const plan = makePlan({
    amounts: ["2", "1"],
    totalAtomic: "4",
    onchainAtomic: "3",
    offchainChangeAtomic: "1",
  });
  assert.throws(() => validatePlanAgainstPolicy(validationInput(plan)));
});
await rejectsPlan("validator rejects an off-chain change component (invariant 9 shape)", (plan) => {
  plan.offchainChange = { amountAtomic: "0" };
  return plan;
});

await test("v2 intent signature binds every plan field and ordered announcement", async () => {
  const signer = Wallet.createRandom();
  const messageInput = {
    payerAgentId: "payer",
    payeeAgentId: "payee",
    groupRef: validPlan.groupRef,
    network: validPlan.network,
    asset: validPlan.asset,
    strategy: validPlan.strategy,
    policyVersion: validPlan.policyVersion,
    quoteRequirementsHash: validPlan.quoteRequirementsHash,
    totalAtomic: validPlan.totalAtomic,
    onchainAtomic: validPlan.onchainAtomic,
    offchainChangeAtomic: validPlan.offchainChangeAtomic,
    planHash: validPlan.planHash,
    legs: validPlan.legs.map(({ index, amountAtomic, ephemeralPubKey }) => ({
      index,
      amountAtomic,
      ephemeralPubKey,
    })),
  };
  const signature = await signer.signMessage(poolPayoutV2IntentMessage(messageInput));
  assert.equal(verifyMessage(poolPayoutV2IntentMessage(messageInput), signature), signer.address);
  assert.notEqual(
    verifyMessage(poolPayoutV2IntentMessage({ ...messageInput, totalAtomic: "5" }), signature),
    signer.address,
  );
});

class FakeLedger {
  constructor(balanceAtomic, failAt = -1) {
    this.balanceAtomic = BigInt(balanceAtomic);
    this.failAt = failAt;
    this.calls = 0;
    this.reservations = new Map();
  }
  balance() {
    return this.balanceAtomic.toString();
  }
  accountReference(agentId) {
    return `acct:${agentId}`;
  }
  async payout(input) {
    if (this.calls === this.failAt) {
      this.calls += 1;
      throw new Error("injected reservation failure");
    }
    this.calls += 1;
    const existing = this.reservations.get(input.payoutRef);
    if (existing) {
      assert.deepEqual(existing.binding, input);
      return { duplicate: true, balanceAtomic: this.balanceAtomic.toString() };
    }
    const amount = BigInt(input.amountAtomic);
    if (this.balanceAtomic < amount) throw new Error("fake insufficient balance");
    this.balanceAtomic -= amount;
    this.reservations.set(input.payoutRef, { amount, binding: input });
    return { duplicate: false, balanceAtomic: this.balanceAtomic.toString() };
  }
  async reversePayout(payoutRef) {
    const reservation = this.reservations.get(payoutRef);
    if (reservation) {
      this.balanceAtomic += reservation.amount;
      this.reservations.delete(payoutRef);
    }
  }
}

class FakeQueue {
  enqueued = [];
  async enqueueGroup(input) {
    this.enqueued.push(input);
    return {
      kind: "pool-payout-queued",
      groupRef: input.groupRef,
      network: input.network,
      strategy: input.strategy,
      legs: input.legs,
      offchainChangeAtomic: "0",
      state: "queued",
      payerBalanceAtomic: input.payerBalanceAtomic,
      estimatedSubmitBeforeMs: Date.now(),
    };
  }
}

const makeIntegration = async ({ amountAtomic = "3700000", failAt = -1 } = {}) => {
  const payerIdentity = Wallet.createRandom();
  const payeeIdentity = Wallet.createRandom();
  const stealth = generateStealthKeys();
  const payerAgentId = `payer-${randomBytes(4).toString("hex")}`;
  const payeeAgentId = `payee-${randomBytes(4).toString("hex")}`;
  const ledger = new FakeLedger("10000000", failAt);
  const queue = new FakeQueue();
  const rail = {
    network: "base",
    kind: "evm",
    tokenConfig: BASE_USDC,
    buildQuote(input) {
      const requirements = buildPaymentRequirements({
        payTo: input.payee.walletAddress,
        maxAmountRequired: input.amountAtomic,
        resource: input.resource,
        validForSeconds: input.validForSeconds,
        token: BASE_USDC,
        nowSeconds: input.nowSeconds,
      });
      requirements.stealthMetaAddress = input.payee.stealthMeta;
      return requirements;
    },
    resolveRecipient(input) {
      if (!input.ephemeralPubKey || !input.payee.stealthViewingKey || !input.payee.stealthMeta) {
        throw new Error("missing fake stealth input");
      }
      const checked = checkStealthAddress({
        ephemeralPubKey: input.ephemeralPubKey,
        viewingKey: input.payee.stealthViewingKey,
        spendingPubKey: input.payee.stealthMeta.spendingPubKey,
      });
      return {
        recipient: checked.stealthAddress,
        stealth: {
          stealthAddress: checked.stealthAddress,
          ephemeralPubKey: input.ephemeralPubKey,
        },
      };
    },
  };
  const registry = new PrivateAgentRegistry([
    {
      agentId: payerAgentId,
      label: "payer",
      vpnIp: "127.0.0.1",
      walletAddress: Wallet.createRandom().address,
      identityAddress: payerIdentity.address,
      sharedSecret: "payer-secret",
      credits: 0,
      inventory: [],
    },
    {
      agentId: payeeAgentId,
      label: "payee",
      vpnIp: "127.0.0.2",
      walletAddress: Wallet.createRandom().address,
      identityAddress: payeeIdentity.address,
      sharedSecret: "payee-secret",
      credits: 0,
      inventory: [],
      stealthMeta: stealth.meta,
      stealthViewingKey: stealth.viewingKey,
    },
  ], {
    privateLedger: ledger,
    rails: new Map([["base", rail]]),
    payoutQueue: queue,
    payout: {
      enabled: true,
      policyVersion: PAYOUT_POLICY_VERSION,
      byNetwork: new Map([["base", defaultPolicy]]),
    },
  });
  const now = Math.floor(Date.now() / 1_000);
  const intentNonce = `0x${randomBytes(32).toString("hex")}`;
  const resource = "denomination-smoke";
  const quote = await registry.quoteX402({
    payeeAgentId,
    payerAgentId,
    amountAtomic,
    resource,
    validForSeconds: 600,
    network: "base",
    intentNonce,
    agentSignature: await payeeIdentity.signMessage(x402QuoteIntentMessage({
      payeeAgentId,
      payerAgentId,
      amountAtomic,
      resource,
      validForSeconds: 600,
      network: "base",
      intentNonce,
    })),
  }, "127.0.0.2", BASE_USDC, now);
  const prepared = await preparePoolPayout({
    requirements: quote,
    identitySigner: payerIdentity,
    payerAgentId,
    payeeAgentId,
    network: "base",
  });
  assert.ok("plan" in prepared);
  return { registry, ledger, queue, quote, prepared, now, payerIdentity, rail };
};

/** The v1 scalar prepared payout (no denomination policy advertised). */
const prepareScalarV1 = async (integration) => {
  const { payoutPolicy: _ignored, ...requirements } = integration.quote;
  const prepared = await preparePoolPayout({
    requirements,
    identitySigner: integration.payerIdentity,
    payerAgentId: integration.prepared.payerAgentId,
    payeeAgentId: integration.prepared.payeeAgentId,
    network: "base",
  });
  assert.ok("quoteNonce" in prepared);
  return prepared;
};

const signPreparedPlan = (identity, prepared, plan) =>
  identity.signMessage(poolPayoutV2IntentMessage({
    payerAgentId: prepared.payerAgentId,
    payeeAgentId: prepared.payeeAgentId,
    groupRef: plan.groupRef,
    network: plan.network,
    asset: plan.asset,
    strategy: plan.strategy,
    policyVersion: plan.policyVersion,
    quoteRequirementsHash: plan.quoteRequirementsHash,
    totalAtomic: plan.totalAtomic,
    onchainAtomic: plan.onchainAtomic,
    offchainChangeAtomic: plan.offchainChangeAtomic,
    planHash: plan.planHash,
    legs: plan.legs.map(({ index, amountAtomic, ephemeralPubKey }) => ({
      index,
      amountAtomic,
      ephemeralPubKey,
    })),
  }));

await test("client produces distinct multi-leg announcements and server conserves value", async () => {
  const integration = await makeIntegration();
  const { prepared } = integration;
  assert.equal(prepared.plan.quoteRequirementsHash, computeQuoteRequirementsHash(integration.quote));
  assert.equal(new Set(prepared.plan.legs.map((leg) => leg.ephemeralPubKey)).size, prepared.plan.legs.length);
  const ack = await integration.registry.enqueuePoolPayout(prepared, "127.0.0.1", integration.now);
  assert.equal(ack.version, 2);
  assert.equal(ack.status, "queued");
  assert.equal(sumLegs(prepared.plan), BigInt(prepared.plan.totalAtomic));
  assert.equal(integration.ledger.balanceAtomic, 10_000_000n - BigInt(prepared.plan.totalAtomic));
  assert.equal(integration.queue.enqueued.length, 1);
  const queued = integration.queue.enqueued[0];
  assert.deepEqual(Object.keys(queued).sort(), [
    "asset", "groupRef", "legs", "network", "offchainChange", "ownerTag",
    "payerBalanceAtomic", "planHash", "strategy",
  ]);
  assert.equal(queued.planHash, prepared.plan.planHash);
});

await test("partial reservation failure compensates every newly reserved leg", async () => {
  const integration = await makeIntegration({ failAt: 1 });
  await assert.rejects(
    integration.registry.enqueuePoolPayout(integration.prepared, "127.0.0.1", integration.now),
    /injected reservation failure/,
  );
  assert.equal(integration.ledger.balanceAtomic, 10_000_000n);
  assert.equal(integration.ledger.reservations.size, 0);
  assert.equal(integration.queue.enqueued.length, 0);
});

await test("single-strategy v2 plan uses a bare groupRef and exact leg", async () => {
  const integration = await makeIntegration({ amountAtomic: "3714159" });
  assert.equal(integration.prepared.plan.strategy, "single");
  assert.equal(integration.prepared.plan.policyVersion, "none");
  assert.equal(integration.prepared.plan.legs.length, 1);
  assert.equal(integration.prepared.plan.legs[0].payoutRef, integration.prepared.plan.groupRef);
  const ack = await integration.registry.enqueuePoolPayout(
    integration.prepared,
    "127.0.0.1",
    integration.now,
  );
  assert.equal(ack.version, 2);
});

await test("v1 client path remains scalar when the quote advertises no policy", async () => {
  const integration = await makeIntegration();
  const { payoutPolicy: _ignored, ...requirements } = integration.quote;
  const prepared = await preparePoolPayout({
    requirements,
    identitySigner: integration.payerIdentity,
    payerAgentId: integration.prepared.payerAgentId,
    payeeAgentId: integration.prepared.payeeAgentId,
    network: "base",
  });
  assert.ok("quoteNonce" in prepared);
  assert.equal(prepared.quoteNonce, requirements.nonce);
  assert.equal(prepared.ephemeralPubKeys?.length, 1);
});

// §2.5 review F1 (Grok, 2026-08-06): the synchronous flag-off path must never
// tell a payer "failed" for a payout that is merely DELAYED — the reserved debit
// stays live and settles later, so a payer who believes the failure re-quotes
// and pays twice.
await test("a quarantined settler refuses the synchronous payout BEFORE consuming anything", async () => {
  const integration = await makeIntegration();
  const prepared = await prepareScalarV1(integration);
  integration.rail.settlerQuarantined = () => true;
  integration.queue.flushGroup = async () => { throw new Error("flush must not be reached"); };
  await assert.rejects(
    integration.registry.enqueuePoolPayout(prepared, "127.0.0.1", integration.now),
    /quarantined pending operator review/,
  );
  assert.equal(integration.ledger.balanceAtomic, 10_000_000n, "nothing may be debited");
  assert.equal(integration.queue.enqueued.length, 0, "nothing may be enqueued");
  // The quote was NOT consumed: the identical prepared payout succeeds once the
  // quarantine lifts — the retry story the refusal message promises.
  integration.rail.settlerQuarantined = () => false;
  integration.queue.flushGroup = async () => {};
  integration.queue.claim = async () => ({
    groupRef: prepared.quoteNonce,
    groupState: "settled",
    network: "base",
    legs: [{ index: 0, state: "settled", mode: "onchain", transactionHash: "0xok", terminalAt: Date.now() }],
    offchainChange: null,
  });
  const receipt = await integration.registry.enqueuePoolPayout(prepared, "127.0.0.1", integration.now);
  assert.equal(receipt.kind, "pool-payout");
  assert.equal(receipt.transactionHash, "0xok");
});

await test("a leg still queued after the flush reports DELAYED, never failed", async () => {
  // The race flavor: the quarantine landed after the quote and debit were
  // consumed, so the leg comes back from the flush still queued. The old
  // response for this state was the literal "Pool payout failed" — an asserted
  // outcome that was false.
  const integration = await makeIntegration();
  const prepared = await prepareScalarV1(integration);
  integration.queue.flushGroup = async () => {};
  integration.queue.claim = async () => ({
    groupRef: prepared.quoteNonce,
    groupState: "pending",
    network: "base",
    legs: [{ index: 0, state: "queued", amountAtomic: "3700000" }],
    offchainChange: null,
  });
  await assert.rejects(
    integration.registry.enqueuePoolPayout(prepared, "127.0.0.1", integration.now),
    (error) => /delayed on base/.test(error.message)
      && /not a failure/.test(error.message)
      && !/Pool payout failed/.test(error.message),
  );
  assert.equal(
    integration.ledger.balanceAtomic,
    10_000_000n - 3_700_000n,
    "the reserved debit is genuinely held in this case — which is why the message must say so",
  );
});

await test("server rejects a v2 plan signed by the wrong identity (invariant 8)", async () => {
  const integration = await makeIntegration();
  const wrong = { ...integration.prepared, agentSignature: "0x00" };
  await assert.rejects(
    integration.registry.enqueuePoolPayout(wrong, "127.0.0.1", integration.now),
    /signature invalid/,
  );
  assert.equal(integration.ledger.balanceAtomic, 10_000_000n);
});

await test("server rejects a correctly signed plan for the wrong rail network (invariant 7)", async () => {
  const integration = await makeIntegration();
  const changed = clone(integration.prepared.plan);
  changed.network = "robinhood";
  const plan = rehash(changed);
  const wrongNetwork = {
    ...integration.prepared,
    plan,
    agentSignature: await signPreparedPlan(integration.payerIdentity, integration.prepared, plan),
  };
  await assert.rejects(
    integration.registry.enqueuePoolPayout(wrongNetwork, "127.0.0.1", integration.now),
    /network mismatch/,
  );
  assert.equal(integration.ledger.balanceAtomic, 10_000_000n);
});

// spec-exit-rounds.md §3.1 — quantization end to end: a value that would have
// published its exact amount instead becomes a standard-denomination plan.
await test("quantizeWithdrawal converts an exact-leg withdrawal into a tiled one", () => {
  const denominationsAtomic = defaultDenominationsAtomic(6);
  const asPolicy = (maxLegs) => ({ denominationsAtomic: denominationsAtomic.map(String), maxLegs });
  const strategyOf = (totalAtomic, maxLegs) => decomposePayout({
    totalAtomic, config: { denominationsAtomic: [...denominationsAtomic], maxLegs }, random: () => 0.5,
  }).strategy;

  // Solana's cap is where this bites hardest: 37 USDC has no 3-leg tiling, so
  // today it publishes "37000000" on-chain with an anonymity set of one.
  assert.equal(strategyOf("37000000", 3), "single");
  const solana = quantizeWithdrawal({ amountAtomic: "37000000", policy: asPolicy(3) });
  assert.equal(solana.quantizedAtomic, "35000000");
  assert.equal(solana.residueAtomic, "2000000", "the remainder stays as ledger balance");
  assert.equal(solana.aboveCeiling, false);
  assert.equal(solana.exact, false);
  assert.equal(strategyOf(solana.quantizedAtomic, 3), "denominations", "leak closed");

  // An amount that already tiles must be returned untouched -- quantization may
  // never cost a caller value it did not need to give up.
  const untouched = quantizeWithdrawal({ amountAtomic: "30000000", policy: asPolicy(3) });
  assert.equal(untouched.quantizedAtomic, "30000000");
  assert.equal(untouched.residueAtomic, "0");
  assert.equal(untouched.exact, true);

  // Above maxLegs x max(denomination) nothing can ever tile. This is the ONLY
  // case worth refusing; refusing on ordinary residue would reject nearly every
  // real withdrawal (spec §3.3).
  const ceiling = quantizeWithdrawal({ amountAtomic: "5000000000", policy: asPolicy(8) });
  assert.equal(ceiling.aboveCeiling, true);
  assert.equal(ceiling.quantizedAtomic, "800000000", "still quantizes to the reachable maximum");

  // Below the smallest denomination there is no tiling at all.
  const dust = quantizeWithdrawal({ amountAtomic: "50000", policy: asPolicy(8) });
  assert.equal(dust.quantizedAtomic, null);
  assert.equal(dust.residueAtomic, "50000");
  assert.equal(dust.aboveCeiling, false);

  assert.throws(() => quantizeWithdrawal({ amountAtomic: "0", policy: asPolicy(8) }));
});

await test("preparePoolPayout reports an exact-leg fallback through onExactLeg", async () => {
  const seen = [];
  // 3714159 atomic does not tile, so this plan publishes its exact value. The
  // callback is how a caller finds that out; nothing can be repaired here,
  // because the plan total is pinned to the quoted total.
  const integration = await makeIntegration({ amountAtomic: "3714159" });
  const prepared = await preparePoolPayout({
    requirements: integration.quote,
    identitySigner: integration.payerIdentity,
    payerAgentId: integration.prepared.payerAgentId,
    payeeAgentId: integration.prepared.payeeAgentId,
    network: "base",
    onExactLeg: (info) => seen.push(info),
  });
  assert.equal(prepared.plan.strategy, "single");
  assert.equal(seen.length, 1, "callback fired exactly once");
  assert.equal(seen[0].reason, "not-tileable");
  assert.equal(seen[0].totalAtomic, "3714159");
  assert.equal(seen[0].network, "base");

  // And it must stay silent on a plan that tiles, or it is noise.
  const quiet = [];
  const tiled = await makeIntegration({ amountAtomic: "3700000" });
  const tiledPlan = await preparePoolPayout({
    requirements: tiled.quote,
    identitySigner: tiled.payerIdentity,
    payerAgentId: tiled.prepared.payerAgentId,
    payeeAgentId: tiled.prepared.payeeAgentId,
    network: "base",
    onExactLeg: (info) => quiet.push(info),
  });
  assert.equal(tiledPlan.plan.strategy, "denominations");
  assert.equal(quiet.length, 0, "no callback on a tiled plan");
});

// spec-exit-rounds.md §3.1 — the property client-side quantization depends on.
// `largestTileableAtMost` and `decomposePayout` are two INDEPENDENT bounded
// searches. If they ever disagree, quantization silently emits the exact-value
// leg it exists to prevent, on the rail where that matters most. Swept across
// several withdrawal distributions because the exact-leg rate is entirely a
// function of the assumed distribution (§3.3) — a single range proves nothing.
await test("quantized values always tile within the leg cap (both caps, 4 distributions)", () => {
  const denominations = defaultDenominationsAtomic(6);
  const distributions = [
    ["atomic", (i) => BigInt(i + 1), 500],
    ["0.1-USDC grid", (i) => BigInt(i + 1) * 100_000n, 2000],
    ["whole USDC", (i) => BigInt(i + 1) * 1_000_000n, 900],
    ["awkward cents", (i) => BigInt(i + 1) * 9_901n, 1000],
  ];
  let checked = 0;
  for (const maxLegs of [DEFAULT_MAX_PAYOUT_LEGS, 3]) {
    for (const [label, valueAt, count] of distributions) {
      for (let index = 0; index < count; index += 1) {
        const total = valueAt(index);
        const config = { denominationsAtomic: [...denominations], maxLegs };
        const quantized = largestTileableAtMost({ totalAtomic: total.toString(), config });
        // Below the smallest denomination nothing tiles; the caller must decide,
        // and null is how it finds out rather than getting a silent exact leg.
        if (quantized === null) {
          assert.ok(total < denominations[0], `${label}: null returned for a tileable ${total}`);
          continue;
        }
        assert.ok(BigInt(quantized) <= total, `${label}: quantized above the request`);
        // random pinned high: pick the LAST enumerated tiling, the leg-count
        // ceiling, so the cap assertion below is exercised at its worst case.
        const plan = decomposePayout({ totalAtomic: quantized, config, random: () => 0.999999 });
        assert.equal(plan.strategy, "denominations",
          `${label} maxLegs=${maxLegs}: ${total} -> ${quantized} still fell back to an exact leg`);
        assert.ok(plan.legs.length <= maxLegs, `${label}: ${plan.legs.length} legs exceeds ${maxLegs}`);
        assert.equal(sumLegs(plan), BigInt(quantized), `${label}: legs do not sum to the quantized total`);
        checked += 1;
      }
    }
  }
  // Guards against a future edit silently shrinking the sweep to nothing. The
  // atomic-granularity values all land below the smallest denomination and are
  // counted as `null` rather than checked, so this floor sits under the ~7.8k
  // that actually tile.
  assert.ok(checked > 7_000, `expected a broad sweep, only checked ${checked}`);
});

// MAXIMALITY, against an independent reference — the property the test above does
// NOT check. `largestTileableAtMost` is a pruned depth-first search; a weakened prune
// still returns a value that tiles, so every tiling assertion stays green while the
// function quietly returns less than the true maximum. That is a silent privacy AND
// value regression: the caller withdraws less than it could, and the residue it is
// told to leave behind is wrong.
//
// The reference below shares no code with the implementation. It enumerates the set
// of ALL sums reachable with at most `maxLegs` denominations, then takes the largest
// one that is <= the request. Obviously correct, exponential, and therefore only
// usable on small configs — which is exactly what a property test wants.
const reachableSums = (denominations, maxLegs) => {
  const all = new Set();
  let level = new Set([0n]);
  for (let leg = 0; leg < maxLegs; leg += 1) {
    const next = new Set();
    for (const partial of level) {
      for (const denomination of denominations) {
        const sum = partial + denomination;
        next.add(sum);
        all.add(sum);
      }
    }
    level = next;
  }
  return all;
};

await test("largestTileableAtMost returns the true MAXIMUM (independent brute force)", () => {
  const configs = [
    // Non-canonical spacing: no 1-2-5 structure, so a greedy or lazily-pruned
    // search gets these wrong where it gets the tidy series right.
    [[7n, 9n, 31n], 4],
    [[3n, 7n, 11n], 4],
    [[7n, 13n, 29n, 31n], 3],
    [[5n, 8n, 13n], 4],
    [[10n, 60n, 70n], 3],
    [[3n, 5n], 5],
    [[1n, 2n, 5n, 10n], 3],
    [[1n, 2n, 5n, 10n], 8],
    [defaultDenominationsAtomic(6), 3],
    [defaultDenominationsAtomic(6), DEFAULT_MAX_PAYOUT_LEGS],
  ];
  let checked = 0;
  let mismatches = 0;
  for (const [denominations, maxLegs] of configs) {
    const sorted = [...denominations].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const reachable = [...reachableSums(sorted, maxLegs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const smallest = sorted[0];
    // Probe every discontinuity: each reachable sum and its immediate neighbours is
    // exactly where an off-by-one or an over-eager prune shows up.
    const probes = new Set();
    for (const sum of reachable) {
      for (const delta of [-1n, 0n, 1n]) {
        const probe = sum + delta;
        if (probe > 0n) probes.add(probe);
      }
    }
    for (const total of probes) {
      const expected = total < smallest
        ? null
        : reachable.reduce((best, sum) => (sum <= total && (best === null || sum > best) ? sum : best), null);
      const actual = largestTileableAtMost({
        totalAtomic: total.toString(),
        config: { denominationsAtomic: [...sorted], maxLegs },
      });
      const actualValue = actual === null ? null : BigInt(actual);
      if (actualValue !== expected) {
        mismatches += 1;
        if (mismatches <= 3) {
          console.error(
            `  MISMATCH denoms=[${sorted.join(",")}] maxLegs=${maxLegs} total=${total}`
            + ` expected=${expected} actual=${actualValue}`,
          );
        }
      }
      checked += 1;
    }
  }
  assert.equal(mismatches, 0, `${mismatches}/${checked} totals did not return the maximum tileable value`);
  assert.ok(checked > 3_000, `expected a broad sweep, only checked ${checked}`);
});

await test("largestTileableAtMost survives a deep, validator-passing denomination set", () => {
  // assertEnumerationBound caps COMBINATIONS, not search DEPTH. ~10k denominations
  // with maxLegs 1 is C(10001,10000) = 10001 combinations, far under ENUM_CAP, so
  // it passes every validator -- while a recursive search descends once per
  // denomination and overflows the stack. Config-reachable availability defect.
  const many = Array.from({ length: 10_000 }, (_unused, index) => BigInt(index + 1) * 1_000n);
  const started = performance.now();
  const result = largestTileableAtMost({
    totalAtomic: "1500", config: { denominationsAtomic: many, maxLegs: 1 },
  });
  assert.equal(result, "1000", "largest single denomination not exceeding 1500");
  assert.ok(performance.now() - started < 5_000, "deep search exceeded 5 seconds");
});

// Server-side tileability enforcement (spec-exit-rounds.md §8.1). Before this,
// `quantizeWithdrawal` shipped but the server accepted `strategy:"single"`
// unconditionally, so tileability was COURTESY, not enforcement: an agent that
// never called the helper kept publishing exact amounts — and because an exact leg
// carries `denominationAtomic: null`, which pins k_eff to 1 for its whole window,
// it degraded every cohort member beside it, not just itself.
await test("enforce rejects an exact leg when a tileable alternative exists", () => {
  // Policy [1,2,5] x maxLegs 4 tiles up to 20, so 23 has a valid 20 alternative.
  const plan = rehash(makePlan({ strategy: "single", amounts: ["23"] }));
  assert.throws(
    () => validatePlanAgainstPolicy(validationInput(plan, { quantizeMode: "enforce" })),
    // The message must name the re-quote amount, or the client cannot act on it.
    /re-quote at 20 atomic units/,
    "an exact leg with a tileable alternative must be refused under enforce",
  );
});

await test("enforce ALWAYS allows an exact leg when nothing tiles", () => {
  // The fund-stranding guard. Below the smallest denomination nothing tiles,
  // `largestTileableAtMost` returns null, and the client has no valid amount to
  // re-quote at — refusing here would lock the balance permanently. Under
  // quantization the residue accumulates in the ledger and a residue withdrawal IS
  // this case, so it is the common path, not an edge case.
  const plan = rehash(makePlan({ strategy: "single", amounts: ["3"] }));
  validatePlanAgainstPolicy(validationInput(plan, {
    quantizeMode: "enforce",
    policy: { denominationsAtomic: [10n], maxLegs: 1 },
  }));
});

await test("quantize enforcement is off by default", () => {
  // No behavior change for existing deployments until an operator opts in.
  const plan = rehash(makePlan({ strategy: "single", amounts: ["23"] }));
  validatePlanAgainstPolicy(validationInput(plan));
  validatePlanAgainstPolicy(validationInput(plan, { quantizeMode: "off" }));
  validatePlanAgainstPolicy(validationInput(plan, { quantizeMode: "advise" }));
});

await test("enforce never interferes with an already-tiled plan", () => {
  validatePlanAgainstPolicy(validationInput(validPlan, { quantizeMode: "enforce" }));
});

// Rail parity (spec-exit-rounds.md §3.4, thesis 6: enforced, not asserted).
const parityDecimals = new Map([["base", 6], ["robinhood", 6], ["solana", 6]]);
const ladder = (values) => ({ denominationsAtomic: values.map(BigInt), maxLegs: 8 });

await test("matching ladders across all three rails pass parity", () => {
  assertDenominationParity({
    byNetwork: new Map([
      ["base", ladder([100000, 1000000])],
      ["robinhood", ladder([100000, 1000000])],
      ["solana", ladder([100000, 1000000])],
    ]),
    decimalsByNetwork: parityDecimals,
  });
});

await test("a maxLegs mismatch fails parity — which the DEFAULT config has", () => {
  // EVM defaults to 8 legs and Solana to 3, so enabling cohorts on default config
  // throws by design: Solana's cap is a priced rent decision (§3.2), and this gate
  // exists so that decision gets made rather than drifted into.
  assert.throws(() => assertDenominationParity({
    byNetwork: new Map([
      ["base", { denominationsAtomic: [100000n], maxLegs: DEFAULT_MAX_PAYOUT_LEGS }],
      ["solana", { denominationsAtomic: [100000n], maxLegs: DEFAULT_MAX_PAYOUT_LEGS_SOLANA }],
    ]),
    decimalsByNetwork: parityDecimals,
  }), /allows 3 legs but .* allows 8|allows 8 legs but .* allows 3/);
});

await test("a ladder mismatch fails parity", () => {
  assert.throws(() => assertDenominationParity({
    byNetwork: new Map([
      ["base", ladder([100000, 1000000])],
      ["solana", ladder([100000, 5000000])],
    ]),
    decimalsByNetwork: parityDecimals,
  }), /not the same human-unit value/);
});

await test("parity compares HUMAN units across differing decimals", () => {
  // 0.1 token at 6 decimals is 100000; at 9 decimals it is 100000000. Same human
  // value, different atomic value — parity must accept it.
  assertDenominationParity({
    byNetwork: new Map([
      ["base", ladder([100000])],
      ["solana", ladder([100000000])],
    ]),
    decimalsByNetwork: new Map([["base", 6], ["solana", 9]]),
  });
});

await test("parity does not silently equate 0.1 and 0.15 (the truncation trap)", () => {
  // The trap §3.4 calls out: normalizing by DIVIDING into integers gives
  // 100000n / 10n**6n === 150000n / 10n**6n === 0n, so a truncating check would
  // pass this and assert nothing. Cross-multiplication catches it.
  assert.throws(() => assertDenominationParity({
    byNetwork: new Map([
      ["base", ladder([100000])],
      ["solana", ladder([150000])],
    ]),
    decimalsByNetwork: parityDecimals,
  }), /not the same human-unit value/);
});

await test("a single configured rail is trivially in parity", () => {
  assertDenominationParity({
    byNetwork: new Map([["base", ladder([100000])]]),
    decimalsByNetwork: parityDecimals,
  });
});

await test("parity refuses to pass when a rail's decimals are unknown", () => {
  // Silently skipping an unknown rail would make the check vacuous for exactly the
  // rail someone just added.
  assert.throws(() => assertDenominationParity({
    byNetwork: new Map([["base", ladder([100000])], ["newchain", ladder([100000])]]),
    decimalsByNetwork: parityDecimals,
  }), /no token decimals known for newchain/);
});

console.log(`PASS denominations smoke (${passed}/${passed}; ENUM_CAP=${ENUM_CAP})`);
