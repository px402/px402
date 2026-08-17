# DESIGN v2 — non-blocking cohort dispatch (spec-exit-rounds.md §5, R14/R15)

Status: **DESIGN v2, revised after three adversarial reviews (Codex, Grok, Fable, 2026-08-06).**
v1 is superseded; its shape was rejected by all three.

Implementation state:
- `d696a56` — `acquireEntry` extracted from `submit()` (behaviour-neutral half of §2.1).
- **§2.1's wait-move is IMPLEMENTED**: `submit()` releases the settler lease after
  `acquireEntry` and polls to finality outside it, for all five call sites at once
  (smoke tests 12/13 invert the old pinned-serial behaviour). Three guards the
  out-of-lease world required, none of which were in this design and all of which
  surfaced while writing its tests: per-logicalId single-flight on the poll (two
  loops on one entry race `putVersion`'s increasing-fee check — test 14),
  nonce-conditional quarantine clear (an unrelated landing must not wipe a live
  record and unpark submissions — test 16), and atomic lowest-nonce-wins quarantine
  set (concurrent timeouts must converge the single record on the root blocker —
  tests 17/17b; the check lives inside the outbox write queue because a
  read-then-write in the coordinator races). Background reconcile now follows the
  quarantine RECORD, re-read each pass, instead of an entry captured at start.
- The wait-move was adversarially reviewed post-implementation (Codex + Grok,
  2026-08-06, both SHIP-WITH-FIXES; findings converged). Fixed: `recoverOutbox`
  skips entries owned by a live poll and scopes its end-of-walk clear to the
  pre-walk record; `resolveQuarantine`'s four clears are record-conditional;
  polls suppress fee bumps while a quarantine records a nonce at/below theirs;
  cancel-mode landed resolutions finalize state and lift the quarantine
  (pre-existing false-resolution bug); `close()` stops active polls (smoke
  tests 18-22, each mutation-verified).
- **§2.4 H7 grace age + minimal §2.8 are IMPLEMENTED** (the prior ops constraint
  is retired). One new verdict across both rails: `pending` = zero on-chain
  evidence inside the entry's OWN liveness bound — the durable dispatch age
  (`versions[0].createdAt`, so a fee bump does not reset the clock and it
  survives restart) against `PX402_POOL_PAYOUT_DISPATCH_GRACE_MS`
  (default 90 s) on EVM, and blockhash validity on Solana (no grace clock
  needed; expiry at the finalized head still proves `terminal-absent`). This
  resolved §2.10's open question: Solana DID flap — absence inside the window
  reported `uncertain` from a status poll that runs milliseconds after
  broadcast. `pending` never reaches the journal (`applyVerdict` leaves the leg
  byte-identical — no state write, no generation churn), and `recoverOutbox`
  classifies a young `broadcasting` entry ONCE, rebroadcasts it, and skips it,
  so a restart mid-burst no longer quarantines a healthy settler. A skip is not
  a resolution: recovery never lifts a quarantine whose entry it skipped.
  Smoke tests: settler 23-25, pool-payout 57/59, each mutation-verified.
  **Post-implementation reviews (Codex + Grok, both SHIP-WITH-FIXES, all fixed):**
  Codex — exhaustion now young-skips by local clock instead of quarantining the
  unexamined; the recovery classify RPC is raced against the budget (it holds
  the lease); `applyVerdict(pending)` clears reorged-away recorded evidence.
  Grok F1 (HIGH, the wave's sharpest finding) — a pending skip had NO owner:
  recovery runs once, EVM reconcile never rebroadcasts, nothing quarantined, so
  a mempool-dropped tx gap-stuck the rail forever with the cancel tooling
  unreachable. Recovery now schedules ONE deferred follow-up run just past the
  remaining grace whenever it pending-skips; the aged entry then takes the full
  resumeEntry path and ownership is restored (settler test 28). Also: startup
  throws when the grace exceeds the submit timeout (split-brain journal read),
  future-skewed `createdAt` classifies uncertain rather than young-forever, the
  suppressed-skip withholds the stale-quarantine lift, EVM pending queue path
  covered (pool-payout 61), test 59 asserts the generation counter genuinely
  does not churn.
- **§2.5 (parked ≠ attempt) is IMPLEMENTED**, and it lands the quarantine-park
  flavor of the §2.6 R12 fix ahead of schedule. Two layers: `flushLeg` consults
  the new optional `ChainRail.settlerQuarantined()` BEFORE the attempts write —
  a quarantined rail's flush is a pure delay, zero journal writes, leg stays
  queued literally byte-identical — and for the quarantine-began-mid-submit
  race, `CoordinatorSubmitInput.onQuarantine: "reject"` makes `submit()` throw
  a synchronous `SettlerQuarantinedError` (nothing signed, no nonce, no outbox
  entry) instead of suspending, at both quarantine-check sites; `flushLeg`
  catches it and restores the leg to queued with its ORIGINAL attempts count.
  The pool-payout rail is the only reject-mode caller — the other four call
  sites keep the suspended park, which is correct for one-shot callers with no
  durable queue of their own. Consequence for R12: a quarantined settler no
  longer pins the network lock via a suspended pool-payout submit.
  Smoke tests: settler 29/29b, pool-payout 62/63, each mutation-verified per
  layer.
  **Post-implementation reviews:** Codex SHIP (zero findings; the dead EVM
  preparePoolPayout alias is marked for §2.2). Grok SHIP-WITH-FIXES — its F1
  caught a real fund-safety inducement on the DEFAULT flag-off path that this
  section's first draft wrongly claimed was handled: the registry classified a
  merely-delayed (queued) leg as the literal "Pool payout failed" while the
  reserved debit stayed live and would settle later, inviting a second quote
  and a double payment. Fixed registry-side: the synchronous path now refuses
  BEFORE consuming quote/debit when the settler is quarantined ("nothing was
  debited, retry later"), and a post-flush queued/broadcasting leg reports
  DELAYED-with-debit-held, never "failed" ("failed" is reserved for the
  terminal state that also reverses the debit). Grok F2 also fixed: a
  quarantined rail's flush window skips release AND cohort planning (no
  unresolvable manifests minted, no k_eff samples for releases that never hit
  chain), while the retention/cohort-resolution tail still runs. Grok F6
  (crash between the pre-call attempts write and the §2.5 revert leaks one
  attempts increment) is an ACCEPTED residual, documented in flushLeg: bounded
  by real crashes inside the race window, worst case an early maxAttempts trip
  to operator-recoverable `uncertain`, never fund loss. Tests: denomination
  suite (registry refusal + DELAYED classification), pool-payout 64 (no cohort
  minting), all mutation-verified.
- **§2.2 `dispatchMany` + §2.3 `maintainEntry` + §2.6 queue dispatch + §2.7 R13
  fences are IMPLEMENTED** — shipped together deliberately: dispatch without
  maintain recreates the review-round F1 ownership dead-end LIVE (a
  dispatched-but-dropped transaction with no rebroadcast/bump owner).
  - `dispatchMany` takes the settler lease ONCE per wave (one quarantine check,
    one nonce read, one fee read, N signs, N WAL writes, N first broadcasts).
    Existing non-terminal entries rebroadcast once and report `dispatched` —
    never `resumeEntry`. Sign failures do not consume a nonce (sequence stays
    gapless). Non-benign FIRST-broadcast failures classify outside the lease
    and feed an 8-consecutive fail-stop into quarantine (the v1 out-of-gas
    pile-up). Rejects synchronously via `SettlerQuarantinedError` at both
    quarantine-check sites.
  - `maintainEntry` is every dispatched entry's owner, driven by the queue's
    reconcile pass with the reconcile's own verdict passed through (H6):
    rebroadcast unconditional, bump only with a signer under a TRY-lease
    (`leaseBusy` flag — never blocks the network lock on the settler lease),
    per-entry deadline from durable `versions[0].createdAt` quarantining past
    `timeoutMs`, MAINTAIN_VERSION_CAP backstop, fully inert under quarantine,
    skips suppressed/active-poll entries. Signers rebuilt from durable journal
    data (`recipient`/`amountAtomic`), so restart loses nothing.
  - Queue: WINDOWED EVM-onchain releases route through `dispatchLegs` — one
    rail dispatch per wave, flush returns with legs `broadcasting`, the
    reconcile finishes them (R12: the network lock is never held for a
    finality wait). The TARGETED flush (`onlyGroupRef`, the flag-off
    synchronous path) keeps the awaited submit — that one-leg-receipt contract
    is frozen. A mid-wave quarantine returns every leg to queued with original
    attempts (§2.5 for the batch). R13: every dispatch-path journal write is
    generation-fenced, with the lock-held-from-selection-to-bookkeeping
    invariant stated at `dispatchLegs`.
  - Smoke tests: settler 30-37, pool-payout 65-67; eight-mutation sweep, one
    per behavior, each caught by its designated test.
  - **Post-implementation reviews (Codex + Grok, both SHIP-WITH-FIXES, no
    fund-safety findings; all fixed).** Codex: dispatchMany had reinstated the
    hand-copied nonce-allocation path d696a56 existed to prevent — now
    `allocateNextNonce()` is the one formula; the grace-vs-timeout ~30s
    operator window is documented and resolveQuarantine's refusal explains it;
    test 68 pins recordDispatchError's two paths incl. the lost-nonce debit
    reversal. Grok F-THROW (the real catch): a batch abort after K of N legs
    reached the durable outbox mass-classified ALL N `uncertain`, opening
    disposition on transactions that may still land — the catch now keeps
    identity-holding legs in flight and errors only the identity-less rest
    (test 69, incl. full convergence after the abort). Tests 38/39 close the
    other gaps: mid-wave sign failure keeps nonces gapless; the fail-stop
    resets on any successful broadcast. Accepted residuals, documented in
    code: M1 (a per-entry deadline quarantine stops fee-bumps for the whole
    rail's wave — siblings cannot mine behind the stuck nonce anyway), M3
    (tryWithLease is a SOFT try; the admitted wait is bounded by one acquire).
  - **Honest landing-tightness statement (Grok finding 1):** the wave is "one
    lease, sequential WAL+broadcast" — N putVersion fsyncs sit between
    broadcasts, so a realistic 8-leg first-to-last spread is ~0.5-2.5 s
    (1-2 Base blocks), not guaranteed sub-block. The pre-lease per-leg
    simulations delay wave START only, never widen the spread. MEASURE the
    real spread against production RPC (broadcast timestamps) before ever
    stating tightness as a property; this is a deploy-gate item.
- **Full §2.8 (cohort-aware recovery) + §2.9 H11 (landing-spread reporting) are
  IMPLEMENTED** — the wave's last two open sections.
  - §2.8: `recoverOutbox` never resumeEntry-polls a pool entry. The rationale is
    structural, not hopeful: recoverOutbox is reachable only from the queue's
    `recover()` (which reconciles the network FIRST) and from the follow-up
    timer (which fires with the queue's reconcile cadence running), so every
    pool entry has a live reconcile+maintain owner. Recovery's whole job for
    them is what a cold maintain cannot do for itself: the cheap terminal
    transitions on the OUTBOX (landed → finalized + lift, terminal-absent →
    failed + lift — backgroundReconcile's precedent; included → recorded, no
    lift — knowledge, not resolution), plus one rebroadcast so the bytes
    re-enter the post-restart mempool. An aged zero-evidence pool entry SKIPS —
    maintainEntry's per-entry deadline owns the quarantine decision — and the
    exhaustion and hung-classify branches skip aged pool entries for the same
    ownership reason. Non-pool kinds keep the resumeEntry path and the
    aged-exhaustion quarantine: their submit() caller died with the process,
    and the follow-up run remains THEIR ownership fix. Companion: the reconcile
    now passes terminal verdicts through `maintainPoolPayout` too, so a settled
    leg's outbox entry finalizes in the same pass instead of stranding
    non-terminal until the next restart's walk — stranded entries are exactly
    what cohorts multiply.
  - §2.9: `landed` verdicts carry the landing coordinate (EVM receipt block /
    Solana finalized-status slot, absent = unmeasured, never = tight);
    `applyVerdict` persists it as the leg's durable `landedBlock`; fresh first
    broadcasts stamp `broadcastAtMs` on the dispatch outcome (never a replay or
    a refused broadcast) and persist as the leg's `broadcastAt`. `settleCohorts`
    resolves each cohort with `landingSpread` (min/max/spread blocks) and
    `broadcastSpreadMs`, recorded ONLY when every settled member measured — a
    partial measurement must not read as a tight one. The claim's
    `concentration` reports the weakest cover: the MAX spread across the
    group's cohorts, silence where unmeasured. Each wave logs
    `POOL_PAYOUT_WAVE_SPREAD <network> legs=N fresh=M spread_ms=X` at dispatch,
    so production measures the real first-to-last broadcast spread on the first
    live cohort — the instrument behind the deploy-gate measurement below.
  - Smoke tests: settler 45-48 (26/27/28/46/47 re-cast for the ownership
    split), pool-payout 70/71 with 67 re-pinned to the maintain-as-outbox-
    propagator behavior. Ten mutations, one per behavior, each caught by its
    designated test; two fixture defects were found ONLY by mutation — test
    46's end-of-walk stale lift masked the in-branch quarantine clears until
    the fixture injected the record MID-walk, and the broadcast-spread `every`
    rule was unobservable until test 71 mixed stamped and unstamped legs in
    one wave.
  - **Post-implementation reviews (Codex + Grok, both SHIP-WITH-FIXES, all
    processed; gate CLOSED).** Codex (fixed in `9e32ebf`): the recovery walk
    judged its `included` write against the walk-start snapshot, so a
    concurrent reconcile finalizing the same entry got downgraded back to
    `included` — now judged against the live entry, never over a terminal
    state (settler 49, mid-walk injection); and the maintain-on-terminal
    companion was guarded against the `handles[0]` fallback. Grok (fixed in
    `0974372`): the fallback itself is DELETED — it adopted a foreign entry's
    verdict for this leg (foreign landed = debit burned against a transfer
    that paid someone else; foreign terminal-absent = refund while the real
    transfer could still land). Safe because the outbox never prunes: a miss
    proves the leg never broadcast, so requeueing cannot double-pay
    (pool-payout 72). `entriesByRef`/`byTransactionHash` are now scoped by
    (chainId, address) like every other outbox lookup — the WAL is ONE shared
    instance across Base and Robinhood, so the collision surface was
    cross-network (settler 50). groupRef uniqueness confirmed independent of
    journal retention (32-byte random quote nonce). Grok's cohort
    double-membership finding (a re-queued leg's landing counted in its
    original cohort) was fixed via a latest-cohort supersession rule, caught
    by the concentration suite's frozen R8 test, and REVERTED as a decision:
    R8's settled-members definition stands, §2.9's annotation is the
    prescribed tell, and pool-payout 73 pins that the straggler's later
    landing block makes the original cohort's landingSpread visibly wide on
    the sibling's claim.
- Still unbuilt / open: the §5.3 chain-atomic disperse contract (explicitly
  deferred), H14 outbox growth (acknowledged), and the production-RPC spread
  NUMBER itself — the instrument ships above, the number arrives with the
  first real on-chain wave, and landing tightness must not be claimed as a
  property until that logged measurement is cited.

---

## 0. Review outcome

**v1's central premise — "additive, leave `submit()` alone, minimal blast radius" — is dead.**

There is one `TransactionCoordinator` per network, shared by `X402Facilitator`,
`EvmChainRail`, and `PrivateBatchCommitter` (`src/server/index.ts:250`, `:294`, `:507`). They share
one lease. Leaving `submit()` blocking means an unrelated x402 settle or batch commitment holds that
lease across a cohort's dispatch, splitting the cohort in two.

**Correction to a number this document previously carried:** the wedge is bounded by
`timeoutMs` (`PX402_POOL_PAYOUT_TIMEOUT_MS`, default **120 s**), not by real finality.
`resumeEntry` loops `while (Date.now() < deadline)` (`TransactionCoordinator.ts:598`) and exits at
the budget, throwing `SettlerNotYetFinalError` (`:678`). The ~1462 s figure is the finality LAG, a
different quantity. 120 s is still an order of magnitude wider than a cohort's own spread, so the
conclusion is unchanged — but the review record should carry the right number.

So v1 was chosen for safety and would have been ineffective in the common case, while shipping a
false-alarm generator (H7) and an unbounded outage (`maintain` without a quarantine).

### What all three agreed on
- The dispatch split is the right increment and is on the critical path under every future.
- Nonce allocation `max(pending, highWater + 1)` inside the lease is sound; none could construct a
  duplicate. The never-pruned outbox is what makes `highWater` monotonic (`:186-191`).
- `dispatch()` MUST use the literal same `this.lease` field. A private lease "for isolation"
  silently voids every allocation guarantee. Stated as a MUST, with a cross-kind test.
- `dispatch()`'s existing-entry branch was unspecified in v1 and is the retry path most likely to be
  exercised; copying `submit()`'s handling would call `resumeEntry` and reintroduce the exact
  blocking R14 removes.
- H6 downgraded: `classifyNonce` is a pure chain read (`:404-433`), so `maintain()` and the reconcile
  cannot corrupt each other. It is duplicated RPC load, not a race.
- Q4 is close to moot: the lease serializes the expensive part, so queue-level concurrency buys
  nothing. `Promise.all` is actively worse — it abandons siblings' bookkeeping on first rejection and
  makes broadcast order (the R10 shuffle) depend on scheduler details.

### Where they diverged, and the call
- Codex read the recovery bail-out as bounded; Grok and Fable traced that nothing rebroadcasts the
  orphaned higher-nonce entries afterward. **Accepted as unbounded** — `resolveQuarantine` disposes
  only the quarantined nonce, `schedulePendingDrain` drains only parked submissions, and the queue's
  reconcile never rebroadcasts on the EVM branch.
- Fable alone challenged the privacy claim directly and concluded the shape DOES deliver it in the
  healthy path. **Accepted, with its caveat**, see §1.

---

## 1. Does this deliver the property? (the gate question)

**Yes in the healthy path; no in the degraded paths; and the reporting layer cannot currently tell
the difference.** That last clause is the finding, not "abandon the shape".

The legs were never unlinkable *from each other* — same settler EOA, same token, public pool
address. That is true at any spread, including inside one block, including under multicall. The
property claimed is unattributability of **output → owner**. A public total order over legs breaks
it only if the order correlates with owner identity, and post-R10 the broadcast order is a shuffle
of the merged release (`PoolPayoutQueue.ts:773-781`) over requests that arrive via WireGuard with no
public timestamp. So the nonce sequence is not itself the linking datum.

Estimated spread, per-leg lease: ~200–650 ms per leg ⇒ **~1.5–5 s for 8 legs**, 1–3 Base blocks.
With `dispatchMany` (§2.2) taking the lease once per cohort: **~0.5–1.5 s, likely one block.**
These are estimates from typical RPC latencies. The smoke plan must measure them, not assume them.

**Two things that must be said plainly in the honest privacy statement:**

1. **This is what stops the ALREADY-SHIPPED metric from being false.** Today legs land one finality
   apart. The shipped k_eff gate therefore measures window membership the chain never exhibits, and
   payers are already being told they had cover that does not exist on-chain. That is the strongest
   argument for building this.
2. **At current traffic it delivers no cover, by design.** Adaptive targeting holds at 1 until a
   lane has evidence, so cohorts of one are the norm. What ships is "the metric stops lying and the
   mechanism is ready", never "withdrawals gain cover".

**Rejected: going straight to chain-atomic multicall (§5.3a).** `Multicall3.aggregate3` executes
with Multicall3 as `msg.sender`, so moving pool USDC through it needs either pre-funding the
contract (an extra public hop, strictly worse) or an allowance from the pool to a **permissionless**
contract — which any third party can then drain via their own `aggregate3` wrapping
`transferFrom(pool, …)`. That is an open drain, not a privacy upgrade. Chain-atomic needs a
purpose-built disperse contract with an owner check, an audit, and two deployments. It also couples
the failure domain: one blacklisted stealth recipient reverts everyone's payout. **And it still
needs R14/R15** — a multicall transaction also needs a lease that releases before finality and an
owner for its fee bump.

---

## 2. Revised design

### 2.1 Single path — `submit() = dispatch() + out-of-lease poll`

Factor `submit()`'s pre-`resumeEntry` setup (`:355-395`) into `dispatch()`. `submit()` becomes
`dispatch()` followed by a poll to finality **outside** the lease. One nonce-allocation and
replay-check implementation; `submit()`'s external contract unchanged for the other four call sites.

This is stronger than v1's two-path design and kills three hazards at the root: path divergence,
the `pendingSubmissions` drain re-driving a dispatched input through the blocking path with the
wrong return contract (`:819-827`), and two writers racing `putVersion`'s increasing-fee check
(`:98-102`).

`dispatch()` returns `dispatched | finalized | parked`, or throws. Explicit invariants:
- **MUST** use the same `this.lease` field.
- **MUST NOT** enter `pendingSubmissions` — covering both the pre-lease check and `PARK_OUTSIDE_LEASE`.
- Existing non-terminal entry ⇒ **rebroadcast newest once, return `dispatched`**. Never `resumeEntry`.
- First-broadcast `nonceTooLow` is **not** benign (unlike a rebroadcast, `:643`) — it means
  allocation was wrong. Classify immediately rather than reporting success for a transaction that
  can never mine.
- Repeated first-broadcast failure **escalates to quarantine**. v1 deleted the fail-stop: with the
  settler out of gas, legs would allocate N…N+7, all fail, and pile up unbounded, where today
  `submit()` quarantines at the budget.

### 2.2 `dispatchMany(inputs)` — lease once per cohort

One quarantine check, one nonce read, one fee read, N signs, N outbox writes, N broadcasts, release.
Highest-leverage change available: cuts the spread to roughly one block, moves any lease contention
to before-or-after the cohort instead of inside it, and halves H4/H5. Costs nothing the per-leg
design did not already pay.

### 2.3 `maintain()` — bounded, scoped, and inert under quarantine

v1's version was a bump loop with no exit: a nonce that cannot mine would be re-signed every
60–90 s forever, no alarm, every later nonce dead behind it — strictly worse than today's bounded,
operator-visible failure. Revised:

- **Per-entry deadline sourced from durable outbox data** (`versions[0].createdAt`), so it survives
  restart, and on expiry it quarantines via the same path `resumeEntry` uses (`:680`).
- **Scope: journal-known pool-payout entries.** Rebroadcast unconditionally; bump only with a signer.
  ("Retained signers only" means a restart leaves nothing rebroadcasting at all, since `classifyNonce`
  is read-only and `recoverOutbox` runs once.)
- **Honors `suppressedPoolLogicalIds`** — as `recoverOutbox` does (`:470-472`); otherwise it can
  resurrect a leg whose ledger transfer was deliberately invalidated.
- **Fully inert while quarantined.** Otherwise it bumps a nonce whose disposition an operator is
  deciding and can perpetually outbid `resolveQuarantine`'s cancel (`:543-577`) — turning the escape
  hatch into a bidding war against our own timer.
- **Version cap per entry**, then escalate rather than sign bump #200 (each is a whole-file fsync).
- **Signers rebuilt from durable state**, not in-memory only: the settler wallet is reconstructed
  identically every boot (`index.ts:202`) and the payload is in the journal, so a pool-payout signer
  is a pure function of durable data (`EvmChainRail.ts:203-209`).
- **Takes the lease only for sign+putVersion**, never across the rebroadcast RPC, and must try-lease
  rather than block — it runs inside `reconcileNetwork`, which holds the NETWORK lock (R12).

### 2.4 H7 — the mandatory fix. Pre-mine must not mean operator review

`classifyNonce` cannot distinguish "broadcast 2 s ago, not yet mined" from "lost forever" — both are
`uncertain` (`:426-427`) — and `applyVerdict`'s else branch writes journal `uncertain`
(`PoolPayoutQueue.ts:1147-1150`), which `deriveGroupState` promotes to a group state of `uncertain`
(`:1157`). That state is never pruned, is a hard error on the claim path, and is the sole entry to
operator disposition.

Today it fires only after a crash. **Under dispatch it fires whenever a reconcile pass lands inside
the mine latency** — a large fraction of healthy windows at a 30 s cadence. It self-heals next pass,
but every occurrence flaps a group into `audit:pool-payout-uncertain` and churns generations. Alarm
fatigue is how the manual-recovery design dies.

Fix: persist a dispatched-at timestamp and require a grace age (or a distinct young-entry verdict)
before `uncertain` may reach the journal. **Not optional — without it this ships a false-alarm
generator.**

### 2.5 Parked must not count as an attempt (frozen R1)

`flushLeg` increments `attempts` before the rail call (`:933-937`) and `maxAttempts` (default 3)
forces the leg `uncertain` (`:1001`). Today a park suspends the promise so it increments once. With
`dispatch()` returning `parked`, every window retries and increments — a quarantine lasting three
windows converts every queued leg on the rail into operator-disposition `uncertain`. **That is a
refusal by another name**, and the frozen rule is delay, never refuse. Parked ⇒ no attempt
increment, leg returns to `queued` byte-identical (frozen R4).

### 2.6 R12 — the production bug this also fixes

**Verified at runtime, not read:** a parked submit mid-flush pins the network lock. `flushNow` holds
the lock (`:466`), `flushLeg` awaits the rail call, and `park()` settles only on operator action, so
`.finally(() => this.schedule(network))` (`:1518`) never runs. A probe with two groups, the second
parking, showed the flush never settling **and a later flush on the same rail never settling
either**. One quarantine freezes that rail's payouts, claims, reconciles, and `maxHoldMs` deadline
accounting — turning a privacy delay into a permanent hold. `dispatch()` returning `parked`
synchronously fixes this flavor; §2.3's try-lease prevents the new one.

### 2.7 R13 — fence all four writes

v1 fenced only the `broadcasting` transition. `flushLeg` has four ungated journal writes: `:929`,
`:934-937`, and both error paths `:995-1011`. Today the network lock is the real fence; under
dispatch a leg's lifecycle spans many lock acquisitions. Gate all four, and state the
lock-held-between-plan-and-bookkeeping invariant explicitly.

### 2.8 Recovery must be cohort-aware (H8)

`recoverOutbox` walks every non-terminal entry under one shared 15 s budget and, on exhaustion,
quarantines and `return`s — abandoning the rest (`:465-499`). That is sized for at most one entry in
flight. Under cohorts, 8 pre-mine entries at a routine deploy makes budget exhaustion the LIKELY
outcome, and `suppressedPoolLogicalIds` is in-memory so the existing skip does not help. Young
`broadcasting` pool entries must be classified once and skipped, not polled to completion.

### 2.9 Reporting must see temporal partitions (H11)

R8 computes realized k_eff over members that *landed*, not members that landed *together*
(`:865-895`). A nonce gap, a cross-kind wedge, or a quarantine-park splits a cohort into two visually
distinct on-chain clusters while the claim still reports full K. Persist per-member landing block and
annotate realized k_eff with landing spread — otherwise "targeted cohort size K" quietly becomes
"reported cohort size K" on exactly the windows where it was not.

### 2.10 Solana

No structural split needed: `poolTransferStatus` is a single `getSignatureStatuses`
(`SolanaX402Facilitator.ts:305`), not a wait — v1's §2.4 premise was wrong. Residual spread is
per-leg prepare/broadcast RPCs, ~1–3 s at `maxLegs` 3. **Open question to resolve before freezing:**
`flushLeg` polls status immediately after broadcast (`:979`); if a just-broadcast signature is not yet
visible, what verdict returns? If it maps to `uncertain`, Solana already suffers the H7 flap today
and the §2.4 grace-age fix must cover both rails.

---

## 3. Tests (assert on `provider.broadcasts` and journal state, never promise resolution)

1. **A reconcile pass between dispatch and mining leaves the leg `broadcasting`, not `uncertain`** —
   the test the v1 design fails.
2. **Invert test 12** — A mined-but-not-final, assert B's dispatch broadcasts anyway.
3. **Cross-kind lease sharing** — concurrent `submit()` (x402) and `dispatch()` (pool payout) on one
   instance.
4. **Gap liveness without false alarms** — A never mines, B behind it; maintain bumps A within N
   passes, both land, B never transits journal `uncertain`.
5. **Restart with a full cohort pre-mine** — 8 `broadcasting` entries, recovery completes without
   quarantine.
6. **`maintain()` skips a suppressed logicalId.**
7. **Parked leg: attempts unchanged, state `queued`, byte-identical.**
8. **Concurrent dispatch allocates consecutive nonces**, no gap or duplicate.
9. **Double-dispatch of one logicalId** returns idempotently without a fresh sign (which would hit
   the increasing-fee check and throw on the retry path meant to be safe).

---

## 4. Deferred, acknowledged

- **H14 — outbox growth is now load-bearing.** Never-pruning is what makes `highWater` monotonic, but
  8 legs/window forever means every write re-encrypts and fsyncs a growing file. Survivable with a
  durable high-water scalar plus pruning of terminal entries. Not this increment; the trajectory is
  acknowledged.
- Chain-atomic dispersal via a purpose-built owner-checked contract (§1's rejection of Multicall3
  does not rule this out — it rules out the shortcut).
- Spend-side residual: recipients sweep stealth outputs at owner-chosen times, which can re-partition
  a cohort after the fact. Caps what landing tightness buys.
