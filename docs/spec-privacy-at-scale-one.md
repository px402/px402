# FROZEN SPEC v1 — Privacy at scale one (the day-one profile)

Status: FROZEN v1. The governing requirement for every privacy feature in this repo.
Increment A (adaptive `k_eff`) is IMPLEMENTED; the rest is the operator profile and the
ordering rule that all future privacy work is judged against.

---

## Thesis (binding)

> **Nothing may be worse than useless when we are small, and nothing may require an
> operator action to become useful when we are not.**

We will not launch with a crowd. We launch with one user, then a few, then more. A privacy
feature whose value begins at N=1000 is not a feature we have — it is a feature we are
hoping for. Every mechanism in this stack must therefore be classified, honestly, as
**crowd-free** or **crowd-dependent**, and the crowd-free ones must carry the product until
the crowd-dependent ones start to bite.

The corollary that took us longest to accept:

> **At N=1, the only way to break the `A → B` link on a public chain is to not put
> `A → B` on a public chain.**

One deposit and one withdrawal cannot be unlinked by any cryptography, because the *set* is
the privacy and a set of one is a pass-through. This is arithmetic, not an engineering gap.
Any design that claims otherwise is either a shielded pool borrowing someone else's crowd,
or wrong.

---

## 1. Classification (normative)

| Mechanism | Crowd-free? | Value at N=1 | Status |
|---|---|---|---|
| **Private ledger** (agent↔agent, never touches a chain) | **yes** | **total** — there is no on-chain event to link | shipped |
| **Confidential amount** (Token-2022 / `PX402Confidential`) | **yes** | full — the value is encrypted regardless of who else is around | `spec-confidential-x402.md` |
| **Stealth receiving** (EIP-5564 / DKSAP) | **yes** | full — a one-time address is one-time for one user too | shipped |
| **Payer rotation** (HD per-payment sender) | **yes** | full | shipped |
| Pool-direct payout (pool is the on-chain sender) | no | **none** — pool→B reconstructs A→B by subtraction | shipped |
| `k_eff` concentration gating | no | **none**, and formerly *negative* (latency for nothing) | shipped + §14 fix |
| Denomination splitting | no | none — one payout's legs still sum to its total | shipped |

**The load-bearing observation:** the four crowd-free mechanisms are the four strongest, and
they are all already built or spec'd. The privacy curve therefore starts high and only
rises. This is the opposite of a mixer-first design, which starts at zero.

---

## 2. The boundary is the whole game

The private ledger means the chain is touched only at the **boundary** — value entering
(deposit) and leaving (withdrawal). Individual payments never appear. So the design variable
is not "how do we mix" but:

> **How few boundary crossings do we force, and how uninformative is each one?**

| Users | What a chain observer sees | What is hidden |
|---|---|---|
| **1** | one funding, one withdrawal, eventually | **every payment, counterparty, and amount between them** |
| **a few** | a handful of crossings | the above, plus amounts unmatchable once confidential ships |
| **many** | crossings pool | the above, plus the boundary link itself (`k_eff` finally bites) |

Amount-matching is what actually deanonymizes small pools. Confidential amounts remove that
channel, which is why the composition becomes meaningfully strong at N of 2 or 3 — not 1000.

**Design rules that follow, and that new work must respect:**
1. **Never one deposit per payment.** Deposit once, spend many times inside the ledger.
2. **Dwell is privacy.** The gap between a deposit and the withdrawal it funds is entropy we
   get for free. Product surfaces should encourage holding a ledger balance, not
   withdrawing per payment.
3. **A withdrawal must not echo a deposit.** Equal-and-opposite amounts re-link across the
   boundary even at N=1000. Confidential amounts and stealth withdrawal addresses both help;
   neither helps if the product withdraws exactly what was deposited.

---

## 3. Day-one operator profile (N = 1 to ~10)

Everything here is either shipped or spec'd. This is the correct configuration on launch day,
not a future state.

| Setting | Day one | Why |
|---|---|---|
| Private ledger | **ON** | the only mechanism that is *total* at N=1 |
| Stealth deposits + stealth receiving | **ON** | crowd-free |
| Payer rotation | **ON** | crowd-free |
| Stealth inbox | **ON** (already default) | without it stealth payouts are unspendable |
| Confidential x402 | **ON** when built | crowd-free; kills amount-matching at the boundary |
| `POOL_PAYOUT_CONCENTRATION_ENABLED` | **ON** | safe — see below |
| `POOL_PAYOUT_KEFF_ADAPTIVE` | **ON** | makes the line above safe: inert at N=1, self-raising later |
| `POOL_PAYOUT_KEFF_TARGET` (static) | leave at `1` | superseded by adaptive; a static value above 1 is the latency-tax bug |
| `POOL_PAYOUT_KEFF_CEILING` | `8` | an ambition, never a target |
| Batching / denominations | ON | harmless at low N, needed later |

The concentration gate is safe to enable on day one **only because** the adaptive target
(§14 of `spec-payout-concentration.md`) guarantees it stays inert without evidence. Enabling
it with a static target above 1 is the bug that spec fixed.

---

## 4. The residual, stated plainly

At N=1 nothing hides **your own boundary crossings** from someone already watching your
funding wallet. They see you funded a PX-402 account and later withdrew. They do not see
who you paid, how much, or when — which is the sensitive part for a market — but the
crossings themselves are visible.

The only fixes are outside the protocol: fund from an unlinkable source (a fresh exchange
withdrawal per address), or route the boundary through a shielded pool that already has a
crowd. The second is measured and evaluated in §5.

We do not claim otherwise, and no marketing copy may.

---

## 5. Borrowing a crowd (measured 2026-07-30, not assumed)

Measured directly against mainnet rather than taken from documentation:

| Chain | Live pool | Measurement |
|---|---|---|
| **Solana** | Umbra (on Arcium), program `UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh` | **24,204 program accounts**, 45 record sizes, one 286,928 B tree account, 96.5 SOL rent, ~435 tx/day, ~36 value-bearing ops/day |
| **Base** | none | Railgun is Ethereum/BNB/Polygon/Arbitrum; Privacy Pools is Ethereum + Gnosis. Neither on Base |
| **Robinhood Chain** | none | too new for any privacy infrastructure to exist |

Read: the Solana set is **real** (24k accounts, not dozens) but its depth is *cumulative*,
not concurrent — ~36 ops/day is thin cover in any given window.

**Not adopted, for three recorded reasons:** it is Solana-only so it cannot give the 3-chain
parity that is a standing requirement; Arcium is an MPC network, the same architectural shape
rejected in `spec-confidential-x402.md` §0.2 R1; and its shielded TVL is not publicly
measurable without the IDL, so the set size in *value* terms is unknown. Revisit only as an
explicitly-labelled Solana-only accelerant, never as the spine.

---

## 6. Explicitly rejected

**Manufactured cover traffic — including operator-run agents.** Funding operator-controlled
agents from the treasury to fake volume does not work: operator-funded decoys sit in one
cluster and an observer strips them with a single predicate. This is the same reason
`spec-payout-concentration.md` §0.2 rejected a churning note set. A fake crowd is not a crowd,
and building one would make our published `k_eff` a lie. Only genuinely independently-funded
participants count.

**Seeding pools with our own capital.** Not rejected so much as *not required*, and recorded
here because it was blocking a decision: a shielded pool is not an AMM. It is pure accounting
over other users' deposits, every withdrawal is backed 1:1 by a prior deposit, and the
operator contributes **zero** capital. The scarce resource is other people's transactions —
a distribution problem, never a treasury one.

---

## 7. Ordering rule for all future privacy work

Ship crowd-free before crowd-dependent, always. Concretely, in order:

1. **Confidential amounts** (`spec-confidential-x402.md`) — the last crowd-free property not
   yet built, and the one that makes small-N boundary crossings unmatchable.
2. **Off-chain change** (`spec-payout-offchain-change.md`) — kills the `strategy:"single"`
   exact-value leak. Crowd-free.
3. **Shielded pool** — the only thing that hides the edge, and the only item here that needs
   a crowd. Its anonymity set is *cumulative* (everyone who ever deposited) rather than
   concurrent, which is why it is worth building despite starting empty.

Anything crowd-dependent that ships before its crowd exists must be inert by default and
self-activating, in the manner of §14. That is now a standing requirement, not a nicety.
