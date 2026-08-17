# SPEC v1 — Denomination-pure exit cohorts

Status: v1, rewritten from DRAFT v0 after three independent adversarial reviews (Codex, Grok,
Fable) **rejected v0 as written**. Every code claim below was read against the live tree on
2026-07-31. Extends — does not replace — `spec-payout-concentration.md` (FROZEN v1) and inherits
its thesis verbatim.

**The v0 → v1 headline:** v0 assumed an in-memory selection of `K` legs was an atomic on-chain
round. It is not. The live queue prepares, broadcasts, finalizes, retries, and recovers legs
**individually and serially**, so a v0 "round" would have landed as `K` transfers separated by
blocks and minutes — no cohort, no `k_eff = K`, and a claim response that said otherwise. v1 is
built around fixing that (§5) and around the discovery that the untiled majority of withdrawals
**mechanically disables** the whole mechanism (§3).

---

## 0. Review record

### 0.1 Verified against the live tree (by the integrator, not taken on trust)

| Claim | Evidence | Verdict |
|---|---|---|
| Submission is serial and finality-blocking | `PoolPayoutQueue.ts:526` `for (…) await this.flushLeg(…)`; `EvmChainRail.submitPoolPayout:170,198` awaits `TransactionCoordinator.submit`, which returns only after `resumeEntry` finalizes | **CONFIRMED — fatal to v0** |
| `k_eff` counted quote nonces, not people | `payoutConcentration.ts:40` added `leg.groupRef`; `groupRef === quote.requirements.nonce` (`PrivateAgentRegistry.ts:846`); zero rate limits on enqueue | **CONFIRMED — live P0, FIXED `ac917b8`** |
| Adaptive evidence is one global pool | `PoolPayoutQueue.ts:152` single `concurrencySamples`; written per-network at `:580`; `effectiveKEffTarget(nowMs)` at `:909` takes **no network** | **CONFIRMED — live defect, parity break** |
| Solana tiles only ~17% of values | real `decomposePayout`, default 10-tier set, `maxLegs=3`: 37 and 137 USDC both emit `EXACT`; same values tile into 7–8 legs on EVM | **CONFIRMED** |
| EVM is not safe either | largest denomination 100 × `maxLegs` 8 ⇒ hard ceiling 800 USDC; coverage collapses to ~49% across 0.1–800 | **CONFIRMED (Fable)** |
| `relayDeposit` is EVM-only | optional at `ChainRail.ts:112`, implemented only at `EvmChainRail.ts:89`, `PrivateAgentRegistry.ts:1618` throws on Solana | **CONFIRMED** |
| No `closeAccount` anywhere | zero matches in `src/`; `SolanaX402Facilitator.ts:448` creates ATAs and nothing closes them | **CONFIRMED** |
| `maxHoldMs` is genuinely signature-bound | enters `canonicalPlanBody` `payoutPlan.ts:58,82` ⇒ inside `planHash` ⇒ inside the v2 intent signature | CONFIRMED |
| Held legs never reach `flushLeg` | gate returns a filtered array `:603`; no `attempts`, no journal write, no CAS | CONFIRMED (R1/R2/R4 intact) |
| `realizedConcentration` is in-memory only | `PoolPayoutQueue.ts:165`; absent after restart | CONFIRMED |
| `flushLeg` writes `broadcasting` without `expectGen` | `PoolPayoutQueue.ts:618` | CONFIRMED |
| Live gate posture is on a PUBLIC surface | `/api/privacy` at `createHttpServer.ts:122,150` exposes `effectiveTarget` + observation count | CONFIRMED |

Doc drift found: the frozen spec's anchors `flushNetwork:398`/`shuffle:406`/`attempts:482`/`claim:180`
are now `507`/`515`/`672`/`288`. `TransactionCoordinator` lives in `src/server/base/`, not
`src/server/payments/`.

### 0.2 Rejected designs (recorded so they are never re-proposed)

**Self-payout "fake-out" cover — REJECTED by all three reviewers.** The operator asked for it; it
does not work for this product. Reasons, strongest first:

1. **Closed-cycle matching needs no labeling.** A cover output traces `pool → S (d)`, later
   `S → D (d)`, later `D → pool (d)`. The token amount is preserved exactly, so the return edge from
   `S` is a deterministic cycle label. Re-laning or delaying the reclaim only changes its timestamp;
   the edge remains.
2. **It is backwards for the product.** Real *external* withdrawals leave the pool cluster
   permanently; cover always returns. The more frequent the external exits — the stated
   requirement — the cleaner the partition. Cover inflates the anonymity set of money going in
   circles, not of money leaving.
3. **v0's central argument was EVM-only and false.** v0 claimed cover and real payouts are
   indistinguishable because both are settler-swept via the gasless relay. There is no relay on
   Solana at all (`:1618` throws), so the argument never held on one of three mandatory rails.
4. **It violates the frozen thesis.** Frozen §1 forbids recurring operator spend. Cover adds
   recurring gas plus **non-recoverable** Solana ATA rent (`:448`, no `closeAccount`). "Working
   capital, not operator capital" does not cover gas and rent, which are simply spent.
5. **A constant residence time is a free classifier.** A fixed `COVER_RECLAIM_MS` gives cover a
   narrow residence-time mode; real sweeps are arbitrary. One histogram separates them, retroactively
   over all history, before any graph analysis.
6. **Multiple cover groups from one cover account are one actor**, and after the §2 owner fix they
   correctly count as one — so cover cannot raise `k_eff` without many funded cover *accounts*,
   which is manufacturing unlinked financial identities, i.e. the structuring the frozen spec
   already refused.

*Not built. Not built flag-off.* Dormant value-moving code is still a surface, and a flag an
operator can enable is a claim we would have to defend.

**Large-withdrawal temporal splitter — DEFERRED.** Negative value at current traffic (spreading one
group's legs across `w` windows at lane occupancy 1 converts one `k_eff = 1` window into `w` of
them), it cannot be honestly reported by a group-level scalar, it is the sole reason v0 needed
per-leg release, and the exact-residue leak dominates any gain. Revisit only after §3 and §5.

**Coarsening the denomination ladder — REJECTED, and this reverses an earlier recommendation.**
Both Grok and Fable initially proposed fewer tiers to raise per-lane arrival rate; both retracted
after measurement, as did the integrator. Fewer lanes does raise λ per lane, but tileability
collapses far faster, and an untiled value publishes its **exact amount** at `k_eff = 1`. Measured
on the real `decomposePayout`: dropping 10 tiers → 3 cuts the volume needed for `k_eff ≥ 2` by only
~2.4× while driving the exact-leak rate from 5.5% to ~71%. The current 1-2-5 ladder is near-optimal
for tileability. **Dilution is real; the fix is longer shared windows, not fewer tiers.**

---

## 1. Thesis (binding)

1. **A cohort is only a cohort if it lands as one.** Anonymity comes from transfers an observer
   cannot separate. Legs separated by finality waits are separable by block height, so they are not
   a cohort no matter what the scheduler intended. This is the property v0 lacked and v1 exists to
   provide.
2. **Report what landed, never what was planned.** Realized privacy is computed from members that
   actually settled, after classification. A planned-subset number is a lie on the one channel whose
   entire purpose is honest self-assessment.
3. **Anonymity is counted over paying accounts, never over groups.** Groups are an accounting
   artifact and are unmetered.
4. **The unit of privacy is the lane** `(network, asset, denominationAtomic)`. Evidence and targets
   are lane-local. A rail or a denomination may never inherit another's concurrency.
5. **Delay, never refuse** (frozen R6), and **correct at N=1** — target 1 until *that lane* has its
   own evidence. At N=1 the honest claim is `k_eff = 1` and a prompt withdrawal, not a synthetic `K`.
6. **Parity is enforced, not asserted.** Where the three rails cannot match, startup fails or the
   difference is a disclosed constant. No silent gaps.

---

## 2. Already landed (v1 increments 0a/0b, merged)

- **`ac917b8` — `k_eff` counts distinct `ownerRef`** (the ledger account), not `groupRef`.
  `ownerRef` is **required** on `ConcentrationLeg`, so omitting it is a compile error rather than a
  silent downgrade. The old fixtures had encoded the attack as desired behavior (every group used
  one hardcoded payer); they now drive distinct funded payers. Regression test asserts four groups
  from one owner is 1, four owners is 4, mixed is 3. `test:concentration` 39/39.
- **`6356522` — `largestTileableAtMost`** in `denominations.ts`, additive and unwired. 811/811
  including brute-force maximality against an independent enumeration.

---

## 3. Tileability is a PREREQUISITE, not a follow-up (increment 1)

**Why it comes first — the mechanical argument, which is stronger than the coverage argument.** A
`singlePlan` leg carries `denominationAtomic: null`, which `anonymityByLeg` conditions on itself
alone (`A = 1`), which forces `computeKEff` to 1 for the whole window, which is the evidence fed to
the adaptive target. So untiled withdrawals do not merely fail to benefit from cohorts — **they pin
the target at 1 and disable the mechanism for everyone.** On Solana that is ~83% of traffic. Ship
cohorts first and they ship as dead code.

### 3.1 Client-side quantization (all three rails)

The withdrawing agent already receives `denominationsAtomic` and `maxLegs` in its quote's
`payoutPolicy` (`PrivateAgentRegistry.ts:1976`) and already loads them
(`privateX402Client.ts:255`), then hands the raw value to `decomposePayout` and silently accepts an
exact leg. Instead it picks the largest tileable amount ≤ its request and leaves the remainder as
ordinary ledger balance.

- **Must be pre-quote.** `payoutPlan.ts:154` requires `total === quote.maxAmountRequired`, so a
  post-quote shrink is hard-rejected before any debit. This is a safety net, not an obstacle.
- **Accounting is untouched.** The residue is never debited, so the payout stays a two-way
  `payer -= onchain; escrow += onchain` and `reversePayout` returns exactly what was taken — which
  is precisely where frozen §11 records off-chain change breaking conservation on its error path.
- **Emitting an exact leg becomes an explicit, logged opt-in**, never a silent fallback.
- Measured: exact-leak 5.5% → **0%** on EVM at 0.06% average residue.

### 3.2 Solana leg cap and rent — CORRECTED (v1 draft §3.2 was wrong)

> **Retraction.** The first v1 draft said "implementing sweep-and-close makes the extra legs
> approximately free." **That is false and the reasoning behind it was wrong.** It cited
> `ConfidentialSlotBook.ts:48` as precedent; that line is a comment on a status union, and no
> production caller in `src/` ever transitions a slot past `reserve`. The frozen spec had it right
> all along (`spec-payout-concentration.md:340-343`: treasury-paid and **non-recoverable**).

**The operator cannot reclaim this rent retroactively — this is structural, not missing work.**
Every payout leg's ATA is funded by `treasury` (`SolanaX402Facilitator.ts:447-455`), and in on-chain
pool mode `treasury === settler` (`SolanaChainRail.ts:42-47`). But SPL `CloseAccount` sends the
lamports wherever the **authority** directs, and the authority is the ATA's owner — the one-time
stealth address, whose scalar is `kSpend + H(kView·R)`. The server holds only
`solanaStealthViewingKey`, explicitly "lets the server verify a pay-to-stealth **without spend**"
(`PrivateAgentRegistry.ts:81`). `SetAuthority(CloseAccount)` likewise requires the owner to sign, and
ATA-create takes no close-authority parameter. So there is no sequence of instructions by which the
account that *paid* the rent can recover it.

Consequences, stated precisely:

- **Today the rent is stranded, not burned and not transferred.** Nothing in `src/` or `scripts/`
  closes any payout ATA. It becomes the payee's only if the payee chooses to close (they can:
  they hold `kSpend`/`kView` and receive `R` from the inbox), which nets them ~2,034,280 lamports
  per leg. That is a live, unexercised rent-farming vector worth recording.
- **The incremental cost of 3 → 8 is 5 × 2,039,280 = ~0.0102 SOL per withdrawal** (~$2 at $200/SOL),
  permanently out of the treasury — a direct violation of the frozen "no recurring operator spend"
  thesis, which is why this is a **priced product decision and not a default bump**.
- **Two independent drivers push leg counts to the cap, not one.** §3.1 quantization maximizes value,
  and `decomposePayout` then picks a **uniformly random** member of the full exact-decomposition
  enumeration (`denominations.ts:157-158`), which biases hard toward the ceiling. Measured: quantization
  alone gives ~5.1 legs at cap 8; random selection adds ~2.2 more, roughly 30% of the rent bill.
  Biasing the pick toward fewer legs is therefore the cheapest available mitigation — but it is a
  **tradeoff, not a free win**, since fewer legs means a smaller multiset and less amount ambiguity.
  Priced option, not adopted here.
- **Flags default off — but the DEPLOYMENT does not use the defaults.** ~~so the current production
  rent bill is exactly zero~~ **RETRACTED 2026-08-03.** The code defaults are indeed `false`
  (`config.ts`), and that is what this bullet originally reasoned from. A live deployment's `.env` sets
  `PX402_POOL_PAYOUT_ENABLED=true` and `PX402_POOL_PAYOUT_DENOMINATIONS_ENABLED=true`
  with a funded Solana settler, and the startup banner confirms `pool-payout … solana onchain`.
  **The decision this bullet said to make before enabling was passed in configuration without being
  made.** Each Solana leg strands ~2,039,280 lamports of ATA rent that is structurally
  unrecoverable, so at `maxLegs=3` a Solana withdrawal costs up to ~0.0061 SOL permanently. Actual
  loss to date is near zero only because real Solana withdrawal traffic is near zero — it is armed,
  not firing. Verify deployed flag state against the deployment's own `.env` and the
  `PX402_AGENT_RPC_READY` banner, never against `config.ts` defaults.

**The architectural option that does work: payee-provisioned close authority.** Retroactive reclaim
is impossible, but a *payee-provisioned ceremony* — which already exists in this repo for the
confidential rail (`confidentialSlotProvisioner.ts`) — lets the payee, as owner, grant
`CloseAccount` authority to the settler **at provisioning time**, after which the settler closes
unilaterally once the balance is zero. That is real work with a real wire change, not a free add-on.

**Close-destination warning (must not be got wrong):** closing N leg-ATAs to a single payee
consolidation address publishes a join across every leg of one payout and **reconstructs the total** —
precisely the leak denomination splitting exists to prevent. Any close path must use per-leg fresh
destinations.

**A cheaper lever for the ceiling problem: extend the ladder instead of raising the cap.** Measured:
11 tiers (+200 USDC) lifts the 5,000-USDC quantization result from 800 to 1,600; 12 tiers
(+200, +500) lifts it to 4,000. Bounded, though — **13 tiers at `maxLegs` 8 throws
`Payout denomination search exceeds ENUM_CAP`**, as does `maxLegs ≥ 11` on the default ladder.

**v1 decision:** do **not** raise Solana's cap in this increment. Ship §3.1 quantization, which is
free on EVM and needs no rent. Solana's cap is a separate, priced decision with three honest
options — accept `maxLegs=3` and its residue, pay ~0.0102 SOL/withdrawal, or build the
payee-provisioned close ceremony — and it is the operator's call, disclosed, not silent.

### 3.3 Measurement discipline (a correction to this spec's own numbers)

Earlier drafts quoted "5.5% exact-leak on EVM, 83% on Solana" **without their range**, and those
figures do not reproduce outside it. The exact-leak rate is entirely a function of the assumed
withdrawal distribution:

| Granularity / range | EVM `maxLegs=8` | Solana `maxLegs=3` |
|---|---|---|
| whole USDC, 1–500 | 5.5% | 83% |
| 0.1 USDC grid, 0.1–800 | ~49% | ~97% |
| 1 atomic unit | ~100% | ~100% |

**Every future number in this spec must state its distribution.** The qualitative conclusions are
unchanged and robust across all three (Solana is far worse; both degrade badly at the top of the
range), but no decision may be made on a figure whose range is not stated.

This also kills an obvious API mistake: a quantization mode that **rejects** on any nonzero residue
would throw on essentially every realistic withdrawal (measured 2000/2000 at atomic granularity).
Rejection may only trigger when the request exceeds `maxLegs × max(denominations)` — the true
ceiling — never on ordinary residue.

### 3.3b Does quantization create a fingerprint? Measured: the opposite

The obvious worry is that quantized withdrawals cluster on tileable values and become
identifying. Measured over 900 realistic requests (round amounts, odd multiples, cent-level),
against the real `decomposePayout` / `largestTileableAtMost`:

| | EVM `maxLegs=8` | Solana `maxLegs=3` |
|---|---|---|
| Exact totals published directly | 567 → **0** | 817 → **0** |
| Distinct exact values visible on-chain | 567 → **0** | 814 → **0** |
| Distinct quantized totals used | 808 of 900 | **163 of 900** |
| Requests sharing a total with another | 10.2% | **81.9%** |

Clustering **is** the mechanism, not a side effect. The product law this stack is judged against
asks for a *coarse amount space*, and quantization is what produces one: it maps an unbounded set of
requested amounts onto a bounded set of reachable ones, and every collision is two agents that now
publish an indistinguishable total.

The striking result is that Solana's tight leg cap — a liability for residue (§3.2) — is an **asset**
for amount coarseness: 900 distinct requests collapse to 163 totals, an 82% collision rate, versus
10% on EVM. **A rail with fewer reachable totals gives each exit more company.** That is a genuine
argument against reflexively raising `maxLegs` to 8, independent of the rent argument, and it means
the two rails should not be assumed to want the same cap for the same reasons.

Residual, honestly: a client whose policy is always "withdraw the maximum tileable" is
distinguishable from one that withdraws round numbers, so **withdrawal policy is itself a
fingerprint** even when amounts are coarse. The collision rates above bound how much that matters.
Not addressed here; it belongs with the client-policy guidance the cohort work will need.

### 3.4 Parity validator (new, normative) — **SHIPPED 2026-08-04**

> **Status.** `assertDenominationParity` lives in `denominations.ts` (pure, unit-testable) and is
> invoked from `index.ts` under `if (config.agentRpc.poolPayoutCohortsEnabled)`, together with the
> `poolMode` clause and the §8.1 batching requirement. **Deviation from the letter of this section:**
> it is called from `index.ts`, not `config.ts` module scope, because `byNetwork` is built there —
> the section's actual constraint (needs nothing from rail construction) holds, and the `poolMode`
> clause genuinely requires the constructed rails. Verified by booting the real server: the batching
> gate and the parity gate each throw with an actionable message, and the agent-RPC-disabled smokes
> still boot clean with the flag off. Seven cases in `test:denominations` (48/48), including the
> truncation trap, which is mutation-checked.

When cohorts are enabled, startup **throws** unless all three networks advertise the same
human-unit denomination ladder, the same `policyVersion`, and the same effective `maxLegs`. Today
nothing prevents a config change from making an amount private on one rail and public on another.

Implementation constraints, all verified against the live tree:

- **Live in `config.ts` module scope, not `index.ts`.** Token decimals are literal constants with no
  env override, so the validator needs nothing from rail construction.
- **Must be conditional on the feature being enabled.** `payoutPolicy` is parsed at unconditional
  module scope (`index.ts:313-321`), and several smokes boot the server with agent RPC disabled; an
  unconditional throw turns them red with "server exited early".
- **Must compare human units by cross-multiplication, never by dividing into integers.**
  `100000n / 10n**6n === 150000n / 10n**6n === 0n`, so a truncating normalization silently equates
  0.1 and 0.15 and the validator would assert nothing.
- **Must include a `poolMode` clause.** `EvmChainRail.ts:37-44` and `SolanaChainRail.ts:42-47`
  independently resolve `onchain` vs `dry-run` from their own `hasSettlerKey && settler === treasury`,
  so Base can be live while Solana is silently dry-run — a parity gap the ladder check alone misses.
- **The confidential scheme must not be advertised a denomination ladder at all.** The attach at
  `PrivateAgentRegistry.ts:1971` currently tests only `requirements.stealthMetaAddress` and not the
  scheme.
- **Any policy-discovery route must be gated by `assertVpnMember`, never by
  `requireEndpoint` + `assertVpnPeer` on a caller-supplied agent id.** The private RPC returns
  `error.message` verbatim, and those two throw `Unknown private agent endpoint: <id>` and
  `VPN peer mismatch for <id>: expected <vpnIp>, got <remoteIp>` — an agent-existence *and*
  agent-IP oracle. The advertisement is per-network and needs no agent id.

---

## 4. Lane-local adaptive target (increment 2) — **SHIPPED 2026-08-04**

> **Status of the persistence half** (the three items the first pass explicitly left open;
> `test:concentration` 50/50, each mutation-checked):
>
> - **Fresh-arrival-only evidence, durably marked (B2).** `PendingPayoutGroup.evidenceCountedAt`
>   is written before the sample is recorded, so a crash loses an observation rather than
>   double-counting one. The rule systematically UNDER-counts — a new arrival beside three held
>   groups records 1, not 4 — which is the deliberate direction: an under-estimate only ever
>   releases sooner, and under *delay, never refuse* a premature release is the cheap error.
>   The test that has teeth here asserts the recorded **value**, not the observation count: an
>   earlier version asserted only the count and the mutation survived it.
> - **Adaptive state and the master secret persist** in `data/pool-payout-concentration.json`
>   (AES-256-GCM, durable, `failClosed`, pruned to the evidence window on load, future-dated
>   samples discarded). Two failures closed at once, and the second was found while building the
>   first: the §6 master secret was `randomBytes(32)` **per process**, so every commitment
>   published before a restart became unrevealable — an accountability scheme erased by a routine
>   deploy. Verified across three real boots: mint, reuse, and a fresh mint once the file is
>   deleted.
> - **Jitter is drawn from an absolute public slot** `(network, epoch, floor(offset / flushMs))`.
>   The cursor it replaces rewound to 0 on restart and replayed the epoch's opening draws — a
>   re-roll of release timing no verifier of the committed schedule could detect. Absolute slots
>   introduce a hazard of their own, so the **network is now bound into the derivation**: without
>   it every rail draws identically in the same slot and flushes in lockstep, correlating landings
>   across chains for free.
> - **Static `K > 1` is rejected at startup in production**, including when adaptive is on and the
>   value is therefore ignored — config that reads as `K=4` but does nothing is its own hazard,
>   and an operator who later disables adaptive would inherit the trap without touching the line.
>
> **Status of the core.** Lane-keyed evidence, lane-local targets, and per-lane gating are implemented.
> `ConcentrationLeg.laneKey` is required (compile error if omitted, following the `ownerRef`
> precedent) **and** guarded at runtime, because the smokes are `.mjs` and bypass the type — an
> absent lane reads as laneless and silently collapses every leg's anonymity to 1, which is a
> privacy downgrade disguised as a passing test.
>
> Two behaviours this bought that the previous per-network pool could not express, both
> mutation-checked in `test:concentration` (44/44):
> - A quiet denomination no longer inherits a busy sibling's target *on the same rail*. Previously
>   only cross-RAIL isolation existed, so a lone withdrawer at an untouched denomination was held to
>   `maxHoldMs` waiting on concurrency that only ever existed at a different one.
> - **An exact leg no longer gates the tiled legs beside it.** It has no lane, so it is judged on its
>   own; under a single window-wide target its `A = 1` dragged the whole window's `k_eff` to 1 and
>   held everyone. `windowKEff` still reports 1 honestly — the exact leg genuinely has an anonymity
>   set of one. What changed is that it no longer penalises its neighbours.
>
> Also corrects a latent metric bug: anonymity was keyed on `denominationAtomic` alone, so two
> different ASSETS sharing an atomic value (1000000 of USDC and of USDG) were counted as one
> anonymity set and `k_eff` was overstated. The lane carries the asset.
>
> **Outstanding after increment 2:** nothing in this section. The `.mjs`-bypasses-the-type lesson
> stands as a standing hazard for the smokes, not an open item.

Replaces the single global pool. `concurrencySamples` becomes `Map<laneKey, KEffSample[]>` keyed
`network:asset:denominationAtomic`, and `effectiveKEffTarget` takes a lane.

- **Invariant 1 — no lane evidence ⇒ target 1** for that lane. The N=1 guarantee, now per lane
  rather than per process.
- **Invariant 2 — never exceeds that lane's own observed quantile.**
- **Evidence is per-lane distinct-OWNER occupancy of fresh arrivals**, not the window minimum and
  not the whole backlog. Each group contributes to evidence **once**, in the first scheduled window
  after enqueue, with the marker persisted so a restart cannot double-count it (Codex B2: held
  backlog reappearing across windows manufactures apparent concurrency and ratchets the target after
  real traffic stops).
- **Static `K > 1` is prohibited in production config** and retained only for tests. It is exactly
  the low-volume latency trap frozen §14 was written to eliminate, and "the operator set it wrong"
  is not an acceptable N=1 failure mode.
- Adaptive state must survive restart, or restart becomes an operator release-control lever
  (Codex F3). Same for the schedule cursor: derive jitter from an absolute public slot
  `(network, floor(t / windowQuantum))` rather than a mutable in-memory index.

---

## 5. The cohort dispatcher (increment 3 — the core of v1)

This is what makes a cohort real. Today: `for (…) await this.flushLeg(…)` (`:526`), where EVM
`flushLeg` blocks to finality. v1 splits *deciding* from *delivering*.

### 5.1 Required shape

```
PLAN     under the network lock: choose cohort membership, assign a cohortId,
         persist a durable cohort manifest (members, laneKey, target, generation)
         BEFORE any member becomes broadcastable.
PREPARE  build every member's transaction and persist its identity
         (EVM outbox entry / Solana signed bytes + lastValidBlockHeight).
DISPATCH submit all members WITHOUT awaiting per-member finality.
RECONCILE asynchronously classify every member; the cohort is terminal only when
         all members are terminal.
REPORT   compute realized k_eff over members that actually LANDED, then persist it.
```

### 5.2 Hard requirements

- **R1–R6 (frozen §4.2) carry over verbatim.** No `attempts` on a hold, no confirmation timer on a
  held leg, bounded holds, recovery-identical held legs, `onlyGroupRef` bypass, never refuse.
- **R7 — cohort members are `K` distinct OWNERS** (not groups — §2), and at most one leg per owner
  per cohort.
- **R8 — realized `k_eff` is computed post-landing over the settled subset**, never from the planned
  selection. `realizedConcentration` currently writes at `:587`, *before* submission begins at
  `:606`; that ordering is the bug. A failed or unresolved member must lower the realized value.
- **R9 — realized metrics are persisted with the cohort**, not held in memory (`:165`), so a claim
  survives restart.
- **R10 — re-shuffle after cohort assembly.** The existing `shuffle` at `:515` runs *before* the
  gate and survives only because `Array.filter` preserves order. Cohort assembly reorders, so
  contiguous same-denomination blocks would leak lane boundaries through the settler's public,
  strictly-increasing nonce sequence. One line, trivially omitted, so it is normative.
- **R11 — separate cohorts, separate reporting.** Complete cohorts, force-released stragglers, and
  null-denomination exact legs are **distinct cohorts with distinct IDs**. Never mix a forced or
  null leg into a cohort advertised as satisfying `K` — under the frozen window metric a single null
  leg drags the whole window's `k_eff` to 1, so v0's single `releasable` array would have reported 1
  for a genuinely 4-way lane.
- **R12 — a blocked rail must not stop deadline accounting.** The next timer is scheduled only in
  `.finally(() => this.schedule(network))` (`:999`), so a quarantined coordinator
  (`TransactionCoordinator.ts:310`) leaves `flushNetwork` pending and no later pass evaluates
  `maxHoldMs`. Planning must be non-blocking and must not be able to starve delay-never-refuse.
- **R13 — CAS fences the whole path.** `flushLeg` writes `broadcasting` with no `expectGen`
  (`:618`). Transitions become `queued → assigned(cohortGen) → prepared → broadcasting`, proceeding
  only if both leg and cohort generations still match.

### 5.2a The serialization is one level DOWN — measured 2026-08-05, and §5 understates it

> **Status: R8/R9/R10/R11 SHIPPED (`0f5ca61`). Dispatch is unchanged and still serial.**
>
> §0.1 located the blocker at `PoolPayoutQueue.ts` `for (…) await this.flushLeg(…)`, which is
> real but **not sufficient**. `TransactionCoordinator.submit` wraps the *entire* operation —
> `resumeEntry` included — in `withLease`, and `resumeEntry` polls until the transaction is
> covered by the finality tag or the confirm budget expires. `withLease` chains every call onto
> one promise per settler EOA. So a second submit cannot allocate its nonce, sign, or even
> broadcast until the first has finished waiting for finality.
>
> **Consequence: `Promise.all` at the queue level would change nothing on EVM.** The legs would
> still land one finality apart. Pinned by test 12 of `npm run test:settler:finality`, which
> holds A inside its post-mining classification and asserts B has not reached the chain;
> disabling the coordinator's lease makes B broadcast immediately and the test fail.
>
> This adds a requirement §5.2 does not have:
>
> - **R14 — the lease must cover nonce allocation and first broadcast, not finality.** `submit`
>   splits into a lease-held *dispatch* (allocate, sign, persist to the outbox, broadcast once)
>   and a lease-free *await*. Everything that made the lease necessary stays inside it; only the
>   waiting moves out.
> - **R15 — a lease-free wait needs an owner for the fee bump.** Today the bump lives in
>   `resumeEntry`'s loop. Once dispatch returns early, a stuck nonce has nobody to replace it and
>   would block the settler EOA indefinitely — trading a privacy defect for a liveness one.
>   Whatever performs the bump must re-take the lease to sign, since a replacement is a write to
>   the same nonce.
>
> This is the nonce pipeline that guards the settler EOA against double-spend, on a deployment
> that broadcasts for real on three rails. It is the highest-risk change in the wave and should
> not be bundled with anything else.

### 5.3 Chain atomicity — open, and the honest fallback

Even with non-blocking dispatch, members land in whatever block the chain gives them. Two options:

- **(a) Chain-atomic multi-output.** Multicall3 is deployed at the identical address on Base and
  Robinhood (verified earlier); Solana can put multiple transfers in one transaction. This makes a
  cohort genuinely atomic and indivisible. Cost: a new contract dependency on EVM, transaction-size
  limits on Solana, and it makes the cohort *itself* a visible object.
- **(b) Non-atomic dispatch with honest reporting.** Members land close together but separably; the
  claim reports the true landed value.

**v1 ships (b) and states it plainly.** (a) is the stronger property and is the natural next wave;
it must not be claimed until built. Under (b) the honest wording is **"targeted cohort size `K`"**,
never "guaranteed `k_eff = K`".

---

## 6. Cohort formation (increment 4)

Only after §3–§5. Deterministic, earliest-deadline-first over per-lane queues; each group
contributes at most one leg per lane per cohort; ties broken by a committed pseudorandom
permutation; force deadlines evaluated **before** filling non-forced cohorts. `K = 1` is exactly
today's behavior (every lane trivially complete, nothing held), so the frozen gate becomes the
`K = 1` specialization and the round planner is the **sole** owner of release decisions — sequencing
the two would let the global-min gate hold a healthy lane the scheduler just cleared, reintroducing
the very defect it fixes.

---

## 7. Reporting and surfaces

- **Owner-bound claim:** per-leg `{cohortId, realizedKEff, heldMs}` plus a group-level minimum, all
  computed post-landing and persisted. A group-level scalar cannot describe legs landing in
  different cohorts.
- **Probe resistance (Codex F5):** return settlement state immediately but delay the *privacy
  metric* until the cohort's max hold plus publication lag, and rate-limit by durable owner —
  otherwise any agent probes lane occupancy with small withdrawals.
- **`/api/privacy` must stop exposing live posture.** `effectiveTarget` and live observation count
  are public today (`createHttpServer.ts:122,150`), which under cohorts tells an attacker exactly
  when the scheduler's expectations dropped. Move live resolved status to an authenticated
  operator-only surface; publish only lagged, bucketed history (frozen A3).

---

## 8. Config — TARGET STATE, none of it implemented yet

> **Read this heading literally.** Every row below is a *planned* variable. As of this writing
> **not one of them exists in `src/`** — verified by grep. A config table in a spec reads like a
> description of shipped behavior, and one reviewer reasonably took it as such. Nothing here is
> wired; the `Status` column is the contract.

| Env var | Default | Status | Notes |
|---|---|---|---|
| `PX402_POOL_PAYOUT_COHORTS_ENABLED` | `false` | **flag + startup gates SHIPPED**; dispatcher still pending (§5) | master switch; off ⇒ frozen §4 gate unchanged. On ⇒ startup throws unless batching is also on, all rails' ladders/`maxLegs` match in human units, and all rails share one `poolMode`. **Default config FAILS parity by design** (EVM 8 legs vs Solana 3), forcing the §3.2 rent decision to be made rather than drifted into. |
| `PX402_POOL_PAYOUT_ROUND_SIZE` | `adaptive` | **not implemented** | static > 1 **rejected at startup in production** |
| `PX402_PAYOUT_QUANTIZE` | `off` | **SHIPPED** (`off\|advise\|enforce`; unrecognised value throws) | server-side enforcement of tileability |
| `PX402_SOLANA_MAX_LEGS` | `3` | **not implemented** | raising it is a priced decision (§3.2), not a default bump |

### 8.1 Quantization — enforcement now EXISTS, and is off by default

> **Status update 2026-08-03.** The enforcement rule below is implemented in
> `validatePlanAgainstPolicy` and reached through `PayoutSplitPolicy.quantizeMode`, driven by
> `PX402_PAYOUT_QUANTIZE`. It runs before any ledger debit. Default `off`, so tileability
> remains **courtesy** on every deployment that has not opted in. Under
> `enforce` it becomes enforcement. Covered by four cases in `test:denominations` (41/41), including
> the never-strand escape hatch, which is mutation-checked: forcing the refusal unconditional makes
> the suite die on `re-quote at null atomic units`.

`quantizeWithdrawal` and `GET /private/a2a/payout-policy` ship, but with `quantizeMode: "off"` the
server still accepts `strategy:"single"`. So an agent that does not call the helper keeps publishing
exact amounts, and **the privacy property is courtesy, not enforcement.** Say that plainly rather
than implying tileability is guaranteed.

Server enforcement is the obvious next step and carries one constraint that must not be got wrong:

> **A refusal must never be able to strand funds.** Refusing a non-tileable amount is *guidance* —
> the client re-quotes at the tileable amount and is paid — and so does not violate "delay, never
> refuse" (frozen R6), which governs **privacy holds**, not amount validation. But when a balance is
> **below the smallest denomination** nothing can tile, `largestTileableAtMost` returns `null`, and
> the client has no valid amount to re-quote at. Refusing there would lock the balance permanently.

So the enforcement rule is: reject `strategy:"single"` **only when a tileable alternative exists**
(`largestTileableAtMost(total) !== null`); always allow the exact leg when nothing tiles. Residue
accumulates in the ledger under quantization, and a residue withdrawal is exactly the sub-denomination
case, so this escape hatch is the common path, not an edge case.

Startup **throws** when cohorts are enabled and batching is not: `flushGroup(quoteNonce)`
(`PrivateAgentRegistry.ts:803`) sets `onlyGroupRef`, which bypasses the gate *and* the scheduler
(`:518`). A privacy flag that silently does nothing is scaffolding theater.

---

## 9. Smoke plan (`scripts/exit-cohorts-smoke.mjs`, `test:exit-cohorts`)

Deterministic via injected RNG and clock. Beyond v0's cases: cohort manifest persists before first
broadcast; a member that fails to land **lowers** realized `k_eff`; realized metrics survive
restart; forced/null legs never join a `K`-cohort; re-shuffle destroys lane-contiguous ordering;
one owner with `K` groups forms **no** cohort; a lane raises its target without any other lane
raising theirs; a quarantined rail still evaluates deadlines; and cases run identically across
`base`, `robinhood`, `solana` asserting **equal realized `k_eff` for an identical total** — the
assertion that would have caught the Solana gap.

Regression gates (current, 2026-08-04): `test:concentration` 50, `test:pool-payout` 58,
`test:denominations` 48, `test:x402` 46.

---

## 10. Build order (binding)

0. ~~Owner-counted `k_eff`~~ **DONE `ac917b8`**; ~~quantization helper~~ **DONE `6356522`**.
1. **Tileability** — quantization enforcement and the parity validator **DONE 2026-08-04**; Solana
   cap + sweep-and-close still open, and the default config fails parity on purpose until it is
   decided (§3.2).
2. ~~**Lane-local adaptive target** — persisted, fresh-arrival evidence (§4)~~ **DONE 2026-08-04**.
3. **Cohort dispatcher** — plan/prepare/dispatch/reconcile/report, post-landing metrics (§5).
4. **Cohort formation** — subsuming the frozen gate (§6).
5. Then reconsider: chain atomicity (§5.3a), off-chain change, splitter.

**Never:** self-payout cover (§0.2).

---

## 11. Honest privacy statement (draft — do NOT merge to CLAUDE.md until §5 ships)

> **Denomination-pure exit cohorts.** Pool withdrawals are grouped into cohorts of same-denomination
> stealth outputs drawn from distinct paying accounts and dispatched together, so a withdrawal's
> anonymity set against a public chain observer is the other members of its cohort that actually
> landed. Cohort size is lane-local and adaptive: 1 until that specific `(network, denomination)`
> lane has its own observed concurrency, so a lone withdrawer is never delayed and no rail inherits
> another's traffic. An incomplete cohort is **held, never refused**, up to the client's
> signature-bound `maxHoldMs`, then released with its true realized value reported on the
> owner-bound claim.
>
> *What this buys:* frequent same-denomination withdrawals concentrate instead of each publishing a
> distinct amount, so user #2's exit improves user #1's.
>
> *What it does not buy:* anything against the operator, which sees every request. Members are
> dispatched together but land in separate transactions, so the honest claim is a **targeted** cohort
> size, not a guaranteed one — chain-atomic multi-output would make it guaranteed and is not built.
> Amounts, leg counts, timing, and the fact that the pool paid someone remain public. A withdrawal
> whose value does not tile still publishes an exact amount. **No manufactured cover traffic is used
> or planned:** operator-funded decoys return to the pool in an exactly-matching closed cycle that
> needs no account labeling to detect, and they are weakest precisely when external exits are
> frequent. The strongest privacy in the system remains the agent↔agent ledger path that never
> crosses a public chain at all.
