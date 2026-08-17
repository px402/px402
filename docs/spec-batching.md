# FROZEN SPEC v4 — Batched payout windows + persisted pending-payout journal (GROUP API)

Target repo: `px402`. Scope: pool-direct
shielded payout (`POST /private/a2a/pool-payout`) across base, robinhood
(`EvmChainRail`) and solana (`SolanaChainRail`). No new npm deps. TypeScript strict.
Secrets never leave encrypted stores.

v2 superseded v1 after Codex's adversarial REJECT (8 BLOCKER, 4 MAJOR, 3 MINOR); I
verified every finding against the tree — §13 records each as fixed / rebutted with
file:line. v3 folded in the integrator's 6 binding decisions on the deferred
questions (§11). **v4 folds in the integrator's reconciliation with denominations v2:**
the CANONICAL LEAN `enqueueGroup` contract (§0.1) — validation-only fields stay in the
registry, only `planHash` (plus `ownerTag`/`legs`/`payerBalanceAtomic`) crosses the
boundary; the unified LEDGER v4 method+field set that both waves consume — implemented in
THIS (first) wave so denominations adds no ledger methods except the deferred
`settlePayoutChange` (§2.5); the batching-owned `accountReference` definition (§2.5); and
the two answered [SEAM] questions — flag-off single-leg keeps today's exact
synchronous wire/receipt via a 0-ms synchronous flush of a one-leg group (§2.8, §11.6),
and the settlement-batch exclusion predicate is `settledAt != null && batchId == null`
(§10.1). The second Codex adversarial pass (REJECT: 6 BLOCKER + 6 MAJOR + 2 MINOR) is folded —
§13.2 records each. **The THIRD targeted pass CLOSED B1A + B5 (confirmed sound) and
left 4 open, now folded here — §13.3 records each:** (B2) recovery reorders so
ledger↔journal reconciliation runs BEFORE any outbox rebroadcast, and a pool-payout tx
is rebroadcast only if its ledger debit is confirmed present; (B1B) `logicalId` is the
idempotency key at BOTH submit-time and recovery — a `queued` leg whose logicalId already
has an outbox entry is resolved via that entry, never re-sent at a fresh nonce, closing
the queued-leg double-pay; (B1C) Solana `null` ALWAYS parks `uncertain` (the
`minContextSlot` absence "proof" is removed — it cannot prove history retention), leaving
manual disposition as the only Solana reversal path; (B6) coordinator recovery
quarantines-and-CONTINUES so a stuck nonce never hangs startup, plus an in-wave guarded
operator escape (cancel-at-nonce / manual-disposition). Plus the `payerBalanceAtomic`
seam semantics (post-reservation projected balance, §0.1). **The FOURTH pass CLOSED B1C
and confirmed B2/B1B/B6 sound for EVM; the 4 remaining were Solana-specific + 2 EVM
recovery edges, folded here — §13.4 records each:** (Solana-B1B) Solana gets its own
durable signed-tx WAL — the queue SPLITS the Solana path into sign → persist(fsync leg
bytes+signature+lastValidBlockHeight) → broadcast, and recovery REBROADCASTS the exact
persisted bytes (never re-signs a new blockhash), closing the Solana double-pay;
(Solana-B6) Solana has no coordinator/quarantine (no sequential nonce) — legs park per-leg
`uncertain` and are released by a DEFINED operator disposition (landed+signature, or
absent gated on machine-verified blockhash expiry + archival attestation); (EVM-B2) the
reverse-direction three-store case consults `OutboxEntry.ref` BEFORE reversing a ledger
orphan, so a broadcast pool tx is never refunded-then-rebroadcast; (EVM-B6) the ENTIRE
network-dependent recovery is bounded by `recoveryBudgetMs`, so a stalled classify RPC
never delays listener binding. **The FIFTH pass CLOSED Solana-B1B (WAL sound, partialSign
idempotency probe-confirmed) and left 3 precise interface/guard items, folded here —
§13.5 records each:** (Solana-B6 binding) `resolvePoolPayoutLeg({landed})` now enforces
`signature === leg.txId` re-derived from the persisted `leg.signedTx` (an unrelated
finalized signature can no longer settle a leg's debit); (EVM-B2 API) an explicit
`outboxEntriesByRef(ref)` enumeration is wired into recovery step 2 so ANY ledger row with
a matching pool send suppresses reversal (EVM-only — Solana's WAL is the journal leg, so a
journal-absent Solana row has no WAL entry and the mismatch cannot arise); (EVM-B6 fence)
the post-listener sweep and any timed-out-but-still-running recovery promise share
`flushNow`'s per-network single-flight lock AND generation-CAS fence every leg write, so a
stale promise that resolves after its budget can never overwrite a concurrently-flushed
leg. **The SIXTH pass CLOSED Solana-B6 and left 2 interface-completion items, folded here —
§13.6 records each:** (EVM-B2) `TransactionOutbox.entriesByRef(ref)` (ALL states) +
`ChainRail.classifyByLogicalId({logicalId, nonce})` are the two primitives recovery step 2
needed to enumerate and classify a journal-less ledger row by ref; and (EVM-B6)
`resolvePoolPayoutLeg` — the one leg-mutating path outside the fence — now captures `gen`,
takes the per-network lock, CAS-writes, and returns `superseded` if the leg advanced. This
is the FROZEN spec: after this fold, only the integrator's wiring verification remains before
implementation. The queue API is an **atomic group API** ratified by the integrator and shared
verbatim with the denominations v2 reviser (§0.1).

Non-negotiable correctness contract added in v2: **at-most-once payout.** Value
moves 0 or 1 times per leg, never 2. When chain state is ambiguous the leg enters a
terminal-for-now `uncertain` state that holds the reserved debit and alerts an
operator — it is NEVER auto-reversed or auto-rebuilt.

---

## 0.1 FROZEN GROUP INTERFACE (cross-check against denominations v2)

The denominations module is a *plan producer* (`src/shared/denominations.ts#decomposePayout`
→ `PayoutPlan`, verified `spec-denominations.md:88-110`). This queue *owns group
execution*. The registry combines the plan + one fresh stealth recipient per leg +
the pseudonymous owner tag, then calls `enqueueGroup`. A single-leg payout is a
one-leg group (`strategy:"single"`, `payoutRef == quoteNonce`, byte-identical to
today per `spec-denominations.md:470-473`).

CANONICAL contract (integrator-reconciled with denominations v2; conform verbatim):

```ts
export interface PoolPayoutLegInput {
  index: number;                 // position in the FINAL shuffled plan
  payoutRef: string;             // "single": `${groupRef}`; "denominations": `${groupRef}:${i}`
  recipient: string;             // resolved one-time stealth addr (or main wallet on no-stealth quote)
  amountAtomic: string;
  ephemeralPubKey?: string;      // present iff the quote carried stealth meta
  denominationAtomic?: string | null;
}

export interface EnqueueGroupInput {   // LEAN (integrator-reconciled, byte-identical to denominations §8)
  groupRef: string;              // == quoteNonce (ledger + claim + coordinator key)
  ownerTag: string;              // accountReference(payerAgentId); reversal + claim-auth binding
  network: string;
  asset: string;                 // rail.tokenConfig.address (lower-cased for EVM)
  strategy: "single" | "denominations";
  planHash: string;              // the ONLY binding field that crosses; flows to ledger.payout()
  payerBalanceAtomic: string;    // PROJECTED post-reservation balance = current balance − totalAtomic
                                 // (the payer's RESULTING balance after all leg debits; receipt returns it directly)
  legs: PoolPayoutLegInput[];    // length 1..maxLegs
  offchainChange: null;          // MUST be null this wave; reject non-null before any ledger mutation
}
// QueuedGroupReceipt: see §2.7.
```

DROPPED from the boundary vs the earlier fat shape: `policyVersion`,
`quoteRequirementsHash`, `totalAtomic`, `onchainAtomic`, `offchainChangeAtomic`. These are
VALIDATION-ONLY — the registry (denominations-owned) verifies the plan's v2 signature,
recomputes `planHash`, and runs the 9 plan invariants using them, THEN maps to this lean
input; they are consumed before enqueue and never cross the boundary. `offchainChange` is
typed as `null` (its future shape is not designed now and it must be null anyway); a
non-null value is rejected with `pool_payout_change_not_enabled` before any ledger mutation.

Single-leg mapping (strategy==="single"): `payoutRef=groupRef` (bare, byte-identical to
today per `spec-denominations.md:470-473`), `planHash` = hash of the one-leg plan. The
durable journal group MAY still persist `planHash` for audit/recovery (§2.6); the on-chain
leg sum is derivable from `legs`, so no dropped field needs re-adding.

Denominations v2 hands the registry a `PayoutPlan` (`spec-denominations.md:88-110`) whose
legs map 1:1 to `PoolPayoutLegInput` (registry fills `recipient`/`ephemeralPubKey`) and
supplies only `planHash` across the enqueue boundary. If its reviser needs a field not
above, they raise it to the integrator BEFORE diverging; likewise if I find a hard blocker
I flag it before changing this shape.

**`offchainChange` this wave (§11.2):** typed `null` at the boundary; the registry
REJECTS any non-null value with `pool_payout_change_not_enabled` before any ledger
mutation. Denominations v2 emits `offchainChange: null` and makes the sub-denomination
remainder an exact on-chain leg, not ledger change, until the change wave ships. The
future `offchainChange` shape (whether it carries a `payeeTag`/`payeeAgentId`) is NOT
designed now.

---

## 0.2 Design summary (read first)

- **Group, not entry.** `PendingPayoutJournal` stores immutable *groups* with N leg
  states. The whole group (all leg reservations + plan + owner tag) is durable BEFORE
  the quote is consumed (closes B7). offchainChange is DEFERRED this wave (§11.2):
  the field stays nullable and is rejected non-null on ingress; no change is reserved.
- **At-most-once.** Leg states `queued → broadcasting → settled | failed | uncertain`.
  `failed` (auto-reverse) requires *authoritative proof the exact signed tx can never
  land*; anything short is `uncertain` (hold debit, alert). `maxAttempts` is a
  quarantine/alert trigger only — never a compensation authority (closes B1).
- **One send owner.** A per-`(chainId,address)` `TransactionCoordinator` holds the
  lease across pending-nonce read → sign → durable outbox fsync → node acceptance →
  confirmation (v1 conservative: hold through confirmation, with same-nonce fee
  replacement on a slow tx). Facilitator prepare/broadcast primitives are lock-free
  (closes B3). Its durable outbox (nonce→hash) is the authority for recovery
  classification.
- **Durable before broadcast.** Journal + outbox writes fsync the temp file, rename,
  then fsync the directory — the pattern already shipped at
  `scripts/x402-pool-payout-live.mjs:69-123` (closes B2 ordering).
- **tmpfs-independent compensation.** Reversal data (`reversalAccountRef`,
  `amountAtomic`) is stamped on the DURABLE ledger payout transfer at reservation
  time, so `reversePayout` no longer reads the tmpfs epoch journal (closes B2
  compensation).
- **Owner-bound claim.** `ownerTag = accountReference(payer)` is persisted on the
  group; claim requires an identity-signed intent whose recomputed tag matches, plus
  a dedicated consumed-nonce scope; status is repeatable until TTL (no lossy one-shot)
  (closes B5).

---

## 1. File-by-file change list

NEW:
- `src/server/payments/PendingPayoutJournal.ts` — durable AES-256-GCM group journal
  (`data/pending-payouts.json`), fsync-hardened writes.
- `src/server/payments/PoolPayoutQueue.ts` — group queue, per-network single-flight
  flusher, crash recovery, claim.
- `src/server/base/TransactionCoordinator.ts` — per-(chainId,address) send lease +
  durable encrypted outbox (`data/settler-outbox.json`) + same-nonce fee replacement.

MODIFIED (production):
- `src/server/rails/ChainRail.ts` — replace `payoutFromPool` with `submitPoolPayout`
  (EVM onchain routes through `coordinator.submit`; dry-run + Solana direct) +
  `poolPayoutStatus`; new result types; status verdict `landed | terminal-absent | uncertain`.
- `src/server/rails/EvmChainRail.ts` — implement `submitPoolPayout` (coordinator-owned) +
  `poolPayoutStatus` (classifyNonce).
- `src/server/rails/SolanaChainRail.ts` — implement the queue-driven split
  `preparePoolPayout` (build+partial-sign, capture signature + `lastValidBlockHeight`, NO
  send) + `broadcastPoolPayout` (`sendRawTransaction`) + `poolPayoutStatus` (finalized
  err===null→landed, err!==null→terminal failure, null→uncertain). No coordinator; the
  durable pending-journal leg is Solana's WAL (Solana-B1B).
- `src/server/base/X402Facilitator.ts` — add lock-free pinned-nonce+fee builders
  `buildPoolTransfer`, `buildTransferWithAuthorization`, `buildCommitBatch`,
  `broadcastRawTransaction`, and finality-aware `poolTransferStatus`; route the on-chain
  `verifyAndSettle` broadcast through the injected coordinator; delete now-dead
  `sendPoolTransfer`.
- `src/server/base/SolanaX402Facilitator.ts` — add `preparePoolTransfer` (captures
  `contextSlot`), `broadcastRawPoolTransfer`, `poolTransferStatus` (finalized err===null →
  landed, err!==null → terminal failure, `null` → ALWAYS uncertain — B1C, no absence proof);
  delete dead `sendPoolTransfer`.
- `src/server/base/PrivateBatchCommitter.ts` — route `commitBatch` through the injected
  coordinator via the lock-free `buildCommitBatch` builder (recoverable from the WAL).
- `src/server/payments/PrivatePaymentLedger.ts` — v3→v4 file bump; payout-transfer fields
  `settledAt?`, `reversalAccountRef?`, `reversalAmountAtomic?`, `planHash?`, `reservationBinding?`;
  `accountReference`; by-reference accessors (no double-HMAC, MAJOR 3); `durable:true` fsync
  persist (B2); `payout(planHash)`; `markPayoutSettled` (finality-gated, conflict-hash reject);
  `reversePayout`/`reverseOrphanPayouts` off durable fields (settledAt===undefined only);
  `findPayoutTransfer`; `createSettlementBatch` predicate `settledAt!=null && batchId==null`;
  per-row fail-closed ambiguous-v3 migration. (`creditReservedChange` DEFERRED with
  offchainChange — §11.2.)
- `src/server/agents/PrivateAgentRegistry.ts` — `payoutFromLedger` → `enqueuePoolPayout`
  (build/validate/reserve group, consume quote, return group receipt) + `claimPoolPayout`;
  per-groupRef in-flight lock; inject `PoolPayoutQueue`; `consumeNonce` scope gains
  `"pool-claim"`.
- `src/server/agents/createPrivateAgentServer.ts` — `/private/a2a/pool-payout` returns
  the group receipt; add `POST /private/a2a/pool-payout-claim`; gate both on the queue.
- `src/shared/x402AgentIntent.ts` — `poolPayoutIntentMessage` binds
  `ephemeralPubKeys: string[]` (align denominations §2, `spec-denominations.md:57`);
  add `poolPayoutClaimIntentMessage`.
- `src/shared/privateX402Client.ts` — `QueuedGroupReceipt` / `PayoutGroupClaim` types;
  `preparePoolPayout` emits `ephemeralPubKeys[]`; add `claimPoolPayout`.
- `src/server/config.ts` — pool-payout queue env block + validation.
- `src/server/index.ts` — build coordinators (one per EVM settler EOA), journal,
  queue; `await queue.recover()` before BOTH listeners; inject queue into registry;
  `queue.stop()` + journal/coordinator close on shutdown.

NEW (scripts — added in v3 per §11.3):
- `scripts/pool-payout-uncertain-audit.mjs` — **read-only** operator visibility.
  Decrypts the pending journal (`PX402_DATA_ENCRYPTION_KEY` from env, never a
  flag) + reconciles against the ledger; prints opaque `groupRef`/leg-index + amount +
  state for every `uncertain` leg/group and every ledger↔journal reserve mismatch. NO
  resolve/retry action (that operator tool is a fast-follow). Exits nonzero if any
  uncertain/mismatch exists so ops tooling can alert. Add
  `"audit:pool-payout-uncertain": "node scripts/pool-payout-uncertain-audit.mjs"` to
  package.json (Node, not tsx — mirrors `audit:private-ledger-state` at package.json:19).
- `scripts/pool-payout-coordinator-escape.mjs` (NEW, B6 escape MECHANISM this wave) —
  GUARDED (admin token) operator tool. EVM address-level (`--nonce N`) drives
  `coordinator.resolveQuarantine` (§2.1): `--cancel` (0-value self-send at the stuck nonce,
  rejected if the payout already landed) or `--disposition (--landed HASH | --absent)`.
  Per-leg (`--leg groupRef:index`, BOTH chains, primary Solana release, Solana-B6) drives
  `queue.resolvePoolPayoutLeg` (§2.7): `--landed --signature SIG` (settle, verified
  finalized-canonical on an archival node) or `--absent --attestation TEXT` (reverse, gated on
  machine-verified blockhash expiry + operator archival-absence attestation). Prints the
  verdict. Add `"escape:pool-payout": "tsx scripts/pool-payout-coordinator-escape.mjs"`.
  Prints the settler-key exclusion banner (§11.5). Richer resolve/retry UI stays fast-follow.

MODIFIED (scripts/docs — added in v2 per B6, extended in v3):
- `scripts/x402-pool-payout-live.mjs` — enqueue → poll authenticated claim to terminal
  → atomically rewrite the demo record; keep preflight no-broadcast + record-before-broadcast
  (`x402-pool-payout-live.mjs:94-123,428-462`). Persist resume material (groupRef +
  demo path) before enqueue; define the random payer identity's crash behaviour
  (regenerate-and-fail-closed: a lost in-memory sweep key ⇒ report funds swept-pending,
  never silently drop). PRINT the operator-exclusion warning banner (§11.5) at startup.
- `scripts/x402-settle-live.mjs`, `scripts/x402-rh-settle-live.mjs`,
  `scripts/x402-fund-rotated-payer.mjs`, `scripts/deploy-private-batch-commitment.mjs`
  — add the SAME loud settler-key exclusion warning banner at startup (§11.5). No logic
  change; these share the settler EOA and must not run against a live server.
- `scripts/x402-stealth-sweep.mjs` — accept a `legs[]` demo record (align denominations
  §3), sweep each leg; single-record back-compat.
- `scripts/private-ledger-state-audit.mjs` — accept `version === 4` (currently pins 3 at
  `:25`).
- `scripts/private-ledger-burn-runtime-proof.mjs` — accept v4 (`:49,:63`).
- `scripts/private-ledger-smoke.mjs` — accept v4 and extend the migration test to
  v1→v2→v3→v4 (`:272,:361,:411`).
- `scripts/pool-payout-smoke.mjs` — full rewrite (§7).
- `VERIFICATION.md`, `CLAUDE.md`, `README.md` — §8.
- `package.json` — add `audit:pool-payout-uncertain` (above); `test:pool-payout` unchanged.

---

## 2. Exact TypeScript signatures

### 2.1 `TransactionCoordinator` (NEW)

The coordinator's durable outbox is the SINGLE write-ahead log for EVERY send from the
shared EVM settler EOA (pool payout, direct x402 settle, batch commit) — B5/3A. It
stores the raw signed bytes + a logical identity + full replacement lineage, so any
crash recovers the exact tx for ANY send kind, not just pool legs.

```ts
export type SettlerSendKind = "pool-payout" | "x402-settle" | "batch-commit";
export type OutboxState = "signing" | "broadcasting" | "included" | "finalized" | "failed" | "uncertain";

export interface OutboxVersion {         // one per fee-bump replacement at the same nonce
  txHash: string;
  signedTx: string;                      // raw signed bytes (encrypted at rest); the exact tx to rebroadcast
  maxFeePerGas: string; maxPriorityFeePerGas: string;
  createdAt: number;
}
export interface OutboxEntry {
  chainId: number; address: string; nonce: number;
  kind: SettlerSendKind; ref?: string;
  // Stable across all fee-bump versions: hash(kind, ref, payloadFingerprint). Two
  // versions with the same logicalId are the SAME logical payment (B1A).
  logicalId: string;
  payloadFingerprint: string;            // EVM: hash(to,calldata,value,chainId) — invariant across replacements
  versions: OutboxVersion[];             // fee-ascending lineage; versions[last] is the current broadcast
  state: OutboxState;
  winningHash?: string;                  // set when a version reaches FINALIZED
}

export interface CoordinatorSubmitInput {
  kind: SettlerSendKind;
  ref?: string;
  logicalId: string;                     // caller-stable id for THIS logical operation
  payloadFingerprint: string;            // invariant part of the tx (to/calldata/value)
  // Build the signed tx at the pinned nonce + fee policy. Called INSIDE the lease;
  // MUST NOT acquire the coordinator (no reentrancy). MUST keep payloadFingerprint
  // invariant across fee versions (only nonce+fees change).
  sign: (input: { nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string }) => Promise<{ signedTx: string; txHash: string }>;
}
export interface CoordinatorResult { txHash: string; nonce: number; state: "finalized" }

/**
 * One instance per EVM settler EOA (keyed (chainId,address)). Serialises every send
 * from that key. Holds the lease across: read pending nonce (max of chain-pending and
 * outbox high-water) -> sign(version) -> outbox.putVersion (fsync) -> node accept ->
 * poll to FINALIZED, fee-bumping the SAME nonce after bumpAfterMs. On timeout with a
 * live/ambiguous nonce it durably QUARANTINES the whole (chainId,address) (B6): new
 * submit() calls QUEUE (never allocated a descendant nonce) while background reconcile
 * continues; startup NEVER hangs on it (recoverOutbox quarantines-and-continues).
 * Solana needs no coordinator (no nonce); its facilitator submits directly.
 */
export class TransactionCoordinator {
  constructor(input: {
    provider: import("ethers").JsonRpcProvider;
    address: string; chainId: number;
    outbox: TransactionOutbox;
    finality: "finalized" | "safe";      // canonical head tag for irreversible actions (MAJOR 1)
    confirmationFloorFallback: number;    // only for chains lacking a finalized tag
    bumpAfterMs: number; timeoutMs: number;
    recoveryBudgetMs: number;            // bounded startup window before quarantine-and-continue (B6)
  });
  // DEDUP BY logicalId (B1B): if the outbox already holds a NON-TERMINAL entry for
  // input.logicalId, submit() does NOT allocate a fresh nonce — it resumes/reconciles that
  // entry (rebroadcast versions[last] / poll to finality). A new nonce is allocated only
  // when no outbox entry for the logicalId exists. This makes a second call for the same
  // leg idempotent even if the leg's journal state and the outbox disagree after a crash.
  submit(input: CoordinatorSubmitInput): Promise<CoordinatorResult>;
  // Recovery classification keyed on logicalId + ALL its versions (B1A). `landed` (with
  // winningHash) if ANY version reached a FINALIZED canonical receipt; `terminal-absent`
  // ONLY when the canonical finalized nonce occupant's payloadFingerprint provably differs
  // from this logicalId's; else `uncertain`.
  classifyNonce(input: { nonce: number; logicalId: string }):
    Promise<{ verdict: "landed" | "terminal-absent" | "uncertain"; transactionHash?: string }>;
  outboxEntryFor(logicalId: string): OutboxEntry | undefined; // recovery/submit cross-check (B1B)
  // Enumerate pool-payout outbox entries carrying a given ledger `ref` (payoutRef). Delegates to
  // `outbox.entriesByRef(ref)` which returns ALL states (incl. FINALIZED/terminal — a nonterminal
  // filter would MISS a finalized entry after a crash BEFORE ledger settlement, sixth pass).
  // Recovery step 2 uses it to suppress reversal of a ledger row whose journal leg is ABSENT but
  // for which a pool tx exists (EVM-B2 reverse-direction edge). Reads OutboxEntry.ref. Each entry
  // carries {logicalId, nonce} so the caller can `classifyNonce` it (already defined above).
  isQuarantined(): boolean;              // exposed to the read-only audit (B6)
  quarantineDetail(): { nonce: number; logicalId?: string; since: number } | undefined; // for the audit
  // Rebroadcast every nonterminal nonce IN ORDER (from WAL raw bytes) within recoveryBudgetMs.
  // A nonce that cannot be brought to finality within the budget QUARANTINES the address and
  // recoverOutbox RETURNS so startup proceeds; background reconcile continues after listeners bind.
  recoverOutbox(): Promise<void>;
  // GUARDED operator escape for a quarantined nonce (B6). Admin-token/CLI gated. Two modes:
  //  - "cancel": sign a 0-value self-send at the stuck nonce with fees above the stuck version,
  //    broadcast, and re-classify — if the payout had already landed the cancel is rejected
  //    (nonce too low) and nothing changes; otherwise the nonce is consumed by the cancel and
  //    the payout's logicalId classifies terminal-absent.
  //  - "disposition": operator supplies the authoritative finalized outcome after chain
  //    inspection ({ landedHash } => settle that logicalId; { absent:true } => terminal-absent),
  //    verified against the finalized head before applied.
  // Either clears quarantine once the nonce resolves. Returns the resulting verdict.
  resolveQuarantine(input: { nonce: number; mode: "cancel" } | { nonce: number; mode: "disposition"; landedHash?: string; absent?: boolean }):
    Promise<{ verdict: "landed" | "terminal-absent"; transactionHash?: string }>;
  close(): void;
}

export interface TransactionOutbox {     // EncryptedJsonFile with durable:true (fsync file->rename->dir)
  putVersion(entry: { chainId: number; address: string; nonce: number; kind: SettlerSendKind; ref?: string; logicalId: string; payloadFingerprint: string; version: OutboxVersion }): Promise<void>;
  setState(logicalId: string, state: OutboxState, winningHash?: string): Promise<void>;
  setQuarantine(chainId: number, address: string, nonce: number | null): Promise<void>; // null clears
  nonterminalNoncesAscending(chainId: number, address: string): OutboxEntry[];
  byLogicalId(logicalId: string): OutboxEntry | undefined;
  // ALL entries (every state, incl. finalized/terminal) carrying this ledger ref. Powers
  // coordinator.outboxEntriesByRef — must NOT filter to nonterminal, or a finalized entry left
  // by a crash-before-ledger-settlement would be missed and the row wrongly reversed (EVM-B2, sixth pass).
  entriesByRef(ref: string): OutboxEntry[];
  highWaterNonce(chainId: number, address: string): number | undefined;
}
```
Critical ordering per send (all inside the lease): read pinned nonce → `sign(version0)`
→ `outbox.putVersion` (fsync, state `broadcasting`) → `broadcastTransaction`. A crash
after putVersion but before/at node accept recovers by rebroadcasting `versions[last]`.
A fee-bump signs `version_{k+1}` (same nonce, invariant payloadFingerprint, higher
fees), `putVersion` (fsync) BEFORE broadcasting it, so the lineage is always durable.

### 2.2 `ChainRail` (MODIFIED)

```ts
export interface ChainRailPreparedPayout {
  network: string; recipient: string; amountAtomic: string;
  mode: "dry-run" | "onchain";
  signedTx?: string; txId?: string; nonce?: number;    // EVM: nonce; Solana: txId = signature
  lastValidBlockHeight?: number;                        // Solana blockhash expiry bound
}
export type ChainRailPayoutVerdict =
  | { status: "landed"; transactionHash: string }
  | { status: "terminal-absent" }        // PROVEN the exact tx can never land -> safe to reverse
  | { status: "uncertain"; detail: string }; // hold debit, alert, never reverse/re-sign

export interface ChainRail {
  // ...unchanged members... readonly poolMode: X402SettlementMode; readonly kind: "evm" | "solana";

  // EVM onchain ONLY: the whole nonce→sign→outbox-WAL→broadcast→finality unit runs through
  // coordinator.submit (coordinator owns the lease/nonce/fee/WAL). Atomic; leg logicalId
  // dedupes against the outbox (B1B).
  submitPoolPayout(input: { recipient: string; amountAtomic: string; nowSeconds: number; logicalId: string }): Promise<ChainRailPreparedPayout>;

  // Solana onchain + dry-run: the QUEUE drives sign → (persist leg, fsync) → broadcast, so
  // the durable signed bytes exist BEFORE the send (Solana has no coordinator/outbox; the
  // durable pending-journal leg IS Solana's WAL — Solana-B1B). preparePoolPayout signs only
  // (no send) and returns the durable material; the queue persists it to the leg (fsync)
  // BEFORE calling broadcastPoolPayout.
  preparePoolPayout(input: { recipient: string; amountAtomic: string; nowSeconds: number; logicalId: string }): Promise<ChainRailPreparedPayout>;
  broadcastPoolPayout(prepared: ChainRailPreparedPayout): Promise<{ txId: string; submitted: boolean }>;

  // SOLANA status path only (prepared carries txId=signature + lastValidBlockHeight):
  // getSignatureStatuses/getTransaction(finalized) (§2.4). EVM classification is NOT routed
  // here — EVM classifies via `classifyByLogicalId` (keyed on logicalId to check ALL fee
  // versions, B1A); `prepared` carries no logicalId, and EVM finality is resolved inside
  // `submitPoolPayout`. So the queue calls this only when `rail.kind === "solana"`.
  poolPayoutStatus(prepared: ChainRailPreparedPayout): Promise<ChainRailPayoutVerdict>;

  // Recovery step-2 reverse-direction lookup (EVM-B2). EVM delegates to
  // coordinator.outboxEntriesByRef(ref) (ALL states); Solana returns [] — Solana's WAL is the
  // journal leg, so a journal-ABSENT Solana row has no separate WAL entry and the
  // reverse-mismatch cannot arise. Returns each entry's classify handle (logicalId + nonce).
  outboxEntriesByRef(ref: string): { logicalId: string; nonce: number }[];
  // Callable classify path for step 2 (EVM-B2, sixth pass) — poolPayoutStatus needs a prepared
  // payout (no logicalId), so this classifies directly by handle. EVM => coordinator.classifyNonce;
  // Solana => throws (never called: outboxEntriesByRef returns [] on Solana).
  classifyByLogicalId(input: { logicalId: string; nonce: number }): Promise<ChainRailPayoutVerdict>;
  // Recovery step 4 pass-through (same rail-adapter pattern as the two methods above — the
  // queue holds rails, not coordinators). EVM => coordinator.recoverOutbox() (rebroadcast every
  // nonterminal nonce in order, quarantine-and-continue within the budget); Solana => no-op
  // (Solana has no coordinator/outbox; its per-leg rebroadcast happens in step 3).
  recoverOutbox(): Promise<void>;
}
```
Queue flush per onchain leg by `rail.kind`:
- **EVM:** `submitPoolPayout` (coordinator-owned atomic sign+outbox+broadcast+finality).
- **Solana:** `preparePoolPayout` (build+partial-sign, capture `signature`+`lastValidBlockHeight`,
  NO send) → `journal.updateLeg(broadcasting, { signedTx, txId: signature, lastValidBlockHeight })`
  **(durable fsync — the commit point)** → `broadcastPoolPayout` (`sendRawTransaction`) → poll
  `poolPayoutStatus`. Recovery rebroadcasts the leg's PERSISTED `signedTx`, never re-signing.
- **dry-run (either):** `preparePoolPayout` simulate-only → mark settled directly.
`submitPoolPayout` (EVM onchain) calls `coordinator.submit({ kind:"pool-payout", ref:
payoutRef, logicalId, payloadFingerprint, sign: ({nonce,maxFeePerGas,maxPriorityFeePerGas})
=> facilitator.buildPoolTransfer({recipient,amountAtomic,nonce,maxFeePerGas,maxPriorityFeePerGas}) })`
and resolves at FINALITY. The `logicalId` is the leg's deterministic id (§2.6), computed the
SAME way here and at enqueue, so `submit` dedupes against any pre-existing outbox entry
(B1B) — a re-flush of the same leg never creates a second send. The COMMIT point is
`outbox.putVersion` (fsync) inside the coordinator, NOT the journal leg state; the EVM leg's
`state`/`txId`/`nonce` are updated as a recovery HINT and are reconciled by `logicalId`, so
any interleaving of the journal vs outbox write is safe. EVM dry-run: `simulatePoolTransfer`
(eth_call) only, throws on revert, returns `{ mode:"dry-run" }`.
For SOLANA the durable commit point is the QUEUE's `journal.updateLeg` (durable fsync of
`signedTx`+`signature`+`lastValidBlockHeight`) BEFORE `broadcastPoolPayout` — the journal
leg IS Solana's WAL (Solana-B1B). A crash after `sendRawTransaction` accepts but before the
call returns is safe: the signed bytes are already durable, so recovery rebroadcasts the
IDENTICAL tx (Solana dedupes by signature) and never re-signs a new blockhash.

### 2.3 `X402Facilitator` (MODIFIED)

```ts
export interface X402FacilitatorOptions { rpcUrl: string; settlerPrivateKey?: string; token?: X402TokenConfig; coordinator?: TransactionCoordinator; }
class X402Facilitator {
  // lock-free pinned-nonce+fee builders. The coordinator supplies nonce + fee policy;
  // these ONLY sign (never read the pending nonce, never self-lock). payloadFingerprint
  // = hash(to, calldata, value, chainId) is invariant across fee versions (MAJOR 2).
  buildPoolTransfer(input: { recipient: string; amountAtomic: string; nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string }): Promise<{ signedTx: string; txHash: string; payloadFingerprint: string }>;
  buildTransferWithAuthorization(input: { payload: X402PaymentPayload; nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string }): Promise<{ signedTx: string; txHash: string; payloadFingerprint: string }>;
  broadcastRawTransaction(signedTx: string): Promise<string>;   // broadcastTransaction; "already known" swallowed; "nonce too low" NOT swallowed -> caller reconciles via classifyNonce
  // FINALITY-aware status (MAJOR 1): a receipt is `landed` only when its block is
  // canonical under the finalized head (reorg-checked). A receipt at shallower depth is
  // `included` (report to client, do NOT settle/reverse/batch). Delegates the
  // terminal-absent-vs-uncertain call to coordinator.classifyNonce(nonce, logicalId).
  poolTransferStatus(input: { logicalId: string; nonce: number }): Promise<ChainRailPayoutVerdict>;
}
```
`verifyAndSettle` on-chain broadcast (X402Facilitator.ts:148-163) now runs through
`coordinator.submit` with `buildTransferWithAuthorization` as its `sign`.
`PrivateBatchCommitter.commit` (PrivateBatchCommitter.ts:24-31) likewise runs through
`coordinator.submit` with a lock-free `buildCommitBatch(nonce, fees)` builder — both are
recoverable from the outbox WAL after a crash (B5/3A). `sendPoolTransfer` deleted.

### 2.4 `SolanaX402Facilitator` (MODIFIED)

```ts
class SolanaX402Facilitator {
  preparePoolTransfer(input: { treasury: string; recipient: string; amountAtomic: string }): Promise<{ signedTx: string; signature: string; lastValidBlockHeight: number; contextSlot: number }>;
  broadcastRawPoolTransfer(signedTx: string): Promise<string>;
  poolTransferStatus(input: { signature: string; lastValidBlockHeight: number }): Promise<ChainRailPayoutVerdict>;
}
```
`poolTransferStatus` (B1C — third pass: `null` absence is NOT safely automatable on
Solana, so we accept the honest limitation and NEVER auto-refund a Solana leg):
1. `getSignatureStatuses([sig], {searchTransactionHistory:true})`. `confirmationStatus:
   "finalized"` and `err === null` ⇒ `landed`. Finalized with `err !== null` ⇒ terminal
   FAILURE ⇒ `terminal-absent` (the tx executed and failed; no value moved — safe to
   reverse). (MINOR 2.)
2. `null` (any reason — not-found OR not-yet-confirmed OR evicted-from-a-pruned-provider)
   ⇒ ALWAYS `uncertain`. There is NO automated absence proof: `minContextSlot ≥ contextSlot`
   does not prove the node retained history across the blockhash-validity interval, and
   `getTransaction` does not accept `minContextSlot` and returns `null` for both not-found
   AND not-confirmed. So a Solana leg with a lost signature PARKS `uncertain` and is
   resolved ONLY by the operator escape (§2.1 `resolveQuarantine` / manual disposition after
   chain inspection). NO ATA-balance fallback. This is fund-safe (never wrong-refunds); the
   honest cost is that a genuinely-absent Solana payout needs a human to release the debit.
   `PX402_SOLANA_HISTORY_RPC_URL` (if set) is only an inspection AID for the operator,
   never a runtime auto-classifier. **EVM auto-resolves via exact-nonce+fingerprint
   inspection; Solana parks for manual disposition.**

### 2.5 `PrivatePaymentLedger` (MODIFIED)

This is the UNIFIED ledger v4 set (integrator-reconciled). It is implemented in THIS
(first) wave and includes everything denominations v2 consumes, so the denominations
wave adds NO ledger methods except the deferred `settlePayoutChange` (§11.2). The
re-critique is specifically checking that `reversePayout`/`reverseOrphanPayouts` read
reversal data from the DURABLE transfer, not the tmpfs epoch journal — they do.

```ts
interface LedgerTransfer { /* ...existing... */
  // payout-source transfers only:
  settledAt?: number;            // presence => terminal + batchable
  reversalAccountRef?: string;   // HMAC account id to credit on reversal (tmpfs-independent)
  reversalAmountAtomic?: string; // amount to credit back on reversal (durable; not the epoch journal)
  planHash?: string;             // binds the leg to its immutable plan
  reservationBinding?: string;   // hash(payerAccountRef,assetKey,network,amountAtomic,planHash) — duplicate-ref guard
}
interface LedgerFile { version: 4; /* rest unchanged */ }

class PrivatePaymentLedger {
  // BATCHING-OWNED helper (denominations §18-q4). Returns the ledger's EXISTING durable
  // account key: `acct_${HMAC_SHA256(accountKey, agentId)}` where accountKey is derived
  // from PX402_DATA_ENCRYPTION_KEY (the private `accountId()` at
  // PrivatePaymentLedger.ts:666-668). Reproducible, identity-free in durable state (no raw
  // agentId at rest), server-only (needs the secret). The registry calls it to compute
  // `ownerTag = accountReference(payerAgentId)` for the group. Just exposes the existing
  // private derivation — no new crypto.
  accountReference(agentId: string): string;
  // payout() takes planHash; stamps reversalAccountRef + reversalAmountAtomic + planHash +
  // reservationBinding on the durable transfer. A duplicate payoutRef whose
  // (payer/asset/network/amount/planHash) binding MISMATCHES the stored one is REJECTED
  // (not silently treated as idempotent); an exact-match replay returns duplicate:true.
  payout(input: { agentId: string; amountAtomic: string; assetKey: string; network: string; payoutRef: string; planHash: string; acceptedAt?: number }): Promise<LedgerPayoutResult>;
  // idempotent; sets settledAt(+hash). REJECTS a CONFLICTING hash for an already-settled
  // ref. Called ONLY after finality (MAJOR 1) — a settled payout is batchable/prunable,
  // so it must be irreversible on-chain first.
  markPayoutSettled(payoutRef: string, transactionHash?: string): Promise<void>;
  // reads reversalAccountRef+reversalAmountAtomic from the DURABLE transfer (NOT the epoch
  // journal) and mutates the account by reversalAccountRef via the BY-REFERENCE accessors
  // below (never re-HMACs an already-acct_ ref — MAJOR 3).
  reversePayout(payoutRef: string): Promise<boolean>;
  // orphan sweep considers ONLY payout transfers with settledAt === undefined && !batchId,
  // so a pruned terminal group's paid transfer is never mistaken for an orphan (B2).
  reverseOrphanPayouts(knownRefs: ReadonlySet<string>): Promise<number>;
  // NEW by-reference internal accessors: mutate the account keyed DIRECTLY by an already
  // acct_-HMAC ref, bypassing the agentId-HMAC in balance()/setBalance() (PrivatePaymentLedger.ts:218-219,625-629,666-668) — MAJOR 3.
  balanceByRef(accountRef: string, assetKey: string): string;   // private/internal
  setBalanceByRef(accountRef: string, assetKey: string, value: bigint): void; // private/internal
  // used by queue recovery to prove the ledger side of a durably-queued leg exists (B2).
  findPayoutTransfer(payoutRef: string): { asset: string; reversalAccountRef?: string; reversalAmountAtomic?: string; settledAt?: number; batchId?: string } | undefined;
  // predicate: settledAt != null && batchId == null  (§10.1) — excludes in-flight payouts.
  createSettlementBatch(input: { assetKey: string; network: string; tokenAddress: string }): Promise<SettlementBatch | undefined>;
  // DEFERRED with offchainChange (§11.2): settlePayoutChange() + a "change" transfer source
  // are NOT added this wave; their future shape needs no journal/file reshape.
}
```
**Power-loss durability (B2/2A).** The ledger's `persist()` currently calls
`file.write` with no fsync (PrivatePaymentLedger.ts:621-622 → EncryptedJsonFile.ts:41-48).
Add a `durable?: boolean` option to `EncryptedJsonFile` that does file-fsync → rename →
dir-fsync (the shipped helper shape at x402-pool-payout-live.mjs:69-123); construct the
ledger, `PendingPayoutJournal`, and `TransactionOutbox` with `{ failClosed: true,
durable: true }`. Non-fund files (transient session state) stay non-durable. Every ledger
transition in this protocol (payout, markPayoutSettled, reversePayout) is therefore
power-loss durable, so a durable journal generation can never outlive its ledger debit.

Migration v3→v4 (§10.4 / §12): stamp `settledAt=acceptedAt` only on payout transfers
whose `transactionHash` receipt is canonical under the FINALIZED head (MAJOR 4C — current
Solana records at `confirmed`, not finalized, so re-reconcile before blessing). A
hashless payout transfer is AMBIGUOUS (dry-run success vs unbroadcast orphan) → **fail
closed**: abort startup and write a reconcile manifest listing each ambiguous ref. There
is NO blanket `ASSUME_DRYRUN` bless (MAJOR 4B — it can permanently bless a crash orphan).
Instead the operator supplies a per-row disposition file
(`data/ledger-migration-reconcile.json`: `{ ref: "settled" | "orphan" }` with a note
field for evidence); migration applies each row (settled ⇒ stamp settledAt; orphan ⇒
reversePayout) and re-runs; any ref left unresolved keeps startup blocked. New fields are
backfilled empty for already-terminal payouts (never reversed). Idempotent; one-way.

### 2.6 `PendingPayoutJournal` (NEW)

```ts
export type LegState = "queued" | "broadcasting" | "settled" | "failed" | "uncertain";
export type GroupState = "queued" | "in-flight" | "settled" | "partial" | "failed" | "uncertain";

export interface PendingPayoutLeg {
  index: number; payoutRef: string; recipient: string; amountAtomic: string;
  ephemeralPubKey?: string; denominationAtomic?: string | null;
  state: LegState; attempts: number;
  // REQUIRED and DETERMINISTIC from the leg's immutable fields, stamped at enqueue while
  // still `queued` (B1B): logicalId = hash(kind:"pool-payout", payoutRef, payloadFingerprint)
  // where payloadFingerprint = hash(recipient, amountAtomic, network/chainId). It is the
  // idempotency key that ties a queued leg to any outbox entry already broadcast for it, so
  // recovery/submit never re-send at a fresh nonce.
  logicalId: string;
  // Monotonic generation, bumped on EVERY successful leg write. A recovery/sweep write must
  // CAS against the gen it read; a stale detached promise (resolved after its budget) NO-OPs
  // if the leg has since advanced under a flush (EVM-B6 fence, fifth pass).
  gen: number;
  signedTx?: string; txId?: string; nonce?: number;
  lastValidBlockHeight?: number; contextSlot?: number; // Solana context (operator-inspection aid only)
  chainStatus?: "included" | "finalized";              // interim finality sub-status (MAJOR 1)
  mode?: "dry-run" | "onchain"; transactionHash?: string; terminalAt?: number;
}
export interface PendingPayoutGroup {
  groupRef: string; ownerTag: string; network: string; asset: string;
  strategy: "single" | "denominations";
  planHash: string;                          // durable bound-plan identity (audit + recovery)
  legs: PendingPayoutLeg[];                   // onchain sum is derivable from legs; no dropped field persisted
  offchainChange: null;                       // always null this wave (§11.2); shape not designed
  groupState: GroupState; createdAt: number; terminalAt?: number;
}
interface PendingPayoutFile { version: 1; groups: PendingPayoutGroup[]; }

export class PendingPayoutJournal {
  constructor(filePath: string, encryptionKey: string);   // EncryptedJsonFile failClosed + fsync wrapper (§10.5)
  load(): Promise<this>;
  list(): PendingPayoutGroup[];
  byRef(groupRef: string): PendingPayoutGroup | undefined;
  knownRefs(): Set<string>;                                // every leg payoutRef of every non-pruned group
  queuedLegs(network: string): { group: PendingPayoutGroup; leg: PendingPayoutLeg }[];
  putGroup(group: PendingPayoutGroup): Promise<void>;      // idempotent create; exact-match replay returns silently
  // Bumps the leg `gen` on success. `expectGen` is a compare-and-set fence (EVM-B6): when
  // provided, the write NO-OPs and returns false if the leg's current gen !== expectGen (the
  // leg advanced under a concurrent flush since the caller read it). Live flush writes omit
  // expectGen; recovery/sweep writes ALWAYS pass the gen they read.
  updateLeg(groupRef: string, index: number, patch: Partial<PendingPayoutLeg>, expectGen?: number): Promise<boolean>;
  setGroupState(groupRef: string, state: GroupState, terminalAt?: number): Promise<void>;
  setChangeState(groupRef: string, state: "credited" | "reversed"): Promise<void>;
  prune(now?: number): Promise<number>;                    // remove terminal groups past claim TTL
  close(): void;
}
```

### 2.7 `PoolPayoutQueue` (NEW)

```ts
export interface QueuedGroupReceipt {
  kind: "pool-payout-queued"; groupRef: string; network: string;
  strategy: "single" | "denominations";
  legs: { index: number; recipient: string; amountAtomic: string; ephemeralPubKey?: string }[];
  offchainChangeAtomic: string;
  state: "queued"; payerBalanceAtomic: string;
  estimatedSubmitBeforeMs: number;      // now + flushMs + maxJitterMs (SUBMIT, not settle — see M2)
}
export interface PayoutGroupClaim {
  groupRef: string; groupState: GroupState | "unknown"; network?: string;
  legs: { index: number; state: LegState; chainStatus?: "included" | "finalized"; mode?: "dry-run" | "onchain"; transactionHash?: string; recipient?: string; amountAtomic?: string; terminalAt?: number }[];
  offchainChange: null;   // deferred (§11.2)
}
export class PoolPayoutQueue {
  constructor(options: {
    journal: PendingPayoutJournal; ledger: PrivatePaymentLedger; rails: ReadonlyMap<string, ChainRail>;
    flushMs: number; maxJitterMs: number; maxAttempts: number; confirmTimeoutMs: number;
    recoveryBudgetMs: number; claimTtlMs: number;
    now?: () => number; random?: () => number;
  });
  enqueueGroup(input: EnqueueGroupInput): Promise<QueuedGroupReceipt>;   // legs already reserved by the registry; this persists the journal group. offchainChange rejected upstream this wave.
  claim(groupRef: string): Promise<PayoutGroupClaim>;                     // repeatable authenticated status until TTL
  recover(): Promise<void>;                                              // ONCE, before start(); network work bounded by recoveryBudgetMs (EVM-B6)
  start(): void; stop(): void;
  // ALL leg mutation for a network runs under ONE per-network single-flight lock: flushNow,
  // the post-listener sweep, AND any detached recovery continuation (a promise that resolved
  // after recover()'s budget returned) acquire the SAME lock — no two run concurrently for a
  // network (EVM-B6 fence part a). Combined with the gen-CAS on every recovery/sweep write
  // (part b), a stale detached promise can neither interleave with a flush nor overwrite a leg
  // the flush has since advanced.
  flushNow(network?: string): Promise<void>;                            // single-flight per network; test hook + timer body
  sweep(network?: string): Promise<void>;                               // post-listener background reconcile of legs left non-terminal by a budget timeout; same lock + gen-CAS

  // GUARDED per-leg operator disposition for an `uncertain` leg (Solana-B6; Solana has no
  // coordinator quarantine, so this is Solana's ONLY release path; also usable for a stuck
  // EVM leg after coordinator resolution). Admin-token/CLI gated.
  //  - { landed, signature }: SIGNATURE-BOUND (Solana-B6, fifth pass). The supplied
  //    `signature` MUST equal `leg.txId`, and `leg.txId` MUST re-derive from the persisted
  //    `leg.signedTx` (recompute the signature from the durable signed bytes — reject a
  //    tampered/mismatched txId). ONLY THEN verify that exact signature is FINALIZED-canonical
  //    (err===null) on an archival node → `markPayoutSettled(ref, signature)` → settled. An
  //    UNRELATED finalized signature (≠ leg.txId) is REJECTED and the leg stays `uncertain` —
  //    an operator can never settle THIS leg's debit with some other transaction.
  //  - { absent: true }: reverse via `reversePayout`, PERMITTED ONLY when the leg's blockhash
  //    is MACHINE-verified expired (Solana: finalized height > lastValidBlockHeight; EVM:
  //    the pinned nonce is consumed by a different finalized tx) AND the operator attests
  //    archival-node absence over the validity interval. The only unprovable residual
  //    (pruned-but-landed) is thereby the operator's attested decision, not an auto-guess.
  //
  //  FENCED under the SAME discipline as sweep/recovery (EVM-B6, sixth pass — this leg-mutating
  //  path was previously unfenced): (a) capture `leg.gen` BEFORE the archival verification RPC;
  //  (b) acquire the leg's per-network single-flight lock AND `updateLeg(..., expectGen)` (CAS)
  //  before EITHER terminal action (settle OR reverse) — if the leg advanced under a concurrent
  //  flush, the write NO-OPs and the disposition RE-VALIDATES against the new state (returns a
  //  "superseded" result rather than applying a stale settle/reversal). The address-level EVM
  //  coordinator escape (`resolveQuarantine`) likewise runs under the coordinator lease so it
  //  cannot race a concurrent settler send.
  resolvePoolPayoutLeg(input: { groupRef: string; index: number } & ({ landed: true; signature: string } | { absent: true; attestation: string })):
    Promise<{ state: "settled" | "failed" | "superseded" }>;
}
```
**Chain-model asymmetry (Solana-B6):** the `TransactionCoordinator`, its quarantine, and
`resolveQuarantine` (§2.1) are EVM-ONLY — they exist to serialise a shared-EOA sequential
nonce. Solana has no sequential nonce and no coordinator; a stuck/ambiguous Solana leg simply
parks per-leg `uncertain` and is released by `resolvePoolPayoutLeg` above. Both escapes are
exposed by `scripts/pool-payout-coordinator-escape.mjs` (§1): `--nonce` mode drives EVM
`resolveQuarantine`, `--leg groupRef:index` mode drives `resolvePoolPayoutLeg`.

### 2.8 `PrivateAgentRegistry` (MODIFIED)

```ts
export interface PoolPayoutInput { payerAgentId: string; payeeAgentId: string; quoteNonce: string; ephemeralPubKeys?: string[]; agentSignature: string; }
export interface PoolPayoutClaimInput { payerAgentId: string; groupRef: string; intentNonce: string; agentSignature: string; }

class PrivateAgentRegistry {
  // Serialised per groupRef by an in-flight lock taken BEFORE the first await (B4).
  // Validates quote/agents/vpn/identity; REJECTS non-null offchainChange with
  // `pool_payout_change_not_enabled` (§11.2, deferred); builds the plan (denominations
  // producer or single-leg) and runs the VALIDATION-ONLY work (verify v2 signature,
  // recompute planHash, run the 9 plan invariants over policyVersion/quoteRequirementsHash/
  // totalAtomic/onchainAtomic/offchainChangeAtomic) — none of which cross the enqueue
  // boundary; resolves one stealth recipient per leg; computes ownerTag=accountReference(payer);
  // reserves EACH leg (ledger.payout with planHash — reservationBinding guards a mismatched
  // duplicate ref); maps to the LEAN EnqueueGroupInput (only planHash + ownerTag + legs +
  // payerBalanceAtomic cross) and persists via queue.enqueueGroup; consumes the quote LAST.
  // Reverses ONLY legs THIS call reserved if group persist fails.
  //
  // FLAG-OFF (§11.6): when pool-payout batching is disabled, the payout is still a
  // one-leg group persisted to the durable journal (crash-safe), but the route then
  // drives a 0-ms SYNCHRONOUS flush of that single group and returns TODAY's
  // `PoolPayoutReceipt` (kind "pool-payout", real transactionHash) byte-for-byte — no
  // claim endpoint. FLAG-ON returns the async QueuedGroupReceipt + claim.
  enqueuePoolPayout(input: PoolPayoutInput, remoteIp: string, nowSeconds: number): Promise<QueuedGroupReceipt | PoolPayoutReceipt>;
  // identity-signed, owner-bound status. Recomputes ownerTag=accountReference(payer),
  // matches group.ownerTag, consumes a "pool-claim"-scoped nonce, returns queue.claim.
  claimPoolPayout(input: PoolPayoutClaimInput, remoteIp: string): Promise<PayoutGroupClaim>;
}
```
`consumeNonce` scope union gains `"pool-claim"` (PrivateAgentRegistry.ts:860).

### 2.9 `x402AgentIntent` (MODIFIED)

```ts
export const poolPayoutIntentMessage = (input: {
  payerAgentId: string; payeeAgentId: string; quoteNonce: string; ephemeralPubKeys: string[]; network: string;
}) => JSON.stringify({ protocol: "px402-pool-payout/v1", action: "payout", payerAgentId: input.payerAgentId, payeeAgentId: input.payeeAgentId, quoteNonce: input.quoteNonce, ephemeralPubKeys: input.ephemeralPubKeys, network: input.network });

export const poolPayoutClaimIntentMessage = (input: { payerAgentId: string; groupRef: string; intentNonce: string }) =>
  JSON.stringify({ protocol: "px402-pool-payout/v1", action: "claim", payerAgentId: input.payerAgentId, groupRef: input.groupRef, intentNonce: input.intentNonce });
```
Back-compat: a 1-element `ephemeralPubKeys` reproduces today's single-key intent
semantics (align denominations §2, `spec-denominations.md:57`).

---

## 3. JSON schemas

- **Durable group journal** (`data/pending-payouts.json`, AES-256-GCM at rest,
  fsync-hardened): `PendingPayoutGroup` (§2.6). Stores NO raw agentId — only
  `ownerTag`/`payeeTag` (server-only HMAC pseudonyms), one-time recipients, amounts,
  and (transiently) signed txs. All chain-public once broadcast.
- **Queued group receipt** (response to `POST /private/a2a/pool-payout`):
  `{ receipt: QueuedGroupReceipt }` (§2.7). No tx hashes. `legs[]` lets the payee
  watch each one-time recipient. `estimatedSubmitBeforeMs` is SUBMIT-time only.
- **Group claim** (response to `POST /private/a2a/pool-payout-claim`):
  `{ claim: PayoutGroupClaim }` (§2.7). Repeatable until `claimTtlMs` after the
  group terminalAt. Returns per-leg state + hash (hashes are already chain-public);
  no one-shot deletion (closes B5 delivery loss).

---

## 4. State machine

Leg: `queued → broadcasting → settled | failed | uncertain`. The leg carries a
`chainStatus?: "included" | "finalized"` sub-status; `broadcasting` legs whose tx has a
receipt but is not yet finalized are `chainStatus:"included"` (surfaced in the claim so
the payee sees the hash early) but stay `broadcasting` — settlement/reversal/batching
require FINALITY (MAJOR 1). The signed identity, once persisted to the outbox, is NEVER
discarded (B1B/B3): there is NO `broadcasting → queued` rebuild branch.

| Leg state | → | Trigger | On-crash (recover) |
|---|---|---|---|
| queued | broadcasting | flush selects leg; `coordinator.submit(logicalId)` (dedup: resume if the outbox already holds this logicalId) reads pinned nonce, `sign`s, `outbox.putVersion` (fsync, the COMMIT point) → node send; leg→`broadcasting` | recovery reconciles by `logicalId` (B1B): outbox entry exists → `classifyNonce` (never re-sent); no entry → reset `queued` (nothing was signed) |
| broadcasting | broadcasting (chainStatus included) | receipt exists but not finalized | re-poll; never settle/reverse from here |
| broadcasting | settled | classify = `landed` at FINALITY (EVM: `submitPoolPayout` finality / `classifyByLogicalId`; Solana: `poolPayoutStatus`); `ledger.markPayoutSettled(ref,hash)`; `updateLeg(settled)` | idempotent re-mark |
| broadcasting | uncertain | status `uncertain`, OR `attempts>=maxAttempts` while tx can still land (quarantine trigger only), OR any post-submission ambiguous error (timeout/5xx/LB) | HELD: never reverse/rebuild/re-nonce; keep the exact signed identity; re-run `classifyNonce`/`poolPayoutStatus`; may resolve later; else stays uncertain + alert |
| broadcasting | failed | status `terminal-absent` PROVEN at finality (EVM: canonical finalized nonce occupant's payloadFingerprint ≠ this logicalId; Solana: finalized `err!==null` ONLY — a `null` Solana status is `uncertain`, never `failed`, §2.4) | `ledger.reversePayout(ref)`; `updateLeg(failed)` |

Note: a same-nonce fee-bump is a NEW outbox version of the SAME logicalId, not a state
change; `classifyNonce` returns `landed` if ANY version of the logicalId reached a
finalized canonical receipt (B1A). There is no branch that returns a leg to unprepared
`queued` once its outbox version exists.

Group derivation (after every leg transition; also on recover). offchainChange is
always null this wave (§11.2), so there is no change credit/reverse step:
- all legs `settled` → group `settled`.
- all legs terminal, ≥1 `failed`, 0 `uncertain` → group `partial`; payee re-quotes the remainder.
- all legs `failed` → group `failed`.
- any leg `uncertain` → group `uncertain`; alert; block finalization until reconciled.
- group terminal (`settled`/`partial`/`failed`) sets `terminalAt`; pruned after `claimTtlMs` AND only once every leg is FINALIZED (no reorg-exposed pruning). `uncertain` groups are NEVER pruned.

`recover()` runs ONCE before `start()` and before either listener (m3). **Ordering is
load-bearing (B2): reconciliation FIRST, any rebroadcast SECOND, and a pool-payout tx is
rebroadcast ONLY if its ledger debit is confirmed present. Steps 2 (local) run to
completion; the network-dependent work (steps 3–5) is bounded by `recoveryBudgetMs`
(EVM-B6): on timeout the affected EVM EOA is quarantined, unfinished Solana legs stay in
place for the post-listener sweep, and listeners bind anyway — a slow/dead RPC NEVER hangs
startup.**
1. `await journal.load()` — LOAD only; NO network sends yet. (Each EVM coordinator has already
   loaded its durable outbox at construction in index.ts, before `queue.recover()` runs, so both
   the journal and every outbox are in memory for step 2's `rail.outboxEntriesByRef`.)
2. **Bidirectional durability reconciliation (B2/2A), local + a bounded classify, BEFORE any
   rebroadcast:**
   - ledger→journal (EVM-B2 reverse-direction edge, wired in the sixth pass): for each payout
     transfer with `settledAt===undefined && !batchId` whose `payoutRef` is NOT in
     `journal.knownRefs()`: BEFORE reversing, query EVERY rail `rail.outboxEntriesByRef(payoutRef)`
     — which delegates to `outbox.entriesByRef(ref)` returning ALL states (a nonterminal filter
     would MISS a finalized entry from a crash-before-ledger-settlement). Solana returns [] (its
     WAL is the journal leg, absent here by definition → no Solana WAL entry → the mismatch cannot
     arise on Solana). **If ANY rail returns an entry, do NOT reverse — a pool tx exists for this
     ref. Reconcile the LEDGER row by ref via `rail.classifyByLogicalId({logicalId, nonce})`:
     landed→`markPayoutSettled(ref, hash)`; terminal-absent→`reversePayout(ref)`; uncertain→leave
     (record for the operator).** No journal leg is required — the outbox entry is the durable
     proof and carries the classify handle; `markPayoutSettled`/`reversePayout` are durable +
     idempotent-by-ref. Only a ref with NO outbox entry on ANY rail is a true orphan →
     `reverseOrphanPayouts` (durable fields, tmpfs-independent).
   - journal→ledger: for every non-terminal leg, verify `ledger.findPayoutTransfer(payoutRef)`
     exists with matching asset/amount/`reversalAccountRef`. If MISSING (ledger rolled back
     below a durable journal generation), PARK the group `uncertain`, alert, and mark the leg
     NO-REBROADCAST — a debit-less leg is NEVER broadcast.
3. **Per-leg reconciliation for EVERY non-terminal leg (B1B), no fresh sends.** The durable
   WAL (EVM outbox / Solana leg bytes), not the leg `state` field, is the authority on whether
   a leg was ever sent. The queue reaches the EVM WAL through its `rail` (the rail wraps the
   coordinator); it never holds the coordinator directly. Skipping groups parked in step 2:
   - **EVM:** `rail.outboxEntriesByRef(leg.payoutRef)` (same method step 2 uses) — a matching
     entry EXISTS → resolve via `rail.classifyByLogicalId({logicalId, nonce})`
     (landed→`markPayoutSettled`; terminal-absent→`reversePayout`; uncertain→park), NEVER
     re-sent at a fresh nonce; NO entry → nothing was signed → set the leg `queued` for the
     first flush. (A `broadcasting` leg carries its own persisted `logicalId`+`nonce`, so
     classify uses those directly; a `queued`-labelled leg whose logicalId nonetheless has an
     entry — the B1B crash edge — is found by this same by-ref lookup.)
   - **Solana:** the leg's own persisted `signedTx`/`signature`/`lastValidBlockHeight` (§2.2) —
     bytes PRESENT → if the blockhash is still valid (finalized height ≤ lastValidBlockHeight)
     REBROADCAST the SAME `signedTx` (idempotent — Solana dedupes by signature), then classify
     via `poolPayoutStatus`: finalized err===null → settled; err!==null → terminal failure →
     reverse; `null` + blockhash PROVABLY expired (finalized height > lastValidBlockHeight) →
     park `uncertain` (only residual is pruned-but-landed; NEVER auto-reverse, NEVER re-sign —
     Solana-B1B/B1C); `null` + still valid → keep polling → uncertain on timeout. Bytes ABSENT
     → nothing was signed → set the leg `queued`.
4. **EVM outbox rebroadcast, SECOND:** for each EVM rail, `rail.recoverOutbox()` (the rail
   pass-through to its `coordinator.recoverOutbox()`) rebroadcasts every nonterminal outbox
   nonce IN ORDER from the WAL raw bytes, SKIPPING any `pool-payout` entry flagged
   no-rebroadcast in step 2. Non-pool `x402-settle`/`batch-commit` entries rebroadcast
   unconditionally. A nonce that cannot reach finality within the remaining budget QUARANTINES
   the address and returns (B6). Solana rails no-op here (their per-leg rebroadcast is step 3).
5. Re-derive each group state from its legs.
6. `queue.start()`. Legs left non-terminal by a budget timeout are picked up by the
   post-listener `sweep`, which re-runs step-3 reconciliation for them.

**Concurrency fence for steps 3/5/6 + the sweep (EVM-B6 fence, fifth pass).** A JS timeout
does NOT cancel a promise, so a classify/rebroadcast started in step 3 can resolve AFTER the
budget returned and after listeners bound — racing a live flush. Two guards make every
recovery/sweep write safe: (a) EVERY leg mutation for a network — flush, sweep, and any
detached recovery continuation — runs under the SAME per-network single-flight lock, so none
interleaves with a flush; (b) each recovery/sweep operation reads `leg.gen` before its network
call and passes it as `expectGen` to `updateLeg`, which NO-OPs if the leg has since advanced.
So the race "stale promise sees no-bytes → flush persists+broadcasts tx A → stale promise
writes `queued` → next flush prepares tx B → double-pay" cannot occur: the stale `queued`
write either can't acquire the lock during the flush, or fails the gen-CAS after it.

Idempotency backstops: `logicalId` is the EVM leg↔outbox key; the Solana leg's persisted
`signedTx`/`signature` is the Solana key; `leg.gen` fences stale recovery/sweep writes;
`ledger.payout`/`markPayoutSettled`/`reversePayout` idempotent by ref/transfer-presence; EVM
re-broadcast is nonce+identity-scoped, Solana signature-scoped (dedupe by signature).
`submit()` dedupes by `logicalId` (§2.1); the Solana queue path dedupes by the leg's persisted
signature — neither can create a second send.

---

## 5. Env vars + validation + docs

`config.ts` `agentRpc` additions (validate at startup — reject non-finite, negative,
`maxAttempts<1`, `confirmations<1`; mirror the retention guard at
PrivatePaymentLedger.ts:171) — closes m2:

```ts
poolPayoutBatchingEnabled: process.env.PX402_POOL_PAYOUT_BATCHING_ENABLED === "true", // default false => sync one-leg path (§11.6)
poolPayoutFlushMs: Number(process.env.PX402_POOL_PAYOUT_FLUSH_MS ?? 60_000),
poolPayoutMaxJitterMs: Number(process.env.PX402_POOL_PAYOUT_MAX_JITTER_MS ?? 0),
poolPayoutMaxAttempts: Number(process.env.PX402_POOL_PAYOUT_MAX_ATTEMPTS ?? 3),      // quarantine trigger only
poolPayoutFinality: process.env.PX402_POOL_PAYOUT_FINALITY ?? "finalized",           // "finalized" | "safe" (MAJOR 1)
poolPayoutConfirmationFloor: Number(process.env.PX402_POOL_PAYOUT_CONFIRMATION_FLOOR ?? 6), // fallback for chains lacking a finalized tag
poolPayoutTimeoutMs: Number(process.env.PX402_POOL_PAYOUT_TIMEOUT_MS ?? 120_000),    // -> coordinator quarantine (B6)
poolPayoutRecoveryBudgetMs: Number(process.env.PX402_POOL_PAYOUT_RECOVERY_BUDGET_MS ?? 15_000), // bounds the ENTIRE network-dependent recovery (EVM classify+rebroadcast + Solana WAL classify+rebroadcast); on timeout, quarantine EVM EOA / leave Solana legs for the post-listener sweep, bind listeners anyway (EVM-B6)
poolPayoutFeeBumpAfterMs: Number(process.env.PX402_POOL_PAYOUT_FEE_BUMP_AFTER_MS ?? 45_000),
poolPayoutClaimTtlMs: Number(process.env.PX402_POOL_PAYOUT_CLAIM_TTL_MS ?? 900_000),
solanaHistoryRpcUrl: process.env.PX402_SOLANA_HISTORY_RPC_URL,                        // OPTIONAL operator-inspection aid only (B1C); NOT a runtime auto-classifier
```
Recommended: flush 60s (privacy vs latency knob, M2/M3); jitter 0 default, 5–15s prod;
maxAttempts 3 (quarantine trigger, NOT compensation); finality "finalized" — reversal,
pruning, and `settled`/batching all require canonical-under-finalized-head, NOT a raw
confirmation count (MAJOR 1); timeout 120s → coordinator quarantine; recoveryBudget 15s
(startup never hangs, B6); feeBump 45s; claim TTL 15m. The blanket
`PX402_LEDGER_MIGRATION_ASSUME_DRYRUN` is REMOVED (MAJOR 4B); migration
reconciliation is per-row (§2.5, §12).

CLAUDE.md Environment-Variables additions (verbatim style): one line each for the 10
queue vars (incl. `PX402_POOL_PAYOUT_BATCHING_ENABLED`, `_FINALITY`,
`_CONFIRMATION_FLOOR`, `_RECOVERY_BUDGET_MS`) + `PX402_SOLANA_HISTORY_RPC_URL`.

**Solana absence — honest limitation (B1C, third pass):** there is NO runtime proof of
Solana non-inclusion. `minContextSlot ≥ contextSlot` does not prove a node retained
history across the blockhash-validity interval, and `getTransaction` accepts no
`minContextSlot` and returns `null` for both not-found and not-confirmed. So a lost Solana
signature ALWAYS parks `uncertain` and is released ONLY by the operator escape (§2.1
`resolveQuarantine` / manual disposition after chain inspection). This is fund-safe (never
wrong-refunds); the cost is a human in the loop for a genuinely-absent Solana payout.
`PX402_SOLANA_HISTORY_RPC_URL` (optional) is only an inspection AID for that operator.
CLAUDE.md note: "`PX402_SOLANA_HISTORY_RPC_URL` — optional history-retaining RPC
(Helius/QuickNode) that AIDS operator inspection of a parked Solana pool-payout leg; it is
never used to auto-classify absence. EVM auto-resolves; Solana parks for manual disposition."

---

## 6. EVM nonce, coordinator, and the at-most-once recovery proof

**Pre-sign decision (unchanged from v1, re-justified):** no enqueue-time pre-signing
(stale gas over the window; long-horizon nonce pinning on the shared EOA; head-of-line
blocking). Sign just-in-time inside the coordinator lease; persist raw tx + hash +
nonce BEFORE node send; recover by re-broadcasting THAT exact tx. Shared EOA proven:
pool payout, direct settle, and batch commit all use the settler key
(X402Facilitator.ts:95-106,148-163; PrivateBatchCommitter.ts:19-29; index.ts:98-111;
settler==treasury required EvmChainRail.ts:24-31). ethers v6 auto-populates nonce from
`getNonce("pending")` and the code uses no `NonceManager` — a single coordinator is
the fix (verified Codex claim #10-11).

**Coordinator ownership (closes B3):** the coordinator is the SOLE lock owner. `submit`
holds the lease across: read pinned nonce (max of chain `getTransactionCount(pending)`
and outbox high-water) → `sign(version, fee policy)` (lock-free builder) →
`outbox.putVersion` (fsync) + journal `broadcasting` (fsync) → node acceptance → poll to
FINALITY, same-nonce fee-bump (new persisted version) after `feeBumpAfterMs`. Builders
NEVER acquire the coordinator (no reentrancy). **v1 = hold through finality
(integrator-ratified, §11.1): correctness over throughput** — no descendant nonce is
assigned against an unconfirmed parent, so there is no stuck-nonce cascade.

**Timeout → address-level quarantine, startup-safe + escapable (B6, third pass).** If a
`submit` (or `recoverOutbox`) hits `poolPayoutTimeoutMs`/`recoveryBudgetMs` with the nonce
still live/ambiguous, the coordinator durably QUARANTINES the whole `(chainId,address)`: it
does NOT allocate `n+1`; new `submit` calls QUEUE; background reconcile keeps
fee-bumping/re-broadcasting the SAME nonce until a version finalizes (→ clear, advance) or
the nonce is proven terminal.
- **Startup never hangs:** `recoverOutbox` runs within `recoveryBudgetMs` and, on an
  unresolved nonce, quarantines-and-RETURNS so the listeners bind; the reconcile continues
  in the background. A permanently-stuck nonce degrades that ONE EOA to "queued sends",
  never a hung server.
- **Operator escape (in-wave MECHANISM):** `coordinator.resolveQuarantine` (§2.1), guarded
  (admin token / CLI), offers `cancel` (0-value self-send at the stuck nonce, high fee — if
  the payout already landed the cancel is rejected `nonce too low` and nothing changes;
  else the nonce is consumed by the cancel and the payout classifies `terminal-absent` →
  reverse) or `disposition` (operator supplies the finalized outcome after chain
  inspection, verified against the finalized head). Either clears the quarantine and
  resolves the affected leg. `isQuarantined()` + `quarantineDetail()` are surfaced to the
  read-only audit and the escape is exposed via `scripts/pool-payout-coordinator-escape.mjs`
  (§1). The richer resolve/retry UI stays fast-follow.

**At-most-once EVM classification** (`coordinator.classifyNonce({nonce, logicalId})` —
keyed on the LOGICAL operation and ALL its outbox versions, B1A):
- If ANY version's `txHash` has a receipt that is CANONICAL UNDER THE FINALIZED HEAD
  (reorg-checked: the receipt block hash equals the canonical block at that height, and
  height ≤ finalized head) with status 1 → `landed` (winningHash = that version). This is
  what makes a successful same-nonce FEE REPLACEMENT count as paid, not absent (B1A).
- else `getTransactionCount(pool,"latest") ≤ nonce` → our tx may still be pending →
  `uncertain` (rebroadcast the SAME raw bytes from the WAL is safe; NEVER reverse).
- else nonce consumed (`count > nonce`) and no finalized receipt for ANY of our versions →
  fetch the CANONICAL finalized occupant of nonce `n`; if its `payloadFingerprint` provably
  ≠ this logicalId's fingerprint → `terminal-absent`. If the occupant cannot be fetched
  authoritatively at finality (external writer, RPC can't serve it) → `uncertain`. Never
  infer from arbitrary `Transfer` logs; never use recipient-uniqueness (false on no-stealth
  quotes, EvmChainRail.ts:70-84).
- `broadcastRawTransaction` swallows "already known" (idempotent resend); "nonce too low"
  routes through `classifyNonce`, never treated as success (closes B1.5).
- Reorg after a `landed` observation: because `landed` requires canonical-under-finalized,
  a normal reorg cannot flip it; if the finalized head itself reorged (deep) the leg is
  re-evaluated and, if the payout is gone, parked `uncertain` — never silently left settled
  against a vanished payout (MAJOR 1).

**At-most-once Solana** (fourth pass — durable-tx WAL + honest limitation). Solana has no
coordinator/nonce; the durable pending-journal LEG is Solana's WAL. The queue SPLITS the
Solana send into sign → persist(leg `signedTx`+`signature`+`lastValidBlockHeight`, fsync) →
broadcast, so a crash after `sendRawTransaction` accepts never loses the signature. Recovery
(§4 step 3-Solana): if the blockhash is still valid, REBROADCAST the exact persisted bytes
(idempotent — Solana dedupes by signature; NEVER re-sign a new blockhash → no double-pay);
then classify. Finalized `err===null` → `landed`; finalized `err!==null` → terminal FAILURE
(atomic execution, no transfer applied → reverse); `null` → ALWAYS `uncertain` (no runtime
absence proof: `minContextSlot` can't certify retention, `getTransaction` returns `null` for
both not-found and not-confirmed). The ONLY residual is crash + blockhash-expiry +
`getTransaction` null (pruned-but-landed vs never-landed, indistinguishable to the machine) →
parked `uncertain`, released ONLY by `resolvePoolPayoutLeg` (§2.7): operator inspects the
stored signature on an archival node and submits `landed`+signature (settle) or `absent`
(reverse, gated on machine-verified blockhash expiry + archival-absence attestation; the
residual pruned-but-landed risk is then the operator's attested decision). No ATA-balance
fallback. **EVM auto-resolves; Solana rebroadcasts-then-parks-for-a-human. Fund-safe: never
auto-double-pays, never auto-wrong-refunds.**

**Operator-script hazard (honest limitation):** a process-local coordinator cannot
lock out repo scripts sharing the key — `x402-pool-payout-live.mjs`,
`x402-settle-live.mjs`, `x402-rh-settle-live.mjs`, `x402-fund-rotated-payer.mjs`,
`deploy-private-batch-commitment.mjs`. Document: these MUST NOT run while the live
server is up; prefer a distinct operator key or an external lock. External-writer
nonce consumption during a crash window resolves to `uncertain` (operator reconcile),
never a double-pay.

---

## 7. Offline smoke test plan (rewrite `scripts/pool-payout-smoke.mjs`)

Keep the real encrypted `PrivatePaymentLedger` + injected mock rails + real
`PendingPayoutJournal`/`PoolPayoutQueue`. Drive flushes with `flushNow` (huge
`flushMs`, `maxJitterMs=0`, injected `now`/`random`). Mock rails implement the triple
with programmable `poolPayoutStatus` verdicts + counters. Simulate a crash by building
a SECOND queue/coordinator over the SAME journal+outbox+ledger files and calling
`recover()`. Enumerated checks:

Group enqueue/flush:
1. Single-leg enqueue returns `kind:"pool-payout-queued"`, `strategy:"single"`, one
   leg with the stealth recipient, no hash, reserved `payerBalanceAtomic`.
2. Journal on disk holds one group, no `agentId`/`"payee"` substring; `ownerTag`
   present and equals `ledger.accountReference("payer")`.
3. `flushNow` drives leg queued→broadcasting→settled (dry-run verdict `landed`);
   conservation `assetTotal==0n`, escrow reflects the payout.
4. Denominations enqueue (inject a 4-leg plan) reserves 4 per-leg refs
   `${groupRef}:${i}`, shuffles broadcast order (stub `random`), and settles all;
   group→`settled`.
5. `claim` returns the group with per-leg hashes; a SECOND claim returns the same
   (repeatable, no loss).

At-most-once (the safety core — closes M4):
6. RPC false-negative: after broadcasting, `poolPayoutStatus` returns `uncertain`;
   flush leaves leg `uncertain`, debit HELD, group `uncertain`, NOT pruned, and NO
   `reversePayout` was called.
7. Proven terminal-absent: verdict `terminal-absent` → leg `failed`, `reversePayout`
   restores exact payer+escrow balances.
8. `maxAttempts` exhausted while tx can still land: transient broadcast errors reach
   `maxAttempts` with status still `uncertain` → leg `uncertain` (NOT failed, NOT
   reversed) — asserts maxAttempts is quarantine-only.
9. Two legs share a recipient (reused ephemeral): both broadcasting, one `landed`;
   assert the other is classified by its OWN nonce/hash via the outbox, not by
   recipient balance/logs.

Concurrency/enqueue (closes B4):
10. `Promise.all` of two identical enqueue bodies → one group persisted, one queued
    receipt returned twice (idempotent), no double reservation, no spurious reverse.
11. Overlapping flush: two `flushNow(base)` in parallel → single-flight guard runs one
    (closes M1); no leg broadcast twice (outbox has one hash per nonce).

Crash recovery:
12. Reserve-then-crash orphan (ledger.payout with no journal group) → `recover` →
    `reverseOrphanPayouts` refunds via DURABLE fields (delete/rename the tmpfs epoch
    dir first to prove tmpfs-independence — closes B2).
13. Broadcasting-crash landed: journal has a `broadcasting` leg; fresh queue whose
    `poolPayoutStatus`=`landed` marks settled WITHOUT re-broadcast (broadcast count
    unchanged).
14. Broadcasting-crash uncertain: verdict `uncertain` → recover keeps `uncertain`,
    holds debit, no reverse, no prune.
15. Broadcasting-crash terminal-absent: verdict `terminal-absent` → recover reverses
    + `failed`; conservation restored.
16. Non-fsync rollback guard: assert the journal write path fsyncs (spy on the
    fsync/`open`+`sync` calls, or assert `writeFileSynced`-style helper is used).

offchainChange deferred (§11.2):
17. Enqueue with non-null `offchainChange` REJECTS with `pool_payout_change_not_enabled`
    before any ledger reservation or journal write; balances unchanged, no group persisted.
18. A normal (null-change) group reserves ONLY the on-chain leg sum — assert no
    `change:${groupRef}` payout transfer exists in the ledger.

Batching + versioning:
19. Only settled legs batch: enqueue+don't-flush → `createSettlementBatch` excludes
    (predicate settledAt!=null && batchId==null); flush→finalize → re-batch includes.
20. v3→v4 migration fixture: a v3 file with a FINALIZED-hash payout → v4 `settledAt`
    stamped; a HASHLESS payout → startup FAILS CLOSED + writes the reconcile manifest;
    supplying a per-row disposition (`settled`/`orphan`) resolves it; a second load is
    byte-stable (idempotent); a crash injected around the migration persist leaves the
    v3 input intact (no partial write) — closes B8/4B/4C.

Real-rail dry-run (retain adapted): 21. EVM `submitPoolPayout` dry-run does one
eth_call and forwards `from`=pool (retain pool-payout-smoke.mjs:476-490); 22. Solana
dry-run simulates without `sendRawTransaction`; 23. EVM+Solana `resolveRecipient`
stealth-vs-main-wallet.

Coordinator: 24. dropped nonce `n` while `n+1` queued → coordinator fee-bump replaces
`n`; `n+1` only mines after `n` resolves; assert no gap/double-send via the outbox.

v4 unified-ledger + flag-off (added in v4):
25. Flag-off byte-for-byte (§11.6): with `poolPayoutBatchingEnabled=false`, a single-leg
    onchain-mock payout returns TODAY's `PoolPayoutReceipt` (`kind:"pool-payout"`,
    `transactionHash` present, `payerBalanceAtomic`, `settledAt`) synchronously — assert
    the exact field set matches the pre-batching receipt; a group was still persisted +
    settled durably (crash-safe). Dry-run variant returns `mode:"dry-run"`, no hash.
26. planHash duplicate guard: `ledger.payout` with an already-used `payoutRef` but a
    DIFFERENT (amount/planHash) is REJECTED (reservationBinding mismatch); an exact
    replay returns `duplicate:true` with no second debit.
27. `markPayoutSettled` conflicting-hash guard: settling an already-settled ref with a
    DIFFERENT `transactionHash` is rejected; same hash is an idempotent no-op.
28. Read-only audit: `scripts/pool-payout-uncertain-audit.mjs` against a journal with one
    `uncertain` group prints its opaque `groupRef` + leg amount + state and exits nonzero;
    against an all-settled journal it exits zero.

Second-pass fund-safety (the 6 blockers — these are the safety core, added in this rev):
29. Fee-replacement winner = landed, NOT refund (B1A): outbox has versions H0,H1 at the
    same nonce+logicalId; H1 has a finalized canonical receipt, H0 does not; crash before
    the journal records the winner; `recover()`/`classifyNonce` returns `landed` (winningHash
    H1), marks the leg settled, and NEVER calls `reversePayout`. A control case where the
    finalized nonce occupant has a DIFFERENT payloadFingerprint → `terminal-absent` → reverse.
30. Power-loss bidirectional recovery (B2/2A): (a) durable queued group whose ledger debit
    is rolled back (simulate by truncating the ledger file to a prior generation) → recover
    PARKS the group `uncertain`, does NOT broadcast, no debit invented. (b) ledger debit with
    no journal leg, settledAt===undefined → `reverseOrphanPayouts` refunds; a pruned settled
    transfer (settledAt set) is NOT reversed.
31. Durable-write assertion: ledger/journal/outbox writes go through the `durable:true`
    fsync path (spy on `open`/`fsync`/rename, or assert the durable helper is invoked).
32. Ambiguous submit error does NOT rebuild (B1B/B3): after `outbox.putVersion` the mock
    broadcast throws a timeout/5xx; the leg stays `broadcasting` with the SAME `txId`/bytes,
    never returns to unprepared `queued`, and no fresh-nonce tx is signed.
33. Solana null ALWAYS uncertain (B1C, third pass): status `null` — for ANY reason, with or
    without a history endpoint, blockhash expired or not → `uncertain`, NO reverse. Finalized
    `err!==null` → terminal failure → reverse; finalized `err===null` → settled. Assert no
    code path auto-reverses a Solana leg on `null`.
34. Outbox WAL recovers a NON-pool send (B5/3A): a mock `x402-settle` submit persists an
    outbox version then "crashes" pre-accept; `recoverOutbox()` rebroadcasts the exact raw
    bytes from the WAL (no nonce gap, no re-sign) before any new send is accepted.
35. Timeout → quarantine (B6/3B): a submit whose nonce never finalizes within
    `poolPayoutTimeoutMs` → `isQuarantined()` true; a subsequent submit is QUEUED (no `n+1`
    allocated); once the stuck nonce finalizes, quarantine clears and the queued send proceeds.
36. Finality gating (MAJOR 1): a receipt present but not canonical-under-finalized keeps the
    leg `broadcasting`/`chainStatus:"included"` (claim shows the hash) and does NOT settle,
    batch, or prune; a reorg that changes the canonical block hash after the first receipt is
    re-evaluated (does not leave a settled leg against a vanished payout).
37. By-reference reversal (MAJOR 3): `reversePayout` restores the EXACT payer balance using
    `reversalAccountRef` (already `acct_`-HMACed) — assert the credited account equals the
    original payer account and the balance is byte-exact (proves no double-HMAC).

Third-pass closure (the 4 remaining blockers — safety core of this rev):
38. Recovery ORDER (B2): construct a durable queued group, then truncate the LEDGER to a
    prior generation (debit rolled back) and ALSO seed an outbox entry for the leg. On
    `recover()`, assert reconciliation runs FIRST (the group is parked `uncertain`) and the
    outbox entry is NOT rebroadcast (broadcast count stays 0) — a debit-less leg never sends.
39. Queued-leg double-pay (B1B, the crux): simulate "crash after outbox-persist + broadcast
    but before submit() returned" — leg label left `queued` while an outbox entry for its
    logicalId exists. `recover()` cross-checks by logicalId and resolves via `classifyNonce`
    (settle if landed), and the next `flushNow` does NOT allocate a fresh nonce for it (assert
    exactly one on-chain send for the logicalId). Companion: a live double-`submit()` of the
    same logicalId produces ONE send (submit dedup).
40. Startup never hangs (B6): a coordinator whose sole nonterminal nonce never finalizes →
    `recoverOutbox()` returns within `recoveryBudgetMs`, `isQuarantined()` true, listeners
    would bind (recover resolves), and a later submit for that EOA is QUEUED not allocated.
41. Operator escape (B6): `resolveQuarantine({mode:"cancel",nonce})` on a stuck-but-unlanded
    nonce → cancel self-send consumes the nonce → the payout logicalId classifies
    `terminal-absent` → leg reverses, quarantine clears. `resolveQuarantine({mode:"disposition",
    nonce, landedHash})` with a finalized-canonical hash → leg settles. A cancel attempted
    when the payout ALREADY landed is rejected (`nonce too low`) and the leg stays settled
    (no double-effect).
Fourth-pass closure (Solana WAL + Solana escape + 2 EVM edges):
42. Solana durable-tx WAL, no double-pay (Solana-B1B): drive a Solana leg through
    prepare→persist(leg signedTx+signature+lastValidBlockHeight, fsync)→broadcast, then
    simulate "crash after sendRawTransaction accepts but before it returns" (leg still
    `broadcasting` with persisted bytes). A fresh queue `recover()` with a mock connection
    whose blockhash is still valid REBROADCASTS the EXACT persisted `signedTx` (assert same
    signature, NO re-sign / new blockhash) and, when the mock reports finalized err===null,
    settles once — assert exactly one distinct signature ever submitted.
43. Solana finalized-fail + null handling: finalized `err!==null` → terminal failure →
    reverse; `null` + blockhash provably expired (mock finalized height > lastValidBlockHeight)
    → parked `uncertain`, NO auto-reverse, NO re-sign; `null` + still valid → rebroadcast + poll.
44. Solana per-leg disposition + SIGNATURE BINDING (Solana-B6, fifth pass): a parked
    `uncertain` Solana leg → `resolvePoolPayoutLeg({landed, signature})` settles ONLY when
    `signature === leg.txId` re-derived from `leg.signedTx` AND finalized-canonical.
    **Negative: an UNRELATED finalized signature (≠ leg.txId) is REJECTED and the leg stays
    `uncertain`** (proves an operator cannot settle this leg's debit with another tx).
    `{absent, attestation}` reverses ONLY when the mock reports blockhash expired (finalized
    height > lastValidBlockHeight) and is rejected while still valid. Assert no automatic
    resolution and that the coordinator quarantine path was NOT used for Solana.
45. EVM reverse-direction three-store edge with the WIRED API (EVM-B2, sixth pass): seed ledger
    debit PRESENT + journal leg ABSENT (not in knownRefs) + an actual pool OUTBOX entry for that
    ref PRESENT. `recover()` step 2 calls `rail.outboxEntriesByRef(ref)` → `outbox.entriesByRef`,
    does NOT reverse, and reconciles the LEDGER row by ref via `rail.classifyByLogicalId({logicalId,
    nonce})` (settle if landed / reverse if terminal-absent) with NO journal leg. **Critical
    ALL-STATE case: the outbox entry is FINALIZED (crash after finalize, before ledger settle) —
    assert `entriesByRef` still returns it (not filtered as nonterminal) and the row is settled,
    not reversed.** A Solana control (journal-absent) returns [] and IS reversed as a true orphan.
    Assert no refund-then-rebroadcast.
46. Startup bound over the WHOLE network recovery (EVM-B6): a mock classify RPC that hangs →
    `recover()` returns within `recoveryBudgetMs`, the affected EVM EOA is quarantined, Solana
    legs are left for the post-listener sweep, and listeners bind (recover resolves) — assert
    total recover() wall-time ≤ budget + slack.
47. Sweep concurrency fence (EVM-B6, fifth pass — the subtle one): start a recovery/sweep op
    that reads a leg's `gen` and STALLS (mock RPC), let a live `flushNow` acquire the lock and
    advance the SAME leg (persist+broadcast tx A, bump gen), THEN let the stalled op resolve and
    attempt its `updateLeg(..., expectGen=oldGen)` write → it NO-OPs (gen-CAS fails); the next
    flush does NOT prepare a second tx B. Assert exactly one on-chain send and the stale
    `queued` write was rejected. Companion: assert the sweep and flush never hold the per-network
    lock simultaneously.

Sixth-pass closure (EVM-B2 wiring + EVM-B6 disposition fence):
48. `resolvePoolPayoutLeg` under the fence (EVM-B6, sixth pass): a disposition captures
    `leg.gen`, then a concurrent `flushNow` advances the SAME leg (bump gen) before the
    disposition's archival RPC returns; the disposition's terminal `updateLeg(..., expectGen)`
    CAS-fails → it returns `{state:"superseded"}`, applies NEITHER a stale settle NOR a stale
    reverse, and does not overwrite the advanced leg. Companion: a disposition on a quiescent
    leg still settles/reverses normally (fence adds no regression). Also assert the address-level
    `resolveQuarantine` runs under the coordinator lease (cannot race a settler send).

Print `N passed, M failed`; exit nonzero on any fail.

---

## 8. Docs to update (B6)

- `CLAUDE.md` pool-payout bullet: rewrite for group-queued batching, durable
  fsync-hardened journal, at-most-once recovery (`uncertain` holds debit + alerts,
  never double-pays), the coordinator/shared-EOA rule, owner-bound repeatable claim
  (an explicit, narrow, capability-scoped exception to "receipt history disabled"),
  the operator-script concurrency prohibition, and the Solana archival-RPC recovery
  dependency (§5, §11.4). Add the 7 env vars + migration flag. Mention
  `npm run audit:pool-payout-uncertain` for operator visibility into parked payouts.
- `VERIFICATION.md`: expand the `test:pool-payout` description (group lifecycle,
  at-most-once/uncertain, crash recovery, tmpfs-independent reversal, v3→v4 fixture);
  update the private-ledger version-assertion sentences to v4; note the migration
  fail-closed behaviour and the assume-dry-run override; add the operator-script
  concurrency warning + the BLOCKING migration-rehearsal gate (§12) to the live-proof
  section (VERIFICATION.md:31-42); add `audit:pool-payout-uncertain` to the checklist.
- `README.md`: update the agent-payment/pool-payout description to say payouts
  are queued/batched and settle asynchronously (claim to learn the hash).

---

## 9. Honest privacy statement (M3-scoped)

Against an EXTERNAL, CHAIN-ONLY observer: shuffle + cross-group interleaving in a
flush window breaks 1:1 request→transfer *ordering* correlation IFF ≥2 legs in the
window are plausibly interchangeable (similar/denominated amounts). Denomination
legs (from the denominations spec) make amounts non-distinctive, which is what makes
the shuffle meaningful — a distinctive exact amount still self-identifies despite
shuffle. Effective anonymity set = co-window legs that remain indistinguishable AFTER
amount/timing side-information, not "every pool participant."

Does NOT hide from: (a) the facilitator host itself — it sees the inbound request, the durable
group, the broadcast, and claim polling; (b) a combined VPN-metadata + chain observer
correlating WireGuard packet timing with broadcasts; (c) per-leg amounts on-chain.
`uncertain` legs have NO finite settlement bound. Larger `flushMs`/more co-window
legs ⇒ bigger set, higher latency.

---

## 10. Correctness interactions (mandatory)

1. **Batch exclusion (SEAM answer #2, integrator-confirmed)** — `createSettlementBatch`
   eligibility predicate for a payout-source transfer is exactly
   **`settledAt != null && batchId == null`**. A queued/broadcasting/uncertain leg
   (`settledAt == null`) is excluded, else it becomes un-reversible while unsettled
   (reversePayout throws once batched, PrivatePaymentLedger.ts:472-485,514-541 — Codex
   verified #4). Non-payout transfers (voucher/deposit) keep their existing
   `batchId == null` eligibility.
2. **Quote consumption** — consumed at enqueue AFTER the whole group is durable
   (B7). Async retries are server-side (flusher); the client never re-submits a
   consumed quote. A fully-`failed` group is learned via claim → payee re-quotes.
3. **tmpfs-independent reversal** — reversal reads `reversalAccountRef` +
   `reversalAmountAtomic` from the DURABLE payout transfer, not the tmpfs epoch journal
   (EphemeralPaymentJournal.ts:38-44; reversePayout old path
   PrivatePaymentLedger.ts:472-501 — B2). The re-critique is verifying this read-path
   change specifically — it MUST NOT call `journal.read(epochId)` for reversal data.
4. **Migration fail-closed, per-row** — §2.5; ambiguous hashless v3 payout ⇒ abort +
   write a reconcile manifest; operator supplies a per-row `settled`/`orphan` disposition
   (NO blanket ASSUME_DRYRUN — MAJOR 4B). Only FINALIZED-canonical hashes are auto-blessed
   (MAJOR 4C). Update all v3 assertions to v4 (B6).
5. **Durable writes (fund-critical trio)** — the LEDGER, `PendingPayoutJournal`, and
   `TransactionOutbox` all use the `EncryptedJsonFile` `durable:true` path (file-fsync →
   rename → dir-fsync, shape at x402-pool-payout-live.mjs:69-123). The ledger's current
   `persist()` (PrivatePaymentLedger.ts:621-622) and `EncryptedJsonFile.write`
   (EncryptedJsonFile.ts:41-48) are atomic but NOT power-loss durable — that is the B2/2A
   fix; do NOT leave the ledger on the bare write. Non-fund files stay non-durable.
6. **Route/startup gating** — `recover()` fully completes before BOTH the public and
   private listeners; `queue.start()` is the single arming owner, called once after
   recover; the claim route gates on an initialized `payoutQueue`, not merely `ledger`
   (m3).

---

## 11. Integrator decisions (folded into v3, BINDING)

All six v2 open questions are resolved by the integrator. These are frozen; the
implementer follows them, not the earlier "open" framing.

1. **Coordinator = hold-through-confirmation.** v1 holds the lease through confirmation
   (§6). Correctness over throughput at demo scale; eliminates the stuck-nonce cascade.
   The release-before-confirm pipeline is a documented FAST-FOLLOW — do NOT build now.
2. **offchainChange = deferred (change-LESS this wave).** Do NOT implement the
   reserved-into-escrow / `creditReservedChange` path. Keep `offchainChange` nullable in
   the frozen shape (§0.1) so no plan-record reshape is needed later; REJECT non-null on
   ingress with `pool_payout_change_not_enabled` (§2.8, smoke check 17). Denominations v2
   emits `offchainChange: null` (remainder becomes an exact on-chain leg).
3. **Uncertain reconciliation = state machine + parking in-wave; read-only audit script
   in-wave; resolve/retry tool is a fast-follow.** The `uncertain` state + safe parking
   is the B1 safety property and is non-negotiable in-wave (§4). Ship the read-only
   `scripts/pool-payout-uncertain-audit.mjs` (§1, §8) — lists opaque refs + amounts + state;
   NO resolve action. The interactive force-settle/force-reverse operator tool is a
   fast-follow.
4. **Solana archival RPC = documented hard recovery dependency (not a ship blocker).**
   `searchTransactionHistory` needs a history-retaining RPC (§5, §11.4 doc note). If
   history is unavailable at recovery, legs PARK as `uncertain` (never guess absence).
5. **Operator-script lock = doc-only this wave.** Loud startup warning banner in the 5
   settler-key scripts + CLAUDE.md (§1, §11.5): they MUST NOT run against the live
   server. A shared filesystem advisory lockfile is the specced fast-follow (§11.5).
6. **Production migration rehearsal = MANDATORY, blocking pre-deploy gate (§12).**

### 11.4 Solana archival-RPC note (implementer text)
See §5. Park-not-guess on history-unavailable is already in `poolPayoutStatus` (§2.4)
and the recovery algorithm (§4).

### 11.5 Operator-script exclusion (doc-only this wave)
The settler EOA is shared by the server and these manual scripts:
`x402-pool-payout-live.mjs`, `x402-settle-live.mjs`, `x402-rh-settle-live.mjs`,
`x402-fund-rotated-payer.mjs`, `deploy-private-batch-commitment.mjs`. A process-local
`TransactionCoordinator` cannot serialise an external process, so each script prints a
loud banner at startup:
```
!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.
```
FAST-FOLLOW (not this wave): a shared advisory lockfile (e.g. `data/.settler-<chainId>.lock`)
that both the server coordinator and each script acquire; refuse to start if held.

### 11.6 Flag-off synchronous path (SEAM answer #1 — integrator-confirmed)

`PX402_POOL_PAYOUT_BATCHING_ENABLED` (default false) is the sync↔async switch.

- **Batching OFF (default):** the route still builds a one-leg group, computes its
  planHash, reserves the leg (`ledger.payout`), and persists the group to the durable
  journal (so the crash window is closed even in the default path). It then drives a
  **0-ms synchronous flush of ONLY that group** — the coordinator broadcasts and holds
  through confirmation (§6) — and returns TODAY's `PoolPayoutReceipt`
  (`kind:"pool-payout"`, `network`, `recipient`, `stealthAddress?`, `ephemeralPubKey?`,
  `mode`, `transactionHash?`, `payerBalanceAtomic`, `settledAt`) BYTE-FOR-BYTE. No
  claim endpoint is involved. This preserves the live demo (`x402-pool-payout-live.mjs`
  reads `receipt.transactionHash` synchronously, :429-431) and the existing smoke
  assertions.
  - The ONLY behavioural divergence from today is the genuinely-ambiguous case: today
    a broadcast failure reversed + threw (unsafe if the tx could still land); the sync
    path returns an `uncertain` error and HOLDS the debit (at-most-once is
    non-negotiable, §4). The live demo + smoke exercise only settle/clean-failure, so
    they are byte-for-byte unaffected. Document this one divergence honestly.
- **Batching ON:** the async group + windowed flush + `pool-payout-claim` endpoint
  (the rest of this spec). The route returns `QueuedGroupReceipt`.
- **Denominations interaction:** the byte-for-byte guarantee is specifically the
  denominations-OFF + batching-OFF corner (today's single-leg path). With denominations
  ON the receipt is the `legs[]` form regardless; batching-OFF then 0-ms-flushes the
  multi-leg group synchronously (all hashes present on return), batching-ON returns the
  queued receipt + claim. A denomination plan's producer therefore does not need to
  know the batching flag — only the route's sync-vs-async return does.

---

## 12. Rollout — BLOCKING pre-deploy gate (fund-safety)

**Why this is a hard gate (MAJOR 4A — now a normative procedure, not an open question):**
the v3→v4 migration runs inside `PrivatePaymentLedger.load()` (PrivatePaymentLedger.ts:183-193),
which executes on EVERY server start that constructs the ledger. Ledger construction is
gated on `agentRpc.enabled && privateLedgerEnabled` (index.ts:50-64), NOT on
`PX402_POOL_PAYOUT_ENABLED` (config.ts:100-107). **So this gate applies whenever the
private ledger is enabled, regardless of the pool-payout flag** — deploying this code
migrates the live production ledger on the next container restart even with pool payout off
(the deployment's compose file persists `/app/data` to host disk). One-way, fails closed on
ambiguity. Only spec touching live production money; blocking, not advisory.

Pre-deploy checklist (ALL must pass before the image ships):
1. **Encrypted backup.** Copy the live `data/private-payment-ledger.json` AND the tmpfs
   epoch artifacts (`PX402_PRIVATE_LEDGER_EPHEMERAL_DIR`) to secure storage. This
   backup IS the rollback path — the migration is one-way (no v4→v3 downgrade tool); the
   prior binary cannot start against a v4 file (PrivatePaymentLedger.ts:183-193,722-729).
2. **Ambiguity pre-audit, per-row.** Classify v3 payout transfers with no FINALIZED-canonical
   `transactionHash` against a COPY. Each is ambiguous (dry-run-success vs unbroadcast-orphan,
   §2.5). There is NO blanket bless (MAJOR 4B). For EACH ambiguous ref the operator records
   a disposition in `data/ledger-migration-reconcile.json` (`settled` with on-chain evidence,
   or `orphan` → reverse) with a note field. Any ref left unresolved keeps production BLOCKED.
   Determine this BEFORE deploy, not by watching the container crash-loop.
3. **Rehearse on a copy.** Run `load()` against the backup copy; verify: file becomes v4,
   per-asset conservation sums to zero, every account balance byte-identical to pre-migration,
   finalized-hash payouts carry `settledAt`, ambiguous rows honored per the disposition file.
4. **Idempotency + crash + finality fixtures.** Load the migrated copy a SECOND time and
   assert byte/state stability; inject a crash around the migration persist and assert the v3
   input is intact (fsync-atomic, no partial write); assert a non-finalized/reorged hash is
   NOT auto-blessed (MAJOR 4C). These mirror smoke check 20.
5. **Rehearse rollback.** Restore the encrypted backup and confirm the PRIOR binary starts
   against it — proving the backup is a working rollback, since v4 is one-way.
6. **Go/no-go.** Only after 1–5 pass on real production contents does the image deploy. No
   `data/private-payment-ledger.json` exists in this checkout, so the fixture (smoke check 20)
   proves the CODE; the rehearsal proves the DATA. Both are required.

Escalate this checklist verbatim into VERIFICATION.md's live-proof section (§8).

---

## 13. Critique responses (verified against code)

Legend: FIXED (design changed) · REBUTTED (with evidence) · DEFERRED (open question).

**B1 (ambiguous chain state → double-pay/refund) — FIXED.** Added the `uncertain`
terminal-for-now leg/group state; `failed`+reverse now requires a `terminal-absent`
proof only. `maxAttempts` is quarantine-only (§4, §6, checks 6-8). Dropped the
recipient-uniqueness backstop and ATA-balance fallback — both were unsound: verified
`EvmChainRail.resolveRecipient` returns the reusable payee wallet on no-stealth
quotes (EvmChainRail.ts:70-84) and `SolanaChainRail` the same (SolanaChainRail.ts:67-81).
EVM classifies via exact hash + outbox nonce-occupant; Solana via
`searchTransactionHistory` finalized; "nonce too low" routes through classification
not success (§6).

**B2 (durability + compensation loss) — FIXED.** (a) Journal + outbox writes fsync
file→rename→fsync dir, citing the shipped helper (x402-pool-payout-live.mjs:69-123);
verified `EncryptedJsonFile.write` is atomic-not-durable (EncryptedJsonFile.ts:41-48).
(b) Reversal data moved onto the DURABLE ledger payout transfer
(`reversalAccountRef`,`amountAtomic`), so compensation no longer depends on the tmpfs
epoch journal (verified the old dependency at PrivatePaymentLedger.ts:472-501 and the
tmpfs requirement at EphemeralPaymentJournal.ts:38-44). Same `ownerTag` binds claim
(B5).

**B3 (mutex ownership contradiction) — FIXED.** Replaced `SettlerSendMutex` with a
single-owner `TransactionCoordinator` per (chainId,address); facilitator/rail
primitives are lock-free and receive the pinned nonce (no reentrancy/deadlock). v1
holds through confirmation + same-nonce fee replacement (§6). Verified the shared-EOA
surface (X402Facilitator.ts:95-106,148-163; PrivateBatchCommitter.ts:19-29;
index.ts:98-111; EvmChainRail.ts:24-31) and ethers auto-nonce behaviour. Operator
scripts documented as must-not-run-concurrently (list in §6).

**B4 (concurrent enqueue reverses valid reservation) — FIXED.** Per-groupRef in-flight
lock taken before the first await; `putGroup` idempotent on exact-match returning the
existing receipt; reverse only legs THIS invocation reserved. Verified the current
end-of-handler quote delete + no lock (PrivateAgentRegistry.ts:270-327) and ledger
`duplicate:true` (PrivatePaymentLedger.ts:376-391). Check 10.

**B5 (claim not owner-bound, lossy one-shot) — FIXED.** Persisted `ownerTag`; claim
requires identity signature whose recomputed `accountReference(payer)` matches, plus a
`"pool-claim"` consumed-nonce scope (verified the scope union at
PrivateAgentRegistry.ts:856-865). Claim is now repeatable authenticated status until
TTL (no `claimedAt` deletion). Documented as a narrow capability-scoped exception to
"receipt history disabled" (verified the GET 404s at createPrivateAgentServer.ts:77-80).

**B6 (breaks live demo + v3 consumers) — FIXED.** Added to the change list:
`x402-pool-payout-live.mjs` (verified sync `payoutFromLedger` + required hash at
:428-431, record rewrite at :439-462), `x402-stealth-sweep.mjs`,
`private-ledger-state-audit.mjs:25`, `private-ledger-burn-runtime-proof.mjs:49,63`,
`private-ledger-smoke.mjs:272,361,411`, `VERIFICATION.md`, `CLAUDE.md`,
`README.md` (§1, §8). Live flow persists resume material, polls the
authenticated claim to terminal, then atomically rewrites the record; preflight +
record-before-broadcast kept.

**B7 (no shared group interface) — FIXED.** Adopted the ratified atomic group API
(§0.1): `enqueueGroup` persists the full immutable plan + per-leg reservations + owner
tag BEFORE quote consumption; per-leg independently-reversible refs `${groupRef}:${i}`;
claim returns `legs[]`; single-leg = one-leg group. offchainChange is deferred (§11.2),
so no change reservation happens this wave. Aligned to denominations `PayoutPlan`/`PayoutLeg`
(spec-denominations.md:88-110) and the array `ephemeralPubKeys` intent (:57).

**B8 (migration blesses orphan, no rollback) — FIXED (hardened by second pass §13.2/B8').**
Migration stamps `settledAt` only on FINALIZED-canonical-hash payouts; hashless payouts
are ambiguous → fail closed with a PER-ROW reconcile manifest (the blanket
`ASSUME_DRYRUN` flag is REMOVED — MAJOR 4B). Verified `ledger.payout` persists before
chain execution (PrivatePaymentLedger.ts:376-448) and the documented crash window
(PrivateAgentRegistry.ts:329-331) — v1 blanket backfill was unsafe, retracted. §12 is now
a normative blocking gate (encrypted backup, per-row audit, rehearse, idempotence/crash/
finality fixtures, rollback rehearsal), applying whenever the private ledger is enabled
regardless of the pool flag.

**M1 (overlapping flush/retry) — FIXED.** Single-flight guard per network;
self-rescheduling (`setTimeout` after prior completes, not `setInterval`); jitter
tasks tracked/cancelled on stop; `queued` vs `broadcasting` distinguish
never-prepared vs prepared-retry (§2.7, §4, check 11).

**M2 (understated latency) — FIXED.** Receipt exposes `estimatedSubmitBeforeMs`
(submit only); docs separate queue-to-submit from queue-to-final; `uncertain` stated
to have no finite bound (§3, §9). Verified quote TTL 600s and that the plain pool
transfer can't expire mid-queue (PrivateAgentRegistry.ts:534-564) — the v1 "≤75s"
was wrong; retracted.

**M3 (overbroad privacy claim) — FIXED.** §9 scopes the benefit to an external
chain-only observer, defines the conditional anonymity set, and states facilitator-host +
VPN-metadata+chain observers retain correlation.

**M4 (missing adversarial tests) — FIXED.** §7 adds RPC false-negative, terminal-absent,
maxAttempts-while-live, shared-recipient classification, concurrent duplicate enqueue,
overlapping flush, uncertain-hold, fsync guard, dropped-nonce fee-bump, and v3→v4
fail-closed fixture. Mock-boolean-only checks are supplemented by the real classify
path in on-chain smoke.

**m1 (terminal timestamps) — FIXED.** Legs/groups carry `terminalAt`; prune keys off
`terminalAt`, never `createdAt`.

**m2 (config validation) — FIXED.** §5 validates all queue numerics at startup
(mirrors PrivatePaymentLedger.ts:171).

**m3 (startup/route gating) — FIXED.** §10.6: `recover()` before both listeners;
`start()` single owner; claim route gates on the queue.

---

## 13.2 Second adversarial pass responses (6 BLOCKER, 6 MAJOR, 2 MINOR — all verified)

Every finding was real; I verified the code claims and folded fixes. None rebutted.

**B1A (fee-replacement winner refunds a paid leg) — FIXED.** classifyNonce is now keyed
on `logicalId` + ALL its outbox versions and returns `landed` (with the winning hash) if
ANY version reached a finalized canonical receipt; `terminal-absent` only when the
canonical finalized nonce occupant's `payloadFingerprint` provably differs (§2.1, §4, §6;
smoke 29). Outbox stores immutable logical identity + replacement lineage; each version is
persisted before broadcast.

**B2/2A (ledger reservation not power-loss durable) — FIXED.** Verified `persist()` →
`file.write` with no fsync (PrivatePaymentLedger.ts:621-622, EncryptedJsonFile.ts:41-48).
Added `durable:true` fsync path (file→rename→dir) used by the ledger + journal + outbox;
recovery now does BIDIRECTIONAL reconciliation (journal→ledger parks `uncertain` on a
missing debit; ledger→journal reverses orphans with `settledAt===undefined`) before any
broadcast (§2.5, §4, §10.5; smoke 30-31).

**B1B/B3 (ambiguous RPC error rebuilds from queued) — FIXED.** Removed the
`broadcasting→queued` rebuild branch. Once an outbox version is persisted, the signed
identity is never discarded; any post-submission ambiguous error stays `broadcasting`/
`uncertain` and reconciles the exact bytes; only a pre-persist `sign` failure returns to
`queued` (§4, §6; smoke 32).

**B1C/B4 (Solana null ≠ absence) — FIXED, then HARDENED by the third pass (see §13.3/B1C).**
Second pass moved to a coverage-proof; the third pass showed even that is not safe
(`minContextSlot` can't certify retention, `getTransaction` accepts no `minContextSlot`), so
the final rule is: Solana `null` → ALWAYS `uncertain`, released only by manual disposition.
Finalized `err!==null` is terminal failure. ATA fallback removed (§2.4, §5, §6; smoke 33, 43).

**B5/3A (coordinator can't recover all shared-EOA sends) — FIXED.** The outbox is now the
single WAL for ALL coordinator sends (pool payout, x402 settle, batch commit), storing
encrypted raw signed bytes + logicalId + payloadFingerprint + replacement lineage +
state + winningHash. `recoverOutbox()` reconciles/rebroadcasts every nonterminal nonce in
order before accepting new sends; never advances past a nonterminal gap. Verified the
shared-EOA send sites (X402Facilitator.ts:95-106,148-163; PrivateBatchCommitter.ts:19-29;
index.ts:98-111) (§2.1, §2.3; smoke 34).

**B6/3B (timed-out live nonce has no quarantine) — FIXED.** On `poolPayoutTimeoutMs` with
a live/ambiguous nonce the coordinator durably quarantines `(chainId,address)`: no
descendant nonce is allocated, new sends queue, background same-nonce reconcile continues
until finality or terminal; `isQuarantined()` is exposed to the audit (§2.1, §6; smoke 35).

**MAJOR 1 (finality, not confirmations=3) — FIXED.** Settlement/reversal/pruning/batching
require canonical-under-finalized-head, not a raw count; interim `included` is surfaced in
the claim but never settles/reverses. Added a reorg re-evaluation path + test (§2.1, §4,
§5, §6; smoke 36). Config `poolPayoutFinality` replaces `poolPayoutConfirmations`.

**MAJOR 2 (fee-bump builder incomplete) — FIXED.** `CoordinatorSubmitInput.sign` takes an
explicit fee policy; lock-free pinned-nonce+fee builders exist for pool transfer,
`transferWithAuthorization`, and `commitBatch`; every replacement (fee-ascending, invariant
payloadFingerprint) is persisted before broadcast (§2.1, §2.3).

**MAJOR 3 (double-HMAC of reversalAccountRef) — FIXED.** Verified `balance()`/`setBalance()`
HMAC the agentId (PrivatePaymentLedger.ts:218-219,625-629,666-668). Added by-reference
accessors that mutate an already-`acct_` ref directly; reverseOrphanPayouts skips
`settledAt` transfers (§2.5; smoke 37).

**MAJOR 4A (gate not actually specified) — FIXED.** §12 is now a normative blocking
pre-deploy gate, and explicitly states it applies whenever the private ledger is enabled
regardless of `PX402_POOL_PAYOUT_ENABLED` (verified index.ts:50-64 / config.ts:100-107).

**MAJOR 4B (ASSUME_DRYRUN blesses orphan) — FIXED.** Blanket flag removed; per-row
disposition manifest required, unresolved rows keep startup blocked (§2.5, §12).

**MAJOR 4C (fixtures don't prove idempotence/finality) — FIXED.** Smoke 20 now covers
second-load byte-stability, crash-around-persist, and non-finalized/reorged-hash
non-blessing; only finalized-canonical hashes auto-bless.

**MINOR 1 (stale open questions) — FIXED.** §11 is integrator decisions, not open
questions; the read-only audit and archival-RPC are decided, not asked.

**MINOR 2 (Solana finalized err handling) — FIXED.** Finalized `err===null` = settled,
`err!==null` = terminal failure (§2.4; smoke 33).

**offchainChange contradiction (flagged) — already RESOLVED in the current revision.** The
registry pseudocode no longer reserves change (§2.8), the group derivation has no
credit/reverse (§4), and tests 17-18 are rejection-only (§7). The critique ran against the
pre-fold snapshot; the live file is consistent.

---

## 13.3 Third adversarial pass responses (B1A + B5 CLOSED; 4 open, all folded)

The pass confirmed B1A (fee-replacement classification) and B5 (outbox WAL) sound. The 4
remaining were real; verified and fixed. None rebutted.

**B2 (recovery order — rebroadcast before reconciliation) — FIXED.** §4 recover() reordered:
load-only (step 1) → bidirectional ledger↔journal reconciliation (step 2) → outbox
cross-check by logicalId (step 3) → `recoverOutbox` rebroadcast (step 4) which SKIPS any
pool-payout entry whose ledger debit is absent. A debit-less leg is parked `uncertain` and
NEVER broadcast; non-pool sends rebroadcast unconditionally. Smoke 38.

**B1B (queued-leg double-pay) — FIXED (the crux).** `logicalId` is now REQUIRED + deterministic
from the leg's immutable fields, stamped at enqueue (§2.6). Two-part fix: (1) recovery
cross-checks EVERY non-terminal leg (queued OR broadcasting) against the outbox by logicalId
and resolves via `classifyNonce`, never re-sending at a fresh nonce (§4 step 3); (2)
`coordinator.submit` dedupes by logicalId — if a non-terminal outbox entry exists it resumes
that entry instead of allocating a new nonce (§2.1). The outbox `putVersion` is the commit
point; the leg `state` is a reconciled hint. Smoke 39.

**B1C (Solana absence) — FIXED (accept the honest limitation).** Removed the `minContextSlot`
"proof" entirely. Solana `null` → ALWAYS `uncertain`; released only by operator escape /
manual disposition. Finalized `err!==null` → terminal failure. Verified current Solana settles
at `confirmed` not finalized (SolanaX402Facilitator.ts:90). Stated honestly: EVM auto-resolves,
Solana parks for a human — fund-safe, never wrong-refunds (§2.4, §5, §6; smoke 33, 43, 44).

**B6 (quarantine startup + escape) — FIXED.** (a) `recoverOutbox` quarantines-and-CONTINUES
within `recoveryBudgetMs` so a stuck nonce degrades one EOA to "queued sends" but never hangs
startup (§2.1, §4, §6; smoke 40). (b) In-wave guarded operator escape
`coordinator.resolveQuarantine` (cancel-at-nonce / manual disposition) + the CLI
`scripts/pool-payout-coordinator-escape.mjs`; `isQuarantined()`/`quarantineDetail()` exposed
to the read-only audit; richer UI stays fast-follow (§2.1, §6, §1; smoke 41).

**Seam — `payerBalanceAtomic` semantics — FIXED.** §0.1 now: PROJECTED post-reservation
balance = current − totalAtomic (the payer's resulting balance; receipt returns it directly).
Matches denominations and the client receipt.

---

## 13.4 Fourth adversarial pass responses (B1C CLOSED; EVM sound; 4 Solana/EVM-edge items folded)

The pass closed B1C and confirmed B2/B1B/B6 sound for EVM. The 4 remaining were Solana's
missing durable machinery + 2 EVM recovery edges. All real; verified and fixed; none rebutted.

**Solana-B1B (no durable signed-tx WAL → re-sign double-pay) — FIXED.** Solana now has a
durable WAL: the queue SPLITS the Solana path into `preparePoolPayout` (sign only) →
`journal.updateLeg` (fsync `signedTx`+`signature`+`lastValidBlockHeight` — the commit point) →
`broadcastPoolPayout` (`sendRawTransaction`). Recovery REBROADCASTS the exact persisted bytes
(idempotent by signature) and NEVER re-signs a new blockhash, closing the double-pay. The only
residual (crash + blockhash-expiry + `getTransaction` null) parks `uncertain`, never
auto-reverses (§2.2, §4 step 3-Solana, §6; smoke 42, 43).

**Solana-B6 (escape undefined) — FIXED.** Clarified the chain-model asymmetry: the coordinator,
quarantine, and `resolveQuarantine` are EVM-ONLY (they serialise a shared-EOA nonce); Solana
has no nonce, so Solana legs park per-leg `uncertain` and are released by a DEFINED
`queue.resolvePoolPayoutLeg` (§2.7) — `landed`+signature (verified finalized-canonical on an
archival node → settle) or `absent`+attestation (reverse, gated on machine-verified blockhash
expiry + operator archival-absence attestation; the pruned-but-landed residual is the
operator's attested decision). Exposed via the escape CLI `--leg` mode (§1; smoke 44).

**EVM-B2 (reverse-direction three-store mismatch) — FIXED.** Recovery step 2 now consults
`OutboxEntry.ref` (and each Solana leg's persisted bytes) BEFORE reversing a ledger orphan: if a
pool-payout tx exists for that ref it is NOT reversed — it was broadcast, so it reconciles in
step 3. Closes the refund-then-rebroadcast window (§4 step 2; smoke 45).

**EVM-B6 (startup bound only covered rebroadcast) — FIXED.** `recoveryBudgetMs` now bounds the
ENTIRE network-dependent recovery (EVM classify + rebroadcast + Solana WAL classify +
rebroadcast), not just `recoverOutbox`. On timeout the affected EVM EOA is quarantined, Solana
legs are left for a post-listener sweep, and listeners bind anyway — a stalled classify RPC
never delays startup (§4, §5, §2.7; smoke 46).

---

## 13.5 Fifth adversarial pass responses (Solana-B1B CLOSED; 3 interface/guard items folded)

The pass closed Solana-B1B (WAL sound; a live @solana/web3.js partialSign-idempotency probe
confirmed rebroadcast safety). The 3 remaining were "mechanism right, interface/guard
incomplete." All real; verified and fixed; none rebutted.

**Solana-B6 (signature binding) — FIXED.** `resolvePoolPayoutLeg({landed})` now enforces
`signature === leg.txId` AND that `leg.txId` re-derives from the persisted `leg.signedTx`
(recompute the signature from the durable bytes) before checking finalized-canonical. An
unrelated finalized signature can no longer settle a leg's debit; it is rejected and the leg
stays `uncertain` (§2.7; smoke 44 incl. the negative case).

**EVM-B2 (outbox-by-ref API missing) — FIXED.** Added `TransactionCoordinator.outboxEntriesByRef(ref)`
and a `ChainRail.outboxEntriesByRef(ref)` (EVM delegates; Solana returns []). Recovery step 2
calls it across rails to suppress reversal of ANY ledger row with a matching pool send, then
reconciles that ledger row by ref via `classifyNonce` with NO journal leg required. Stated
explicitly EVM-only: on Solana the WAL is the journal leg, so a journal-absent row has no WAL
entry and the reverse-mismatch cannot arise (§2.1, §2.2, §4 step 2; smoke 45).

**EVM-B6 (sweep concurrency fence) — FIXED (the subtle one).** Two guards close the stale-promise
race: (a) the post-listener `sweep` and any detached recovery continuation acquire the SAME
per-network single-flight lock `flushNow` uses — no leg mutation runs concurrently with a flush;
(b) each leg carries a monotonic `gen`, and every recovery/sweep `updateLeg` passes `expectGen`
(compare-and-set) so a promise that resolves after its budget NO-OPs if the leg advanced under a
flush. The specific "stale write reverts a flushed leg to `queued` → double-pay" path cannot
occur (§2.6, §2.7, §4 fence paragraph; smoke 47).

---

## 13.6 Sixth adversarial pass responses (Solana-B6 CLOSED; 2 interface-completion items folded)

The pass closed Solana-B6 (signature binding + crypto reasoning validated). The 2 remaining were
"mechanism right, exact method signatures not wired." Both were real; verified and fixed.

**EVM-B2 (wire the lookup + classify) — FIXED.** Two missing primitives added. (a)
`TransactionOutbox.entriesByRef(ref)` returns ALL entries (every state, incl. finalized/terminal)
for a ref — a nonterminal filter would MISS a finalized entry left by a crash BEFORE ledger
settlement and wrongly reverse the row; `coordinator.outboxEntriesByRef` delegates to it. (b) A
callable classify path `ChainRail.classifyByLogicalId({logicalId, nonce})` (EVM → coordinator
`classifyNonce`; Solana throws, never called) — `poolPayoutStatus` needs a prepared payout with no
logicalId, so step 2 could not otherwise classify a journal-less ledger row. Recovery step 2 now
enumerates via `rail.outboxEntriesByRef` (ALL states) and settles/reverses by ref via
`rail.classifyByLogicalId`, no journal leg required; the durable+idempotent-by-ref
markPayoutSettled/reversePayout apply the result (§2.1, §2.2, §4 step 2; smoke 45). Consistency
sweep (final proofread) completed the same "queue holds rails, not coordinators" rail-adapter
everywhere it was referenced: recovery step 3 (EVM) reaches the WAL via
`rail.outboxEntriesByRef`/`rail.classifyByLogicalId` (not `coordinator.*`); step 4 uses a new
`ChainRail.recoverOutbox()` pass-through (EVM→coordinator, Solana no-op) instead of naming
`coordinator.recoverOutbox()`; step 1's dangling `coordinator.loadOutbox()` is removed (each
coordinator loads its outbox at construction in index.ts, before `queue.recover()`); and
`ChainRail.poolPayoutStatus`'s comment is corrected to be the SOLANA status path (EVM classifies
via `classifyByLogicalId`, keyed on logicalId for the B1A all-versions check — `prepared` carries
no logicalId).

**EVM-B6 (fence resolvePoolPayoutLeg) — FIXED.** The operator disposition was the one leg-mutating
path outside the gen-CAS fence. It now: (a) captures `leg.gen` BEFORE the archival verification
RPC; (b) acquires the per-network single-flight lock and passes `expectGen` to `updateLeg` before
EITHER terminal action (settle OR reverse), returning `{state:"superseded"}` and applying nothing
if the leg advanced under a concurrent flush; (c) the address-level EVM `resolveQuarantine` runs
under the coordinator lease so it cannot race a settler send (§2.7; smoke 48).
