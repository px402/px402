import { randomBytes } from "node:crypto";
import type { KEffSample } from "../../shared/payoutConcentration";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

/**
 * Durable adaptive-concentration state (spec-exit-rounds.md §4, Codex F3).
 *
 * Two things live here, and both are here for the same reason: without them a
 * process restart silently changes the privacy posture of the deployment, which
 * hands the operator a release-control lever that leaves no trace.
 *
 * - `lanes` — the per-lane concurrency evidence the adaptive target is derived
 *   from. Held only in memory, a restart resets every lane to "no evidence", and
 *   an adaptive deployment that had earned a target of 4 drops back to 1 and
 *   releases everything immediately. That is not a fail-safe default: it is a
 *   privacy downgrade an operator can trigger at will and blame on a deploy.
 * - `scheduleMasterSeed` — the §6 commit-and-reveal master secret. It was minted
 *   fresh per process, so every commitment published before a restart became
 *   unverifiable afterwards: `revealSchedule` would answer for a closed epoch with
 *   a seed derived from a DIFFERENT master, and the reveal would not hash to the
 *   commitment anyone recorded. A scheme whose whole purpose is after-the-fact
 *   detection cannot have its evidence erased by `docker restart`.
 *
 * Encrypted at rest and `failClosed`: lane occupancy over time is per-denomination
 * traffic detail, which §7 deliberately keeps off the public surface. Not durable-
 * critical to funds — a lost file degrades to "no evidence yet", never to a wrong
 * ledger — but written durably anyway, because the whole point is surviving the
 * restart.
 */

export interface ConcentrationState {
  version: 1;
  /** Long-lived §6 master secret, hex. Null until concentration first runs. */
  scheduleMasterSeed: string | null;
  /** Evidence per lane key (`network:asset:denominationAtomic`). */
  lanes: Record<string, KEffSample[]>;
}

const EMPTY = (): ConcentrationState => ({
  version: 1,
  scheduleMasterSeed: null,
  lanes: {},
});

const isSample = (value: unknown): value is KEffSample => {
  if (typeof value !== "object" || value === null) return false;
  const sample = value as { atMs?: unknown; kEff?: unknown };
  return Number.isFinite(sample.atMs) && Number.isFinite(sample.kEff);
};

export class ConcentrationStateStore {
  private readonly file: EncryptedJsonFile<ConcentrationState>;
  private state = EMPTY();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptionKey: string) {
    if (!encryptionKey.trim()) {
      throw new Error("Concentration state store requires PX402_DATA_ENCRYPTION_KEY");
    }
    this.file = new EncryptedJsonFile(filePath, encryptionKey, {
      failClosed: true,
      durable: true,
    });
  }

  /**
   * Read state back, discarding anything that fell outside the evidence window
   * while the process was down. Pruning on load rather than only on write means a
   * deployment that was off for longer than the window comes back with a clean
   * slate rather than resurrecting stale concurrency it can no longer justify.
   */
  async load(nowMs: number, windowMs: number): Promise<ConcentrationState> {
    const stored = await this.file.read(EMPTY());
    if (stored.version !== 1 || typeof stored.lanes !== "object" || stored.lanes === null) {
      throw new Error("Concentration state file is invalid");
    }
    const horizon = nowMs - windowMs;
    const lanes: Record<string, KEffSample[]> = {};
    for (const [lane, samples] of Object.entries(stored.lanes)) {
      if (!Array.isArray(samples)) continue;
      const kept = samples
        .filter(isSample)
        // A sample stamped in the future is not evidence; it is a clock that moved
        // backwards, and admitting it would pin a lane's target until it aged out.
        .filter((sample) => sample.atMs >= horizon && sample.atMs <= nowMs);
      if (kept.length > 0) lanes[lane] = kept;
    }
    const seed = typeof stored.scheduleMasterSeed === "string"
      && /^[0-9a-f]{64}$/i.test(stored.scheduleMasterSeed)
      ? stored.scheduleMasterSeed
      : null;
    this.state = { version: 1, scheduleMasterSeed: seed, lanes };
    if (this.file.shouldRewriteEncrypted()) await this.persist();
    return { version: 1, scheduleMasterSeed: seed, lanes: structuredClone(lanes) };
  }

  /**
   * The master secret, minting and persisting one on first use. Callers must await
   * this before publishing any commitment, or a crash between publishing and
   * writing would leave a commitment nothing can reveal.
   */
  async resolveMasterSeed(): Promise<string> {
    if (this.state.scheduleMasterSeed) return this.state.scheduleMasterSeed;
    const seed = randomBytes(32).toString("hex");
    this.state = { ...this.state, scheduleMasterSeed: seed };
    await this.persist();
    return seed;
  }

  /** Replace the lane evidence wholesale; the queue owns the in-memory truth. */
  saveLanes(lanes: ReadonlyMap<string, readonly KEffSample[]>): Promise<void> {
    const next: Record<string, KEffSample[]> = {};
    for (const [lane, samples] of lanes) {
      if (samples.length > 0) next[lane] = samples.map((sample) => ({ ...sample }));
    }
    this.state = { ...this.state, lanes: next };
    return this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.file.write(snapshot));
    return this.writeQueue;
  }
}
