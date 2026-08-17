import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAYOUT_POLICY_VERSION } from "../shared/denominations";
import type { PayoutQuantizeMode } from "../shared/payoutPlan";
import type { ChainRail } from "./rails/ChainRail";

export type StealthInboxClaimMode = "off" | "agent" | "browser";

/**
 * `PX402_PAYOUT_QUANTIZE` (docs/spec-exit-rounds.md §8.1).
 *
 * Defaults to `off` so enabling server-side tileability enforcement stays an
 * explicit operator decision — an unrecognised value throws rather than silently
 * degrading to `off`, because a typo'd privacy flag that reads as "disabled" is
 * exactly the scaffolding-theater failure this repo bans.
 */
const resolvePayoutQuantizeMode = (raw: string | undefined): PayoutQuantizeMode => {
  if (raw === undefined || raw === "") return "off";
  if (raw === "off" || raw === "advise" || raw === "enforce") return raw;
  throw new Error(
    `PX402_PAYOUT_QUANTIZE must be one of off|advise|enforce, got ${JSON.stringify(raw)}`,
  );
};

export interface ServerConfig {
  /** Public status server (health, privacy transparency, stealth inbox). */
  host: string;
  port: number;
  /**
   * Bound into every browser-scoped stealth intent signature so a signature
   * produced against staging cannot be replayed against production. Required
   * whenever the browser inbox is enabled.
   */
  deploymentId?: string;
  storage: {
    encryptionKey?: string;
  };
  admin: {
    token?: string;
  };
  agentRpc: {
    enabled: boolean;
    host: string;
    port: number;
    endpointsJson?: string;
    privateLedgerEnabled: boolean;
    blindVouchersEnabled: boolean;
    blindVoucherDenominationsAtomic: string[];
    blindVoucherKeysetGraceMs: number;
    blindVoucherMintIdentityKey?: string;
    blindVoucherMaxOutputsPerRequest: number;
    blindVoucherMaxProofsPerRequest: number;
    poolPayoutEnabled: boolean;
    poolPayoutBatchingEnabled: boolean;
    payoutDenominationsEnabled: boolean;
    payoutQuantizeMode: PayoutQuantizeMode;
    /**
     * Master switch for denomination-pure exit cohorts (docs/spec-exit-rounds.md).
     * Off ⇒ the frozen §4 concentration gate is unchanged. On ⇒ startup enforces
     * rail parity and requires batching, because a cohort that cannot be dispatched
     * as a unit is not a cohort.
     */
    poolPayoutCohortsEnabled: boolean;
    payoutDenominationsJson?: string;
    payoutPolicyVersion: string;
    poolPayoutFlushMs: number;
    poolPayoutMaxJitterMs: number;
    poolPayoutKEffTarget: number;
    poolPayoutKEffAdaptive: boolean;
    poolPayoutKEffCeiling: number;
    poolPayoutKEffAdaptiveWindowMs: number;
    poolPayoutKEffAdaptiveMinSamples: number;
    poolPayoutKEffAdaptiveQuantile: number;
    poolPayoutMaxHoldMs: number;
    poolPayoutConcentrationEnabled: boolean;
    poolPayoutKEffPublishEnabled: boolean;
    poolPayoutScheduleEpochMs: number;
    poolPayoutMaxAttempts: number;
    poolPayoutFinality: "finalized" | "safe";
    poolPayoutConfirmationFloor: number;
    poolPayoutTimeoutMs: number;
    poolPayoutReconcileMs: number;
    poolPayoutRecoveryBudgetMs: number;
    poolPayoutFeeBumpAfterMs: number;
    poolPayoutDispatchGraceMs: number;
    poolPayoutClaimTtlMs: number;
    privateLedgerRetentionMs: number;
    privateLedgerSweepMs: number;
    privateLedgerEphemeralDirectory: string;
    privateLedgerRequireMemoryBacked: boolean;
    stealthDepositsEnabled: boolean;
    stealthInboxEnabled: boolean;
    stealthInboxRetentionMs: number;
    stealthInboxDormantMs: number;
    stealthSweepRelayEnabled: boolean;
    stealthInboxReapMs: number;
    stealthInboxBrowserEnabled: boolean;
    stealthInboxBrowserClaim: StealthInboxClaimMode;
    stealthInboxRatePerMinute: number;
    stealthInboxPageSize: number;
    stealthInboxSubscriptionTtlMs: number;
    stealthInboxPairTicketTtlMs: number;
    // Requested only. `resolveStealthSimulationGate` decides whether it applies.
    stealthInboxSimulationRequested: boolean;
    depositSweepMs: number;
    depositSweepMinAgeMs: number;
    depositSweepMaxPerRun: number;
    depositSweepConfirmations: number;
    depositRetentionMs: number;
    depositUnpaidGraceMs: number;
    depositSweepBackoffMs: number;
    depositSweepMaxAttempts: number;
  };
  base: {
    chainId: 8453;
    rpcUrl: string;
    treasury: string;
    x402: {
      // funded relayer that broadcasts the EIP-3009 transfer; absent => dry-run
      settlerPrivateKey?: string;
      usdcAddress: string;
      usdcDomainName: string;
      usdcDomainVersion: string;
      batchCommitmentContract?: string;
    };
  };
  robinhood: {
    chainId: number;
    rpcUrl: string;
    treasury: string;
    x402: {
      // funded relayer that broadcasts the EIP-3009 USDG transfer; absent => dry-run
      settlerPrivateKey?: string;
      usdgAddress: string;
      usdgDomainName: string;
      usdgDomainVersion: string;
      batchCommitmentContract?: string;
    };
  };
  solana: {
    rpcUrl: string;
    historyRpcUrl?: string;
    usdcMint: string;
    treasury: string;
    x402: {
      // base58 fee-payer keypair; absent => verify-and-simulate dry-run
      settlerSecretKey?: string;
    };
    /** Token-2022 mint with the ConfidentialTransferMint extension. */
    confidentialMint: string;
  };
  /** Confidential x402 (docs/spec-confidential-x402.md §9). Default-off throughout. */
  confidential: {
    enabled: boolean;
    /** Raw JSON; parsed and validated by `resolveConfidentialNetworks`. */
    networks: string;
    baseContract: string;
    rhContract: string;
    verifyingKeyHash: string;
    proofTimeoutMs: number;
  };
}

export const config: ServerConfig = {
  host: process.env.PX402_HOST ?? "127.0.0.1",
  port: Number(process.env.PX402_PORT ?? 8787),
  deploymentId: process.env.PX402_DEPLOYMENT_ID,
  storage: {
    encryptionKey: process.env.PX402_DATA_ENCRYPTION_KEY
  },
  admin: {
    token: process.env.PX402_ADMIN_TOKEN
  },
  agentRpc: {
    enabled: process.env.PX402_AGENT_RPC_ENABLED === "true",
    host: process.env.PX402_AGENT_RPC_HOST ?? "127.0.0.1",
    port: Number(process.env.PX402_AGENT_RPC_PORT ?? 3099),
    endpointsJson: process.env.PX402_AGENT_ENDPOINTS,
    privateLedgerEnabled: process.env.PX402_PRIVATE_LEDGER_ENABLED === "true",
    blindVouchersEnabled: process.env.PX402_BLIND_VOUCHERS_ENABLED === "true",
    blindVoucherDenominationsAtomic: parseDenoms(
      process.env.PX402_BLIND_VOUCHER_DENOMINATIONS,
    ) ?? ["100000", "1000000", "10000000", "100000000"],
    blindVoucherKeysetGraceMs: parseSafeMs(
      process.env.PX402_BLIND_VOUCHER_KEYSET_GRACE_MS,
      1000 * 60 * 60 * 24 * 7,
    ),
    blindVoucherMintIdentityKey:
      process.env.PX402_BLIND_VOUCHER_MINT_IDENTITY_KEY,
    blindVoucherMaxOutputsPerRequest: Number(
      process.env.PX402_BLIND_VOUCHER_MAX_OUTPUTS ?? 64,
    ),
    blindVoucherMaxProofsPerRequest: Number(
      process.env.PX402_BLIND_VOUCHER_MAX_PROOFS ?? 64,
    ),
    poolPayoutEnabled: process.env.PX402_POOL_PAYOUT_ENABLED === "true",
    poolPayoutBatchingEnabled: process.env.PX402_POOL_PAYOUT_BATCHING_ENABLED === "true",
    payoutDenominationsEnabled: process.env.PX402_POOL_PAYOUT_DENOMINATIONS_ENABLED === "true",
    payoutQuantizeMode: resolvePayoutQuantizeMode(process.env.PX402_PAYOUT_QUANTIZE),
    poolPayoutCohortsEnabled: process.env.PX402_POOL_PAYOUT_COHORTS_ENABLED === "true",
    payoutDenominationsJson: process.env.PX402_PAYOUT_DENOMINATIONS,
    payoutPolicyVersion: process.env.PX402_PAYOUT_POLICY_VERSION ?? PAYOUT_POLICY_VERSION,
    poolPayoutFlushMs: Number(process.env.PX402_POOL_PAYOUT_FLUSH_MS ?? 60_000),
    poolPayoutMaxJitterMs: Number(process.env.PX402_POOL_PAYOUT_MAX_JITTER_MS ?? 30_000),
    poolPayoutKEffTarget: Number(process.env.PX402_POOL_PAYOUT_KEFF_TARGET ?? 1),
    poolPayoutKEffAdaptive: process.env.PX402_POOL_PAYOUT_KEFF_ADAPTIVE === "true",
    poolPayoutKEffCeiling: Number(process.env.PX402_POOL_PAYOUT_KEFF_CEILING ?? 8),
    poolPayoutKEffAdaptiveWindowMs:
      Number(process.env.PX402_POOL_PAYOUT_KEFF_ADAPTIVE_WINDOW_MS ?? 21_600_000),
    poolPayoutKEffAdaptiveMinSamples:
      Number(process.env.PX402_POOL_PAYOUT_KEFF_ADAPTIVE_MIN_SAMPLES ?? 20),
    poolPayoutKEffAdaptiveQuantile:
      Number(process.env.PX402_POOL_PAYOUT_KEFF_ADAPTIVE_QUANTILE ?? 0.5),
    poolPayoutMaxHoldMs: Number(process.env.PX402_POOL_PAYOUT_MAX_HOLD_MS ?? 900_000),
    poolPayoutConcentrationEnabled: process.env.PX402_POOL_PAYOUT_CONCENTRATION_ENABLED === "true",
    poolPayoutKEffPublishEnabled: process.env.PX402_POOL_PAYOUT_KEFF_PUBLISH_ENABLED === "true",
    poolPayoutScheduleEpochMs: Number(process.env.PX402_POOL_PAYOUT_SCHEDULE_EPOCH_MS ?? 3_600_000),
    poolPayoutMaxAttempts: Number(process.env.PX402_POOL_PAYOUT_MAX_ATTEMPTS ?? 3),
    poolPayoutFinality: parsePoolPayoutFinality(process.env.PX402_POOL_PAYOUT_FINALITY),
    poolPayoutConfirmationFloor: Number(process.env.PX402_POOL_PAYOUT_CONFIRMATION_FLOOR ?? 6),
    poolPayoutTimeoutMs: Number(process.env.PX402_POOL_PAYOUT_TIMEOUT_MS ?? 120_000),
    poolPayoutReconcileMs: Number(process.env.PX402_POOL_PAYOUT_RECONCILE_MS ?? 30_000),
    poolPayoutRecoveryBudgetMs: Number(process.env.PX402_POOL_PAYOUT_RECOVERY_BUDGET_MS ?? 15_000),
    poolPayoutFeeBumpAfterMs: Number(process.env.PX402_POOL_PAYOUT_FEE_BUMP_AFTER_MS ?? 45_000),
    // H7 dispatch grace (docs/spec-cohort-dispatch.md §2.4): 90s = two default fee-bump
    // intervals with zero on-chain evidence before absence counts as ambiguity.
    poolPayoutDispatchGraceMs: Number(process.env.PX402_POOL_PAYOUT_DISPATCH_GRACE_MS ?? 90_000),
    poolPayoutClaimTtlMs: Number(process.env.PX402_POOL_PAYOUT_CLAIM_TTL_MS ?? 900_000),
    privateLedgerRetentionMs: Number(
      process.env.PX402_PRIVATE_LEDGER_RETENTION_MS ?? 1000 * 60 * 15
    ),
    privateLedgerSweepMs: Number(
      process.env.PX402_PRIVATE_LEDGER_SWEEP_MS ?? 1000 * 30
    ),
    privateLedgerEphemeralDirectory: process.env.PX402_PRIVATE_LEDGER_EPHEMERAL_DIR
      ?? join(tmpdir(), "px402", "payment-epochs"),
    privateLedgerRequireMemoryBacked: process.env.PX402_PRIVATE_LEDGER_REQUIRE_TMPFS
      ? process.env.PX402_PRIVATE_LEDGER_REQUIRE_TMPFS === "true"
      : process.env.NODE_ENV === "production",
    stealthDepositsEnabled: process.env.PX402_STEALTH_DEPOSITS_ENABLED === "true",
    // Defaults ON, deliberately unlike every other privacy flag here. Those add
    // a surface; this closes a fund-loss hole — without the announcement index a
    // payee can never locate or spend a stealth payout. It moves no funds and
    // adds no trust assumption (the server already holds the payee viewing key
    // and already derives these addresses). Opt OUT with "false".
    stealthInboxEnabled: process.env.PX402_STEALTH_INBOX_ENABLED !== "false",
    stealthInboxRetentionMs: Number(
      process.env.PX402_STEALTH_INBOX_RETENTION_MS ?? 900_000,
    ),
    stealthInboxDormantMs: Number(
      process.env.PX402_STEALTH_INBOX_DORMANT_MS ?? 86_400_000,
    ),
    // Defaults OFF, unlike the inbox above: this one broadcasts with the
    // settler's gas, so it is new value-moving surface and takes the normal
    // flag-off convention.
    stealthSweepRelayEnabled: process.env.PX402_STEALTH_SWEEP_RELAY_ENABLED === "true",
    stealthInboxReapMs: Number(
      process.env.PX402_STEALTH_INBOX_REAP_MS ?? 300_000,
    ),
    stealthInboxBrowserEnabled:
      process.env.PX402_STEALTH_INBOX_BROWSER_ENABLED === "true",
    stealthInboxBrowserClaim: parseStealthInboxClaimMode(
      process.env.PX402_STEALTH_INBOX_BROWSER_CLAIM,
    ),
    stealthInboxRatePerMinute: Number(
      process.env.PX402_STEALTH_INBOX_RATE_PER_MIN ?? 30,
    ),
    stealthInboxPageSize: Number(
      process.env.PX402_STEALTH_INBOX_PAGE_SIZE ?? 8,
    ),
    stealthInboxSubscriptionTtlMs: Number(
      process.env.PX402_STEALTH_INBOX_SUBSCRIPTION_TTL_MS ?? 600_000,
    ),
    stealthInboxPairTicketTtlMs: Number(
      process.env.PX402_STEALTH_INBOX_PAIR_TICKET_TTL_MS ?? 300_000,
    ),
    stealthInboxSimulationRequested:
      process.env.PX402_STEALTH_INBOX_SIMULATION === "true",
    depositSweepMs: Number(process.env.PX402_DEPOSIT_SWEEP_MS ?? 60_000),
    depositSweepMinAgeMs: Number(
      process.env.PX402_DEPOSIT_SWEEP_MIN_AGE_MS ?? 300_000,
    ),
    depositSweepMaxPerRun: Number(
      process.env.PX402_DEPOSIT_SWEEP_MAX_PER_RUN ?? 8,
    ),
    depositSweepConfirmations: Number(
      process.env.PX402_DEPOSIT_SWEEP_CONFIRMATIONS ?? 2,
    ),
    depositRetentionMs: Number(
      process.env.PX402_DEPOSIT_RETENTION_MS ?? 900_000,
    ),
    depositUnpaidGraceMs: Number(
      process.env.PX402_DEPOSIT_UNPAID_GRACE_MS ?? 86_400_000,
    ),
    depositSweepBackoffMs: Number(
      process.env.PX402_DEPOSIT_SWEEP_BACKOFF_MS ?? 30_000,
    ),
    depositSweepMaxAttempts: Number(
      process.env.PX402_DEPOSIT_SWEEP_MAX_ATTEMPTS ?? 10,
    ),
  },
  base: {
    chainId: 8453,
    rpcUrl: process.env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org",
    treasury: process.env.PX402_BASE_TREASURY ?? "",
    x402: {
      settlerPrivateKey: process.env.PX402_BASE_X402_SETTLER_KEY,
      usdcAddress: process.env.PX402_BASE_USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      usdcDomainName: process.env.PX402_BASE_USDC_DOMAIN_NAME ?? "USD Coin",
      usdcDomainVersion: process.env.PX402_BASE_USDC_DOMAIN_VERSION ?? "2",
      batchCommitmentContract: process.env.PX402_PRIVATE_BATCH_CONTRACT
    }
  },
  robinhood: {
    chainId: 4663,
    rpcUrl: process.env.PX402_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    treasury: process.env.PX402_RH_TREASURY ?? process.env.PX402_BASE_TREASURY ?? "",
    x402: {
      settlerPrivateKey: process.env.PX402_RH_X402_SETTLER_KEY,
      usdgAddress: process.env.PX402_RH_USDG_ADDRESS ?? "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      usdgDomainName: process.env.PX402_RH_USDG_DOMAIN_NAME ?? "Global Dollar",
      usdgDomainVersion: process.env.PX402_RH_USDG_DOMAIN_VERSION ?? "1",
      batchCommitmentContract: process.env.PX402_RH_PRIVATE_BATCH_CONTRACT
    }
  },
  solana: {
    rpcUrl: process.env.PX402_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    historyRpcUrl: process.env.PX402_SOLANA_HISTORY_RPC_URL,
    usdcMint: process.env.PX402_SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    treasury: process.env.PX402_SOLANA_TREASURY ?? "",
    x402: {
      settlerSecretKey: process.env.PX402_SOLANA_X402_SETTLER_KEY
    },
    // Token-2022 mint carrying the ConfidentialTransferMint extension
    // (docs/spec-confidential-x402.md §5/§9). Distinct from `usdcMint`: the
    // confidential rail is a different token, not a mode of the same one.
    confidentialMint: process.env.PX402_SOLANA_CONFIDENTIAL_MINT ?? ""
  },
  // Confidential x402 (docs/spec-confidential-x402.md §9). Every value default-off:
  // flag off ⇒ the scheme is never advertised and no confidential rail is built.
  confidential: {
    enabled: process.env.PX402_CONFIDENTIAL_X402_ENABLED === "true",
    networks: process.env.PX402_CONFIDENTIAL_NETWORKS ?? "[]",
    baseContract: process.env.PX402_BASE_CONFIDENTIAL_CONTRACT ?? "",
    rhContract: process.env.PX402_RH_CONFIDENTIAL_CONTRACT ?? "",
    /** Required whenever an EVM contract is set; a mismatch THROWS (§6.4). */
    verifyingKeyHash: process.env.PX402_CONFIDENTIAL_VERIFYING_KEY_HASH ?? "",
    proofTimeoutMs: Number(process.env.PX402_CONFIDENTIAL_PROOF_TIMEOUT_MS ?? 30_000)
  }
};

/**
 * Confidential-scheme config validation (§9).
 *
 * Safe to call with the flag off, in which case it only guarantees that a
 * half-configured deployment cannot silently advertise a capability it does
 * not have.
 */
export const resolveConfidentialNetworks = (): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config.confidential.networks);
  } catch {
    throw new Error("PX402_CONFIDENTIAL_NETWORKS must be a JSON array of network ids");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("PX402_CONFIDENTIAL_NETWORKS must be a JSON array of network ids");
  }
  const networks = parsed as string[];
  const unique = new Set(networks);
  if (unique.size !== networks.length) {
    throw new Error("PX402_CONFIDENTIAL_NETWORKS must not repeat a network");
  }
  if (!config.confidential.enabled) return [];
  if (
    !Number.isFinite(config.confidential.proofTimeoutMs)
    || config.confidential.proofTimeoutMs <= 0
  ) {
    throw new Error("PX402_CONFIDENTIAL_PROOF_TIMEOUT_MS must be a positive finite number");
  }
  for (const network of unique) {
    if (network === "solana") {
      // §5.1 — no mint, no capability. Asserting the auditor key is null happens
      // against the LIVE mint at startup, not from config: a config value cannot
      // prove what the deployed mint actually allows.
      if (!config.solana.confidentialMint) {
        throw new Error("PX402_SOLANA_CONFIDENTIAL_MINT is required to enable confidential solana");
      }
      continue;
    }
    const contract = network === "base"
      ? config.confidential.baseContract
      : network === "robinhood"
        ? config.confidential.rhContract
        : undefined;
    if (contract === undefined) {
      throw new Error(`PX402_CONFIDENTIAL_NETWORKS contains an unsupported network: ${network}`);
    }
    if (!contract) {
      throw new Error(`A PX402Confidential contract address is required to enable confidential ${network}`);
    }
    // §6.4 — a confidential contract with an unverified verifying key is a
    // contract that can mint. Refuse to start rather than trust it.
    if (!config.confidential.verifyingKeyHash) {
      throw new Error("PX402_CONFIDENTIAL_VERIFYING_KEY_HASH is required when an EVM confidential contract is set");
    }
  }
  return [...unique];
};

const queueDurations = {
  poolPayoutFlushMs: config.agentRpc.poolPayoutFlushMs,
  poolPayoutMaxJitterMs: config.agentRpc.poolPayoutMaxJitterMs,
  poolPayoutTimeoutMs: config.agentRpc.poolPayoutTimeoutMs,
  poolPayoutRecoveryBudgetMs: config.agentRpc.poolPayoutRecoveryBudgetMs,
  poolPayoutFeeBumpAfterMs: config.agentRpc.poolPayoutFeeBumpAfterMs,
  poolPayoutDispatchGraceMs: config.agentRpc.poolPayoutDispatchGraceMs,
  poolPayoutClaimTtlMs: config.agentRpc.poolPayoutClaimTtlMs,
};
for (const [name, value] of Object.entries(queueDurations)) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}
// The H7 dispatch grace must sit at or below the submit timeout. A live
// submission quarantines at poolPayoutTimeoutMs regardless of age; a grace
// beyond that keeps the journal reporting "pending / in-flight" for an entry
// the coordinator has already quarantined underneath — a split-brain read for
// the operator, and a wider window for the restart dead-end the recovery
// follow-up exists to close.
if (config.agentRpc.poolPayoutDispatchGraceMs > config.agentRpc.poolPayoutTimeoutMs) {
  throw new Error(
    "PX402_POOL_PAYOUT_DISPATCH_GRACE_MS must not exceed PX402_POOL_PAYOUT_TIMEOUT_MS",
  );
}
// Payout concentration (docs/spec-payout-concentration.md §8). kEffTarget=1 keeps
// the gate inert, so these defaults reproduce prior behavior apart from jitter.
if (config.agentRpc.poolPayoutMaxJitterMs > config.agentRpc.poolPayoutFlushMs * 4) {
  throw new Error("PX402_POOL_PAYOUT_MAX_JITTER_MS must be <= flushMs * 4");
}
if (
  !Number.isInteger(config.agentRpc.poolPayoutKEffTarget)
  || config.agentRpc.poolPayoutKEffTarget < 1
) {
  throw new Error("PX402_POOL_PAYOUT_KEFF_TARGET must be an integer >= 1");
}
// docs/spec-exit-rounds.md §4 — a STATIC target above 1 is prohibited in production.
//
// It is exactly the low-volume latency trap the frozen spec's §14 was written to
// eliminate: a fixed K=4 with no concurrent traffic holds every window to
// maxHoldMs waiting for cover that never arrives, and the deployment where that
// hurts most is the one with a single user. "The operator set it wrong" is not an
// acceptable failure mode for a privacy guarantee that must hold at N=1, so it is
// rejected rather than warned about.
//
// Rejected even when adaptive is ON, where the static value is silently ignored:
// config that reads as "K=4" but does nothing is its own hazard, and an operator
// who later turns adaptive off would inherit the trap without touching this line.
// Tests keep the static path — they set it in-process, never through env.
if (
  process.env.NODE_ENV === "production"
  && config.agentRpc.poolPayoutConcentrationEnabled
  && config.agentRpc.poolPayoutKEffTarget > 1
) {
  throw new Error(
    "PX402_POOL_PAYOUT_KEFF_TARGET must be 1 in production: a static target holds"
    + " lone withdrawers for cover that may never arrive. Use"
    + " PX402_POOL_PAYOUT_KEFF_ADAPTIVE=true with PX402_POOL_PAYOUT_KEFF_CEILING,"
    + " which stays at 1 until that lane has its own observed concurrency",
  );
}
// §14 adaptive target. The ceiling is an upper bound the gate may work toward, never
// itself a target: with adaptive on and no observed concurrency the effective target
// is 1, so a low-user-count deployment is never held.
if (
  !Number.isInteger(config.agentRpc.poolPayoutKEffCeiling)
  || config.agentRpc.poolPayoutKEffCeiling < 1
) {
  throw new Error("PX402_POOL_PAYOUT_KEFF_CEILING must be an integer >= 1");
}
if (
  !Number.isFinite(config.agentRpc.poolPayoutKEffAdaptiveWindowMs)
  || config.agentRpc.poolPayoutKEffAdaptiveWindowMs <= 0
) {
  throw new Error("PX402_POOL_PAYOUT_KEFF_ADAPTIVE_WINDOW_MS must be positive and finite");
}
if (
  !Number.isInteger(config.agentRpc.poolPayoutKEffAdaptiveMinSamples)
  || config.agentRpc.poolPayoutKEffAdaptiveMinSamples < 1
) {
  throw new Error("PX402_POOL_PAYOUT_KEFF_ADAPTIVE_MIN_SAMPLES must be an integer >= 1");
}
if (
  !Number.isFinite(config.agentRpc.poolPayoutKEffAdaptiveQuantile)
  || config.agentRpc.poolPayoutKEffAdaptiveQuantile < 0
  || config.agentRpc.poolPayoutKEffAdaptiveQuantile > 1
) {
  throw new Error("PX402_POOL_PAYOUT_KEFF_ADAPTIVE_QUANTILE must be between 0 and 1");
}
{
  const maxHold = config.agentRpc.poolPayoutMaxHoldMs;
  if (
    !Number.isFinite(maxHold)
    || maxHold <= config.agentRpc.poolPayoutFlushMs
    || maxHold > 86_400_000
  ) {
    throw new Error("PX402_POOL_PAYOUT_MAX_HOLD_MS must be finite, > flushMs, and <= 24h");
  }
}
if (
  !Number.isFinite(config.agentRpc.poolPayoutScheduleEpochMs)
  || config.agentRpc.poolPayoutScheduleEpochMs <= 0
) {
  throw new Error("PX402_POOL_PAYOUT_SCHEDULE_EPOCH_MS must be a positive finite number");
}
if (!Number.isInteger(config.agentRpc.poolPayoutMaxAttempts)
  || config.agentRpc.poolPayoutMaxAttempts < 1) {
  throw new Error("poolPayoutMaxAttempts must be an integer >= 1");
}
if (!Number.isInteger(config.agentRpc.poolPayoutConfirmationFloor)
  || config.agentRpc.poolPayoutConfirmationFloor < 1) {
  throw new Error("poolPayoutConfirmationFloor must be an integer >= 1");
}
if (!Number.isInteger(config.agentRpc.blindVoucherMaxOutputsPerRequest)
  || config.agentRpc.blindVoucherMaxOutputsPerRequest < 1) {
  throw new Error("blindVoucherMaxOutputsPerRequest must be an integer >= 1");
}
if (!Number.isInteger(config.agentRpc.blindVoucherMaxProofsPerRequest)
  || config.agentRpc.blindVoucherMaxProofsPerRequest < 1) {
  throw new Error("blindVoucherMaxProofsPerRequest must be an integer >= 1");
}

export const validateDepositConfig = () => {
  const positiveDurations = {
    depositSweepMs: config.agentRpc.depositSweepMs,
    depositSweepMinAgeMs: config.agentRpc.depositSweepMinAgeMs,
    depositRetentionMs: config.agentRpc.depositRetentionMs,
    depositUnpaidGraceMs: config.agentRpc.depositUnpaidGraceMs,
    depositSweepBackoffMs: config.agentRpc.depositSweepBackoffMs,
  };
  for (const [name, value] of Object.entries(positiveDurations)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  const positiveIntegers = {
    depositSweepMaxPerRun: config.agentRpc.depositSweepMaxPerRun,
    depositSweepConfirmations: config.agentRpc.depositSweepConfirmations,
    depositSweepMaxAttempts: config.agentRpc.depositSweepMaxAttempts,
  };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be an integer >= 1`);
    }
  }
  const intentLifetimeMs = 900_000;
  if (config.agentRpc.depositUnpaidGraceMs < intentLifetimeMs) {
    throw new Error("depositUnpaidGraceMs must be >= the 900 second deposit intent lifetime");
  }
};

validateDepositConfig();

/**
 * The browser inbox is the first surface where a key that is not an operator's
 * lives outside WireGuard, so its prerequisites are enforced at boot rather than
 * discovered at the first request. Durations are checked unconditionally: a
 * malformed one is a misconfiguration whether or not the flag is on today.
 */
export const validateStealthInboxConfig = () => {
  const positiveDurations = {
    stealthInboxReapMs: config.agentRpc.stealthInboxReapMs,
    stealthInboxSubscriptionTtlMs: config.agentRpc.stealthInboxSubscriptionTtlMs,
    stealthInboxPairTicketTtlMs: config.agentRpc.stealthInboxPairTicketTtlMs,
  };
  for (const [name, value] of Object.entries(positiveDurations)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  const positiveIntegers = {
    stealthInboxRatePerMinute: config.agentRpc.stealthInboxRatePerMinute,
    stealthInboxPageSize: config.agentRpc.stealthInboxPageSize,
  };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be an integer >= 1`);
    }
  }
  if (!config.agentRpc.stealthInboxBrowserEnabled) return;
  if (!config.storage.encryptionKey) {
    throw new Error("Browser stealth inbox requires PX402_DATA_ENCRYPTION_KEY");
  }
  if (!config.agentRpc.privateLedgerEnabled) {
    throw new Error("Browser stealth inbox requires PX402_PRIVATE_LEDGER_ENABLED");
  }
  // There is no self-service pairing path, not even in development: a
  // self-asserted agentId establishing a credential is the whole bug class this
  // surface has to avoid. Without an admin token nothing could ever be paired.
  if (!config.admin.token) {
    throw new Error("Browser stealth inbox requires PX402_ADMIN_TOKEN to mint pairing tickets");
  }
  if (!config.deploymentId?.trim()) {
    throw new Error("Browser stealth inbox requires PX402_DEPLOYMENT_ID");
  }
};

validateStealthInboxConfig();

/**
 * Tier 1 of the stealth demo. An OBJECT rather than a boolean precisely so a
 * stray `true` from a parsed env var, a default parameter, or a truthy config
 * read cannot satisfy `if (gate)` somewhere downstream — the only way to hold
 * one is to have been handed one by this function.
 *
 * All four conditions, no shortcuts: requested; not production; every rail
 * settling dry-run; every rail paying out dry-run. With every rail dry-run
 * there is no key in the process that can move value anywhere, which is what
 * makes an accidental enable inert rather than dangerous.
 */
export interface StealthSimulationGate {
  readonly reason: "all-rails-dry-run";
}

export const resolveStealthSimulationGate = (input: {
  requested: boolean;
  rails: ReadonlyMap<string, ChainRail>;
  nodeEnv: string | undefined;
}): StealthSimulationGate | undefined => {
  if (!input.requested) return undefined;
  if (input.nodeEnv === "production") return undefined;
  // "every rail is dry-run" is vacuously true of no rails at all. Treat that as
  // a misconfiguration rather than a licence: an empty rail map proves nothing.
  if (input.rails.size === 0) return undefined;
  for (const rail of input.rails.values()) {
    if (rail.settlementMode !== "dry-run") return undefined;
    if (rail.poolMode !== "dry-run") return undefined;
  }
  return { reason: "all-rails-dry-run" };
};

function parseStealthInboxClaimMode(value: string | undefined): StealthInboxClaimMode {
  const mode = value ?? "agent";
  if (mode !== "off" && mode !== "agent" && mode !== "browser") {
    throw new Error("PX402_STEALTH_INBOX_BROWSER_CLAIM must be off, agent, or browser");
  }
  return mode;
}

function parsePoolPayoutFinality(value: string | undefined): "finalized" | "safe" {
  const finality = value ?? "finalized";
  if (finality !== "finalized" && finality !== "safe") {
    throw new Error("PX402_POOL_PAYOUT_FINALITY must be finalized or safe");
  }
  return finality;
}

export function parseDenoms(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PX402_BLIND_VOUCHER_DENOMINATIONS must be a JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PX402_BLIND_VOUCHER_DENOMINATIONS must be a nonempty JSON array");
  }
  const canonical = parsed.map((entry) => {
    if ((typeof entry !== "string" && typeof entry !== "number")
      || (typeof entry === "number" && !Number.isSafeInteger(entry))) {
      throw new Error("Blind voucher denominations must be integer strings or safe integers");
    }
    let amount: bigint;
    try {
      amount = BigInt(entry);
    } catch {
      throw new Error("Blind voucher denomination is not an integer");
    }
    if (amount <= 0n || amount > 10n ** 18n) {
      throw new Error("Blind voucher denomination must be positive and at most 10^18");
    }
    return amount.toString();
  });
  if (new Set(canonical).size !== canonical.length) {
    throw new Error("Blind voucher denominations contain a duplicate canonical value");
  }
  return canonical.sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
}

export function parseSafeMs(
  value: string | undefined,
  fallback: number,
  maximum = 1000 * 60 * 60 * 24 * 365,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)
    || !Number.isFinite(parsed)
    || parsed < 0
    || parsed > maximum) {
    throw new Error(`Blind voucher duration must be a finite integer from 0 through ${maximum}`);
  }
  return parsed;
}
