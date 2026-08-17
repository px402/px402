# FROZEN SPEC v1 — Off-chain change (killing the `strategy:"single"` exact-value leak)

Status: FROZEN v1, NOT IMPLEMENTED. Named as a deliverable by
`spec-payout-concentration.md` §11 and ordered #2 in `spec-privacy-at-scale-one.md` §7.
Hand verbatim to an implementation agent. TypeScript strict, no new dependencies.

Owner surfaces: `src/shared/payoutPlan.ts`, `src/shared/denominations.ts`,
`src/server/payments/PrivatePaymentLedger.ts`, `src/server/agents/PrivateAgentRegistry.ts`.

---

## Thesis (binding)

**A payout that cannot be tiled into standard denominations currently publishes its exact
value on-chain.** `decomposePayout` falls back to `singlePlan` for any total below the
smallest denomination or with no bounded tiling, emitting one leg whose `amountAtomic` is
the raw total, `denominationAtomic: null`, `kind: "exact"`. `computeKEff` conditions such a
leg on itself alone, so it has `k_eff = 1` **by construction, forever, at any user count.**

This is a **crowd-free** leak, which makes it unusually important: it is one of the few
remaining privacy defects that more users will never fix.

The fix is to stop forcing the on-chain legs to sum to the exact total. Pay standard
denominations that sum to *less*, and deliver the remainder **off-chain** as a credit to the
payee's private-ledger balance. Every published leg is then a standard denomination and no
exact value ever appears.

> **Scope limit, stated up front:** off-chain change requires the payee to hold a ledger
> account, so this helps **agent↔agent payments only**. Same lesson as the private ledger
> itself — the mechanism works precisely where value does not have to cross the boundary.
> A payout to a party with no ledger account keeps today's exact-leg behavior and keeps the
> leak. Do not describe this as a general fix.

---

## 0. Review record

### 0.1 Wire scaffolding already complete (verified)

| Fact | Evidence |
|---|---|
| `offchainChangeAtomic` is in the canonical plan body | `payoutPlan.ts:57` |
| …and in the signed intent | `x402AgentIntent.ts:115` |
| §7.2 already validates `onchain + offchain === total` | `payoutPlan.ts:139` |
| `decomposePayout` refuses change today | `denominations.ts:104` — `offchainChange === true` throws |
| `singlePlan` hard-codes `offchainChangeAtomic: "0"` | `denominations.ts:195` |

So the wire, the hash, and the signature already commit to the field. This spec turns it on.

### 0.2 The two landmines (both verified against the live tree)

**L1 — §7.3 becomes unsatisfiable.** `payoutPlan.ts:144-147` requires
`legs[0].amountAtomic === plan.totalAtomic` for `strategy:"single"`, while §7.1 requires
`legSum === onchainAtomic`. With non-zero change these contradict and **every**
single-leg-with-change plan is rejected.

*Fix:* the single-leg rule must compare against `plan.onchainAtomic`, not `plan.totalAtomic`.
`§7.2` already pins `onchain + offchain === total`, so the total stays bound — the check is
being moved to the right operand, not weakened.

**L2 — the reversal path breaks per-asset conservation.** This is the dangerous one.
`PrivatePaymentLedger.payout()` debits and credits the *same* `amount`
(`PrivatePaymentLedger.ts:665-666`) and then calls `assertConserved` (`:681`). With change
the required postings are:

```
payer  -= totalAtomic
escrow += onchainAtomic          // the legs that will broadcast
payee  += offchainChangeAtomic   // delivered off-chain, immediately spendable
```

`payout()` never resolves a payee reference, and reversal (`:915-926`) returns a single
`reversalAmountAtomic`. **The break is on the error path — the least-tested code in the
system**, and a conservation break there is a silent mint or burn.

*Fix — normative, and the reason this spec exists:*

1. `payout()` gains a required `changeCredit?: { payeeRef: string; amountAtomic: string }`.
   When `offchainChangeAtomic > 0` it is **mandatory**; a plan with change and no resolvable
   payee ledger account is **rejected at validation time, before any debit** (§2.3).
2. The three postings happen in **one** CAS'd mutation under the existing generation fence.
   There is no window in which the payer is debited but the payee is not credited.
3. `assertConserved` is extended to the three-way sum and asserted **after** the mutation,
   as today.
4. **Reversal must reverse all three postings.** `reversePayout` takes the stored
   `{ total, onchain, change, payeeRef }` from the journal rather than a single scalar, and
   is itself CAS'd and idempotent on `payoutRef`.
5. **The change credit is spendable immediately and is NOT reversible once the payee has
   spent it.** Reversal therefore has to handle a payee balance that has already moved.
   Normative resolution: reversal debits the payee's change credit if and only if the
   balance still covers it; otherwise the group is **quarantined for operator review**
   (`uncertain`) exactly as ambiguous finality is today. **It must never force a negative
   balance and never silently skip the leg.** This case is rare but it is the one that
   corrupts the ledger if handled by assumption instead of by rule.

---

## 1. Scope

**In:** enabling `offchainChange` in `decomposePayout`; L1 and L2; validation ordering so no
debit precedes a rejection; three-way conservation; reversal; tests including the error path.

**Out:** change to a non-ledger payee (keeps the exact leg — see the scope limit above);
any change to `exact`-rail behavior; the confidential rail (which removes the need for this
entirely on the networks where it ships — see §5).

---

## 2. Mechanism

### 2.1 Decomposition

`decomposePayout({ ..., offchainChange: true })` returns the **largest** standard tiling
whose sum is `<= total` within `maxLegs`, with `offchainChangeAtomic = total - legSum`.

Selection rule (normative): maximize `legSum`, then minimize leg count. Minimizing change
matters because the change is the part that reveals nothing on-chain **but does reveal the
total to the payee**, which is fine — the payee is a party to the payment.

A total below the smallest denomination yields **zero on-chain legs** and pure off-chain
change. That is the ideal case: nothing is published at all.

### 2.2 Plan shape

`strategy: "denominations"` with `offchainChangeAtomic > 0` is the normal case.
`strategy: "single"` with change exists only for the zero-leg case above; L1's fix is what
makes it validate.

### 2.3 Validation order (normative, safety-critical)

Everything below happens **before any ledger mutation**:

1. §7.1 `legSum === onchainAtomic`
2. §7.2 `onchainAtomic + offchainChangeAtomic === totalAtomic`
3. §7.3 (L1-fixed) single-leg compares to `onchainAtomic`
4. Every leg is a standard denomination for the advertised policy
5. Plan hash, signature, quote/rail/policy binding — unchanged
6. **`offchainChangeAtomic > 0` ⇒ the payee has a resolvable ledger account**

Rule 6 is the one that keeps L2 from ever arising: a plan that could not be conserved is
refused before the payer is touched.

---

## 3. Config

| Var | Default | Meaning |
|---|---|---|
| `PX402_POOL_PAYOUT_OFFCHAIN_CHANGE_ENABLED` | `false` | flag-off reproduces today's behavior exactly, including the exact-leg leak |

Advertised on the quote so a client knows whether to produce a change plan; a client plan
carrying change against a server that does not advertise it is hard-rejected.

---

## 4. Test plan (`test:offchain-change`)

Conservation and the error path are the point; leg arithmetic is the easy half.

1. Tiling: `legSum + change === total`, every leg standard, `legSum` maximal within `maxLegs`.
2. Sub-smallest total ⇒ zero legs, pure change, **nothing published**.
3. L1: a single-leg-with-change plan validates (and fails if compared to `totalAtomic`).
4. Three-way conservation holds after payout, asserted per asset.
5. Rule 6: change with no payee ledger account is refused **and the payer balance is
   unchanged** — assert the balance explicitly, not just the throw.
6. **Reversal restores all three postings exactly**, and is idempotent on replay.
7. **Reversal when the payee already spent the change ⇒ `uncertain` quarantine**, never a
   negative balance, never a silent skip.
8. Crash between debit and credit is impossible — assert single-mutation atomicity by
   generation, not by timing.
9. Flag-off: byte-identical plans to today.

Plus no regression in `test:pool-payout`, `test:denominations`, `test:concentration`,
`test:x402:private-ledger`.

---

## 5. Relationship to confidential x402

On any network where `spec-confidential-x402.md` ships, the amount is encrypted and this
entire leak disappears — off-chain change becomes redundant there. It remains valuable
because it is **cheap, needs no contract, no proving system, and no new dependency**, so it
can ship on all three rails long before the confidential rail is deployed on any of them.

Sequencing: ship this first. It is the last crowd-free privacy win available for the price of
ordinary application code.
