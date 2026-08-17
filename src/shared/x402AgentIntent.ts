import { resolveX402Network } from "./x402";
import type { X402PaymentPayload } from "./x402";
import type { SolanaX402PaymentPayload } from "./x402Solana";
import type { SolanaConfidentialPayload } from "./x402SolanaConfidential";
import type { PrivateLedgerRequirements } from "./privateLedger";

export interface X402QuoteIntent {
  payeeAgentId: string;
  payerAgentId: string;
  amountAtomic: string;
  resource: string;
  validForSeconds: number;
  // friendly settlement-network id ("base", "robinhood"); binds the quote to a
  // chain so a transport cannot silently move the charge elsewhere
  network: string;
  intentNonce: string;
  /**
   * Binds the payment SCHEME, for the same reason `network` binds the chain: an
   * unbound scheme is a downgrade attack. A transport that could rewrite
   * `confidential` to `exact` would publish the very amount the scheme exists to
   * hide, and the payee's signature would still verify.
   *
   * Omitted for `exact`, deliberately — every existing signature was produced
   * over a message without this field, and adding it unconditionally would
   * invalidate all of them. Absent and `"exact"` are the same request.
   */
  scheme?: X402QuoteScheme;
}

export type X402QuoteScheme = "exact" | "confidential";

/**
 * Canonical, human-readable EIP-191 messages signed by the stable agent
 * identity key. They never go on-chain: the signatures are verified only by
 * the private WireGuard RPC before a quote or payment is accepted.
 */
export const x402QuoteIntentMessage = (input: X402QuoteIntent) =>
  JSON.stringify({
    protocol: "px402-agent-intent/v1",
    action: "quote",
    payeeAgentId: input.payeeAgentId,
    payerAgentId: input.payerAgentId,
    amountAtomic: input.amountAtomic,
    resource: input.resource,
    validForSeconds: input.validForSeconds,
    network: input.network,
    intentNonce: input.intentNonce,
    // Key ORDER is part of the message, so this must stay last, and it must stay
    // absent for `exact` — a spread that emitted `scheme: undefined` would still
    // be dropped by JSON.stringify, but an explicit `"exact"` would change every
    // existing signature.
    ...(input.scheme === "confidential" ? { scheme: "confidential" } : {})
  });

export const x402PayIntentMessage = (input: {
  payerAgentId: string;
  payeeAgentId: string;
  payment: X402PaymentPayload | SolanaX402PaymentPayload | SolanaConfidentialPayload;
  requirementsNonce?: string;
}) => {
  // A confidential payload carries `transactions` (the multi-transaction plan)
  // and has no `authorization`, so it must be matched BEFORE the EVM fallback —
  // which would otherwise read `.authorization.from` off an object that has
  // none and throw before the signature is ever checked.
  if ("transactions" in input.payment) {
    if (!input.requirementsNonce) {
      throw new Error("Confidential x402 intent requires the quote nonce");
    }
    return JSON.stringify({
      protocol: "px402-agent-intent/v1",
      action: "pay",
      payerAgentId: input.payerAgentId,
      payeeAgentId: input.payeeAgentId,
      network: input.payment.network,
      asset: input.payment.asset,
      from: input.payment.payer,
      // The WHOLE ordered plan is bound. Signing only the first transaction
      // would leave the transfer itself — the last one — unauthenticated.
      transactions: input.payment.transactions,
      authorizationNonce: input.requirementsNonce,
      scheme: "confidential"
    });
  }
  if ("transaction" in input.payment) {
    if (!input.requirementsNonce) throw new Error("Solana x402 intent requires the quote nonce");
    return JSON.stringify({
      protocol: "px402-agent-intent/v1",
      action: "pay",
      payerAgentId: input.payerAgentId,
      payeeAgentId: input.payeeAgentId,
      network: input.payment.network,
      asset: input.payment.asset,
      from: input.payment.payer,
      transaction: input.payment.transaction,
      authorizationNonce: input.requirementsNonce
    });
  }
  return JSON.stringify({
    protocol: "px402-agent-intent/v1",
    action: "pay",
    payerAgentId: input.payerAgentId,
    payeeAgentId: input.payeeAgentId,
    network: input.payment.network,
    asset: input.payment.asset,
    from: input.payment.authorization.from,
    to: input.payment.authorization.to,
    value: input.payment.authorization.value,
    validAfter: input.payment.authorization.validAfter,
    validBefore: input.payment.authorization.validBefore,
    authorizationNonce: input.payment.authorization.nonce
  });
};

/**
 * The payee authorizing a confidential slot-provisioning batch (§5.2-P).
 *
 * Signed by the stable identity key, and it binds the ADDRESSES — not just a
 * count — because the server pays rent for every account in the batch. Without
 * the addresses bound, a transport could swap in a different set and have us
 * fund accounts for a payee that never asked.
 */
export const confidentialSlotProvisionIntentMessage = (input: {
  payeeAgentId: string;
  network: string;
  mint: string;
  stealthAddresses: string[];
  intentNonce: string;
}) => JSON.stringify({
  protocol: "px402-confidential-slots/v1",
  action: "provision",
  payeeAgentId: input.payeeAgentId,
  network: input.network,
  mint: input.mint,
  stealthAddresses: input.stealthAddresses,
  intentNonce: input.intentNonce
});

export const poolPayoutIntentMessage = (input: {
  payerAgentId: string;
  payeeAgentId: string;
  quoteNonce: string;
  ephemeralPubKeys: string[];
  network: string;
}) =>
  JSON.stringify({
    protocol: "px402-pool-payout/v1",
    action: "payout",
    payerAgentId: input.payerAgentId,
    payeeAgentId: input.payeeAgentId,
    quoteNonce: input.quoteNonce,
    ephemeralPubKeys: input.ephemeralPubKeys,
    network: input.network
  });

export const poolPayoutV2IntentMessage = (input: {
  payerAgentId: string;
  payeeAgentId: string;
  groupRef: string;
  network: string;
  asset: string;
  strategy: "single" | "denominations";
  policyVersion: string;
  quoteRequirementsHash: string;
  totalAtomic: string;
  onchainAtomic: string;
  offchainChangeAtomic: string;
  planHash: string;
  legs: { index: number; amountAtomic: string; ephemeralPubKey?: string }[];
}) => JSON.stringify({
  protocol: "px402-pool-payout/v2",
  action: "payout",
  payerAgentId: input.payerAgentId,
  payeeAgentId: input.payeeAgentId,
  groupRef: input.groupRef,
  network: input.network,
  asset: input.asset,
  strategy: input.strategy,
  policyVersion: input.policyVersion,
  quoteRequirementsHash: input.quoteRequirementsHash,
  totalAtomic: input.totalAtomic,
  onchainAtomic: input.onchainAtomic,
  offchainChangeAtomic: input.offchainChangeAtomic,
  planHash: input.planHash,
  legs: input.legs
});

export const poolPayoutClaimIntentMessage = (input: {
  payerAgentId: string;
  groupRef: string;
  intentNonce: string;
}) => JSON.stringify({
  protocol: "px402-pool-payout/v1",
  action: "claim",
  payerAgentId: input.payerAgentId,
  groupRef: input.groupRef,
  intentNonce: input.intentNonce
});

export const blindVoucherIssueIntentMessage = (input: {
  payerAgentId: string;
  network: string;
  keysetId: string;
  outputsFingerprint: string;
  totalAtomic: string;
  intentNonce: string;
}) => JSON.stringify({
  protocol: "px402-blind-voucher/v1",
  action: "issue",
  payerAgentId: input.payerAgentId,
  network: input.network,
  keysetId: input.keysetId,
  outputsFingerprint: input.outputsFingerprint,
  totalAtomic: input.totalAtomic,
  intentNonce: input.intentNonce,
});

export const privateLedgerVoucherIntentMessage = (input: {
  requirements: PrivateLedgerRequirements;
  authorizationNonce: string;
}) =>
  JSON.stringify({
    protocol: "px402-private-ledger/v1",
    action: "authorize-debit",
    ...input.requirements,
    authorizationNonce: input.authorizationNonce
  });

interface PrivateLedgerDepositIntentFields {
  agentId: string;
  fromAddress: string;
  amountAtomic: string;
  network: string;
  intentNonce: string;
}

/**
 * Base58 is case-sensitive, so lowercasing a Solana sender leaves the signed
 * intent failing to uniquely commit to the address it authorizes — the registry
 * stores Solana senders case-preserved while the message flattened them. EVM
 * senders stay lowercased, which is what existing signers already produce, so
 * only Solana signatures change shape.
 */
const depositIntentSender = (network: string, fromAddress: string) =>
  resolveX402Network(network).kind === "solana" ? fromAddress : fromAddress.toLowerCase();

export const privateLedgerDepositIntentMessage = (input: PrivateLedgerDepositIntentFields) => JSON.stringify({
  protocol: "px402-private-ledger/v1",
  action: "deposit-intent",
  agentId: input.agentId,
  fromAddress: depositIntentSender(input.network, input.fromAddress),
  amountAtomic: input.amountAtomic,
  network: input.network,
  intentNonce: input.intentNonce
});

/**
 * Pre-fix format that lowercased every sender. Accepted for ONE release on
 * Solana only, so in-flight clients are not broken by the binding fix above.
 * Remove once every Solana depositor has been upgraded.
 *
 * @deprecated
 */
export const legacyPrivateLedgerDepositIntentMessage = (input: PrivateLedgerDepositIntentFields) => JSON.stringify({
  protocol: "px402-private-ledger/v1",
  action: "deposit-intent",
  agentId: input.agentId,
  fromAddress: input.fromAddress.toLowerCase(),
  amountAtomic: input.amountAtomic,
  network: input.network,
  intentNonce: input.intentNonce
});

export const depositRelayIntentMessage = (input: {
  agentId: string;
  depositId: string;
  network: string;
  authorizationNonce: string;
}) => JSON.stringify({
  protocol: "px402-private-ledger/v1",
  action: "relay-deposit",
  agentId: input.agentId,
  depositId: input.depositId,
  network: input.network,
  // binds the signature to the exact authorization being relayed, so an
  // approval for one payload cannot be reused to broadcast another
  authorizationNonce: input.authorizationNonce.toLowerCase()
});

export const stealthInboxIntentMessage = (input: {
  agentId: string;
  network: string;
  intentNonce: string;
}) => JSON.stringify({
  protocol: "px402-stealth-inbox/v1",
  action: "inbox",
  agentId: input.agentId,
  network: input.network,
  intentNonce: input.intentNonce
});

/**
 * Browser-scoped stealth inbox intents.
 *
 * `stealthInboxIntentMessage` above stays exactly as it is — agents already sign
 * it and SI-1 requires the WireGuard path be byte-for-byte unchanged. But it is
 * unsuitable for a browser: it carries no timestamp, no expiry, and no
 * deployment or origin binding, so its only replay defence is the 10-minute
 * in-memory nonce map. Over WireGuard that is backed by peer-IP membership; from
 * a browser a captured signature would become a permanent inbox-read credential
 * the moment the nonce map evicts, and a signature produced against staging
 * would replay against production.
 *
 * So the browser signs a different message that binds `issuedAt`/`expiresAt`,
 * `deploymentId`, and `origin`. Verified in spec-stealth-inbox-phase4.md §6.13.
 */
export const stealthInboxBrowserIntentMessage = (input: {
  agentId: string;
  network: string;
  intentNonce: string;
  issuedAt: number;
  expiresAt: number;
  deploymentId: string;
  origin: string;
}) => JSON.stringify({
  protocol: "px402-stealth-inbox-browser/v1",
  action: "inbox",
  agentId: input.agentId,
  network: input.network,
  intentNonce: input.intentNonce,
  issuedAt: input.issuedAt,
  expiresAt: input.expiresAt,
  deploymentId: input.deploymentId,
  origin: input.origin
});

/**
 * Stage-1 pairing (4a). Signed by the NEW inbox key, which is what proves the
 * browser possesses it. `ticketId` binds the signature to the one admin-minted
 * ticket being consumed, so a captured pairing signature cannot be replayed
 * against a later ticket.
 *
 * `metaFingerprint` is null at stage 1: 4a binds a read credential only and does
 * not touch where money is sent. Stage 2 (4b-browser) supplies it, and binding
 * it there is what stops a transport swapping the meta-address.
 */
export const stealthInboxPairIntentMessage = (input: {
  agentId: string;
  network: string;
  inboxIdentityAddress: string;
  metaFingerprint: string | null;
  ticketId: string;
  intentNonce: string;
  issuedAt: number;
  expiresAt: number;
  deploymentId: string;
  origin: string;
}) => JSON.stringify({
  protocol: "px402-stealth-inbox-browser/v1",
  action: "pair",
  agentId: input.agentId,
  network: input.network,
  inboxIdentityAddress: input.inboxIdentityAddress.toLowerCase(),
  metaFingerprint: input.metaFingerprint,
  ticketId: input.ticketId,
  intentNonce: input.intentNonce,
  issuedAt: input.issuedAt,
  expiresAt: input.expiresAt,
  deploymentId: input.deploymentId,
  origin: input.origin
});

/**
 * Simulation-only inbound announcement (Tier 1 demo, §9). Signed by the inbox
 * key like every other browser operation, so the simulation surface is not a
 * weaker door into a paired agent.
 */
export const stealthInboxSimulateIntentMessage = (input: {
  agentId: string;
  network: string;
  amountAtomic: string;
  intentNonce: string;
  issuedAt: number;
  expiresAt: number;
  deploymentId: string;
  origin: string;
}) => JSON.stringify({
  protocol: "px402-stealth-inbox-browser/v1",
  action: "simulate-inbound",
  agentId: input.agentId,
  network: input.network,
  amountAtomic: input.amountAtomic,
  intentNonce: input.intentNonce,
  issuedAt: input.issuedAt,
  expiresAt: input.expiresAt,
  deploymentId: input.deploymentId,
  origin: input.origin
});

export const privateLedgerDepositConfirmMessage = (input: {
  agentId: string;
  depositId: string;
  transactionHash: string;
  network: string;
}) => JSON.stringify({
  protocol: "px402-private-ledger/v1",
  action: "confirm-deposit",
  agentId: input.agentId,
  depositId: input.depositId,
  transactionHash: input.transactionHash.toLowerCase(),
  network: input.network
});
