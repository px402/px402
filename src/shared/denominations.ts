import { randomInt } from "node:crypto";

export const DEFAULT_MAX_PAYOUT_LEGS = 8;
export const DEFAULT_MAX_PAYOUT_LEGS_SOLANA = 3;
export const ENUM_CAP = 200_000;
export const PAYOUT_POLICY_VERSION = "denom/v1";

export interface DenominationConfig {
  denominationsAtomic: bigint[];
  maxLegs: number;
}

export interface PayoutLeg {
  index: number;
  amountAtomic: string;
  denominationAtomic: string | null;
  kind: "denomination" | "exact";
}

export interface PayoutPlanShape {
  totalAtomic: string;
  onchainAtomic: string;
  offchainChangeAtomic: string;
  legs: PayoutLeg[];
  strategy: "single" | "denominations";
}

export interface DecomposeInput {
  totalAtomic: string;
  config: DenominationConfig;
  random?: () => number;
  offchainChange?: boolean;
}

interface RawDenominationConfig {
  denominationsAtomic?: unknown;
  maxLegs?: unknown;
}

const UINT32_RANGE = 2 ** 32;
const cryptoUniform = () => randomInt(0, UINT32_RANGE) / UINT32_RANGE;

export const defaultDenominationsAtomic = (decimals: number): bigint[] => {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error("Payout denomination decimals must be a non-negative safe integer");
  }
  const scale = 10n ** BigInt(Math.max(0, decimals - 1));
  return [1n, 2n, 5n, 10n, 20n, 50n, 100n, 200n, 500n, 1_000n]
    .map((value) => value * scale)
    .filter((value) => value <= 100n * (10n ** BigInt(decimals)));
};

export const parsePayoutDenominations = (
  json: string | undefined,
  networks: readonly { network: string; decimals: number; maxLegs?: number }[],
): Map<string, DenominationConfig> => {
  let configured: Record<string, unknown> = {};
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("PX402_PAYOUT_DENOMINATIONS must be valid JSON");
    }
    if (!isPlainObject(parsed)) {
      throw new Error("PX402_PAYOUT_DENOMINATIONS must be a network-keyed object");
    }
    configured = parsed;
  }

  const supported = new Set(networks.map(({ network }) => network));
  for (const network of Object.keys(configured)) {
    if (!supported.has(network)) {
      throw new Error(`Unknown payout denomination network: ${network}`);
    }
  }

  const result = new Map<string, DenominationConfig>();
  for (const network of networks) {
    const raw = configured[network.network];
    const objectConfig: RawDenominationConfig = Array.isArray(raw)
      ? { denominationsAtomic: raw }
      : raw === undefined
        ? {}
        : isPlainObject(raw)
          ? raw
          : (() => {
              throw new Error(`Payout denomination config for ${network.network} must be an array or object`);
            })();
    const denominationsAtomic = objectConfig.denominationsAtomic === undefined
      ? defaultDenominationsAtomic(network.decimals)
      : parseDenominationList(objectConfig.denominationsAtomic, network.network);
    const maxLegs = objectConfig.maxLegs === undefined
      ? network.maxLegs ?? DEFAULT_MAX_PAYOUT_LEGS
      : parseMaxLegs(objectConfig.maxLegs, network.network);
    const config = normalizeConfig({ denominationsAtomic, maxLegs });
    assertEnumerationBound(config);
    result.set(network.network, config);
  }
  return result;
};

export const decomposePayout = (input: DecomposeInput): PayoutPlanShape => {
  if (input.offchainChange === true) {
    throw new Error("Off-chain payout change is not enabled");
  }
  const total = parsePositiveAtomic(input.totalAtomic, "Payout total");
  const config = normalizeConfig(input.config);
  assertEnumerationBound(config);
  const denominations = config.denominationsAtomic;
  if (total < denominations[0]) return singlePlan(total);

  const exact: number[][] = [];
  const counts = Array<number>(denominations.length).fill(0);
  interface EnumerationFrame {
    denominationIndex: number;
    coins: number;
    sum: bigint;
    nextTake: number;
    maxTake: number;
  }
  const frameFor = (denominationIndex: number, coins: number, sum: bigint): EnumerationFrame => {
    const available = config.maxLegs - coins;
    const affordable = (total - sum) / denominations[denominationIndex];
    return {
      denominationIndex,
      coins,
      sum,
      nextTake: 0,
      maxTake: Math.min(available, affordable > BigInt(available) ? available : Number(affordable)),
    };
  };
  const stack: EnumerationFrame[] = [frameFor(0, 0, 0n)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.nextTake > frame.maxTake) {
      counts[frame.denominationIndex] = 0;
      stack.pop();
      continue;
    }
    const take = frame.nextTake;
    frame.nextTake += 1;
    counts[frame.denominationIndex] = take;
    const coins = frame.coins + take;
    const sum = frame.sum + denominations[frame.denominationIndex] * BigInt(take);
    if (sum === total) {
      exact.push([...counts]);
      continue;
    }
    const nextIndex = frame.denominationIndex + 1;
    if (nextIndex < denominations.length && coins < config.maxLegs) {
      stack.push(frameFor(nextIndex, coins, sum));
    }
  }

  if (exact.length === 0) return singlePlan(total);
  const random = input.random ?? cryptoUniform;
  const selected = exact[randomIndex(exact.length, random)];
  const legs: PayoutLeg[] = [];
  selected.forEach((count, denominationIndex) => {
    const amountAtomic = denominations[denominationIndex].toString();
    for (let index = 0; index < count; index += 1) {
      legs.push({
        index: legs.length,
        amountAtomic,
        denominationAtomic: amountAtomic,
        kind: "denomination",
      });
    }
  });
  for (let index = legs.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1, random);
    [legs[index], legs[swap]] = [legs[swap], legs[index]];
  }
  legs.forEach((leg, index) => {
    leg.index = index;
  });

  const sum = legs.reduce((value, leg) => value + BigInt(leg.amountAtomic), 0n);
  if (sum !== total || legs.length > config.maxLegs) {
    throw new Error("Payout decomposition violated value or leg-count preservation");
  }
  return {
    totalAtomic: total.toString(),
    onchainAtomic: total.toString(),
    offchainChangeAtomic: "0",
    legs,
    strategy: "denominations",
  };
};

const singlePlan = (total: bigint): PayoutPlanShape => ({
  totalAtomic: total.toString(),
  onchainAtomic: total.toString(),
  offchainChangeAtomic: "0",
  legs: [{
    index: 0,
    amountAtomic: total.toString(),
    denominationAtomic: null,
    kind: "exact",
  }],
  strategy: "single",
});

/**
 * The largest value `<= total` that tiles exactly into at most `maxLegs`
 * standard denominations, or `null` when even the smallest denomination does
 * not fit.
 *
 * Why this exists: `decomposePayout` falls back to `singlePlan` for any value it
 * cannot tile, and a single plan publishes the EXACT withdrawal amount on-chain
 * with `k_eff = 1` by construction (`denominationAtomic: null`). Measured against
 * the default 1-2-5 set, that fallback fires for 5.5% of values at `maxLegs = 8`
 * and **83% at `maxLegs = 3`** (Solana) — so most Solana pool payouts currently
 * publish their exact amount.
 *
 * A client holds `denominationsAtomic` and `maxLegs` from its quote's
 * `payoutPolicy`, so it can quantize BEFORE requesting the quote and leave the
 * remainder as ordinary ledger balance. That reaches the same end state as
 * off-chain change without its accounting: the residue is never debited, so the
 * payout stays a two-way `payer -= onchain; escrow += onchain` and per-asset
 * conservation on the reversal path is untouched.
 *
 * Quantizing AFTER a quote is issued cannot work and must not be attempted:
 * `validatePlanAgainstPolicy` requires `total === quote.maxAmountRequired`
 * (`payoutPlan.ts` §7.2), so a shrunken plan is hard-rejected before any debit.
 *
 * Pure and deterministic. Search space is the same bounded multiset enumeration
 * `decomposePayout` uses, so `assertEnumerationBound` caps it identically.
 */
export const largestTileableAtMost = (input: {
  totalAtomic: string;
  config: DenominationConfig;
}): string | null => {
  const total = parsePositiveAtomic(input.totalAtomic, "Quantization total");
  const config = normalizeConfig(input.config);
  assertEnumerationBound(config);
  // Descending, so the first branch reaches a large sum early and the
  // cannot-improve prune below cuts the rest of the tree aggressively.
  const denominations = [...config.denominationsAtomic].reverse();
  if (total < denominations[denominations.length - 1]) return null;

  // Explicit stack rather than recursion, matching `decomposePayout` above.
  // `assertEnumerationBound` caps the number of COMBINATIONS, not the search
  // depth: a valid config of ~10k denominations with maxLegs 1 has only
  // C(10001,10000) combinations — far under ENUM_CAP — yet a recursive walk would
  // descend once per denomination and overflow the JS stack. That is an
  // availability defect reachable from configuration alone.
  interface Frame { index: number; legsLeft: number; sum: bigint; nextTake: number }
  let best = 0n;
  const frameFor = (index: number, legsLeft: number, sum: bigint): Frame => {
    const affordable = (total - sum) / denominations[index];
    const maxTake = affordable > BigInt(legsLeft) ? legsLeft : Number(affordable);
    // Descend from the largest take first so a big sum is reached early and the
    // cannot-improve prune cuts the remaining branches.
    return { index, legsLeft, sum, nextTake: maxTake };
  };
  const stack: Frame[] = [frameFor(0, config.maxLegs, 0n)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.sum > best) best = frame.sum;
    if (best === total) break;
    if (frame.nextTake < 0
      || frame.legsLeft === 0
      || frame.index >= denominations.length
      // Cannot improve on `best` even by filling every remaining leg with the
      // largest denomination still available.
      || frame.sum + denominations[frame.index] * BigInt(frame.legsLeft) <= best) {
      stack.pop();
      continue;
    }
    const take = frame.nextTake;
    frame.nextTake -= 1;
    const sum = frame.sum + denominations[frame.index] * BigInt(take);
    if (sum > best) best = sum;
    if (best === total) break;
    if (frame.index + 1 < denominations.length && frame.legsLeft - take > 0) {
      stack.push(frameFor(frame.index + 1, frame.legsLeft - take, sum));
    }
  }
  return best === 0n ? null : best.toString();
};

const randomIndex = (length: number, random: () => number): number => {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Payout decomposition RNG must return a finite value in [0, 1)");
  }
  return Math.floor(value * length);
};

const normalizeConfig = (config: DenominationConfig): DenominationConfig => {
  const maxLegs = parseMaxLegs(config.maxLegs, "runtime");
  if (!Array.isArray(config.denominationsAtomic) || config.denominationsAtomic.length === 0) {
    throw new Error("Payout denominations must be a non-empty array");
  }
  const denominationsAtomic = config.denominationsAtomic.map((value) => {
    if (typeof value !== "bigint" || value <= 0n) {
      throw new Error("Payout denominations must contain only positive bigint values");
    }
    return value;
  }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (let index = 1; index < denominationsAtomic.length; index += 1) {
    if (denominationsAtomic[index] === denominationsAtomic[index - 1]) {
      throw new Error("Payout denominations must be distinct");
    }
  }
  return { denominationsAtomic, maxLegs };
};

const parseDenominationList = (raw: unknown, network: string): bigint[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Payout denominations for ${network} must be a non-empty array`);
  }
  return raw.map((value) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Payout denominations for ${network} must be positive safe integers`);
      }
      return BigInt(value);
    }
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw new Error(`Payout denominations for ${network} must be positive integer strings`);
    }
    return BigInt(value);
  });
};

const parseMaxLegs = (value: unknown, network: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Payout maxLegs for ${network} must be an integer >= 1`);
  }
  return Number(value);
};

const assertEnumerationBound = (config: DenominationConfig): void => {
  if (config.maxLegs > ENUM_CAP || config.denominationsAtomic.length > ENUM_CAP) {
    throw new Error(`Payout denomination search exceeds ENUM_CAP (${ENUM_CAP})`);
  }
  const combinations = chooseBounded(
    config.maxLegs + config.denominationsAtomic.length,
    config.denominationsAtomic.length,
    BigInt(ENUM_CAP),
  );
  if (combinations > BigInt(ENUM_CAP)) {
    throw new Error(`Payout denomination search exceeds ENUM_CAP (${ENUM_CAP})`);
  }
};

const chooseBounded = (n: number, k: number, cap: bigint): bigint => {
  const width = Math.min(k, n - k);
  let result = 1n;
  for (let index = 1; index <= width; index += 1) {
    result = (result * BigInt(n - width + index)) / BigInt(index);
    if (result > cap) return result;
  }
  return result;
};

const parsePositiveAtomic = (value: string, label: string): bigint => {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer string`);
  return BigInt(value);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Denomination parity across rails (spec-exit-rounds.md §3.4, thesis 6:
 * "parity is enforced, not asserted").
 *
 * Nothing else prevents a config change from making an amount private on one rail
 * and public on another: the ladders are parsed per network and never compared, so
 * a value that tiles on Base and not on Solana silently publishes its exact amount
 * there — and an exact leg pins that window's `k_eff` to 1 for everyone in it.
 *
 * Two deliberate properties:
 *
 * 1. **Human units, compared by cross-multiplication.** Rails may differ in token
 *    decimals, so atomic values are not comparable directly. Normalizing by
 *    dividing into integers is worse than useless: `100000n / 10n**6n` and
 *    `150000n / 10n**6n` are both `0n`, so a truncating check silently equates 0.1
 *    and 0.15 and the validator asserts nothing.
 * 2. **Actionable failure.** Default `maxLegs` is 8 on EVM and 3 on Solana, so the
 *    default config FAILS this check — by design. Solana's cap is a priced decision
 *    (§3.2: each extra leg strands ~0.00204 SOL of unrecoverable ATA rent), and the
 *    point of this gate is that the decision gets made rather than drifted into.
 */
export const assertDenominationParity = (input: {
  byNetwork: ReadonlyMap<string, DenominationConfig>;
  decimalsByNetwork: ReadonlyMap<string, number>;
}): void => {
  const networks = [...input.byNetwork.keys()].sort();
  if (networks.length < 2) return;

  const decimalsFor = (network: string): bigint => {
    const decimals = input.decimalsByNetwork.get(network);
    if (decimals === undefined) {
      throw new Error(`Payout denomination parity: no token decimals known for ${network}`);
    }
    return BigInt(decimals);
  };

  const [reference, ...rest] = networks;
  const referenceConfig = input.byNetwork.get(reference) as DenominationConfig;
  const referenceScale = 10n ** decimalsFor(reference);

  for (const network of rest) {
    const config = input.byNetwork.get(network) as DenominationConfig;
    const scale = 10n ** decimalsFor(network);

    if (config.maxLegs !== referenceConfig.maxLegs) {
      throw new Error(
        `Payout denomination parity: ${network} allows ${config.maxLegs} legs but `
        + `${reference} allows ${referenceConfig.maxLegs}. Cohorts require an identical `
        + `effective maxLegs on every rail, because a value that tiles on one rail and not `
        + `another publishes an exact amount there and pins that window's k_eff to 1. `
        + `Resolve by setting PX402_PAYOUT_DENOMINATIONS with a matching maxLegs on all `
        + `rails — note that raising Solana's is a priced decision (spec-exit-rounds.md §3.2: `
        + `~0.00204 SOL of unrecoverable ATA rent per extra leg), not a default bump.`,
      );
    }

    if (config.denominationsAtomic.length !== referenceConfig.denominationsAtomic.length) {
      throw new Error(
        `Payout denomination parity: ${network} advertises `
        + `${config.denominationsAtomic.length} denominations but ${reference} advertises `
        + `${referenceConfig.denominationsAtomic.length}`,
      );
    }

    for (let index = 0; index < config.denominationsAtomic.length; index += 1) {
      const mine = config.denominationsAtomic[index];
      const theirs = referenceConfig.denominationsAtomic[index];
      // Equal in human units iff mine/scale === theirs/referenceScale. Cross-multiply
      // so this stays exact integer arithmetic — see the truncation trap above.
      if (mine * referenceScale !== theirs * scale) {
        throw new Error(
          `Payout denomination parity: ${network} denomination ${mine} (${config.denominationsAtomic.length} `
          + `tiers, ${decimalsFor(network)} decimals) is not the same human-unit value as `
          + `${reference} denomination ${theirs}. Ladders must match in human units across rails.`,
        );
      }
    }
  }
};
