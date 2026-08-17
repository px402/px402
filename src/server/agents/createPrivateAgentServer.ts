import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentAcceptInput, AgentOfferInput, BlindVoucherIssueInput, BlindVoucherRedeemInput, ConfidentialSlotProvisionInput, PoolPayoutClaimInput, PoolPayoutInput, PoolPayoutV2Input, PrivateAgentRegistry, PrivateLedgerDepositConfig, PrivateLedgerDepositConfirmInput, PrivateLedgerDepositIntentInput, PrivateLedgerDepositRelayInput, StealthInboxInput, TokenTransferVerifier, X402PayInput, X402QuoteInput } from "./PrivateAgentRegistry";
import type { X402Facilitator } from "../base/X402Facilitator";
import type { SolanaX402Facilitator } from "../base/SolanaX402Facilitator";
import type { PrivatePaymentLedger } from "../payments/PrivatePaymentLedger";
import type { SettlementBatchCommitter } from "../base/PrivateBatchCommitter";
import { resolveX402Network, type X402TokenConfig } from "../../shared/x402";
import { privateLedgerAssetKey } from "../../shared/privateLedger";
import type { PoolPayoutQueue } from "../payments/PoolPayoutQueue";
import type { TransactionCoordinator } from "../base/TransactionCoordinator";
import type { BlindVoucherMint } from "../payments/BlindVoucherMint";

export interface PrivateLedgerServerDeposit {
  recipient: string;
  asset: string;
  verifier: TokenTransferVerifier;
}

interface PrivateAgentServerDeps {
  registry: PrivateAgentRegistry;
  facilitator?: X402Facilitator;
  // per-network facilitators ("base", "robinhood", ...). Falls back to
  // `facilitator` (as network "base") when absent, preserving old wiring.
  facilitators?: ReadonlyMap<string, X402SettlementFacilitator>;
  solanaFacilitator?: SolanaX402Facilitator;
  ledger?: PrivatePaymentLedger;
  settlementAdminToken?: string;
  deposits?: ReadonlyMap<string, PrivateLedgerServerDeposit>;
  deposit?: PrivateLedgerServerDeposit;
  batchCommitters?: ReadonlyMap<string, SettlementBatchCommitter>;
  batchCommitter?: SettlementBatchCommitter;
  payoutQueue?: PoolPayoutQueue;
  poolPayoutBatchingEnabled?: boolean;
  poolPayoutDenominationsEnabled?: boolean;
  coordinators?: ReadonlyMap<string, TransactionCoordinator>;
  mint?: BlindVoucherMint;
}

type X402SettlementFacilitator = X402Facilitator | SolanaX402Facilitator;

export const createPrivateAgentServer = ({ registry, facilitator, facilitators, solanaFacilitator, ledger, settlementAdminToken, deposits, deposit, batchCommitters, batchCommitter, payoutQueue, poolPayoutBatchingEnabled = false, poolPayoutDenominationsEnabled = false, coordinators, mint }: PrivateAgentServerDeps) => {
  const ledgerDeposits = withBaseFallback(deposits, deposit);
  const ledgerBatchCommitters = withBaseFallback(batchCommitters, batchCommitter);
  const depositVerifiers = new Map<string, PrivateLedgerDepositConfig>(
    [...ledgerDeposits].map(([network, configured]) => [network, {
      recipient: configured.recipient,
      asset: configured.asset,
      verifyTransfer: (proof) => configured.verifier.verifyErc20Transfer(proof),
    }]),
  );

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://agent-rpc");
      const remoteIp = normalizeRemoteIp(request.socket.remoteAddress ?? "");

      if (request.method === "GET" && url.pathname === "/private/health") {
        sendJson(response, 200, {
          status: "healthy",
          route: "wireguard-agent-rpc",
          endpoints: registry.redactedEndpoints()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/private/a2a/offers") {
        sendJson(response, 200, registry.openOffers());
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/offer") {
        const body = (await readJson(request)) as unknown as AgentOfferInput;
        const offer = registry.createOffer(body, remoteIp);
        sendJson(response, 201, { offer });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/accept") {
        const body = (await readJson(request)) as unknown as AgentAcceptInput;
        const receipt = registry.acceptOffer(body, remoteIp);
        sendJson(response, 201, { receipt });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/private/a2a/receipts" || url.pathname === "/private/a2a/x402-receipts")) {
        sendJson(response, 404, { error: "receipt_storage_disabled" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/private/a2a/mint-keys") {
        if (!mint) {
          sendJson(response, 503, { error: "blind voucher mint not configured" });
          return;
        }
        const network = url.searchParams.get("network") ?? "base";
        const resolved = resolveLedgerDeposit(network, ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private payment ledger not configured for network ${network}` });
          return;
        }
        sendJson(response, 200, registry.mintManifest(network, resolved.token, remoteIp));
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/voucher-issue") {
        if (!mint || !ledger) {
          sendJson(response, 503, { error: "blind voucher mint not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as BlindVoucherIssueInput;
        const resolved = resolveLedgerDeposit(body.network ?? "base", ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private payment ledger not configured for network ${body.network ?? "base"}` });
          return;
        }
        const result = await registry.issueBlindVouchers(
          body,
          remoteIp,
          resolved.token,
          Math.floor(Date.now() / 1000),
        );
        sendJson(response, 201, { result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/voucher-redeem") {
        if (!mint || !ledger) {
          sendJson(response, 503, { error: "blind voucher mint not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as BlindVoucherRedeemInput;
        const resolved = resolveLedgerDeposit(body.network ?? "base", ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private payment ledger not configured for network ${body.network ?? "base"}` });
          return;
        }
        const result = await registry.redeemBlindVouchers(
          body,
          remoteIp,
          resolved.token,
          Math.floor(Date.now() / 1000),
        );
        sendJson(response, 201, { result });
        return;
      }

      if (request.method === "GET" && url.pathname === "/private/a2a/balance") {
        const resolved = resolveLedgerDeposit(url.searchParams.get("network") ?? "base", ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private payment ledger not configured for network ${url.searchParams.get("network") ?? "base"}` });
          return;
        }
        sendJson(response, 200, registry.privateBalance(url.searchParams.get("agentId") ?? "", remoteIp, resolved.token));
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/private-quote") {
        if (!ledger) {
          sendJson(response, 503, { error: "private payment ledger not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as X402QuoteInput;
        const resolved = resolveLedgerDeposit(body.network ?? "base", ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private payment ledger not configured for network ${body.network ?? "base"}` });
          return;
        }
        const requirements = registry.quotePrivateLedger(body, remoteIp, resolved.token, Math.floor(Date.now() / 1000));
        sendJson(response, 201, { requirements });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/private-pay") {
        if (!ledger) {
          sendJson(response, 503, { error: "private payment ledger not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as import("../../shared/privateLedger").PrivateLedgerVoucher;
        const payment = await registry.payPrivateLedger(body, remoteIp, Math.floor(Date.now() / 1000));
        sendJson(response, 201, { payment });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/pool-payout") {
        if (!ledger || !payoutQueue) {
          sendJson(response, 503, { error: "pool payout queue not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as PoolPayoutInput | PoolPayoutV2Input;
        const groupRef = "plan" in body ? body.plan.groupRef : body.quoteNonce;
        if (registry.poolPayoutRailAvailable(groupRef) === false) {
          sendJson(response, 503, { error: "pool payout rail not configured for quoted network" });
          return;
        }
        const receipt = await registry.enqueuePoolPayout(body, remoteIp, Math.floor(Date.now() / 1000));
        sendJson(response, 201, { receipt });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/pool-payout-claim") {
        if (!payoutQueue || (!poolPayoutBatchingEnabled && !poolPayoutDenominationsEnabled)) {
          sendJson(response, 503, { error: "pool payout batching not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as PoolPayoutClaimInput;
        const claim = await registry.claimPoolPayout(body, remoteIp);
        sendJson(response, 200, { claim });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/admin/pool-payout/resolve-leg") {
        if (!settlementAdminToken
          || request.headers.authorization !== `Bearer ${settlementAdminToken}`) {
          sendJson(response, 403, { error: "admin authorization required" });
          return;
        }
        if (!payoutQueue) {
          sendJson(response, 503, { error: "pool payout queue not configured" });
          return;
        }
        const body = await readJson(request) as unknown as Parameters<PoolPayoutQueue["resolvePoolPayoutLeg"]>[0];
        const result = await payoutQueue.resolvePoolPayoutLeg(body);
        sendJson(response, 200, { result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/admin/pool-payout/resolve-nonce") {
        if (!settlementAdminToken
          || request.headers.authorization !== `Bearer ${settlementAdminToken}`) {
          sendJson(response, 403, { error: "admin authorization required" });
          return;
        }
        const body = await readJson(request) as unknown as {
          network: string;
          resolution: Parameters<TransactionCoordinator["resolveQuarantine"]>[0];
        };
        const coordinator = coordinators?.get(body.network);
        if (!coordinator) {
          sendJson(response, 503, { error: `coordinator not configured for ${body.network}` });
          return;
        }
        const result = await coordinator.resolveQuarantine(body.resolution);
        sendJson(response, 200, { result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/deposit-intent") {
        if (!ledger) {
          sendJson(response, 503, { error: "private deposit escrow not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as PrivateLedgerDepositIntentInput;
        const resolved = resolveLedgerDeposit(body.network ?? "base", ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private deposit escrow not configured for network ${body.network ?? "base"}` });
          return;
        }
        const intent = await registry.createPrivateLedgerDepositIntent(
          body,
          remoteIp,
          resolved.deposit,
          Math.floor(Date.now() / 1000),
        );
        sendJson(response, 201, { intent });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/deposit-relay") {
        if (!ledger || ledgerDeposits.size === 0) {
          sendJson(response, 503, { error: "private deposit escrow not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as PrivateLedgerDepositRelayInput;
        const relay = await registry.relayPrivateLedgerDeposit(
          body,
          remoteIp,
          depositVerifiers,
          Math.floor(Date.now() / 1000),
        );
        sendJson(response, 201, { relay });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/slot-provision") {
        // §5.2-P, the settler half of the two-signature ceremony: the payee
        // builds and owner-signs the configure plan (only an owner may
        // configure a confidential account), we fund the rent and broadcast.
        const body = (await readJson(request)) as unknown as ConfidentialSlotProvisionInput;
        const result = await registry.provisionConfidentialSlots(body, remoteIp);
        sendJson(response, result.status === "provisioned" ? 201 : 409, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/private/a2a/slot-depth") {
        // Exhaustion is a liveness condition, and the correct response to it is
        // to refuse rather than reuse a slot — so an operator has to be able to
        // see it coming.
        const network = url.searchParams.get("network") ?? "solana";
        const depth = registry.confidentialSlotDepth(network);
        if (!depth) {
          sendJson(response, 503, { error: "confidential slot pool not configured" });
          return;
        }
        sendJson(response, 200, { network, ...depth });
        return;
      }

      if (request.method === "GET" && url.pathname === "/private/a2a/payout-policy") {
        // The denomination ladder, one step BEFORE the quote that embeds it. A
        // client must quantize its withdrawal to a tileable amount before asking
        // for a quote; afterwards is too late, because the plan total is pinned to
        // the quoted total. Takes no agentId on purpose (see
        // PrivateAgentRegistry.payoutPolicyAdvertisement).
        const network = url.searchParams.get("network") ?? "base";
        sendJson(response, 200, registry.payoutPolicyAdvertisement(network, remoteIp));
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/inbox") {
        const body = (await readJson(request)) as unknown as StealthInboxInput;
        const inbox = await registry.stealthInbox(body, remoteIp);
        sendJson(response, 200, { inbox });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/deposit-confirm") {
        if (!ledger || ledgerDeposits.size === 0) {
          sendJson(response, 503, { error: "private deposit escrow not configured" });
          return;
        }
        const body = (await readJson(request)) as unknown as PrivateLedgerDepositConfirmInput;
        const payment = await registry.confirmPrivateLedgerDeposit(body, remoteIp, depositVerifiers);
        sendJson(response, 201, { payment });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/settlement/batch") {
        if (!ledger || !settlementAdminToken || !bearerMatches(request, settlementAdminToken)) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        const body = await readJson(request);
        const requestedNetwork = String(body.network ?? "base");
        const resolved = resolveLedgerDeposit(requestedNetwork, ledgerDeposits);
        if (!resolved) {
          sendJson(response, 503, { error: `private payment ledger not configured for network ${requestedNetwork}` });
          return;
        }
        const tokenAddress = String(body.asset ?? resolved.deposit.asset);
        const assetKey = privateLedgerAssetKey(resolved.token.network, tokenAddress);
        let batch = ledger.unsettledBatch(assetKey) ?? await ledger.createSettlementBatch({
          assetKey,
          network: resolved.token.network,
          tokenAddress,
        });
        if (!batch) {
          sendJson(response, 200, { batch: null });
          return;
        }
        let status: "local-pending" | "chain-committed" = "local-pending";
        const committer = ledgerBatchCommitters.get(batch.network);
        if (committer) {
          const committed = await committer.commit(batch);
          batch = await ledger.markBatchCommitted(batch.id, committed.transactionHash);
          status = "chain-committed";
        }
        sendJson(response, 201, {
          batch: {
            id: batch.id,
            asset: batch.asset,
            network: batch.network,
            tokenAddress: batch.tokenAddress,
            merkleRoot: batch.merkleRoot,
            transferCount: batch.transferCount,
            createdAt: batch.createdAt,
            transactionHash: batch.transactionHash,
            status
          }
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/quote") {
        const body = (await readJson(request)) as unknown as X402QuoteInput;
        const quoteFacilitator = resolveFacilitator(body.network ?? "base", facilitators, facilitator, solanaFacilitator);
        if (!quoteFacilitator) {
          sendJson(response, 503, { error: `x402 facilitator not configured for network ${body.network ?? "base"}` });
          return;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        const requirements = await registry.quoteX402(body, remoteIp, quoteFacilitator.tokenConfig, nowSeconds);
        sendJson(response, 201, { requirements, mode: quoteFacilitator.mode });
        return;
      }

      if (request.method === "POST" && url.pathname === "/private/a2a/pay") {
        const body = (await readJson(request)) as unknown as X402PayInput;
        // The quote (resolved by the payment's nonce) decides the settlement
        // network — a payer cannot redirect settlement to a different chain.
        const quotedNetwork = registry.quotedNetworkForPayment(body);
        const payFacilitator = quotedNetwork
          ? resolveFacilitator(quotedNetwork, facilitators, facilitator, solanaFacilitator)
          : resolveFacilitator("base", facilitators, facilitator, solanaFacilitator);
        if (!payFacilitator) {
          sendJson(response, 503, { error: `x402 facilitator not configured for network ${quotedNetwork ?? "base"}` });
          return;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        const receipt = await registry.payX402(body, remoteIp, payFacilitator, nowSeconds);
        sendJson(response, 201, { receipt, mode: payFacilitator.mode });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "private_agent_rpc_rejected" });
    }
  });
};

const resolveFacilitator = (
  network: string,
  facilitators?: ReadonlyMap<string, X402SettlementFacilitator>,
  fallback?: X402Facilitator,
  solana?: SolanaX402Facilitator
): X402SettlementFacilitator | undefined => {
  if (facilitators) {
    const direct = facilitators.get(network);
    if (direct) return direct;
    // accept CAIP-2 aliases ("eip155:8453" -> the facilitator whose token matches)
    for (const candidate of facilitators.values()) {
      if (candidate.tokenConfig.caip2 === network) return candidate;
    }
  }
  if (network === "solana" || solana?.tokenConfig.caip2 === network) return solana;
  return network === "base" || fallback?.tokenConfig.network === network ? fallback : undefined;
};

const resolveLedgerDeposit = (
  network: string,
  deposits: ReadonlyMap<string, PrivateLedgerServerDeposit>,
): { deposit: PrivateLedgerServerDeposit; token: X402TokenConfig } | undefined => {
  const token = resolveX402Network(network);
  const configured = deposits.get(token.network);
  return configured
    ? { deposit: configured, token: { ...token, address: configured.asset } }
    : undefined;
};

const withBaseFallback = <T>(configured?: ReadonlyMap<string, T>, fallback?: T) => {
  const result = new Map(configured);
  if (fallback && !result.has("base")) result.set("base", fallback);
  return result;
};

const normalizeRemoteIp = (ip: string) => ip.replace(/^::ffff:/, "");

const readJson = (request: IncomingMessage) =>
  new Promise<Record<string, string | number>>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 250_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}") as Record<string, string | number>);
      } catch {
        reject(new Error("Invalid private agent JSON"));
      }
    });
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, payload: unknown) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
};

const bearerMatches = (request: IncomingMessage, expected: string) => request.headers.authorization === `Bearer ${expected}`;
