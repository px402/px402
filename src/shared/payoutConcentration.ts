/**
 * k_eff — the payout-concentration anonymity metric (spec-payout-concentration.md §2).
 *
 * Binding thesis: on a transparent account model you cannot manufacture cover
 * traffic, only concentrate the boundary crossings you already pay for. A leg's
 * anonymity set is therefore the OTHER legs of the same denomination landing in
 * the same flush window, counted by distinct PAYING ACCOUNT — because one
 * identified leg usually identifies its whole group (the remaining legs must
 * satisfy `group_total - identified_leg` under `<= maxLegs`).
 *
 * Counted over owners, not groups: a group is one quote nonce and an agent may
 * mint arbitrarily many, so counting groups let a single agent manufacture its own
 * anonymity set. See `anonymityByLeg`. Note this makes the metric a count of
 * distinct paying LEDGER ACCOUNTS, not of distinct humans — nothing here is
 * sybil-resistant, and K accounts held by one operator still count as K.
 *
 * This module is pure and deterministic so it can be unit-tested and reused by
 * both the flush gate (§4) and the authenticated claim report (§7).
 */

/** A leg as the analyst sees it in a window: which group produced it, at what denomination. */
export interface ConcentrationLeg {
  groupRef: string;
  /**
   * The PAYING LEDGER ACCOUNT behind this leg, not its group. Required, because
   * anonymity is counted over owners (see `anonymityByLeg`) and a caller that
   * omitted it would silently forfeit the protection — so omission is a compile
   * error rather than a runtime downgrade.
   */
  ownerRef: string;
  /**
   * Atomic denomination value. `null`/absent is a `strategy:"single"` leg, which
   * publishes an exact non-standard value and hides among nothing — it is
   * conditioned on itself alone, so its anonymity is always 1 (§2, degenerate case).
   */
  denominationAtomic?: string | null;
  /**
   * The LANE this leg belongs to: `network:asset:denominationAtomic`
   * (spec-exit-rounds.md thesis 4 — "the unit of privacy is the lane"). `null` for
   * an exact leg, which has no lane because it is conditioned on itself alone.
   *
   * Required, following the `ownerRef` precedent: omitting it would silently
   * restore denomination-only grouping, so omission is a compile error rather than
   * a runtime downgrade. Denomination alone is not a safe key — two different
   * ASSETS sharing an atomic value (1000000 of USDC and of USDG) are not
   * interchangeable to an observer, yet a denomination-keyed tally counts them as
   * one anonymity set and overstates k_eff.
   */
  laneKey: string | null;
}

/**
 * `undefined` means the caller FORGOT the lane; `null` means "deliberately no lane"
 * (an exact leg). TypeScript makes omission a compile error, but the smoke harnesses
 * are `.mjs` and bypass that entirely — and a forgotten lane reads as laneless,
 * which silently collapses every leg's anonymity to 1. That is a privacy downgrade
 * disguised as a passing test, so it is caught loudly at runtime as well.
 */
const requireLane = (leg: ConcentrationLeg): string | null => {
  if (leg.laneKey === undefined) {
    throw new Error(
      `ConcentrationLeg is missing laneKey (group ${leg.groupRef}); pass null explicitly `
      + "for an exact leg — an absent lane silently collapses anonymity to 1",
    );
  }
  return leg.laneKey;
};

/** Canonical lane identity (§ thesis 4). Exact legs have no lane. */
export const laneKeyFor = (input: {
  network: string;
  asset: string;
  denominationAtomic?: string | null;
}): string | null => (
  input.denominationAtomic == null
    ? null
    : `${input.network}:${input.asset}:${input.denominationAtomic}`
);

/**
 * `A(ℓ)` for every leg: the number of distinct PAYING ACCOUNTS in the window that
 * produced a leg of ℓ's exact denomination. Null-denomination legs are excluded
 * from the per-denomination tally; each is conditioned on itself alone (A = 1).
 *
 * Counted over `ownerRef`, never `groupRef`. A `groupRef` is one x402 quote nonce
 * (`PrivateAgentRegistry` binds `plan.groupRef === quote.requirements.nonce`), and
 * quotes are unmetered — there is no rate limit or concurrency cap on payout
 * enqueue. Keyed on groups, one agent splitting a single withdrawal into `K`
 * one-leg groups would mint `k_eff = K` for an anonymity set of exactly ONE, and
 * that inflated number would then (a) be reported to the payer as its realized
 * privacy, (b) be ingested as adaptive-target evidence, raising the bar for every
 * honest withdrawer until they hold to `maxHoldMs` waiting on concurrency that
 * never existed, and (c) poison the published histogram. Owners are the identity
 * the anonymity claim is actually about; groups are an accounting artifact.
 */
const anonymityByLeg = (legs: readonly ConcentrationLeg[]): number[] => {
  const ownersByLane = new Map<string, Set<string>>();
  for (const leg of legs) {
    const laneKey = requireLane(leg);
    if (laneKey == null) continue;
    let owners = ownersByLane.get(laneKey);
    if (!owners) {
      owners = new Set<string>();
      ownersByLane.set(laneKey, owners);
    }
    owners.add(leg.ownerRef);
  }
  return legs.map((leg) =>
    leg.laneKey == null
      ? 1
      : ownersByLane.get(leg.laneKey)?.size ?? 1,
  );
};

/** `A(ℓ)` per lane — the evidence and gating unit for lane-local targets (§4). */
export const anonymityByLane = (legs: readonly ConcentrationLeg[]): Map<string, number> => {
  const ownersByLane = new Map<string, Set<string>>();
  for (const leg of legs) {
    const laneKey = requireLane(leg);
    if (laneKey == null) continue;
    let owners = ownersByLane.get(laneKey);
    if (!owners) {
      owners = new Set<string>();
      ownersByLane.set(laneKey, owners);
    }
    owners.add(leg.ownerRef);
  }
  return new Map([...ownersByLane].map(([lane, owners]) => [lane, owners.size]));
};

/**
 * Primary metric — `k_eff(W) = min over ℓ ∈ L(W) of A(ℓ)`. The analyst attacks the
 * weakest leg, so the minimum (never the average) is the security parameter.
 *
 * Degenerate cases (normative, §2): an empty window is `0` (no gate evaluation, no
 * broadcast); any non-empty window is `>= 1`; a single-strategy (null-denomination)
 * leg forces `k_eff = 1`, the honest reading and the argument for off-chain change.
 */
export const computeKEff = (legs: readonly ConcentrationLeg[]): number => {
  if (legs.length === 0) return 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (const anonymity of anonymityByLeg(legs)) {
    if (anonymity < minimum) minimum = anonymity;
  }
  return Number.isFinite(minimum) ? minimum : 0;
};

/** `G(W)` — distinct groups contributing at least one leg to the window (§2). */
export const distinctGroupCount = (legs: readonly ConcentrationLeg[]): number =>
  new Set(legs.map((leg) => leg.groupRef)).size;

/** A candidate group as the flush gate weighs it (§4.1). */
export interface ConcentrationGroup {
  groupRef: string;
  /** Paying ledger account; anonymity is counted over these, not over groups. */
  ownerRef: string;
  /** When the group entered the queue; `held(g) = now - createdAt` (§4.1 step 5). */
  createdAt: number;
  /**
   * Resolved hold ceiling for THIS group: the client-declared cap (§5) clamped to
   * the server ceiling. Mandatory and finite (§4.2 R3) — there is no unbounded hold.
   */
  maxHoldMs: number;
  /** The group's queued legs eligible for this window. */
  legs: ConcentrationLeg[];
}

export interface ReleaseDecision {
  /** `k_eff` over the full candidate window (§4.1 step 3). */
  windowKEff: number;
  /** True when the gate held at least one group; false means proceed unchanged. */
  gated: boolean;
  /** Group refs to broadcast this pass (every group when not gated). */
  releaseGroupRefs: string[];
  /** Group refs held to a later window (§4.1 step 8). */
  heldGroupRefs: string[];
  /** `k_eff` over exactly the submitted subset (§4.1 step 7); 0 when nothing is submitted. */
  realizedKEff: number;
}

/** One window's realized k_eff and when it landed, for the lagged histogram (§7). */
export interface KEffSample {
  atMs: number;
  kEff: number;
}

/**
 * Aggregate k_eff histogram over windows OLDER than `lagMs` (spec §7). Live or
 * near-live thinness is a strike signal (A3), so anything inside the lag is
 * excluded; the result is bucketed by k_eff value with no per-window, per-group,
 * or per-agent rows. Pure and deterministic.
 */
export const kEffHistogram = (
  samples: readonly KEffSample[],
  nowMs: number,
  lagMs: number,
): Record<string, number> => {
  const cutoff = nowMs - lagMs;
  const buckets: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.atMs > cutoff) continue; // still live/near-live — never published
    const key = sample.kEff >= 5 ? "5+" : String(sample.kEff);
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return buckets;
};

/**
 * Adaptive `k_eff` target (spec-payout-concentration.md §14).
 *
 * A STATIC target is a latency tax at low user counts: set it above 1 while the
 * system has no concurrency and every window is held to `maxHoldMs` waiting for
 * cover that will never arrive — pure delay, zero privacy. The protocol has to be
 * correct at user #1 and improve on its own as users arrive, without an operator
 * noticing and editing an env var.
 *
 * So the target is DERIVED from concurrency the system has actually demonstrated,
 * and is bounded above by it. Two invariants make this safe:
 *
 *   1. **Insufficient evidence ⇒ 1.** Below `minSamples` observations in the window
 *      the target is 1, which `planWindowRelease` treats as inert. This is the N=1
 *      guarantee: a lone user is never held, because nothing was ever observed.
 *   2. **Never exceeds the observed quantile.** The target can only ask for
 *      concentration that recently occurred naturally, so it cannot demand an
 *      unattainable `k_eff` and stall the queue.
 *
 * Samples are the PRE-gate `windowKEff` (natural concurrency), not the post-gate
 * realized value, so the measurement is of arrivals rather than of our own holding.
 * Held groups do remain candidates in later windows and so feed back weakly; the
 * `ceiling` and each group's `maxHoldMs` bound that in both directions, and a
 * conservative default quantile keeps it tracking rather than leading.
 *
 * Pure and deterministic.
 */
export interface AdaptiveTargetInput {
  /** Observed pre-gate window k_eff samples. */
  samples: readonly KEffSample[];
  nowMs: number;
  /** Only samples this recent count as evidence. */
  windowMs: number;
  /** Minimum observations before the target may exceed 1. */
  minSamples: number;
  /** Quantile of observed concurrency to demand, 0..1. Lower is more conservative. */
  quantile: number;
  /** Hard upper bound the operator is willing to reach. */
  ceiling: number;
}

export const adaptiveKEffTarget = (input: AdaptiveTargetInput): number => {
  const cutoff = input.nowMs - input.windowMs;
  const observed = input.samples
    .filter((sample) => sample.atMs >= cutoff && sample.kEff > 0)
    .map((sample) => sample.kEff)
    .sort((a, b) => a - b);
  // Invariant 1 — no evidence, no holding.
  if (observed.length < input.minSamples) return 1;
  const clampedQuantile = Math.min(1, Math.max(0, input.quantile));
  const index = Math.floor(clampedQuantile * (observed.length - 1));
  // Invariant 2 — floor, so we never round UP to concurrency we have not seen.
  return Math.max(1, Math.min(input.ceiling, Math.floor(observed[index])));
};

/**
 * The flush gate's decision (spec-payout-concentration.md §4.1) — **delay, never
 * refuse.** When `k_eff` meets the target the whole window proceeds unchanged.
 * Otherwise each group is held until it reaches its own `maxHoldMs`, at which point
 * it is force-released; a held group is never dropped, so the only two outcomes are
 * *broadcast now* and *broadcast at `maxHoldMs`* (§4.2 R6). Pure and deterministic:
 * it mutates nothing and the caller decides what to do with the held groups.
 */
export const planWindowRelease = (
  groups: readonly ConcentrationGroup[],
  params: {
    /** Single target for every lane. Superseded by `targetForLane` when supplied. */
    kEffTarget: number;
    /**
     * Lane-local target (spec-exit-rounds.md §4). A lane is judged ONLY against its
     * own evidence, so a rail or denomination can never inherit another's
     * concurrency — and, critically, an exact leg no longer drags the window down:
     * it has no lane, its own target is 1 by construction, and it therefore stops
     * gating every tiled leg beside it. Under the single-target form, one untiled
     * withdrawal held the entire window to `maxHoldMs`.
     */
    targetForLane?: (laneKey: string) => number;
    now: number;
  },
): ReleaseDecision => {
  const windowLegs = groups.flatMap((group) => group.legs);
  const windowKEff = computeKEff(windowLegs);
  const meetsTarget = params.targetForLane
    ? [...anonymityByLane(windowLegs)].every(
      ([lane, anonymity]) => anonymity >= (params.targetForLane as (l: string) => number)(lane),
    )
    : windowKEff >= params.kEffTarget;
  // §4.1 step 4 — target met (or nothing to weigh): proceed unchanged.
  if (windowLegs.length === 0 || meetsTarget) {
    return {
      windowKEff,
      gated: false,
      releaseGroupRefs: groups.map((group) => group.groupRef),
      heldGroupRefs: [],
      realizedKEff: windowKEff,
    };
  }
  // §4.1 steps 5-8 — hold, force-releasing only the groups past their own cap.
  const released: ConcentrationGroup[] = [];
  const held: ConcentrationGroup[] = [];
  for (const group of groups) {
    if (params.now - group.createdAt >= group.maxHoldMs) released.push(group);
    else held.push(group);
  }
  return {
    windowKEff,
    gated: true,
    releaseGroupRefs: released.map((group) => group.groupRef),
    heldGroupRefs: held.map((group) => group.groupRef),
    realizedKEff: computeKEff(released.flatMap((group) => group.legs)),
  };
};
