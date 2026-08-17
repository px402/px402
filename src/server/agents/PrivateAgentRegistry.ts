import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "ethers";
import { PublicKey } from "@solana/web3.js";
import type { InventoryItem } from "../../shared/types";
import { createServerId } from "../utils/id";
import { buildPaymentRequirements, resolveX402Network, type X402PaymentPayload, type X402PaymentRequirements, type X402TokenConfig } from "../../shared/x402";
import { deriveStealthAddress, type StealthMetaAddress } from "../../shared/stealth";
import type { SolanaStealthMetaAddress } from "../../shared/stealthSolana";
import { checkSolanaStealthAddress } from "../../shared/stealthSolana";
import { buildSolanaAgentQuote, type SolanaX402PaymentPayload, type SolanaX402PaymentRequirements } from "../../shared/x402Solana";
import { confidentialSlotProvisionIntentMessage } from "../../shared/x402AgentIntent";
import { blindVoucherIssueIntentMessage, poolPayoutClaimIntentMessage, poolPayoutIntentMessage, poolPayoutV2IntentMessage, x402PayIntentMessage, x402QuoteIntentMessage, type X402QuoteScheme } from "../../shared/x402AgentIntent";
import { depositRelayIntentMessage, legacyPrivateLedgerDepositIntentMessage, privateLedgerDepositConfirmMessage, privateLedgerDepositIntentMessage, privateLedgerVoucherIntentMessage, stealthInboxBrowserIntentMessage, stealthInboxIntentMessage, stealthInboxSimulateIntentMessage } from "../../shared/x402AgentIntent";
import { PRIVATE_LEDGER_SCHEME, privateLedgerAssetKey, type PrivateLedgerPaymentAccepted, type PrivateLedgerRequirements, type PrivateLedgerVoucher } from "../../shared/privateLedger";
import {
  meltFingerprint,
  nullifierOf,
  redeemKeyOf,
  sumAtomic,
  verifyDleq,
  type BlindVoucherOutput,
  type ManifestCheckpoint,
  type SignedManifestEntry,
} from "../../shared/blindVoucher";
import type { DenominationConfig } from "../../shared/denominations";
import {
  computeQuoteRequirementsHash,
  validatePlanAgainstPolicy,
  type PayoutGroupPlan,
  type PayoutQuantizeMode,
} from "../../shared/payoutPlan";
import type { X402Facilitator, X402Settlement } from "../base/X402Facilitator";
import type { SolanaX402Facilitator } from "../base/SolanaX402Facilitator";
import type { PrivatePaymentLedger } from "../payments/PrivatePaymentLedger";
import type { DepositAddressBook, DepositAddressRecord } from "../payments/DepositAddressBook";
import type { DepositReconciliationQueue } from "../payments/DepositReconciliationQueue";
import type { DepositConsolidationService } from "../payments/DepositConsolidationService";
import type { InboundAnnouncementBook, InboundAnnouncementConfidentiality, InboundAnnouncementRecord, NewInboundAnnouncement } from "../payments/InboundAnnouncementBook";
import type { StealthSimulationGate } from "../config";
import type {
  BlindVoucherMint,
  MintSignResult,
  PublicKeyset,
} from "../payments/BlindVoucherMint";
import {
  poolPayoutPlanHash,
  type PayoutGroupClaim,
  type PoolPayoutQueue,
  type QueuedGroupReceipt,
} from "../payments/PoolPayoutQueue";
import { isConfidentialProvisioningRail, isConfidentialRail, type ChainRail } from "../rails/ChainRail";
import type { ConfidentialSlotBook, NewConfidentialSlot } from "../payments/ConfidentialSlotBook";
import {
  ConfidentialPaymentError,
  asConfidentialEncryptionPubKey,
  assertSolanaConfidentialRequirements,
  type SolanaConfidentialRequirements,
} from "../../shared/x402SolanaConfidential";
import { EvmChainRail } from "../rails/EvmChainRail";
import { SolanaChainRail } from "../rails/SolanaChainRail";

export interface PrivateAgentEndpoint {
  agentId: string;
  label: string;
  vpnIp: string;
  walletAddress: string;
  // Stable agent identity used for private EIP-191 intent signatures. It is
  // distinct from the public payment wallet and never appears on Base.
  identityAddress?: string;
  sharedSecret: string;
  credits: number;
  // Bootstrap funding for the encrypted private USDC ledger. Production
  // deployments should populate this only after a verified escrow deposit.
  x402BalanceAtomic?: string;
  inventory: InventoryItem[];
  // Address of the browser-held, receive-only stealth inbox key, bound by an
  // admin-ticketed pairing. It authorizes inbox reads and NOTHING else: it is
  // never accepted where identityAddress is required, so it cannot authorize a
  // spend-side intent.
  inboxIdentityAddress?: string;
  // Optional EIP-5564 stealth receiving. stealthMeta is published in quotes;
  // stealthViewingKey lets the server verify a pay-to-stealth without spend
  // authority (viewing keys detect, they cannot spend).
  stealthMeta?: StealthMetaAddress;
  stealthViewingKey?: string;
  // Solana stealth keys are ed25519 and cannot be reused with the EVM rail.
  solanaStealthMeta?: SolanaStealthMetaAddress;
  solanaStealthViewingKey?: string;
}

export interface AgentOfferInput {
  senderAgentId: string;
  receiverAgentId: string;
  itemId: string;
  price: number;
  nonce: string;
  signature: string;
}

export interface AgentAcceptInput {
  receiverAgentId: string;
  offerId: string;
  nonce: string;
  signature: string;
}

interface AgentOffer {
  id: string;
  senderAgentId: string;
  receiverAgentId: string;
  item: InventoryItem;
  price: number;
  nonce: string;
  status: "open" | "settled";
  createdAt: number;
}

export interface AgentReceipt {
  id: string;
  offerId: string;
  senderAgentId: string;
  receiverAgentId: string;
  senderVpnIp: string;
  receiverVpnIp: string;
  item: InventoryItem;
  price: number;
  settledAt: number;
  route: "wireguard-agent-rpc";
}

// An x402 USDC payment between two registered agents, negotiated over the
// private WireGuard channel and settled on Base. Only wallet addresses + value
// touch the chain; agent identities/VPN routing stay off-chain.
export interface X402TradeReceipt {
  id: string;
  kind: "x402";
  payerAgentId: string;
  payeeAgentId: string;
  payerVpnIp: string;
  payeeVpnIp: string;
  asset: string;
  value: string;
  resource: string;
  settlement: X402Settlement;
  settledAt: number;
  route: "wireguard-x402";
  // present when the payee was paid via a one-time EIP-5564 stealth address
  stealthAddress?: string;
  ephemeralPubKey?: string;
}

export interface X402QuoteInput {
  payeeAgentId: string;
  payerAgentId: string;
  amountAtomic: string; // settlement-token atomic units the payee is charging
  resource: string;
  validForSeconds?: number;
  // settlement network for this quote ("base" default, "robinhood", or a
  // CAIP-2 alias). The signed quote intent binds it, so a transport cannot
  // silently move a payee's charge to another chain.
  network?: string;
  intentNonce: string;
  agentSignature: string;
  /**
   * Requests the `confidential` scheme (spec-confidential-x402.md §4).
   *
   * A REQUEST, not a setting: it is honoured only when the rail is confidential-
   * capable, the payee carries a stealth meta-address, and a provisioned slot is
   * available. Anything else is refused with a reason rather than silently
   * downgraded to `exact` — a silent downgrade publishes the amount, which is
   * the one thing this scheme exists to prevent.
   */
  scheme?: X402QuoteScheme;
}

/**
 * One slot the payee has built locally and is asking us to fund. Everything here
 * is a CLAIM: the address is re-derived, the ATA re-derived, and the encryption
 * key compared against what the program stored, before any of it is registered.
 */
export interface ConfidentialSlotClaim {
  stealthAddress: string;
  ephemeralPubKey: string;
  encryptionPubKey: string;
  tokenAccount: string;
}

export interface ConfidentialSlotProvisionInput {
  payeeAgentId: string;
  network: string;
  slots: ConfidentialSlotClaim[];
  /** Payee-signed configure plan; the settler is fee payer and co-signs. */
  transactions: string[];
  intentNonce: string;
  agentSignature: string;
}

export interface ConfidentialSlotProvisionResult {
  status: "provisioned" | "refused";
  registered: number;
  available?: number;
  signatures: string[];
  detail?: string;
  rejected?: string[];
}

/** Bounds the rent we can be asked to fund in one request. */
export const MAX_CONFIDENTIAL_SLOTS_PER_BATCH = 16;

export interface X402PayInput {
  payment: X402PaymentPayload | SolanaX402PaymentPayload;
  // Solana transactions have no EIP-3009 nonce field, so the transport carries
  // the quote nonce beside the payment and binds it in the agent intent.
  requirementsNonce?: string;
  // required when the quote carried a stealthMetaAddress: the payer's ephemeral
  // pubkey ("announcement"), delivered privately so the payee can sweep.
  ephemeralPubKey?: string;
  agentSignature: string;
}

export interface PoolPayoutInput {
  payerAgentId: string;
  payeeAgentId: string;
  quoteNonce: string;
  ephemeralPubKeys?: string[];
  agentSignature: string;
}

export interface PoolPayoutV2Input {
  payerAgentId: string;
  payeeAgentId: string;
  plan: PayoutGroupPlan;
  agentSignature: string;
}

export interface PoolPayoutAck {
  kind: "pool-payout";
  version: 2;
  groupRef: string;
  network: string;
  strategy: "single" | "denominations";
  status: "queued";
  legs: {
    index: number;
    payoutRef: string;
    amountAtomic: string;
    recipient: string;
    ephemeralPubKey?: string;
    state: "planned";
  }[];
  onchainAtomic: string;
  offchainChangeAtomic: "0";
  payerBalanceAtomic: string;
  acceptedAt: number;
}

export interface PayoutSplitPolicy {
  enabled: boolean;
  policyVersion: string;
  byNetwork: ReadonlyMap<string, DenominationConfig>;
  /** Disclosed ceiling for a client-declared release cap (spec-payout-concentration.md §5). */
  maxHoldMsCeiling?: number;
  /**
   * Server-side tileability enforcement (spec-exit-rounds.md §8.1). Omitted ⇒
   * `off`, the historical behavior where an exact leg is always accepted and
   * tileability is therefore courtesy rather than enforcement.
   */
  quantizeMode?: PayoutQuantizeMode;
}

/** Fallback release ceiling when a PayoutSplitPolicy omits one (§5 / config default). */
const DEFAULT_POOL_PAYOUT_MAX_HOLD_MS = 900_000;

export interface PoolPayoutClaimInput {
  payerAgentId: string;
  groupRef: string;
  intentNonce: string;
  agentSignature: string;
}

export interface PoolPayoutReceipt {
  kind: "pool-payout";
  network: string;
  recipient: string;
  stealthAddress?: string;
  ephemeralPubKey?: string;
  mode: "dry-run" | "onchain";
  transactionHash?: string;
  payerBalanceAtomic: string;
  settledAt: number;
}

interface X402Quote {
  requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
  payeeAgentId: string;
  payerAgentId: string;
  expiresAtMs: number;
}

interface PrivateLedgerQuote {
  requirements: PrivateLedgerRequirements;
  expiresAtMs: number;
}

export interface PrivateLedgerDepositIntentInput {
  agentId: string;
  fromAddress: string;
  amountAtomic: string;
  network?: string;
  intentNonce: string;
  agentSignature: string;
}

export interface PrivateLedgerDepositConfirmInput {
  agentId: string;
  depositId: string;
  transactionHash: string;
  network?: string;
  agentSignature: string;
}

interface PrivateLedgerDepositIntent {
  id: string;
  agentId: string;
  fromAddress: string;
  amountAtomic: string;
  network: string;
  expiresAtMs: number;
}

export interface TokenTransferProof {
  transactionHash: string;
  tokenAddress: string;
  fromAddress: string;
  recipient: string;
  amountAtomic: string;
}

export interface TokenTransferVerifier {
  verifyErc20Transfer(input: TokenTransferProof): Promise<TokenTransferVerification>;
}

export interface TokenTransferVerification {
  transactionHash: string;
  amountAtomic: string;
  transferIndex: number;
}

export interface PrivateLedgerDepositConfig {
  recipient: string;
  asset: string;
  verifyTransfer: (input: TokenTransferProof) => Promise<TokenTransferVerification>;
}

export interface BlindVoucherIssueInput {
  payerAgentId: string;
  network?: string;
  keysetId: string;
  outputs: BlindVoucherOutput[];
  totalAtomic: string;
  intentNonce: string;
  agentSignature: string;
  requestRef?: string;
}

export interface BlindVoucherRedeemInput {
  network?: string;
  recipientAgentId: string;
  keysetId: string;
  proofs: { denomAtomic: string; secret: string; C: string }[];
}

export interface PrivateAgentRegistryOptions {
  requireIdentitySignatures?: boolean;
  privateLedger?: PrivatePaymentLedger;
  rails?: ReadonlyMap<string, ChainRail>;
  /**
   * Pre-provisioned confidential receive slots (§5.2-P). Absent ⇒ the
   * `confidential` scheme is refused, never silently downgraded.
   */
  confidentialSlots?: ConfidentialSlotBook;
  payoutQueue?: PoolPayoutQueue;
  poolPayoutBatchingEnabled?: boolean;
  payout?: PayoutSplitPolicy;
  depositAddressBook?: DepositAddressBook;
  reconciliationQueue?: DepositReconciliationQueue;
  stealthDepositsEnabled?: boolean;
  consolidation?: Pick<DepositConsolidationService, "reserveOk">;
  inboundAnnouncements?: InboundAnnouncementBook;
  sweepRelayEnabled?: boolean;
  mint?: BlindVoucherMint;
}

export interface PrivateLedgerDepositRelayInput {
  agentId: string;
  depositId: string;
  network?: string;
  payment: X402PaymentPayload;
  agentSignature: string;
}

/** Read-only browser operations. A spend-side scope deliberately does not exist. */
export type BrowserInboxScope = "stealth-inbox" | "stealth-inbox-pair" | "stealth-inbox-sim";

/**
 * Who is calling a private-agent operation.
 *
 * `wireguard` is the original channel: registered peer IP plus an identity
 * signature, both required. `browser-inbox` has no peer to check, so it is
 * authorized by a signature from the paired inbox key alone — a strictly
 * weaker, receive-only credential that is never accepted where
 * `identityAddress` is.
 */
export type PrivateCallerContext =
  | { channel: "wireguard"; remoteIp: string }
  | { channel: "browser-inbox"; scope: BrowserInboxScope };

/** A bare string is a WireGuard peer IP, so existing callers need no change. */
export type PrivateCaller = string | PrivateCallerContext;

export interface StealthInboxInput {
  agentId: string;
  network?: string;
  intentNonce: string;
  agentSignature: string;
  // Browser channel only. The WireGuard intent has no expiry because a captured
  // signature still needs peer membership to replay; from a browser it would
  // become a permanent inbox-read credential once the nonce map evicts, and a
  // staging signature would replay against production.
  issuedAt?: number;
  expiresAt?: number;
  deploymentId?: string;
  origin?: string;
}

export interface StealthInboxEntry {
  id: string;
  network: string;
  asset: string;
  assetDecimals: number;
  stealthAddress: string;
  ephemeralPubKey: string;
  expectedAmountAtomic: string | null;
  observedAmountAtomic: string | null;
  /** `null` means never checked, which is NOT checked-and-empty. */
  observedAt: number | null;
  status: string;
  claimable: boolean;
  simulated: boolean;
  anomaly: "unexplained-drain" | null;
  createdAt: number;
}

export interface StealthSimulateInboundInput {
  agentId: string;
  network: string;
  amountAtomic: string;
  intentNonce: string;
  agentSignature: string;
  issuedAt: number;
  expiresAt: number;
  deploymentId: string;
  origin: string;
}

export class PrivateAgentRegistry {
  private static readonly NONCE_TTL_MS = 10 * 60 * 1000;
  private static readonly INBOX_BALANCE_REFRESH_LIMIT = 16;
  private static readonly INBOX_BALANCE_REFRESH_FLOOR = 4;
  private static readonly BROWSER_INTENT_MAX_LIFETIME_MS = 5 * 60 * 1000;
  private static readonly BROWSER_INTENT_MAX_SKEW_MS = 5 * 60 * 1000;
  private static readonly SIMULATED_MAX_AMOUNT_ATOMIC = 100_000_000n;
  private readonly endpoints = new Map<string, PrivateAgentEndpoint>();
  private readonly offers = new Map<string, AgentOffer>();
  private readonly x402Quotes = new Map<string, X402Quote>();
  private readonly privateLedgerQuotes = new Map<string, PrivateLedgerQuote>();
  private readonly privateLedgerDeposits = new Map<string, PrivateLedgerDepositIntent>();
  private readonly consumedNonces = new Map<string, number>();
  private readonly requireIdentitySignatures: boolean;
  private readonly privateLedger?: PrivatePaymentLedger;
  private readonly rails?: ReadonlyMap<string, ChainRail>;
  private readonly confidentialSlots?: ConfidentialSlotBook;
  private readonly payoutQueue?: PoolPayoutQueue;
  private readonly poolPayoutBatchingEnabled: boolean;
  private readonly payout: PayoutSplitPolicy;
  private readonly depositAddressBook?: DepositAddressBook;
  private readonly reconciliationQueue?: DepositReconciliationQueue;
  private readonly stealthDepositsEnabled: boolean;
  private readonly consolidation?: Pick<DepositConsolidationService, "reserveOk">;
  private readonly inboundAnnouncements?: InboundAnnouncementBook;
  private readonly sweepRelayEnabled: boolean;
  private readonly inboxListeners = new Set<(agentId: string) => void>();
  readonly mint?: BlindVoucherMint;
  private readonly payoutInflight = new Map<string, Promise<QueuedGroupReceipt | PoolPayoutReceipt | PoolPayoutAck>>();

  constructor(endpoints: PrivateAgentEndpoint[], options: PrivateAgentRegistryOptions = {}) {
    this.requireIdentitySignatures = options.requireIdentitySignatures ?? true;
    this.privateLedger = options.privateLedger;
    this.rails = options.rails;
    this.confidentialSlots = options.confidentialSlots;
    this.payoutQueue = options.payoutQueue;
    this.poolPayoutBatchingEnabled = options.poolPayoutBatchingEnabled ?? false;
    this.payout = options.payout ?? {
      enabled: false,
      policyVersion: "none",
      byNetwork: new Map(),
    };
    this.depositAddressBook = options.depositAddressBook;
    this.reconciliationQueue = options.reconciliationQueue;
    this.stealthDepositsEnabled = options.stealthDepositsEnabled ?? false;
    this.consolidation = options.consolidation;
    this.inboundAnnouncements = options.inboundAnnouncements;
    this.sweepRelayEnabled = options.sweepRelayEnabled ?? false;
    this.mint = options.mint;
    for (const endpoint of endpoints) {
      this.endpoints.set(endpoint.agentId, {
        ...endpoint,
        inventory: endpoint.inventory.map((item) => ({ ...item }))
      });
    }
  }

  static fromJson(json: string | undefined, options: PrivateAgentRegistryOptions = {}) {
    return new PrivateAgentRegistry(parsePrivateAgentEndpoints(json), options);
  }

  redactedEndpoints() {
    return { count: this.endpoints.size, privatePayments: Boolean(this.privateLedger) };
  }

  openOffers() {
    return [...this.offers.values()].filter((offer) => offer.status === "open");
  }

  privateBalance(agentId: string, remoteIp: string, token: X402TokenConfig) {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const endpoint = this.requireEndpoint(agentId);
    this.assertVpnPeer(endpoint, remoteIp);
    return {
      agentId,
      network: token.caip2,
      asset: token.address.toLowerCase(),
      availableAtomic: this.privateLedger.balance(
        agentId,
        privateLedgerAssetKey(token.network, token.address),
      ),
      scheme: PRIVATE_LEDGER_SCHEME
    };
  }

  mintManifest(network: string, token: X402TokenConfig, remoteIp: string): {
    network: string;
    asset: string;
    mintIdentityPubKey: string;
    checkpoint: ManifestCheckpoint;
    manifest: SignedManifestEntry[];
    keysets: PublicKeyset[];
  } {
    if (!this.mint) throw new Error("Blind voucher mint is not configured");
    this.assertVpnMember(remoteIp);
    const asset = privateLedgerAssetKey(token.network, token.address);
    return {
      network: resolveX402Network(network).network,
      asset,
      mintIdentityPubKey: this.mint.mintIdentityPubKey(),
      checkpoint: this.mint.checkpoint(asset),
      manifest: this.mint.publicManifest(asset),
      keysets: this.mint.publicKeysets(asset),
    };
  }

  async issueBlindVouchers(
    input: BlindVoucherIssueInput,
    remoteIp: string,
    token: X402TokenConfig,
    _nowSeconds: number,
  ): Promise<MintSignResult> {
    if (!this.mint || !this.privateLedger) {
      throw new Error("Blind voucher mint is not configured");
    }
    const payer = this.requireEndpoint(input.payerAgentId);
    this.assertVpnPeer(payer, remoteIp);
    const asset = privateLedgerAssetKey(token.network, token.address);
    const active = this.mint.activeKeyset(asset);
    if (!active || input.keysetId !== active.keysetId) {
      throw new Error("Blind voucher issue requires the active keyset");
    }
    if (!Array.isArray(input.outputs) || input.outputs.length === 0) {
      throw new Error("Blind voucher outputs are required");
    }
    const knownDenominations = new Set(
      active.denominations.map((denomination) => denomination.denomAtomic),
    );
    if (input.outputs.some((output) => !knownDenominations.has(output.denomAtomic))) {
      throw new Error("Blind voucher denomination is not in the active keyset");
    }
    if (BigInt(input.totalAtomic) <= 0n
      || sumAtomic(input.outputs.map((output) => output.denomAtomic)) !== input.totalAtomic) {
      throw new Error("Blind voucher output total mismatch");
    }
    const fingerprint = meltFingerprint({
      asset,
      keysetId: input.keysetId,
      outputs: input.outputs,
      totalAtomic: input.totalAtomic,
    });
    this.assertAgentIntent(
      payer,
      input.agentSignature,
      blindVoucherIssueIntentMessage({
        payerAgentId: payer.agentId,
        network: token.network,
        keysetId: input.keysetId,
        outputsFingerprint: fingerprint,
        totalAtomic: input.totalAtomic,
        intentNonce: input.intentNonce,
      }),
    );
    this.consumeNonce("voucher-issue", payer.agentId, input.intentNonce);

    const result = this.mint.sign({
      asset,
      keysetId: input.keysetId,
      outputs: input.outputs,
    });
    if (result.signatures.length !== input.outputs.length
      || result.signatures.some((signature, index) => {
        const output = input.outputs[index];
        const denomination = active.denominations.find(
          (candidate) => candidate.denomAtomic === output.denomAtomic,
        );
        return signature.denomAtomic !== output.denomAtomic
          || !denomination
          || !verifyDleq({
            B_: output.B_,
            C_: signature.C_,
            K: denomination.K,
            dleq: signature.dleq,
          });
      })) {
      throw new Error("Blind voucher mint DLEQ self-verification failed");
    }

    await this.privateLedger.meltToVouchers({
      agentId: payer.agentId,
      amountAtomic: input.totalAtomic,
      assetKey: asset,
      keysetId: input.keysetId,
      meltKey: fingerprint,
    });
    return result;
  }

  async redeemBlindVouchers(
    input: BlindVoucherRedeemInput,
    remoteIp: string,
    token: X402TokenConfig,
    _nowSeconds: number,
  ): Promise<{ status: "redeemed"; valueAtomic: string }> {
    if (!this.mint || !this.privateLedger) {
      throw new Error("Blind voucher mint is not configured");
    }
    this.assertVpnMember(remoteIp);
    const recipient = this.requireEndpoint(input.recipientAgentId);
    if (!Array.isArray(input.proofs) || input.proofs.length === 0) {
      throw new Error("Blind voucher proofs are required");
    }
    const asset = privateLedgerAssetKey(token.network, token.address);
    const redeemKey = redeemKeyOf({
      asset,
      recipientAgentId: recipient.agentId,
      keysetId: input.keysetId,
      proofs: input.proofs.map((proof) => ({
        denomAtomic: proof.denomAtomic,
        nullifier: nullifierOf(proof.secret),
      })),
    });
    const { valueAtomic } = await this.mint.verifyAndReserveNullifiers({
      asset,
      keysetId: input.keysetId,
      redeemKey,
      proofs: input.proofs,
    });
    await this.privateLedger.redeemToAccount({
      recipientAgentId: recipient.agentId,
      amountAtomic: valueAtomic,
      assetKey: asset,
      keysetId: input.keysetId,
      redeemKey,
    });
    return { status: "redeemed", valueAtomic };
  }

  enqueuePoolPayout(
    input: PoolPayoutInput | PoolPayoutV2Input,
    remoteIp: string,
    nowSeconds: number
  ): Promise<QueuedGroupReceipt | PoolPayoutReceipt | PoolPayoutAck> {
    const groupRef = "plan" in input ? input.plan.groupRef : input.quoteNonce;
    const existing = this.payoutInflight.get(groupRef);
    if (existing) return existing;
    const operation = this.enqueuePoolPayoutUnlocked(input, remoteIp, nowSeconds);
    this.payoutInflight.set(groupRef, operation);
    void operation.catch(() => {
      if (this.payoutInflight.get(groupRef) === operation) {
        this.payoutInflight.delete(groupRef);
      }
    });
    return operation;
  }

  private async enqueuePoolPayoutUnlocked(
    input: PoolPayoutInput | PoolPayoutV2Input,
    remoteIp: string,
    nowSeconds: number,
  ): Promise<QueuedGroupReceipt | PoolPayoutReceipt | PoolPayoutAck> {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    if (!this.payoutQueue) throw new Error("Pool payout queue is not configured");
    if ("plan" in input) {
      return this.enqueuePoolPayoutV2Unlocked(input, remoteIp, nowSeconds);
    }
    this.evictExpiredQuotes(nowSeconds);
    const quote = this.x402Quotes.get(input.quoteNonce);
    if (!quote) throw new Error("No outstanding x402 quote for this payment nonce");
    assertPoolPayoutQuoteScheme(quote.requirements);
    if (quote.payerAgentId !== input.payerAgentId || quote.payeeAgentId !== input.payeeAgentId) {
      throw new Error("Pool payout agents do not match issued quote");
    }

    const payer = this.requireEndpoint(quote.payerAgentId);
    const payee = this.requireEndpoint(quote.payeeAgentId);
    this.assertVpnPeer(payer, remoteIp);
    const rail = this.resolveRail(quote.requirements.network);
    if (!rail) throw new Error(`x402 rail not configured for network ${quote.requirements.network}`);
    this.assertAgentIntent(payer, input.agentSignature, poolPayoutIntentMessage({
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      quoteNonce: input.quoteNonce,
      ephemeralPubKeys: input.ephemeralPubKeys ?? [],
      network: rail.network
    }));
    const ephemeralPubKey = input.ephemeralPubKeys?.[0];
    const resolved = rail.resolveRecipient({
      requirements: quote.requirements,
      payee,
      ephemeralPubKey
    });
    const asset = rail.network === "solana"
      ? rail.tokenConfig.address
      : rail.tokenConfig.address.toLowerCase();
    const leg = {
      index: 0,
      payoutRef: input.quoteNonce,
      recipient: resolved.recipient,
      amountAtomic: quote.requirements.maxAmountRequired,
      ephemeralPubKey: resolved.stealth?.ephemeralPubKey,
      denominationAtomic: null,
    };
    const planHash = poolPayoutPlanHash({
      groupRef: input.quoteNonce,
      network: rail.network,
      asset,
      legs: [leg],
    });
    const payoutAssetKey = privateLedgerAssetKey(rail.network, rail.tokenConfig.address);
    if (this.consolidation && !(await this.consolidation.reserveOk(payoutAssetKey))) {
      throw new Error(`Private ledger payout reserve mismatch for asset ${payoutAssetKey}`);
    }
    // On the synchronous (batching-off) path there is NO claim mechanism: once
    // the quote and debit are consumed, a quarantine delay has no honest
    // completion channel — the old behavior reported "failed" for a payout that
    // would still settle later, the exact inducement for the payer to open a
    // second quote and pay twice. So refuse BEFORE consuming anything: nothing
    // is debited, no announcement is indexed, and the quote remains outstanding
    // for a retry after the quarantine resolves. The batching path accepts as
    // normal — its claim reports `queued` honestly for the same situation.
    if (!this.poolPayoutBatchingEnabled && rail.settlerQuarantined?.()) {
      throw new Error(
        `Pool payout settler for ${rail.network} is quarantined pending operator review;`
        + " nothing was debited and the quote remains outstanding — retry after it"
        + " resolves, or enable pool payout batching.",
      );
    }
    await this.indexInboundAnnouncements({
      payeeAgentId: payee.agentId,
      network: rail.network,
      caip2: rail.tokenConfig.caip2,
      tokenAddress: asset,
      source: "pool-payout",
      legs: [{
        sourceRef: leg.payoutRef,
        stealthAddress: leg.recipient,
        ephemeralPubKey: leg.ephemeralPubKey,
        amountAtomic: leg.amountAtomic,
      }],
    });
    const reservation = await this.privateLedger.payout({
      agentId: payer.agentId,
      amountAtomic: quote.requirements.maxAmountRequired,
      assetKey: payoutAssetKey,
      network: rail.network,
      payoutRef: input.quoteNonce,
      planHash,
    });

    let queued: QueuedGroupReceipt;
    try {
      queued = await this.payoutQueue.enqueueGroup({
        groupRef: input.quoteNonce,
        ownerTag: this.privateLedger.accountReference(payer.agentId),
        network: rail.network,
        asset,
        strategy: "single",
        planHash,
        payerBalanceAtomic: reservation.balanceAtomic,
        legs: [leg],
        offchainChange: null,
      });
    } catch (error) {
      if (!reservation.duplicate) await this.privateLedger.reversePayout(input.quoteNonce);
      throw error;
    }
    this.x402Quotes.delete(input.quoteNonce);
    if (this.poolPayoutBatchingEnabled) return queued;

    await this.payoutQueue.flushGroup(input.quoteNonce);
    const claim = await this.payoutQueue.claim(input.quoteNonce);
    const claimedLeg = claim.legs[0];
    if (!claimedLeg || claimedLeg.state !== "settled") {
      if (claimedLeg?.state === "uncertain") {
        throw new Error("Pool payout outcome is uncertain; reserved debit is held");
      }
      // Mined and canonical, finality outstanding. Reporting this as "failed" would
      // tell the payer the money did not move when it demonstrably did — the worst
      // available answer, and worse than the `uncertain` case above, which at least
      // does not assert an outcome. This path is synchronous by construction, so on
      // any chain whose finality exceeds the confirm budget (Base ~20 min, Robinhood
      // ~18 min) it CANNOT honestly return `settled`: enable
      // PX402_POOL_PAYOUT_BATCHING_ENABLED, whose claim token is designed for
      // exactly this wait. The reconcile pass settles the leg either way.
      if (claimedLeg?.chainStatus === "included") {
        throw new Error(
          `Pool payout is included but not yet final on ${rail.network}`
          + `${claimedLeg.transactionHash ? ` (tx ${claimedLeg.transactionHash})` : ""};`
          + " the debit is held and the reconcile pass will settle it."
          + " Enable pool payout batching to receive this outcome as a claim instead.",
        );
      }
      // A DELAYED leg, not a failed one: §2.5 returns a leg to `queued` on a
      // quarantine (or a transient error below maxAttempts) and the queue keeps
      // retrying it. Reporting "failed" here asserted an outcome that was false —
      // the reserved debit was live and WOULD settle later, so a payer who
      // believed the failure and re-quoted paid twice. "failed" is reserved for
      // the terminal state below, which is the only one that also reverses the
      // debit.
      if (claimedLeg && (claimedLeg.state === "queued" || claimedLeg.state === "broadcasting")) {
        throw new Error(
          `Pool payout is delayed on ${rail.network}; the reserved debit is held and the`
          + " queue will keep retrying until it settles. This is not a failure — do not"
          + " open a second quote for the same payment. Enable pool payout batching to"
          + " receive this outcome as a claim instead.",
        );
      }
      throw new Error(`Pool payout failed for network ${rail.network}`);
    }
    return {
      kind: "pool-payout",
      network: rail.network,
      recipient: resolved.recipient,
      stealthAddress: resolved.stealth?.stealthAddress,
      ephemeralPubKey: resolved.stealth?.ephemeralPubKey,
      mode: claimedLeg.mode ?? "dry-run",
      transactionHash: claimedLeg.transactionHash,
      payerBalanceAtomic: reservation.balanceAtomic,
      settledAt: claimedLeg.terminalAt ?? Date.now()
    };
  }

  private async enqueuePoolPayoutV2Unlocked(
    input: PoolPayoutV2Input,
    remoteIp: string,
    nowSeconds: number,
  ): Promise<PoolPayoutAck> {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    if (!this.payoutQueue) throw new Error("Pool payout queue is not configured");
    if (!this.payout.enabled) throw new Error("Payout denominations are not enabled");
    this.evictExpiredQuotes(nowSeconds);
    const quote = this.x402Quotes.get(input.plan.groupRef);
    if (!quote) throw new Error("No outstanding x402 quote for this payout group");
    assertPoolPayoutQuoteScheme(quote.requirements);
    if (quote.payerAgentId !== input.payerAgentId || quote.payeeAgentId !== input.payeeAgentId) {
      throw new Error("Pool payout agents do not match issued quote");
    }

    const payer = this.requireEndpoint(quote.payerAgentId);
    const payee = this.requireEndpoint(quote.payeeAgentId);
    this.assertVpnPeer(payer, remoteIp);
    const rail = this.resolveRail(quote.requirements.network);
    if (!rail) throw new Error(`x402 rail not configured for network ${quote.requirements.network}`);
    if (input.plan.network !== rail.network) throw new Error("Payout plan network mismatch");
    if (input.plan.groupRef !== quote.requirements.nonce) throw new Error("Payout plan group does not match quote nonce");

    const policy = this.payout.byNetwork.get(rail.network);
    const advertisement = quote.requirements.payoutPolicy;
    if (!policy || !advertisement) throw new Error("Issued quote has no payout denomination policy");
    const maxHoldMsCeiling = this.payout.maxHoldMsCeiling ?? DEFAULT_POOL_PAYOUT_MAX_HOLD_MS;
    if (advertisement.policyVersion !== this.payout.policyVersion
      || advertisement.maxLegs !== policy.maxLegs
      // §5 — the ceiling the client validated its cap against must still be the
      // configured one, so an operator cannot widen it between quote and pay.
      || (advertisement.maxHoldMsCeiling ?? DEFAULT_POOL_PAYOUT_MAX_HOLD_MS) !== maxHoldMsCeiling
      || advertisement.denominationsAtomic.length !== policy.denominationsAtomic.length
      || advertisement.denominationsAtomic.some(
        (value, index) => value !== policy.denominationsAtomic[index]?.toString(),
      )) {
      throw new Error("Issued payout policy no longer matches the configured policy");
    }

    this.assertAgentIntent(payer, input.agentSignature, poolPayoutV2IntentMessage({
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      groupRef: input.plan.groupRef,
      network: input.plan.network,
      asset: input.plan.asset,
      strategy: input.plan.strategy,
      policyVersion: input.plan.policyVersion,
      quoteRequirementsHash: input.plan.quoteRequirementsHash,
      totalAtomic: input.plan.totalAtomic,
      onchainAtomic: input.plan.onchainAtomic,
      offchainChangeAtomic: input.plan.offchainChangeAtomic,
      planHash: input.plan.planHash,
      legs: input.plan.legs.map((leg) => ({
        index: leg.index,
        amountAtomic: leg.amountAtomic,
        ephemeralPubKey: leg.ephemeralPubKey,
      })),
    }), true);

    const resolvedRecipients = new Map<string, string>();
    validatePlanAgainstPolicy({
      plan: input.plan,
      policy,
      policyVersion: this.payout.policyVersion,
      asset: rail.tokenConfig.address,
      totalAtomic: quote.requirements.maxAmountRequired,
      quoteRequirementsHash: computeQuoteRequirementsHash(quote.requirements),
      maxHoldMsCeiling,
      quantizeMode: this.payout.quantizeMode,
      resolveRecipient: (ephemeralPubKey) => {
        const resolved = rail.resolveRecipient({
          requirements: quote.requirements,
          payee,
          ephemeralPubKey,
        }).recipient;
        resolvedRecipients.set(ephemeralPubKey, resolved);
        return resolved;
      },
    });

    const payoutAssetKey = privateLedgerAssetKey(rail.network, rail.tokenConfig.address);
    const balanceBefore = BigInt(this.privateLedger.balance(payer.agentId, payoutAssetKey));
    const total = BigInt(quote.requirements.maxAmountRequired);
    if (balanceBefore < total) throw new Error("Insufficient private ledger balance for payout");
    if (this.consolidation && !(await this.consolidation.reserveOk(payoutAssetKey))) {
      throw new Error(`Private ledger payout reserve mismatch for asset ${payoutAssetKey}`);
    }

    const queueAsset = rail.network === "solana"
      ? rail.tokenConfig.address
      : rail.tokenConfig.address.toLowerCase();
    const legs = input.plan.legs.map((leg) => ({
      index: leg.index,
      payoutRef: leg.payoutRef,
      recipient: resolvedRecipients.get(leg.ephemeralPubKey ?? "") ?? leg.recipient,
      amountAtomic: leg.amountAtomic,
      ephemeralPubKey: leg.ephemeralPubKey,
      denominationAtomic: leg.denominationAtomic,
    }));
    await this.indexInboundAnnouncements({
      payeeAgentId: payee.agentId,
      network: rail.network,
      caip2: rail.tokenConfig.caip2,
      tokenAddress: queueAsset,
      source: "pool-payout",
      legs: legs.map((leg) => ({
        sourceRef: leg.payoutRef,
        stealthAddress: leg.recipient,
        ephemeralPubKey: leg.ephemeralPubKey,
        amountAtomic: leg.amountAtomic,
      })),
    });

    const newlyReserved: string[] = [];
    let payerBalanceAtomic = (balanceBefore - total).toString();
    try {
      for (const leg of legs) {
        const reservation = await this.privateLedger.payout({
          agentId: payer.agentId,
          amountAtomic: leg.amountAtomic,
          assetKey: payoutAssetKey,
          network: rail.network,
          payoutRef: leg.payoutRef,
          planHash: input.plan.planHash,
        });
        payerBalanceAtomic = reservation.balanceAtomic;
        if (!reservation.duplicate) newlyReserved.push(leg.payoutRef);
      }
      await this.payoutQueue.enqueueGroup({
        groupRef: input.plan.groupRef,
        ownerTag: this.privateLedger.accountReference(payer.agentId),
        network: rail.network,
        asset: queueAsset,
        strategy: input.plan.strategy,
        planHash: input.plan.planHash,
        payerBalanceAtomic,
        legs,
        offchainChange: null,
        // Additive: forward the signed cap only when the client declared one, so a
        // capless payout enqueues with its exact prior shape.
        ...(input.plan.maxHoldMs !== undefined ? { maxHoldMs: input.plan.maxHoldMs } : {}),
      });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const payoutRef of newlyReserved.reverse()) {
        try {
          await this.privateLedger.reversePayout(payoutRef);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Pool payout enqueue failed and one or more reserved legs could not be reversed",
        );
      }
      throw error;
    }

    this.x402Quotes.delete(input.plan.groupRef);
    return {
      kind: "pool-payout",
      version: 2,
      groupRef: input.plan.groupRef,
      network: rail.network,
      strategy: input.plan.strategy,
      status: "queued",
      legs: legs.map((leg) => ({
        index: leg.index,
        payoutRef: leg.payoutRef,
        amountAtomic: leg.amountAtomic,
        recipient: leg.recipient,
        ephemeralPubKey: leg.ephemeralPubKey,
        state: "planned",
      })),
      onchainAtomic: input.plan.onchainAtomic,
      offchainChangeAtomic: "0",
      payerBalanceAtomic,
      acceptedAt: Date.now(),
    };
  }

  async claimPoolPayout(
    input: PoolPayoutClaimInput,
    remoteIp: string,
  ): Promise<PayoutGroupClaim> {
    if (!this.privateLedger || !this.payoutQueue) {
      throw new Error("Pool payout queue is not configured");
    }
    const payer = this.requireEndpoint(input.payerAgentId);
    this.assertVpnPeer(payer, remoteIp);
    this.assertAgentIntent(payer, input.agentSignature, poolPayoutClaimIntentMessage(input));
    const ownerTag = this.privateLedger.accountReference(payer.agentId);
    if (this.payoutQueue.ownerTag(input.groupRef) !== ownerTag) {
      throw new Error("Pool payout claim owner mismatch");
    }
    this.consumeNonce("pool-claim", payer.agentId, input.intentNonce);
    return this.payoutQueue.claim(input.groupRef);
  }

  /**
   * Persist the payee's announcements BEFORE their legs can be broadcast.
   *
   * A stealth one-time key is `kSpend + H(kView * R)`. Without `R` the payee
   * cannot derive it or even locate the address, and the payout ACK carrying
   * `R` goes to the PAYER — so a crash between broadcast and index-write
   * strands the funds permanently. The book fsyncs before returning.
   *
   * Fails safe in one direction only: an indexed announcement whose payout is
   * later rolled back is an empty record that goes dormant and reaps.
   */
  private async indexInboundAnnouncements(input: {
    payeeAgentId: string;
    network: string;
    caip2: string;
    tokenAddress: string;
    source: "pool-payout" | "x402-direct";
    /**
     * B3. Defaults to `"plain"` because every caller but the confidential rail
     * pays in plaintext, and a plaintext output's zero balance really does mean
     * empty.
     *
     * A confidential output's plaintext balance is zero BY CONSTRUCTION, so the
     * book would read it as "provably drained", mark it dormant, and reap the
     * only copy of `R` — leaving funds nobody, including us, can locate. The
     * discriminator has existed since `dd4fb8e`; this is the call site that
     * finally sets it.
     */
    confidentiality?: InboundAnnouncementConfidentiality;
    legs: {
      sourceRef: string;
      stealthAddress: string;
      ephemeralPubKey?: string;
      amountAtomic?: string | null;
    }[];
  }): Promise<void> {
    if (!this.inboundAnnouncements || !this.privateLedger) return;
    const accountId = this.privateLedger.accountReference(input.payeeAgentId);
    const entries: NewInboundAnnouncement[] = [];
    for (const leg of input.legs) {
      if (!leg.ephemeralPubKey) continue; // non-stealth leg: nothing to recover
      entries.push({
        accountId,
        network: input.network,
        caip2: input.caip2,
        tokenAddress: input.tokenAddress,
        stealthAddress: leg.stealthAddress,
        ephemeralPubKey: leg.ephemeralPubKey,
        // A confidential leg carries no knowable amount. `null` is the honest
        // value; a number here would be a claim the chain cannot support.
        expectedAmountAtomic: input.confidentiality === "confidential"
          ? null
          : leg.amountAtomic ?? null,
        source: input.source,
        sourceRef: leg.sourceRef,
        confidentiality: input.confidentiality ?? "plain",
      });
    }
    if (entries.length === 0) return;
    await this.inboundAnnouncements.addMany(entries);
    this.notifyInboxChanged(input.payeeAgentId);
  }

  /**
   * Subscribe to "this agent's inbox changed". Drives the WebSocket push.
   *
   * Edge-triggered on a SEMANTIC change only — a re-read that observes the same
   * balances fires nothing. That is load-bearing: a listener that re-reads the
   * inbox on every notification would otherwise refresh, observe, notify, and
   * re-read forever.
   */
  onInboxChanged(listener: (agentId: string) => void): void {
    this.inboxListeners.add(listener);
  }

  private notifyInboxChanged(agentId: string) {
    for (const listener of this.inboxListeners) {
      try {
        listener(agentId);
      } catch (error) {
        // A failing push transport must never break the payment path that
        // wrote the announcement.
        console.warn(`STEALTH_INBOX_LISTENER_FAILED ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Payee-facing list of stealth outputs owed to them, with the announcement
   * each one needs to be spendable.
   *
   * Over WireGuard this requires BOTH the registered peer and an identity
   * signature — peer IP alone is not authorization to enumerate an agent's
   * inbound payments. From a browser there is no peer, so the paired
   * receive-only inbox key carries the whole authorization and the intent must
   * additionally be time-, deployment-, and origin-bound.
   */
  async stealthInbox(input: StealthInboxInput, caller: PrivateCaller): Promise<{
    agentId: string;
    entries: StealthInboxEntry[];
    totalObservedAtomic: string;
  }> {
    if (!this.inboundAnnouncements) throw new Error("Stealth inbox is not configured");
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const endpoint = this.requireEndpoint(input.agentId);
    const context = normalizePrivateCaller(caller);
    const message = context.channel === "wireguard"
      ? stealthInboxIntentMessage({
        agentId: input.agentId,
        network: input.network ?? "",
        intentNonce: input.intentNonce,
      })
      : stealthInboxBrowserIntentMessage({
        agentId: input.agentId,
        network: input.network ?? "",
        intentNonce: input.intentNonce,
        ...this.assertBrowserIntentWindow(input),
      });
    this.assertCaller(endpoint, context, "stealth-inbox", input.agentSignature, message);
    this.consumeNonce(
      context.channel === "wireguard" ? "stealth-inbox" : "stealth-inbox-browser",
      endpoint.agentId,
      input.intentNonce,
    );

    const network = input.network ? resolveX402Network(input.network).network : undefined;
    const accountId = this.privateLedger.accountReference(endpoint.agentId);

    // Bounded, rotating, jittered refresh. One request must never fan out to
    // unbounded RPC; `refreshable` orders by observation age so the oldest
    // records are eventually re-checked instead of the newest forever; and the
    // per-call budget is randomized because the RPC provider sees these
    // unrelated one-time addresses queried together and a constant burst size
    // is a clean clustering signal.
    let changed = false;
    for (const record of shuffled(this.inboundAnnouncements.refreshable(accountId, network, this.refreshBudget()))) {
      const rail = this.resolveRail(record.network);
      if (!rail) continue;
      try {
        const observed = await rail.observedBalanceAtomic({ stealthAddress: record.stealthAddress });
        const updated = await this.inboundAnnouncements.observe(record.id, observed);
        if (updated.observedAmountAtomic !== record.observedAmountAtomic
          || updated.status !== record.status
          || updated.anomaly !== record.anomaly) {
          changed = true;
        }
      } catch (error) {
        // A dead RPC must not hide the announcement — the record is still
        // returned with its last known observation. The record id is omitted:
        // one warn line per record per read is a per-record activity trace.
        console.warn(`STEALTH_INBOX_REFRESH_FAILED network=${record.network} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (changed) this.notifyInboxChanged(endpoint.agentId);

    // Deliberately the same builder the push path uses. A second mapper here
    // would let the pushed view drift from the authorized one — a different
    // `claimable`, a missed `anomaly` — and the user would see one thing in the
    // panel and another after a refresh, which is worse than an error.
    return this.stealthInboxSnapshot(endpoint.agentId, input.network);
  }

  /**
   * The inbox as the book currently holds it: no signature, no nonce, no RPC.
   *
   * For pushing to an ALREADY-AUTHORIZED subscription. `stealthInbox` cannot
   * serve that path — it demands a fresh signature and burns a one-shot nonce,
   * and a server-side `onInboxChanged` has neither. The signature was verified
   * once at subscribe time and the subscription TTL bounds it from there
   * (SI-15). **This is not an authorization check and must never be reachable
   * from a route**; the caller is responsible for having established the
   * subscription.
   *
   * The missing RPC refresh is a privacy gain, not a shortcut: each refresh
   * fires up to N `balanceOf` calls for unrelated one-time addresses from one
   * IP in one burst — a clean clustering signal to the RPC provider, and
   * precisely what EIP-5564 exists to prevent (§13.3). Refreshing per push
   * event would turn a rare event into a continuous beacon. Refresh stays on
   * the authorized read and the rotating background window.
   */
  stealthInboxSnapshot(agentId: string, network?: string): {
    agentId: string;
    entries: StealthInboxEntry[];
    totalObservedAtomic: string;
  } {
    if (!this.inboundAnnouncements) throw new Error("Stealth inbox is not configured");
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const endpoint = this.requireEndpoint(agentId);
    const resolved = network ? resolveX402Network(network).network : undefined;
    const accountId = this.privateLedger.accountReference(endpoint.agentId);
    let totalObserved = 0n;
    const entries = this.inboundAnnouncements.forAccount(accountId, resolved).map((record) => {
      if (record.observedAmountAtomic) totalObserved += BigInt(record.observedAmountAtomic);
      return this.toInboxEntry(record);
    });
    return { agentId: endpoint.agentId, entries, totalObservedAtomic: totalObserved.toString() };
  }

  /**
   * Write a stealth announcement nobody paid for, for the Tier 1 UI demo.
   *
   * The address is derived with the REAL EIP-5564 derivation against the
   * endpoint's configured meta-address, so the row a user sees is one their own
   * keys would control. `gate` is the object from `resolveStealthSimulationGate`
   * rather than a boolean, so a stray `true` from a config typo cannot satisfy
   * it; it is only produced when every rail is dry-run, i.e. when no key in the
   * process can move value anywhere.
   */
  async simulateInboundAnnouncement(
    input: StealthSimulateInboundInput,
    caller: PrivateCaller,
    gate: StealthSimulationGate,
  ): Promise<StealthInboxEntry> {
    if (!gate || gate.reason !== "all-rails-dry-run") {
      throw new Error("Stealth inbox simulation is not available");
    }
    if (!this.inboundAnnouncements) throw new Error("Stealth inbox is not configured");
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const endpoint = this.requireEndpoint(input.agentId);
    if (!endpoint.stealthMeta) {
      // An honestly empty panel beats a fabricated row: with no meta-address
      // there is no address this agent could ever have been paid at.
      throw new Error(`Stealth receiving is not configured for ${endpoint.agentId}`);
    }
    const token = resolveX402Network(input.network);
    const amount = BigInt(input.amountAtomic);
    if (amount <= 0n) throw new Error("Simulated inbound amount must be positive");
    if (amount > PrivateAgentRegistry.SIMULATED_MAX_AMOUNT_ATOMIC) {
      throw new Error("Simulated inbound amount exceeds the simulation cap");
    }
    // Signed over the caller's own field values, not the resolved ones: any
    // normalization here would change the bytes and reject a valid signature.
    this.assertCaller(endpoint, caller, "stealth-inbox-sim", input.agentSignature,
      stealthInboxSimulateIntentMessage({
        agentId: input.agentId,
        network: input.network,
        amountAtomic: input.amountAtomic,
        intentNonce: input.intentNonce,
        ...this.assertBrowserIntentWindow(input),
      }));
    this.consumeNonce("stealth-inbox-sim", endpoint.agentId, input.intentNonce);

    const derived = deriveStealthAddress(endpoint.stealthMeta);
    const [record] = await this.inboundAnnouncements.addMany([{
      accountId: this.privateLedger.accountReference(endpoint.agentId),
      network: token.network,
      caip2: token.caip2,
      tokenAddress: token.address.toLowerCase(),
      stealthAddress: derived.stealthAddress,
      ephemeralPubKey: derived.ephemeralPubKey,
      expectedAmountAtomic: amount.toString(),
      source: "simulated",
      sourceRef: `sim-${randomBytes(12).toString("hex")}`,
    }]);
    const observed = await this.inboundAnnouncements.observe(record.id, amount);
    this.notifyInboxChanged(endpoint.agentId);
    return this.toInboxEntry(observed);
  }

  /**
   * Bind the browser's receive-only inbox key, and at 4b the meta-address
   * payments will be sent to.
   *
   * Deliberately exhaustive and deliberately narrow. It must never be able to
   * rebind `identityAddress` (which authorizes every spend-side intent),
   * `walletAddress`, `vpnIp`, `sharedSecret`, `credits`, `x402BalanceAtomic`,
   * or `inventory` — an admin-ticketed browser pairing is not an identity
   * rotation.
   */
  applyStealthInboxPairing(agentId: string, patch: {
    inboxIdentityAddress?: string;
    stealthMeta?: StealthMetaAddress;
    stealthViewingKey?: string;
  }): void {
    const endpoint = this.requireEndpoint(agentId);
    if (patch.inboxIdentityAddress !== undefined) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(patch.inboxIdentityAddress)) {
        throw new Error("Stealth inbox identity address is invalid");
      }
      endpoint.inboxIdentityAddress = patch.inboxIdentityAddress;
    }
    if (patch.stealthMeta !== undefined) endpoint.stealthMeta = { ...patch.stealthMeta };
    if (patch.stealthViewingKey !== undefined) endpoint.stealthViewingKey = patch.stealthViewingKey;
  }

  /**
   * Announcements that could still hold value. Re-pairing a different
   * meta-address while any of these are outstanding orphans the spend authority
   * for money already announced to the old one, so a pairing path must refuse
   * on a nonzero count.
   *
   * Zero when the book or ledger is absent is the truth, not a fallback:
   * `indexInboundAnnouncements` returns early without both, so nothing was ever
   * indexed.
   */
  outstandingAnnouncementCount(agentId: string): number {
    if (!this.inboundAnnouncements || !this.privateLedger) return 0;
    const endpoint = this.requireEndpoint(agentId);
    const accountId = this.privateLedger.accountReference(endpoint.agentId);
    return this.inboundAnnouncements
      .forAccount(accountId)
      .filter((record) => record.status !== "swept" && record.status !== "dormant")
      .length;
  }

  // Existence probes for the browser surface. They return undefined rather than
  // throwing so a caller can keep unknown-agent and unpaired-agent responses
  // indistinguishable instead of turning this into an agent-existence oracle.
  hasEndpoint(agentId: string): boolean {
    return this.endpoints.has(agentId);
  }

  endpointStealthMeta(agentId: string): StealthMetaAddress | undefined {
    const meta = this.endpoints.get(agentId)?.stealthMeta;
    return meta ? { ...meta } : undefined;
  }

  endpointInboxIdentityAddress(agentId: string): string | undefined {
    return this.endpoints.get(agentId)?.inboxIdentityAddress;
  }

  private refreshBudget() {
    const floor = PrivateAgentRegistry.INBOX_BALANCE_REFRESH_FLOOR;
    const ceiling = PrivateAgentRegistry.INBOX_BALANCE_REFRESH_LIMIT;
    return floor + Math.floor(Math.random() * (ceiling - floor + 1));
  }

  private toInboxEntry(record: InboundAnnouncementRecord): StealthInboxEntry {
    return {
      id: record.id,
      network: record.network,
      asset: record.tokenAddress,
      assetDecimals: this.assetDecimalsFor(record.network),
      stealthAddress: record.stealthAddress,
      ephemeralPubKey: record.ephemeralPubKey,
      expectedAmountAtomic: record.expectedAmountAtomic,
      observedAmountAtomic: record.observedAmountAtomic,
      observedAt: record.observedAt,
      status: record.status,
      // There is no claim path at 4a. Reporting true here would advertise a
      // button that cannot exist yet.
      claimable: false,
      simulated: record.source === "simulated",
      anomaly: record.anomaly,
      createdAt: record.createdAt,
    };
  }

  private assetDecimalsFor(network: string): number {
    const rail = this.resolveRail(network);
    if (rail) return rail.tokenConfig.decimals;
    try {
      return resolveX402Network(network).decimals;
    } catch {
      // An announcement for a network this process no longer configures must
      // still be listed — dropping the row drops the payee's only copy of `R`.
      // Zero renders raw atomic units, which is visibly unformatted rather
      // than confidently wrong by a factor of a million.
      return 0;
    }
  }

  quotePrivateLedger(
    input: X402QuoteInput,
    remoteIp: string,
    token: X402TokenConfig,
    nowSeconds: number
  ): PrivateLedgerRequirements {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const payee = this.requireEndpoint(input.payeeAgentId);
    const payer = this.requireEndpoint(input.payerAgentId);
    if (payee.agentId === payer.agentId) throw new Error("Private ledger payer and payee must differ");
    this.assertVpnPeer(payee, remoteIp);
    if (BigInt(input.amountAtomic) <= 0n) throw new Error("quote amount must be positive");
    const validForSeconds = input.validForSeconds ?? 600;
    const network = resolveX402Network(input.network ?? "base");
    if (network.network !== token.network) {
      throw new Error(`Quote network ${network.network} does not match ledger token network ${token.network}`);
    }
    this.assertAgentIntent(payee, input.agentSignature, x402QuoteIntentMessage({
      payeeAgentId: input.payeeAgentId,
      payerAgentId: input.payerAgentId,
      amountAtomic: input.amountAtomic,
      resource: input.resource,
      validForSeconds,
      network: network.network,
      intentNonce: input.intentNonce
    }));
    this.consumeNonce("x402-quote", payee.agentId, input.intentNonce);
    const requirements: PrivateLedgerRequirements = {
      x402Version: 2,
      scheme: PRIVATE_LEDGER_SCHEME,
      network: network.caip2,
      asset: token.address.toLowerCase(),
      amountAtomic: BigInt(input.amountAtomic).toString(),
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      quoteNonce: `0x${randomBytes(32).toString("hex")}`,
      resourceHash: sha256(input.resource),
      validBefore: nowSeconds + validForSeconds
    };
    this.evictExpiredQuotes(nowSeconds);
    this.privateLedgerQuotes.set(requirements.quoteNonce, {
      requirements,
      expiresAtMs: requirements.validBefore * 1000
    });
    return requirements;
  }

  async payPrivateLedger(
    voucher: PrivateLedgerVoucher,
    remoteIp: string,
    nowSeconds: number
  ): Promise<PrivateLedgerPaymentAccepted> {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    this.evictExpiredQuotes(nowSeconds);
    const quote = this.privateLedgerQuotes.get(voucher.requirements.quoteNonce);
    if (!quote) throw new Error("No outstanding private ledger quote");
    if (canonicalJson(voucher.requirements) !== canonicalJson(quote.requirements)) {
      throw new Error("Private ledger voucher requirements do not match issued quote");
    }
    const payer = this.requireEndpoint(quote.requirements.payerAgentId);
    this.assertVpnPeer(payer, remoteIp);
    this.assertAgentIntent(payer, voucher.agentSignature, privateLedgerVoucherIntentMessage({
      requirements: voucher.requirements,
      authorizationNonce: voucher.authorizationNonce
    }));
    const network = resolveX402Network(quote.requirements.network).network;
    const result = await this.privateLedger.transfer({
      payerAgentId: quote.requirements.payerAgentId,
      payeeAgentId: quote.requirements.payeeAgentId,
      amountAtomic: quote.requirements.amountAtomic,
      assetKey: privateLedgerAssetKey(network, quote.requirements.asset),
      authorizationNonce: voucher.authorizationNonce,
      resourceHash: quote.requirements.resourceHash
    });
    this.privateLedgerQuotes.delete(quote.requirements.quoteNonce);
    return {
      status: "accepted",
      scheme: PRIVATE_LEDGER_SCHEME,
      commitment: result.commitment,
      payerBalanceAtomic: result.payerBalanceAtomic,
      acceptedAt: result.acceptedAt
    };
  }

  async createPrivateLedgerDepositIntent(
    input: PrivateLedgerDepositIntentInput,
    remoteIp: string,
    deposit: { recipient: string; asset: string },
    nowSeconds: number
  ): Promise<{
    depositId: string;
    network: string;
    asset: string;
    recipient: string;
    amountAtomic: string;
    validBefore: number;
  }> {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const endpoint = this.requireEndpoint(input.agentId);
    this.assertVpnPeer(endpoint, remoteIp);
    if (BigInt(input.amountAtomic) <= 0n) throw new Error("Deposit amount must be positive");
    const network = resolveX402Network(input.network ?? "base");
    if (network.kind === "solana") {
      try {
        new PublicKey(input.fromAddress);
      } catch {
        throw new Error("Invalid private deposit sender");
      }
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(input.fromAddress)) {
      throw new Error("Invalid private deposit sender");
    }
    // The Solana sender-binding fix changed the signed bytes for base58
    // addresses. Accept the pre-fix format for one release so in-flight Solana
    // clients keep working; EVM signers are unaffected (already lowercase).
    const depositIntentFields = { ...input, network: network.network };
    try {
      this.assertAgentIntent(
        endpoint,
        input.agentSignature,
        privateLedgerDepositIntentMessage(depositIntentFields),
      );
    } catch (error) {
      if (network.kind !== "solana") throw error;
      this.assertAgentIntent(
        endpoint,
        input.agentSignature,
        legacyPrivateLedgerDepositIntentMessage(depositIntentFields),
      );
      console.warn(`DEPOSIT_INTENT_LEGACY_SIGNATURE agent=${endpoint.agentId} network=${network.network}`);
    }
    const intent: PrivateLedgerDepositIntent = {
      id: `deposit-intent-${randomBytes(16).toString("hex")}`,
      agentId: endpoint.agentId,
      fromAddress: network.kind === "solana" ? input.fromAddress : input.fromAddress.toLowerCase(),
      amountAtomic: BigInt(input.amountAtomic).toString(),
      network: network.network,
      expiresAtMs: (nowSeconds + 900) * 1000
    };
    const rail = this.resolveRail(network.network);
    const issueStealth = Boolean(
      this.stealthDepositsEnabled
      && this.depositAddressBook
      && rail?.depositCapable,
    );
    if (this.stealthDepositsEnabled && !issueStealth) {
      const reason = rail?.settlementMode === "onchain"
        ? "settler_ne_treasury"
        : "no_settler";
      console.warn(`STEALTH_DEPOSITS_FALLBACK network=${network.network} reason=${reason}`);
    }
    if (issueStealth && this.depositAddressBook && rail) {
      this.depositAddressBook.consumeNonce(
        `private-deposit:${endpoint.agentId}:${input.intentNonce}`,
        intent.expiresAtMs + PrivateAgentRegistry.NONCE_TTL_MS,
      );
      const derivationIndex = await this.depositAddressBook.nextIndex(network.network);
      const derived = rail.deriveDepositAddress(derivationIndex);
      await this.depositAddressBook.add({
        intentId: intent.id,
        accountId: this.depositAddressBook.accountId(endpoint.agentId),
        network: network.network,
        caip2: network.caip2,
        tokenAddress: network.kind === "solana" ? deposit.asset : deposit.asset.toLowerCase(),
        keyVersion: derived.keyVersion,
        derivationIndex,
        stealthAddress: derived.stealthAddress,
        ephemeralPubKey: derived.ephemeralPubKey,
        fromAddress: intent.fromAddress,
        expectedAmountAtomic: intent.amountAtomic,
        creditValidBefore: Math.floor(intent.expiresAtMs / 1000),
      });
      return {
        depositId: intent.id,
        network: network.caip2,
        asset: network.kind === "solana" ? deposit.asset : deposit.asset.toLowerCase(),
        recipient: derived.stealthAddress,
        amountAtomic: intent.amountAtomic,
        validBefore: Math.floor(intent.expiresAtMs / 1000),
      };
    }
    this.consumeNonce("private-deposit", endpoint.agentId, input.intentNonce);
    this.privateLedgerDeposits.set(intent.id, intent);
    return {
      depositId: intent.id,
      network: network.caip2,
      asset: network.kind === "solana" ? deposit.asset : deposit.asset.toLowerCase(),
      recipient: network.kind === "solana" ? deposit.recipient : deposit.recipient.toLowerCase(),
      amountAtomic: intent.amountAtomic,
      validBefore: Math.floor(intent.expiresAtMs / 1000)
    };
  }

  /**
   * Broadcast a depositor-signed gasless authorization so a stealth output can
   * reach a deposit address without ever holding native gas.
   *
   * Gas-funding a stealth address publishes a `pool -> stealthAddr` edge and
   * destroys the recipient unlinkability the one-time address exists to give.
   * Relaying instead keeps the only public edge `stealthAddr -> depositAddr`,
   * which then consolidates into the pool on the normal deposit path — the same
   * shape every other deposit already has.
   *
   * This is NOT a general relay. Every value binding comes from the durable
   * deposit record, never from the caller, and is asserted before the settler
   * signs anything.
   */
  async relayPrivateLedgerDeposit(
    input: PrivateLedgerDepositRelayInput,
    remoteIp: string,
    deposits: ReadonlyMap<string, PrivateLedgerDepositConfig>,
    nowSeconds: number,
  ) {
    if (!this.sweepRelayEnabled) throw new Error("Stealth sweep relay is not enabled");
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const endpoint = this.requireEndpoint(input.agentId);
    this.assertVpnPeer(endpoint, remoteIp);

    const auth = input.payment?.authorization;
    if (!auth?.nonce) throw new Error("Deposit relay requires a signed EIP-3009 authorization");

    const network = resolveX402Network(input.network ?? "base");
    // force: this spends the settler's gas, so it always needs the agent's
    // identity signature regardless of the global signature policy.
    this.assertAgentIntent(endpoint, input.agentSignature, depositRelayIntentMessage({
      agentId: endpoint.agentId,
      depositId: input.depositId,
      network: network.network,
      authorizationNonce: auth.nonce,
    }), true);

    const rail = this.resolveRail(network.network);
    if (!rail?.relayDeposit) {
      throw new Error(`Deposit relay is not supported on network ${network.network}`);
    }

    const durable = this.depositAddressBook?.byIntentId(input.depositId);
    let bindings: { from: string; to: string; value: string; validBefore: number };
    if (durable) {
      if (!this.depositAddressBook) throw new Error("Durable private deposit recovery is not configured");
      if (durable.accountId !== this.depositAddressBook.accountId(input.agentId)) {
        throw new Error("Private deposit agent mismatch");
      }
      if (durable.network !== network.network) throw new Error("Private deposit network mismatch");
      if (durable.status !== "awaiting-payment") {
        throw new Error(`Deposit relay requires an unpaid deposit intent, got ${durable.status}`);
      }
      bindings = {
        from: durable.fromAddress,
        to: durable.stealthAddress,
        value: durable.expectedAmountAtomic,
        validBefore: durable.creditValidBefore,
      };
    } else {
      const intent = this.privateLedgerDeposits.get(input.depositId);
      if (!intent || intent.expiresAtMs <= Date.now()) {
        throw new Error("Private deposit intent unavailable or expired");
      }
      if (intent.agentId !== endpoint.agentId) throw new Error("Private deposit agent mismatch");
      if (intent.network !== network.network) throw new Error("Private deposit network mismatch");
      const deposit = deposits.get(intent.network);
      if (!deposit) throw new Error(`Private deposit escrow not configured for network ${intent.network}`);
      bindings = {
        from: intent.fromAddress,
        to: deposit.recipient,
        value: intent.amountAtomic,
        validBefore: Math.floor(intent.expiresAtMs / 1000),
      };
    }

    // The authorization must not outlive the intent that justifies spending
    // settler gas on it. Deliberately unlike deposit-confirm, where
    // creditValidBefore is only a liveness bound because a late payer can only
    // ever credit their own already-landed transfer. Here WE are the one
    // broadcasting, so the window is a real bound.
    if (Number(auth.validBefore) > bindings.validBefore) {
      throw new Error("Deposit relay authorization outlives the deposit intent");
    }

    // One-shot. Durable whenever a durable record exists, so a restart cannot
    // reopen the slot and buy a second broadcast on the settler's gas.
    if (durable && this.depositAddressBook) {
      this.depositAddressBook.consumeNonce(
        `deposit-relay:${durable.id}`,
        bindings.validBefore * 1000 + PrivateAgentRegistry.NONCE_TTL_MS,
      );
    } else {
      this.consumeNonce("deposit-relay", endpoint.agentId, input.depositId);
    }

    const inbound = this.inboundAnnouncements?.byStealthAddress(network.network, bindings.from);
    if (inbound && inbound.status !== "sweeping" && inbound.status !== "swept") {
      await this.inboundAnnouncements?.markSweeping(inbound.id, input.depositId);
    }

    try {
      // to/from/value are asserted inside relayDeposit against these bindings,
      // which came only from the durable record.
      const result = await rail.relayDeposit({
        payload: input.payment,
        expectedFrom: bindings.from,
        expectedTo: bindings.to,
        expectedValueAtomic: bindings.value,
        ref: `deposit-relay:${input.depositId}`,
        nowSeconds,
      });
      return {
        status: "relayed" as const,
        depositId: input.depositId,
        network: network.network,
        mode: result.mode,
        transactionHash: result.transactionHash,
        standing: result.standing,
        reason: result.reason,
      };
    } catch (error) {
      // the sweep never left; let the output be swept again rather than
      // stranding it in `sweeping` forever
      if (inbound) {
        await this.inboundAnnouncements?.releaseSweeping(inbound.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async retireSweptAnnouncement(
    network: string | undefined,
    fromAddress: string | undefined,
    transactionHash: string,
  ) {
    if (!this.inboundAnnouncements || !network || !fromAddress) return;
    const inbound = this.inboundAnnouncements.byStealthAddress(network, fromAddress);
    if (!inbound || inbound.status === "swept") return;
    await this.inboundAnnouncements.markSwept(inbound.id, transactionHash);
  }

  async confirmPrivateLedgerDeposit(
    input: PrivateLedgerDepositConfirmInput,
    remoteIp: string,
    deposits: ReadonlyMap<string, PrivateLedgerDepositConfig>
  ) {
    if (!this.privateLedger) throw new Error("Private payment ledger is not configured");
    const durable = this.depositAddressBook?.byIntentId(input.depositId);
    if (durable) {
      const confirmed = await this.confirmDurablePrivateLedgerDeposit(
        durable,
        input,
        remoteIp,
        deposits,
      );
      // a credited deposit whose sender was one of our stealth outputs means
      // that output has been drained into the pool path — retire it
      await this.retireSweptAnnouncement(
        durable.network,
        durable.fromAddress,
        input.transactionHash,
      );
      return confirmed;
    }
    const intent = this.privateLedgerDeposits.get(input.depositId);
    if (!intent || intent.expiresAtMs <= Date.now()) throw new Error("Private deposit intent unavailable or expired");
    if (intent.agentId !== input.agentId) throw new Error("Private deposit agent mismatch");
    const network = resolveX402Network(input.network ?? "base");
    if (network.network !== intent.network) throw new Error("Private deposit network mismatch");
    const deposit = deposits.get(intent.network);
    if (!deposit) throw new Error(`Private deposit escrow not configured for network ${intent.network}`);
    const endpoint = this.requireEndpoint(input.agentId);
    this.assertVpnPeer(endpoint, remoteIp);
    this.assertAgentIntent(endpoint, input.agentSignature, privateLedgerDepositConfirmMessage({
      ...input,
      network: network.network,
    }));
    await deposit.verifyTransfer({
      transactionHash: input.transactionHash,
      tokenAddress: deposit.asset,
      fromAddress: intent.fromAddress,
      recipient: deposit.recipient,
      amountAtomic: intent.amountAtomic
    });
    const result = await this.privateLedger.creditDeposit({
      agentId: intent.agentId,
      amountAtomic: intent.amountAtomic,
      network: intent.network,
      assetKey: privateLedgerAssetKey(intent.network, deposit.asset),
      transactionHash: input.transactionHash
    });
    this.privateLedgerDeposits.delete(intent.id);
    await this.retireSweptAnnouncement(intent.network, intent.fromAddress, input.transactionHash);
    return {
      status: "credited" as const,
      commitment: result.commitment,
      balanceAtomic: result.payerBalanceAtomic,
      acceptedAt: result.acceptedAt
    };
  }

  private async confirmDurablePrivateLedgerDeposit(
    initial: DepositAddressRecord,
    input: PrivateLedgerDepositConfirmInput,
    remoteIp: string,
    deposits: ReadonlyMap<string, PrivateLedgerDepositConfig>,
  ) {
    if (!this.privateLedger || !this.depositAddressBook) {
      throw new Error("Durable private deposit recovery is not configured");
    }
    // `creditValidBefore` is deliberately NOT enforced here. A durable record
    // binds accountId, fromAddress, stealthAddress, token, and amount, and
    // verifyTransfer re-checks every one of them against the chain below, so the
    // deadline is a liveness bound rather than a security one: a late payer can
    // only ever credit their own real transfer, and the ledger's consumed-hash
    // set stops it counting twice.
    //
    // Rejecting late meant funds stranded with no in-protocol recovery — the
    // record is retained (reapSwept only drops `swept`) but became permanently
    // unconfirmable, which contradicts unpaidStale/toDormant deliberately
    // retaining anything that could still hold value. The dormancy sweeper, not
    // this check, is the cleanup authority for addresses that never get paid.
    if (initial.accountId !== this.depositAddressBook.accountId(input.agentId)) {
      throw new Error("Private deposit agent mismatch");
    }
    const network = resolveX402Network(input.network ?? "base");
    if (network.network !== initial.network) throw new Error("Private deposit network mismatch");
    const deposit = deposits.get(initial.network);
    if (!deposit) throw new Error(`Private deposit escrow not configured for network ${initial.network}`);
    if ((network.kind === "solana" ? deposit.asset : deposit.asset.toLowerCase())
      !== initial.tokenAddress) {
      throw new Error("Private deposit token binding mismatch");
    }
    const endpoint = this.requireEndpoint(input.agentId);
    this.assertVpnPeer(endpoint, remoteIp);
    this.assertAgentIntent(endpoint, input.agentSignature, privateLedgerDepositConfirmMessage({
      ...input,
      network: network.network,
    }));

    let record = initial;
    if (record.status === "awaiting-payment") {
      const verification = await deposit.verifyTransfer({
        transactionHash: input.transactionHash,
        tokenAddress: record.tokenAddress,
        fromAddress: record.fromAddress,
        recipient: record.stealthAddress,
        amountAtomic: record.expectedAmountAtomic,
      });
      if (BigInt(verification.amountAtomic) < BigInt(record.expectedAmountAtomic)) {
        throw new Error("Private deposit observed amount below expected");
      }
      const proofTxHash = record.network === "solana"
        ? verification.transactionHash
        : verification.transactionHash.toLowerCase();
      const proofId = `${record.network}:${proofTxHash}:${verification.transferIndex}`;
      const claimed = this.depositAddressBook.all().find((candidate) =>
        candidate.id !== record.id && candidate.proofId === proofId);
      if (claimed) throw new Error("Private deposit proof already claimed by another record");
      record = await this.depositAddressBook.transition(
        record.id,
        "awaiting-payment",
        (current) => {
          current.status = "proof-verified";
          current.proofId = proofId;
          current.proofTxHash = proofTxHash;
          current.proofTransferIndex = verification.transferIndex;
          current.observedAmountAtomic = verification.amountAtomic;
          const surplus = BigInt(verification.amountAtomic)
            - BigInt(current.expectedAmountAtomic);
          current.overpaymentAtomic = surplus > 0n ? surplus.toString() : null;
          current.proofVerifiedAt = Date.now();
        },
      );
    }
    if (!record.proofTxHash || record.proofTransferIndex === null || !record.proofId) {
      throw new Error("Durable private deposit proof identity is incomplete");
    }
    const submittedProofHash = record.network === "solana"
      ? input.transactionHash
      : input.transactionHash.toLowerCase();
    if (submittedProofHash !== record.proofTxHash) {
      throw new Error("Private deposit confirmation transaction does not match the durable proof");
    }
    const claimed = this.depositAddressBook.all().find((candidate) =>
      candidate.id !== record.id && candidate.proofId === record.proofId);
    if (claimed) throw new Error("Private deposit proof already claimed by another record");
    const result = await this.privateLedger.creditDeposit({
      agentId: input.agentId,
      amountAtomic: record.expectedAmountAtomic,
      network: record.network,
      assetKey: privateLedgerAssetKey(record.network, record.tokenAddress),
      transactionHash: record.proofTxHash,
      transferIndex: record.proofTransferIndex,
    });
    if (result.duplicate && this.privateLedger.depositProofClaim({
      network: record.network,
      transactionHash: record.proofTxHash,
      transferIndex: record.proofTransferIndex,
    }) !== "indexed") {
      throw new Error("Private deposit duplicate does not belong to this proof");
    }
    if (record.status === "proof-verified") {
      record = await this.depositAddressBook.transition(
        record.id,
        "proof-verified",
        (current) => {
          current.status = "credited";
          current.creditedAt = Date.now();
        },
      );
    } else if (!["credited", "reserve-mismatch", "sweep-submitted", "swept"].includes(record.status)) {
      throw new Error(`Private deposit record cannot be credited from ${record.status}`);
    }
    if (record.overpaymentAtomic
      && BigInt(record.overpaymentAtomic) > 0n
      && record.status === "credited") {
      record = await this.depositAddressBook.transition(record.id, "credited", (current) => {
        current.quarantineReason = "overpayment";
      });
      await this.reconciliationQueue?.enqueue({
        recordId: record.id,
        reason: "overpayment",
        network: record.network,
        stealthAddress: record.stealthAddress,
        observedAmountAtomic: record.observedAmountAtomic ?? record.expectedAmountAtomic,
        expectedAmountAtomic: record.expectedAmountAtomic,
        at: Date.now(),
      });
      console.error(`DEPOSIT_RECONCILIATION record=${record.id} reason=overpayment`);
    }
    return {
      status: "credited" as const,
      commitment: result.commitment,
      balanceAtomic: result.payerBalanceAtomic,
      acceptedAt: result.acceptedAt,
    };
  }

  /**
   * Payee side of the x402 handshake: issue a 402 payment challenge for a payer.
   * Only the payee (the agent being paid) may issue it, from its own VPN IP, and
   * `payTo` is forced to the payee's registered wallet. The returned
   * requirements carry a fresh nonce that the payment must reference, so a payer
   * cannot invent their own cheaper requirements.
   */
  async quoteX402(
    input: X402QuoteInput,
    remoteIp: string,
    token: X402TokenConfig,
    nowSeconds: number
  ): Promise<X402PaymentRequirements | SolanaX402PaymentRequirements> {
    const payee = this.requireEndpoint(input.payeeAgentId);
    const payer = this.requireEndpoint(input.payerAgentId);
    if (payee.agentId === payer.agentId) throw new Error("x402 payer and payee must differ");
    this.assertVpnPeer(payee, remoteIp);
    if (BigInt(input.amountAtomic) <= 0n) throw new Error("quote amount must be positive");

    const validForSeconds = input.validForSeconds ?? 600;
    if ((input.network ?? token.network) !== token.network && input.network !== token.caip2) {
      throw new Error(`Quote network ${input.network} does not match facilitator network ${token.network}`);
    }
    if (this.requireIdentitySignatures) {
      this.assertAgentIntent(payee, input.agentSignature, x402QuoteIntentMessage({
        payeeAgentId: input.payeeAgentId,
        payerAgentId: input.payerAgentId,
        amountAtomic: input.amountAtomic,
        resource: input.resource,
        validForSeconds,
        network: token.network,
        intentNonce: input.intentNonce,
        scheme: input.scheme
      }));
      this.consumeNonce("x402-quote", payee.agentId, input.intentNonce);
    }
    const requirements = input.scheme === "confidential"
      ? await this.buildConfidentialQuote({
        payee,
        amountAtomic: input.amountAtomic,
        resource: input.resource,
        validForSeconds,
        token,
      })
      : this.buildX402Quote({
        payee,
        amountAtomic: input.amountAtomic,
        resource: input.resource,
        validForSeconds,
        token,
        nowSeconds
      });
    // A denomination ladder is meaningless on the confidential rail — that scheme
    // hides the AMOUNT, so there is nothing to split into standard legs, and its
    // settlement path never builds a payout plan. `buildConfidentialQuote` sets a
    // stealthMetaAddress of its own, so testing that alone would advertise a
    // ladder no confidential payer can use and invite a client into the wrong
    // path (spec-exit-rounds.md §3.4).
    if (input.scheme !== "confidential" && requirements.stealthMetaAddress) {
      const advertisement = this.payoutAdvertisementFor(token.network);
      if (advertisement) requirements.payoutPolicy = advertisement;
    }
    this.evictExpiredQuotes(nowSeconds);
    this.x402Quotes.set(requirements.nonce, {
      requirements,
      payeeAgentId: payee.agentId,
      payerAgentId: payer.agentId,
      expiresAtMs: nowSeconds * 1000 + validForSeconds * 1000
    });
    return requirements;
  }

  /**
   * Which settlement network an outstanding quote was issued on, resolved by
   * the payment's authorization nonce. Lets the transport pick the matching
   * facilitator without trusting the payload's own network claim.
   */
  quotedNetworkForPayment(input: X402PayInput): string | undefined {
    const paymentRail = this.railOwningPayment(input.payment);
    const nonce = paymentRail?.paymentNonce(input)
      ?? (isSolanaPayment(input.payment) ? input.requirementsNonce ?? "" : input.payment.authorization?.nonce ?? "");
    return this.x402Quotes.get(nonce)?.requirements.network;
  }

  poolPayoutRailAvailable(quoteNonce: string): boolean | undefined {
    const quote = this.x402Quotes.get(quoteNonce);
    return quote ? Boolean(this.resolveRail(quote.requirements.network)) : undefined;
  }

  /**
   * Payer side: settle a payment that satisfies an outstanding quote. The
   * payment's authorization nonce IS the quote id, so the server uses its own
   * issued requirements (never trusts caller-supplied ones). Payer must come
   * from its registered VPN IP, and the signed transfer must move funds between
   * exactly the quoted payer/payee wallets. The facilitator verifies the
   * EIP-3009 signature and settles (gated dry-run vs on-chain). One-shot: the
   * quote is consumed on success.
   */
  async payX402(
    input: X402PayInput,
    remoteIp: string,
    facilitator: X402Facilitator | SolanaX402Facilitator,
    nowSeconds: number
  ): Promise<X402TradeReceipt> {
    const payment = input.payment;
    // A confidential payload carries `transactions` (the five-transaction plan),
    // NOT `transaction`, so neither `ownsPayment` nor `isSolanaPayment`
    // recognises it and the fallback would read `payment.authorization.nonce` on
    // an object that has no authorization. Like Solana `exact`, the quote nonce
    // rides beside the payment on the transport.
    const nonce = isConfidentialPayload(payment)
      ? input.requirementsNonce
      : this.railOwningPayment(payment)?.paymentNonce(input)
        ?? (isSolanaPayment(payment) ? input.requirementsNonce : payment.authorization.nonce);
    if (!nonce) throw new Error("Solana x402 payment requires the quote nonce");
    this.evictExpiredQuotes(nowSeconds);
    const quote = this.x402Quotes.get(nonce);
    if (!quote) throw new Error("No outstanding x402 quote for this payment nonce");

    const payer = this.requireEndpoint(quote.payerAgentId);
    const payee = this.requireEndpoint(quote.payeeAgentId);
    // The WireGuard peer IP authenticates WHICH agent is paying. The on-chain
    // `from` is intentionally NOT bound to the registered wallet — payers rotate
    // fresh addresses (Phase 2 privacy) so their identity wallet never appears
    // on-chain. The quote being payer-scoped + this peer check is the auth.
    this.assertVpnPeer(payer, remoteIp);
    this.assertAgentIntent(payer, input.agentSignature, x402PayIntentMessage({
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      payment: input.payment,
      requirementsNonce: input.requirementsNonce
    }));

    // Routed by the QUOTE's scheme, never the payload's. A payload-driven
    // decision is a downgrade attack: a payer that could assert `exact` against
    // a confidential quote would publish the amount the payee paid to hide.
    if ((quote.requirements as { scheme?: string }).scheme === "confidential") {
      return this.payConfidential({
        quote, payer, payee, nonce, payment, facilitator,
      });
    }

    const rail = this.settlementRail(quote.requirements, payment, facilitator);
    // Write-ahead before settle can broadcast. resolveRecipient is deterministic
    // and side-effect free, so recomputing it inside settle is free.
    if (input.ephemeralPubKey) {
      const announced = rail.resolveRecipient({
        requirements: quote.requirements,
        payee,
        ephemeralPubKey: input.ephemeralPubKey,
      });
      if (announced.stealth) {
        await this.indexInboundAnnouncements({
          payeeAgentId: payee.agentId,
          network: rail.network,
          caip2: rail.tokenConfig.caip2,
          tokenAddress: rail.network === "solana"
            ? rail.tokenConfig.address
            : rail.tokenConfig.address.toLowerCase(),
          source: "x402-direct",
          legs: [{
            sourceRef: nonce,
            stealthAddress: announced.stealth.stealthAddress,
            ephemeralPubKey: announced.stealth.ephemeralPubKey,
            amountAtomic: "maxAmountRequired" in quote.requirements
              ? quote.requirements.maxAmountRequired
              : null,
          }],
        });
      }
    }
    const { settlement, stealth } = await rail.settle({
      payment,
      requirements: quote.requirements,
      payee,
      ephemeralPubKey: input.ephemeralPubKey,
      nowSeconds
    });
    this.x402Quotes.delete(nonce); // one-shot quote

    const receipt: X402TradeReceipt = {
      id: createServerId("x402-receipt"),
      kind: "x402",
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      payerVpnIp: payer.vpnIp,
      payeeVpnIp: payee.vpnIp,
      asset: settlement.asset,
      value: settlement.value,
      resource: quote.requirements.resource,
      settlement,
      settledAt: Date.now(),
      route: "wireguard-x402",
      stealthAddress: stealth?.stealthAddress,
      ephemeralPubKey: stealth?.ephemeralPubKey
    };
    return receipt;
  }

  /**
   * The server half of the slot-provisioning ceremony (§5.2-P, §15.3 step 2).
   *
   * Two signatures, and they are split because neither party can do the other's
   * job. Only the account OWNER may run `Configure` — measured on devnet as
   * `Missing required signature for instruction (instruction #2)` — and the
   * owner is a one-time stealth key derived from `kSpend`, which never leaves
   * the payee. Only the settler has SOL for rent. So the payee builds and
   * partial-signs the plan, and we fund and broadcast it.
   *
   * Because we are funding accounts on someone else's say-so, everything the
   * payee asserts is re-derived here before a single lamport is spent:
   *
   *   1. **The address is really this payee's** — recomputed from `R` and OUR
   *      copy of the viewing key. This is what stops an agent having us fund
   *      accounts owned by someone else, or by nobody.
   *   2. **The ATA is the real Token-2022 ATA** for that address and mint,
   *      derived by us. A payee-supplied account would be where payments land.
   *   3. **`P` matches what the PROGRAM stored**, read back after confirmation.
   *      The server can never compute `P` (`s⁻¹·H`, and we hold only a viewing
   *      key), so a read-back comparison is the only available check — and it is
   *      a complete one, because that stored key is exactly what the program
   *      enforces against a later transfer's `destinationElgamalPubkey`.
   *
   * Registration happens only after all three pass on a CONFIRMED account. A
   * slot registered before confirmation is a slot we might hand to a payer that
   * then pays into an account which does not exist.
   */
  async provisionConfidentialSlots(
    input: ConfidentialSlotProvisionInput,
    remoteIp: string,
  ): Promise<ConfidentialSlotProvisionResult> {
    const payee = this.requireEndpoint(input.payeeAgentId);
    this.assertVpnPeer(payee, remoteIp);
    if (!this.confidentialSlots) {
      throw new ConfidentialPaymentError("confidential_not_supported", "no slot pool configured");
    }
    if (!this.privateLedger) {
      throw new ConfidentialPaymentError("confidential_not_supported", "no private ledger");
    }
    if (!payee.solanaStealthMeta || !payee.solanaStealthViewingKey) {
      throw new ConfidentialPaymentError("confidential_requires_stealth", payee.agentId);
    }
    const slots = Array.isArray(input.slots) ? input.slots : [];
    if (slots.length === 0 || slots.length > MAX_CONFIDENTIAL_SLOTS_PER_BATCH) {
      throw new ConfidentialPaymentError("confidential_malformed", "slot batch size");
    }
    const rail = this.resolveRail(input.network);
    if (!rail || !isConfidentialProvisioningRail(rail)) {
      throw new ConfidentialPaymentError("confidential_not_supported", input.network);
    }
    this.assertAgentIntent(payee, input.agentSignature, confidentialSlotProvisionIntentMessage({
      payeeAgentId: payee.agentId,
      network: rail.network,
      mint: rail.confidentialMint,
      stealthAddresses: slots.map((slot) => slot.stealthAddress),
      intentNonce: input.intentNonce,
    }));
    this.consumeNonce("confidential-slots", payee.agentId, input.intentNonce);

    // (1) Every address must recompute from R + OUR viewing key. Done BEFORE
    // broadcast, because this is the check that decides whether we pay rent.
    for (const slot of slots) {
      const expected = checkSolanaStealthAddress({
        ephemeralPubKey: slot.ephemeralPubKey,
        viewingScalar: payee.solanaStealthViewingKey,
        spendingPubKey: payee.solanaStealthMeta.spendingPubKey,
      }).stealthAddress;
      if (expected !== slot.stealthAddress) {
        throw new ConfidentialPaymentError(
          "confidential_malformed",
          "a slot address does not derive from this payee's meta-address",
        );
      }
    }

    const broadcast = await rail.provisionConfidentialSlots({
      transactions: input.transactions,
      addresses: slots.map((slot) => slot.stealthAddress),
    });
    if (broadcast.status !== "provisioned") {
      return { status: "refused", registered: 0, detail: broadcast.detail, signatures: broadcast.signatures };
    }

    const accountId = this.privateLedger.accountReference(payee.agentId);
    const verified: NewConfidentialSlot[] = [];
    const rejected: string[] = [];
    for (const slot of slots) {
      const landed = broadcast.onchain.find((entry) => entry.stealthAddress === slot.stealthAddress);
      // (2) the ATA we derived, never the one the payee sent.
      if (!landed || landed.tokenAccount !== slot.tokenAccount) {
        rejected.push(`${slot.stealthAddress}:ata-mismatch`);
        continue;
      }
      // (3) the key the program stored, never the one the payee claimed.
      if (!landed.encryptionPubKey) {
        rejected.push(`${slot.stealthAddress}:not-configured`);
        continue;
      }
      if (landed.encryptionPubKey !== slot.encryptionPubKey) {
        rejected.push(`${slot.stealthAddress}:elgamal-mismatch`);
        continue;
      }
      verified.push({
        accountId,
        network: rail.network,
        caip2: rail.tokenConfig.caip2,
        mint: rail.confidentialMint,
        stealthAddress: slot.stealthAddress,
        ephemeralPubKey: slot.ephemeralPubKey,
        // Branded only HERE, from the value the program stored — never from the
        // payee's claim. ~1% of ed25519 points are silently accepted by
        // ElGamalPubkey.fromBytes, so an unchecked cast can encrypt funds to a
        // key nobody holds.
        encryptionPubKey: asConfidentialEncryptionPubKey(landed.encryptionPubKey),
        tokenAccount: landed.tokenAccount,
      });
    }
    if (rejected.length > 0) {
      // Loud, because rent was already spent on these and an operator or the
      // payee needs to know which accounts are stranded.
      console.error(
        `CONFIDENTIAL_SLOT_REJECTED network=${rail.network} count=${rejected.length}`
        + ` reasons=${rejected.join(",")}`,
      );
    }
    const added = verified.length > 0 ? await this.confidentialSlots.addMany(verified) : [];
    return {
      status: "provisioned",
      registered: added.length,
      available: this.confidentialSlots.availableCount(rail.network),
      signatures: broadcast.signatures,
      ...(rejected.length > 0 ? { rejected } : {}),
    };
  }

  /**
   * Pool depth for the confidential rail. Exhaustion is a liveness condition, so
   * an operator needs to see it coming rather than discover it as a refused
   * quote.
   */
  confidentialSlotDepth(network: string): { available: number; total: number } | undefined {
    if (!this.confidentialSlots) return undefined;
    return {
      available: this.confidentialSlots.availableCount(network),
      total: this.confidentialSlots.all().filter((slot) => slot.network === network).length,
    };
  }

  /**
   * Settles a payment against a `confidential` quote (§15.2).
   *
   * The announcement write-ahead is passed INTO `settleConfidential` rather than
   * performed here, so the ordering is enforced by the rail's own signature: it
   * awaits the write before its first broadcast, and a throw means nothing was
   * broadcast at all. `R` is the only thing that lets the payee derive its
   * one-time key or even locate the address, so an announcement lost between
   * broadcast and index-write strands the funds permanently.
   */
  private async payConfidential(input: {
    quote: { requirements: X402PaymentRequirements | SolanaX402PaymentRequirements };
    payer: PrivateAgentEndpoint;
    payee: PrivateAgentEndpoint;
    nonce: string;
    payment: X402PaymentPayload | SolanaX402PaymentPayload;
    facilitator: X402Facilitator | SolanaX402Facilitator;
  }): Promise<X402TradeReceipt> {
    const requirements = assertSolanaConfidentialRequirements(input.quote.requirements);
    const rail = this.resolveRail(requirements.network);
    if (!rail || !isConfidentialRail(rail)) {
      throw new ConfidentialPaymentError("confidential_not_supported", requirements.network);
    }
    // Recomputes the recipient from `R` + the payee's viewing key rather than
    // trusting the quote we stored, and refuses if the slot is not this payee's.
    const recipient = rail.resolveConfidentialRecipient({
      requirements,
      payee: input.payee,
      ephemeralPubKey: requirements.ephemeralPubKey,
    });
    await rail.ensureConfidentialAccount({ recipient });

    const { settlement, stealth } = await rail.settleConfidential({
      payload: input.payment,
      requirements,
      writeAheadAnnouncement: () => this.indexInboundAnnouncements({
        payeeAgentId: input.payee.agentId,
        network: rail.network,
        caip2: rail.tokenConfig.caip2,
        tokenAddress: requirements.asset,
        source: "x402-direct",
        // B3. Without this the book reads the confidential output's
        // by-construction zero as "provably drained" and reaps the only copy
        // of `R` about a day later, silently.
        confidentiality: "confidential",
        legs: [{
          sourceRef: input.nonce,
          stealthAddress: recipient.recipient,
          ephemeralPubKey: requirements.ephemeralPubKey,
        }],
      }),
    });
    this.x402Quotes.delete(input.nonce); // one-shot quote

    return {
      id: createServerId("x402-receipt"),
      kind: "x402",
      payerAgentId: input.payer.agentId,
      payeeAgentId: input.payee.agentId,
      payerVpnIp: input.payer.vpnIp,
      payeeVpnIp: input.payee.vpnIp,
      asset: settlement.asset,
      value: settlement.value,
      resource: requirements.resource,
      settlement,
      settledAt: Date.now(),
      route: "wireguard-x402",
      stealthAddress: stealth?.stealthAddress,
      ephemeralPubKey: stealth?.ephemeralPubKey,
    };
  }

  /**
   * Builds a `confidential` quote by handing out one pre-provisioned slot
   * (spec-confidential-x402.md §5.2-P).
   *
   * Async where `buildX402Quote` is sync, because the slot must be RESERVED
   * durably before it is published — issuing one slot to two payments would let
   * the first payer decrypt the second payment's balance.
   *
   * Every refusal below is explicit and none of them fall back to `exact`. A
   * silent downgrade would hand the payer a quote that publishes the amount
   * while it believes it bought confidentiality, which is worse than an error.
   */
  private async buildConfidentialQuote(input: {
    payee: PrivateAgentEndpoint;
    amountAtomic: string;
    resource: string;
    validForSeconds: number;
    token: X402TokenConfig;
  }): Promise<SolanaConfidentialRequirements> {
    const rail = this.resolveRail(input.token.network, input.token.caip2);
    if (!rail || !isConfidentialRail(rail)) {
      throw new ConfidentialPaymentError("confidential_not_supported", input.token.network);
    }
    if (!this.confidentialSlots) {
      throw new ConfidentialPaymentError("confidential_not_supported", "no slot pool configured");
    }
    // §3.2 — confidential without stealth hides the value but publishes a
    // persistent, reusable receiver. Refused at quote time so a payer never
    // builds proofs for a payment we would reject.
    //
    // `solanaStealthMeta`, NOT `stealthMeta`: the latter is the secp256k1
    // EIP-5564 meta-address, and this rail is ed25519 DKSAP. Both fields exist
    // on the endpoint and both are optional, so reading the wrong one
    // type-checks perfectly and fails only at the point where funds move.
    if (!input.payee.solanaStealthMeta || !input.payee.solanaStealthViewingKey) {
      throw new ConfidentialPaymentError("confidential_requires_stealth", input.payee.agentId);
    }
    const slot = await this.confidentialSlots.reserve(
      `x402:${input.payee.agentId}:${input.resource}:${input.amountAtomic}`,
      rail.network,
    );
    if (!slot) {
      // Exhaustion is a LIVENESS condition, not a correctness one. Reusing a
      // slot instead would be the correctness failure.
      throw new ConfidentialPaymentError("confidential_not_supported", "slot pool exhausted");
    }
    const requirements: SolanaConfidentialRequirements = {
      x402Version: 1,
      scheme: "confidential",
      network: "solana",
      asset: slot.mint,
      payTo: slot.stealthAddress,
      maxAmountRequired: input.amountAtomic,
      resource: input.resource,
      nonce: `0x${randomBytes(32).toString("hex")}`,
      validForSeconds: input.validForSeconds,
      stealthMetaAddress: input.payee.solanaStealthMeta,
      ephemeralPubKey: slot.ephemeralPubKey,
      encryptionPubKey: slot.encryptionPubKey,
      destinationTokenAccount: slot.tokenAccount,
    };
    // Validate our OWN output before publishing it: a malformed quote sends the
    // payer off to build proofs against a slot it can never satisfy.
    return assertSolanaConfidentialRequirements(requirements);
  }

  private buildX402Quote(input: {
    payee: PrivateAgentEndpoint;
    amountAtomic: string;
    resource: string;
    validForSeconds: number;
    token: X402TokenConfig;
    nowSeconds: number;
  }): X402PaymentRequirements | SolanaX402PaymentRequirements {
    const rail = this.resolveRail(input.token.network, input.token.caip2);
    if (rail) return rail.buildQuote(input);

    // Backward compatibility for direct registry callers that provide only a
    // token at quote time and a facilitator later at pay time.
    if (input.token.kind === "solana") {
      return buildSolanaAgentQuote({
        payee: input.payee,
        amountAtomic: input.amountAtomic,
        resource: input.resource,
        validForSeconds: input.validForSeconds,
        token: input.token
      });
    }

    const requirements = buildPaymentRequirements({
      payTo: input.payee.walletAddress,
      maxAmountRequired: input.amountAtomic,
      resource: input.resource,
      validForSeconds: input.validForSeconds,
      token: input.token,
      nowSeconds: input.nowSeconds
    });
    if (input.payee.stealthMeta) requirements.stealthMetaAddress = input.payee.stealthMeta;
    return requirements;
  }

  private settlementRail(
    requirements: X402PaymentRequirements | SolanaX402PaymentRequirements,
    payment: X402PaymentPayload | SolanaX402PaymentPayload,
    facilitator: X402Facilitator | SolanaX402Facilitator
  ): ChainRail {
    const solanaRequirements = "x402Version" in requirements;
    const solanaPayment = isSolanaPayment(payment);
    if (solanaPayment && !solanaRequirements) throw new Error("Solana payment cannot satisfy an EVM quote");
    if (!solanaPayment && solanaRequirements) throw new Error("EVM payment cannot satisfy a Solana quote");

    const configuredRail = this.resolveRail(requirements.network);
    if (configuredRail) {
      if (solanaRequirements && configuredRail.kind !== "solana") throw new Error("Solana x402 facilitator mismatch");
      if (!solanaRequirements && configuredRail.kind !== "evm") throw new Error("EVM x402 facilitator mismatch");
      return configuredRail;
    }

    if (solanaRequirements) {
      if (facilitator.tokenConfig.kind !== "solana") throw new Error("Solana x402 facilitator mismatch");
      return new SolanaChainRail({ facilitator: facilitator as SolanaX402Facilitator });
    }
    if (facilitator.tokenConfig.kind !== "evm") throw new Error("EVM x402 facilitator mismatch");
    return new EvmChainRail({ facilitator: facilitator as X402Facilitator });
  }

  private resolveRail(...networks: string[]): ChainRail | undefined {
    if (!this.rails) return undefined;
    for (const network of networks) {
      const direct = this.rails.get(network);
      if (direct) return direct;
      for (const rail of this.rails.values()) {
        if (rail.network === network || rail.tokenConfig.caip2 === network) return rail;
      }
    }
    return undefined;
  }

  private railOwningPayment(payment: X402PaymentPayload | SolanaX402PaymentPayload): ChainRail | undefined {
    if (!this.rails) return undefined;
    for (const rail of this.rails.values()) {
      if (rail.ownsPayment(payment)) return rail;
    }
    return undefined;
  }

  private evictExpiredQuotes(nowSeconds: number) {
    const nowMs = nowSeconds * 1000;
    for (const [nonce, quote] of this.x402Quotes) {
      if (quote.expiresAtMs <= nowMs) this.x402Quotes.delete(nonce);
    }
    for (const [nonce, quote] of this.privateLedgerQuotes) {
      if (quote.expiresAtMs <= nowMs) this.privateLedgerQuotes.delete(nonce);
    }
  }

  createOffer(input: AgentOfferInput, remoteIp: string) {
    const sender = this.requireEndpoint(input.senderAgentId);
    const receiver = this.requireEndpoint(input.receiverAgentId);
    this.assertVpnPeer(sender, remoteIp);
    this.assertSignature(sender, this.offerPayload(input), input.signature);
    this.consumeNonce("offer", sender.agentId, input.nonce);

    const item = sender.inventory.find((entry) => entry.id === input.itemId);
    if (!item || item.quantity < 1) throw new Error("Sender does not carry offered item");
    if (receiver.credits < input.price) throw new Error("Receiver cannot afford offer");

    const offer: AgentOffer = {
      id: createServerId("a2a-offer"),
      senderAgentId: sender.agentId,
      receiverAgentId: receiver.agentId,
      item: { ...item, quantity: 1 },
      price: Math.max(1, Math.floor(input.price)),
      nonce: input.nonce,
      status: "open",
      createdAt: Date.now()
    };
    this.offers.set(offer.id, offer);
    return offer;
  }

  acceptOffer(input: AgentAcceptInput, remoteIp: string) {
    const receiver = this.requireEndpoint(input.receiverAgentId);
    this.assertVpnPeer(receiver, remoteIp);
    this.assertSignature(receiver, this.acceptPayload(input), input.signature);
    this.consumeNonce("accept", receiver.agentId, input.nonce);

    const offer = this.offers.get(input.offerId);
    if (!offer || offer.status !== "open") throw new Error("Offer unavailable");
    if (offer.receiverAgentId !== receiver.agentId) throw new Error("Offer receiver mismatch");

    const sender = this.requireEndpoint(offer.senderAgentId);
    const senderItem = sender.inventory.find((entry) => entry.id === offer.item.id);
    if (!senderItem || senderItem.quantity < offer.item.quantity) throw new Error("Sender inventory changed");
    if (receiver.credits < offer.price) throw new Error("Receiver balance changed");

    senderItem.quantity -= offer.item.quantity;
    sender.inventory = sender.inventory.filter((item) => item.quantity > 0);
    sender.credits += offer.price;
    receiver.credits -= offer.price;
    this.addInventory(receiver.inventory, offer.item, offer.item.quantity);
    offer.status = "settled";

    const receipt: AgentReceipt = {
      id: createServerId("a2a-receipt"),
      offerId: offer.id,
      senderAgentId: sender.agentId,
      receiverAgentId: receiver.agentId,
      senderVpnIp: sender.vpnIp,
      receiverVpnIp: receiver.vpnIp,
      item: offer.item,
      price: offer.price,
      settledAt: Date.now(),
      route: "wireguard-agent-rpc"
    };
    this.offers.delete(offer.id);
    return receipt;
  }

  offerPayload(input: Pick<AgentOfferInput, "senderAgentId" | "receiverAgentId" | "itemId" | "price" | "nonce">) {
    return `offer:${input.senderAgentId}:${input.receiverAgentId}:${input.itemId}:${Math.floor(input.price)}:${input.nonce}`;
  }

  acceptPayload(input: Pick<AgentAcceptInput, "receiverAgentId" | "offerId" | "nonce">) {
    return `accept:${input.receiverAgentId}:${input.offerId}:${input.nonce}`;
  }

  private requireEndpoint(agentId: string) {
    const endpoint = this.endpoints.get(agentId);
    if (!endpoint) throw new Error(`Unknown private agent endpoint: ${agentId}`);
    return endpoint;
  }

  // Each signed offer/accept carries a one-time nonce. Without consuming it a
  // captured (payload, signature) pair could be replayed over WireGuard to mint
  // duplicate offers / re-drive settlement. Consumed only after the signature
  // verifies, so an attacker cannot burn another agent's nonce with garbage.
  private consumeNonce(scope: "offer" | "accept" | "x402-quote" | "private-deposit" | "pool-claim" | "voucher-issue" | "stealth-inbox" | "deposit-relay" | "stealth-inbox-pair" | "stealth-inbox-browser" | "stealth-inbox-sim" | "confidential-slots", agentId: string, nonce: string) {
    if (!nonce) throw new Error("Agent intent nonce required");
    this.evictExpiredNonces();
    const key = `${scope}:${agentId}:${nonce}`;
    if (this.consumedNonces.has(key)) throw new Error("Replayed agent intent nonce rejected");
    this.consumedNonces.set(key, Date.now() + PrivateAgentRegistry.NONCE_TTL_MS);
  }

  private evictExpiredNonces() {
    const now = Date.now();
    for (const [key, expiresAt] of this.consumedNonces) {
      if (expiresAt <= now) this.consumedNonces.delete(key);
    }
  }

  /**
   * The single authorization gate for both channels.
   *
   * WireGuard keeps exactly the checks it always had, in the same order:
   * registered peer, then a forced identity signature. The browser channel gets
   * neither a peer check nor `identityAddress` — recovering to that address
   * here would silently promote a receive-only read key into the credential
   * that authorizes every spend-side intent.
   */
  private assertCaller(
    endpoint: PrivateAgentEndpoint,
    caller: PrivateCaller,
    expectedScope: BrowserInboxScope,
    signature: string,
    message: string,
  ) {
    const context = normalizePrivateCaller(caller);
    if (context.channel === "wireguard") {
      this.assertVpnPeer(endpoint, context.remoteIp);
      this.assertAgentIntent(endpoint, signature, message, true);
      return;
    }
    if (context.scope !== expectedScope) {
      throw new Error(`Stealth inbox scope mismatch: expected ${expectedScope}, got ${context.scope}`);
    }
    if (!endpoint.inboxIdentityAddress) {
      throw new Error(`Stealth inbox is not paired for ${endpoint.agentId}`);
    }
    if (!signature) throw new Error("Agent intent signature required");
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw new Error("Agent intent signature invalid");
    }
    if (recovered.toLowerCase() !== endpoint.inboxIdentityAddress.toLowerCase()) {
      throw new Error("Stealth inbox signer does not match the paired browser key");
    }
  }

  /**
   * Browser intents must expire, and must not cross deployments.
   *
   * The registry can only enforce the window — it does not know this
   * deployment's id or the request's origin. The HTTP/WS layer MUST compare
   * `deploymentId` and `origin` against its own before calling in, or a
   * signature produced against staging replays against production.
   */
  private assertBrowserIntentWindow(input: {
    issuedAt?: number;
    expiresAt?: number;
    deploymentId?: string;
    origin?: string;
  }, now = Date.now()) {
    const { issuedAt, expiresAt, deploymentId, origin } = input;
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number" || !deploymentId || !origin) {
      throw new Error("Browser stealth intent requires issuedAt, expiresAt, deploymentId and origin");
    }
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      throw new Error("Browser stealth intent window is not finite");
    }
    if (expiresAt <= issuedAt) throw new Error("Browser stealth intent expires before it was issued");
    if (expiresAt - issuedAt > PrivateAgentRegistry.BROWSER_INTENT_MAX_LIFETIME_MS) {
      throw new Error("Browser stealth intent window is too long");
    }
    if (Math.abs(issuedAt - now) > PrivateAgentRegistry.BROWSER_INTENT_MAX_SKEW_MS) {
      throw new Error("Browser stealth intent issuedAt is skewed");
    }
    if (expiresAt <= now) throw new Error("Browser stealth intent has expired");
    return { issuedAt, expiresAt, deploymentId, origin };
  }

  private assertVpnPeer(endpoint: PrivateAgentEndpoint, remoteIp: string) {
    if (remoteIp !== endpoint.vpnIp) {
      throw new Error(`VPN peer mismatch for ${endpoint.agentId}: expected ${endpoint.vpnIp}, got ${remoteIp}`);
    }
  }

  /**
   * The denomination ladder advertised for one network, or `undefined` when this
   * network has no payout policy. Single source of truth for both the quote's
   * embedded `payoutPolicy` and the standalone discovery route below, so the two
   * can never drift — a client that quantizes against a stale ladder produces a
   * plan the server hard-rejects.
   */
  private payoutAdvertisementFor(network: string): X402PaymentRequirements["payoutPolicy"] | undefined {
    if (!this.payout.enabled) return undefined;
    const payoutConfig = this.payout.byNetwork.get(network);
    if (!payoutConfig) return undefined;
    return {
      policyVersion: this.payout.policyVersion,
      denominationsAtomic: payoutConfig.denominationsAtomic.map(String),
      maxLegs: payoutConfig.maxLegs,
      maxHoldMsCeiling: this.payout.maxHoldMsCeiling ?? DEFAULT_POOL_PAYOUT_MAX_HOLD_MS,
    };
  }

  /**
   * Denomination-policy discovery (spec-exit-rounds.md §3.1). An agent must know
   * the ladder BEFORE it asks for a quote: `decomposePayout` silently falls back
   * to a `single` plan that publishes the EXACT withdrawal amount on-chain, and
   * the fallback cannot be repaired afterwards because `validatePlanAgainstPolicy`
   * pins the plan total to the quoted total. So the ladder has to reach the client
   * one step earlier than the quote that embeds it.
   *
   * Gated by WireGuard MEMBERSHIP only — deliberately NOT `requireEndpoint` +
   * `assertVpnPeer` on a caller-supplied agent id. Those throw
   * `Unknown private agent endpoint: <id>` and
   * `VPN peer mismatch for <id>: expected <vpnIp>, got <remoteIp>`, and the private
   * RPC returns `error.message` verbatim — which would turn this into an
   * agent-existence AND agent-IP oracle. The advertisement is per-network and
   * identical for every peer, so it needs no agent id at all.
   */
  payoutPolicyAdvertisement(network: string, remoteIp: string): {
    network: string;
    policy: NonNullable<X402PaymentRequirements["payoutPolicy"]> | null;
  } {
    this.assertVpnMember(remoteIp);
    const resolved = resolveX402Network(network).network;
    return { network: resolved, policy: this.payoutAdvertisementFor(resolved) ?? null };
  }

  private assertVpnMember(remoteIp: string) {
    if (![...this.endpoints.values()].some((endpoint) => endpoint.vpnIp === remoteIp)) {
      throw new Error(`Unregistered VPN peer: ${remoteIp}`);
    }
  }

  private assertAgentIntent(
    endpoint: PrivateAgentEndpoint,
    signature: string,
    message: string,
    force = false,
  ) {
    if (!force && !this.requireIdentitySignatures) return;
    if (!endpoint.identityAddress) throw new Error(`Identity signing is not configured for ${endpoint.agentId}`);
    if (!signature) throw new Error("Agent intent signature required");
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw new Error("Agent intent signature invalid");
    }
    if (recovered.toLowerCase() !== endpoint.identityAddress.toLowerCase()) {
      throw new Error("Agent intent signer does not match registered identity");
    }
  }

  private assertSignature(endpoint: PrivateAgentEndpoint, payload: string, signature: string) {
    const expected = createHmac("sha256", endpoint.sharedSecret).update(payload).digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const actualBuffer = Buffer.from(signature, "hex");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new Error("Agent intent signature rejected");
    }
  }

  private addInventory(inventory: InventoryItem[], item: InventoryItem, quantity: number) {
    const owned = inventory.find((entry) => entry.id === item.id);
    if (owned) owned.quantity += quantity;
    else inventory.push({ ...item, quantity });
  }
}

const normalizePrivateCaller = (caller: PrivateCaller): PrivateCallerContext =>
  typeof caller === "string" ? { channel: "wireguard", remoteIp: caller } : caller;

/**
 * Fisher-Yates. Used only to scramble the ORDER of a refresh burst so the
 * sequence of `balanceOf` calls does not hand the RPC provider the records'
 * relative age on top of the fact that they were queried together.
 */
const shuffled = <T>(values: T[]): T[] => {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
};

/**
 * A pool payout is a TRANSPARENT settlement: a plain-token transfer from the shared
 * treasury whose amount is public on chain. A `confidential` quote exists precisely to
 * keep that amount hidden, and it still carries a real `maxAmountRequired` and
 * `stealthMetaAddress` — so without this check a payer could take a confidential quote
 * and settle it down the pool path, publishing the amount the payee demanded be hidden,
 * burning the reserved confidential slot, and silently downgrading the scheme.
 *
 * `payX402` already routes by the QUOTE's scheme rather than the payload's for exactly
 * this reason. The pool payout paths were the asymmetry: they resolved a quote by nonce
 * and never looked at its scheme. The v2 path rejected a confidential quote only
 * incidentally, because such a quote carries no denomination policy — an accident, not
 * a guard, and one that a future policy change would silently remove.
 */
const POOL_PAYOUT_QUOTE_SCHEMES: ReadonlySet<string> = new Set([
  // The transparent x402 scheme, and the private-ledger requirements scheme. Both
  // already accept that the on-chain amount is public.
  "exact",
  PRIVATE_LEDGER_SCHEME,
]);

const assertPoolPayoutQuoteScheme = (requirements: unknown): void => {
  const scheme = (requirements as { scheme?: string } | undefined)?.scheme;
  if (scheme === undefined) return;
  // An ALLOW-list, not a deny-list on `confidential`. Today those are the same set,
  // but any future scheme whose point is to hide something would be silently
  // downgraded by a deny-list the day it is added. Unknown schemes fail closed.
  if (!POOL_PAYOUT_QUOTE_SCHEMES.has(scheme)) {
    throw new Error(`Pool payout refuses a ${scheme} quote; the pool path publishes the amount`);
  }
};

const sha256 = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}`;
const canonicalJson = (value: unknown) => JSON.stringify(value);
const isSolanaPayment = (payment: X402PaymentPayload | SolanaX402PaymentPayload): payment is SolanaX402PaymentPayload =>
  "transaction" in payment;

/**
 * A confidential payload, recognised by `transactions` (plural).
 *
 * Only used to route the NONCE lookup — the settle decision is made from the
 * QUOTE's scheme, never from this, because a payload-driven choice would let a
 * payer downgrade a confidential quote and publish the amount.
 */
const isConfidentialPayload = (payment: unknown): boolean =>
  typeof payment === "object" && payment !== null
  && Array.isArray((payment as { transactions?: unknown }).transactions);

export const parsePrivateAgentEndpoints = (json: string | undefined) => {
  if (!json) throw new Error("PX402_AGENT_ENDPOINTS is required when private agent RPC is enabled");
  const parsed = JSON.parse(json) as PrivateAgentEndpoint[];
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error("PX402_AGENT_ENDPOINTS must contain at least two agent endpoints");
  }
  return parsed;
};
