# spec-stealth-inbox — receiver-side stealth funds: index, sweep, wallet

Status: **Phase 1 IMPLEMENTED** (Component A + D5 fix, `npm run test:stealth:inbox`
16/16). Phases 2–4 remain DRAFT.
Decision log: Component A ships default-ON (§6, approved); `sourceRef` is not
exposed by `/inbox` (§11.4); one deposit intent per leg (§5.2).
Scope: how an agent that *receives* stealth payments learns about them, keeps them
recoverable, and turns N one-time addresses back into one spendable balance.
Owner: this spec covers `src/server/agents/PrivateAgentRegistry.ts`,
`src/server/rails/*`, `src/server/payments/*`, `src/shared/stealth*.ts`, and one
new client wallet module.

---

## 1. Problem

Stealth receiving (EIP-5564 on EVM, DKSAP on Solana) gives each payment a fresh
one-time address. The sending side of this is implemented and proven live. The
**receiving side is not implemented at all**, and the gap is not cosmetic.

### D1 — The payee never learns the announcement (fund loss, P0)

In `enqueuePoolPayoutV2Unlocked` the **payer** supplies `ephemeralPubKey` per leg
(`PrivateAgentRegistry.ts:707`). The server resolves each recipient through
`rail.resolveRecipient` (`:719-727`) and returns `legs[].ephemeralPubKey` in the
ACK to the **payer** (`:806`). `claimPoolPayout` requires `payerAgentId` and
asserts the payer's VPN peer (`:823-824`).

No endpoint delivers the announcement to the payee.

The one-time key is `kStealth = kSpend + H(kView · R)` (`stealth.ts:100`). Without
`R` (the announcement) the payee cannot derive the key and **cannot even locate
the address**. `R` is freshly random per payment (`stealth.ts:60`) and is
deliberately never published to an ERC-5564 Announcer (`stealth.ts:9-10`).

Consequences:
- A seed/spend-key backup does **not** recover stealth funds. Nothing does.
- Today the flow only works because payer and payee are the same operator.
- Loss is silent. Nothing errors; the money is simply unreachable forever.

### D2 — Fragmentation

N payments → N addresses. With `PX402_POOL_PAYOUT_DENOMINATIONS_ENABLED`,
one payout is up to `maxLegs` addresses (8 on Base/Robinhood, 3 on Solana). A
receiver has no aggregate balance, only a scatter of one-time outputs.

### D3 — Consolidation re-links what stealth just unlinked

Sweeping N stealth addresses into one personal wallet publishes on-chain that
those N payments share an owner. The naive fix for D2 destroys the property D2
is a side effect of.

### D4 — The only sweep tool leaks, by gas

`scripts/x402-stealth-sweep.mjs:180` has the settler **send native gas to the
stealth address** before sweeping. That is a direct, public `pool → stealthAddr`
edge which destroys recipient unlinkability outright. The script logs the caveat
at `:133` and calls it acceptable "for this demo." It is not acceptable for a
receiver. It also reads `stealthPrivateKey` out of a *payer-side* demo JSON
(`:119`), so it is not a receiver tool at all.

Solana's path is already clean — the settler is fee payer and the stealth address
needs no SOL (`:240`).

### D5 — Solana deposit intents under-bind `fromAddress` (defect found while speccing)

`privateLedgerDepositIntentMessage` lowercases `fromAddress` unconditionally
(`x402AgentIntent.ts:171`), but the registry stores it case-preserved for Solana
(`PrivateAgentRegistry.ts:952`). Base58 is case-sensitive, so the signed intent
does not uniquely commit to the Solana sender it authorizes. Both sides lowercase
so signatures still verify — this is a binding weakness, not a break. It becomes
load-bearing here because §5.2 makes `fromAddress` a receiver-controlled stealth
address.

---

## 2. The reframe

> **A stealth address is a mailbox, not a wallet.**

The receiver never holds a balance at a stealth address and never spends from
one. Funds land, then flow into the shared pool and credit **one** private-ledger
balance. Spending is `pool-payout`, which is already built.

This resolves D2 and D3 together, and the reason is the interesting part:

- `stealthAddr → myWallet` is a **self-link**. It is the worst possible edge.
- `stealthAddr → pool` is the **same edge every deposit makes**. It terminates in
  the shared anonymity set instead of in an identity.

Sweeping to the pool is therefore both the better UX *and* the better privacy
choice. They are not in tension.

---

## 3. Trust model — what this does NOT claim

State this plainly wherever the feature is described, including to investors.

**Stealth receiving is not private against the server, and never was.** The
server holds `payee.stealthViewingKey` and computes the stealth address itself
(`EvmChainRail.ts:154-159`). It already knows every address that belongs to every
payee. Adding a payee-facing index (§5.1) **adds no trust assumption** — it
exposes to the payee what the server already computes.

The property stealth provides is unlinkability **against public chain
observers**. That is real and unchanged here.

Residual leaks after this spec:

1. **Amount+timing join at the sweep hop.** An observer sees `pool → legAddr` for
   200000, then `legAddr → depositAddr` for 200000. Exact-amount equality plus
   proximity in time is a strong join. Mitigated by sweep delay (§6.3), not
   eliminated. Only ZK or a value-hiding pool removes it.
2. **Two-hop graph.** `legAddr → depositAddr → pool` is public, as documented for
   existing deposits in CLAUDE.md.
3. **The server sees everything live** while processing requests.

Not addressed here, deliberately: a viewing-key-free design where the payee
withholds the viewing key and supplies addresses itself. That would remove the
server's detect capability but also removes its ability to validate that a payout
recipient truly belongs to the payee. Deferred.

---

## 4. Architecture

Three components, independently shippable.

| # | Component | Fixes | Value-moving |
|---|---|---|---|
| A | Inbound announcement index + `/private/a2a/inbox` | D1 | no |
| B | Receiver-signed gasless sweep-to-pool relay | D2, D3, D4 | yes |
| C | `StealthReceiveWallet` client + CLI | D2 (UX) | no (signs only) |

---

## 5. Design

### 5.1 Component A — inbound announcement index

**Store.** New `data/private-inbound-announcements.json` via `EncryptedJsonFile`
with `failClosed: true, durable: true`. Durable, **not** tmpfs: it backs live
claimable funds, same reasoning as the blind-voucher stores.

```ts
interface InboundAnnouncementRecord {
  id: string;
  accountId: string;          // keyed HMAC, same derivation as DepositAddressBook
  network: string;
  caip2: string;
  tokenAddress: string;
  stealthAddress: string;
  ephemeralPubKey: string;    // THE announcement — the thing that is currently lost
  amountAtomic: string;       // expected, from the leg
  source: "pool-payout" | "x402-direct";
  sourceRef: string;          // groupRef:index, or the settle nonce
  status: "announced" | "observed" | "sweeping" | "swept" | "dormant";
  observedAmountAtomic: string | null;
  sweepIntentId: string | null;   // deposit intent consuming it
  sweepTxHash: string | null;
  createdAt: number;
  observedAt: number | null;
  sweptAt: number | null;
}
```

**Write-ahead is mandatory.** The record must be persisted and fsynced **before**
the leg becomes broadcastable — i.e. before `payoutQueue.enqueueGroup` returns in
`enqueuePoolPayoutV2Unlocked`, and before `facilitator.verifyAndSettle` in
`EvmChainRail.settle`. A crash between broadcast and index-write would otherwise
lose the announcement permanently, which is exactly D1. Same durability argument
as the pending-payout journal.

Indexing dry-run legs is harmless: balance stays 0 and dormancy reaps them.

**Reaping.** A record may **never** be reaped while its stealth address holds a
nonzero balance. Only `swept` records age out, after
`PX402_STEALTH_INBOX_RETENTION_MS`. `dormant` (announced, never funded,
past grace) is retained, mirroring `DepositAddressBook.toDormant`.

**Endpoint.** `POST /private/a2a/inbox` — payee-authenticated.

```
request  { agentId, network?, intentNonce, agentSignature }
response { entries: [{ ephemeralPubKey, stealthAddress, network, asset,
                       amountAtomic, observedAmountAtomic, status, sourceRef }],
           totalObservedAtomic }
```

Auth: `assertVpnPeer(payee, remoteIp)` **and** `assertAgentIntent` over a new
`stealthInboxIntentMessage`. Both required — VPN peer alone is not sufficient
authorization to enumerate someone's inbound payments.

`observedAmountAtomic` refreshes via `rail.observedBalanceAtomic`, which already
exists (`EvmChainRail.ts:85-87`). Cap the per-request refresh count and serve
cached values beyond it; do not let one call fan out to unbounded RPC.

**New intent message** (`x402AgentIntent.ts`):

```ts
export const stealthInboxIntentMessage = (input: {
  agentId: string; network: string; intentNonce: string;
}) => JSON.stringify({
  protocol: "px402-stealth-inbox/v1",
  action: "inbox",
  agentId: input.agentId,
  network: input.network,
  intentNonce: input.intentNonce,
});
```

### 5.2 Component B — receiver-signed gasless sweep-to-pool

Flow, per stealth output:

1. Payee reads `/inbox`, picks an entry with `observedAmountAtomic > 0`.
2. Payee calls `/private/a2a/deposit-intent` with
   `fromAddress = <the stealth address>`, `amountAtomic = observedAmountAtomic`.
   Gets a one-time deposit recipient. **No server change needed** — the intent
   already accepts an arbitrary `fromAddress` (`PrivateAgentRegistry.ts:952,986`).
3. Payee derives the one-time key locally via `computeStealthPrivateKey`. **The
   spend key and the derived key never leave the agent.**
4. Payee signs an EIP-3009 `transferWithAuthorization(from=stealthAddr,
   to=depositRecipient, value, validAfter, validBefore, nonce)`.
5. **NEW** `POST /private/a2a/deposit-relay` — server broadcasts with the settler
   paying gas; returns the transaction hash.
6. Payee calls `/private/a2a/deposit-confirm` with that hash. Ledger credits.
7. The existing `DepositConsolidationService` sweeps the one-time deposit address
   into the pool on its normal schedule. Unchanged.

**Why this works with zero changes to verification:** `verifyErc20Transfer` binds
the `Transfer` log's `topics[1]`, not `transaction.from`
(`BasePaymentVerifier.ts:66-73`). The settler broadcasts; the log still reads
`stealthAddr → depositAddr`. That is the bug fixed in `cec0226` paying off — this
design is not possible without it.

**Why it kills D4:** the stealth address needs no native gas, ever. No
`pool → stealthAddr` funding edge exists.

**Default is one deposit intent per leg.** Aggregating several legs into one
deposit address would link those legs to each other. Per-leg intents cost more
addresses, which `DepositConsolidationService` already handles at scale.

#### Relay endpoint — binding rules (security-critical)

The relay must not become a general "broadcast anything" oracle paid for by the
settler. Reject unless **all** hold:

1. An outstanding deposit intent exists, owned by the calling agent
   (`accountId` match), in status `awaiting-payment`.
2. `authorization.to` **equals** that intent's recipient.
3. `authorization.from` **equals** that intent's `fromAddress`.
4. `authorization.value` **equals** `expectedAmountAtomic`.
5. `authorization.validBefore` is within the intent's remaining lifetime.
6. The intent's relay slot is unconsumed (one-shot; tombstone on use).
7. Caller passes `assertVpnPeer` + `assertAgentIntent` over
   `depositRelayIntentMessage`.

Then: simulate via the facilitator's existing `simulateSettle` pre-flight, and
submit **through the `TransactionCoordinator` outbox**. This is a settler-EOA
transaction; per CLAUDE.md every settler-EOA transaction is prepared into the
encrypted fsynced outbox before broadcast. Bypassing it corrupts the shared nonce
pipeline and breaks pool-payout recovery.

Replay safety: the EIP-3009 nonce is single-use on-chain; the local tombstone
stops wasted gas on a resubmit.

**Solana.** No EIP-3009. The payee builds `transferChecked` from the stealth ATA,
partial-signs as token authority, names the settler as fee payer — exactly
`sweepStealth` in `stealthSolana.ts`, which already exists. The relay verifies
instruction/accounts/amount/authority, co-signs, and broadcasts. This mirrors
`SolanaX402Facilitator` and reuses its persisted-signed-bytes recovery discipline.

### 5.3 Component C — `StealthReceiveWallet` (client)

New `src/shared/stealthReceiveWallet.ts`. Pure client. Never sends a spend key.

- **CORRECTED 2026-07-29 (Phase 4a shipped).** This bullet previously said the
  client "persists announcements locally, encrypted with the agent's own key —
  defence in depth so a server-side loss is not fatal." **That is rejected and
  was not implemented.** `ephemeralPubKey` is what bounds retroactive
  de-anonymization: without `R` an attacker holding `kSpend`/`kView` still
  cannot test an arbitrary on-chain address for membership, because the address
  is `Pspend + H(kView·R)·G`. Copying every `R` into browser storage widens that
  exposure for a benefit the server-side book already provides. The shipped
  browser client keeps announcements **in memory only, for the lifetime of the
  panel**, and never persists, caches, syncs, backs up, or logs them; the
  offline suite asserts nothing under `src/client/` writes them. A
  server-side loss of the announcement book remains fatal by design, which is
  why that store is durable, encrypted, and fail-closed.
- Derives addresses from `(spendKey, viewKey, announcement)`; verifies each
  against what the server reported before trusting it.
- Presents **one** aggregate balance per asset.
- Plans sweeps: selects outputs, builds intents, signs authorizations.
- Coin selection for the external-self-custody case (§8, out of scope for v1).

CLI: `npm run inbox` (list + balance), `npm run inbox:sweep` (dry-run by default,
`--confirm` to relay).

The point is that this is a *wallet-layer* problem. Bitcoin users hold hundreds
of UTXOs across hundreds of addresses and never think about it because the wallet
shows one number. That is exactly what C does.

---

## 6. Configuration

| Var | Default | Notes |
|---|---|---|
| `PX402_STEALTH_INBOX_ENABLED` | **`true`** | See below |
| `PX402_STEALTH_INBOX_RETENTION_MS` | 15 min | post-`swept` reap delay |
| `PX402_STEALTH_INBOX_DORMANT_MS` | 24 h | announced-never-funded grace |
| `PX402_STEALTH_SWEEP_RELAY_ENABLED` | `false` | new value-moving surface |
| `PX402_STEALTH_SWEEP_MIN_AGE_MS` | 5 min | delay before a leg may be swept |

**Component A defaults ON, deliberately breaking the flag-off convention.** Every
other privacy feature here ships default-off because it *adds* a surface. A is
different: it is a fund-safety fix. Shipping it off means the system keeps losing
money by default. It adds no trust assumption (§3) and moves no funds.

If that is rejected in review, the fallback is default-off plus a loud
`STEALTH_PAYOUT_NO_INBOX` warning emitted on every stealth payout, and flip the
default one release later. I recommend against the fallback — the warning does
not recover funds already lost.

**Component B defaults OFF.** It moves value and adds a settler-signed broadcast
path. Normal convention applies.

### 6.3 Sweep delay

`PX402_STEALTH_SWEEP_MIN_AGE_MS` exists only to weaken the amount+timing
join in §3.1. It does not eliminate it. Do not describe it as doing so.

---

## 7. Migration

- New encrypted store, created empty on first boot. No ledger schema change.
- **Pre-existing stealth outputs are not recoverable by this spec.** Any payout
  made before Component A ships has no indexed announcement. If the payer still
  holds the ACK JSON, the announcement can be re-imported through a one-shot
  operator tool; otherwise those funds are gone.

  *Verified 2026-07-28:* the only stealth payout leg ever generated
  (`0x5c24793020497C5Dd02a8A1a2167957eE4694dB3`, Base USDC) holds **0 atomic** —
  the payout was never broadcast. **Nothing is stranded today, so no re-import
  tool is needed.** Server-derived one-time *deposit* addresses are unaffected by
  D1 regardless: their keys re-derive from the settler key plus index
  (`EvmChainRail.ts:71-83`). Re-verify this balance immediately before shipping
  Phase 1 if any payout has fired in the interim.
- **D5 fix is a signed-message format change.** Making
  `privateLedgerDepositIntentMessage` network-aware changes the bytes Solana
  clients sign. It must land with a version bump and both formats accepted for
  one release, or every existing Solana depositor breaks. EVM is unaffected
  (already lowercase).

---

## 8. Out of scope (v1)

- **Direct spends from stealth outputs without consolidating.** With standard
  denominations the outputs are notes and coin selection applies. Strictly better
  privacy — no self-link ever — but only matters for external self-custody
  receivers who are not on the ledger.
- **Trustless announcement recovery** via on-chain publication (ERC-5564
  Announcer on EVM, SPL Memo on Solana). Removes the server dependency in A;
  costs gas and makes the announcement set publicly enumerable. Ship as opt-in
  later if a counterparty demands no-server recovery.
- **Deterministic ephemeral keys** from a per-pair shared secret. Would allow
  seed-only rescan with no index at all, but requires a long-term pair secret and
  desynchronizes on gaps. Poor fit for stranger-to-agent payments.
- Blind vouchers as the receive primitive (already built, flag-off).

---

## 9. Test plan

Nothing is "done" without these green.

**A — index**
- `test:stealth:inbox` — announcement indexed before enqueue returns; kill the
  process between index-write and enqueue and assert the record survives restart.
- Payee A cannot read payee B's inbox (wrong VPN peer → reject; wrong signature →
  reject; both must be independently verified).
- A record with nonzero on-chain balance is never reaped.
- Round-trip: index → derive key from `(spendKey, announcement)` →
  `addressForPrivateKey` equals the indexed `stealthAddress`.

**B — relay**
- Rejects each of the 7 binding rules independently (7 cases, one per rule).
- Fork-mainnet: full receive → sweep → deposit-confirm → ledger credit, asserting
  the stealth address holds **zero native gas** throughout.
- Outbox: relay transaction appears in the coordinator outbox before broadcast;
  same-nonce replacement is classified correctly.
- Conservation: after sweep+credit, per-asset zero-sum holds.

**D5**
- Two Solana addresses differing only in case produce **different** signed intents.

**Live**
- One end-to-end receive on Base with a real payout, swept back to ledger, with
  the on-chain graph inspected to confirm no `pool → stealthAddr` gas edge exists.

---

## 10. Phasing

| Phase | Content | Risk |
|---|---|---|
| 1 | ✅ **DONE** — Component A + D5 fix | low — no value movement |
| 2 | Component B, EVM only | high — settler broadcast, outbox-integrated |
| 3 | Component B, Solana | medium — reuses `sweepStealth` |
| 4 | Component C + CLI | low — client only |

Phase 1 alone stops the bleeding: funds stop becoming unrecoverable. Phase 2 is
what actually collapses N addresses into one balance.

---

## 11. Open questions for review

1. Component A default-on — accept, or take the fallback in §6?
2. Per-leg deposit intents (default) vs aggregate: confirm the extra address
   churn is acceptable to avoid cross-leg linkage.
3. ~~Is there outstanding stealth value on Base right now?~~ **Answered: no.**
   Checked on-chain 2026-07-28 — the only payout leg is empty (§7). No re-import
   tool required.
4. Should `/inbox` expose `sourceRef`? It tells the payee which payout a leg came
   from — useful for reconciliation, but it is also the payer-linking datum the
   payee would otherwise not hold. My lean: omit it by default, expose an opaque
   per-entry id instead, and let reconciliation happen client-side.
