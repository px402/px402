import { createHash, createHmac } from "node:crypto";

/**
 * Committed-and-revealed flush schedule (spec-payout-concentration.md §6).
 *
 * The operator controls when payouts flush, which is exactly the lever a malicious
 * operator would use to manufacture k_eff = 1 for a victim (A1). This does not stop
 * that — it makes *systematic* isolation detectable after the fact: the operator
 * commits to each epoch's jitter schedule up front and reveals the seed once the
 * epoch closes, so anyone can recompute every window's jitter draw and check that
 * realized landing times match. Say exactly that and nothing stronger — it is
 * detection, not prevention (§6).
 *
 * The per-epoch seed is derived from a long-lived per-network master secret via
 * HMAC, so revealing a closed epoch's seed exposes neither the master nor any
 * other epoch's seed. The master secret is never published.
 *
 * Pure and deterministic so both the scheduler and an external verifier compute
 * identical draws.
 */

/** Which epoch a timestamp falls in, given a fixed epoch length. */
export const epochOf = (nowMs: number, epochMs: number): number => Math.floor(nowMs / epochMs);

/** The epoch seed the scheduler uses and later reveals: HMAC(master, "epoch:"+e). */
export const epochSeed = (masterSeedHex: string, epoch: number): string =>
  createHmac("sha256", Buffer.from(masterSeedHex, "hex"))
    .update(`epoch:${epoch}`)
    .digest("hex");

/** Public commitment published for an epoch before it opens: H(epochSeed || ":" || epoch). */
export const scheduleCommitment = (epochSeedHex: string, epoch: number): string =>
  `0x${createHash("sha256").update(`${epochSeedHex}:${epoch}`).digest("hex")}`;

/**
 * The absolute slot a timestamp occupies within its epoch: `floor(offset / windowMs)`.
 *
 * This is a pure function of public values — the network's flush period and the wall
 * clock — so the scheduler and an external verifier agree without sharing any state,
 * and, decisively, a process restart cannot change it (spec-exit-rounds.md §4, Codex
 * F3). The previous scheme incremented an in-memory cursor per draw, so restarting
 * rewound every network to index 0 and replayed the epoch's opening jitter draws.
 * Restart was therefore an undetectable release-timing lever: exactly the operator
 * capability the commit-and-reveal scheme exists to expose.
 */
export const scheduleSlot = (nowMs: number, epochMs: number, windowMs: number): number =>
  Math.floor((nowMs - epochOf(nowMs, epochMs) * epochMs) / windowMs);

/**
 * Jitter for one flush window, in `[0, maxJitterMs]`, derived from the epoch seed,
 * the NETWORK, and the window's absolute slot within the epoch. Uniform to within
 * modulo bias over a 48-bit draw, which is negligible against millisecond jitter
 * ranges.
 *
 * The network is part of the derivation because slots are now absolute rather than
 * per-network cursors: without it every rail would draw the identical jitter in the
 * same slot and flush in lockstep, correlating their landings for free. It is public,
 * so a verifier recomputing a revealed epoch loses nothing.
 */
export const deriveScheduleJitter = (
  epochSeedHex: string,
  network: string,
  epoch: number,
  windowIndex: number,
  maxJitterMs: number,
): number => {
  if (maxJitterMs <= 0) return 0;
  const digest = createHmac("sha256", Buffer.from(epochSeedHex, "hex"))
    .update(`${network}:${epoch}:${windowIndex}`)
    .digest();
  return digest.readUIntBE(0, 6) % (maxJitterMs + 1);
};
