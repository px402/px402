import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

/**
 * Durable cohort manifests (spec-exit-rounds.md §5, R9).
 *
 * A cohort is the set of legs a flush window decided to release together, and it
 * is the thing an agent's realized privacy is actually measured over. Two reasons
 * it lives on disk rather than in a `Map`:
 *
 * - **R8 — realized `k_eff` is computed post-landing.** The value was previously
 *   written from the release DECISION, before a single leg had been submitted, so
 *   it reported the cohort that was planned rather than the one that landed. A
 *   member that fails or never resolves must lower it, and that is not knowable
 *   until every member is terminal — which, on a real chain, is minutes after the
 *   window closed and frequently after a restart.
 * - **R9 — the claim must survive restart.** `realizedConcentration` was in-memory,
 *   so the honest self-assessment channel answered `undefined` to any agent that
 *   claimed after a deploy. Silence is not a wrong number, but on the one surface
 *   whose entire purpose is telling the payer what it actually got, it is close.
 *
 * Encrypted and `failClosed` for the same reason as the concentration evidence:
 * membership is a per-window map of which accounts withdrew alongside each other,
 * which is exactly the correlation the mechanism exists to prevent an observer
 * from building.
 */

/**
 * R11 — a window can emit three DIFFERENT kinds of release, and mixing them in one
 * reported cohort is a lie in the agent's favour. Under the frozen window metric a
 * single null-denomination leg drags the whole window's `k_eff` to 1, so a shared
 * manifest would have reported 1 for a genuinely 4-way lane; and a straggler
 * force-released at `maxHoldMs` never had the cover the complete cohort did.
 */
export type CohortKind =
  /** The window met its target: every member released together on purpose. */
  | "cohort"
  /** Force-released at `maxHoldMs` while the window was still below target. */
  | "forced"
  /** Null-denomination exact legs. `k_eff = 1` by construction, never held. */
  | "exact";

export interface CohortMember {
  groupRef: string;
  legIndex: number;
  /** The paying ACCOUNT (§2) — anonymity is counted over owners, never groups. */
  ownerRef: string;
  /** `network:asset:denominationAtomic`, or null for an exact leg. */
  laneKey: string | null;
  /** How long this member's group waited between enqueue and release. */
  heldMs: number;
}

export interface CohortRecord {
  cohortId: string;
  network: string;
  kind: CohortKind;
  /** The lane target this window was judged against, for after-the-fact review. */
  targetK: number;
  /** What the release decision expected. Retained ONLY to compare against reality. */
  plannedKEff: number;
  createdAt: number;
  members: CohortMember[];
  /** Post-landing, over members that actually settled (R8). Absent until terminal. */
  realizedKEff?: number;
  terminalAt?: number;
  /**
   * §2.9 H11 — the temporal partition realized k_eff cannot see. A nonce gap, a
   * cross-kind wedge, or a quarantine-park splits a cohort into two visually
   * distinct on-chain clusters while every member still counts as "settled", so
   * "targeted cohort size K" quietly becomes "reported cohort size K" on exactly
   * the windows where it was not. `landingSpread` is over the settled members'
   * landing blocks (EVM) / slots (Solana); recorded ONLY when every settled
   * member has a measured landing coordinate — a partial measurement must not
   * read as a tight one.
   */
  landingSpread?: { minBlock: number; maxBlock: number; spreadBlocks: number };
  /**
   * First-to-last first-broadcast spread over the settled members, in ms — the
   * measured value behind the spec's honest landing-tightness statement (one
   * lease, sequential WAL+broadcast ≈ 0.5–2.5 s for 8 legs, never claimed
   * sub-block without this number). Same all-measured-or-absent rule.
   */
  broadcastSpreadMs?: number;
}

interface CohortFile {
  version: 1;
  cohorts: CohortRecord[];
}

const EMPTY = (): CohortFile => ({ version: 1, cohorts: [] });

export class CohortBook {
  private readonly file: EncryptedJsonFile<CohortFile>;
  private state = EMPTY();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptionKey: string) {
    if (!encryptionKey.trim()) {
      throw new Error("Cohort book requires PX402_DATA_ENCRYPTION_KEY");
    }
    this.file = new EncryptedJsonFile(filePath, encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  async load(): Promise<this> {
    const stored = await this.file.read(EMPTY());
    if (stored.version !== 1 || !Array.isArray(stored.cohorts)) {
      throw new Error("Cohort book file is invalid");
    }
    this.state = stored;
    if (this.file.shouldRewriteEncrypted()) await this.persist();
    return this;
  }

  /** Every manifest on disk, for rehydrating the queue's working state at startup. */
  all(): CohortRecord[] {
    return structuredClone(this.state.cohorts);
  }

  /** Manifests for a network that have not yet been resolved post-landing. */
  openFor(network: string): CohortRecord[] {
    return this.state.cohorts
      .filter((cohort) => cohort.network === network && cohort.realizedKEff === undefined)
      .map((cohort) => structuredClone(cohort));
  }

  /** Every cohort a group has a leg in, terminal or not. */
  byGroup(groupRef: string): CohortRecord[] {
    return this.state.cohorts
      .filter((cohort) => cohort.members.some((member) => member.groupRef === groupRef))
      .map((cohort) => structuredClone(cohort));
  }

  /**
   * Persist a manifest. Awaited by the planner BEFORE any member is broadcastable:
   * a cohort whose membership is only known in memory cannot be reconciled after a
   * crash, and its members would land with no record of what they were supposed to
   * be landing with.
   */
  put(record: CohortRecord): Promise<void> {
    return this.serialize(async () => {
      if (this.state.cohorts.some((cohort) => cohort.cohortId === record.cohortId)) {
        throw new Error("Cohort id is already recorded");
      }
      if (record.members.length === 0) throw new Error("Cohort has no members");
      this.state.cohorts.push(structuredClone(record));
      await this.persist();
    });
  }

  /** Record the post-landing outcome. Idempotent: a resolved cohort never changes. */
  resolve(
    cohortId: string,
    realizedKEff: number,
    terminalAt: number,
    spread?: {
      landingSpread?: { minBlock: number; maxBlock: number; spreadBlocks: number };
      broadcastSpreadMs?: number;
    },
  ): Promise<boolean> {
    return this.serialize(async () => {
      const cohort = this.state.cohorts.find((entry) => entry.cohortId === cohortId);
      if (!cohort || cohort.realizedKEff !== undefined) return false;
      const previous = structuredClone(this.state);
      cohort.realizedKEff = realizedKEff;
      cohort.terminalAt = terminalAt;
      if (spread?.landingSpread) cohort.landingSpread = structuredClone(spread.landingSpread);
      if (spread?.broadcastSpreadMs !== undefined) cohort.broadcastSpreadMs = spread.broadcastSpreadMs;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return true;
    });
  }

  /**
   * Drop resolved cohorts past the retention horizon. Unresolved ones are NEVER
   * pruned however old they are — an unresolved cohort means members that never
   * reached a terminal state, which is exactly the case an operator needs to see.
   */
  prune(before: number): Promise<number> {
    return this.serialize(async () => {
      const kept = this.state.cohorts.filter(
        (cohort) => cohort.terminalAt === undefined || cohort.terminalAt > before,
      );
      const removed = this.state.cohorts.length - kept.length;
      if (removed === 0) return 0;
      this.state.cohorts = kept;
      await this.persist();
      return removed;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }
}
