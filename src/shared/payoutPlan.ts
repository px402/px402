import { createHash } from "node:crypto";
import { largestTileableAtMost, type DenominationConfig } from "./denominations";

export interface PayoutPlanLeg {
  index: number;
  payoutRef: string;
  amountAtomic: string;
  denominationAtomic: string | null;
  kind: "denomination" | "exact";
  recipient: string;
  stealthAddress?: string;
  ephemeralPubKey?: string;
}

export interface PayoutGroupPlan {
  version: 2;
  groupRef: string;
  network: string;
  asset: string;
  strategy: "single" | "denominations";
  policyVersion: string;
  quoteRequirementsHash: string;
  totalAtomic: string;
  onchainAtomic: string;
  offchainChangeAtomic: string;
  legs: PayoutPlanLeg[];
  /**
   * Client-declared release cap (spec-payout-concentration.md §5). Optional and
   * additive: when absent it is omitted from the canonical body, so the plan hash
   * of every pre-existing plan is unchanged and the server falls back to its
   * default hold. When present it is bound into the plan hash — and therefore into
   * the signature — so the operator cannot edit or strip it (§7.6 catches both).
   */
  maxHoldMs?: number;
  planHash: string;
}

export interface PayoutPolicyAdvertisement {
  policyVersion: string;
  denominationsAtomic: string[];
  maxLegs: number;
  /** Disclosed ceiling for a client-declared release cap (§5); server default when omitted. */
  maxHoldMsCeiling?: number;
}

export interface PlanValidationInput {
  plan: PayoutGroupPlan;
  policy: DenominationConfig;
  policyVersion: string;
  asset: string;
  totalAtomic: string;
  quoteRequirementsHash: string;
  /** Server ceiling a client-declared `maxHoldMs` must not exceed (§5). */
  maxHoldMsCeiling: number;
  resolveRecipient: (ephemeralPubKey: string) => string;
  /**
   * Server-side tileability enforcement (spec-exit-rounds.md §8.1).
   *
   * `quantizeWithdrawal` ships client-side, but the server accepting
   * `strategy:"single"` unconditionally makes tileability **courtesy, not
   * enforcement** — an agent that simply never calls the helper keeps publishing
   * exact amounts. Worse, an exact leg carries `denominationAtomic: null`, which
   * pins `k_eff` to 1 for its whole window, so one untiled withdrawal degrades the
   * anonymity of every cohort member beside it.
   *
   * `off` preserves the historical behavior. `enforce` rejects an exact leg **only
   * when a tileable alternative exists**; when nothing tiles the exact leg is
   * always allowed, because refusing there would strand a balance below the
   * smallest denomination with no valid amount to re-quote at. Under quantization
   * the residue accumulates in the ledger and a residue withdrawal IS that case,
   * so the escape hatch is the common path rather than an edge case.
   */
  quantizeMode?: PayoutQuantizeMode;
}

export type PayoutQuantizeMode = "off" | "advise" | "enforce";

export const canonicalPlanBody = (plan: Omit<PayoutGroupPlan, "planHash">): string =>
  JSON.stringify({
    version: plan.version,
    groupRef: plan.groupRef,
    network: plan.network,
    asset: plan.asset,
    strategy: plan.strategy,
    policyVersion: plan.policyVersion,
    quoteRequirementsHash: plan.quoteRequirementsHash,
    totalAtomic: plan.totalAtomic,
    onchainAtomic: plan.onchainAtomic,
    offchainChangeAtomic: plan.offchainChangeAtomic,
    legs: plan.legs.map((leg) => ({
      index: leg.index,
      payoutRef: leg.payoutRef,
      amountAtomic: leg.amountAtomic,
      denominationAtomic: leg.denominationAtomic,
      kind: leg.kind,
      recipient: leg.recipient,
      stealthAddress: leg.stealthAddress,
      ephemeralPubKey: leg.ephemeralPubKey,
    })),
    // Additive: JSON.stringify drops it when undefined, so plans that declare no
    // cap hash exactly as before this field existed.
    maxHoldMs: plan.maxHoldMs,
  });

export const computePlanHash = (plan: Omit<PayoutGroupPlan, "planHash">): string =>
  sha256(canonicalPlanBody(plan));

export const computeQuoteRequirementsHash = (requirements: unknown): string =>
  sha256(JSON.stringify(requirements));

export const validatePlanAgainstPolicy = (input: PlanValidationInput): void => {
  const { plan } = input;
  if (plan.version !== 2) throw new Error("Payout plan version must be 2");
  if (!plan.groupRef) throw new Error("Payout plan groupRef is required");
  if (Object.prototype.hasOwnProperty.call(plan, "offchainChange")) {
    throw new Error("Off-chain payout change component is not enabled");
  }
  if (plan.strategy !== "single" && plan.strategy !== "denominations") {
    throw new Error("Payout plan strategy is invalid");
  }
  if (plan.strategy === "single" && input.quantizeMode === "enforce") {
    // Guidance, not a privacy hold: the client re-quotes at the returned amount and
    // is paid, so this does not touch frozen R6 ("delay, never refuse"), which
    // governs holds rather than amount validation. `null` means nothing tiles —
    // always allow the exact leg there, or a balance below the smallest
    // denomination becomes permanently unwithdrawable.
    const tileable = largestTileableAtMost({
      totalAtomic: plan.totalAtomic,
      config: input.policy,
    });
    if (tileable !== null) {
      // The amount is the payer's own, so naming it leaks nothing they do not know,
      // and without it the client cannot act on the refusal.
      throw new Error(
        `Payout must be quantized: re-quote at ${tileable} atomic units `
        + `(requested ${plan.totalAtomic}); an exact leg publishes its value on-chain`,
      );
    }
  }
  if (!Array.isArray(plan.legs) || plan.legs.length === 0) {
    throw new Error("Payout plan must contain at least one leg");
  }
  if (!Number.isSafeInteger(input.policy.maxLegs)
    || input.policy.maxLegs < 1
    || plan.legs.length > input.policy.maxLegs) {
    throw new Error("Payout plan exceeds the configured maximum leg count");
  }

  const total = parseAtomic(plan.totalAtomic, "Payout plan total", true);
  const onchain = parseAtomic(plan.onchainAtomic, "Payout plan on-chain total", true);
  const offchain = parseAtomic(plan.offchainChangeAtomic, "Payout plan off-chain change", false);
  const authoritativeTotal = parseAtomic(input.totalAtomic, "Quoted payout total", true);
  let legSum = 0n;
  const denominationSet = new Set(input.policy.denominationsAtomic.map(String));
  const announcements = new Set<string>();

  for (let index = 0; index < plan.legs.length; index += 1) {
    const leg = plan.legs[index];
    const amount = parseAtomic(leg.amountAtomic, `Payout leg ${index} amount`, true);
    legSum += amount;
    if (leg.index !== index) throw new Error("Payout plan leg indexes must be ordered and contiguous");
    const expectedRef = plan.strategy === "single" ? plan.groupRef : `${plan.groupRef}:${index}`;
    if (leg.payoutRef !== expectedRef) throw new Error("Payout plan leg reference does not match its group/index");
    if (!leg.recipient) throw new Error("Payout plan leg recipient is required");
    if (leg.stealthAddress !== undefined && leg.stealthAddress !== leg.recipient) {
      throw new Error("Payout plan stealth address must equal its recipient");
    }
    if (!leg.ephemeralPubKey) throw new Error("Payout plan stealth announcement is required");
    if (announcements.has(leg.ephemeralPubKey)) {
      throw new Error("Payout plan stealth announcements must be pairwise distinct");
    }
    announcements.add(leg.ephemeralPubKey);
    if (input.resolveRecipient(leg.ephemeralPubKey) !== leg.recipient) {
      throw new Error("Payout plan stealth announcement resolves to a different recipient");
    }

    if (plan.strategy === "denominations") {
      if (!denominationSet.has(leg.amountAtomic)) {
        throw new Error("Payout plan leg is not a configured denomination");
      }
      if (leg.denominationAtomic !== leg.amountAtomic || leg.kind !== "denomination") {
        throw new Error("Payout denomination leg metadata is inconsistent");
      }
    } else if (leg.denominationAtomic !== null || leg.kind !== "exact") {
      throw new Error("Single payout leg must be marked as exact");
    }
  }

  // §7.1 — exact per-leg value preservation.
  if (legSum !== onchain) throw new Error("Payout plan leg sum does not equal on-chain total");

  // §7.2 — total preservation against both the signed plan and issued quote.
  if (onchain + offchain !== total || total !== authoritativeTotal) {
    throw new Error("Payout plan does not preserve the quoted total");
  }

  // §7.3 — denomination membership or one exact single leg.
  if (plan.strategy === "single"
    && (plan.legs.length !== 1 || plan.legs[0].amountAtomic !== plan.totalAtomic)) {
    throw new Error("Single payout plan must contain one exact-total leg");
  }

  // §7.4 — network policy hard cap.
  // §7.5 is enforced in the loop: required/distinct announcements + resolution.

  // §7.6 — immutable plan anchor.
  const { planHash, ...body } = plan;
  if (computePlanHash(body) !== planHash) throw new Error("Payout plan hash mismatch");

  // §7.7 — quote, rail, and policy bindings.
  const expectedPolicyVersion = plan.strategy === "single" ? "none" : input.policyVersion;
  if (plan.quoteRequirementsHash !== input.quoteRequirementsHash) {
    throw new Error("Payout plan quote requirements hash mismatch");
  }
  if (plan.asset !== input.asset) throw new Error("Payout plan asset mismatch");
  if (plan.policyVersion !== expectedPolicyVersion) throw new Error("Payout plan policy version mismatch");

  // §7.8 is enforced by PrivateAgentRegistry.assertAgentIntent over the v2 message.

  // §7.9 — change is deliberately unavailable in this wave.
  if (plan.offchainChangeAtomic !== "0") {
    throw new Error("Off-chain payout change is not enabled");
  }

  // §5 — client-declared release cap. Optional; when present it must be a positive
  // integer within the disclosed ceiling. It is already bound into planHash above
  // (§7.6), so this rejects only a client that over-declares, never an operator
  // edit. Absence means "use the server default" and is not an error.
  if (plan.maxHoldMs !== undefined) {
    if (!Number.isInteger(plan.maxHoldMs) || plan.maxHoldMs <= 0) {
      throw new Error("Payout plan maxHoldMs must be a positive integer");
    }
    if (plan.maxHoldMs > input.maxHoldMsCeiling) {
      throw new Error("Payout plan maxHoldMs exceeds the disclosed ceiling");
    }
  }
};

const parseAtomic = (value: string, label: string, positive: boolean): bigint => {
  const pattern = positive ? /^[1-9]\d*$/ : /^(0|[1-9]\d*)$/;
  if (!pattern.test(value)) throw new Error(`${label} must be a canonical integer string`);
  return BigInt(value);
};

const sha256 = (value: string): string =>
  `0x${createHash("sha256").update(value).digest("hex")}`;
