import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

export type LegState = "queued" | "broadcasting" | "settled" | "failed" | "uncertain";
export type GroupState = "queued" | "in-flight" | "settled" | "partial" | "failed" | "uncertain";

export interface PendingPayoutLeg {
  index: number;
  payoutRef: string;
  recipient: string;
  amountAtomic: string;
  ephemeralPubKey?: string;
  denominationAtomic?: string | null;
  state: LegState;
  attempts: number;
  logicalId: string;
  gen: number;
  signedTx?: string;
  txId?: string;
  nonce?: number;
  lastValidBlockHeight?: number;
  contextSlot?: number;
  chainStatus?: "included" | "finalized";
  mode?: "dry-run" | "onchain";
  transactionHash?: string;
  terminalAt?: number;
  /**
   * §2.9 H11 — when THIS process handed the leg's first broadcast to the RPC
   * (absent on replays, refused broadcasts, dry-runs, and legacy legs). The
   * cohort's first-to-last spread over these is the measured broadcast
   * tightness the spec refuses to claim unmeasured.
   */
  broadcastAt?: number;
  /**
   * §2.9 H11 — the block (EVM) or slot (Solana) the leg's landed verdict was
   * observed in. Absent = unmeasured, never = tight. The cohort's landing
   * spread over these is what exposes a temporal partition: members that all
   * "settled" but landed in visually distinct on-chain clusters.
   */
  landedBlock?: number;
}

export interface PendingPayoutGroup {
  groupRef: string;
  ownerTag: string;
  network: string;
  asset: string;
  strategy: "single" | "denominations";
  planHash: string;
  legs: PendingPayoutLeg[];
  offchainChange: null;
  groupState: GroupState;
  createdAt: number;
  terminalAt?: number;
  /**
   * Signed client-declared release cap (spec-payout-concentration.md §5), clamped
   * to the server ceiling by the flush gate. Advisory-only per §4.2 R4: it changes
   * WHEN a group releases, never whether it settles, and it never gates recovery.
   */
  maxHoldMs?: number;
  /**
   * When this group was counted as adaptive concurrency evidence, if it has been
   * (spec-exit-rounds.md §4, Codex B2). A group contributes to evidence exactly
   * once, in the first gated window after it is enqueued.
   *
   * Persisted rather than tracked in memory because the failure it prevents is a
   * restart-shaped one: a held backlog that is re-counted every window manufactures
   * concurrency that no longer exists and ratchets the lane's target upward after
   * real traffic has stopped — the adaptive gate holding lone withdrawers on the
   * strength of its own echo. Advisory only, exactly like `maxHoldMs`: it changes
   * what the gate LEARNS, never whether a payout settles.
   */
  evidenceCountedAt?: number;
}

interface PendingPayoutFile {
  version: 1;
  groups: PendingPayoutGroup[];
}

const EMPTY_FILE = (): PendingPayoutFile => ({ version: 1, groups: [] });

export class PendingPayoutJournal {
  private readonly file: EncryptedJsonFile<PendingPayoutFile>;
  private state = EMPTY_FILE();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptionKey: string) {
    if (!encryptionKey.trim()) {
      throw new Error("Pending payout journal requires PX402_DATA_ENCRYPTION_KEY");
    }
    this.file = new EncryptedJsonFile(filePath, encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY_FILE());
    if (stored.version !== 1 || !Array.isArray(stored.groups)) {
      throw new Error("Pending payout journal file is invalid");
    }
    this.state = stored;
    this.assertState();
    if (this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  list(): PendingPayoutGroup[] {
    return structuredClone(this.state.groups);
  }

  byRef(groupRef: string): PendingPayoutGroup | undefined {
    const group = this.state.groups.find((entry) => entry.groupRef === groupRef);
    return group ? structuredClone(group) : undefined;
  }

  knownRefs(): Set<string> {
    return new Set(this.state.groups.flatMap((group) => group.legs.map((leg) => leg.payoutRef)));
  }

  queuedLegs(network: string) {
    return this.state.groups
      .filter((group) => group.network === network)
      .flatMap((group) => group.legs
        .filter((leg) => leg.state === "queued")
        .map((leg) => ({ group: structuredClone(group), leg: structuredClone(leg) })));
  }

  putGroup(group: PendingPayoutGroup): Promise<void> {
    return this.serialize(async () => {
      const existing = this.state.groups.find((entry) => entry.groupRef === group.groupRef);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(group)) {
          throw new Error("Pending payout groupRef already exists with different content");
        }
        return;
      }
      const previous = structuredClone(this.state);
      this.state.groups.push(structuredClone(group));
      try {
        this.assertState();
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
  }

  updateLeg(
    groupRef: string,
    index: number,
    patch: Partial<PendingPayoutLeg>,
    expectGen?: number,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const group = this.state.groups.find((entry) => entry.groupRef === groupRef);
      if (!group) throw new Error("Pending payout group not found");
      const leg = group.legs.find((entry) => entry.index === index);
      if (!leg) throw new Error("Pending payout leg not found");
      if (expectGen !== undefined && leg.gen !== expectGen) return false;
      if (patch.index !== undefined && patch.index !== leg.index) {
        throw new Error("Pending payout leg index is immutable");
      }
      if (patch.payoutRef !== undefined && patch.payoutRef !== leg.payoutRef) {
        throw new Error("Pending payout leg ref is immutable");
      }
      if (patch.logicalId !== undefined && patch.logicalId !== leg.logicalId) {
        throw new Error("Pending payout leg logicalId is immutable");
      }
      const previous = structuredClone(this.state);
      Object.assign(leg, patch, { gen: leg.gen + 1 });
      try {
        this.assertState();
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return true;
    });
  }

  setGroupState(groupRef: string, state: GroupState, terminalAt?: number): Promise<void> {
    return this.serialize(async () => {
      const group = this.state.groups.find((entry) => entry.groupRef === groupRef);
      if (!group) throw new Error("Pending payout group not found");
      if (group.groupState === state && group.terminalAt === terminalAt) return;
      const previous = structuredClone(this.state);
      group.groupState = state;
      group.terminalAt = terminalAt;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
  }

  /**
   * Stamp groups as already counted toward adaptive evidence (§4, Codex B2).
   *
   * Batched into ONE write because the caller marks a whole window at once and this
   * sits on the flush path ahead of any broadcast. Already-stamped groups are
   * skipped rather than restamped, so the recorded time stays the first window —
   * re-dating them would make the marker meaningless. Silently ignores refs that
   * are gone: this is advisory metadata and must never fail a flush.
   */
  markEvidenceCounted(groupRefs: readonly string[], atMs: number): Promise<string[]> {
    return this.serialize(async () => {
      const wanted = new Set(groupRefs);
      const marked = this.state.groups.filter(
        (group) => wanted.has(group.groupRef) && group.evidenceCountedAt === undefined,
      );
      if (marked.length === 0) return [];
      const previous = structuredClone(this.state);
      for (const group of marked) group.evidenceCountedAt = atMs;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      // The refs that were NEWLY stamped, not the refs asked for: the caller records
      // one evidence sample per group and must not count a group the write skipped.
      return marked.map((group) => group.groupRef);
    });
  }

  setChangeState(_groupRef: string, _state: "credited" | "reversed"): Promise<void> {
    return Promise.reject(new Error("pool_payout_change_not_enabled"));
  }

  prune(now = Date.now()): Promise<number> {
    return this.serialize(async () => {
      const before = this.state.groups.length;
      this.state.groups = this.state.groups.filter((group) => (
        group.groupState === "uncertain"
        || group.terminalAt === undefined
        || group.terminalAt > now
      ));
      const removed = before - this.state.groups.length;
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  close(): void {
    // EncryptedJsonFile keeps no open descriptor between operations.
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }

  private assertState() {
    const refs = new Set<string>();
    for (const group of this.state.groups) {
      if (!group.groupRef || !group.ownerTag || !group.planHash || group.offchainChange !== null) {
        throw new Error("Pending payout group is invalid");
      }
      if (group.legs.length === 0) throw new Error("Pending payout group has no legs");
      for (const leg of group.legs) {
        if (refs.has(leg.payoutRef)) throw new Error("Pending payout leg ref is duplicated");
        refs.add(leg.payoutRef);
        if (!leg.logicalId || !Number.isInteger(leg.gen) || leg.gen < 0) {
          throw new Error("Pending payout leg is invalid");
        }
        if (BigInt(leg.amountAtomic) <= 0n) throw new Error("Pending payout leg amount is invalid");
      }
    }
  }
}
