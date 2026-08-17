import { getAddress } from "ethers";
import type { PublicKey } from "@solana/web3.js";
import { nextPayerWallet, type PayerPool } from "./payerRotation";
import { nextSolanaPayerKeypair, type SolanaPayerPool } from "./payerRotationSolana";
import { deriveStealthAddress, type StealthDerivation } from "./stealth";
import { deriveSolanaStealthAddress, type SolanaStealthDerivation } from "./stealthSolana";
import { createPaymentPayload, randomNonce, resolveX402Network, type X402PaymentPayload, type X402PaymentRequirements } from "./x402";
import { createSolanaPaymentPayload, type SolanaPaymentBuildConnection, type SolanaX402PaymentPayload, type SolanaX402PaymentRequirements } from "./x402Solana";
import { poolPayoutClaimIntentMessage, poolPayoutIntentMessage, poolPayoutV2IntentMessage, x402PayIntentMessage, x402QuoteIntentMessage } from "./x402AgentIntent";
import { privateLedgerDepositConfirmMessage, privateLedgerDepositIntentMessage, privateLedgerVoucherIntentMessage } from "./x402AgentIntent";
import type { PrivateLedgerPaymentAccepted, PrivateLedgerRequirements, PrivateLedgerVoucher } from "./privateLedger";
import { decomposePayout, largestTileableAtMost, type DenominationConfig } from "./denominations";
import { computePlanHash, computeQuoteRequirementsHash, type PayoutGroupPlan } from "./payoutPlan";

export interface AgentIdentitySigner {
  signMessage(message: string): Promise<string>;
}

export interface PrivateX402QuoteRequest {
  rpcUrl: string;
  payeeAgentId: string;
  payerAgentId: string;
  amountAtomic: string;
  resource: string;
  validForSeconds?: number;
  // settlement network ("base" default, "robinhood", or CAIP-2 alias)
  network?: string;
  identitySigner: AgentIdentitySigner;
}

export interface PreparedRotatingX402Payment {
  payment: X402PaymentPayload;
  ephemeralPubKey?: string;
  payerAddress: string;
  payerIndex: number;
  nextPayerPool: PayerPool;
  requirements: X402PaymentRequirements;
  stealth?: StealthDerivation;
}

export interface PreparedRotatingSolanaX402Payment {
  payment: SolanaX402PaymentPayload;
  requirementsNonce: string;
  ephemeralPubKey?: string;
  payerAddress: string;
  payerIndex: number;
  nextPayerPool: SolanaPayerPool;
  requirements: SolanaX402PaymentRequirements;
  stealth?: SolanaStealthDerivation;
}

export interface PrivateX402SettlementResponse {
  mode: "dry-run" | "onchain";
  receipt: {
    route: "wireguard-x402";
    settlement: {
      settlement: "dry-run" | "onchain";
      transactionHash?: string;
      from: string;
      to: string;
      value: string;
    };
  };
}

export interface PrivateLedgerSettlementResponse {
  payment: PrivateLedgerPaymentAccepted;
}

export interface PrivateLedgerDepositIntentResponse {
  intent: {
    depositId: string;
    network: string;
    asset: string;
    recipient: string;
    amountAtomic: string;
    validBefore: number;
  };
}

export interface PreparedPoolPayout {
  payerAgentId: string;
  payeeAgentId: string;
  quoteNonce: string;
  ephemeralPubKeys?: string[];
  agentSignature: string;
}

export interface PreparedPoolPayoutV2 {
  payerAgentId: string;
  payeeAgentId: string;
  plan: PayoutGroupPlan;
  agentSignature: string;
}

export interface PoolPayoutResponse {
  receipt: PoolPayoutReceipt | QueuedGroupReceipt | PoolPayoutAck;
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

export interface QueuedGroupReceipt {
  kind: "pool-payout-queued";
  groupRef: string;
  network: string;
  strategy: "single" | "denominations";
  legs: { index: number; recipient: string; amountAtomic: string; ephemeralPubKey?: string }[];
  offchainChangeAtomic: string;
  state: "queued";
  payerBalanceAtomic: string;
  estimatedSubmitBeforeMs: number;
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

export interface PayoutGroupClaim {
  groupRef: string;
  groupState: "queued" | "in-flight" | "settled" | "partial" | "failed" | "uncertain" | "unknown";
  network?: string;
  legs: {
    index: number;
    state: "queued" | "broadcasting" | "settled" | "failed" | "uncertain";
    chainStatus?: "included" | "finalized";
    mode?: "dry-run" | "onchain";
    transactionHash?: string;
    recipient?: string;
    amountAtomic?: string;
    terminalAt?: number;
  }[];
  offchainChange: null;
}

/** Call this from the receiving agent's WireGuard peer. */
export const requestPrivateX402Quote = async (
  input: PrivateX402QuoteRequest
): Promise<X402PaymentRequirements | SolanaX402PaymentRequirements> => {
  const validForSeconds = input.validForSeconds ?? 600;
  // normalize CAIP-2 aliases to the friendly id the server signs/verifies with
  const network = resolveX402Network(input.network ?? "base").network;
  const intentNonce = randomNonce();
  const agentSignature = await input.identitySigner.signMessage(x402QuoteIntentMessage({
    payeeAgentId: input.payeeAgentId,
    payerAgentId: input.payerAgentId,
    amountAtomic: input.amountAtomic,
    resource: input.resource,
    validForSeconds,
    network,
    intentNonce
  }));
  const response = await postJson<{ requirements?: X402PaymentRequirements | SolanaX402PaymentRequirements }>(input.rpcUrl, "/private/a2a/quote", {
    payeeAgentId: input.payeeAgentId,
    payerAgentId: input.payerAgentId,
    amountAtomic: input.amountAtomic,
    resource: input.resource,
    validForSeconds,
    network,
    intentNonce,
    agentSignature
  });
  if (!response.requirements) throw new Error("Private x402 quote response is missing requirements");
  return response.requirements;
};

/** Request a private, off-chain voucher instead of an immediate Base transfer. */
export const requestPrivateLedgerQuote = async (input: PrivateX402QuoteRequest): Promise<PrivateLedgerRequirements> => {
  const validForSeconds = input.validForSeconds ?? 600;
  const network = resolveX402Network(input.network ?? "base").network;
  const intentNonce = randomNonce();
  const agentSignature = await input.identitySigner.signMessage(x402QuoteIntentMessage({
    payeeAgentId: input.payeeAgentId,
    payerAgentId: input.payerAgentId,
    amountAtomic: input.amountAtomic,
    resource: input.resource,
    validForSeconds,
    network,
    intentNonce
  }));
  const response = await postJson<{ requirements?: PrivateLedgerRequirements }>(input.rpcUrl, "/private/a2a/private-quote", {
    payeeAgentId: input.payeeAgentId,
    payerAgentId: input.payerAgentId,
    amountAtomic: input.amountAtomic,
    resource: input.resource,
    validForSeconds,
    network,
    intentNonce,
    agentSignature
  });
  if (!response.requirements) throw new Error("Private ledger quote response is missing requirements");
  return response.requirements;
};

export const preparePrivateLedgerVoucher = async (input: {
  requirements: PrivateLedgerRequirements;
  identitySigner: AgentIdentitySigner;
}): Promise<PrivateLedgerVoucher> => {
  const authorizationNonce = randomNonce();
  return {
    requirements: input.requirements,
    authorizationNonce,
    agentSignature: await input.identitySigner.signMessage(privateLedgerVoucherIntentMessage({
      requirements: input.requirements,
      authorizationNonce
    }))
  };
};

export const preparePoolPayout = async (input: {
  requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
  identitySigner: AgentIdentitySigner;
  payerAgentId: string;
  payeeAgentId: string;
  network: string;
  /**
   * Optional client-declared release cap (spec-payout-concentration.md §5). Bound
   * into the signed plan; must not exceed the quote's disclosed ceiling. Omit to
   * accept the server default.
   */
  maxHoldMs?: number;
  /**
   * Called when this payout will publish its EXACT value on-chain — i.e. the
   * quoted total did not tile into standard denominations and `decomposePayout`
   * fell back to a `single` plan, whose leg carries `denominationAtomic: null` and
   * therefore has an anonymity set of one by construction.
   *
   * Opt-in, and deliberately not a `console.warn`: this module has no console
   * statements, and several callers are proof scripts whose output is read as
   * evidence. Nothing can be repaired at this point either — the plan total is
   * pinned to the quoted total — so this reports a decision already made. To
   * AVOID the leak, quantize before quoting with `quantizeWithdrawal`.
   */
  onExactLeg?: (info: { network: string; totalAtomic: string; reason: "not-tileable" }) => void;
}): Promise<PreparedPoolPayout | PreparedPoolPayoutV2> => {
  const network = resolveX402Network(input.network).network;
  const requirementsNetwork = resolveX402Network(input.requirements.network).network;
  if (network !== requirementsNetwork) {
    throw new Error(`Pool payout network ${network} does not match quote network ${requirementsNetwork}`);
  }
  // Defense in depth: the server must not attach a ladder to a confidential quote
  // and no longer does, but the client must not build a denomination plan from one
  // even if a server did. The confidential scheme settles through its own proof
  // path; a payout plan there is meaningless. Structural types let the two mix at
  // compile time, so this is checked at runtime.
  const scheme = (input.requirements as { scheme?: string }).scheme;
  if (scheme === "confidential" && input.requirements.payoutPolicy) {
    throw new Error("Confidential quote must not carry a pool-payout denomination policy");
  }
  if (scheme !== "confidential"
    && input.requirements.payoutPolicy
    && input.requirements.stealthMetaAddress) {
    const policy = denominationConfigFromAdvertisement(input.requirements.payoutPolicy);
    if (input.maxHoldMs !== undefined) {
      const ceiling = input.requirements.payoutPolicy.maxHoldMsCeiling;
      if (!Number.isInteger(input.maxHoldMs) || input.maxHoldMs <= 0) {
        throw new Error("Pool payout maxHoldMs must be a positive integer");
      }
      if (ceiling !== undefined && input.maxHoldMs > ceiling) {
        throw new Error("Pool payout maxHoldMs exceeds the quote's disclosed ceiling");
      }
    }
    const shape = decomposePayout({
      totalAtomic: input.requirements.maxAmountRequired,
      config: policy
    });
    if (shape.strategy === "single") {
      input.onExactLeg?.({
        network,
        totalAtomic: input.requirements.maxAmountRequired,
        reason: "not-tileable",
      });
    }
    const usedAnnouncements = new Set<string>();
    const legs = shape.legs.map((leg, index) => {
      let derivation: StealthDerivation | SolanaStealthDerivation | undefined;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = "x402Version" in input.requirements
          ? deriveSolanaStealthAddress(input.requirements.stealthMetaAddress!)
          : deriveStealthAddress(input.requirements.stealthMetaAddress!);
        if (!usedAnnouncements.has(candidate.ephemeralPubKey)) {
          derivation = candidate;
          usedAnnouncements.add(candidate.ephemeralPubKey);
          break;
        }
      }
      if (!derivation) throw new Error("Unable to derive a distinct stealth announcement for each payout leg");
      return {
        ...leg,
        index,
        payoutRef: shape.strategy === "single"
          ? input.requirements.nonce
          : `${input.requirements.nonce}:${index}`,
        recipient: derivation.stealthAddress,
        stealthAddress: derivation.stealthAddress,
        ephemeralPubKey: derivation.ephemeralPubKey
      };
    });
    const body: Omit<PayoutGroupPlan, "planHash"> = {
      version: 2,
      groupRef: input.requirements.nonce,
      network,
      asset: input.requirements.asset,
      strategy: shape.strategy,
      policyVersion: shape.strategy === "single"
        ? "none"
        : input.requirements.payoutPolicy.policyVersion,
      quoteRequirementsHash: computeQuoteRequirementsHash(input.requirements),
      totalAtomic: shape.totalAtomic,
      onchainAtomic: shape.onchainAtomic,
      offchainChangeAtomic: shape.offchainChangeAtomic,
      legs,
      // Additive: only carry the key when a cap is declared, so a plan without one
      // keeps its exact prior shape and hash.
      ...(input.maxHoldMs !== undefined ? { maxHoldMs: input.maxHoldMs } : {})
    };
    const plan: PayoutGroupPlan = { ...body, planHash: computePlanHash(body) };
    return {
      payerAgentId: input.payerAgentId,
      payeeAgentId: input.payeeAgentId,
      plan,
      agentSignature: await input.identitySigner.signMessage(poolPayoutV2IntentMessage({
        payerAgentId: input.payerAgentId,
        payeeAgentId: input.payeeAgentId,
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
        legs: plan.legs.map((leg) => ({
          index: leg.index,
          amountAtomic: leg.amountAtomic,
          ephemeralPubKey: leg.ephemeralPubKey
        }))
      }))
    };
  }
  const stealth = input.requirements.stealthMetaAddress
    ? "x402Version" in input.requirements
      ? deriveSolanaStealthAddress(input.requirements.stealthMetaAddress)
      : deriveStealthAddress(input.requirements.stealthMetaAddress)
    : undefined;
  const prepared = {
    payerAgentId: input.payerAgentId,
    payeeAgentId: input.payeeAgentId,
    quoteNonce: input.requirements.nonce,
    ephemeralPubKeys: stealth ? [stealth.ephemeralPubKey] : []
  };
  return {
    ...prepared,
    agentSignature: await input.identitySigner.signMessage(poolPayoutIntentMessage({
      ...prepared,
      network
    }))
  };
};

export const submitPoolPayout = (input: {
  rpcUrl: string;
  prepared: PreparedPoolPayout | PreparedPoolPayoutV2;
}) => postJson<PoolPayoutResponse>(input.rpcUrl, "/private/a2a/pool-payout", input.prepared);

export const claimPoolPayout = async (input: {
  rpcUrl: string;
  payerAgentId: string;
  groupRef: string;
  identitySigner: AgentIdentitySigner;
}) => {
  const intentNonce = randomNonce();
  const body = {
    payerAgentId: input.payerAgentId,
    groupRef: input.groupRef,
    intentNonce,
    agentSignature: await input.identitySigner.signMessage(poolPayoutClaimIntentMessage({
      payerAgentId: input.payerAgentId,
      groupRef: input.groupRef,
      intentNonce,
    })),
  };
  return postJson<{ claim: PayoutGroupClaim }>(
    input.rpcUrl,
    "/private/a2a/pool-payout-claim",
    body,
  );
};

export const submitPrivateLedgerVoucher = (input: { rpcUrl: string; voucher: PrivateLedgerVoucher }) =>
  postJson<PrivateLedgerSettlementResponse>(input.rpcUrl, "/private/a2a/private-pay", input.voucher);

/**
 * The response recipient may be a per-intent one-time address. The signed wire
 * shape is unchanged: callers pay exactly the returned recipient and later
 * confirm with the public transaction hash.
 */
export const requestPrivateLedgerDepositIntent = async (input: {
  rpcUrl: string;
  agentId: string;
  fromAddress: string;
  amountAtomic: string;
  network?: string;
  identitySigner: AgentIdentitySigner;
}) => {
  const network = resolveX402Network(input.network ?? "base").network;
  const intentNonce = randomNonce();
  const agentSignature = await input.identitySigner.signMessage(privateLedgerDepositIntentMessage({
    agentId: input.agentId,
    fromAddress: input.fromAddress,
    amountAtomic: input.amountAtomic,
    network,
    intentNonce
  }));
  return postJson<PrivateLedgerDepositIntentResponse>(
    input.rpcUrl,
    "/private/a2a/deposit-intent",
    { agentId: input.agentId, fromAddress: input.fromAddress, amountAtomic: input.amountAtomic, network, intentNonce, agentSignature }
  );
};

export const confirmPrivateLedgerDeposit = async (input: {
  rpcUrl: string;
  agentId: string;
  depositId: string;
  transactionHash: string;
  network?: string;
  identitySigner: AgentIdentitySigner;
}) => {
  const network = resolveX402Network(input.network ?? "base").network;
  const agentSignature = await input.identitySigner.signMessage(privateLedgerDepositConfirmMessage({ ...input, network }));
  return postJson<{ payment: { status: "credited"; commitment: string; balanceAtomic: string; acceptedAt: number } }>(
    input.rpcUrl,
    "/private/a2a/deposit-confirm",
    { agentId: input.agentId, depositId: input.depositId, transactionHash: input.transactionHash, network, agentSignature }
  );
};

/**
 * Payer-side preparation. Persist `nextPayerPool` before submitting the result
 * so a restart or retry can never reuse a fresh payer address.
 */
export const prepareRotatingX402Payment = async (input: {
  payerPool: PayerPool;
  requirements: X402PaymentRequirements;
  nowSeconds?: number;
}): Promise<PreparedRotatingX402Payment> => {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const next = nextPayerWallet(input.payerPool);
  const stealth = input.requirements.stealthMetaAddress
    ? deriveStealthAddress(input.requirements.stealthMetaAddress)
    : undefined;
  const requirements = stealth
    ? { ...input.requirements, payTo: stealth.stealthAddress }
    : input.requirements;
  // Sign under the settlement network's token domain. The quoted asset is
  // authoritative for the verifying contract (covers server-side overrides).
  const token = { ...resolveX402Network(requirements.network), address: requirements.asset };
  const payment = await createPaymentPayload({
    payerPrivateKey: next.wallet.privateKey,
    requirements,
    token,
    nowSeconds
  });

  return {
    payment,
    ephemeralPubKey: stealth?.ephemeralPubKey,
    payerAddress: getAddress(next.wallet.address),
    payerIndex: next.index,
    nextPayerPool: next.pool,
    requirements,
    stealth
  };
};

/** Persist `nextPayerPool` before submission so a Solana payer is never reused. */
export const prepareRotatingSolanaX402Payment = async (input: {
  payerPool: SolanaPayerPool;
  requirements: SolanaX402PaymentRequirements;
  settlerPubkey: PublicKey | string;
  connection: SolanaPaymentBuildConnection;
  nowSeconds?: number;
}): Promise<PreparedRotatingSolanaX402Payment> => {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const next = nextSolanaPayerKeypair(input.payerPool);
  const stealth = input.requirements.stealthMetaAddress
    ? deriveSolanaStealthAddress(input.requirements.stealthMetaAddress)
    : undefined;
  const requirements = stealth
    ? { ...input.requirements, payTo: stealth.stealthAddress }
    : input.requirements;
  const token = { ...resolveX402Network("solana"), address: requirements.asset };
  const payment = await createSolanaPaymentPayload({
    payerKeypair: next.keypair,
    requirements,
    settlerPubkey: input.settlerPubkey,
    connection: input.connection,
    token,
    nowSeconds
  });
  return {
    payment,
    requirementsNonce: input.requirements.nonce,
    ephemeralPubKey: stealth?.ephemeralPubKey,
    payerAddress: next.keypair.publicKey.toBase58(),
    payerIndex: next.index,
    nextPayerPool: next.pool,
    requirements,
    stealth
  };
};

/** Call this from the paying agent's WireGuard peer after persisting its index. */
export const submitPrivateX402Payment = (input: {
  rpcUrl: string;
  prepared: Pick<PreparedRotatingX402Payment, "payment" | "ephemeralPubKey">
    | Pick<PreparedRotatingSolanaX402Payment, "payment" | "ephemeralPubKey" | "requirementsNonce">;
  payerAgentId: string;
  payeeAgentId: string;
  identitySigner: AgentIdentitySigner;
}) =>
  input.identitySigner.signMessage(x402PayIntentMessage({
    payerAgentId: input.payerAgentId,
    payeeAgentId: input.payeeAgentId,
    payment: input.prepared.payment,
    requirementsNonce: "requirementsNonce" in input.prepared ? input.prepared.requirementsNonce : undefined
  })).then((agentSignature) => postJson<PrivateX402SettlementResponse>(input.rpcUrl, "/private/a2a/pay", {
    payment: input.prepared.payment,
    ephemeralPubKey: input.prepared.ephemeralPubKey,
    requirementsNonce: "requirementsNonce" in input.prepared ? input.prepared.requirementsNonce : undefined,
    agentSignature
  }));

const postJson = async <T>(rpcUrl: string, path: string, body: unknown): Promise<T> => {
  const response = await fetch(new URL(path, ensureTrailingSlash(rpcUrl)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const error = payload as { error?: string };
    throw new Error(error.error ?? `Private x402 request failed (${response.status})`);
  }
  return payload as T;
};

/**
 * Choose a withdrawal amount that will tile into standard denominations, BEFORE
 * asking for a quote (spec-exit-rounds.md §3.1).
 *
 * This must run pre-quote and cannot be retrofitted: `validatePlanAgainstPolicy`
 * requires the plan total to equal the quoted total, so a plan shrunk after the
 * fact is hard-rejected before any debit. Fetch the ladder from
 * `GET /private/a2a/payout-policy?network=<n>`, quantize, then quote for the
 * result. The remainder is not lost — it simply stays as ledger balance, which is
 * the same end state off-chain change would produce, without its accounting: the
 * residue is never debited, so the payout stays two-way and conservation on the
 * reversal path is untouched.
 *
 * `aboveCeiling` marks a request strictly greater than `maxLegs × max(denomination)`,
 * which no tiling can ever reach (denominations are repeatable, so that product is
 * genuinely the maximum reachable sum). A request EQUAL to the ceiling tiles as
 * `maxLegs` copies of the largest denomination and is not flagged. That is the ONLY
 * case a caller should consider refusing; refusing on ordinary nonzero residue
 * would reject essentially every real withdrawal, since exact tileability is rare
 * at fine granularity.
 */
export const quantizeWithdrawal = (input: {
  amountAtomic: string;
  policy: { denominationsAtomic: string[]; maxLegs: number };
}): {
  quantizedAtomic: string | null;
  residueAtomic: string;
  aboveCeiling: boolean;
  exact: boolean;
} => {
  const config = denominationConfigFromAdvertisement(input.policy);
  // Parse before BigInt(), so a malformed amount raises a domain error rather than
  // a bare SyntaxError from the coercion — matching decomposePayout's contract.
  if (!/^[1-9]\d*$/.test(input.amountAtomic)) {
    throw new Error("Withdrawal amount must be a positive integer string");
  }
  const requested = BigInt(input.amountAtomic);
  const largest = config.denominationsAtomic.reduce((a, b) => (a > b ? a : b), 0n);
  const aboveCeiling = requested > largest * BigInt(config.maxLegs);
  const quantizedAtomic = largestTileableAtMost({ totalAtomic: input.amountAtomic, config });
  return {
    quantizedAtomic,
    // Below the smallest denomination nothing tiles at all, so the whole request
    // is residue and the caller must decide whether to wait or accept the leak.
    residueAtomic: (requested - BigInt(quantizedAtomic ?? "0")).toString(),
    aboveCeiling,
    exact: quantizedAtomic !== null && BigInt(quantizedAtomic) === requested,
  };
};

const ensureTrailingSlash = (value: string) => (value.endsWith("/") ? value : `${value}/`);

const denominationConfigFromAdvertisement = (advertisement: {
  denominationsAtomic: string[];
  maxLegs: number;
}): DenominationConfig => {
  if (!Array.isArray(advertisement.denominationsAtomic) || advertisement.denominationsAtomic.length === 0) {
    throw new Error("Pool payout policy has no denominations");
  }
  const denominationsAtomic = advertisement.denominationsAtomic.map((value) => {
    if (!/^[1-9]\d*$/.test(value)) throw new Error("Pool payout policy contains an invalid denomination");
    return BigInt(value);
  });
  if (!Number.isSafeInteger(advertisement.maxLegs) || advertisement.maxLegs < 1) {
    throw new Error("Pool payout policy maxLegs must be an integer >= 1");
  }
  return { denominationsAtomic, maxLegs: advertisement.maxLegs };
};
