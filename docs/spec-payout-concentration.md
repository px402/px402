# FROZEN SPEC v1 — Payout concentration (`k_eff` gating, release jitter, disclosed windows)

Status: FROZEN v1 (drafted from an adversarial review whose every code claim was independently
verified against the live tree — see §0). Hand verbatim to a Codex implementation agent.
TypeScript strict, no new dependencies, never print secrets, match existing conventions.

## Thesis (binding — read before any code)

**You cannot manufacture cover traffic on a transparent account model. You can only concentrate
the crossings you already pay for.**

Every mitigation in this spec is worth exactly what it does to the number of *simultaneous
boundary-crossing events*. Nothing else moves the needle. The rejected alternative (a churning
pool-controlled note set) failed because notes cannot hold native gas, so the settler must relay
every note move, so the entire note set is labelable with a single query and every churn edge is
intra-cluster and removable with one predicate. See §0.2.

Consequences that shape the whole design:

1. **Privacy is bought with latency, not gas.** Latency is paid by the user and **cannot be
   retroactively revoked**. A gas subsidy can be cut tomorrow, which retroactively shrinks the set
   for everyone still in flight. This wave therefore introduces **no recurring operator spend**.
2. **Delay, never refuse.** Refusing a payout on thin privacy converts a privacy feature into a
   liveness hazard and hands an attacker a denial vector (thin the window → block payouts).
3. **The operator is the strongest adversary, and it is under-defended.** See §0.3 (A1).

---

## 0. Review record

### 0.1 Verified claims (all independently confirmed against the live tree by the integrator)

| Claim | Evidence | Verdict |
|---|---|---|
| `PoolPayoutQueue` shuffles legs **across concurrent groups** before serial submission | `PoolPayoutQueue.ts:406` `shuffle(candidates, this.random)` over `journal.list()` flatMapped legs | CONFIRMED — the only existing mechanism that survives cluster filtering |
| Flush delay is **exactly** `flushMs` when jitter is 0 | `PoolPayoutQueue.ts:660` `delay = this.flushMs + Math.floor(this.random() * (this.maxJitterMs + 1))` | CONFIRMED |
| `poolPayoutMaxJitterMs` defaults to **0** | `config.ts:158` | CONFIRMED |
| `poolPayoutFlushMs` defaults to **60_000** | `config.ts:157` | CONFIRMED |
| Quarantine threshold is attempt-count based | `PoolPayoutQueue.ts:482` `attempts >= this.maxAttempts` | CONFIRMED |
| `singlePlan` publishes the **exact raw value** on-chain | `denominations.ts:192-196`, `denominationAtomic:null`, `kind:"exact"` | CONFIRMED — live leak, owned by `spec-payout-offchain-change.md` |
| Solana `maxLegs` = 3, EVM = 8 | `denominations.ts:3-4` | CONFIRMED |
| Enumeration ceiling is `maxLegs` = 10 | `assertEnumerationBound` `denominations.ts:257-269`, `chooseBounded(maxLegs+|D|, |D|, 200_000)`; C(20,10)=184,756 passes, C(21,10)=352,716 throws | CONFIRMED |
| No `closeAccount` anywhere → Solana ATA rent accretes | zero matches across `src/` + `scripts/` | CONFIRMED |
| `settler == treasury` is a hard invariant, degrading to `dry-run` | `EvmChainRail.ts:32-42,61-69`; `SolanaChainRail.ts:25-33,52-58` | CONFIRMED |

### 0.2 Rejected design (recorded so it is not re-proposed)

**Churning note set — REJECTED.** Pool becomes N denominated notes at one-time stealth addresses,
churned pool→pool at constant rate as manufactured cover.

Attack, in four steps, all deterministic (no statistics):
1. `C_relay` = the settler EOA per chain — trivially identified as `tx.from` on every protocol tx.
2. `C` = closure of every address appearing in a transfer inside a tx with `tx.from ∈ C_relay`.
   Because notes hold no native gas *by design*, **every** note move is settler-relayed, so this
   captures the entire note set on the first hop.
3. Delete every edge where `from ∈ C AND to ∈ C`. Every churn hop matches. Remaining graph is
   identical to the no-churn case. Cost to us: full gas burn. Cost to the analyst: one predicate.
4. Flow conservation: churn is balance-preserving inside `C`, contributing zero to the public
   inflow/outflow series, regardless of churn rate.

Terminal-behavior labeling closes it: churn destinations *must* later emit a settler-relayed
transfer; real payout destinations are swept by the user. After one residence window destinations
partition cleanly.

**The structural result — and the reason no cheaper variant works: the property that makes notes
lossless (settler pays for everything) is exactly the property that makes them clusterable.** Our
own tree already states the mechanism at `scripts/x402-stealth-sweep.mjs:133` ("settler gas-funding
links the pool to the stealth address") with the funding transfer at `:180`. That is not a demo
artifact; it is the attack.

Also rejected, with reasons:
- **Cross-chain rebalancing as cover** — destinations are bridges/CEX/OTC, all vendor-labeled as
  not-a-fresh-stealth-address. It additionally *reveals* per-chain flow imbalance, which sizes the
  user base. Anti-cover.
- **Re-deposit loops** — a re-deposit is a settler-relayed sweep that pulls the exit destination
  back into `C`, converting a clean exit into a labeled round-trip. The churn mistake one level out.
- **Boundary-crossing decoys** — these *do* survive the cluster filter, and gas is affordable
  (k=10 at 100 exits/day ≈ $4.50/day on Base). The binding constraint is the **funding leg**: each
  decoy needs gas from a source untraceable to the settler, i.e. *n* independent funding identities
  with independent histories. At scale, deliberately manufacturing unlinked financial identities is
  structuring. **Do not build this.** Funding decoys from one alternate relayer merely creates `C2`
  and buys the analyst one more predicate.

### 0.3 Findings promoted to blockers in this wave

- **A1 — Operator active isolation (highest severity; previously unweighted).** With
  server-controlled flush and `maxJitterMs = 0`, a malicious or coerced operator manufactures
  `k_eff = 1` for any chosen victim by delaying every other group's legs. No cryptographic break,
  no on-chain signature distinguishable from normal operation, and it defeats every other mechanism
  in this spec. Mitigations: §5 (client-chosen release window), §6 (committed schedule), §4
  (return realized `k_eff` so the victim can detect it).
- **A2 — Timing oracle (verified).** With jitter 0, `chain_landing_time − flushMs` = the private-RPC
  request arrival time to within broadcast latency. Combined with the WireGuard peer set this
  narrows the requester hard. §3.
- **A3 — Live-metric publication is itself an attack signal.** Publishing current thinness tells an
  attacker exactly when to strike. §7.

---

## 1. Scope

**In:** the `k_eff` metric, delay-not-refuse flush gating, non-zero jitter default, client-declared
release windows, disclosed delay caps, `k_eff` returned on claim, lagged aggregate publication, and
the quarantine-interaction fix.

**Out (explicitly):**
- Off-chain change / the `singlePlan` exact-value leak → `spec-payout-offchain-change.md` (§11).
- Solana `maxLegs` 3 → 8 → §11, after the free changes; it carries real per-payout rent.
- Threshold/MPC settler — **real custody value, zero privacy value.** Ship it; never market it as
  privacy. Attach point exists: `TransactionCoordinator.submit` already isolates signing behind
  `sign: async (fees) => ...`.
- TEE, split-operator (non-colluding validate/debit vs schedule/broadcast), ZK commitment tree.
  All are the honest long-term answers to §0.3 A1 and none are this wave.

**No new dependencies. No recurring operator spend. Every behavior flag-gated, default off or
default-preserving.**

---

## 2. The `k_eff` metric (normative)

Defined over what the analyst actually computes, per network, per flush window `W`.

- `L(W)` = multiset of all legs broadcast in `W`.
- `G(W)` = number of distinct payout groups contributing at least one leg to `W`.
- `A(ℓ)` for leg `ℓ ∈ L(W)` = number of distinct groups in `W` that could have produced a leg of
  `ℓ`'s exact `denominationAtomic`. **Denomination-conditioned** — a leg only hides among legs of
  the same denomination.

**Primary metric — `k_eff(W) = min over ℓ ∈ L(W) of A(ℓ)`.**

Rationale (binding): the analyst attacks the weakest leg, and one identified leg usually identifies
its whole group, because the remaining legs must satisfy `group_total − identified_leg` under
`≤ maxLegs`. Averages are misleading here; the minimum is the security parameter.

**Secondary metric — `P(W)`** = the number of distinct ways to partition `L(W)` into `G(W)` valid
plans (each `≤ maxLegs`, each summing to a quoted total). Report `log2 P(W)` as bits of ambiguity
in the group→total mapping. Exactly computable server-side; bounded by `maxLegs ≤ 8`. Compute with
a memoized bounded partition search and a hard node cap reusing the `ENUM_CAP` discipline from
`denominations.ts:257-269` — on cap exceedance report `log2 P` as `">= cap"`, never throw.

**Degenerate cases, normative:**
- `L(W)` empty ⇒ `k_eff = 0`, no gate evaluation, no broadcast.
- `strategy:"single"` legs have `denominationAtomic == null`. A null-denomination leg is
  **conditioned on itself alone**: `A(ℓ) = 1` always. This is correct and intentional — an exact
  non-standard value hides among nothing. It makes `k_eff(W) = 1` whenever any single-leg plan is in
  the window, which is the honest reading and the strongest possible argument for §11's off-chain
  change work.

---

## 3. Jitter default (smallest diff; do first)

`config.ts:158` — `poolPayoutMaxJitterMs` default `0` → **`30_000`** (half of the `flushMs`
default, giving a meaningful smear without doubling worst-case latency).

- Formula at `PoolPayoutQueue.ts:660` is unchanged and already correct.
- **Buys:** destroys the deterministic `landing − flushMs` offset (A2).
- **Does not buy:** any increase in set size. A jittered lone leg is still a lone leg. **Jitter
  fixes an oracle; only concurrency fixes the set.** Do not let it be reported as the fix.
- Invariant risk: none — same code path, bounded, per-group timer.
- `validateDuration` already guards the value (`PoolPayoutQueue.ts:113`); confirm `maxJitterMs`
  is validated the same way and add it if not.

---

## 4. Flush gating — delay, never refuse

Attach point: `PoolPayoutQueue.flushNetwork` (`:398`), **immediately after
`shuffle(candidates, this.random)` (`:406`) and before the serial `for` loop.** This composes with
the existing per-network lock (`withNetworkLock`) with no new locking.

### 4.1 Algorithm

```
1. Gather candidates as today (queued legs, all groups, this network). Shuffle as today.
2. If candidates is empty -> return (unchanged).
3. Compute k_eff over the candidate multiset (§2).
4. If k_eff >= kEffTarget            -> proceed to the submission loop unchanged.
5. Else, for each candidate group g:
     held(g) = now - g.firstQueuedAt
     if held(g) >= maxHoldMs(g)      -> g is RELEASE-FORCED (must broadcast this pass)
     else                            -> g is HELD
6. If every group is HELD            -> broadcast nothing, reschedule, return.
7. If any group is RELEASE-FORCED    -> broadcast the RELEASE-FORCED groups' legs only,
                                        recompute k_eff over exactly that submitted subset,
                                        and record it as the realized k_eff for those groups.
8. Held groups remain state "queued", untouched, and are retried next window.
```

`maxHoldMs(g)` = the group's own declared cap (§5), clamped to `poolPayoutMaxHoldMs`.

### 4.2 Hard requirements

- **R1 — A privacy hold MUST NOT increment `leg.attempts`.** `PoolPayoutQueue.ts:482` quarantines
  at `attempts >= this.maxAttempts` (default 3). A hold is not a failed attempt. Conflating them
  quarantines healthy payouts within three windows. **This is the single highest-risk regression in
  this wave.** Held legs must not pass through `flushLeg` at all.
- **R2 — A hold MUST NOT count toward confirmation timeouts.** `poolPayoutConfirmTimeoutMs`
  measures from broadcast; a held leg has not been broadcast. Verify no timer starts at enqueue.
- **R3 — Holds MUST be bounded.** `maxHoldMs` is mandatory and finite. There is no unbounded hold
  and no configuration that produces one; validate at construction.
- **R4 — Recovery-safe.** A held leg is indistinguishable from a never-flushed queued leg on
  restart. No new journal state, no new generation-CAS interaction. If a `heldAt`/`holdCount`
  field is added it MUST be advisory-only and never gate correctness.
- **R5 — `onlyGroupRef` flushes bypass the gate.** `flushNetwork(network, onlyGroupRef)` is used by
  targeted/recovery paths; gating a single-group flush would deadlock it. Skip the gate whenever
  `onlyGroupRef` is set, and log that the release was ungated.
- **R6 — Never refuse.** No code path may terminate a payout for low `k_eff`. The only outcomes are
  *broadcast now* and *broadcast at `maxHoldMs`*.

---

## 5. Client-declared release window (mitigates A1)

Removes operator **discretion** over timing, extending the denominations-wave pattern (client
produces, server validates) from *plan shape* to *release timing*.

- The stealth-capable quote advertises: `flushMs`, `maxJitterMs`, `kEffTarget`, `maxHoldMs` ceiling,
  and `policyVersion`. Additive fields only.
- The signed payout intent gains an optional client-declared `maxHoldMs`. Bind it into the existing
  `px402-pool-payout/v2` canonical body and plan hash. **It must be inside the signature** — an
  unsigned hold cap is operator-editable, which reintroduces A1 exactly.
- Server validation (in `validatePlanAgainstPolicy`, alongside the existing checks): reject unless
  `0 < clientMaxHoldMs <= advertised ceiling`. On absence, use the server default. Follow the
  existing §7 style — hard-reject before any debit.
- **The cap must be disclosed before the agent commits**, and the ceiling must be a *policy
  constant*, not per-agent. An agent that always waits the maximum is otherwise distinguishable
  from one that does not, making the hold cap itself a side channel.

---

## 6. Committed flush schedule (mitigates A1)

The operator publishes a schedule commitment it cannot later deviate from undetectably:

- At startup, derive a per-network schedule seed. Publish `H(seed || epoch)` via the existing
  health/privacy surface.
- Reveal `seed` for epoch *e* after epoch *e* closes, so anyone can recompute the jitter draws for
  every window in that epoch and verify realized landings match.
- This does **not** prevent isolation; it makes systematic isolation **detectable after the fact**.
  Say exactly that and nothing stronger.
- Non-goal: consensus, external witnesses, or a transparency log. Those are the honest fix and are
  out of scope (§1).

---

## 7. Reporting `k_eff`

**On claim (per-agent, authenticated).** Add to the claim response the realized `k_eff` for the
window in which that group's legs actually landed, plus `heldMs` and `log2P` (or `">= cap"`).

This is the most honest feature in this wave: agents learn their **actual** anonymity set rather
than a marketing number, and it makes A1 victim-detectable. Return it only over the existing
owner-bound authenticated claim path (`PoolPayoutQueue.claim`, `:180`) — never on an unauthenticated
surface.

**Aggregate publication (A3).**
- Publish **only over already-settled windows**, aggregated as a daily histogram of `k_eff`, lagged
  by at least `poolPayoutClaimTtlMs` (default 15 min) **and** one full retention period.
- **Never publish live or near-live `k_eff`.** Live thinness is a strike signal.
- No per-group, per-agent, or per-window rows. Histogram buckets only.

---

## 8. Config (`config.ts`, under `agentRpc`)

| Env var | Default | Validation |
|---|---|---|
| `PX402_POOL_PAYOUT_MAX_JITTER_MS` | `0` → **`30_000`** | finite, ≥ 0, ≤ `flushMs × 4` |
| `PX402_POOL_PAYOUT_KEFF_TARGET` | `1` (gate inert) | integer ≥ 1 |
| `PX402_POOL_PAYOUT_MAX_HOLD_MS` | `900_000` (15 min) | finite, > `flushMs`, ≤ 24 h |
| `PX402_POOL_PAYOUT_CONCENTRATION_ENABLED` | `false` | boolean |
| `PX402_POOL_PAYOUT_KEFF_PUBLISH_ENABLED` | `false` | boolean |

`kEffTarget = 1` makes the gate a no-op (every non-empty window satisfies it), so the default
configuration is byte-for-byte the current behavior apart from jitter. **`flushMs` default is
deliberately unchanged in this wave** — raising it is an operator decision with a real latency
cost, documented in §10, not a silent default change.

---

## 9. Offline smoke plan (`scripts/payout-concentration-smoke.mjs`, `test:concentration`)

Deterministic via injected RNG and clock (both already injectable: `options.random`, `this.now()`).

1. **`k_eff` correctness** — hand-built windows with known minima, including all-same-denomination,
   mixed, and a `singlePlan` leg forcing `k_eff = 1`.
2. **Gate inert at default** — `kEffTarget = 1`: leg-for-leg identical broadcast order to a
   pre-change baseline under a fixed seed.
3. **Hold then forced release** — `kEffTarget = 4` with 1 group: held across windows, released
   exactly at `maxHoldMs`, `attempts` still `0` (**R1**), no quarantine.
4. **Concentration works** — 6 groups arriving inside one window: single pass, `k_eff ≥ 4`, no hold.
5. **Mixed forced/held** — some groups past `maxHoldMs`, some not: only forced groups broadcast;
   realized `k_eff` recomputed over the submitted subset only (§4.1 step 7).
6. **`onlyGroupRef` bypass** — targeted flush releases immediately under `kEffTarget = 99` (**R5**).
7. **Adversarial hold cap** — signed `maxHoldMs` above the advertised ceiling is hard-rejected
   before any debit; tampering with the cap post-signature fails the plan hash.
8. **Recovery** — restart with held legs: no duplicate broadcast, no rebroadcast of settled legs,
   generation CAS intact (**R4**).
9. **Jitter** — over many draws, delays occupy `[flushMs, flushMs + maxJitterMs]` and are not
   constant (A2).

---

## 10. Operator runbook

- **`flushMs` is the primary concentration lever and it is not touched by default.** Expected
  co-flushed population ≈ arrival rate × `flushMs`. At `60_000` and bootstrap volume that is ≈ 0, so
  the existing cross-group shuffle is currently decorative. 60 s → 1 h multiplies expected co-flush
  population ~60×. **The cost is user-visible latency and nothing else — no gas, no capital.**
- Recommended rollout: (1) jitter on; (2) `k_eff` computed and logged with `kEffTarget = 1`
  (observe only); (3) raise `flushMs` deliberately; (4) raise `kEffTarget` once the observed
  histogram supports it; (5) enable lagged publication.
- **The strongest privacy in the system is not on this path at all.** Agent↔agent
  `/private/a2a/private-pay` is a pure ledger transfer with **zero on-chain footprint and zero
  boundary crossing**. Every participant who settles internally instead of exiting removes a
  crossing entirely. Unlike any manufactured scheme, this gets *cheaper* as it scales. Onboarding
  counterparties is a business action with a larger privacy effect than anything in this spec.

---

## 11. Explicitly deferred, with reasons

- **`spec-payout-offchain-change.md`** — enabling `offchainChange` kills the `singlePlan`
  exact-value leak. Wire scaffolding is already complete (`offchainChangeAtomic` is in
  `canonicalPlanBody` `payoutPlan.ts:57` and the signed intent `x402AgentIntent.ts:115`; §7.2 at
  `:139` already validates `onchain + offchain === total`). **Two verified landmines that MUST be in
  that spec:**
  1. **§7.3 becomes unsatisfiable.** `payoutPlan.ts:144-147` requires
     `legs[0].amountAtomic === plan.totalAtomic` for `strategy:"single"`, while §7.1 requires
     `legSum === onchain`. With non-zero change these contradict, rejecting every
     single-leg-with-change plan. Must become `!== plan.onchainAtomic`.
  2. **The reversal path breaks per-asset conservation.** `payout()` debits and credits the *same*
     `amount` (`PrivatePaymentLedger.ts:665-666`) then `assertConserved` (`:681`). With change you
     need `payer -= total; escrow += onchain; payee += offchain`, but `payout()` never resolves a
     payee ref, and reversal (`:915-926`) returns the single `reversalAmountAtomic`. **The break is
     on the error path — the least-tested code in the system.**
  - Scope note: off-chain change requires a payee holding a ledger account, so it helps agent↔agent
    payments only. Same lesson as §10 — the mechanism works precisely where value does not cross.
- **Solana `maxLegs` 3 → 8.** Safe ceiling is exactly 10 (§0.1). Each added leg costs a fresh ATA at
  `2,039,280` lamports, treasury-paid (`SolanaX402Facilitator.buildPoolTransfer:392-399`) and
  **non-recoverable** — no `closeAccount` exists. Better-justified than churn (it buys amount
  privacy on real traffic) but it is a priced product decision, not a silent default bump.
- **Threshold/MPC settler, TEE, split-operator, ZK.** §1.

---

## 12. Honest privacy statement (for `CLAUDE.md`, verbatim on merge)

> **Payout concentration.** Pool payouts are grouped in a flush window and their legs are shuffled
> across all concurrent groups before submission, so a leg's anonymity set is the other legs of the
> same denomination landing in the same window. The server measures this directly as
> `k_eff` — the minimum, over legs in a window, of the number of distinct groups that could have
> produced a leg of that denomination — and returns the realized value to the paying agent on its
> authenticated claim. When `k_eff` is below target the window may be **held** up to a
> client-declared, signature-bound, disclosed-in-advance `maxHoldMs`, after which it broadcasts
> regardless. **A payout is never refused for thin privacy**, and a privacy hold never counts toward
> attempt-quarantine or confirmation timeouts.
>
> *What this buys:* concurrency at the only point an observer cannot filter — the boundary where
> value leaves the pool. It is paid in latency, not gas, and therefore cannot be retroactively
> revoked by cutting an operator subsidy.
>
> *What it does not buy:* anything against the operator, which sees every request as it is
> processed and — with server-controlled timing — could manufacture `k_eff = 1` for a chosen victim
> by delaying others. Client-declared release windows, a committed-and-revealed jitter schedule, and
> returning realized `k_eff` make that **detectable, not impossible.** Amounts, leg counts, timing,
> and the fact that the pool paid someone remain public. A `strategy:"single"` leg publishes its
> exact value and has `k_eff = 1` by construction until off-chain change ships. Manufactured cover
> traffic is **not** used: operator-relayed decoys are removable with a single intra-cluster
> predicate, and independently-funded decoys are not something we will build. Concentration is the
> honest mechanism available without zero-knowledge proofs, and the strongest privacy in the system
> remains the agent↔agent ledger path that never touches a public chain at all.

---

## 13. Open questions

1. Epoch length for the §6 commit-reveal — long enough to be cheap, short enough that
   after-the-fact detection is useful.
2. Whether `log2 P(W)` is worth computing in production or is a diagnostics-only metric.
3. ~~Whether `maxHoldMs` should be quantized~~ — **DECIDED 2026-07-30: yes, but not yet, and it is
   lower priority than it looks.** A free-form integer is a per-agent fingerprint bound into every
   signed plan, so a ladder (1 m / 5 m / 15 m / 1 h / 6 h / 24 h, rounding **down** so a client
   never gets a longer hold than it declared) is the right end state. Two reasons it is not
   implemented here: enforcement requires **advertising** the ladder on the quote, so it is a change
   to the signed-plan wire and the quote surface, not a local validation tweak; and the leak only
   exists for clients that declare a custom cap at all — **absent is the common case and carries no
   fingerprint**, so the honest mitigation available today is documentation: *do not declare a
   custom `maxHoldMs` unless you actually need one.* Implement with the next planned change to the
   plan wire rather than as a standalone break.

---

## 14. Adaptive `k_eff` target — IMPLEMENTED (correct at user #1)

### 14.1 The defect this fixes

`kEffTarget` was a static integer. Set it above 1 on a deployment with no concurrent traffic
and **every window is held to `maxHoldMs` waiting for cover that will never arrive** — pure
latency, zero privacy. The only protection was an operator remembering not to raise it, and
the only way to benefit later was an operator remembering to raise it. Both are wrong: the
protocol has to be correct at user #1 and improve *by itself* as users arrive.

This is the general shape of the requirement the whole privacy stack is judged against:

> **Nothing may be worse than useless when we are small, and nothing may require an
> operator action to become useful when we are not.**

### 14.2 Mechanism (normative)

`adaptiveKEffTarget` (pure, `src/shared/payoutConcentration.ts`) derives the target from
concurrency the system has **actually demonstrated**, bounded above by it:

- Evidence is the **pre-gate `windowKEff`** of each evaluated window — natural arrivals,
  not our own holding — retained for `windowMs` in a bounded buffer.
- **Invariant 1 — insufficient evidence ⇒ 1.** Below `minSamples` observations the target
  is 1, which `planWindowRelease` treats as inert. This is the N=1 guarantee.
- **Invariant 2 — never exceeds the observed quantile.** `floor()` of the q-quantile,
  clamped to `[1, ceiling]`, so the gate can never demand concurrency that has not occurred
  and therefore can never stall the queue.
- The target **falls** as well as rises: samples age out of `windowMs`, so a deployment that
  goes quiet returns to inert on its own.

`ceiling` is an upper bound the gate may work *toward*. It is never itself a target — a fresh
deployment with adaptive ON and a ceiling of 8 still runs at 1.

Held groups remain candidates in later windows and so feed back weakly into `windowKEff`.
The ceiling and each group's `maxHoldMs` bound that in both directions, and the default
quantile (0.5) keeps the target tracking rather than leading.

### 14.3 Config

| Var | Default | Meaning |
|---|---|---|
| `PX402_POOL_PAYOUT_KEFF_ADAPTIVE` | `false` | on ⇒ the derived target replaces the static one |
| `PX402_POOL_PAYOUT_KEFF_CEILING` | `8` | upper bound only; never a target |
| `PX402_POOL_PAYOUT_KEFF_ADAPTIVE_WINDOW_MS` | `21_600_000` | evidence retention (6 h) |
| `PX402_POOL_PAYOUT_KEFF_ADAPTIVE_MIN_SAMPLES` | `20` | observations before the target may exceed 1 |
| `PX402_POOL_PAYOUT_KEFF_ADAPTIVE_QUANTILE` | `0.5` | quantile of observed concurrency to demand |

### 14.4 Transparency

`PoolPayoutQueue.concentrationStatus()` reports the **resolved** posture on `/api/privacy`
under `poolPayoutConcentration.gate` — and unlike §6/§7 it is **always present**. An operator
must be able to distinguish three states that otherwise look identical from outside:
the gate is off; the gate is on but inert because nobody else is transacting
(`inertReason: "insufficient-observations"`); the gate is live and holding. Aggregate only —
no per-group, per-agent, or per-window rows.

### 14.5 Verified

`npm run test:concentration` — 38/38, of which eight are §14: both invariants, quantile
selection, decay when traffic stops, and two queue-level proofs — a lone payer broadcasts in
its first window with a ceiling of 8 (no latency tax), and after three observed `k_eff = 2`
windows the target raises itself to 2 and begins holding thin windows **with no config change
and no redeploy**, still force-releasing at `maxHoldMs` (delay, never refuse). No regression:
`test:pool-payout` 48/48, `test:denominations` 32/32, `test:x402` 46/46.
