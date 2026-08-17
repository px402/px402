# FROZEN SPEC v3 — Standard-denomination payout splitting (plan-producer for the batching group API)

Status: FROZEN v3 (final; the team-lead review is the gate — no re-critique planned).
Supersedes v2. Hand verbatim to a Codex implementation agent. TypeScript strict, no new
dependencies, never print secrets, match existing conventions. Every path/type/line was read
from the live tree.

## v3 rulings applied (from the integrator, binding)

1. **RATIFIED: client produces the plan, server validates it.** The server's
   `validatePlanAgainstPolicy` is the ENTIRE safety boundary and must be COMPLETE — the 9
   mandatory checks are enumerated verbatim in §7 and completeness is treated as a
   blocker-level property with an adversarial malformed-plan smoke (§15).
2. **enqueueGroup boundary is LEAN (batching-owned `EnqueueGroupInput`, §0.1)** (§8). The registry
   validates the plan (9 invariants), recomputes `planHash`, resolves recipients, THEN maps
   `PayoutGroupPlan` → the LEAN `EnqueueGroupInput` — the validation-only binding fields
   (`policyVersion`, `quoteRequirementsHash`, `totalAtomic`, `onchainAtomic`, `offchainChangeAtomic`)
   are consumed AT VALIDATION and NEVER cross; only `planHash` crosses (→ `ledger.payout()`). Leg
   shape = batching's `PoolPayoutLegInput` exactly: `{ index, payoutRef, recipient, amountAtomic,
   ephemeralPubKey?, denominationAtomic? }` (`kind`/`stealthAddress` stay internal); `payoutRef` =
   bare `${groupRef}` for single, `${groupRef}:${index}` for denominations.
3. **Off-chain change is DEFERRED to a fast-follow, NOT this wave.** `offchainChangeAtomic="0"`,
   `offchainChange=null`. `settlePayoutChange` + `source:"change"` land with that fast-follow.
   Consequence: this wave's decomposition produces ONLY exact denomination tilings
   (`sum(legs)==total`) as `strategy:"denominations"`, else falls back to `strategy:"single"`
   (one exact leg). No non-denomination residual leg (that was a v2 idea; it violates check #3).
4. **Ledger v4 is OWNED BY BATCHING** and lands in the FIRST wave (before this one). This spec
   CONSUMES it and re-specifies nothing (§10). The only ledger addition this workstream owns is
   `settlePayoutChange` + `source:"change"`, and it is DEFERRED with off-chain change.
5. **Seams resolved by the integrator** (§16): (a) denominations OFF ⇒ today's exact
   synchronous single-leg wire/receipt is preserved (queue flag off = legacy path byte-for-byte;
   single-leg groups that do run through the queue preserve the synchronous receipt);
   denominations ON ⇒ async ACK + owner-bound claim. (b) settlement-batch exclusion predicate =
   `settledAt != null && batchId == null` (batching ledger-v4).

---

## 0. Critique responses (v2 record — all 14 findings verified against code and ACCEPTED)

| # | Verdict | Resolution | Evidence |
|---|---|---|---|
| B1 | ACCEPT | Bounded enumerate-and-choose over EXACT denomination tilings; examples produced BY the algorithm on a denser 1-2-5 default set (§4-5). v1's `{0.1,1,10,100}` could not split `3.7` under maxLegs 8. | 6-decimal atomic; arithmetic |
| B2 | ACCEPT | Plan computed once, hashed, persisted immutably before first debit; retries replay the stored plan. Ledger dedup/record hardening → **now owned by batching ledger-v4** (§10). | `PrivatePaymentLedger.ts:380-391`, `:451-469` |
| B3 | ACCEPT (pivot) | No synchronous immediate loop; durable tmpfs group queue + owner-bound claim (§8, §11). | `PrivateAgentRegistry.ts:264-343`, `:216` |
| B4 | ACCEPT | `px402-pool-payout/v2` binds quote-hash/total/planHash/legs/announcements/on-chain-total/off-chain-change/policyVersion. Change = dedicated `settlePayoutChange` (`source:"change"`), never `source:"voucher"` — DEFERRED (§9). | `PrivatePaymentLedger.ts:257-281`, `PrivateAgentRegistry.ts:406-418` |
| B5 | ACCEPT | Merged: plan-producer for the frozen `enqueueGroup`; unsettled children excluded from batches; off-chain change is a parent completion action (§8, §16). | `PrivatePaymentLedger.ts:524-527`, `:480` |
| M1 | ACCEPT | No "byte-identical" claims. Denominations OFF = today's synchronous single-leg path preserved; ON = negotiated v2 (§6, §16). | `x402AgentIntent.ts:71-86`, `privateX402Client.ts:79-99,175-205` |
| M2 | ACCEPT | Rails VALIDATE keys; CLIENT mints fresh announcements; server enforces pairwise-distinct + each resolves to its recipient (§7 check 5). | `EvmChainRail.ts:77-81`, `SolanaChainRail.ts:74-78`, `stealth.ts:60`, `stealthSolana.ts:56` |
| M3 | ACCEPT | planned/attempted/settled records + owner-bound repeatable claim (§8, §11). | receipt history disabled; in-memory quote |
| M4 | ACCEPT | Full v2 demo/sweep record; per-leg on-chain records; secrets persisted before broadcast; each pair validated (§13). | `x402-stealth-sweep.mjs:58-67,121-128,215-225`, `x402-pool-payout-live.mjs:144-168,429-450` |
| M5 | ACCEPT | Enumerate-and-choose is finite (`C(L+|D|,|D|) ≤ ENUM_CAP`, parse-enforced), amount-magnitude-independent, no flatten-before-cap, no `continue` loop, exact BigInt, deterministic under injected RNG (§4). | v1 pseudocode |
| M6 | ACCEPT | All breakages enumerated; distribution smoke uses an amount the algorithm can split ≥2 ways (§13, §15). | `pool-payout-smoke.mjs:245-249,331-336,428-442` |
| N1 | ACCEPT | Native-unit fee table + runtime estimator; ATA rent `2,039,280` lamports; RH is ETH-gas ~1¢/leg; `sweepStealth` doesn't close the ATA (§14). | `SolanaX402Facilitator.ts:164-212`, `stealthSolana.ts:114-163`, `X402Facilitator.ts:95-106` |
| N2 | ACCEPT | Quote advertises `maxLegs`; client derives exactly that many; server clamps to signed distinct keys (§6-7). | config vs client default |
| N3 | ACCEPT | Decided: `px402-pool-payout/v2` (§6). | — |

---

## 1. File-by-file change list

| File | Change |
|---|---|
| `src/shared/denominations.ts` | **NEW.** Pure module: types, `decomposePayout` (exact-tiling-or-single, bounded enumerate-and-choose), `parsePayoutDenominations`, `defaultDenominationsAtomic`, constants. Imports only `node:crypto`. |
| `src/shared/payoutPlan.ts` | **NEW.** `PayoutGroupPlan`, `PayoutPlanLeg`, `canonicalPlanBody`, `computePlanHash`, `validatePlanAgainstPolicy` (pure; shared client+server). |
| `src/shared/x402AgentIntent.ts` | Add `poolPayoutV2IntentMessage` (§6.2). Keep v1 `poolPayoutIntentMessage` unchanged (denominations-off path). |
| `src/shared/x402.ts` | Add optional `payoutPolicy?: PayoutPolicyAdvertisement` to `X402PaymentRequirements` + `SolanaX402PaymentRequirements`. |
| `src/shared/privateX402Client.ts` | `preparePoolPayout` branches v1 (policy absent, unchanged) vs v2 (policy present + stealth: decompose, derive distinct announcements, build+hash plan, sign v2 intent). New `PreparedPoolPayoutV2`, `PoolPayoutAck`, `claimPoolPayout`. |
| `src/server/agents/PrivateAgentRegistry.ts` | Add `PayoutSplitPolicy` to options. `payoutFromLedger` dispatches: v1 input → existing synchronous path (unchanged); v2 input → `validatePlanAgainstPolicy` → map the validated plan to batching's lean `EnqueueGroupInput` (§8) → `enqueueGroup` → return `PoolPayoutAck`. Add `claimPoolPayout` delegating to the queue [SEAM]. |
| `src/server/config.ts` | Parse 3 wave-1 env vars into `config.agentRpc.payout` (§12). |
| `src/server/index.ts` | Build `PayoutSplitPolicy` (per-network `DenominationConfig` + `policyVersion`); advertise it in quotes when enabled. |
| `scripts/denomination-smoke.mjs` | **NEW** (`test:denominations`): decomposition + plan-validation (incl. adversarial malformed plans) + v2-intent checks (§15). |
| `scripts/pool-payout-smoke.mjs` | Update all breaking assertions; add a denominations-on group-ACK case (§13). |
| `scripts/x402-pool-payout-live.mjs` | Emit a v2 demo record with per-leg on-chain records (§13). |
| `scripts/x402-stealth-sweep.mjs` | Consume v2 `legs[]`, sweep each, validate each key/address pair; keep v1 single-`receiver` fallback (§13). |
| `package.json` | Add `"test:denominations"`. |
| `CLAUDE.md`, `VERIFICATION.md`, `AGENTS.md`, `pool-payout-spec.md` | Docs + env vars + honest privacy statement; `legs[]` shape (§14, §17). |

[SEAM] The durable queue, `enqueueGroup` impl, per-leg state machine, owner-bound claim,
`accountReference`, and ledger v4 are the batching workstream. This spec produces the plan and
consumes those; it does not implement them.

---

## 2. Constants (`denominations.ts`)

```ts
export const DEFAULT_MAX_PAYOUT_LEGS = 8;
export const DEFAULT_MAX_PAYOUT_LEGS_SOLANA = 3;   // per-ATA rent (§14)
export const ENUM_CAP = 200_000;                    // parse enforces C(L+|D|,|D|) <= ENUM_CAP
export const PAYOUT_POLICY_VERSION = "denom/v1";    // bump on any default-set / semantics change
```

---

## 3. Types

### 3.1 `denominations.ts`
```ts
export interface DenominationConfig {
  denominationsAtomic: bigint[];  // distinct, > 0; smallest = dust unit
  maxLegs: number;                // >=1; hard cap on legs
}
export interface PayoutLeg {
  index: number;
  amountAtomic: string;
  denominationAtomic: string | null; // a denomination (strategy=denominations) or null (single exact leg)
  kind: "denomination" | "exact";    // INTERNAL discriminator; "exact" = the sole single-strategy leg
}
export interface PayoutPlanShape {
  totalAtomic: string;
  onchainAtomic: string;             // == totalAtomic this wave (offchain deferred)
  offchainChangeAtomic: string;      // "0" this wave
  legs: PayoutLeg[];                 // 1..maxLegs; sum(legs)==onchainAtomic
  strategy: "single" | "denominations";
}
export interface DecomposeInput {
  totalAtomic: string;
  config: DenominationConfig;
  random?: () => number;             // [0,1); defaults to crypto-backed; deterministic under injection
  // offchainChange?: boolean;       // RESERVED for the fast-follow; wave-1 throws if true (§9)
}
export function decomposePayout(input: DecomposeInput): PayoutPlanShape;
export function defaultDenominationsAtomic(decimals: number): bigint[]; // 1-2-5 series (§4)
export function parsePayoutDenominations(
  json: string | undefined,
  networks: readonly { network: string; decimals: number; maxLegs?: number }[],
): Map<string, DenominationConfig>;   // throws on malformed / dup / non-positive / C(L+|D|,|D|) > ENUM_CAP
```

### 3.2 `payoutPlan.ts`
```ts
export interface PayoutPlanLeg {
  index: number;
  payoutRef: string;                 // single: `${groupRef}`; denominations: `${groupRef}:${index}` (matches batching §0.1)
  amountAtomic: string;
  denominationAtomic: string | null;
  kind: "denomination" | "exact";    // internal; NOT sent to enqueueGroup
  recipient: string;                 // resolved stealth address (or payee wallet for a non-stealth single leg)
  stealthAddress?: string;           // internal; == recipient when stealth; NOT sent to enqueueGroup
  ephemeralPubKey?: string;          // the announcement
}
export interface PayoutGroupPlan {
  version: 2;
  groupRef: string;                  // == quoteNonce
  network: string;
  asset: string;                     // token contract / mint (rail.tokenConfig.address)
  strategy: "single" | "denominations";
  policyVersion: string;             // "none" when strategy==="single"
  quoteRequirementsHash: string;     // sha256(canonicalJson(quote requirements))
  totalAtomic: string;
  onchainAtomic: string;
  offchainChangeAtomic: string;      // "0" this wave
  legs: PayoutPlanLeg[];
  planHash: string;                  // computePlanHash(body); immutable anchor
}
export interface PayoutPolicyAdvertisement {  // carried in quote requirements when splitting is enabled
  policyVersion: string;
  denominationsAtomic: string[];
  maxLegs: number;
  // offchainChangeEnabled reserved for the fast-follow; omitted / false this wave
}
export function canonicalPlanBody(plan: Omit<PayoutGroupPlan, "planHash">): string; // fixed field order; no agent ids
export function computePlanHash(plan: Omit<PayoutGroupPlan, "planHash">): string;    // "0x"+sha256(canonicalPlanBody)

export interface PlanValidationInput {
  plan: PayoutGroupPlan;
  policy: DenominationConfig;
  policyVersion: string;
  asset: string;                     // rail.tokenConfig.address (authoritative)
  totalAtomic: string;               // authoritative quote amount
  quoteRequirementsHash: string;     // recomputed server-side
  resolveRecipient: (ephemeralPubKey: string) => string; // rail.resolveRecipient(...).recipient
}
export function validatePlanAgainstPolicy(input: PlanValidationInput): void; // throws on ANY violation (§7)
```
`PayoutGroupPlan` carries NO agent identities. Identities used for execution/claim live only
in the batching tmpfs pending-payout journal (`ownerTag`, and — fast-follow — the change
payee), consistent with `EphemeralPaymentJournal` already storing agent ids in tmpfs.

### 3.3 Registry / client
```ts
export interface PayoutSplitPolicy {
  enabled: boolean;
  policyVersion: string;
  byNetwork: ReadonlyMap<string, DenominationConfig>;
  // offchainChange reserved for the fast-follow; hard-false this wave
}
// v1 input UNCHANGED (denominations-off path):
export interface PoolPayoutInput { payerAgentId: string; payeeAgentId: string; quoteNonce: string;
  ephemeralPubKey?: string; agentSignature: string; }
// v2 input:
export interface PoolPayoutV2Input { payerAgentId: string; payeeAgentId: string;
  plan: PayoutGroupPlan; agentSignature: string; }
export interface PoolPayoutAck {   // v2 immediate response (queued; NOT settled)
  kind: "pool-payout"; version: 2; groupRef: string; network: string; strategy: "single" | "denominations";
  status: "queued";
  legs: { index: number; payoutRef: string; amountAtomic: string; recipient: string;
          ephemeralPubKey?: string; state: "planned" }[];
  onchainAtomic: string; offchainChangeAtomic: "0"; payerBalanceAtomic: string; acceptedAt: number;
}
```

---

## 4. Decomposition algorithm (wave-1: exact-tiling-or-single; bounded, deterministic)

Default `defaultDenominationsAtomic(6)` = **1-2-5 series** `{0.1,0.2,0.5,1,2,5,10,20,50,100}` →
`[100000,200000,500000,1000000,2000000,5000000,10000000,20000000,50000000,100000000]`. Denser
than v1's `{0.1,1,10,100}` so real small payouts have ≥2 sub-cap tilings. `|D|=10, L=8 ⇒
C(18,10)=43758 ≤ ENUM_CAP`.

```
decomposePayout({ totalAtomic, config, random = cryptoUniform }):
  T = BigInt(totalAtomic);  require T > 0n
  D = uniqueSortedAsc(config.denominationsAtomic);  smallest = D[0];  L = max(1, config.maxLegs)
  if T < smallest: return single(T)                      # sub-dust -> one exact leg

  # Enumerate multisets M of D (as counts), 1<=|M|<=L, that sum EXACTLY to T.
  # Recursive over denomination index, pruning a branch as soon as partialSum > T or coins > L.
  # Bounded by C(L+|D|,|D|) <= ENUM_CAP (guaranteed at config-parse). Independent of |T|.
  exact = []
  gen(i, coins, sum, counts):
     if sum == T: exact.push(copy(counts)); return
     if i == |D| or coins == L or sum > T: return
     # take another D[i] (stay on this index for multiset), or advance
     if sum + D[i] <= T: counts[i]++; gen(i, coins+1, sum+D[i], counts); counts[i]--
     gen(i+1, coins, sum, counts)
  gen(0, 0, 0n, zeros)

  if exact is empty: return single(T)                    # not tileable under the cap -> one exact leg
  chosen = exact[ floor(random() * exact.length) ]       # uniform among exact tilings -> randomization
  legs = expand(chosen)                                  # each {amount:D[i], denom:D[i], kind:"denomination"}
  fisherYatesShuffle(legs, random);  legs.forEach((l,k)=> l.index=k)
  assert Σ legs.amount == T                               # value preservation (exact BigInt)
  return { totalAtomic:T, onchainAtomic:T, offchainChangeAtomic:"0", legs, strategy:"denominations" }

single(v): { totalAtomic:v, onchainAtomic:v, offchainChangeAtomic:"0",
             legs:[{index:0, amountAtomic:v, denominationAtomic:null, kind:"exact"}], strategy:"single" }
cryptoUniform = () => randomInt(0, 2**32) / 2**32        # node:crypto; never Math.random
```

Properties (M5): enumeration ≤ `ENUM_CAP` and pruned by `sum > T` — bounded time/memory for dust
AND huge amounts; counts never flattened before the cap; legs are real denominations and the sum
is exact BigInt; no `continue`/infinite loop; deterministic under injected `random`; no
canonical/divisibility assumption. Off-chain change and any non-denomination residual leg are the
fast-follow (§9) — this wave is exact-tiling-or-single only, satisfying §7 check 3.

---

## 5. Worked examples PRODUCED BY the algorithm (default 1-2-5 set, L=8)

- **`T=3.7` (3,700,000).** Exact tilings summing to 3,700,000 with ≤8 coins: `{2,1,0.5,0.2}` (4),
  `{2,1,0.5,0.1,0.1}` (5), `{1,1,1,0.5,0.2}` (5), `{2,1,0.2,0.2,0.2,0.1}` (6), … ⇒ **≥2 distinct
  multisets** → distribution smoke passes. `strategy:"denominations"`, `onchain=3.7, offchain=0`.
- **`T=2.0` (2,000,000).** Tilings: `{2}` (1), `{1,1}` (2), `{1,0.5,0.5}` (3), `{0.5,0.5,0.5,0.5}` (4),
  `{1,0.5,0.2,0.2,0.1}` (5), … ⇒ ≥2. `strategy:"denominations"`.
- **`T=3.714159` (sub-`0.1` dust `14,159`).** No exact multiset of D hits it → `strategy:"single"`,
  one exact leg `3,714,159` (paid to a fresh stealth address). Splits once the off-chain-change
  fast-follow moves the dust off-chain (§9).
- **`T=0.03` (< smallest).** `single(30,000)`.
- **`T` huge, > `L`×maxDenom.** No exact tiling → `single(T)`.

---

## 6. Wire v2 — quote capability, intent, client

### 6.1 Quote advertises capability (M1/N2/N3)
When `payout.enabled` and the quote is stealth-capable for the network, the server adds:
```ts
requirements.payoutPolicy = { policyVersion, denominationsAtomic: D.map(String), maxLegs };
```
Absent ⇒ client uses the v1 scalar path. v2 is opt-in per quote, never assumed.

### 6.2 v2 intent (`x402AgentIntent.ts`) — B4
```ts
export const poolPayoutV2IntentMessage = (input: {
  payerAgentId: string; payeeAgentId: string; groupRef: string; network: string; asset: string;
  strategy: "single" | "denominations"; policyVersion: string; quoteRequirementsHash: string;
  totalAtomic: string; onchainAtomic: string; offchainChangeAtomic: string; planHash: string;
  legs: { index: number; amountAtomic: string; ephemeralPubKey?: string }[];   // ordered amounts + announcements
}) => JSON.stringify({
  protocol: "px402-pool-payout/v2", action: "payout",
  payerAgentId: input.payerAgentId, payeeAgentId: input.payeeAgentId, groupRef: input.groupRef,
  network: input.network, asset: input.asset, strategy: input.strategy, policyVersion: input.policyVersion,
  quoteRequirementsHash: input.quoteRequirementsHash, totalAtomic: input.totalAtomic,
  onchainAtomic: input.onchainAtomic, offchainChangeAtomic: input.offchainChangeAtomic,
  planHash: input.planHash, legs: input.legs
});
```
Signed by the payer identity; verified with the existing `assertAgentIntent`
(`PrivateAgentRegistry.ts:881-894`). `planHash` is the immutable anchor; explicit fields let §7
check directly.

### 6.3 Client (`privateX402Client.ts`)
```ts
preparePoolPayout(input): Promise<PreparedPoolPayout /*v1*/ | PreparedPoolPayoutV2> {
  if (!input.requirements.payoutPolicy || !input.requirements.stealthMetaAddress) { /* v1 scalar path — unchanged */ }
  const policy = toDenominationConfig(input.requirements.payoutPolicy);
  const shape = decomposePayout({ totalAtomic: input.requirements.maxAmountRequired, config: policy });
  const refFor = (i) => shape.strategy === "single" ? input.requirements.nonce : `${input.requirements.nonce}:${i}`;
  const legs = shape.legs.map((leg, i) => { const d = derive(input.requirements.stealthMetaAddress); // fresh key/leg
    return { ...leg, payoutRef: refFor(i), recipient: d.stealthAddress,
             stealthAddress: d.stealthAddress, ephemeralPubKey: d.ephemeralPubKey }; });
  const body = { version:2, groupRef: input.requirements.nonce, network, asset: input.requirements.asset,
    strategy: shape.strategy, policyVersion: input.requirements.payoutPolicy.policyVersion,
    quoteRequirementsHash: sha256(canonicalJson(input.requirements)),
    totalAtomic: shape.totalAtomic, onchainAtomic: shape.onchainAtomic,
    offchainChangeAtomic: shape.offchainChangeAtomic, legs };
  const plan = { ...body, planHash: computePlanHash(body) };
  const agentSignature = await input.identitySigner.signMessage(poolPayoutV2IntentMessage({ ...plan,
    legs: plan.legs.map(l => ({ index: l.index, amountAtomic: l.amountAtomic, ephemeralPubKey: l.ephemeralPubKey })) }));
  return { payerAgentId: input.payerAgentId, payeeAgentId: input.payeeAgentId, plan, agentSignature };
}
export const claimPoolPayout = (input: { rpcUrl; groupRef; payerAgentId; payeeAgentId; identitySigner })
  => Promise<PoolPayoutClaimResponse>;   // owner-bound status/settled-legs poll [SEAM]
```
The client persists the plan (esp. every stealth secret for sweeping) BEFORE submitting — mirrors
the "persist `nextPayerPool` before submission" rule already in this file (`privateX402Client.ts:259`).
For `strategy:"single"` the client still derives ONE fresh announcement so the single leg is paid
to a stealth address.

---

## 7. Server validation — `validatePlanAgainstPolicy` MUST reject unless ALL hold (the entire safety boundary)

Enumerated verbatim per the integrator; each is a hard throw. A gap here is a fund/privacy hole.

1. `sum(legs.amountAtomic) === onchainAtomic`.
2. `onchainAtomic + offchainChangeAtomic === totalAtomic === signed-intent totalAtomic === quote.maxAmountRequired`.
3. `strategy==="denominations"` ⇒ every `leg.amountAtomic` is a member of `policy.denominationsAtomic`
   for the resolved `(asset, policyVersion)`; `strategy==="single"` ⇒ `legs.length===1` and
   `legs[0].amountAtomic === totalAtomic`.
4. `legs.length <= policy.maxLegs` (network).
5. Every `leg.ephemeralPubKey` is present-when-stealth, all pairwise DISTINCT, and each resolves via
   `resolveRecipient(leg.ephemeralPubKey) === leg.recipient` (the rail's `checkStealthAddress` /
   `checkSolanaStealthAddress`).
6. `computePlanHash(plan-without-planHash) === plan.planHash` (recomputed server-side).
7. `plan.quoteRequirementsHash === sha256(canonicalJson(resolved quote requirements))`, and
   `plan.asset === rail.tokenConfig.address`, `plan.network === rail.network`,
   `plan.policyVersion === payout.policyVersion` (or `"none"` when `strategy==="single"`).
8. The v2 intent signature verifies (via `assertAgentIntent`) over EVERY bound field
   (payer/payee, groupRef, network, asset, strategy, policyVersion, quoteRequirementsHash,
   totalAtomic, onchainAtomic, offchainChangeAtomic, planHash, ordered leg amounts + announcements).
9. `offchainChangeAtomic === "0"` and there is no off-chain-change component (this wave; the
   fast-follow relaxes this behind its own flag).

Plus preconditions the registry checks before validation: quote exists for `plan.groupRef`;
`quote.payerAgentId/payeeAgentId` match the input; `assertVpnPeer(payer, remoteIp)`; a rail is
configured for `quote.requirements.network`; and (fail-fast) `ledger.balance(payer, assetKey) >=
totalAtomic`.

---

## 8. Plan → batching's LEAN EnqueueGroupInput mapping + claim  [batching owns the impl]

The registry does NOT emit the binding fields. After it (1) verifies the v2 signature, (2) recomputes
`planHash`, (3) runs the 9 invariants (§7), and (4) resolves per-leg recipients, it MAPS the validated
`PayoutGroupPlan` → batching's LEAN `EnqueueGroupInput` (its §0.1, verified byte-for-byte). The
validation-only binding fields (`policyVersion`, `quoteRequirementsHash`, `totalAtomic`,
`onchainAtomic`, `offchainChangeAtomic`) are consumed AT VALIDATION and NEVER cross; only `planHash`
crosses (→ `ledger.payout()`).

```ts
// batching-owned EnqueueGroupInput (§0.1) — the registry produces EXACTLY this (match casing verbatim):
enqueueGroup({
  groupRef,            // == quoteNonce
  ownerTag,            // accountReference(payerAgentId) = acct_${HMAC_SHA256(accountKey, agentId)}
                       //   (ledger accountId(); accountKey derived from PX402_DATA_ENCRYPTION_KEY) [batching-owned]
  network,
  asset,               // rail.tokenConfig.address (lower-cased for EVM). Field is `asset`, NOT tokenAddress
  strategy,            // "single" | "denominations"
  planHash,            // the ONLY binding field that crosses → ledger.payout()
  payerBalanceAtomic,  // PROJECTED post-reservation = ledger.balance(payer,assetKey) − totalAtomic (balance AFTER this payout's debits)
  legs: PoolPayoutLegInput[],
  offchainChange: null // TYPE is null (the literal, not a union) this wave; non-null rejected before any ledger mutation
}) -> QueuedGroupReceipt
```

**PayoutPlanLeg → `PoolPayoutLegInput` (matches batching §0.1 verbatim; 6 fields, 2 dropped):**

| PayoutPlanLeg (internal) | PoolPayoutLegInput (batching §0.1) | note |
|---|---|---|
| `index` | `index` | 1:1 |
| `payoutRef` (single: `${groupRef}`; denominations: `${groupRef}:${index}`) | `payoutRef` | 1:1; single-strategy uses the BARE groupRef |
| `recipient` | `recipient` | 1:1 — resolved stealth address |
| `amountAtomic` | `amountAtomic` | 1:1 |
| `ephemeralPubKey?` | `ephemeralPubKey?` | 1:1; present this wave (stealth required) |
| `denominationAtomic` (string\|null) | `denominationAtomic?` | 1:1, optional/informational; queue ignores |
| `kind` | — | DROPPED (internal to `PayoutGroupPlan`) |
| `stealthAddress?` | — | DROPPED (== `recipient`) |

`planHash` is the ONE field that reaches `ledger.payout()`: batching's ledger-v4 `payout({ …,
payoutRef, planHash })` rejects a duplicate `payoutRef` whose `(payer, asset, network, amount,
planHash)` mismatch (§10) — this spec CONSUMES that. Requirements this spec places on the queue
(batching honors): persist the immutable plan (with `planHash`) in the tmpfs pending-payout journal
BEFORE the first `ledger.payout`; per-leg state `planned → reserved → broadcast → settled | failed`;
exclude unsettled children from `createSettlementBatch` (predicate `settledAt != null && batchId ==
null`); expose an owner-bound, repeatable, identity-free `claimPoolPayout(groupRef)`. Off-chain
change is a parent completion action — **deferred** (§9), so `offchainChange` is always `null` this
wave.

Claim response (batching-owned shape; identity-free — M3):
```ts
export interface PoolPayoutClaimResponse {
  kind: "pool-payout"; version: 2; groupRef: string; network: string; strategy: "single" | "denominations";
  status: "queued" | "in-progress" | "complete" | "partial";
  legs: { index: number; payoutRef: string; amountAtomic: string; recipient: string; ephemeralPubKey?: string;
          state: "planned" | "reserved" | "broadcast" | "settled" | "failed";
          transactionHash?: string; failureReason?: string }[];
  onchainAtomic: string; settledAtomic: string; offchainChangeAtomic: "0"; updatedAt: number;
}
```

---

## 9. Off-chain change — FAST-FOLLOW (NOT this wave)

Deferred per the integrator. When it lands (behind its own flag), it adds, in this workstream:
- `decomposePayout` gains `offchainChange: boolean`; when true it peels a sub-dust residual
  `r` (`0 < r ≤ maxOffchainResidualAtomic`, default `smallest-1`) off-chain, tiling `T-r` exactly
  with denominations (all on-chain legs stay valid denominations — §7 check 3 still holds; no
  non-denomination leg). Wave-1 `decomposePayout` THROWS if called with `offchainChange:true`.
- `PrivatePaymentLedger.settlePayoutChange({ payerAgentId, payeeAgentId, amountAtomic, assetKey,
  changeRef, planHash })` + `source:"change"`: `payer -= r`, `payee += r`, `assertConserved`,
  idempotent by `hash("change:"+changeRef)`, mismatch-reject via a `reservationBinding` like the
  payout path. Authorized by the persisted, signature-verified v2 plan (the intent bound
  `offchainChangeAtomic` + `planHash`) — never `source:"voucher"` (fixes B4). It runs as a durable
  group-completion action AFTER all legs settle; its failure never returns an error that permits
  replay of settled legs.
- `enqueueGroup` then carries `offchainChangeAtomic > "0"` and a NON-null `offchainChange` whose
  exact boundary shape the fast-follow defines (payeeTag vs payeeAgentId is a deliberate fast-follow
  decision — NOT specified here); §7 check 9 is relaxed behind the fast-follow flag.

This wave introduces ZERO ledger changes (§10); `settlePayoutChange`/`source:"change"` ship with
this fast-follow.

---

## 10. Ledger contract — CONSUMED from batching ledger-v4 (owned by batching; specified there)

The batching workstream's ledger-v4 change set lands FIRST and provides (this spec references,
does not re-specify):
- `payout({ …, payoutRef, planHash })` that stores a reservation binding and **rejects a duplicate
  reservation whose (payer, asset, network, amount, planHash) differs** (fixes B2).
- `markPayoutSettled(payoutRef, transactionHash)` that **rejects a conflicting hash** for a settled
  ref (fixes B2; replaces the silent overwrite at `recordPayoutTransaction` `:451-469`).
- reversal data persisted on the durable transfer so `reversePayout` needs no live journal.
- `createSettlementBatch` **excludes unsettled children** via predicate `settledAt != null &&
  batchId == null` (fixes B5; today it batches all unbatched at `:524-527`, and `reversePayout`
  throws once `batchId` is set at `:480`).

The QUEUE (batching) calls these; denominations does not call ledger methods directly this wave.
The only ledger addition this workstream owns is `settlePayoutChange` + `source:"change"`, DEFERRED
with off-chain change (§9).

---

## 11. Planned / attempted / settled + recovery (M3) — batching-owned; requirements

- planned (in the immutable plan) → reserved (`ledger.payout` ok) → broadcast (tx submitted) →
  settled (`markPayoutSettled` stored the immutable hash) → failed (`reversePayout(leg.payoutRef)`,
  per-leg, conservation-safe).
- Aggregate `status`: `complete` (all settled), `partial` (≥1 settled, ≥1 permanently failed after
  the retry budget), else `in-progress`.
- Recovery: the client re-issues `claimPoolPayout(groupRef)` (owner-bound, repeatable) to read
  per-leg state + settled remainder — no reliance on the one-shot ACK, no lost strand. Each
  `payoutRef` is broadcast at most once (durable state + binding), so retries never double-pay.

---

## 12. Config env vars (`config.ts` under `agentRpc`) — wave-1

```ts
payoutDenominationsEnabled: process.env.PX402_PAYOUT_DENOMINATIONS_ENABLED === "true", // default false
payoutDenominationsJson:    process.env.PX402_PAYOUT_DENOMINATIONS,                     // optional per-network JSON
payoutPolicyVersion:        process.env.PX402_PAYOUT_POLICY_VERSION ?? PAYOUT_POLICY_VERSION,
```
`PX402_PAYOUT_OFFCHAIN_CHANGE` is RESERVED for the off-chain-change fast-follow — do NOT add
it this wave. `index.ts`:
```ts
const byNetwork = parsePayoutDenominations(config.agentRpc.payoutDenominationsJson, [
  { network:"base", decimals:6, maxLegs:DEFAULT_MAX_PAYOUT_LEGS },
  { network:"robinhood", decimals:6, maxLegs:DEFAULT_MAX_PAYOUT_LEGS },
  { network:"solana", decimals:6, maxLegs:DEFAULT_MAX_PAYOUT_LEGS_SOLANA },
]);
const payout: PayoutSplitPolicy = { enabled: config.agentRpc.payoutDenominationsEnabled,
  policyVersion: config.agentRpc.payoutPolicyVersion, byNetwork };
```
JSON accepts object form `{ "base": { "denominationsAtomic":[…], "maxLegs":8 } }` or bare array
`{ "base":[…] }`. `parsePayoutDenominations` throws if `C(L+|D|,|D|) > ENUM_CAP`.

---

## 13. Demo/sweep record v2 + ALL script breakages (M4, M6)

Record v2 (`data/pool-payout-demos/*.json`, mode 0600):
```json
{ "version": 2, "createdAt": "…", "network": "base", "asset": "0x…", "strategy": "denominations",
  "totalAtomic": "3700000", "onchainAtomic": "3700000", "offchainChangeAtomic": "0",
  "sender": { "label": "…", "ledgerAccountHint": "…", "balanceBefore": "…", "balanceAfter": "…" },
  "amountDisplay": "3.7 USDC", "publicView": ["…"], "privateView": ["…"],
  "legs": [ { "index":0, "payoutRef":"0x…:0", "amountAtomic":"2000000", "denominationAtomic":"2000000",
      "stealthAddress":"0x…", "ephemeralPubKey":"0x…",
      "spendPrivateKey":"0x…", "viewPrivateKey":"0x…", "stealthPrivateKey":"0x…",
      "stealthPublicKey":"…solana-only…",
      "onchain": { "state":"settled", "transactionHash":"0x…", "explorer":"https://…", "from":"0xpool" } } ] }
```
`x402-stealth-sweep.mjs`: iterate `record.legs[]`; per leg validate `stealthPrivateKey` controls
`stealthAddress` (`addressForPrivateKey` / `publicKeyForSolanaScalar`) before sweeping; sweep each
independently (reuse `runEvm`/`runSolana` per leg). v1 fallback: if `record.legs` absent, normalize
`record.receiver` + `record.onchain` into a one-element leg list (fixes the assumptions at
`x402-stealth-sweep.mjs:58-67,121-128,215-225`).

Breakages to fix (M6): `pool-payout-smoke.mjs:245-249` (recipient/stealth → `legs[0]`; add a v2
group-ACK case for flag-on), `:331-336` (top-level tx hash → per-leg / async claim), `:428-442`
(stealth comparison → per-leg); `x402-pool-payout-live.mjs:144-168` (transcript reads
`receiver`/`amountDisplay`/`sender`/single chain → v2 record), `:429-450` (top-level
`receipt.transactionHash` → per-leg + ACK/claim). Distribution smoke uses `T=3.7` (≥2 tilings on
the 1-2-5 set).

---

## 14. Fee reality check (native units + runtime estimator) — N1

The pool (settler/treasury) is fee payer on every rail. Native units; estimate at runtime.

| Rail | Per-leg on-chain cost (native) | Notes / evidence |
|---|---|---|
| **Base** (USDC `transfer`) | ~45–55k gas × base fee (gwei). `X402Facilitator.ts:95-106`. | Estimate via `getFeeData()` × `estimateGas`; sum across legs. Cheap but not fixed. |
| **Robinhood** (USDG `transfer`, ETH gas) | ~50k gas × RH base fee. Observed ~`0.1 gwei` ⇒ ≈ **1¢/leg**. | ETH is the gas token; not "fractions of a cent." |
| **Solana** (USDC-SPL) | `5,000` lamports/sig + **`2,039,280` lamports (`0.00203928 SOL`) rent per FRESH stealth ATA** (165-byte account). ATA created idempotently, treasury pays: `SolanaX402Facilitator.ts:164-212`. | Rent dominates, scales per leg. Default `maxLegs=3`. Not reclaimed today: `sweepStealth` never `closeAccount` (`stealthSolana.ts:114-163`) → reclaim is open (§18). |

Estimator `estimatePayoutCost(plan, rail)` returns `{ nativeFeeAtomic, perLeg[] }` from live
`getFeeData`/`getMinimumBalanceForRentExemption`; the queue may refuse a plan whose estimated pool
fee exceeds a configured ceiling.

---

## 15. Offline smoke test plan (`scripts/denomination-smoke.mjs`, `test:denominations`)

Covers what this spec owns: decomposition + plan validation (incl. adversarial) + v2 intent. E2E
queue execution/claim/partial-failure is the batching spec's smoke.

1. **Distribution + determinism**: 200× `decomposePayout(T=3.7, default)` ⇒ every plan: legs ∈
   denominations; `sum(legs)===total`; `legs.length ≤ maxLegs`; `strategy==="denominations"`;
   **≥2 distinct multisets**. Injected `random=()=>0` ⇒ stable output (no hang).
2. **Bounded time**: `T=10^15` and `T=1` return within a call-count guard (≤ ENUM_CAP recursion
   steps); dust `T<smallest` ⇒ `strategy:"single"`.
3. **Value preservation**: 1000 random `T` ⇒ `onchainAtomic===T`, `offchainChangeAtomic==="0"`,
   `sum(legs)===T`.
4. **Single fallback**: `T=3.714159` (sub-dust) ⇒ `strategy:"single"`, one exact leg `===T`.
5. **planHash immutability**: mutating any leg amount/announcement changes `computePlanHash`.
6. **`validatePlanAgainstPolicy` completeness (BLOCKER-level — adversarial)**: feed a valid plan,
   then N tampered variants and assert EACH throws, one per §7 check:
   (1) bad sum `sum(legs)!=onchainAtomic`; (2) `onchain+offchain!=total`; (3a) a leg amount not in
   the denomination set (denominations strategy); (3b) single strategy with `legs[0]!=total` or
   `legs.length!=1`; (4) `legs.length > maxLegs`; (5a) two legs sharing an `ephemeralPubKey`;
   (5b) an announcement resolving to a different recipient; (6) tampered `planHash`; (7) wrong
   `quoteRequirementsHash` / wrong `asset` / wrong `policyVersion`; (8) a signature over
   mismatched fields; (9) `offchainChangeAtomic!="0"`. Also assert a fully-valid plan PASSES.
7. **v2 intent round-trip**: `poolPayoutV2IntentMessage` signed by an identity wallet verifies via
   `verifyMessage`; any changed bound field fails verification.
8. **Config parse guard**: a set with `C(L+|D|,|D|) > ENUM_CAP` ⇒ `parsePayoutDenominations` throws.

Offline, dry-run, no RPC, no secrets; exit non-zero on any FAIL.

---

## 16. Rollout + resolved seams

- **Denominations OFF** (default): quotes carry no `payoutPolicy`; clients take the v1 scalar path;
  observable behavior is **today's exact synchronous single-leg wire/receipt** (batching preserves
  this — queue flag off = legacy path byte-for-byte; any one-leg group that runs through the queue
  keeps the synchronous receipt the live demo + smoke read via `receipt.transactionHash`). Exact
  rollback state.
- **Denominations ON** (per network): quote advertises capability; client produces + signs a v2
  plan; server validates (§7) + enqueues (§8); async `PoolPayoutAck` + owner-bound
  `claimPoolPayout`. Start Base/RH; keep Solana `maxLegs=3`.
- Resolved seams (integrator): (a) single-leg payouts migrate to the durable queue as one-leg
  groups while denominations-off preserves today's synchronous receipt; (b) settlement-batch
  exclusion predicate = `settledAt != null && batchId == null`. Both are batching-owned; removed
  from open questions.

---

## 17. Honest privacy statement (CLAUDE.md)

Splitting makes each on-chain leg a STANDARD amount to a FRESH stealth address, so a single payout
no longer carries its total as a visible fingerprint and legs are individually indistinguishable
across agents. It does NOT by itself hide the total from an observer who can GROUP one agent's legs
— in this wave (exact tiling) the legs sum to the total. Recipient unlinkability comes from per-leg
stealth; sender unlinkability from the shared pool. **Amount-anonymity comes from INTERLEAVING legs
with OTHER agents' legs in a batched flush window (the batching workstream)** — per-payout multiset
randomization is a weak secondary defense. Sub-dust amounts fall back to a single exact leg until
the off-chain-change fast-follow moves the dust off-chain. Residual public leaks: the pool paid
someone, the leg count, per-leg standard amounts, and timing (until interleaving lands).
VERIFICATION.md adds `npm run test:denominations`.

---

## 18. Open questions

1. **Solana ATA rent reclaim**: `sweepStealth` should optionally `closeAccount` each stealth ATA to
   reclaim `0.00203928 SOL`/leg to the pool (`stealthSolana.ts:114-163`). Follow-up.
2. **Pre-flight fee ceiling**: should the queue reject/downgrade a plan whose estimated pool fee
   exceeds a configured ceiling (esp. Solana)? Recommend yes; threshold TBD.
3. **Off-chain-change fast-follow scope**: `maxOffchainResidualAtomic` default (`smallest-1` vs
   higher to drop more legs) and whether change may exceed sub-dust — deferred with §9.
4. **[batching] `accountReference` derivation**: must be reproducible for the owner-bound claim and
   leak no identity in durable state — owned by batching ledger-v4; denominations only supplies
   `accountReference(payerAgentId)` as `ownerTag`.

---

## 19. Appendix — schemas for cross-check against batching v2

Immutable plan record `PayoutGroupPlan` and v2 intent: §3.2, §6.2. Lean `EnqueueGroupInput` mapping
and the `PayoutPlanLeg → PoolPayoutLegInput` table: §8 (only `planHash` crosses; the 5 validation-only
binding fields never cross). Claim response
`PoolPayoutClaimResponse`: §8. Consumed ledger-v4 surface (`payout(planHash)`+mismatch-reject,
`markPayoutSettled`+conflict-reject, reversal data, settlement-batch exclusion): §10 —
owned/specified by batching. Deferred ledger addition (`settlePayoutChange` + `source:"change"`): §9.
