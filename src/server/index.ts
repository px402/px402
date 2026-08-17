import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import { JsonRpcProvider, Transaction, Wallet } from "ethers";
import { BrowserInboxGateway, STEALTH_INBOX_DEFAULT_NETWORK } from "./agents/BrowserInboxGateway";
import {
  parsePrivateAgentEndpoints,
  PrivateAgentRegistry,
  type PayoutSplitPolicy,
  type TokenTransferVerifier,
} from "./agents/PrivateAgentRegistry";
import {
  createPrivateAgentServer,
  type PrivateLedgerServerDeposit,
} from "./agents/createPrivateAgentServer";
import { BasePaymentVerifier } from "./base/BasePaymentVerifier";
import {
  PrivateBatchCommitter,
  type SettlementBatchCommitter,
} from "./base/PrivateBatchCommitter";
import {
  SolanaBatchCommitter,
  solanaKeypairFromBase58,
} from "./base/SolanaBatchCommitter";
import { SolanaPaymentVerifier } from "./base/SolanaPaymentVerifier";
import { SolanaX402Facilitator } from "./base/SolanaX402Facilitator";
import {
  TransactionCoordinator,
  TransactionOutbox,
  SettlerSendMutex,
} from "./base/TransactionCoordinator";
import { X402Facilitator } from "./base/X402Facilitator";
import { config, resolveStealthSimulationGate } from "./config";
import { createApiServer } from "./http/createHttpServer";
import { EphemeralPaymentJournal } from "./payments/EphemeralPaymentJournal";
import { CohortBook } from "./payments/CohortBook";
import { ConcentrationStateStore } from "./payments/ConcentrationStateStore";
import { PendingPayoutJournal } from "./payments/PendingPayoutJournal";
import { PoolPayoutQueue } from "./payments/PoolPayoutQueue";
import { PrivatePaymentLedger } from "./payments/PrivatePaymentLedger";
import { BlindVoucherMint } from "./payments/BlindVoucherMint";
import { DepositAddressBook } from "./payments/DepositAddressBook";
import { DepositReconciliationQueue } from "./payments/DepositReconciliationQueue";
import { InboundAnnouncementBook } from "./payments/InboundAnnouncementBook";
import { StealthInboxPairingBook } from "./payments/StealthInboxPairingBook";
import { DepositConsolidationService } from "./payments/DepositConsolidationService";
import type { ChainRail } from "./rails/ChainRail";
import { EvmChainRail } from "./rails/EvmChainRail";
import { SolanaChainRail } from "./rails/SolanaChainRail";
import { privateLedgerAssetKey } from "../shared/privateLedger";
import {
  assertDenominationParity,
  DEFAULT_MAX_PAYOUT_LEGS,
  DEFAULT_MAX_PAYOUT_LEGS_SOLANA,
  parsePayoutDenominations,
} from "../shared/denominations";

const dataPath = (...parts: string[]) => resolve(process.cwd(), "data", ...parts);

const paymentVerifier = config.agentRpc.privateLedgerEnabled
  ? new BasePaymentVerifier(config.base.rpcUrl)
  : undefined;
const privateLedgerVerifiers = new Map<string, TokenTransferVerifier>();
if (config.agentRpc.privateLedgerEnabled && paymentVerifier) {
  privateLedgerVerifiers.set("base", paymentVerifier);
  privateLedgerVerifiers.set("robinhood", new BasePaymentVerifier(config.robinhood.rpcUrl));
}
const privateAgentEndpoints = config.agentRpc.enabled
  ? parsePrivateAgentEndpoints(config.agentRpc.endpointsJson)
  : [];
const privatePaymentJournal = config.agentRpc.enabled && config.agentRpc.privateLedgerEnabled
  ? new EphemeralPaymentJournal(config.agentRpc.privateLedgerEphemeralDirectory, {
    requireMemoryBacked: config.agentRpc.privateLedgerRequireMemoryBacked,
  })
  : undefined;
const privatePaymentLedger = config.agentRpc.enabled && config.agentRpc.privateLedgerEnabled
  ? await new PrivatePaymentLedger(
    dataPath("private-payment-ledger.json"),
    config.storage.encryptionKey ?? "",
    {
      journal: privatePaymentJournal!,
      retentionMs: config.agentRpc.privateLedgerRetentionMs,
      baseAssetKey: privateLedgerAssetKey("base", config.base.x402.usdcAddress),
      payoutFinalityVerifier: verifyLegacyPayoutFinality,
    },
  ).load(Object.fromEntries(
    privateAgentEndpoints.map((endpoint) => [endpoint.agentId, endpoint.x402BalanceAtomic ?? "0"]),
  ))
  : undefined;
if (privatePaymentLedger
  && (!config.base.treasury || !config.robinhood.treasury || privateLedgerVerifiers.size !== 2)) {
  throw new Error(
    "Private payment ledger requires Base and Robinhood treasury recipients plus RPC verification",
  );
}
const solanaLedgerTreasury = privatePaymentLedger
  ? config.solana.treasury || (config.solana.x402.settlerSecretKey
    ? solanaKeypairFromBase58(config.solana.x402.settlerSecretKey).publicKey.toBase58()
    : "")
  : "";
if (privatePaymentLedger && solanaLedgerTreasury) {
  privateLedgerVerifiers.set(
    "solana",
    new SolanaPaymentVerifier({ rpcUrl: config.solana.rpcUrl }),
  );
}

const privateLedgerDeposits: Map<string, PrivateLedgerServerDeposit> | undefined =
  privatePaymentLedger
    ? new Map<string, PrivateLedgerServerDeposit>([
      ["base", {
        recipient: config.base.treasury,
        asset: config.base.x402.usdcAddress,
        verifier: privateLedgerVerifiers.get("base")!,
      }],
      ["robinhood", {
        recipient: config.robinhood.treasury,
        asset: config.robinhood.x402.usdgAddress,
        verifier: privateLedgerVerifiers.get("robinhood")!,
      }],
    ])
    : undefined;
if (privateLedgerDeposits && solanaLedgerTreasury) {
  privateLedgerDeposits.set("solana", {
    recipient: solanaLedgerTreasury,
    asset: config.solana.usdcMint,
    verifier: privateLedgerVerifiers.get("solana")!,
  });
}

if (config.agentRpc.blindVouchersEnabled
  && (!privatePaymentLedger
    || !config.agentRpc.blindVoucherMintIdentityKey
    || !config.storage.encryptionKey)) {
  throw new Error(
    "Blind vouchers require the private payment ledger, data encryption key, and mint identity key",
  );
}
const blindVoucherMint = config.agentRpc.blindVouchersEnabled
  && privatePaymentLedger
  && config.agentRpc.blindVoucherMintIdentityKey
  && config.storage.encryptionKey
  ? await new BlindVoucherMint({
    keysetFilePath: dataPath("blind-voucher-keysets.json"),
    nullifierFilePath: dataPath("blind-voucher-nullifiers.json"),
    encryptionKey: config.storage.encryptionKey,
    mintIdentityKey: config.agentRpc.blindVoucherMintIdentityKey,
    denominationsAtomic: config.agentRpc.blindVoucherDenominationsAtomic,
    keysetGraceMs: config.agentRpc.blindVoucherKeysetGraceMs,
    maxOutputsPerRequest: config.agentRpc.blindVoucherMaxOutputsPerRequest,
    maxProofsPerRequest: config.agentRpc.blindVoucherMaxProofsPerRequest,
    assets: [...privateLedgerDeposits!].map(([network, deposit]) =>
      privateLedgerAssetKey(network, deposit.asset)),
  }).load()
  : undefined;

const needsEvmOutbox = config.agentRpc.enabled
  && Boolean(config.base.x402.settlerPrivateKey || config.robinhood.x402.settlerPrivateKey);
const transactionOutbox = needsEvmOutbox
  ? await new TransactionOutbox(
    dataPath("settler-outbox.json"),
    config.storage.encryptionKey ?? "",
  ).load()
  : undefined;
const coordinators = new Map<string, TransactionCoordinator>();

const createCoordinator = (input: {
  network: string;
  rpcUrl: string;
  chainId: number;
  privateKey?: string;
}) => {
  if (!input.privateKey || !transactionOutbox) return undefined;
  const provider = new JsonRpcProvider(input.rpcUrl, input.chainId);
  const wallet = new Wallet(input.privateKey);
  const coordinator = new TransactionCoordinator({
    provider,
    address: wallet.address,
    chainId: input.chainId,
    outbox: transactionOutbox,
    finality: config.agentRpc.poolPayoutFinality,
    confirmationFloorFallback: config.agentRpc.poolPayoutConfirmationFloor,
    bumpAfterMs: config.agentRpc.poolPayoutFeeBumpAfterMs,
    timeoutMs: config.agentRpc.poolPayoutTimeoutMs,
    recoveryBudgetMs: config.agentRpc.poolPayoutRecoveryBudgetMs,
    dispatchGraceMs: config.agentRpc.poolPayoutDispatchGraceMs,
    cancelSign: async (fees) => {
      const signedTx = await wallet.signTransaction({
        type: 2,
        chainId: input.chainId,
        nonce: fees.nonce,
        to: wallet.address,
        value: 0n,
        gasLimit: 21_000n,
        maxFeePerGas: BigInt(fees.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
      });
      const txHash = Transaction.from(signedTx).hash;
      if (!txHash) throw new Error("Cancel transaction has no hash");
      return { signedTx, txHash };
    },
  });
  coordinators.set(input.network, coordinator);
  return coordinator;
};

const baseCoordinator = createCoordinator({
  network: "base",
  rpcUrl: config.base.rpcUrl,
  chainId: config.base.chainId,
  privateKey: config.base.x402.settlerPrivateKey,
});
const robinhoodCoordinator = createCoordinator({
  network: "robinhood",
  rpcUrl: config.robinhood.rpcUrl,
  chainId: config.robinhood.chainId,
  privateKey: config.robinhood.x402.settlerPrivateKey,
});
const solanaSettlerSendMutex = new SettlerSendMutex();

const x402Facilitator = new X402Facilitator({
  rpcUrl: config.base.rpcUrl,
  settlerPrivateKey: config.base.x402.settlerPrivateKey,
  coordinator: baseCoordinator,
  token: {
    kind: "evm",
    network: "base",
    caip2: `eip155:${config.base.chainId}`,
    address: config.base.x402.usdcAddress,
    chainId: config.base.chainId,
    domainName: config.base.x402.usdcDomainName,
    domainVersion: config.base.x402.usdcDomainVersion,
    decimals: 6,
  },
});
const robinhoodFacilitator = new X402Facilitator({
  rpcUrl: config.robinhood.rpcUrl,
  settlerPrivateKey: config.robinhood.x402.settlerPrivateKey,
  coordinator: robinhoodCoordinator,
  token: {
    kind: "evm",
    network: "robinhood",
    caip2: `eip155:${config.robinhood.chainId}`,
    address: config.robinhood.x402.usdgAddress,
    chainId: config.robinhood.chainId,
    domainName: config.robinhood.x402.usdgDomainName,
    domainVersion: config.robinhood.x402.usdgDomainVersion,
    decimals: 6,
  },
});
const solanaFacilitator = new SolanaX402Facilitator({
  rpcUrl: config.solana.rpcUrl,
  historyRpcUrl: config.solana.historyRpcUrl,
  settlerSecretKey: config.solana.x402.settlerSecretKey,
  settlerPubkey: solanaLedgerTreasury || undefined,
  sendCoordinator: solanaSettlerSendMutex,
  token: {
    kind: "solana",
    network: "solana",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    address: config.solana.usdcMint,
    decimals: 6,
  },
});
const x402Rails = new Map<string, ChainRail>([
  ["base", new EvmChainRail({
    facilitator: x402Facilitator,
    coordinator: baseCoordinator,
    treasury: config.base.treasury,
    poolPayoutEnabled: config.agentRpc.poolPayoutEnabled,
  })],
  ["robinhood", new EvmChainRail({
    facilitator: robinhoodFacilitator,
    coordinator: robinhoodCoordinator,
    treasury: config.robinhood.treasury,
    poolPayoutEnabled: config.agentRpc.poolPayoutEnabled,
  })],
  ["solana", new SolanaChainRail({
    facilitator: solanaFacilitator,
    treasury: solanaLedgerTreasury,
    poolPayoutEnabled: config.agentRpc.poolPayoutEnabled,
  })],
]);
const x402Facilitators = new Map<string, X402Facilitator | SolanaX402Facilitator>([
  ["base", x402Facilitator],
  ["robinhood", robinhoodFacilitator],
  ["solana", solanaFacilitator],
]);
const payoutPolicy: PayoutSplitPolicy = {
  enabled: config.agentRpc.payoutDenominationsEnabled,
  policyVersion: config.agentRpc.payoutPolicyVersion,
  maxHoldMsCeiling: config.agentRpc.poolPayoutMaxHoldMs,
  quantizeMode: config.agentRpc.payoutQuantizeMode,
  byNetwork: parsePayoutDenominations(config.agentRpc.payoutDenominationsJson, [
    { network: "base", decimals: 6, maxLegs: DEFAULT_MAX_PAYOUT_LEGS },
    { network: "robinhood", decimals: 6, maxLegs: DEFAULT_MAX_PAYOUT_LEGS },
    { network: "solana", decimals: 6, maxLegs: DEFAULT_MAX_PAYOUT_LEGS_SOLANA },
  ]),
};

// docs/spec-exit-rounds.md §3.4 / §8.1 — both gates are conditional on the cohorts
// flag ON PURPOSE. `payoutPolicy` above is built at unconditional module scope, and
// smokes boot this server with agent RPC disabled; an unconditional throw would
// turn them red with "server exited early".
if (config.agentRpc.poolPayoutCohortsEnabled) {
  if (!config.agentRpc.poolPayoutBatchingEnabled) {
    // `flushGroup(quoteNonce)` sets `onlyGroupRef`, which bypasses BOTH the
    // concentration gate and the scheduler. Cohorts without batching is a privacy
    // flag that silently does nothing — scaffolding theater, which this repo bans.
    throw new Error(
      "PX402_POOL_PAYOUT_COHORTS_ENABLED requires "
      + "PX402_POOL_PAYOUT_BATCHING_ENABLED: the synchronous payout path bypasses "
      + "the scheduler entirely, so cohorts would be advertised while never forming",
    );
  }
  assertDenominationParity({
    byNetwork: payoutPolicy.byNetwork,
    decimalsByNetwork: new Map([["base", 6], ["robinhood", 6], ["solana", 6]]),
  });
  // The ladder check alone misses this. Each rail resolves `onchain` vs `dry-run`
  // independently from its OWN `hasSettlerKey && settler === treasury`, so Base can
  // be broadcasting while Solana is silently dry-run. A cohort spanning that split
  // reports a realized k_eff counting members that were never going to land.
  const poolModes = new Map([...x402Rails].map(([network, rail]) => [network, rail.poolMode]));
  const distinctModes = new Set(poolModes.values());
  if (distinctModes.size > 1) {
    const detail = [...poolModes].map(([network, mode]) => `${network}=${mode}`).join(" ");
    throw new Error(
      `Pool payout mode parity: rails disagree (${detail}). Cohorts require every rail to be `
      + `in the same mode, because a dry-run rail contributes members that never land while `
      + `still counting toward a reported anonymity set. Configure a settler equal to the `
      + `treasury on every rail, or disable PX402_POOL_PAYOUT_COHORTS_ENABLED.`,
    );
  }
}

const depositAddressBookPath = dataPath("private-deposit-addresses.json");
const recoverStealthDeposits = Boolean(
  privatePaymentLedger
  && (config.agentRpc.stealthDepositsEnabled || existsSync(depositAddressBookPath)),
);
const depositAddressBook = recoverStealthDeposits
  ? await new DepositAddressBook(depositAddressBookPath, {
    retentionMs: config.agentRpc.depositRetentionMs,
    encryptionKey: config.storage.encryptionKey ?? "",
  }).load()
  : undefined;
const depositReconciliationQueue = recoverStealthDeposits
  ? await new DepositReconciliationQueue(
    dataPath("private-deposit-reconciliation.json"),
    config.storage.encryptionKey ?? "",
  ).load()
  : undefined;
const depositConsolidationLock = recoverStealthDeposits
  ? await acquireDepositConsolidationLock(dataPath(".deposit-consolidation.lock"))
  : undefined;
const depositConsolidation = privatePaymentLedger
  && depositAddressBook
  && depositReconciliationQueue
  ? new DepositConsolidationService(
    depositAddressBook,
    depositReconciliationQueue,
    x402Rails,
    {
      minAgeMs: config.agentRpc.depositSweepMinAgeMs,
      maxPerRun: config.agentRpc.depositSweepMaxPerRun,
      unpaidGraceMs: config.agentRpc.depositUnpaidGraceMs,
      confirmations: config.agentRpc.depositSweepConfirmations,
      backoffMs: config.agentRpc.depositSweepBackoffMs,
      maxAttempts: config.agentRpc.depositSweepMaxAttempts,
      ledger: privatePaymentLedger,
      creditProofVerified: async (record) => {
        const endpoint = privateAgentEndpoints.find((candidate) =>
          privatePaymentLedger.accountReference(candidate.agentId) === record.accountId);
        if (!endpoint || !record.proofTxHash || record.proofTransferIndex === null) {
          throw new Error("Durable deposit credit replay has no bound ledger account or proof");
        }
        const result = await privatePaymentLedger.creditDeposit({
          agentId: endpoint.agentId,
          amountAtomic: record.expectedAmountAtomic,
          network: record.network,
          assetKey: privateLedgerAssetKey(record.network, record.tokenAddress),
          transactionHash: record.proofTxHash,
          transferIndex: record.proofTransferIndex,
        });
        if (result.duplicate && privatePaymentLedger.depositProofClaim({
          network: record.network,
          transactionHash: record.proofTxHash,
          transferIndex: record.proofTransferIndex,
        }) !== "indexed") {
          throw new Error("Durable deposit replay collided with a legacy proof");
        }
      },
    },
  )
  : undefined;
if (depositConsolidation) {
  await depositConsolidation.reconcileOnStartup();
  const backlog = depositConsolidation.backlog();
  console.log(
    `STEALTH_DEPOSIT_BACKLOG oldestCreditedAgeMs=${backlog.oldestCreditedAgeMs ?? "none"} counts=${JSON.stringify(backlog.counts)}`,
  );
}

// Stays loaded whenever a book already exists, even with the flag off: the
// records are the only copy of announcements that outstanding funds depend on.
const inboundAnnouncementPath = dataPath("private-inbound-announcements.json");
const inboundAnnouncements = privatePaymentLedger
  && (config.agentRpc.stealthInboxEnabled || existsSync(inboundAnnouncementPath))
  ? await new InboundAnnouncementBook(inboundAnnouncementPath, {
    retentionMs: config.agentRpc.stealthInboxRetentionMs,
    dormantMs: config.agentRpc.stealthInboxDormantMs,
    encryptionKey: config.storage.encryptionKey ?? "",
  }).load()
  : undefined;
if (privatePaymentLedger && !inboundAnnouncements) {
  console.warn(
    "STEALTH_INBOX_DISABLED a stealth payout's announcement will not be retained; the payee will not be able to locate or spend it",
  );
}

const pendingPayoutJournal = privatePaymentLedger
  ? new PendingPayoutJournal(
    dataPath("pending-payouts.json"),
    config.storage.encryptionKey ?? "",
  )
  : undefined;
const payoutQueue = privatePaymentLedger && pendingPayoutJournal
  ? new PoolPayoutQueue({
    journal: pendingPayoutJournal,
    ledger: privatePaymentLedger,
    rails: x402Rails,
    flushMs: config.agentRpc.poolPayoutFlushMs,
    maxJitterMs: config.agentRpc.poolPayoutMaxJitterMs,
    maxAttempts: config.agentRpc.poolPayoutMaxAttempts,
    reconcileMs: config.agentRpc.poolPayoutReconcileMs,
    recoveryBudgetMs: config.agentRpc.poolPayoutRecoveryBudgetMs,
    claimTtlMs: config.agentRpc.poolPayoutClaimTtlMs,
    concentrationEnabled: config.agentRpc.poolPayoutConcentrationEnabled,
    kEffTarget: config.agentRpc.poolPayoutKEffTarget,
    kEffAdaptive: config.agentRpc.poolPayoutKEffAdaptive,
    kEffCeiling: config.agentRpc.poolPayoutKEffCeiling,
    kEffAdaptiveWindowMs: config.agentRpc.poolPayoutKEffAdaptiveWindowMs,
    kEffAdaptiveMinSamples: config.agentRpc.poolPayoutKEffAdaptiveMinSamples,
    kEffAdaptiveQuantile: config.agentRpc.poolPayoutKEffAdaptiveQuantile,
    maxHoldMs: config.agentRpc.poolPayoutMaxHoldMs,
    // §6 — the committed-and-revealed jitter schedule runs only when concentration
    // is on. The master secret is resolved from the durable store during recovery
    // and minted there on first use: it used to be `randomBytes(32)` per process,
    // which meant every commitment published before a restart became unrevealable
    // afterwards — an accountability scheme erased by a routine deploy.
    concentrationStore: config.agentRpc.poolPayoutConcentrationEnabled
      ? new ConcentrationStateStore(
        dataPath("pool-payout-concentration.json"),
        config.storage.encryptionKey ?? "",
      )
      : undefined,
    // §5 R9 — durable cohort manifests. Only meaningful when the gate is on, since
    // nothing forms a cohort otherwise.
    cohortBook: config.agentRpc.poolPayoutConcentrationEnabled
      ? new CohortBook(dataPath("pool-payout-cohorts.json"), config.storage.encryptionKey ?? "")
      : undefined,
    scheduleEpochMs: config.agentRpc.poolPayoutScheduleEpochMs,
    kEffPublishEnabled: config.agentRpc.poolPayoutKEffPublishEnabled,
  })
  : undefined;
if (payoutQueue) {
  await payoutQueue.recover();
  payoutQueue.start();
}

const privateBatchCommitters = new Map<string, SettlementBatchCommitter>();
if (privatePaymentLedger
  && config.base.x402.batchCommitmentContract
  && config.base.x402.settlerPrivateKey) {
  privateBatchCommitters.set("base", new PrivateBatchCommitter({
    rpcUrl: config.base.rpcUrl,
    privateKey: config.base.x402.settlerPrivateKey,
    contractAddress: config.base.x402.batchCommitmentContract,
    chainId: config.base.chainId,
    coordinator: baseCoordinator,
    facilitator: x402Facilitator,
  }));
}
if (privatePaymentLedger
  && config.robinhood.x402.batchCommitmentContract
  && config.robinhood.x402.settlerPrivateKey) {
  privateBatchCommitters.set("robinhood", new PrivateBatchCommitter({
    rpcUrl: config.robinhood.rpcUrl,
    privateKey: config.robinhood.x402.settlerPrivateKey,
    contractAddress: config.robinhood.x402.batchCommitmentContract,
    chainId: config.robinhood.chainId,
    coordinator: robinhoodCoordinator,
    facilitator: robinhoodFacilitator,
  }));
}
if (privatePaymentLedger && config.solana.x402.settlerSecretKey) {
  privateBatchCommitters.set("solana", new SolanaBatchCommitter({
    rpcUrl: config.solana.rpcUrl,
    settlerSecretKey: config.solana.x402.settlerSecretKey,
    sendCoordinator: solanaSettlerSendMutex,
  }));
}
const privateBatchCommitter = privateBatchCommitters.get("base");

const privateAgentRegistry = config.agentRpc.enabled
  ? new PrivateAgentRegistry(privateAgentEndpoints, {
    privateLedger: privatePaymentLedger,
    rails: x402Rails,
    payoutQueue,
    poolPayoutBatchingEnabled: config.agentRpc.poolPayoutBatchingEnabled,
    payout: payoutPolicy,
    depositAddressBook,
    reconciliationQueue: depositReconciliationQueue,
    stealthDepositsEnabled: config.agentRpc.stealthDepositsEnabled,
    consolidation: depositConsolidation,
    inboundAnnouncements,
    sweepRelayEnabled: config.agentRpc.stealthSweepRelayEnabled,
    mint: blindVoucherMint,
  })
  : undefined;

// Tier 1 of the stealth demo. An object, never a boolean, and only when every
// rail is dry-run in a non-production process — see resolveStealthSimulationGate.
const stealthSimulationGate = resolveStealthSimulationGate({
  requested: config.agentRpc.stealthInboxSimulationRequested,
  rails: x402Rails,
  nodeEnv: process.env.NODE_ENV,
});
const stealthPairingBook = config.agentRpc.stealthInboxBrowserEnabled
  && privateAgentRegistry
  && privatePaymentLedger
  && inboundAnnouncements
  ? await new StealthInboxPairingBook(dataPath("stealth-inbox-pairings.json"), {
    encryptionKey: config.storage.encryptionKey ?? "",
    ticketTtlMs: config.agentRpc.stealthInboxPairTicketTtlMs,
  }).load()
  : undefined;
const browserInbox = stealthPairingBook
  && privateAgentRegistry
  && privatePaymentLedger
  && inboundAnnouncements
  ? new BrowserInboxGateway({
    registry: privateAgentRegistry,
    ledger: privatePaymentLedger,
    pairings: stealthPairingBook,
    rails: x402Rails,
    rateLimitFilePath: dataPath("stealth-inbox-rate.json"),
    encryptionKey: config.storage.encryptionKey ?? "",
    adminToken: config.admin.token,
    deploymentId: config.deploymentId ?? "",
    ratePerMinute: config.agentRpc.stealthInboxRatePerMinute,
    pageSize: config.agentRpc.stealthInboxPageSize,
    subscriptionTtlMs: config.agentRpc.stealthInboxSubscriptionTtlMs,
    simulationGate: stealthSimulationGate,
    production: process.env.NODE_ENV === "production",
  })
  : undefined;
if (config.agentRpc.stealthInboxBrowserEnabled && !browserInbox) {
  throw new Error(
    "Browser stealth inbox requires the private agent RPC, the private ledger, and the announcement book",
  );
}
// Every durable pairing is re-applied to the endpoints here, before either
// listener binds — the first request after a restart must not race an endpoint
// that has not learned its inbox key yet.
const stealthRestore = await browserInbox?.restore();
console.log(
  `STEALTH_INBOX_BROWSER enabled=${Boolean(browserInbox)} claim=${browserInbox?.claimMode ?? "off"} paired=${stealthRestore?.paired ?? 0} tier=${browserInbox?.simulationTier ?? 0}`,
);
if (browserInbox && stealthSimulationGate) {
  console.warn("STEALTH_DEMO_TIER=1 SETTLEMENT_NOT_EXERCISED");
}
if (stealthRestore && stealthRestore.skipped.length > 0) {
  console.warn(
    `STEALTH_INBOX_PAIRING_ORPHANED count=${stealthRestore.skipped.length} (paired agents with no configured endpoint)`,
  );
}

const server = createApiServer({
  stealthInbox: browserInbox,
  stealthConfig: {
    enabled: Boolean(browserInbox),
    deploymentId: config.deploymentId ?? "",
    claimMode: browserInbox?.claimMode ?? "off",
    // Derived from the RESOLVED gate and the rails, never from the requested
    // env var. Reporting "simulation" while a settler key is loaded is exactly
    // the footgun the gate object exists to prevent, and `onchain` wins over
    // `dry-run` whenever ANY rail can really settle, so the panel never
    // understates what the process is capable of.
    mode: stealthSimulationGate
      ? "simulation"
      : [...x402Rails.values()].some((rail) => rail.settlementMode === "onchain")
        ? "onchain"
        : "dry-run",
    simulation: Boolean(stealthSimulationGate),
    defaultNetwork: STEALTH_INBOX_DEFAULT_NETWORK,
    pageSize: config.agentRpc.stealthInboxPageSize,
  },
  privacy: {
    encryptedStorage: Boolean(config.storage.encryptionKey),
    agentRpcEnabled: config.agentRpc.enabled,
    privateLedgerEnabled: Boolean(privatePaymentLedger),
    aggregateBatchCommitmentsEnabled: Boolean(privateBatchCommitter),
    cryptographicErasureEnabled: Boolean(privatePaymentLedger),
    poolPayoutTransparency: payoutQueue
      ? {
        scheduleCommitment: () => payoutQueue.scheduleCommitment(),
        revealSchedule: (epoch: number) => payoutQueue.revealSchedule(epoch),
        kEffHistogram: () => payoutQueue.kEffHistogram(),
        publicConcentrationStatus: () => payoutQueue.publicConcentrationStatus(),
      }
      : undefined,
  },
});

const privateLedgerSweepTimer = privatePaymentLedger
  ? setInterval(() => {
    void privatePaymentLedger.burnExpired().then((result) => {
      if (result.transfersRemoved > 0) {
        console.log(
          `PRIVATE_LEDGER_ERASURE batches=${result.batchesCompacted} transfers=${result.transfersRemoved} epochs=${result.epochsBurned}`,
        );
      }
    }).catch((error) => {
      console.error(
        "PRIVATE_LEDGER_ERASURE_FAILED",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }, config.agentRpc.privateLedgerSweepMs)
  : undefined;
privateLedgerSweepTimer?.unref();
const blindVoucherRetirementTimer = blindVoucherMint && privatePaymentLedger
  ? setInterval(() => {
    void blindVoucherMint.freezeExpiredKeysets().then(async (frozen) => {
      for (const { asset, keysetId } of frozen) {
        if (privatePaymentLedger.voucherLiability(asset, keysetId) !== "0") {
          await privatePaymentLedger.reclaimRetiredKeyset({
            assetKey: asset,
            keysetId,
          });
        }
        if (privatePaymentLedger.voucherLiability(asset, keysetId) !== "0") {
          throw new Error(`Blind voucher liability remains for frozen keyset ${keysetId}`);
        }
        await blindVoucherMint.eraseKeyset(asset, keysetId);
        await privatePaymentLedger.reclaimRetiredKeyset({
          assetKey: asset,
          keysetId,
        });
      }
    }).catch((error) => {
      console.error(
        "BLIND_VOUCHER_RETIREMENT_FAILED",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }, config.agentRpc.privateLedgerSweepMs)
  : undefined;
blindVoucherRetirementTimer?.unref();
const depositConsolidationTimer = depositConsolidation
  ? setInterval(() => {
    void depositConsolidation.runOnce();
  }, config.agentRpc.depositSweepMs)
  : undefined;
depositConsolidationTimer?.unref();
// `reap` only drops what provably cannot hold value, so this runs whether or
// not the browser surface is enabled — without it the book grows monotonically
// while every write rewrites the whole encrypted file.
const inboundAnnouncementReapTimer = inboundAnnouncements
  ? setInterval(() => {
    void inboundAnnouncements.reap().then((removed) => {
      if (removed > 0) console.log(`STEALTH_INBOX_REAPED records=${removed}`);
    }).catch((error) => {
      console.error(
        "STEALTH_INBOX_REAP_FAILED",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }, config.agentRpc.stealthInboxReapMs)
  : undefined;
inboundAnnouncementReapTimer?.unref();

let privateAgentServer: ReturnType<typeof createPrivateAgentServer> | undefined;
if (privateAgentRegistry) {
  privateAgentServer = createPrivateAgentServer({
    registry: privateAgentRegistry,
    facilitator: x402Facilitator,
    facilitators: x402Facilitators,
    solanaFacilitator,
    ledger: privatePaymentLedger,
    payoutQueue,
    poolPayoutBatchingEnabled: config.agentRpc.poolPayoutBatchingEnabled,
    poolPayoutDenominationsEnabled: config.agentRpc.payoutDenominationsEnabled,
    settlementAdminToken: config.admin.token,
    deposits: privateLedgerDeposits,
    batchCommitters: privateBatchCommitters,
    coordinators,
    mint: blindVoucherMint,
  });
}

// Recovery and queue arming above complete before either listener binds.
server.listen(config.port, config.host, () => {
  console.log(`PX402_STATUS_READY http://${config.host}:${config.port}`);
});
privateAgentServer?.listen(config.agentRpc.port, config.agentRpc.host, () => {
  const poolModes = [...x402Rails.entries()]
    .map(([network, rail]) => `${network} ${rail.poolMode}`)
    .join(", ");
  console.log(
    `PX402_AGENT_RPC_READY http://${config.agentRpc.host}:${config.agentRpc.port} (x402 base ${x402Facilitator.mode}, robinhood ${robinhoodFacilitator.mode}, solana ${solanaFacilitator.mode}; pool-payout ${poolModes}; private-ledger ${privatePaymentLedger ? "enabled" : "disabled"})`,
  );
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (privateLedgerSweepTimer) clearInterval(privateLedgerSweepTimer);
  if (blindVoucherRetirementTimer) clearInterval(blindVoucherRetirementTimer);
  if (depositConsolidationTimer) clearInterval(depositConsolidationTimer);
  if (inboundAnnouncementReapTimer) clearInterval(inboundAnnouncementReapTimer);
  payoutQueue?.stop();
  await depositConsolidation?.waitForIdle();
  await depositAddressBook?.close();
  await depositReconciliationQueue?.close();
  await inboundAnnouncements?.close();
  await browserInbox?.close();
  await stealthPairingBook?.close();
  await releaseDepositConsolidationLock(depositConsolidationLock);
  pendingPayoutJournal?.close();
  for (const coordinator of coordinators.values()) coordinator.close();
  transactionOutbox?.close();
  blindVoucherMint?.close();
  privatePaymentLedger?.close();
  privateAgentServer?.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function verifyLegacyPayoutFinality(input: {
  network: string;
  transactionHash: string;
}): Promise<boolean> {
  if (input.network === "solana") {
    const connection = new Connection(
      config.solana.historyRpcUrl ?? config.solana.rpcUrl,
      "finalized",
    );
    const status = (await connection.getSignatureStatuses(
      [input.transactionHash],
      { searchTransactionHistory: true },
    )).value[0];
    return status?.confirmationStatus === "finalized" && status.err === null;
  }
  const chain = input.network === "robinhood" ? config.robinhood : config.base;
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const receipt = await provider.getTransactionReceipt(input.transactionHash);
  if (!receipt || Number(receipt.status) !== 1) return false;
  const [canonical, finalized] = await Promise.all([
    provider.getBlock(receipt.blockNumber),
    provider.getBlock(config.agentRpc.poolPayoutFinality),
  ]);
  return Boolean(
    canonical?.hash
    && canonical.hash.toLowerCase() === receipt.blockHash.toLowerCase()
    && finalized
    && receipt.blockNumber <= finalized.number,
  );
}

async function acquireDepositConsolidationLock(
  filePath: string,
): Promise<{ handle: FileHandle; filePath: string }> {
  await mkdir(dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(filePath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      await handle.sync();
      return { handle, filePath };
    } catch (error) {
      if (!isFileExists(error)) throw error;
      const existing = await readFile(filePath, "utf8").catch(() => "");
      const pid = Number((JSON.parse(existing || "{}") as { pid?: unknown }).pid);
      // In a container the node process gets the same pid on every start, so
      // a lock naming OUR pid can only be a leftover from a crashed predecessor
      // — treating it as live would wedge the boot forever.
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
        throw new Error(`Deposit consolidator already active with pid ${pid}`);
      }
      await unlink(filePath);
    }
  }
  throw new Error("Unable to acquire deposit consolidation lock");
}

async function releaseDepositConsolidationLock(
  lock: { handle: FileHandle; filePath: string } | undefined,
) {
  if (!lock) return;
  await lock.handle.close();
  await unlink(lock.filePath).catch(() => undefined);
}

// Both helpers run inside `acquireDepositConsolidationLock`, which is invoked
// by a top-level await ABOVE this point in the module — a `const` here would
// still be uninitialized at that moment, so they must be hoisted declarations.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFileExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "EEXIST";
}
