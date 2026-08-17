# FROZEN SPEC v2 — One-time deposit addresses (delayed pool attribution)

Status: **frozen implementation spec, revision 2** (supersedes v1 after Codex REJECT).
Hand verbatim to the Codex implementation agent. No repo code was edited to produce
this. Every symbol/line cited was checked against the live tree. §11 answers every
critique finding (all accepted; none rebutted on substance).

**Naming change from v1 (BLOCKER #1):** the feature is **"one-time deposit
addresses / delayed pool attribution"**, NOT "kill the funding trail". It removes
the always-on treasury watchlist and gives forward ambiguity until consolidation;
a motivated analyst can still 2-hop-join `depositor → stealthAddress → treasury`
after the consolidation transaction. Real unlinkability only holds when the
depositor funds the one-time address from a burner/unlinkable source (then the
join terminates at the burner). It does NOT introduce a shielded pool — that is
the separate blind-voucher workstream.

---

## 0. Problem, mechanism, and RESOLVED design decisions

### The leak (unchanged from v1, verified)
A private-ledger deposit is a public token transfer straight to the well-known
treasury: `deposit-intent` returns `recipient = deposit.recipient` (treasury,
wired `src/server/index.ts:77-96`), the agent pays it, `deposit-confirm`
(`PrivateAgentRegistry.confirmPrivateLedgerDeposit`, `:473-513`) verifies against
the treasury and credits the ledger. Depositor **X** is permanently, publicly
linked to the pool.

### The mechanism
Per deposit, the server derives a **fresh one-time address** from the treasury
stealth meta (keys derived from the network's settler key), returns THAT as
`recipient`, verifies the on-chain transfer landed there, then a delayed/batched
**consolidation sweeper** moves each address's balance to the treasury. An
observer watching the known treasury sees nothing at deposit time.

### Decision 1 — treasury stealth keys: DETERMINISTIC INDEXED derivation from the settler key
Adopt **deterministic, indexed** derivation (resolves BLOCKER #7, #8; MAJOR #13):

- Per network, treasury stealth spend/view keys derive from that network's settler
  key, **domain-separated by CAIP-2 network id + token address + scheme version +
  keyVersion** (fixes MAJOR #13 — one settler key reused on Base and Robinhood now
  yields DIFFERENT roots).
- Each deposit gets a **monotonic `derivationIndex` i** (persisted per network).
  The ephemeral scalar `r_i` is itself **deterministically derived** from
  `(settlerKey, caip2, token, keyVersion, i)`, so the one-time address AND its
  spend key are **regenerable from `(settler key, keyVersion, i)` alone** — the
  persisted `ephemeralPubKey` is a convenience/validation cache, not the sole
  recovery material. A lost record is recoverable by re-deriving indices `0..maxIssued`.
- `keyVersion` is a stable fingerprint of the settler (`keccak256(settlerAddress)`
  first 8 hex for EVM; `keccak256(settlerPubkeyBytes)` first 8 hex for Solana).
  Rotating the settler bumps `keyVersion`; a **recovery keyring** maps historical
  `keyVersion → settler key` so old addresses stay sweepable indefinitely (#8).

Justification: the settler already custodies the pool and broadcasts payouts, so
deriving stealth spend authority from it adds no new trust root **when
`settler == treasury`** — which §Decision 6 now REQUIRES for issuance (fixes
MAJOR #14, which showed the "no new trust root" claim is false when settler ≠ treasury).

### Decision 2 — durable saga record holds the COMPLETE verification intent
The v1 record could not credit a depositor after a restart because intents live
only in `PrivateAgentRegistry.privateLedgerDeposits` (in-memory `Map`,
`:218`, `:479-480`) and the record lacked `fromAddress` (verifiers require it —
`BasePaymentVerifier.ts:58`, `SolanaPaymentVerifier.ts:29-33`). **Fix (BLOCKER #3):**
the durable record stores the full verification intent — `fromAddress`,
`expectedAmountAtomic`, `network`/`caip2`, `tokenAddress`, `keyVersion`,
`derivationIndex`, `stealthAddress`, `accountId` (identity binding),
`creditValidBefore`. `confirmPrivateLedgerDeposit` resolves the **durable record
first** and runs entirely from it; the in-memory map is only a legacy fast-path
for the flag-off treasury flow.

### Decision 3 — durable WAL state machine + startup reconciliation (BLOCKER #2, #4, #5, #6)
```
awaiting-payment → proof-verified → credited → sweep-submitted → swept
                                                     │
        (any anomaly at/after credit) ──────────────┴──────────→ reserve-mismatch  (a.k.a. quarantined, manual)
awaiting-payment ── unpaid a long time ──────────────────────→ dormant  (retained, slow re-check; NEVER erased)
```
- Every transition is persisted through the book's serialized write queue BEFORE
  the side effect it authorizes (write-ahead).
- `proof-verified` is persisted **before** `creditDeposit`; `sweep-submitted`
  (with tx hash + EVM nonce) is persisted **before** broadcast. `swept` is set
  **only after an awaited successful receipt at the required finality** (fixes
  BLOCKER #5 — `verifyAndSettle` does NOT await a receipt; `X402Facilitator.ts:152-163`
  returns `tx.hash` immediately, so the sweep uses a dedicated broadcast-then-wait
  path, not `verifyAndSettle`).
- **Startup reconciliation** (`DepositConsolidationService.reconcileOnStartup`)
  scans every intermediate state: re-runs idempotent `creditDeposit` for
  `proof-verified`, re-checks `sweep-submitted` tx hashes on-chain before any
  rebroadcast, resumes `credited` sweeps.
- **Zero balance is never silently "swept"** (fixes BLOCKER #6): a `credited` or
  `sweep-submitted` record found empty **without a confirmed successful sweep
  receipt** → `reserve-mismatch`, which **gates affected payouts** and enqueues an
  encrypted reconciliation entry. Only an awaited successful sweep receipt sets `swept`.

### Decision 4 — ledger credit is idempotent and proof-keyed; two-file atomicity via WAL replay (BLOCKER #4, #9)
`creditDeposit` gains an optional `transferIndex`; when present the replay key
becomes `depositProof:<network>:<txHash>:<transferIndex>` (plus a legacy-key
backstop so pre-migration deposits stay non-replayable). This lets one transaction
credit **multiple** distinct one-time addresses (fixes BLOCKER #9 — verifiers today
`.some(...)` match any transfer and the ledger dedups on tx hash only, so a second
one-time transfer in the same tx returns `duplicate` and credits nobody).
`confirmPrivateLedgerDeposit` now inspects `result.duplicate`: a duplicate whose
`proofId` matches THIS record ⇒ safe WAL replay (advance to `credited`); a
duplicate whose proof was claimed by a DIFFERENT record ⇒ **reject** (never falsely
report `credited`). Crash between `creditDeposit` and `markCredited` is healed by
startup reconciliation re-running the idempotent credit.

### Decision 5 — the wire and normal client stay unchanged
`deposit-intent`/`deposit-confirm` request/response shapes and the signed intent
messages (`x402AgentIntent.ts:99-127`, verified to omit the recipient) are
unchanged; `recipient` merely becomes a one-time address. `privateX402Client.ts`
needs only a doc comment. (One additive, backward-compatible durable field:
persisted intent-nonce tombstones — §Decision 7.)

### Decision 6 — issuance requires `settler == treasury`; recovery is flag-independent (BLOCKER #8, MAJOR #14)
A network **issues** one-time deposit addresses only when
`PX402_STEALTH_DEPOSITS_ENABLED=true` AND that network's settler key is
present AND `settler == treasury` (same check the rails already use for on-chain
pool payout — `EvmChainRail.ts:24-33`, `SolanaChainRail.ts:24-31`). Otherwise it
transparently falls back to the treasury recipient and logs
`STEALTH_DEPOSITS_FALLBACK network=<n> reason=<no_settler|settler_ne_treasury>`.
**Recovery/consolidation is constructed whenever the book file exists**, regardless
of the issuance flag, so turning the flag off never strands previously issued funds.

### Decision 7 — durable intent-nonce tombstones (MAJOR #17)
`deposit-intent` consumed nonces are memory-only today
(`PrivateAgentRegistry.ts:219`) and the signed message has no timestamp, so a
captured request replays after every restart to mint durable records. Persist a
bounded tombstone set (`{ key, expiresAt }`, key = `private-deposit:<agentId>:<nonce>`,
retention = intent lifetime + margin) in a small encrypted sibling file; reject on hit.

### Decision 8 — settler send serialization (integration note, from batching workstream)
The batching workstream introduces a process-wide **`SettlerSendMutex`**
serialising ALL broadcasts from the settler EOA. Every EVM sweep broadcast and
every Solana sweep send in this spec MUST acquire that mutex before sending. Treat
it as an injected dependency (`send: <T>(fn: () => Promise<T>) => Promise<T>`); if
it is not yet available at implementation time, inject a local single-flight
async lock with the identical interface so it can be swapped later. See §10 Q6.

---

## 1. File-by-file change list

### New files
| Path | Purpose |
|---|---|
| `src/shared/depositStealth.ts` **NEW** | Deterministic, domain-separated treasury stealth key + indexed one-time address derivation (EVM secp256k1 + Solana ed25519). Pure, no I/O. Fully byte-specified (§2.1). |
| `src/server/payments/DepositAddressBook.ts` **NEW** | Durable AES-256-GCM saga store: records, CAS state transitions, per-network index counter, intent-nonce tombstones, `close()`. |
| `src/server/payments/DepositConsolidationService.ts` **NEW** | Single-flight sweeper: startup reconciliation, credited→swept with finality, quarantine, bounded/backoff scans, reserve check. |
| `src/server/payments/DepositReconciliationQueue.ts` **NEW** | Durable AES-256-GCM, access-controlled queue for quarantine/overpayment detail (keeps address/amount OUT of plain logs — MAJOR #18). |
| `scripts/stealth-deposit-smoke.mjs` **NEW** | Offline smoke, wired as `test:stealth:deposits` (§6). |

### Changed files
| Path | Change |
|---|---|
| `src/server/rails/ChainRail.ts` | Add `depositCapable`, `deriveDepositAddress(index)`, `sweepDeposit(...)`, `observedBalanceAtomic(...)` + result types. |
| `src/server/rails/EvmChainRail.ts` | Implement; delegate secret crypto + broadcast-and-wait to `X402Facilitator`; enforce `settler == treasury` for `depositCapable`. |
| `src/server/rails/SolanaChainRail.ts` | Implement; delegate to `SolanaX402Facilitator`; same capability gate. |
| `src/server/base/X402Facilitator.ts` | Add `depositStealthMeta(index)`, `tokenBalanceOf`, `sweepDepositToPool` (own broadcast + `tx.wait(confirmations)` + status check), `sweepTxStatus`. |
| `src/server/base/SolanaX402Facilitator.ts` | Add `depositStealthMeta(index)`, `stealthAtaBalance`, `sweepDepositToPool` (send + `confirmTransaction(finalized)` + `.value.err` check — fixes the ignored-err gap), `sweepTxStatus`. |
| `src/server/base/BasePaymentVerifier.ts` | `verifyErc20Transfer` returns `{ transactionHash, amountAtomic, transferIndex }`; add optional min-confirmations depth check. |
| `src/server/base/SolanaPaymentVerifier.ts` | `verifyErc20Transfer` returns `{ transactionHash, amountAtomic, transferIndex }` (flattened-instruction index). |
| `src/server/payments/PrivatePaymentLedger.ts` | `creditDeposit` accepts optional `transferIndex`; proof-keyed replay + legacy backstop; expose `ledgerLiability(assetKey)` + `accountKeyForBook()` (or a shared KDF) for reserve checks. |
| `src/server/agents/PrivateAgentRegistry.ts` | Thread book/flag/rails into deposit intent (now async) + confirm (durable-record-first, proof-keyed, duplicate-aware); reserve-gate `payoutFromLedger`. |
| `src/server/agents/createPrivateAgentServer.ts` | `await` the intent creation (line 145); no server→registry construction invented (registry is built in `index.ts`). |
| `src/server/config.ts` | New validated env block (§4) with fail-closed `validateDepositConfig`. |
| `src/server/index.ts` | Construct book + reconciliation queue + consolidation service (independent of issuance flag); wire registry options; startup reconciliation; single-flight timer; shutdown await. |
| `package.json` | `"test:stealth:deposits": "tsx scripts/stealth-deposit-smoke.mjs"`. |
| `CLAUDE.md`, `VERIFICATION.md`, **`README.md`** | Docs (§7). The README's deposit description currently says deposits go to the treasury and credit exactly once — MUST be updated in the same diff (MAJOR #20). |

---

## 2. Exact TypeScript signatures

### 2.1 `src/shared/depositStealth.ts` (NEW) — byte-exact KDF
```ts
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { keccak256, toUtf8Bytes, getBytes, concat, toBeHex, zeroPadValue, hexlify } from "ethers";
import type { StealthKeys, StealthMetaAddress, StealthDerivation } from "./stealth";
import type { SolanaStealthKeys, SolanaStealthMetaAddress, SolanaStealthDerivation } from "./stealthSolana";

export const DEPOSIT_STEALTH_SCHEME = "px402-deposit-stealth/v1";
export const DEPOSIT_EPHEMERAL_SCHEME = "px402-deposit-eph/v1";

/** 8-byte big-endian encoding of a non-negative integer. */
export const u64be: (n: number) => Uint8Array; // getBytes(zeroPadValue(toBeHex(BigInt(n)), 8))

export interface TreasuryKeyContext { caip2: string; tokenAddress: string; keyVersion: string; }

/** EVM: keccak256(concat(utf8(scheme), utf8(caip2), utf8(tokenLower), utf8(keyVersion), utf8(role), settlerPriv32)) mod n; 0→1. */
export const deriveEvmTreasuryStealthKeys: (settlerPrivateKey: string, ctx: TreasuryKeyContext) => StealthKeys;

/** EVM: r_i = keccak256(concat(utf8(EPH scheme), utf8(caip2), utf8(tokenLower), utf8(keyVersion), u64be(index), settlerPriv32)) mod n; 0→1.
 *  Returns deriveStealthAddress(meta, hexlify(r_i)). Deterministic + regenerable. */
export const deriveEvmDepositAddress: (
  settlerPrivateKey: string, ctx: TreasuryKeyContext, index: number
) => StealthDerivation;

/** EVM: recompute the one-time private key for a given index (for the sweep). */
export const deriveEvmDepositPrivateKey: (
  settlerPrivateKey: string, ctx: TreasuryKeyContext, index: number
) => string; // 0x-hex 32B; addressForPrivateKey(result) === deriveEvmDepositAddress(...).stealthAddress

/** Solana analogues: sha512(concat(...)) reduced mod L (bytesToNumberBE % L), emitted 0x-hex 32B. */
export const deriveSolanaTreasuryStealthKeys: (settlerSecretKeyBase58: string, ctx: TreasuryKeyContext) => SolanaStealthKeys;
export const deriveSolanaDepositAddress: (settlerSecretKeyBase58: string, ctx: TreasuryKeyContext, index: number) => SolanaStealthDerivation;
export const deriveSolanaDepositScalar: (settlerSecretKeyBase58: string, ctx: TreasuryKeyContext, index: number) => string; // raw scalar for sweepStealth

/** keyVersion fingerprint (stable per settler). */
export const evmKeyVersion: (settlerAddress: string) => string;        // keccak256(getBytes(address)).slice(2,10)
export const solanaKeyVersion: (settlerPubkeyBase58: string) => string; // keccak256(pubkeyBytes).slice(2,10)
```
Notes: EVM base-point math via `secp256k1.getPublicKey(scalar, true)`; `meta` built
exactly as `stealth.ts.generateStealthKeys`. Solana meta via
`publicKeyForSolanaScalar(scalar).toBase58()` (exported, `stealthSolana.ts:111`).
No new deps (`@noble/curves`, `@noble/hashes`, `ethers` already present).

### 2.2 `src/server/rails/ChainRail.ts` (CHANGED)
```ts
export interface ChainRailDepositAddress { stealthAddress: string; ephemeralPubKey: string; derivationIndex: number; keyVersion: string; }

export interface ChainRailSweepResult {
  outcome: "confirmed" | "empty" | "submitted-unconfirmed" | "not-capable";
  transactionHash?: string;      // present for confirmed / submitted-unconfirmed
  sweepNonce?: string;           // EVM EIP-3009 authorization nonce (dedup across retries)
  observedAmountAtomic: string;  // balance seen (string; 0 when empty)
}

export interface ChainRailSweepTxStatus { state: "confirmed-success" | "confirmed-failed" | "pending" | "unknown"; }

export interface ChainRail {
  // ...existing members unchanged...
  readonly depositCapable: boolean; // settler present AND settler === treasury

  deriveDepositAddress(index: number): ChainRailDepositAddress;

  observedBalanceAtomic(input: { stealthAddress: string }): Promise<bigint>;

  /** Broadcast a sweep to the pool and AWAIT finality. Validates keyVersion, caip2,
   *  tokenAddress, expectedStealthAddress, poolAddress before signing (#8). Persist
   *  sweep-submitted BEFORE calling this. Goes through the SettlerSendMutex. */
  sweepDeposit(input: {
    derivationIndex: number; keyVersion: string; caip2: string; tokenAddress: string;
    expectedStealthAddress: string; poolAddress: string; nowSeconds: number; confirmations: number;
    reuseSweepNonce?: string;      // on retry, reuse to avoid double-move where possible
  }): Promise<ChainRailSweepResult>;

  /** Re-check a previously submitted sweep tx (startup reconciliation, #5). */
  sweepTxStatus(input: { transactionHash: string }): Promise<ChainRailSweepTxStatus>;
}
```

### 2.3 `src/server/base/X402Facilitator.ts` (CHANGED — additions)
```ts
depositStealthMeta(ctx: TreasuryKeyContext): StealthMetaAddress | undefined;   // undefined w/o settler key; memoized per ctx
tokenBalanceOf(address: string): Promise<bigint>;                              // eth_call balanceOf

/** Recompute the index'd stealth key, validate address, build EIP-3009 pay-to-pool for the FULL balance,
 *  simulateSettle pre-flight, broadcast via SettlerSendMutex, then `await tx.wait(confirmations)` and check
 *  receipt.status===1. NEVER uses verifyAndSettle (which does not await a receipt). */
sweepDepositToPool(input: {
  ctx: TreasuryKeyContext; derivationIndex: number; expectedStealthAddress: string;
  poolAddress: string; amountAtomic: string; nowSeconds: number; confirmations: number; reuseSweepNonce?: string;
}): Promise<{ outcome: "confirmed" | "empty" | "submitted-unconfirmed"; transactionHash?: string; sweepNonce?: string; observedAmountAtomic: string }>;

sweepTxStatus(transactionHash: string): Promise<{ state: "confirmed-success" | "confirmed-failed" | "pending" | "unknown" }>;
```
`amountAtomic` here is already a **string** (fixes BLOCKER #10 — do not pass a `bigint`
into `maxAmountRequired`). The synthetic requirements use
`maxAmountRequired: amountAtomic` (string). Settler key is required; when absent the
rail reports `depositCapable=false` and this is never called.

### 2.4 `src/server/base/SolanaX402Facilitator.ts` (CHANGED — additions)
```ts
depositStealthMeta(ctx: TreasuryKeyContext): SolanaStealthMetaAddress | undefined;
stealthAtaBalance(stealthOwnerBase58: string): Promise<{ exists: boolean; amountAtomic: bigint }>; // distinguishes missing ATA / zero / RPC error (#16)

sweepDepositToPool(input: {
  ctx: TreasuryKeyContext; derivationIndex: number; expectedStealthAddress: string;
  poolOwner: string; nowSeconds: number; reuseSweepNonce?: string;
}): Promise<{ outcome: "confirmed" | "empty" | "submitted-unconfirmed"; transactionHash?: string; observedAmountAtomic: string }>;

sweepTxStatus(signature: string): Promise<{ state: "confirmed-success" | "confirmed-failed" | "pending" | "unknown" }>;
```
Pre-checks `stealthAtaBalance`; on `exists:false` or `amountAtomic===0n` → `empty`
(never call `sweepStealth`, which THROWS on non-positive — `stealthSolana.ts:137`).
On RPC failure → throw (caller backs off, no transition). On confirm, checks
`confirmTransaction(...).value.err === null` at `finalized` (fixes the ignored-err
gap the critic flagged at `SolanaX402Facilitator.ts:133-136`). Send goes through
the SettlerSendMutex.

### 2.5 `src/server/payments/DepositAddressBook.ts` (NEW)
```ts
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile"; // VALUE import (fixes BLOCKER #10) — instantiated

export type DepositAddressStatus =
  | "awaiting-payment" | "proof-verified" | "credited"
  | "sweep-submitted" | "swept" | "reserve-mismatch" | "dormant";

export interface DepositAddressRecord {
  id: string;                 // "depaddr-" + 24 hex — the ONLY id used in plain logs
  intentId: string;
  accountId: string;          // 64-hex HMAC-SHA256(accountKey, agentId)  (fixes MINOR #22)
  network: string; caip2: string; tokenAddress: string;
  keyVersion: string; derivationIndex: number;
  stealthAddress: string;     // EVM checksummed EOA | Solana owner base58
  ephemeralPubKey: string;    // cache; regenerable from (settler,keyVersion,index)
  fromAddress: string;        // depositor (verifier input)  (fixes BLOCKER #3)
  expectedAmountAtomic: string;
  observedAmountAtomic: string | null;
  overpaymentAtomic: string | null;
  creditValidBefore: number;  // unix seconds
  proofId: string | null;     // "<network>:<txHash>:<transferIndex>"  (fixes BLOCKER #9)
  proofTxHash: string | null; // case-preserved for solana
  proofTransferIndex: number | null;
  status: DepositAddressStatus;
  attemptCount: number;
  sweepNonce: string | null;  // EVM EIP-3009 auth nonce, reused across retries
  sweepTxHash: string | null;
  nextRetryAt: number | null; // ms
  quarantineReason: string | null;
  createdAt: number; proofVerifiedAt: number | null; creditedAt: number | null;
  sweepSubmittedAt: number | null; sweptAt: number | null;
}

export interface DepositNonceTombstone { key: string; expiresAt: number; }

export interface DepositAddressBookFile {
  version: 1;
  records: DepositAddressRecord[];
  nextIndexByNetwork: Record<string, number>;
  nonceTombstones: DepositNonceTombstone[];
}

export interface DepositAddressBookOptions { retentionMs: number; encryptionKey: string; }

export class DepositAddressBook {
  constructor(filePath: string, options: DepositAddressBookOptions);
  load(): Promise<this>;
  accountId(agentId: string): string;                       // same tag as the ledger KDF (§10 Q2)
  nextIndex(network: string): Promise<number>;              // atomic increment + persist
  add(record: Omit<DepositAddressRecord,"id"|"status"|"createdAt"|"attemptCount"
        |"observedAmountAtomic"|"overpaymentAtomic"|"proofId"|"proofTxHash"|"proofTransferIndex"
        |"sweepNonce"|"sweepTxHash"|"nextRetryAt"|"quarantineReason"
        |"proofVerifiedAt"|"creditedAt"|"sweepSubmittedAt"|"sweptAt">): Promise<DepositAddressRecord>;
  byIntentId(intentId: string): DepositAddressRecord | undefined;
  byId(id: string): DepositAddressRecord | undefined;
  /** CAS: apply mutator only if current status === expectedFrom; else throw. Serialized write. (#11) */
  transition(id: string, expectedFrom: DepositAddressStatus, mutate: (r: DepositAddressRecord) => void): Promise<DepositAddressRecord>;
  consolidatable(minAgeMs: number, limit: number, now?: number): DepositAddressRecord[]; // credited, oldest-first, capped, shuffled
  resumableSubmitted(limit: number): DepositAddressRecord[];   // sweep-submitted needing re-check
  reverifiable(limit: number): DepositAddressRecord[];         // proof-verified needing credit replay
  unpaidStale(unpaidGraceMs: number, limit: number, now?: number): DepositAddressRecord[]; // awaiting-payment past grace (capped, #16)
  reapSwept(now?: number): Promise<number>;                    // delete swept past retentionMs (derivation still regenerable by index)
  toDormant(id: string): Promise<void>;                        // never deletes; keeps regenerable material
  consumeNonce(key: string, expiresAt: number): void;          // throws on replay (#17); persisted, evicts expired
  reserveRecordsForAsset(assetKey: string): DepositAddressRecord[]; // credited|sweep-submitted (unswept reserves, #12)
  all(): readonly DepositAddressRecord[];
  close(): Promise<void>;                                      // drain writeQueue, wipe key buffers (fixes MINOR #24)
}
```
Persistence mirrors `PrivatePaymentLedger`: `EncryptedJsonFile(filePath,
encryptionKey, { failClosed: true })`, a `writeQueue` promise chain, `structuredClone`
rollback on persist failure. `transition` is the compare-and-set primitive.

### 2.6 `src/server/payments/DepositConsolidationService.ts` (NEW)
```ts
export interface DepositConsolidationOptions {
  minAgeMs: number; maxPerRun: number; unpaidGraceMs: number; confirmations: number;
  backoffMs: number; maxAttempts: number;
}
export interface DepositConsolidationResult { swept: number; quarantined: number; reaped: number; retried: number; failures: number; }

export class DepositConsolidationService {
  constructor(book: DepositAddressBook, queue: DepositReconciliationQueue,
              rails: ReadonlyMap<string, ChainRail>, options: DepositConsolidationOptions);
  reconcileOnStartup(now?: number): Promise<DepositConsolidationResult>;
  runOnce(now?: number): Promise<DepositConsolidationResult>; // single-flight (guarded, #11); never throws
  /** Reserve gate for payouts (#12): confirmed reserve (treasury balance + Σ unswept record balances)
   *  ≥ ledger liability for the asset. Called by payoutFromLedger before spend. */
  reserveOk(assetKey: string): Promise<boolean>;
  backlog(): { oldestCreditedAgeMs: number | null; counts: Record<DepositAddressStatus, number> }; // metric (#19)
}
```
`runOnce` order (each step capped by `maxPerRun`, wrapped in try/catch per record,
CAS transitions, exponential `backoffMs` on failure up to `maxAttempts` then quarantine):
1. `reapSwept()`.
2. `resumableSubmitted()`: `rail.sweepTxStatus(tx)` → `confirmed-success` ⇒ `swept`;
   `confirmed-failed`/`unknown` past retry ⇒ rebuild via `sweepDeposit(reuseSweepNonce)`;
   `pending` ⇒ skip.
3. `consolidatable(minAgeMs)`: CAS `credited`→`sweep-submitted` (persist tx hash+nonce
   returned by a two-phase call — see note) → await `sweepDeposit`; `confirmed` ⇒ `swept`;
   `empty` **without** our prior successful receipt ⇒ `reserve-mismatch` + queue (#6);
   `submitted-unconfirmed` ⇒ stay `sweep-submitted` (re-checked next run); error ⇒ backoff/attempt++.
4. `unpaidStale(unpaidGraceMs)`: `rail.observedBalanceAtomic`/`stealthAtaBalance`;
   confirmed **zero + ATA-absent/empty** ⇒ `toDormant` (retained, regenerable, NOT deleted, #7);
   confirmed **nonzero** on an uncredited address ⇒ sweep to pool + `reserve-mismatch` + queue
   (funds preserved, never stranded, never silently pooled, #6/#7/#15); RPC error ⇒ skip+backoff (#16).

Note on step 3 atomicity: `sweepDeposit` must return its `sweepNonce`/`transactionHash`
so the record can be marked `sweep-submitted` with them **before** the network settles.
Implement as: rail derives the nonce, the service persists `sweep-submitted{nonce,txHash-pending}`,
THEN the rail broadcasts. If the process dies between persist and broadcast, startup
reconciliation finds `sweep-submitted` with a not-yet-mined nonce and re-drives it.

### 2.7 `src/server/payments/DepositReconciliationQueue.ts` (NEW)
```ts
export interface ReconciliationEntry {
  recordId: string; reason: "zero-without-receipt" | "overpayment" | "late-uncredited" | "key-mismatch";
  network: string; stealthAddress: string; observedAmountAtomic: string; expectedAmountAtomic: string; at: number;
}
export class DepositReconciliationQueue {
  constructor(filePath: string, encryptionKey: string); // EncryptedJsonFile, failClosed, 0600
  load(): Promise<this>;
  enqueue(entry: ReconciliationEntry): Promise<void>;
  list(): readonly ReconciliationEntry[];
  close(): Promise<void>;
}
```
Address/amount linkage lives ONLY here (encrypted). Plain logs carry `record=<id>
reason=<code>` only (fixes MAJOR #18).

### 2.8 `PrivatePaymentLedger` (CHANGED)
```ts
export interface LedgerDepositInput {
  agentId: string; amountAtomic: string; network: string; assetKey: string;
  transactionHash: string; transferIndex?: number; acceptedAt?: number; // transferIndex NEW (#9)
}
// authorizationHash: transferIndex present -> hash(`depositProof:${network}:${txHash}:${transferIndex}`)
//                    absent               -> existing legacy formula (unchanged; flag-off compat)
// When indexed: ALSO reject if the legacy key for (network,txHash) is already in
// consumedDepositHashes (prevents replay of a pre-migration credit). Return `duplicate` as today.
ledgerLiability(assetKey: string): bigint;         // Σ positive agent balances (= -escrow); for reserve check (#12)
```
`creditDeposit` continues to persist atomically and return `LedgerTransferResult`
(with `duplicate`). No migration of existing ledger files (indexed keys are new).

### 2.9 `PrivateAgentRegistry` (CHANGED)
```ts
export interface PrivateAgentRegistryOptions {
  requireIdentitySignatures?: boolean;
  privateLedger?: PrivatePaymentLedger;
  rails?: ReadonlyMap<string, ChainRail>;
  depositAddressBook?: DepositAddressBook;                     // NEW
  reconciliationQueue?: DepositReconciliationQueue;            // NEW
  stealthDepositsEnabled?: boolean;                            // NEW
  consolidation?: Pick<DepositConsolidationService, "reserveOk">; // NEW (payout reserve gate, #12)
}

// now async (persists a durable saga record + returns a one-time recipient)
createPrivateLedgerDepositIntent(
  input: PrivateLedgerDepositIntentInput, remoteIp: string,
  deposit: { recipient: string; asset: string }, nowSeconds: number,
): Promise<{ depositId: string; network: string; asset: string; recipient: string; amountAtomic: string; validBefore: number }>;
```
`confirmPrivateLedgerDeposit` keeps its wire signature; internally: durable-record-first
resolution, identity-binding check (`record.accountId === book.accountId(agentId)`),
verifier returns `transferIndex` + `observedAmount`, proof-keyed idempotent credit,
`result.duplicate` handling (§Decision 4), overpayment recording (MAJOR #15), WAL
transitions. `payoutFromLedger` calls `consolidation.reserveOk(assetKey)` and refuses
(503 / dry-run) on mismatch (#12).

---

## 3. JSON schemas + RPC bodies + state machine

### 3.1 `data/private-deposit-addresses.json` (encrypted at rest)
Decrypted shape = `DepositAddressBookFile` (§2.5). Example record (note **64-hex**
`accountId` — fixes MINOR #22; `null` for absent optionals — fixes MINOR #23):
```json
{
  "version": 1,
  "records": [{
    "id": "depaddr-9f2c1a4b7e0c1d2e3f405162",
    "intentId": "deposit-intent-4b7e2c1a9f0c1d2e3f405162",
    "accountId": "acct_5d41402abc4b2a76b9719d911017c592a1b2c3d4e5f60718293a4b5c6d7e8f90",
    "network": "base", "caip2": "eip155:8453",
    "tokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "keyVersion": "9a3f1c02", "derivationIndex": 41,
    "stealthAddress": "0x1c2b3aF4e5D6079810b2C3d4E5f60718293A4B5c",
    "ephemeralPubKey": "0x02abc0000000000000000000000000000000000000000000000000000000000001",
    "fromAddress": "0xdeadbeef00000000000000000000000000000001",
    "expectedAmountAtomic": "250000", "observedAmountAtomic": "250000", "overpaymentAtomic": null,
    "creditValidBefore": 1721721600,
    "proofId": "base:0xabc...:3", "proofTxHash": "0xabc...", "proofTransferIndex": 3,
    "status": "credited", "attemptCount": 0,
    "sweepNonce": null, "sweepTxHash": null, "nextRetryAt": null, "quarantineReason": null,
    "createdAt": 1721720700000, "proofVerifiedAt": 1721720795000, "creditedAt": 1721720800000,
    "sweepSubmittedAt": null, "sweptAt": null
  }],
  "nextIndexByNetwork": { "base": 42 },
  "nonceTombstones": [{ "key": "private-deposit:agent-alpha:0x…", "expiresAt": 1721722500000 }]
}
```
Solana records: `stealthAddress`/`ephemeralPubKey`/`proofTxHash` base58, case-preserved.

### 3.2 State machine (durable, WAL)
| From | Event | To | Persist-before-effect |
|---|---|---|---|
| — | deposit-intent (issuing) | `awaiting-payment` | record persisted before returning recipient |
| `awaiting-payment` | verifier passes | `proof-verified` | persisted **before** `creditDeposit` |
| `proof-verified` | credit ok / idempotent-dup(own proof) | `credited` | persisted after credit; startup-reconcilable |
| `credited` | eligible + broadcast | `sweep-submitted` | tx hash + nonce persisted **before** broadcast |
| `sweep-submitted` | awaited success receipt | `swept` | — |
| `sweep-submitted` | dropped/failed | `sweep-submitted` (attempt++) or rebuild | reuseSweepNonce |
| `credited`/`sweep-submitted` | empty w/o our receipt | `reserve-mismatch` | + encrypted queue; gates payouts |
| `awaiting-payment` | unpaid past grace, confirmed empty | `dormant` | retained, never deleted |
| `awaiting-payment`/`dormant` | late nonzero, uncredited | `reserve-mismatch` | swept-to-pool + queue |
| `swept` | past retention | (deleted) | derivation still regenerable by index |

### 3.3 RPC (shapes unchanged; semantics only)
`POST /private/a2a/deposit-intent` → `recipient` is a one-time address when the
network is issuance-capable, else the treasury. `POST /private/a2a/deposit-confirm`
→ `{ payment: { status: "credited", commitment, balanceAtomic, acceptedAt } }`;
**rejects** (400) when the proof was already claimed by another record, when
`observed < expected`, or when the identity binding fails.

---

## 4. New env vars (validated, fail-closed — MAJOR #19)
| Name | Default | Meaning |
|---|---|---|
| `PX402_STEALTH_DEPOSITS_ENABLED` | `false` | Master switch for **issuance**. Per-network active only if settler present AND `settler == treasury`. |
| `PX402_DEPOSIT_SWEEP_MS` | `60000` | Consolidation cadence (ms). Must be a positive integer. |
| `PX402_DEPOSIT_SWEEP_MIN_AGE_MS` | `300000` | Min age of a `credited` record before sweep (decorrelation). |
| `PX402_DEPOSIT_SWEEP_MAX_PER_RUN` | `8` | Cap per run for BOTH the credited and unpaid scans (positive integer). |
| `PX402_DEPOSIT_SWEEP_CONFIRMATIONS` | `2` (EVM) / `finalized` (Solana) | Finality before marking `swept`. |
| `PX402_DEPOSIT_RETENTION_MS` | `900000` | Post-`swept` record retention before deletion. |
| `PX402_DEPOSIT_UNPAID_GRACE_MS` | `86400000` | Age before an unpaid record is confirmed-empty-checked and moved to `dormant`. Must be **≥ intent lifetime** (900 s) or startup fails. |
| `PX402_DEPOSIT_SWEEP_BACKOFF_MS` | `30000` | Per-record failure backoff base. |
| `PX402_DEPOSIT_SWEEP_MAX_ATTEMPTS` | `10` | Attempts before a sweep is quarantined. |

`validateDepositConfig()` runs at startup and THROWS (fail closed) on: any `NaN`,
negative, or zero duration/cadence; non-integer or <1 batch cap; `UNPAID_GRACE_MS <
intent lifetime`. Startup logs a backlog metric (oldest credited age + status counts).

CLAUDE.md doc lines: append the nine vars above with these one-liners, and state
that treasury stealth keys derive from the per-network settler key (no new secret),
issuance requires `settler == treasury`, and recovery runs regardless of the flag.

---

## 5. Per-chain sweep mechanism decision table
| Network | Token | Sweep instruction | Stealth-addr signer | Broadcaster / fee payer | Native at stealth | On-chain txs | Marked `swept` after |
|---|---|---|---|---|---|---|---|
| `base` | Circle USDC (EIP-3009) | `transferWithAuthorization(stealth→treasury, full balance)` | index'd secp256k1 key (regenerated) | **settler** via SettlerSendMutex | ZERO | 1 | `tx.wait(confirmations)` status===1 |
| `robinhood` | Paxos USDG (EIP-3009) | same | index'd secp256k1 key | **settler** via SettlerSendMutex | ZERO | 1 | `tx.wait(confirmations)` status===1 |
| `solana` | USDC-SPL | `transferChecked(stealthATA→treasuryATA)` + idempotent create-treasury-ATA | recovered ed25519 scalar (`sweepStealth`) | **settler** = fee payer, via SettlerSendMutex | ZERO SOL | 1 | `confirmTransaction(finalized).value.err === null` |

Rejected: the existing gas-funded EVM demo path (`scripts/x402-stealth-sweep.mjs:141-195`)
= settler→stealth native top-up THEN ERC-20 transfer (2 txs, pre-links settler↔stealth).
EIP-3009 is used instead. **Do NOT reuse `verifyAndSettle` for sweeps** — it returns
`tx.hash` without awaiting a receipt (`X402Facilitator.ts:152-163`); `sweepDepositToPool`
has its own broadcast-then-`wait` path.

---

## 6. Offline smoke — `scripts/stealth-deposit-smoke.mjs`
Style: `tsx`, `.ts` imports, `ok(cond,msg)` counter (match `scripts/stealth-smoke.mjs`
/ `scripts/solana-deposit-verify-smoke.mjs`). No live RPC/funds; inject fakes for
`ethCall`/`connection`/rails. Checks:

**A. Deterministic derivation & regeneration (depositStealth.ts)**
1. EVM/Solana treasury keys deterministic; different `caip2` OR `tokenAddress` ⇒ different roots (proves per-network KDF, #13).
2. `deriveEvmDepositAddress(i)` regenerates the SAME address/ephemeralPubKey from `(settler,keyVersion,i)` across calls.
3. `addressForPrivateKey(deriveEvmDepositPrivateKey(i))` === `deriveEvmDepositAddress(i).stealthAddress` (key controls address).
4. Solana: `publicKeyForSolanaScalar(deriveSolanaDepositScalar(i)).toBase58()` === `deriveSolanaDepositAddress(i).stealthAddress`.
5. Distinct indices ⇒ distinct addresses; a wrong `keyVersion` regenerates a DIFFERENT address (proves rotation binding, #8).

**B. Verifier proof identity (#9)**
6. `BasePaymentVerifier.verifyErc20Transfer` (stub RPC, receipt with two Transfer logs to two one-time EOAs) returns the correct `transferIndex` for each recipient and ACCEPTS each.
7. Same fixture REJECTS `recipient = treasury`.
8. Solana verifier returns a flattened-instruction `transferIndex` and ACCEPTS `recipient = stealthOwner`, REJECTS `recipient = treasury`.
9. `observedAmount` reflects an overpayment (returns > expected).

**C. Ledger proof-keyed credit (#9, #4)**
10. Two `creditDeposit` calls, same txHash, different `transferIndex`, different accounts ⇒ BOTH credited (no false duplicate).
11. Re-running `creditDeposit` with the same `(network,txHash,transferIndex)` ⇒ `duplicate:true` (idempotent WAL replay safe).
12. A legacy-key already-consumed txHash blocks an indexed credit for the same tx (replay backstop).

**D. Book saga + CAS (#2, #11, #24)**
13. Encrypted round-trip (`add`→reload); raw file does NOT contain the plaintext `stealthAddress` (encryption at rest); raw `agentId` absent; `accountId` is 64-hex.
14. `transition(id, expectedFrom, ...)` throws on a stale `expectedFrom` (CAS).
15. `consolidatable`/`unpaidStale` respect the cap and status filter.
16. `reapSwept` deletes only `swept`-past-retention; keeps others.
17. `nextIndex` increments monotonically and persists across reload.
18. `consumeNonce` throws on replay and persists the tombstone across reload (#17).
19. `close()` drains writes and wipes key buffers.

**E. Consolidation service (injected fake rails, #5, #6, #7)**
20. `credited` → `sweep-submitted` persisted BEFORE the fake broadcast; only an awaited `confirmed` result sets `swept`.
21. A fake rail returning `submitted-unconfirmed` leaves `sweep-submitted`; `reconcileOnStartup` + `sweepTxStatus:confirmed-success` promotes it to `swept`.
22. A `credited` record whose fake rail reports `empty` (no prior receipt) ⇒ `reserve-mismatch` + queue entry, NOT `swept`.
23. A throwing sweep increments `attemptCount`, backs off, and quarantines after `maxAttempts`.
24. `maxPerRun` caps both scans; single-flight `runOnce` (second concurrent call is a no-op/queued).
25. Late-payment: an `awaiting-payment`/`dormant` record with a fake nonzero balance is swept-to-pool + `reserve-mismatch` (never stranded, never silently pooled, #7/#15); a confirmed-empty one → `dormant` (retained, not deleted).

**F. Reserve gate + logging (#12, #18)**
26. `reserveOk(asset)` returns false when `ledgerLiability > treasuryBalance + Σ unswept record balances` (fake balances); `payoutFromLedger` refuses on false.
27. Quarantine path writes address/amount ONLY to `DepositReconciliationQueue` (encrypted); the captured log line contains `record=<id> reason=<code>` and NO address/amount.

Target: all green offline. Add to VERIFICATION.md standard checks.

---

## 7. Docs to update in the same diff
- **`README.md`** (MAJOR #20): revise the deposit paragraph — deposits
  target a per-deposit one-time address (issuance-capable networks) that the server
  later consolidates to the treasury; credit is exactly-once per
  `(network, txHash, transferIndex)`; add the honest residual (§8) and the
  burner-funding composability note.
- **`CLAUDE.md`**: the nine env vars (§4) + a Systems bullet describing one-time
  deposit addresses, deterministic indexed derivation, the WAL states, gasless sweep
  per chain, reserve-gated payouts, encrypted reconciliation queue, and the honest
  residual. Update the existing private-ledger deposit sentence.
- **`VERIFICATION.md`**: add `npm run test:stealth:deposits`; note that stealth-deposit
  changes must also keep `test:x402:private-ledger` and `test:ledger:solana` green
  (credit path changed — proof identity), and that sweeps mark `swept` only after
  awaited finality.

---

## 8. Honest residual-leak statement (reframed — BLOCKER #1)
One-time deposit addresses deliver **delayed pool attribution**, not unlinkability:
1. **The graph join survives.** EVM `transferWithAuthorization` carries `from/to/value`
   (`X402Facilitator.ts:10-13,152-161`); Solana `transferChecked` names source/dest
   ATAs and owner (`stealthSolana.ts:151-160`). The consolidation tx gives an exact
   `stealthAddress → treasury` edge; combined with the deposit's `depositor →
   stealthAddress` edge, a motivated analyst recovers `depositor → treasury` by a
   2-hop join. No amount/timing inference is even required. "Shuffling" reorders
   independent sweeps; it does not break the edge.
2. **What is actually gained:** (a) no always-on treasury watchlist — an observer
   watching the known treasury sees nothing at deposit time; (b) forward ambiguity
   until consolidation (the one-time address looks like any address until it is swept);
   (c) many deposits share one consolidation window, so the pool's inbound is not a
   per-depositor signal in real time.
3. **When it becomes real unlinkability — composability:** if the depositor funds the
   one-time address from a **burner / unlinkable source** (per-address CEX withdrawal,
   or a future shielded pool), the `depositor → stealthAddress` edge terminates at the
   burner and the pool never observes the depositor's persistent wallet. This feature
   is the address-layer half; the money-trail half is out of scope (blind-voucher
   workstream).
4. **Amounts + timing stay public** on both legs; an exact unusual amount reappearing
   in a consolidation is trivially linkable (fixed-denomination consolidation is the
   denominations workstream, not this one).
5. **Settler relays every sweep** (tx origin ties settler↔stealth↔pool) and **the live
   server** sees the address↔agent mapping while processing — same honesty boundary as the
   private ledger; only at-rest data is encrypted.

Net: **temporal + set decorrelation and removal of the treasury watchlist, not ZK
unlinkability.** Docs and the README must carry exactly this framing.

---

## 9. Migration / rollout
- **Issuance flag default OFF**; flag-off deposit path is byte-for-byte today's
  behavior (treasury recipient, legacy credit key, no book record).
- **Per-network gate:** issue only when settler present AND `settler == treasury`;
  else treasury fallback + log.
- **Recovery independent of the flag** (Decision 6): `DepositAddressBook`,
  `DepositReconciliationQueue`, and `DepositConsolidationService` are constructed
  whenever the book file exists, so disabling issuance still sweeps outstanding funds.
  `reconcileOnStartup` runs before the timer starts.
- **Single-process invariant** (#11): the consolidation service assumes one backend
  process (matches `index.ts`). Guard with a `data/.deposit-consolidation.lock`
  (pid + mtime); refuse to start a second consolidator. Distributed leader lease →
  §10 Q5.
- **Ledger migration:** none. Indexed proof keys are new; legacy deposits keep their
  legacy keys and stay non-replayable via the backstop.
- **Shutdown:** `clearInterval` the sweep timer, `await` any in-flight `runOnce`,
  then `await book.close()` and `await queue.close()` alongside the existing
  `privateLedgerSweepTimer` teardown.

---

## 10. Open questions (only genuinely unresolved)
1. **Deposit finality depth for CREDIT.** This spec adds a confirmation-depth check
   for the SWEEP and (minimal) for the stealth-deposit credit, but Base still accepts
   the first receipt (`BasePaymentVerifier.ts:59-80`) and Solana uses `confirmed` for
   deposit verification (`SolanaPaymentVerifier.ts:24`). Full reorg-safe finalized
   crediting (and rollback of a credited-then-reorged deposit) is deferred — recommend
   a follow-up that requires `finalized`/N-confirmations for credit too.
2. **Book vs ledger account KDF sharing.** The book's `accountId` must match the
   ledger's HMAC (`PrivatePaymentLedger.ts:666-668`, tag
   `"px402-private-ledger/account-index/v2\0"`). Implementer choice: expose a
   getter on the ledger, or re-derive with the identical tag in the book. Spec assumes
   re-derivation with the identical tag.
3. **Reserve reconciliation depth.** §2.6 `reserveOk` is the minimal sound version (a
   per-asset check gating payouts + a backlog metric). Continuous reserve monitoring,
   alerting thresholds, and automatic dry-run flip on sustained mismatch are deferred.
4. **Overpayment credit policy.** Spec credits `expected`, records the surplus, and
   quarantines it for manual reconciliation. Whether surplus should auto-credit the
   agent or auto-refund is a product decision.
5. **Multi-process / HA.** Single-process lockfile is specified; a leader lease for a
   multi-replica backend is deferred.
6. **SettlerSendMutex interface.** Sweeps must serialize through the batching
   workstream's `SettlerSendMutex`. Its exact type is owned by that workstream; this
   spec injects `send<T>(fn)` and falls back to a local single-flight lock until it
   lands. Confirm the final interface at integration.
7. **Solana treasury == settler default.** `solanaLedgerTreasury` defaults to the
   settler pubkey (`index.ts:69-73`), satisfying Decision 6 automatically; confirm ops
   intends the settler to custody consolidated Solana USDC (it already does for pool payout).

---

## 11. Critique responses (per finding)

All 25 findings were re-verified against the code. **Every finding is accepted and
fixed; none is rebutted on substance.** The critic's own "Verified correct claims"
list matched my re-read.

### BLOCKERS
- **#1 Privacy overclaim — FIXED (reframe).** Verified: `transferWithAuthorization`
  carries `from/to/value` (`X402Facilitator.ts:10-13`), `transferChecked` names the
  ATAs (`stealthSolana.ts:151-160`) — the 2-hop join is real. Renamed the feature to
  "one-time deposit addresses / delayed pool attribution"; removed all "kill trail"/
  "set-based privacy" claims; added the burner-funding composability note; propagated
  to §8, CLAUDE.md, README.md. No shielded pool invented.
- **#2 `sweep-pending` dead state — FIXED.** New state machine has `sweep-submitted`
  with `attemptCount`, `sweepNonce`, `sweepTxHash`, `nextRetryAt`; `resumableSubmitted()`
  re-selects it; startup reconciliation re-checks the tx.
- **#3 Restart cannot credit — FIXED.** Verified intents are in-memory
  (`PrivateAgentRegistry.ts:218`, reject at `:479-480`) and v1's record lacked
  `fromAddress`. The durable record now stores the FULL verification intent; confirm
  resolves the durable record first.
- **#4 Non-atomic credit vs book — FIXED.** WAL ordering (`proof-verified` before
  `creditDeposit`; idempotent proof-keyed credit) + startup reconciliation heals a
  crash between ledger persist and `markCredited`.
- **#5 tx.hash ≠ confirmed — FIXED.** Verified `verifyAndSettle` returns `tx.hash`
  with no `wait()` (`X402Facilitator.ts:152-163`); Solana ignores `.value.err`
  (`SolanaX402Facilitator.ts:133-136`). `sweepDepositToPool` now has its own
  broadcast-then-`tx.wait(confirmations)`/`finalized`+err-check path; `swept` set only
  on awaited success; submitted hashes reconciled on restart.
- **#6 "zero ⇒ swept" — FIXED.** Zero balance without our confirmed sweep receipt ⇒
  `reserve-mismatch` (payouts gated, encrypted queue), never silent `swept`.
- **#7 Unpaid reap strands late funds — FIXED.** Deterministic indexed derivation makes
  every address regenerable from `(settler,keyVersion,index)`; unpaid records go to
  `dormant` (retained, never deleted); late nonzero balances are always sweepable.
- **#8 Key/token rotation mis-sweep — FIXED.** `keyVersion` + `caip2` + `tokenAddress`
  + `expectedStealthAddress` + `poolAddress` are stored and validated in `sweepDeposit`;
  recovery keyring maps historical `keyVersion → settler`; recovery runs with the flag off.
- **#9 Coarse replay identity — FIXED.** Verified `.some(...)` match + txHash-only dedup
  + confirm ignoring `result.duplicate` (`:499-512`). Verifiers now return
  `transferIndex`; ledger dedups on `(network,txHash,transferIndex)` with a legacy
  backstop; confirm rejects a cross-record duplicate.
- **#10 Type/algorithm errors — FIXED.** VALUE import of `EncryptedJsonFile`;
  `amountAtomic` passed as string; `sweepDeposit` gets `nowSeconds`/`confirmations`;
  facilitator `mode`/settlement `settlement` field used precisely; KDF fully
  byte-specified with `toUtf8Bytes`/`concat`/`u64be`.

### MAJORS
- **#11 Concurrency — FIXED.** Single-flight `runOnce`, CAS `transition`, cloned
  returns, rollback on persist failure, single-process lockfile (leader lease deferred, Q5).
- **#12 Wrong invariant — FIXED.** Added per-asset `reserveOk` (treasury + unswept
  record balances vs `ledgerLiability`) gating payouts + smoke #26. Continuous
  monitoring deferred (Q3).
- **#13 KDF not per-network — FIXED.** KDF input binds CAIP-2 + token + scheme +
  keyVersion; byte order/encoding specified (§2.1).
- **#14 "no new trust root" false — FIXED.** Issuance now requires `settler == treasury`;
  expanded trust stated explicitly.
- **#15 Silent appropriation — FIXED.** Verifier returns `observedAmount`; record stores
  it + `overpaymentAtomic`; overpayment/second-deposit ⇒ quarantine + encrypted queue.
- **#16 Unbounded/Solana-zero — FIXED.** Both scans capped by `maxPerRun` + backoff;
  `stealthAtaBalance` distinguishes missing-ATA/zero/RPC-error (avoids `sweepStealth`'s
  non-positive throw, `stealthSolana.ts:137`).
- **#17 Replayed intents — FIXED.** Durable nonce tombstones (Decision 7) persisted with
  bounded retention; no client change.
- **#18 Log leakage — FIXED.** Logs carry `record=<id> reason=<code>` only; address/amount
  go to the encrypted `DepositReconciliationQueue`.
- **#19 Unvalidated config — FIXED.** `validateDepositConfig` fails closed on
  NaN/negative/zero/fractional and `UNPAID_GRACE_MS < intent lifetime`; backlog metric logged.
- **#20 Missing user-facing doc — FIXED.** Verified the README's deposit description;
  added to the same-diff doc list (§7).

### MINORS
- **#21 Wiring — FIXED.** Registry is built in `index.ts:120-123` and passed to the
  server; new options wired in `index.ts`; `createPrivateAgentServer.ts:145` changed to
  `await`. No server→registry construction invented.
- **#22 accountId 32→64 hex — FIXED** (§3.1 example).
- **#23 null vs omitted — FIXED.** Optional fields typed `string | null`/`number | null`
  and shown as `null`.
- **#24 Unspecified `close()` — FIXED.** `DepositAddressBook.close()`/`Queue.close()`
  drain writes + wipe key buffers; shutdown awaits the active pass.
- **#25 Wrong helper signature in Decision 1 — FIXED.** Decision text now uses the
  object form `computeStealthPrivateKey({ ephemeralPubKey, viewingKey, spendingKey })`
  (`stealth.ts:97-102`).
