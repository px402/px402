import { randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "ethers";
import type {
  PublicStealthInbox,
  PublicStealthInboxEntry,
  StealthInboxEntryStatus,
  StealthInboxErrorCode,
} from "../../shared/protocol";
import { privateLedgerAssetKey } from "../../shared/privateLedger";
import type { StealthMetaAddress } from "../../shared/stealth";
import { resolveX402Network } from "../../shared/x402";
import {
  stealthInboxBrowserIntentMessage,
  stealthInboxPairIntentMessage,
  stealthInboxSimulateIntentMessage,
} from "../../shared/x402AgentIntent";
import type { StealthSimulationGate } from "../config";
import { StealthInboxPairingBook } from "../payments/StealthInboxPairingBook";
import type { ChainRail } from "../rails/ChainRail";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

/**
 * Everything the browser stealth inbox is allowed to do, and the only place the
 * rules live. The HTTP and WebSocket layers below this are deliberately dumb:
 * they parse a body, resolve an origin, call one method, and render whatever
 * opaque code comes back. Policy in two transports is policy that drifts.
 *
 * Phase 4a scope: subscribe, push, render. There is NO claim path here — no
 * prepare, no submit, no journal, no relay. `claimMode` is forced to "off" on
 * the wire regardless of configuration, because a panel that advertises a claim
 * button against a surface that does not exist is worse than one that does not.
 */

// ---------------------------------------------------------------------------
// The slice of PrivateAgentRegistry this gateway uses.
//
// Declared structurally rather than imported so this module compiles on its own
// and the cross-workstream seam fails LOUDLY at the single wiring site in
// index.ts instead of quietly here. Every field below is required: if the
// registry has not grown `anomaly` yet, that must be a compile error, not a
// panel that silently reports "no anomaly" for a drained output.
// ---------------------------------------------------------------------------

export type BrowserInboxScope = "stealth-inbox" | "stealth-inbox-pair" | "stealth-inbox-sim";

export interface BrowserInboxCaller {
  channel: "browser-inbox";
  scope: BrowserInboxScope;
}

export interface StealthInboxReadInput {
  agentId: string;
  network?: string;
  intentNonce: string;
  agentSignature: string;
  issuedAt: number;
  expiresAt: number;
  deploymentId: string;
  origin: string;
}

/**
 * `network` is REQUIRED here, unlike a read. The registry signs the simulate
 * intent over the caller's own field value, so an omitted network would produce
 * two different messages on the two sides of the check.
 */
export interface StealthInboxSimulateInput extends Omit<StealthInboxReadInput, "network"> {
  network: string;
  amountAtomic: string;
}

export interface StealthInboxRegistryEntry {
  id: string;
  network: string;
  asset: string;
  assetDecimals: number;
  stealthAddress: string;
  ephemeralPubKey: string;
  expectedAmountAtomic: string | null;
  observedAmountAtomic: string | null;
  observedAt: number | null;
  status: string;
  claimable: boolean;
  simulated: boolean;
  anomaly: "unexplained-drain" | null;
  createdAt: number;
}

export interface StealthInboxRegistry {
  stealthInbox(input: StealthInboxReadInput, caller: BrowserInboxCaller): Promise<{
    agentId: string;
    entries: StealthInboxRegistryEntry[];
    totalObservedAtomic: string;
  }>;
  /**
   * The book as it currently stands: no signature, no nonce, no RPC. Used ONLY
   * to build a push for a subscription that was already authorized, and the
   * registry documents it as not an authorization check. `stealthInbox` calls it
   * internally, so the authorized read and the push come out of exactly one
   * mapper — two mappers would let a pushed row drift from the same row after a
   * refresh (a missed `anomaly`, a different `claimable`), which is worse than
   * an error because nothing looks wrong.
   */
  stealthInboxSnapshot(agentId: string, network?: string): {
    agentId: string;
    entries: StealthInboxRegistryEntry[];
    totalObservedAtomic: string;
  };
  applyStealthInboxPairing(agentId: string, patch: {
    inboxIdentityAddress?: string;
    stealthMeta?: StealthMetaAddress;
    stealthViewingKey?: string;
  }): void;
  outstandingAnnouncementCount(agentId: string): number;
  hasEndpoint(agentId: string): boolean;
  endpointInboxIdentityAddress(agentId: string): string | undefined;
  onInboxChanged(listener: (agentId: string) => void): void;
  simulateInboundAnnouncement(
    input: StealthInboxSimulateInput,
    caller: BrowserInboxCaller,
    gate: StealthSimulationGate,
  ): Promise<StealthInboxRegistryEntry>;
}

/** Only the balance the panel header shows; entries come from the registry. */
export interface StealthInboxLedger {
  balance(agentId: string, assetKey: string): string;
}

export interface BrowserInboxGatewayDeps {
  registry: StealthInboxRegistry;
  ledger: StealthInboxLedger;
  pairings: StealthInboxPairingBook;
  rails: ReadonlyMap<string, ChainRail>;
  /** Path for the durable rate-limit buckets. */
  rateLimitFilePath: string;
  encryptionKey: string;
  adminToken?: string;
  deploymentId: string;
  ratePerMinute: number;
  pageSize: number;
  subscriptionTtlMs: number;
  simulationGate?: StealthSimulationGate;
  production: boolean;
}

export interface StealthInboxPairRequest {
  agentId: string;
  network?: string;
  inboxIdentityAddress: string;
  ticket: string;
  intentNonce: string;
  agentSignature: string;
  issuedAt: number;
  expiresAt: number;
}

export interface StealthInboxPairResult {
  agentId: string;
  inboxIdentityAddress: string;
  pairedAt: number;
}

export interface StealthInboxPush {
  socketKey: string;
  inbox: PublicStealthInbox;
}

/**
 * The only thing a browser ever learns about a failure.
 *
 * Unknown agent, unpaired agent, and bad signature all raise the SAME code, so
 * this channel cannot be used to test whether an agent exists. The real reason
 * goes to the server log beside a correlation id the operator can match up. The
 * private RPC's catch-all echoes `error.message`, and those messages carry agent
 * ids and WireGuard IPs; nothing here inherits that.
 */
export class StealthInboxFailure extends Error {
  readonly code: StealthInboxErrorCode;
  readonly correlationId: string;

  constructor(code: StealthInboxErrorCode, detail: string) {
    super(detail);
    this.name = "StealthInboxFailure";
    this.code = code;
    this.correlationId = randomBytes(6).toString("hex");
  }
}

interface StealthSubscription {
  socketKey: string;
  agentId: string;
  network?: string;
  expiresAt: number;
}

/**
 * Signed intents are short-lived; anything older is a replay attempt. Both
 * bounds match the registry's, deliberately: a stricter rule here would reject
 * requests the registry documents as valid and send an operator hunting for the
 * wrong policy. They compose, so a captured-but-unused signature can be worth up
 * to lifetime + skew — bounded further by the one-shot nonce on both sides.
 */
const MAX_INTENT_LIFETIME_MS = 300_000;
const CLOCK_SKEW_MS = 300_000;
/** Tier 1 only ever mints play money. */
const MAX_SIMULATED_AMOUNT_ATOMIC = 100_000_000n;
const AGENT_ID = /^[\w.:-]{1,64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_NONCE = /^(0x)?[0-9a-fA-F]{8,128}$/;

/**
 * Phase 4a holds a READ credential and nothing else, so no entry is claimable
 * and no claim route is mounted. When 4b lands this becomes the configured
 * claim mode and `claimable` starts passing through from the registry.
 */
const CLAIM_MODE_4A = "off" as const;

/**
 * Which rail a request that names no network is read against. Exported so the
 * client is told the same value the gateway resolves its balance and mode from
 * rather than assuming one.
 */
export const STEALTH_INBOX_DEFAULT_NETWORK = "base";

const ENTRY_STATUSES: readonly StealthInboxEntryStatus[] = [
  "announced",
  "observed",
  "sweeping",
  "swept",
  "dormant",
];

/**
 * Filler so an inbox frame's length does not reveal how many outputs an agent
 * has. WIRE CONTRACT: an entry whose `id` is the empty string is padding and
 * MUST be discarded by the client — a real record id is always `inbound-…`.
 */
const PADDING_ENTRY: Readonly<PublicStealthInboxEntry> = Object.freeze({
  id: "",
  network: "",
  asset: "",
  assetDecimals: 0,
  stealthAddress: "",
  ephemeralPubKey: "",
  expectedAmountAtomic: null,
  observedAmountAtomic: null,
  observedAt: null,
  status: "dormant" as StealthInboxEntryStatus,
  claimable: false,
  simulated: false,
  anomaly: null,
  createdAt: 0,
});

const isLoopbackHost = (host: string) =>
  host === "localhost"
  || host === "127.0.0.1"
  || host === "::1"
  || host === "[::1]"
  || host.startsWith("127.");

const originHost = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
};

export class BrowserInboxGateway {
  private readonly subscriptions = new Map<string, StealthSubscription>();
  private readonly subscriptionsByAgent = new Map<string, Set<string>>();
  private readonly listeners = new Set<(push: StealthInboxPush) => void>();
  private readonly limiter: DurableRateLimiter;
  /**
   * One-shot intent nonces, held here as well as in the registry. The registry's
   * map is the authority for the WireGuard path; duplicating it costs a few
   * bytes and means a browser replay is refused even if the browser branch of
   * the registry ever stops consuming.
   */
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly deps: BrowserInboxGatewayDeps) {
    if (!deps.deploymentId.trim()) {
      throw new Error("Browser stealth inbox requires a deployment id");
    }
    this.limiter = new DurableRateLimiter(
      deps.rateLimitFilePath,
      deps.encryptionKey,
      deps.ratePerMinute,
    );
    this.deps.registry.onInboxChanged((agentId) => this.handleInboxChanged(agentId));
  }

  get pairedCount(): number {
    return this.deps.pairings.count;
  }

  get simulationTier(): 0 | 1 {
    return this.deps.simulationGate ? 1 : 0;
  }

  get claimMode(): "off" | "agent" | "browser" {
    return CLAIM_MODE_4A;
  }

  /**
   * Re-apply every durable pairing to the in-memory endpoints. Must complete
   * before either listener binds, or the first request after a restart races an
   * endpoint that has not learned its inbox key yet.
   */
  async restore(): Promise<{ paired: number; skipped: string[] }> {
    await this.limiter.load();
    let paired = 0;
    const skipped: string[] = [];
    for (const record of this.deps.pairings.all()) {
      if (!this.deps.registry.hasEndpoint(record.agentId)) {
        // The endpoint list is configuration; it can legitimately shrink. The
        // record is kept so the pairing survives the endpoint coming back.
        skipped.push(record.agentId);
        continue;
      }
      this.deps.registry.applyStealthInboxPairing(record.agentId, {
        inboxIdentityAddress: record.inboxIdentityAddress,
      });
      paired += 1;
    }
    return { paired, skipped };
  }

  /**
   * Decide which origin a request is allowed to claim. Returns undefined when
   * the request must be refused outright.
   *
   * Production is strict same-origin. Development additionally accepts a
   * loopback page talking to a loopback server, because `npm run dev` serves the
   * client from Vite on :5173 while the API listens on :8787 — without this the
   * documented local runbook could not complete a single request.
   */
  resolveOrigin(requestOrigin: string | undefined, serverOrigin: string): string | undefined {
    if (!requestOrigin) return serverOrigin;
    if (requestOrigin === serverOrigin) return requestOrigin;
    if (this.deps.production) return undefined;
    return isLoopbackHost(originHost(requestOrigin)) && isLoopbackHost(originHost(serverOrigin))
      ? requestOrigin
      : undefined;
  }

  /**
   * Mint a one-time pairing ticket. The admin bearer is required
   * UNCONDITIONALLY — there is no self-service path, not even under the
   * simulation gate. A self-asserted agentId establishing its own credential is
   * the exact bug this surface exists to avoid, and an auth-optional branch is
   * forever.
   */
  async mintPairingTicket(input: {
    agentId: string;
    adminAuthorization: string | undefined;
    replace?: boolean;
  }): Promise<{ ticket: string; ticketId: string; expiresAt: number }> {
    if (!this.deps.adminToken) {
      throw this.reject("stealth_unavailable", "admin token is not configured");
    }
    if (!isBearerAuthorized(input.adminAuthorization, this.deps.adminToken)) {
      throw this.reject("stealth_unauthorized", "admin bearer rejected");
    }
    if (!AGENT_ID.test(input.agentId) || !this.deps.registry.hasEndpoint(input.agentId)) {
      // Same code as a bad bearer. The operator gets the real reason from the
      // log line; the wire keeps one rule with no exceptions to reason about.
      throw this.reject("stealth_unauthorized", `no endpoint for agent ${input.agentId}`);
    }
    return this.deps.pairings.issueTicket({
      agentId: input.agentId,
      allowReplace: input.replace ?? false,
    });
  }

  /**
   * Stage 1 pairing: bind an inbox READ key to an agent. Signing the pair intent
   * with that key is what proves the browser holds it; the admin ticket is what
   * decides the browser is allowed to hold it for THIS agent.
   */
  async pair(
    input: StealthInboxPairRequest,
    ctx: { tls: boolean; origin: string },
  ): Promise<StealthInboxPairResult> {
    this.assertAgentId(input.agentId);
    this.assertRate(input.agentId);
    if (!ctx.tls && !isLoopbackHost(originHost(ctx.origin))) {
      throw this.reject("stealth_unauthorized", "pairing refused over plaintext off-loopback");
    }
    if (!ADDRESS.test(input.inboxIdentityAddress)) {
      throw this.reject("stealth_unauthorized", "inbox identity address is malformed");
    }
    const ticketId = StealthInboxPairingBook.ticketIdOf(input.ticket);
    if (!ticketId) throw this.reject("stealth_unauthorized", "pairing ticket is malformed");

    this.assertIntentWindow(input.issuedAt, input.expiresAt);
    this.assertNonceUnused("stealth-inbox-pair", input.agentId, input.intentNonce, input.expiresAt);
    // Recovered against the address the request is asking us to bind, not
    // against a stored one: at stage 1 there is nothing stored yet, and
    // possession of the new key is exactly what has to be demonstrated.
    this.assertSignature(
      stealthInboxPairIntentMessage({
        agentId: input.agentId,
        network: input.network ?? "",
        inboxIdentityAddress: input.inboxIdentityAddress,
        metaFingerprint: null,
        ticketId,
        intentNonce: input.intentNonce,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        deploymentId: this.deps.deploymentId,
        origin: ctx.origin,
      }),
      input.agentSignature,
      input.inboxIdentityAddress,
    );

    const outcome = await this.deps.pairings.pair({
      ticket: input.ticket,
      agentId: input.agentId,
      inboxIdentityAddress: input.inboxIdentityAddress,
      announcementsOutstanding:
        this.deps.registry.outstandingAnnouncementCount(input.agentId) > 0,
    });
    if (!outcome.ok) {
      throw this.reject(
        outcome.reason === "already-paired" ? "stealth_conflict" : "stealth_unauthorized",
        `pairing refused for ${input.agentId}: ${outcome.reason}`,
      );
    }
    // Durable first, in-memory second: a crash between the two is repaired by
    // `restore()` on the next boot, whereas the reverse order would leave a
    // live credential with no record of it.
    this.deps.registry.applyStealthInboxPairing(input.agentId, {
      inboxIdentityAddress: outcome.record.inboxIdentityAddress,
    });
    return {
      agentId: outcome.record.agentId,
      inboxIdentityAddress: outcome.record.inboxIdentityAddress,
      pairedAt: outcome.record.pairedAt,
    };
  }

  /** Authorized read. Used by the no-WebSocket HTTP fallback. */
  async inbox(
    input: Omit<StealthInboxReadInput, "deploymentId" | "origin">,
    ctx: { origin: string },
  ): Promise<PublicStealthInbox> {
    const result = await this.authorizedRead(input, ctx, "stealth-inbox");
    return this.toPublicInbox({
      agentId: result.agentId,
      network: input.network,
      entries: result.entries.map((entry) => this.toPublicEntry(entry)),
      totalObservedAtomic: result.totalObservedAtomic,
      subscriptionExpiresAt: this.subscriptionExpiryFor(result.agentId),
    });
  }

  /**
   * Authorized read plus a push subscription for its TTL. The socket key only
   * ROUTES the push; it is never an authorization input, so a client that fully
   * impersonates another session still gets nothing without that session's
   * inbox key.
   */
  async subscribe(
    socketKey: string,
    input: Omit<StealthInboxReadInput, "deploymentId" | "origin">,
    ctx: { origin: string },
  ): Promise<PublicStealthInbox> {
    const result = await this.authorizedRead(input, ctx, "stealth-inbox");
    const expiresAt = Date.now() + this.deps.subscriptionTtlMs;
    this.unsubscribe(socketKey);
    const subscription: StealthSubscription = {
      socketKey,
      agentId: result.agentId,
      network: input.network,
      expiresAt,
    };
    this.subscriptions.set(socketKey, subscription);
    let keys = this.subscriptionsByAgent.get(result.agentId);
    if (!keys) {
      keys = new Set<string>();
      this.subscriptionsByAgent.set(result.agentId, keys);
    }
    keys.add(socketKey);
    return this.toPublicInbox({
      agentId: result.agentId,
      network: input.network,
      entries: result.entries.map((entry) => this.toPublicEntry(entry)),
      totalObservedAtomic: result.totalObservedAtomic,
      subscriptionExpiresAt: expiresAt,
    });
  }

  unsubscribe(socketKey: string): void {
    const subscription = this.subscriptions.get(socketKey);
    if (!subscription) return;
    this.subscriptions.delete(socketKey);
    const keys = this.subscriptionsByAgent.get(subscription.agentId);
    keys?.delete(socketKey);
    if (keys && keys.size === 0) this.subscriptionsByAgent.delete(subscription.agentId);
  }

  /** Drops subscriptions past their TTL. Cheap enough to run on the snapshot tick. */
  sweepSubscriptions(now = Date.now()): void {
    for (const [key, subscription] of [...this.subscriptions]) {
      if (subscription.expiresAt <= now) this.unsubscribe(key);
    }
    for (const [key, expiresAt] of [...this.usedNonces]) {
      if (expiresAt <= now) this.usedNonces.delete(key);
    }
  }

  /**
   * Tier 1 only: write a real announcement against the paired meta-address so
   * the panel, the transport, and the push can be exercised without a chain.
   * Requires the gate OBJECT — a boolean here would be one truthy value away
   * from minting announcements on a live deployment.
   */
  async simulateInbound(
    input: Omit<StealthInboxSimulateInput, "deploymentId" | "origin">,
    ctx: { origin: string },
  ): Promise<PublicStealthInboxEntry> {
    const gate = this.deps.simulationGate;
    if (!gate) {
      throw this.reject("stealth_simulation_unavailable", "simulation gate is closed");
    }
    this.assertAgentId(input.agentId);
    this.assertRate(input.agentId);
    if (!input.network) {
      throw this.reject("stealth_simulation_unavailable", "simulated inbound requires a network");
    }
    let amount: bigint;
    try {
      amount = BigInt(input.amountAtomic);
    } catch {
      throw this.reject("stealth_simulation_unavailable", "simulated amount is not an integer");
    }
    if (amount <= 0n || amount > MAX_SIMULATED_AMOUNT_ATOMIC) {
      throw this.reject("stealth_simulation_unavailable", "simulated amount out of range");
    }
    this.assertIntentWindow(input.issuedAt, input.expiresAt);
    this.assertNonceUnused("stealth-inbox-sim", input.agentId, input.intentNonce, input.expiresAt);
    this.assertSignature(
      stealthInboxSimulateIntentMessage({
        agentId: input.agentId,
        network: input.network,
        amountAtomic: input.amountAtomic,
        intentNonce: input.intentNonce,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        deploymentId: this.deps.deploymentId,
        origin: ctx.origin,
      }),
      input.agentSignature,
      this.pairedAddressOrReject(input.agentId),
    );
    const request: StealthInboxSimulateInput = {
      ...input,
      deploymentId: this.deps.deploymentId,
      origin: ctx.origin,
    };
    try {
      const entry = await this.deps.registry.simulateInboundAnnouncement(
        request,
        { channel: "browser-inbox", scope: "stealth-inbox-sim" },
        gate,
      );
      return this.toPublicEntry(entry);
    } catch (error) {
      throw this.reject("stealth_simulation_unavailable", describe(error));
    }
  }

  onInboxChanged(listener: (push: StealthInboxPush) => void): void {
    this.listeners.add(listener);
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
    this.subscriptionsByAgent.clear();
    this.listeners.clear();
    await this.limiter.close();
  }

  // -------------------------------------------------------------------------

  private async authorizedRead(
    input: Omit<StealthInboxReadInput, "deploymentId" | "origin">,
    ctx: { origin: string },
    scope: BrowserInboxScope,
  ) {
    this.assertAgentId(input.agentId);
    this.assertRate(input.agentId);
    this.assertIntentWindow(input.issuedAt, input.expiresAt);
    this.assertNonceUnused(scope, input.agentId, input.intentNonce, input.expiresAt);
    this.assertSignature(
      stealthInboxBrowserIntentMessage({
        agentId: input.agentId,
        network: input.network ?? "",
        intentNonce: input.intentNonce,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        deploymentId: this.deps.deploymentId,
        origin: ctx.origin,
      }),
      input.agentSignature,
      this.pairedAddressOrReject(input.agentId),
    );
    const request: StealthInboxReadInput = {
      ...input,
      deploymentId: this.deps.deploymentId,
      origin: ctx.origin,
    };
    try {
      return await this.deps.registry.stealthInbox(request, { channel: "browser-inbox", scope });
    } catch (error) {
      // The caller is already proven at this point, so a throw from here is an
      // internal fault (a dead RPC, a missing ledger) rather than an authorization
      // decision. Reporting it as `unauthorized` would send an operator hunting
      // for a key problem that does not exist.
      throw this.reject("stealth_unavailable", describe(error));
    }
  }

  /**
   * Build a push payload. No signature, because a server-side change event has
   * none to offer — the subscription was verified once at subscribe and its TTL
   * bounds it from there (SI-15).
   *
   * No RPC either, and that is a privacy GAIN rather than a shortcut: a refresh
   * fires up to N `balanceOf` calls for unrelated one-time addresses from one IP
   * in one burst — a clean clustering signal to the RPC provider, and precisely
   * what EIP-5564 exists to prevent (spec §13.3). Refreshing on every push would
   * turn a rare event into a continuous beacon. Refresh stays on the authorized
   * read and the registry's rotating background window.
   *
   * The entries come from the same registry mapper the authorized read uses, so
   * a pushed row cannot drift from the same row after a refresh.
   */
  private snapshotInbox(subscription: StealthSubscription): PublicStealthInbox {
    const snapshot = this.deps.registry.stealthInboxSnapshot(
      subscription.agentId,
      subscription.network,
    );
    return this.toPublicInbox({
      agentId: snapshot.agentId,
      network: subscription.network,
      entries: snapshot.entries.map((entry) => this.toPublicEntry(entry)),
      totalObservedAtomic: snapshot.totalObservedAtomic,
      subscriptionExpiresAt: subscription.expiresAt,
    });
  }

  private handleInboxChanged(agentId: string) {
    const keys = this.subscriptionsByAgent.get(agentId);
    if (!keys || keys.size === 0) return;
    const now = Date.now();
    for (const socketKey of [...keys]) {
      const subscription = this.subscriptions.get(socketKey);
      if (!subscription) {
        keys.delete(socketKey);
        continue;
      }
      if (subscription.expiresAt <= now) {
        this.unsubscribe(socketKey);
        continue;
      }
      let inbox: PublicStealthInbox;
      try {
        inbox = this.snapshotInbox(subscription);
      } catch (error) {
        console.warn(`STEALTH_INBOX_PUSH_FAILED agent=${agentId} ${describe(error)}`);
        continue;
      }
      for (const listener of this.listeners) listener({ socketKey, inbox });
    }
  }

  private toPublicInbox(input: {
    agentId: string;
    network?: string;
    entries: PublicStealthInboxEntry[];
    totalObservedAtomic: string;
    subscriptionExpiresAt: number;
  }): PublicStealthInbox {
    const networkId = this.resolveNetworkId(input.network ?? STEALTH_INBOX_DEFAULT_NETWORK);
    const rail = this.deps.rails.get(networkId);
    const assetKey = rail
      ? privateLedgerAssetKey(networkId, rail.tokenConfig.address)
      : privateLedgerAssetKey(networkId, "");
    return {
      agentId: input.agentId,
      ...(input.network === undefined ? {} : { network: input.network }),
      entries: this.padEntries(input.entries),
      page: 0,
      totalObservedAtomic: input.totalObservedAtomic,
      balanceAtomic: this.deps.ledger.balance(input.agentId, assetKey),
      balanceAsset: rail?.tokenConfig.address ?? "",
      balanceAssetDecimals: rail?.tokenConfig.decimals ?? 0,
      mode: this.deps.simulationGate
        ? "simulation"
        : rail?.settlementMode === "onchain"
          ? "onchain"
          : "dry-run",
      claimMode: CLAIM_MODE_4A,
      subscriptionExpiresAt: input.subscriptionExpiresAt,
      updatedAt: Date.now(),
    };
  }

  /**
   * Pad UP to a whole number of pages rather than truncating at one. Truncating
   * would hide real money from anyone holding more than a page of outputs; this
   * still coarsens the count to a page boundary, which is what the padding is
   * for.
   */
  private padEntries(entries: PublicStealthInboxEntry[]): PublicStealthInboxEntry[] {
    const pageSize = this.deps.pageSize;
    const pages = Math.max(1, Math.ceil(entries.length / pageSize));
    const padded = [...entries];
    while (padded.length < pages * pageSize) padded.push({ ...PADDING_ENTRY });
    return padded;
  }

  private toPublicEntry(entry: StealthInboxRegistryEntry): PublicStealthInboxEntry {
    return {
      id: entry.id,
      network: entry.network,
      asset: entry.asset,
      assetDecimals: entry.assetDecimals,
      stealthAddress: entry.stealthAddress,
      ephemeralPubKey: entry.ephemeralPubKey,
      expectedAmountAtomic: entry.expectedAmountAtomic,
      observedAmountAtomic: entry.observedAmountAtomic,
      observedAt: entry.observedAt,
      status: entryStatus(entry.status),
      claimable: CLAIM_MODE_4A === "off" ? false : entry.claimable,
      simulated: entry.simulated,
      anomaly: entry.anomaly,
      createdAt: entry.createdAt,
    };
  }

  private subscriptionExpiryFor(agentId: string): number {
    let latest = 0;
    for (const socketKey of this.subscriptionsByAgent.get(agentId) ?? []) {
      const subscription = this.subscriptions.get(socketKey);
      if (subscription && subscription.expiresAt > latest) latest = subscription.expiresAt;
    }
    return latest;
  }

  private resolveNetworkId(network: string): string {
    try {
      return resolveX402Network(network).network;
    } catch {
      throw this.reject("stealth_unavailable", `unknown network ${network}`);
    }
  }

  private pairedAddressOrReject(agentId: string): string {
    const address = this.deps.registry.endpointInboxIdentityAddress(agentId);
    if (!address) {
      // Unknown agent and unpaired agent are indistinguishable from here, which
      // is the point: neither reveals whether the agent exists.
      throw this.reject("stealth_unauthorized", `agent ${agentId} has no paired inbox key`);
    }
    return address;
  }

  private assertAgentId(agentId: string) {
    if (!AGENT_ID.test(agentId)) {
      throw this.reject("stealth_unauthorized", "agent id is malformed");
    }
  }

  /**
   * Charged BEFORE the signature check and keyed only by agent id, so a flood of
   * bad signatures cannot be told apart from a flood of good ones — a limiter
   * that only counts authorized requests is an agent-existence oracle.
   *
   * Accepted residual: someone who knows an agent id can exhaust that agent's
   * read budget. Pushes do not draw on the bucket, so a live panel keeps
   * updating while that is happening; only the poll-style fallback degrades.
   */
  private assertRate(agentId: string) {
    if (!this.limiter.consume(agentId)) {
      throw this.reject("stealth_rate_limited", `rate limit exhausted for ${agentId}`);
    }
  }

  private assertIntentWindow(issuedAt: number, expiresAt: number) {
    const now = Date.now();
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
      throw this.reject("stealth_unauthorized", "intent timestamps are not integers");
    }
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_INTENT_LIFETIME_MS) {
      throw this.reject("stealth_unauthorized", "intent lifetime out of bounds");
    }
    if (Math.abs(issuedAt - now) > CLOCK_SKEW_MS || expiresAt <= now) {
      throw this.reject("stealth_unauthorized", "intent is expired or skewed");
    }
  }

  private assertNonceUnused(
    scope: BrowserInboxScope,
    agentId: string,
    intentNonce: string,
    expiresAt: number,
  ) {
    if (!HEX_NONCE.test(intentNonce)) {
      throw this.reject("stealth_unauthorized", "intent nonce is malformed");
    }
    const key = `${scope}:${agentId}:${intentNonce.toLowerCase()}`;
    if (this.usedNonces.has(key)) {
      throw this.reject("stealth_unauthorized", "intent nonce already used");
    }
    this.usedNonces.set(key, expiresAt);
  }

  private assertSignature(message: string, signature: string, expectedAddress: string) {
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw this.reject("stealth_unauthorized", "intent signature is unrecoverable");
    }
    if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw this.reject("stealth_unauthorized", "intent signature recovered a different address");
    }
  }

  private reject(code: StealthInboxErrorCode, detail: string): StealthInboxFailure {
    const failure = new StealthInboxFailure(code, detail);
    console.warn(`STEALTH_INBOX_REJECTED code=${code} correlation=${failure.correlationId} ${detail}`);
    return failure;
  }
}

const entryStatus = (status: string): StealthInboxEntryStatus => {
  const match = ENTRY_STATUSES.find((candidate) => candidate === status);
  if (match) return match;
  console.warn(`STEALTH_INBOX_UNKNOWN_STATUS ${status}`);
  return "announced";
};

const describe = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

const isBearerAuthorized = (header: string | undefined, token: string) => {
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
};

interface RateBucketFile {
  version: 1;
  buckets: { agentId: string; tokens: number; updatedAt: number }[];
}

/**
 * Per-agent token bucket that survives a restart.
 *
 * Writes are coalesced rather than fsynced per request: the bucket refills
 * completely within a minute anyway, so paying a durability barrier per read
 * would buy at most a few seconds of accounting for a real cost on every
 * request. A graceful restart keeps the state; a hard kill can lose up to the
 * coalescing window. Stated rather than implied.
 */
class DurableRateLimiter {
  private static readonly MAX_TRACKED_AGENTS = 4096;
  private static readonly FLUSH_MS = 1000;
  private readonly file: EncryptedJsonFile<RateBucketFile>;
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private flushTimer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, encryptionKey: string, private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Stealth inbox rate limit must be an integer >= 1");
    }
    // Fails OPEN, unlike every other store here, and deliberately: this file
    // backs no value, so an unreadable one should cost an attacker their head
    // start on a bucket rather than cost everyone the server.
    this.file = new EncryptedJsonFile(filePath, encryptionKey, {
      failClosed: false,
      durable: false,
    });
  }

  async load(): Promise<void> {
    const stored = await this.file.read({ version: 1, buckets: [] });
    if (stored.version !== 1 || !Array.isArray(stored.buckets)) {
      throw new Error("Stealth inbox rate limit file is invalid");
    }
    for (const bucket of stored.buckets) {
      if (typeof bucket.agentId !== "string") continue;
      this.buckets.set(bucket.agentId, {
        tokens: Math.min(this.capacity, Math.max(0, Number(bucket.tokens) || 0)),
        updatedAt: Number(bucket.updatedAt) || 0,
      });
    }
  }

  consume(agentId: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(agentId) ?? this.track(agentId, now);
    if (!bucket) return false;
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed * this.capacity) / 60_000);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.schedule();
      return false;
    }
    bucket.tokens -= 1;
    this.schedule();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.writing;
    await this.flush();
  }

  /**
   * Bound the map so unknown agent ids cannot grow it without limit. A bucket at
   * full capacity carries no information, so evicting one is free; when every
   * bucket is mid-refill the request is refused rather than tracked.
   */
  private track(agentId: string, now: number) {
    if (this.buckets.size >= DurableRateLimiter.MAX_TRACKED_AGENTS) {
      for (const [key, bucket] of this.buckets) {
        const elapsed = Math.max(0, now - bucket.updatedAt);
        if (bucket.tokens + (elapsed * this.capacity) / 60_000 >= this.capacity) {
          this.buckets.delete(key);
        }
      }
      if (this.buckets.size >= DurableRateLimiter.MAX_TRACKED_AGENTS) return undefined;
    }
    const bucket = { tokens: this.capacity, updatedAt: now };
    this.buckets.set(agentId, bucket);
    return bucket;
  }

  private schedule() {
    if (this.closed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.writing = this.flush();
    }, DurableRateLimiter.FLUSH_MS);
    this.flushTimer.unref();
  }

  private async flush(): Promise<void> {
    const snapshot: RateBucketFile = {
      version: 1,
      buckets: [...this.buckets].map(([agentId, bucket]) => ({
        agentId,
        tokens: bucket.tokens,
        updatedAt: bucket.updatedAt,
      })),
    };
    try {
      await this.file.write(snapshot);
    } catch (error) {
      console.warn(`STEALTH_INBOX_RATE_PERSIST_FAILED ${describe(error)}`);
    }
  }
}
