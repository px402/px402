import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StealthMetaAddress } from "../../shared/stealth";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

/**
 * Which browser may read which agent's stealth inbox.
 *
 * Durable and encrypted, NOT tmpfs. Losing a pairing does not lose money, but it
 * does orphan the browser's ability to be recognised for outputs that were
 * ALREADY announced to it — the announcements stay in the book while nothing can
 * enumerate them until an operator mints a fresh ticket. That is an outage, so
 * the record survives a restart like every other liability-adjacent store here.
 *
 * Two stages, matching the 4a/4b split (spec §6.5):
 *
 *  - Stage 1 (4a, this phase) binds `inboxIdentityAddress` and NOTHING else. The
 *    browser becomes a reader of announcements; it does not become the party
 *    they were generated for, so where money goes is unchanged.
 *  - Stage 2 (4b-browser, not implemented here) additionally supplies a
 *    `stealthMeta` the browser can spend from, which DOES change where future
 *    payments are sent, and therefore carries heavier guards.
 *
 * The stage-2 fields are nullable rather than absent so the upgrade is an
 * additive mutation of the same record. Regenerating the inbox key at stage 2
 * would force a re-pair, and a re-pair is refused exactly when announcements are
 * outstanding — i.e. precisely when the user has money waiting.
 */

export interface StealthInboxPairingRecord {
  agentId: string;
  /** Stage 1, required. The read credential. EIP-55 checksummed. */
  inboxIdentityAddress: string;
  /** Stage 2 (4b-browser). Null for every record this phase writes. */
  stealthMeta: StealthMetaAddress | null;
  stealthViewingKey: string | null;
  metaFingerprint: string | null;
  /** The stage-1 ticket that authorized this binding. */
  ticketId: string;
  upgradeTicketId: string | null;
  pairedAt: number;
  upgradedAt: number | null;
}

/**
 * A one-time pairing authorization. Only the SHA-256 of the secret half is
 * stored: the file is encrypted, but a bearer credential that never needs to be
 * read back should not be readable back.
 */
export interface StealthInboxPairingTicket {
  id: string;
  agentId: string;
  secretHash: string;
  /**
   * Whether this ticket may overwrite an existing pairing. Decided by the
   * operator at mint time, because minting requires the admin bearer — a
   * browser can never elect to replace a binding.
   */
  allowReplace: boolean;
  issuedAt: number;
  expiresAt: number;
  /** Tombstone. A ticket that can be spent twice is a second pairing. */
  consumedAt: number | null;
}

interface PairingBookFile {
  version: 1;
  records: StealthInboxPairingRecord[];
  tickets: StealthInboxPairingTicket[];
}

export interface StealthInboxPairingBookOptions {
  encryptionKey: string;
  ticketTtlMs: number;
}

export type StealthPairingRejection =
  | "ticket-malformed"
  | "ticket-unknown"
  | "ticket-expired"
  | "ticket-consumed"
  | "ticket-agent-mismatch"
  | "already-paired";

export type StealthPairingOutcome =
  | { ok: true; record: StealthInboxPairingRecord }
  | { ok: false; reason: StealthPairingRejection };

const EMPTY_BOOK = (): PairingBookFile => ({ version: 1, records: [], tickets: [] });

const TICKET_ID = /^tkt_[a-f0-9]{16}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const constantTimeEqualHex = (left: string, right: string) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

export class StealthInboxPairingBook {
  private readonly file: EncryptedJsonFile<PairingBookFile>;
  private state = EMPTY_BOOK();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, private readonly options: StealthInboxPairingBookOptions) {
    if (!options.encryptionKey.trim()) {
      throw new Error("Stealth inbox pairing book requires PX402_DATA_ENCRYPTION_KEY");
    }
    if (!Number.isSafeInteger(options.ticketTtlMs) || options.ticketTtlMs <= 0) {
      throw new Error("Stealth inbox pairing ticket TTL must be a positive integer");
    }
    this.file = new EncryptedJsonFile(filePath, options.encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_BOOK());
    if (stored.version !== 1 || !Array.isArray(stored.records) || !Array.isArray(stored.tickets)) {
      throw new Error("Stealth inbox pairing book file is invalid");
    }
    this.state = stored;
    for (const record of this.state.records) this.assertRecord(record);
    const pruned = this.pruneTickets(Date.now());
    if (pruned || this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  get(agentId: string): StealthInboxPairingRecord | undefined {
    const record = this.state.records.find((entry) => entry.agentId === agentId);
    return record ? structuredClone(record) : undefined;
  }

  all(): readonly StealthInboxPairingRecord[] {
    return this.state.records.map((record) => structuredClone(record));
  }

  get count(): number {
    return this.state.records.length;
  }

  /**
   * Mint a one-time ticket. The returned `ticket` is the only time the secret
   * half exists outside the operator's hands; the book keeps its hash.
   */
  issueTicket(input: {
    agentId: string;
    allowReplace?: boolean;
    now?: number;
  }): Promise<{ ticketId: string; ticket: string; expiresAt: number }> {
    return this.serialize(async () => {
      const now = input.now ?? Date.now();
      const ticketId = `tkt_${randomBytes(8).toString("hex")}`;
      const secret = randomBytes(32).toString("hex");
      const ticket: StealthInboxPairingTicket = {
        id: ticketId,
        agentId: input.agentId,
        secretHash: sha256(secret),
        allowReplace: input.allowReplace ?? false,
        issuedAt: now,
        expiresAt: now + this.options.ticketTtlMs,
        consumedAt: null,
      };
      this.pruneTickets(now);
      this.state.tickets.push(ticket);
      await this.persist();
      return { ticketId, ticket: `${ticketId}.${secret}`, expiresAt: ticket.expiresAt };
    });
  }

  /** Ticket id half of a `<id>.<secret>` ticket, for binding it into a signature. */
  static ticketIdOf(ticket: string): string | undefined {
    const [id] = ticket.split(".");
    return TICKET_ID.test(id ?? "") ? id : undefined;
  }

  /**
   * Consume a ticket and write the stage-1 binding in ONE serialized, single-fsync
   * operation. Splitting the consume from the write would let two concurrent
   * pair requests with the same ticket both pass the consume check.
   */
  pair(input: {
    ticket: string;
    agentId: string;
    inboxIdentityAddress: string;
    /** Refuses a REPLACEMENT (not a first pairing) when true; see SI-6. */
    announcementsOutstanding: boolean;
    now?: number;
  }): Promise<StealthPairingOutcome> {
    return this.serialize(async () => {
      const now = input.now ?? Date.now();
      const [ticketId, secret] = input.ticket.split(".");
      if (!TICKET_ID.test(ticketId ?? "") || !/^[a-f0-9]{64}$/.test(secret ?? "")) {
        return { ok: false, reason: "ticket-malformed" } as const;
      }
      const ticket = this.state.tickets.find((entry) => entry.id === ticketId);
      if (!ticket || !constantTimeEqualHex(ticket.secretHash, sha256(secret))) {
        return { ok: false, reason: "ticket-unknown" } as const;
      }
      if (ticket.consumedAt !== null) return { ok: false, reason: "ticket-consumed" } as const;
      if (ticket.expiresAt <= now) return { ok: false, reason: "ticket-expired" } as const;
      if (ticket.agentId !== input.agentId) {
        return { ok: false, reason: "ticket-agent-mismatch" } as const;
      }

      const existing = this.state.records.find((entry) => entry.agentId === input.agentId);
      if (existing && (!ticket.allowReplace || input.announcementsOutstanding)) {
        // SI-6. A first pairing is always allowed — refusing it would leave a
        // payee unable to even SEE money already announced to them. What is
        // refused is REPLACING a binding while outputs are outstanding, which is
        // what would orphan recognition of those outputs.
        return { ok: false, reason: "already-paired" } as const;
      }

      ticket.consumedAt = now;
      const record: StealthInboxPairingRecord = {
        agentId: input.agentId,
        inboxIdentityAddress: input.inboxIdentityAddress,
        stealthMeta: null,
        stealthViewingKey: null,
        metaFingerprint: null,
        ticketId: ticket.id,
        upgradeTicketId: null,
        pairedAt: now,
        upgradedAt: null,
      };
      this.assertRecord(record);
      if (existing) {
        this.state.records[this.state.records.indexOf(existing)] = record;
      } else {
        this.state.records.push(record);
      }
      this.pruneTickets(now);
      await this.persist();
      return { ok: true, record: structuredClone(record) } as const;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
  }

  /**
   * Drop tickets that can no longer authorize anything. An expired ticket fails
   * the TTL check whether or not its tombstone survives, so retaining it past
   * expiry only grows the file.
   */
  private pruneTickets(now: number): boolean {
    const before = this.state.tickets.length;
    this.state.tickets = this.state.tickets.filter((ticket) => ticket.expiresAt > now);
    return this.state.tickets.length !== before;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Stealth inbox pairing book is closed"));
    const execute = async () => {
      const previous = structuredClone(this.state);
      try {
        return await operation();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    };
    const result = this.writeQueue.then(execute, execute);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }

  private assertRecord(record: StealthInboxPairingRecord) {
    if (!record.agentId
      || !ADDRESS.test(record.inboxIdentityAddress)
      || !TICKET_ID.test(record.ticketId)) {
      throw new Error("Stealth inbox pairing record is invalid");
    }
    // Stage 2 is all-or-nothing: a half-applied upgrade would leave the server
    // publishing a meta-address whose viewing key it does not have.
    const stageTwo = [record.stealthMeta, record.stealthViewingKey, record.metaFingerprint];
    if (stageTwo.some((value) => value !== null) && stageTwo.some((value) => value === null)) {
      throw new Error("Stealth inbox pairing record has a partial stage-2 upgrade");
    }
  }
}
