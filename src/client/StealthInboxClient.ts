import type { StealthInboxErrorCode } from "../shared/protocol";
import { generateStealthInboxIdentity, signStealthInboxMessage } from "../shared/stealthReceive";
import {
  stealthInboxBrowserIntentMessage,
  stealthInboxPairIntentMessage
} from "../shared/x402AgentIntent";
import {
  StealthInboxRequestError,
  stealthApiBase,
  type StealthInboxConfig
} from "./stealthInboxConfig";

/**
 * Browser side of the Phase 4a stealth inbox.
 *
 * This holds exactly ONE credential: a standalone random 32-byte
 * `inboxIdentityKey`. There is no seed, no spending key and no viewing key
 * anywhere in this module or anywhere else in the browser at 4a — the key can
 * enumerate the announcements owed to one paired agent and nothing else. If a
 * future change makes this file import `stealthReceiveKeysFromSeed`, the 4a/4b
 * split has been collapsed (spec-stealth-inbox-phase4.md §2, SI-34/SI-36).
 *
 * Two storage rules, both load-bearing:
 *
 * 1. The key lives in IndexedDB, never `localStorage`. `LocalStore` is plaintext
 *    `localStorage` and already holds a live agent control token, so one XSS
 *    would take both credentials at once. IndexedDB is not a defence against
 *    same-origin script execution — nothing is — but it does keep the key out of
 *    the `Local Storage/leveldb` file that commodity infostealers scrape.
 * 2. An inbox ENTRY is never persisted, cached, synced, backed up, or logged.
 *    `ephemeralPubKey` is what bounds retroactive de-anonymization: without `R`
 *    an attacker holding the spend/view keys still cannot test an arbitrary
 *    on-chain address for membership. That bound is fragile, so entries live in
 *    memory for the lifetime of the panel and are dropped on close. This class
 *    has no entry storage at all, which is the enforcement (SI-33).
 *
 * This module is reached only through a dynamic `import()` from the host
 * application, so the `@noble` curve and hash code it pulls in becomes its own
 * chunk instead of loading with the application shell. Anything imported here is paid for by the split chunk;
 * anything needed to decide whether to load it belongs in `stealthInboxConfig`.
 */

export type StealthInboxClientState = "initializing" | "absent" | "ready";

export interface StealthInboxPairing {
  agentId: string;
  network: string;
  pairedAt: number;
}

export interface StealthInboxSubscribePayload {
  agentId: string;
  network: string;
  intentNonce: string;
  issuedAt: number;
  expiresAt: number;
  agentSignature: string;
}

interface StoredInboxRecord {
  version: 1;
  inboxIdentityKey: string;
  inboxIdentityAddress: string;
  createdAt: number;
  pairing: StealthInboxPairing | null;
}

const DB_NAME = "px402";
const DB_VERSION = 1;
const STORE_NAME = "stealth-receive";
const RECORD_KEY = "v1";

/**
 * Intent lifetime in milliseconds, matching `Date.now()` and the rest of the
 * repo's timestamps. The server rejects anything longer than 300s.
 */
const INTENT_TTL_MS = 120_000;

const randomNonce = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
  });

const readRecord = async (): Promise<StoredInboxRecord | null> => {
  const db = await openDatabase();
  try {
    return await new Promise<StoredInboxRecord | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve((request.result as StoredInboxRecord | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
};

const writeRecord = async (record: StoredInboxRecord | null): Promise<void> => {
  const db = await openDatabase();
  try {
    // Resolve on transaction completion rather than request success, so a
    // caller that reports "paired" is reporting a durable write.
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      if (record) store.put(record, RECORD_KEY);
      else store.delete(RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
};

export class StealthInboxClient {
  private currentState: StealthInboxClientState = "initializing";
  private record: StoredInboxRecord | null = null;
  private loading?: Promise<StealthInboxClientState>;
  private lastFailure = "";

  /**
   * The config is fetched before this chunk is loaded — its presence is what
   * decided to load the chunk at all — so it arrives as a constructor argument
   * rather than being fetched again here.
   */
  constructor(private readonly currentConfig: StealthInboxConfig) {}

  get state(): StealthInboxClientState {
    return this.currentState;
  }

  get config(): StealthInboxConfig {
    return this.currentConfig;
  }

  get pairing(): StealthInboxPairing | null {
    return this.record?.pairing ?? null;
  }

  get identityAddress(): string | null {
    return this.record?.inboxIdentityAddress ?? null;
  }

  /** Last local (not server) failure, e.g. IndexedDB unavailable. */
  get failure(): string {
    return this.lastFailure;
  }

  /**
   * Idempotent. Called once at host-application start and awaited by nobody on
   * the render path — the UI renders `initializing` until this resolves and the
   * panel is safe to open mid-load.
   */
  load(): Promise<StealthInboxClientState> {
    if (!this.loading) this.loading = this.initialize();
    return this.loading;
  }

  private async initialize(): Promise<StealthInboxClientState> {
    try {
      this.record = await readRecord();
    } catch (error) {
      // No localStorage fallback: a private-mode browser without IndexedDB gets
      // an honest "unavailable", never a plaintext one.
      this.lastFailure = error instanceof Error ? error.message : "local key storage unavailable";
      this.record = null;
    }
    this.currentState = this.record ? "ready" : "absent";
    return this.currentState;
  }

  /** Mints the 4a read credential. No seed is generated, here or anywhere. */
  async create(): Promise<void> {
    if (this.record) return;
    const identity = generateStealthInboxIdentity();
    const record: StoredInboxRecord = {
      version: 1,
      inboxIdentityKey: identity.inboxIdentityKey,
      inboxIdentityAddress: identity.inboxIdentityAddress,
      createdAt: Date.now(),
      pairing: null
    };
    await writeRecord(record);
    this.record = record;
    this.currentState = "ready";
  }

  async sign(message: string): Promise<string> {
    const record = this.requireRecord();
    return signStealthInboxMessage(record.inboxIdentityKey, message);
  }

  /**
   * Stage 1 pairing. Binds this browser's read key to one agent using a ticket
   * the OPERATOR minted with the admin token — there is no self-service path,
   * because a self-asserted `agentId` establishing a credential is exactly the
   * hole the admin requirement closes.
   *
   * The ticket is expected as `<ticketId>.<secret>`: the signature has to bind
   * `ticketId` before the request is sent, so the browser must be able to read
   * it out of the one string the operator pastes. A ticket with no separator is
   * treated as its own id.
   */
  async pair(input: { agentId: string; network: string; ticket: string }): Promise<void> {
    const config = this.currentConfig;
    if (!this.record) await this.create();
    const record = this.requireRecord();

    const ticket = input.ticket.trim();
    const separator = ticket.indexOf(".");
    const ticketId = separator > 0 ? ticket.slice(0, separator) : ticket;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + INTENT_TTL_MS;
    const intentNonce = randomNonce();
    const agentSignature = signStealthInboxMessage(
      record.inboxIdentityKey,
      stealthInboxPairIntentMessage({
        agentId: input.agentId,
        network: input.network,
        inboxIdentityAddress: record.inboxIdentityAddress,
        // 4a binds a READ credential only. Stage 2 supplies a meta-address, and
        // only stage 2 changes where money is sent.
        metaFingerprint: null,
        ticketId,
        intentNonce,
        issuedAt,
        expiresAt,
        deploymentId: config.deploymentId,
        origin: window.location.origin
      })
    );

    await this.post("/api/stealth/pair", {
      agentId: input.agentId,
      network: input.network,
      ticket,
      ticketId,
      inboxIdentityAddress: record.inboxIdentityAddress,
      metaFingerprint: null,
      intentNonce,
      issuedAt,
      expiresAt,
      deploymentId: config.deploymentId,
      origin: window.location.origin,
      agentSignature
    });

    const paired: StoredInboxRecord = {
      ...record,
      pairing: { agentId: input.agentId, network: input.network, pairedAt: Date.now() }
    };
    await writeRecord(paired);
    this.record = paired;
  }

  /**
   * The signed body of a `stealthInboxSubscribe`. A fresh nonce every time, so a
   * captured payload cannot be replayed — the server consumes each one once.
   */
  async subscribePayload(network?: string): Promise<StealthInboxSubscribePayload> {
    const config = this.currentConfig;
    const record = this.requireRecord();
    const pairing = record.pairing;
    if (!pairing) throw new Error("This browser is not paired to an agent inbox");

    const resolvedNetwork = network ?? pairing.network;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + INTENT_TTL_MS;
    const intentNonce = randomNonce();
    const agentSignature = signStealthInboxMessage(
      record.inboxIdentityKey,
      stealthInboxBrowserIntentMessage({
        agentId: pairing.agentId,
        network: resolvedNetwork,
        intentNonce,
        issuedAt,
        expiresAt,
        deploymentId: config.deploymentId,
        origin: window.location.origin
      })
    );

    return {
      agentId: pairing.agentId,
      network: resolvedNetwork,
      intentNonce,
      issuedAt,
      expiresAt,
      agentSignature
    };
  }

  /**
   * Destroys the read key. This is not fund loss: the server still holds every
   * announcement and the money is still owed. It costs read access until the
   * operator issues a new pairing ticket.
   */
  async forget(): Promise<void> {
    await writeRecord(null);
    this.record = null;
    this.currentState = "absent";
  }

  private requireRecord(): StoredInboxRecord {
    if (!this.record) throw new Error("No inbox key in this browser");
    return this.record;
  }

  private async post(path: string, body: unknown): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${stealthApiBase()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      throw new StealthInboxRequestError("stealth_unreachable", "");
    }
    if (response.ok) return;

    // The server returns a fixed code enum and a correlation id, never a
    // message — unknown agent, unpaired agent and bad signature are deliberately
    // indistinguishable here so this channel is not an agent-existence oracle.
    let code: StealthInboxErrorCode | "stealth_unreachable" = "stealth_unreachable";
    let correlationId = "";
    try {
      const parsed = (await response.json()) as { code?: unknown; correlationId?: unknown };
      if (typeof parsed.code === "string") code = parsed.code as StealthInboxErrorCode;
      if (typeof parsed.correlationId === "string") correlationId = parsed.correlationId;
    } catch {
      // A non-JSON body is a transport or proxy failure, not a server verdict.
    }
    throw new StealthInboxRequestError(code, correlationId);
  }
}
