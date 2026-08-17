/**
 * Atomic sweep-and-pay planning — the CoinJoin over our own deposits
 * (spec-join-payouts.md).
 *
 * Today the chain sees two events and joins them through the pool:
 *
 *     buyer -> X        (deposit)
 *     X -> pool         (sweep)      <- linkable
 *     pool -> payee     (payout)     <- linkable
 *
 * Instead, several unswept one-time deposit addresses are spent DIRECTLY to
 * several stealth payout addresses in ONE transaction:
 *
 *     {X1, X2, X3} -> {payee A, payee B, change}
 *
 * The pool address never appears, and consolidation stops existing as a separate
 * event because it IS the payout. Two consequences follow, and they are the
 * whole reason for this module:
 *
 *  - **Liquidity stops fighting privacy.** A deposit is spendable the moment it
 *    lands, because spending it is the payout. There is no float to carry and no
 *    delay to tune, so the privacy knob becomes a COUNT (how many inputs are in
 *    the join) rather than a DELAY. A count is reachable at tiny volume; a delay
 *    is not shortenable without losing everything it bought.
 *  - **Privacy stops depending on timing.** The ambiguity is structural, inside
 *    one atomic transaction, rather than a hope that the sweep drifted far
 *    enough from the payment.
 *
 * THE HUB, AND WHY IT IS NOT OPTIONAL. This was first written as if it were a
 * Bitcoin CoinJoin, where inputs and outputs are unordered lists and the mapping
 * genuinely is not in the transaction. Base, Robinhood and Solana are ACCOUNT
 * chains: every ERC-20 `Transfer` event and every SPL `transferChecked` carries
 * an explicit `(from, to, value)`. So paying M outputs from N inputs directly
 * would emit N explicit `from -> to` edges and publish the exact mapping, while
 * `subsetSumAmbiguity` reported a comfortable number — worse than reporting
 * nothing, because a false figure reads as safety.
 *
 * So every input pays a single EPHEMERAL HUB and every output is paid by it,
 * inside one atomic transaction:
 *
 *     X1 -> H,  X2 -> H,  X3 -> H,  H -> A,  H -> B,  H -> change
 *
 * The hub is FRESH per join and never holds a balance between transactions —
 * that is what keeps it from quietly becoming the pool address this design
 * exists to remove.
 *
 * WHAT THIS DOES NOT BUY, STATED PLAINLY. Two earlier claims in this header were
 * wrong and are corrected here rather than quietly deleted.
 *
 * 1. **The join is RECOGNIZABLE.** "Privacy stops depending on timing" was
 *    false. One cheap predicate finds these regardless of how they are wrapped:
 *    an address receiving from >=2 addresses then sending to >=2 addresses in
 *    one transaction, balanced in and out, with little prior history. Routing
 *    through a public batcher does not help — a batcher exposes every nested
 *    call — and a bespoke mixing contract is a STRONGER beacon, since identical
 *    bytecode clusters every deployment of it instantly. On an account chain,
 *    ambiguous-but-recognizable appears to be the ceiling for exact transfers;
 *    unrecognizable needs shielded transfers or genuine off-chain netting.
 *
 * 2. **`ambiguity` is NOT an anonymity set.** It models each input as assigned
 *    indivisibly to some output, but a hub COMMINGLES fungible balance, so no
 *    such assignment physically exists. Inputs `[7,13]` fund outputs `[10,10]`
 *    perfectly well while the metric reports 0. Treat it as a weak lower-bound
 *    heuristic on amount-linkability, never as a guarantee, and never as a
 *    number to hand a payee as if it were `k_eff`.
 *
 * The honest claim is therefore: this transaction is recognizable as a join, but
 * absent side information it does not prove which input funded which output.
 */

/** An unswept one-time deposit address available to spend. */
export interface JoinInput {
  /** Opaque handle; the chain layer maps it back to a derivation index. */
  ref: string;
  amountAtomic: bigint;
  /**
   * When the deposit was observed. Monero forbids spending an output for 10
   * blocks so that "spent immediately" is never itself a signal; `minInputAgeMs`
   * is the same idea.
   */
  observedAtMs: number;
}

export type JoinOutputKind =
  /** A real payee. */
  | "payout"
  /**
   * A self-payout that funnels back in as a future input — Monero calls this
   * churn. It costs GAS, never capital: the value returns to an address we
   * control, which is what makes cover traffic affordable before any volume
   * exists.
   *
   * The reason operator decoys were rejected for pool payouts and are accepted
   * here is distributional, not moral. A decoy is worthless the moment one
   * predicate separates it from a real output, so these are only ever emitted in
   * the same denominations, the same counts, and the same size distribution as
   * real payouts. Early Monero drew ring decoys uniformly while real spends
   * skewed recent, and roughly nine in ten spends fell out to a single
   * heuristic. Same failure, same fix: match the real distribution.
   */
  | "decoy"
  /** Value returning to us because the inputs over-covered the payouts. */
  | "change";

export interface JoinOutput {
  kind: JoinOutputKind;
  amountAtomic: bigint;
  /** Present for real payouts; decoys and change are ours. */
  payeeRef?: string;
}

export interface JoinPolicy {
  /**
   * Minimum inputs before a join may broadcast. Below 2 there is no ambiguity
   * to measure — one input funds everything by construction.
   */
  minInputs: number;
  /** Minimum total outputs, counting decoys and change. */
  minOutputs: number;
  /**
   * Standard denominations. Arbitrary amounts are what let an observer solve the
   * subset-sum and recover the exact input->output mapping; standard ones are
   * what make many assignments equally consistent.
   */
  denominationsAtomic: readonly bigint[];
  /** Monero's 10-block lock, generalized. */
  minInputAgeMs: number;
  /**
   * How many decoys to add. FIXED POLICY, never a per-agent choice: Monero
   * enforces one ring size for everyone precisely so that picking a different
   * one cannot fingerprint you. An agent emitting seven splits where everyone
   * else emits three has identified itself.
   */
  decoyCount: number;
  /** Ceiling on inputs per join, so a transaction stays broadcastable. */
  maxInputs: number;
}

export interface JoinPlan {
  inputs: JoinInput[];
  outputs: JoinOutput[];
  /**
   * The ephemeral hub every input pays and every output is paid by.
   *
   * Opaque here — the chain layer derives the actual address — but the INDEX is
   * carried so a plan is reproducible after a crash, and so a test can assert
   * that no two joins ever share one. A reused hub is a persistent address with
   * a history, which is the pool by another name.
   */
  hubIndex: number;
  /**
   * A weak amount-linkability heuristic — NOT an anonymity set, and not safe to
   * present to a payee as one. See the header: a hub commingles fungible
   * balance, so the indivisible-assignment model this counts does not match what
   * actually happens on chain.
   */
  ambiguity: number;
  /** Populated when the plan is refused; `inputs`/`outputs` are then empty. */
  refusal?: JoinRefusal;
}

export type JoinRefusal =
  | "insufficient-inputs"
  | "insufficient-value"
  | "inputs-too-young"
  | "no-outputs";

const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/**
 * How many distinct subsets of `inputs` sum EXACTLY to `target`.
 *
 * A structural helper, not a privacy figure. Exponential by nature, so it is
 * bounded by a VISIT budget as well as a result cap — see the comment in the
 * body for why a result cap alone bounds nothing.
 */
export const subsetSumCount = (
  inputs: readonly bigint[],
  target: bigint,
  cap = 4096,
  nodeBudget = 200_000,
): number => {
  let count = 0;
  // A MATCH cap does not bound the search. It stops early only once enough
  // matches exist, so the pathological case is the one with NO matches: 60
  // inputs of 2 against an odd target never increments `count`, the cap never
  // trips, and the DFS walks an enormous tree synchronously — measured hanging
  // past 20 s and blocking the event loop, which on a payment path stalls every
  // other payout. The visit budget is what actually bounds it.
  let visits = nodeBudget;
  const walk = (index: number, remaining: bigint): void => {
    if (count >= cap || visits <= 0) return;
    visits -= 1;
    if (remaining === 0n) { count += 1; return; }
    if (index >= inputs.length || remaining < 0n) return;
    walk(index + 1, remaining - inputs[index]); // take
    walk(index + 1, remaining);                 // skip
  };
  walk(0, target);
  return count;
};

/**
 * The plan's ambiguity: for the WORST output, how many distinct input-subsets
 * could have funded it **in some complete, consistent assignment**.
 *
 * The assignment constraint is the whole point, and leaving it out was a real
 * bug. Counting each output's subsets INDEPENDENTLY — which is what
 * `subsetSumCount` does — overstates privacy, because a subset can sum to the
 * right value and still be impossible once the other outputs must also be
 * funded from what remains. Measured over ~18,500 random fundable plans, the
 * independent count was too high in 1.2% of them, and every such case reported
 * ambiguity 2 for an output that was in fact FORCED. A figure of 1 means "this
 * output is fully deanonymised"; reporting 2 tells the payee the opposite.
 *
 * A privacy number that overstates itself is worse than no number, so this pays
 * for the exponential search. It is bounded by a VISIT budget rather than only a
 * result cap: a result cap stops nothing when there are no results, which is
 * exactly the unsatisfiable-target case that hangs.
 *
 * Deliberately the minimum over outputs, never the average: an average lets a
 * comfortable majority hide one perfectly-identified output, and that payee is
 * not consoled by everyone else's privacy. Same reasoning as `k_eff`.
 */
export const subsetSumAmbiguity = (
  plan: Pick<JoinPlan, "inputs" | "outputs">,
  assignmentCap = 20_000,
  nodeBudget = 500_000,
): number => {
  if (plan.outputs.length === 0 || plan.inputs.length === 0) return 0;
  const amounts = plan.inputs.map((input) => input.amountAtomic);
  const targets = plan.outputs.map((output) => output.amountAtomic);

  // Per output, the set of subsets that appear in at least one valid assignment.
  const viable: Set<string>[] = targets.map(() => new Set<string>());
  let assignments = 0;
  let exhausted = false;
  // Bounds the SEARCH, not just the result count — an unsatisfiable target
  // explores an exponential tree without ever incrementing `assignments`.
  let visits = nodeBudget;

  const walk = (outIndex: number, used: boolean[], chosen: number[][]): void => {
    if (assignments >= assignmentCap || visits <= 0) { exhausted = true; return; }
    if (outIndex === targets.length) {
      assignments += 1;
      for (let i = 0; i < chosen.length; i += 1) viable[i].add(chosen[i].join(","));
      return;
    }
    const pick = (index: number, remaining: bigint, subset: number[]): void => {
      if (assignments >= assignmentCap || visits <= 0) return;
      visits -= 1;
      if (remaining === 0n) {
        chosen.push([...subset]);
        walk(outIndex + 1, used, chosen);
        chosen.pop();
        return;
      }
      if (index >= amounts.length || remaining < 0n) return;
      if (!used[index]) {
        used[index] = true;
        subset.push(index);
        pick(index + 1, remaining - amounts[index], subset);
        subset.pop();
        used[index] = false;
      }
      pick(index + 1, remaining, subset);
    };
    pick(0, targets[outIndex], []);
  };
  walk(0, new Array(amounts.length).fill(false), []);

  // No consistent assignment at all means the plan does not conserve value, and
  // `planJoin` refuses those. Reporting 0 keeps a broken plan from ever reading
  // as private.
  if (assignments === 0) return 0;
  // If the search was truncated, the counts below are a LOWER bound on the true
  // ambiguity — which is the safe direction to be wrong in.
  void exhausted;
  return Math.min(...viable.map((set) => set.size));
};

/**
 * Splits a value into standard denominations.
 *
 * Greedy from the largest, which is deterministic and therefore uniform across
 * agents — the property that matters here. A cleverer per-payout split would be
 * a fingerprint, exactly like a non-standard ring size.
 */
export const splitIntoDenominations = (
  value: bigint,
  denominationsAtomic: readonly bigint[],
  maxLegs: number,
): bigint[] => {
  const sorted = [...denominationsAtomic].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const legs: bigint[] = [];
  let remaining = value;
  for (const denomination of sorted) {
    while (remaining >= denomination && legs.length < maxLegs - 1) {
      legs.push(denomination);
      remaining -= denomination;
    }
  }
  // Whatever is left rides as one exact leg. It publishes its own value, which
  // is why `subsetSumAmbiguity` is reported per-output and not per-plan.
  if (remaining > 0n) legs.push(remaining);
  return legs.length > 0 ? legs : [value];
};

/**
 * Builds an atomic sweep-and-pay plan, or refuses with a reason.
 *
 * Refusing is a first-class outcome. A join that cannot reach `minInputs` has no
 * ambiguity to offer, and quietly broadcasting it anyway would publish a
 * one-to-one mapping while letting everyone believe otherwise.
 */
export const planJoin = (input: {
  available: readonly JoinInput[];
  payouts: readonly { payeeRef: string; amountAtomic: bigint }[];
  policy: JoinPolicy;
  nowMs: number;
  /**
   * Monotonic index for this join's ephemeral hub. Supplied by the caller (which
   * owns durable state) rather than generated here, so the planner stays pure
   * and a recovered plan re-derives the SAME hub instead of stranding funds at
   * one nobody can find again.
   */
  hubIndex: number;
  /** Deterministic decoy sizing; injected so tests are reproducible. */
  pickDecoyAmount: (index: number, denominations: readonly bigint[]) => bigint;
}): JoinPlan => {
  const empty = (refusal: JoinRefusal): JoinPlan =>
    ({ inputs: [], outputs: [], hubIndex: input.hubIndex, ambiguity: 0, refusal });

  if (input.payouts.length === 0) return empty("no-outputs");

  // Monero's spend lock: an input that can be spent the instant it lands makes
  // "was spent immediately" a usable signal all by itself.
  const mature = input.available
    .filter((candidate) => candidate.observedAtMs + input.policy.minInputAgeMs <= input.nowMs)
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  if (mature.length === 0) return empty("inputs-too-young");
  if (mature.length < input.policy.minInputs) return empty("insufficient-inputs");

  const inputs = mature.slice(0, input.policy.maxInputs);
  const inputTotal = sum(inputs.map((entry) => entry.amountAtomic));

  // Real payouts first, split into standard denominations.
  const outputs: JoinOutput[] = [];
  for (const payout of input.payouts) {
    for (const leg of splitIntoDenominations(
      payout.amountAtomic, input.policy.denominationsAtomic, input.policy.decoyCount + 2,
    )) {
      outputs.push({ kind: "payout", amountAtomic: leg, payeeRef: payout.payeeRef });
    }
  }
  const payoutTotal = sum(outputs.map((output) => output.amountAtomic));
  if (payoutTotal > inputTotal) return empty("insufficient-value");

  // Decoys, drawn in the SAME denominations as real legs so no predicate
  // separates them. They are funded from what would otherwise be change, so
  // they cost gas and never capital — the value lands on an address we control
  // and returns as a future input.
  let spare = inputTotal - payoutTotal;
  for (let index = 0; index < input.policy.decoyCount; index += 1) {
    // A decoy is the least important output in the plan, so nothing it does may
    // take the plan down with it. A picker that returns a non-bigint — an index
    // off the end of a short denomination list is the easy way — would otherwise
    // throw `Cannot mix BigInt and other types` from the comparison below and
    // fail a real payout for the sake of cover traffic.
    const amount = input.pickDecoyAmount(index, input.policy.denominationsAtomic);
    if (typeof amount !== "bigint" || amount <= 0n || amount > spare) continue;
    outputs.push({ kind: "decoy", amountAtomic: amount });
    spare -= amount;
  }
  if (spare > 0n) outputs.push({ kind: "change", amountAtomic: spare });

  if (outputs.length < input.policy.minOutputs) return empty("no-outputs");

  const plan = { inputs, outputs };
  return { ...plan, hubIndex: input.hubIndex, ambiguity: subsetSumAmbiguity(plan) };
};
