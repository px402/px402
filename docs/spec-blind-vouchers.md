# FROZEN SPEC v2 — Chaumian Blind-Signature Vouchers (BDHKE) for the Private Ledger

**Status:** revised implementation spec after adversarial Codex review (v1 REJECTED: 4 BLOCKER, 8 MAJOR, 2 MINOR). Every finding is verified against the actual code and resolved below; see **§11 Critique responses** for the finding-by-finding disposition (fixed / rebutted-with-evidence / deferred). TypeScript strict, **no new dependencies** (`@noble/curves@1.9.7`, `ethers@6.17.0`, `@solana/web3.js` only). Reviewed commit `98736ca`.

**One-line goal:** add a Cashu-style blind-signature layer so the server holds **no direct cryptographic or protocol identifier** linking *who melted* to *who redeemed* inside the private ledger. Custody/trust model unchanged (server already custodies the pool). This is the buildable ZK-endgame step; the honest ceiling (statistical correlation still possible) is stated plainly in §8.

**Scope discipline:** implementable in one Codex wave. A full external transparency log, peer gossip infrastructure, and tombstone indexing beyond keyset partitioning are pushed to **§10 open questions** with the minimal sound version specced here.

---

## 0. Design decisions locked (read once)

1. **Curve/lib:** secp256k1 via `@noble/curves/secp256k1` `ProjectivePoint` (same import as `src/shared/stealth.ts`). Confirmed on 1.9.7: `ProjectivePoint.BASE`, `.fromHex`, `.toBytes(true)`→33-byte compressed, `.add/.subtract/.negate/.multiply/.equals/.assertValidity`, `secp256k1.CURVE.n`, `secp256k1.utils.randomSecretKey()`. **`multiply(0n) throws** — every scalar fed to `.multiply` MUST be validated nonzero (§4.7).
2. **Hash-to-curve — Cashu NUT-00 domain-separated try-and-increment**, implemented in-repo (not `@noble`'s top-level `hashToCurve` export — rejected: heavier SSWU map, no in-repo KATs). Pinned KATs in §4.1; Codex confirmed the three point outputs and the loop counters are **0, 3, 3** respectively.
3. **Hashing/encoding in shared code:** `sha256`, `randomBytes`, `getBytes`, `hexlify`, `concat`, `toUtf8Bytes` from `ethers` (browser-safe, already used across `src/shared/`). No `node:crypto` in `src/shared/`. Server-only modules use `node:crypto` freely.
4. **Equivocation defence (B1) — signed append-only keyset MANIFEST under a stable mint identity key + cross-client checkpoint comparison over WireGuard.** Published keys + DLEQ alone do NOT stop a server handing a unique keyset per agent; the manifest + a mint-identity signature + full 32-byte keyset digests + cross-peer checkpoint comparison do. **Honest residual:** two *fully isolated* clients that never compare checkpoints can still each be shown a consistent-but-different manifest — cross-client checkpoint comparison is the shippable mitigation; a real transparency log with external witnesses is an open question (§10).
5. **Denominations** consumed from the parallel denominations spec: `{0.1,1,10,100}` → atomic `{100000,1000000,10000000,100000000}` for all three 6-decimal tokens. Each denomination = its own keypair inside a keyset. Clients derive denominations from the **committed active keyset**, never from a caller list (M12). Honest constraint: this set only represents exact multiples of 0.1.
6. **Accounting — PER-KEYSET liability (B3).** New account label `vouchers:<assetKey>:<keysetId>` per active keyset (Codex confirmed these slot into the existing zero-sum invariant unchanged). Sign ONLY under active keysets; NEVER erase a key while its keyset's liability ≠ 0. No arbitrary-amount sweep.
7. **Crash-safety (B4):** blind signing `C'=k·B'` is pure/deterministic. The mint computes signatures + self-verifies DLEQ **in memory before** committing the debit; the client persists a **pending issuance record `{x,r,B_,keysetId,fingerprint}` before** submitting and finalizes atomically after. Retry uses a **fresh intent nonce** (consumeNonce rejects repeats — verified) with content-fingerprint idempotency at the ledger.
8. **Serialized nullifier reservation (B2):** verify + intra-request duplicate rejection + spent lookup + reservation + persistence run inside ONE mint-wide `serialize()`/`writeQueue` critical section (mirrors `PrivatePaymentLedger.ts:615-618`), clone+rollback on persist failure.
9. **Fail-closed everywhere (M5):** all three encrypted stores use `{ failClosed: true }` + decrypted-schema validation; retirement erases keys **before** pruning nullifiers.
10. **Redeem is bearer-authenticated, single-keyset** (M8): gated by WireGuard membership + knowledge of `(secret,C)`; canonical length-prefixed `redeemKey` includes version, asset, recipient, keysetId, and sorted `(denom,nullifier)`.
11. **Transferable vouchers (M9):** the bearer token retains `{r, dleq:{e,s}}` so a *receiving* peer verifies offline against the committed keyset; `r` is NEVER sent to the server.

---

## 1. File-by-file change list

### NEW
| Path | Purpose | Env |
|---|---|---|
| `src/shared/blindVoucher.ts` | Isomorphic BDHKE crypto: hash-to-curve, blind/unblind, sign, redeem-verify, DLEQ prove/verify (deterministic nonce), canonical fingerprint/redeemKey/keysetId encoders, manifest hashing + verify. `ethers`+`@noble/curves` only, no `node:*`. | browser+node |
| `src/shared/blindVoucherClient.ts` | Browser-safe protocol/RPC helpers + `VoucherWallet` **interface** (injected persistence — no fs). melt prepare/submit/finalize/recover, redeem, discovery+manifest verification. | browser+node |
| `src/node/blindVoucherWalletFile.ts` | **Node-only** reference `VoucherWallet` over an encrypted file: separate 32-byte wallet key, `failClosed`, serialized mutations, atomic temp+rename. Imports `node:fs/promises`. | node |
| `src/server/payments/BlindVoucherMint.ts` | Server mint service: durable encrypted keyset registry (secret `k` at rest), signed append-only manifest + checkpoint, encrypted per-keyset nullifier spent-set, `serialize()` critical section, sign/verify+reserve, rotate/retire (liability-gated erasure). | node |
| `scripts/blind-voucher-smoke.mjs` | Offline falsification suite (§7). Wired as `test:blind-vouchers`. | node |

### MODIFIED
| Path | Change |
|---|---|
| `src/server/payments/PrivatePaymentLedger.ts` | Per-keyset liability accounts `vouchers:<asset>:<keysetId>`; methods `meltToVouchers`, `redeemToAccount`, `reclaimRetiredKeyset`, `voucherLiability(assetKey,keysetId)`; add `consumedVoucherRefs?: Record<string,string[]>` (partitioned by keysetId) to v3 `LedgerFile` (additive, defaulted in `load()`); **`assertState()` validates `consumedVoucherRefs`** (M11). No version bump. |
| `src/server/agents/PrivateAgentRegistry.ts` | `mint?: BlindVoucherMint` option; `assertVpnMember`, `mintManifest(network,token,remoteIp)`, `issueBlindVouchers`, `redeemBlindVouchers`. |
| `src/server/agents/createPrivateAgentServer.ts` | `mint?` dep; routes `GET /private/a2a/mint-keys`, `POST /private/a2a/voucher-issue`, `POST /private/a2a/voucher-redeem` (reuse `resolveLedgerDeposit` for the token). |
| `src/shared/x402AgentIntent.ts` | `blindVoucherIssueIntentMessage(...)` (identity-signed melt). No redeem intent (bearer). Add `"voucher-issue"` to `consumeNonce` scope union. |
| `src/server/config.ts` | `agentRpc.blindVouchersEnabled`, `.blindVoucherDenominationsAtomic`, `.blindVoucherKeysetGraceMs`, `.blindVoucherMintIdentityKey`, `.blindVoucherMaxOutputsPerRequest`, `.blindVoucherMaxProofsPerRequest`; strict `parseDenoms` (M12). |
| `src/server/index.ts` | Construct `BlindVoucherMint` when `blindVouchersEnabled && privatePaymentLedger`; pass `mint` into registry + server; keyset-retirement timer (liability-gated). |
| `package.json` | `"test:blind-vouchers": "tsx scripts/blind-voucher-smoke.mjs"`. |
| `CLAUDE.md` | Env vars + Systems bullet + honest privacy statement (§6, §8). |
| `scripts/private-ledger-smoke.mjs` | The three `version === 3` asserts at **lines 272, 361, 411** stay valid (no version bump); add one assert that `consumedVoucherRefs` defaults + round-trips. |

---

## 2. Exact TypeScript signatures

### 2.1 `src/shared/blindVoucher.ts` (isomorphic)
```ts
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256, getBytes, hexlify, concat, toUtf8Bytes, randomBytes, type BytesLike } from "ethers";
const { ProjectivePoint } = secp256k1;
const N = secp256k1.CURVE.n;
type Point = InstanceType<typeof ProjectivePoint>;

export interface BlindVoucherOutput { denomAtomic: string; B_: string; }          // B_: 0x compressed
export interface DleqProof { e: string; s: string; }
export interface BlindSignature { denomAtomic: string; C_: string; dleq: DleqProof; }
/** Transferable bearer token — retains r + dleq for OFFLINE receiver verification (r never sent to server). */
export interface BlindVoucher {
  id: string;            // local wallet id (random) — never sent to the mint
  asset: string;         // "base:0x8335…"
  keysetId: string;      // full 32-byte digest, 0x + 64 hex
  denomAtomic: string;
  secret: string;        // x, 0x 32 bytes
  C: string;             // unblinded k·Y, 0x compressed
  r: string;             // blinding scalar — OFFLINE verify only, NEVER in a redeem body
  dleq: DleqProof;       // issuance DLEQ over (K, C_, B_)
}
export interface BlindingContext { secret: string; r: string; denomAtomic: string; Y: string; B_: string; }
export interface KeysetDenominationPub { denomAtomic: string; K: string; }         // K: 0x compressed public key

// primitives
export const hashToCurve = (secret: BytesLike): Point;                              // Cashu NUT-00, §4.1
export const nullifierOf = (secret: BytesLike): string;                            // §4.5, 0x-hex
export const randomSecret = (): string;                                            // 32 random bytes 0x-hex
export const randomScalar = (): string;                                            // nonzero [1,n-1], 0x-hex (§4.7)

// client
export const blindSecret = (secret: BytesLike, rHex?: string): BlindingContext;    // rHex injectable for tests
export const unblindSignature = (i: { C_: string; r: string; K: string }): string; // C = C_ - r·K
export const verifyDleq = (i: { B_: string; C_: string; K: string; dleq: DleqProof }): boolean; // try/catch→false
/** Offline receiver check of a transferred voucher against the COMMITTED keyset key K for its denom. */
export const verifyTransferredVoucher = (i: { secret: string; C: string; r: string; dleq: DleqProof; K: string }): boolean;

// server / mint
export const signBlinded = (i: { B_: string; k: string }): string;                 // C_ = k·B_
export const proveDleq = (i: { B_: string; C_: string; k: string; K: string }): DleqProof; // deterministic nonce §4.6
export const verifyRedeemProof = (i: { secret: string; C: string; k: string }): boolean;   // k·H(secret) == C

// denominations + canonical encodings (all length-prefixed + domain-separated, §4.8)
export const decomposeAmount = (amountAtomic: string, denomsAtomic: readonly string[]): string[]; // exact or throw
export const sumAtomic = (values: readonly string[]): string;
export const meltFingerprint = (i: { asset: string; keysetId: string; outputs: readonly BlindVoucherOutput[]; totalAtomic: string }): string;
export const redeemKeyOf = (i: { asset: string; recipientAgentId: string; keysetId: string; proofs: readonly { denomAtomic: string; nullifier: string }[] }): string;
export const computeKeysetId = (i: { asset: string; epoch: number; denominations: readonly KeysetDenominationPub[] }): string; // full 32-byte digest

// manifest (B1)
export interface ManifestEntry {
  seq: number; asset: string; epoch: number; keysetId: string;
  denominations: KeysetDenominationPub[];
  activatesAt: number; redeemUntil: number | null;   // null = redeem indefinitely (default policy)
  prevEntryHash: string;                              // hash-chain, "0x0"*32 for seq 0
}
export interface SignedManifestEntry { entry: ManifestEntry; entryHash: string; signature: string; } // ECDSA over entryHash
export interface ManifestCheckpoint { headSeq: number; headEntryHash: string; signature: string; }
export const hashManifestEntry = (e: ManifestEntry): string;
export const verifyManifestEntry = (e: SignedManifestEntry, mintPubKey: string): boolean;
export const verifyCheckpoint = (c: ManifestCheckpoint, mintPubKey: string): boolean;
```

### 2.2 `src/server/payments/BlindVoucherMint.ts`
```ts
export interface MintDenominationKey { denomAtomic: string; k: string; K: string; }  // k SECRET (encrypted at rest)
export interface MintKeyset {
  keysetId: string; asset: string; epoch: number;
  status: "active" | "retired" | "frozen";     // frozen = past redeemUntil, redemptions refused, awaiting reclaim+erase
  activatesAt: number; retiredAt?: number; redeemUntil: number | null;
  denominations: MintDenominationKey[];
}
export interface PublicKeyset {                 // returned to agents — NEVER includes k
  keysetId: string; asset: string; epoch: number; status: MintKeyset["status"];
  activatesAt: number; retiredAt?: number; redeemUntil: number | null;
  denominations: import("../../shared/blindVoucher").KeysetDenominationPub[];
}
export interface BlindVoucherMintOptions {
  keysetFilePath: string;       // data/blind-voucher-keysets.json (durable, encrypted, failClosed)
  nullifierFilePath: string;    // data/blind-voucher-nullifiers.json (durable, encrypted, failClosed)
  encryptionKey: string;        // PX402_DATA_ENCRYPTION_KEY
  mintIdentityKey: string;      // secp256k1 privkey signing the manifest (server-only)
  denominationsAtomic: readonly string[];
  keysetGraceMs: number;
  maxOutputsPerRequest: number; maxProofsPerRequest: number;
  assets: readonly string[];
}
export interface MintSignResult { keysetId: string; signatures: import("../../shared/blindVoucher").BlindSignature[]; }

export class BlindVoucherMint {
  constructor(options: BlindVoucherMintOptions);
  load(): Promise<this>;                                  // failClosed load; bootstrap 1 active keyset/asset if none

  mintIdentityPubKey(): string;                           // stable, pinned by agents out-of-band
  publicManifest(asset: string): import("../../shared/blindVoucher").SignedManifestEntry[];
  checkpoint(asset: string): import("../../shared/blindVoucher").ManifestCheckpoint;
  publicKeysets(asset: string): PublicKeyset[];
  activeKeyset(asset: string): PublicKeyset | undefined;

  /** PURE (no persisted side effect): validate keysetId is ACTIVE, denoms exist, ≤maxOutputs; sign + self-verify DLEQ. Throws on invalid. */
  sign(i: { asset: string; keysetId: string; outputs: import("../../shared/blindVoucher").BlindVoucherOutput[] }): MintSignResult;

  /** SERIALIZED critical section (B2): all-nullifiers-first, reject intra-request dups, verify crypto, all-or-nothing reserve, clone+rollback. */
  verifyAndReserveNullifiers(i: {
    asset: string; keysetId: string; redeemKey: string;
    proofs: { denomAtomic: string; secret: string; C: string }[];
  }): Promise<{ valueAtomic: string; duplicate: boolean }>;

  rotateKeyset(asset: string): Promise<PublicKeyset>;      // new active; prev active→retired; append+sign manifest
  /** Freeze keysets past redeemUntil (stop redemptions). Returns frozen keyset ids for the ledger reclaim+erase step. */
  freezeExpiredKeysets(now?: number): Promise<{ asset: string; keysetId: string }[]>;
  /** Erase a FROZEN keyset's secret keys + prune its nullifiers. PRECONDITION: caller proved ledger liability == 0. Keys erased BEFORE nullifier prune (M5). */
  eraseKeyset(asset: string, keysetId: string): Promise<void>;
  close(): void;                                           // zero secret buffers
}
```

### 2.3 `PrivatePaymentLedger.ts` additions
```ts
export interface LedgerVoucherMeltInput { agentId: string; amountAtomic: string; assetKey: string; keysetId: string; meltKey: string; acceptedAt?: number; }
export interface LedgerVoucherRedeemInput { recipientAgentId: string; amountAtomic: string; assetKey: string; keysetId: string; redeemKey: string; acceptedAt?: number; }
export interface LedgerVoucherResult { balanceAtomic: string; duplicate: boolean; }

meltToVouchers(i: LedgerVoucherMeltInput): Promise<LedgerVoucherResult>;   // agent -= A ; vouchers:<asset>:<keysetId> += A
redeemToAccount(i: LedgerVoucherRedeemInput): Promise<LedgerVoucherResult>;// vouchers:<asset>:<keysetId> -= A ; recipient += A
reclaimRetiredKeyset(i: { assetKey: string; keysetId: string }): Promise<{ reclaimedAtomic: string }>; // vouchers:<..>:<ks> -= bal ; escrow += bal (exact, provable)
voucherLiability(assetKey: string, keysetId: string): string;
```
Internals:
- `EMPTY_LEDGER()` gains `consumedVoucherRefs: {}`. `LedgerFile` gains `consumedVoucherRefs?: Record<string /*keysetId*/, string[] /*authHashes*/>`. `load()` defaults `this.state.consumedVoucherRefs ??= {}`.
- `meltToVouchers`: `authHash = hash("voucher-melt:"+meltKey)`; if `consumedVoucherRefs[keysetId]?.includes(authHash)` → `{ balance(agent), duplicate:true }`. Else assert `balance(agent) >= A`; snapshot `prevTotal`; move agent→`vouchers:<asset>:<keysetId>`; append tombstone under `keysetId`; `assertConserved`; persist (structuredClone/try-catch rollback). All in `serialize()`.
- `redeemToAccount`: `authHash = hash("voucher-redeem:"+redeemKey)`; tombstone under `keysetId`; assert `voucherLiability(asset,keysetId) >= A`; move `vouchers:<asset>:<keysetId>`→recipient; `assertConserved`; persist.
- `reclaimRetiredKeyset`: `A = voucherLiability(asset,keysetId)`; if `A>0` move `vouchers:<asset>:<keysetId>`→`escrow:<asset>`; `assertConserved`; delete `consumedVoucherRefs[keysetId]` (prune); persist. Returns `A`. **Only** callable by the retirement timer after the mint has FROZEN the keyset (no new redeems possible → `A` is final/provable).
- `assertState()` (M11): after the existing checks, validate `consumedVoucherRefs` is an object of `string[]` whose entries are `0x`-prefixed hashes; per-keyset `vouchers:<asset>:<keysetId>` accounts already validate via the existing per-asset zero-sum + `":"`-in-asset-key checks (the asset map key is still `network:token`; the account *label* is HMAC-derived by `accountId()` — no change to the inner key format).

### 2.4 `PrivateAgentRegistry.ts` additions
```ts
export interface BlindVoucherIssueInput {
  payerAgentId: string; network?: string; keysetId: string;
  outputs: import("../../shared/blindVoucher").BlindVoucherOutput[]; totalAtomic: string;
  intentNonce: string; agentSignature: string; requestRef?: string;   // requestRef NOT trusted for idempotency
}
export interface BlindVoucherRedeemInput {
  network?: string; recipientAgentId: string; keysetId: string;        // single-keyset per request (M8/M11)
  proofs: { denomAtomic: string; secret: string; C: string }[];        // NO r — r stays client-side (M9)
}
// options gains: mint?: BlindVoucherMint;
mintManifest(network: string, token: X402TokenConfig, remoteIp: string): {
  network: string; asset: string; mintIdentityPubKey: string;
  checkpoint: ManifestCheckpoint; manifest: SignedManifestEntry[]; keysets: PublicKeyset[];
};
issueBlindVouchers(i: BlindVoucherIssueInput, remoteIp: string, token: X402TokenConfig, nowSeconds: number): Promise<MintSignResult>;
redeemBlindVouchers(i: BlindVoucherRedeemInput, remoteIp: string, token: X402TokenConfig, nowSeconds: number): Promise<{ status: "redeemed"; valueAtomic: string }>;
private assertVpnMember(remoteIp: string): void;   // remoteIp ∈ {endpoint.vpnIp} else throw
```

`issueBlindVouchers` (server order — B4):
1. `payer = requireEndpoint(payerAgentId); assertVpnPeer(payer, remoteIp)`.
2. `active = mint.activeKeyset(assetKey)`; require `input.keysetId === active.keysetId` (**sign only under active** — B3); require `outputs.length ≤ maxOutputsPerRequest` (M12); every `denomAtomic ∈ active.denominations`; `sumAtomic(denoms) === totalAtomic`; `BigInt(totalAtomic) > 0`.
3. `fp = meltFingerprint({asset,keysetId,outputs,totalAtomic})`; `assertAgentIntent(payer, agentSignature, blindVoucherIssueIntentMessage({payerAgentId, network: token.network, keysetId, outputsFingerprint: fp, totalAtomic, intentNonce}))`; `consumeNonce("voucher-issue", payer.agentId, intentNonce)` (**fresh nonce each attempt**).
4. `const result = this.mint.sign({asset, keysetId, outputs})` — computes C_+DLEQ and **self-verifies DLEQ in memory**; throws (⇒ NO debit) if any invalid.
5. `await this.privateLedger.meltToVouchers({agentId: payer.agentId, amountAtomic: totalAtomic, assetKey, keysetId, meltKey: fp})` — idempotent by `fp`.
6. `return result`. (Crash after 5 before response → client retries with fresh nonce + same `fp` → step 5 idempotent, step 4 deterministic ⇒ same C_.)

`redeemBlindVouchers`:
1. `assertVpnMember(remoteIp)` (membership only, NO identity).
2. `recipient = requireEndpoint(recipientAgentId)`; `proofs.length ≤ maxProofsPerRequest`.
3. `redeemKey = redeemKeyOf({asset, recipientAgentId: recipient.agentId, keysetId, proofs: proofs.map(p=>({denomAtomic:p.denomAtomic, nullifier: nullifierOf(p.secret)}))})`.
4. `const { valueAtomic } = await this.mint.verifyAndReserveNullifiers({asset, keysetId, redeemKey, proofs})` — **nullifiers reserved before credit** (crash-safe order, Codex claim #8).
5. `await this.privateLedger.redeemToAccount({recipientAgentId: recipient.agentId, amountAtomic: valueAtomic, assetKey, keysetId, redeemKey})` — idempotent by `redeemKey`.
6. `return { status:"redeemed", valueAtomic }` — no counterparty, no melt ref, no recipient balance.

### 2.5 `createPrivateAgentServer.ts` routes
```
GET  /private/a2a/mint-keys?network=base   503 if !mint; resolve token via resolveLedgerDeposit; 200 registry.mintManifest(network, token, remoteIp)
POST /private/a2a/voucher-issue            503 if !mint||!ledger; 201 { result: await registry.issueBlindVouchers(body, remoteIp, resolved.token, now) }
POST /private/a2a/voucher-redeem           503 if !mint||!ledger; 201 { result: await registry.redeemBlindVouchers(body, remoteIp, resolved.token, now) }
```

### 2.6 `x402AgentIntent.ts` addition
```ts
export const blindVoucherIssueIntentMessage = (i: {
  payerAgentId: string; network: string; keysetId: string; outputsFingerprint: string; totalAtomic: string; intentNonce: string;
}) => JSON.stringify({ protocol: "px402-blind-voucher/v1", action: "issue", ...i });
```

### 2.7 `src/shared/blindVoucherClient.ts` (browser-safe; INJECTED persistence)
```ts
import type { AgentIdentitySigner } from "./privateX402Client";
import type { BlindVoucher, BlindingContext } from "./blindVoucher";

export interface PendingIssuance {
  fingerprint: string; asset: string; keysetId: string; createdAt: number;
  contexts: { denomAtomic: string; secret: string; r: string; B_: string }[];
}
/** Persistence is injected — keeps this module browser-safe (M10). Implementations serialize + atomic-replace. */
export interface VoucherWallet {
  loadPending(): Promise<PendingIssuance[]>;
  savePending(rec: PendingIssuance): Promise<void>;
  finalize(fingerprint: string, vouchers: BlindVoucher[]): Promise<void>; // ATOMIC: drop pending + add vouchers
  loadVouchers(): Promise<BlindVoucher[]>;
  removeVouchers(ids: string[]): Promise<void>;
}
export interface DiscoveredMint {
  network: string; asset: string; mintIdentityPubKey: string;
  checkpoint: ManifestCheckpoint; manifest: SignedManifestEntry[]; keysets: PublicKeyset[];
}

/** Fetch + verify manifest signatures + recompute every keysetId. Caller SHOULD compare `checkpoint` with a peer (B1). */
export const discoverMint = (i: { rpcUrl: string; network?: string; pinnedMintPubKey: string }) => Promise<DiscoveredMint>;
/** Cross-client equivocation guard: throws if two checkpoints for the same head differ. */
export const assertCheckpointAgreement = (a: ManifestCheckpoint, b: ManifestCheckpoint) => void;

export const meltToBlindVouchers = (i: {
  rpcUrl: string; payerAgentId: string; amountAtomic: string; network?: string;
  mint: DiscoveredMint; identitySigner: AgentIdentitySigner; wallet: VoucherWallet;
}) => Promise<BlindVoucher[]>;   // decompose→blind→savePending→submit→verifyDleq→unblind→finalize
/** Recover a pending issuance whose response was lost/crashed: fresh nonce, same fingerprint. */
export const recoverMelt = (i: {
  rpcUrl: string; payerAgentId: string; pending: PendingIssuance; network?: string;
  mint: DiscoveredMint; identitySigner: AgentIdentitySigner; wallet: VoucherWallet;
}) => Promise<BlindVoucher[]>;
export const redeemBlindVouchers = (i: {
  rpcUrl: string; recipientAgentId: string; vouchers: BlindVoucher[]; network?: string;
}) => Promise<{ status: "redeemed"; valueAtomic: string }>;   // body carries ONLY {denomAtomic,keysetId,secret,C} — never r
```
`meltToBlindVouchers` MUST (a) verify manifest signatures + recompute keysetIds via `discoverMint`; (b) `verifyDleq` every returned signature and, on any failure, throw and KEEP the pending record (do not finalize — the payer's funds remain recoverable, and against an honest server step 4/§2.4 guarantees no debit occurred); (c) construct each stored `BlindVoucher` with `r` + `dleq` for offline transfer (M9). `redeemBlindVouchers` MUST strip `r`/`dleq` from the wire body (M9/M10).

### 2.8 `src/node/blindVoucherWalletFile.ts` (Node-only `VoucherWallet`)
Reuses `EncryptedJsonFile` (Node) with `{ failClosed: true }` and a **separate** high-entropy 32-byte wallet key (NOT the ledger/data key). Serializes all mutations through an internal promise queue; `finalize` is a single atomic write. Documented: **deleting or corrupting this file permanently destroys the vouchers' value** (bearer instrument). Never logs secrets/`r`/vouchers.

---

## 3. Wire schemas

### 3.1 `GET /private/a2a/mint-keys?network=base` → 200
```json
{
  "network": "base",
  "asset": "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "mintIdentityPubKey": "0x02f0…33 bytes",
  "checkpoint": { "headSeq": 4, "headEntryHash": "0x…32", "signature": "0x…" },
  "manifest": [
    { "entry": { "seq": 4, "asset": "base:0x8335…", "epoch": 2, "keysetId": "0x…64hex",
                 "denominations": [ { "denomAtomic": "100000", "K": "0x02…" }, { "denomAtomic": "1000000", "K": "0x03…" },
                                    { "denomAtomic": "10000000", "K": "0x02…" }, { "denomAtomic": "100000000", "K": "0x03…" } ],
                 "activatesAt": 1770000000, "redeemUntil": null, "prevEntryHash": "0x…32" },
      "entryHash": "0x…32", "signature": "0x…" }
  ],
  "keysets": [ { "keysetId": "0x…64", "asset": "base:0x8335…", "epoch": 2, "status": "active",
                 "activatesAt": 1770000000, "redeemUntil": null,
                 "denominations": [ { "denomAtomic": "100000", "K": "0x02…" }, … ] } ]
}
```
Secret `k` NEVER appears. Retired/frozen (in-policy) keysets are included so bearers can still redeem/roll over. Clients recompute each `keysetId` and verify `checkpoint`/`manifest` signatures against the **pinned** `mintIdentityPubKey`.

### 3.2 `POST /private/a2a/voucher-issue` → 201
Request: `{ payerAgentId, network, keysetId, totalAtomic, outputs:[{denomAtomic,B_}], intentNonce, agentSignature, requestRef? }`
Response: `{ "result": { "keysetId":"0x…64", "signatures":[ { "denomAtomic":"1000000","C_":"0x02…","dleq":{"e":"0x…","s":"0x…"} }, … ] } }`

### 3.3 `POST /private/a2a/voucher-redeem` → 201 (bearer; single keysetId; NO r)
Request: `{ network, recipientAgentId, keysetId, proofs:[{denomAtomic,secret,C}, …] }`
Response: `{ "result": { "status":"redeemed", "valueAtomic":"2000000" } }`
Errors: `400 {"error":"double_spend"}`, `400 {"error":"invalid voucher proof"}`, `400 {"error":"multiple keysets in one redeem"}` — all no-state-change.

### 3.4 Client wallet at rest (AES-256-GCM, separate 32-byte wallet key, failClosed)
```json
{ "version": 1,
  "pending": [ { "fingerprint":"0x…","asset":"base:0x8335…","keysetId":"0x…64","createdAt":1770,
                 "contexts":[ {"denomAtomic":"1000000","secret":"0x…32","r":"0x…32","B_":"0x02…"} ] } ],
  "vouchers": [ { "id":"vch_…","asset":"base:0x8335…","keysetId":"0x…64","denomAtomic":"1000000",
                  "secret":"0x…32","C":"0x02…","r":"0x…32","dleq":{"e":"0x…","s":"0x…"} } ] }
```

### 3.5 Server keyset store (`data/blind-voucher-keysets.json`, encrypted, failClosed)
`{ "version":1, "mintIdentityKeyFingerprint":"0x…", "manifestByAsset": { "<asset>": SignedManifestEntry[] }, "keysets": MintKeyset[] }` — `MintKeyset.denominations[].k` is the SECRET scalar, only ever inside this ciphertext.

### 3.6 Server nullifier store (`data/blind-voucher-nullifiers.json`, encrypted, failClosed)
`{ "version":1, "spent": { "<keysetId>": { "<nullifierHex>": "<redeemKey>" } } }` — partitioned by keyset for O(1) lookup and prune-on-erase.

---

## 4. Cryptographic spec (precise, choices pinned)

`G = ProjectivePoint.BASE`; `n = secp256k1.CURVE.n`; points compressed via `"0x"+p.toHex(true)` (33 bytes); scalars 32-byte BE `0x`-hex reduced mod `n`.

### 4.1 hashToCurve — Cashu NUT-00 (PINNED)
```
DOMAIN = toUtf8Bytes("Secp256k1_HashToCurve_Cashu_")
hashToCurve(secretBytes):
  msg = getBytes(sha256(concat([DOMAIN, secretBytes])))
  for counter in 0 .. 65535:
    cand = getBytes(sha256(concat([msg, uint32LE(counter)])))
    try: return ProjectivePoint.fromHex(concat([Uint8Array.of(0x02), cand]))   // even-Y compressed
    catch: continue
  throw "hashToCurve exhausted"
```
Variable-time loop is acceptable: the secret is public at redemption and the loop count leaks nothing about a melt (Codex claim #3). Per-request output/proof caps (M12) bound worst-case work.

**Pinned KATs (assert in smoke; counters 0, 3, 3):**
| input (32-byte) | output (compressed) | counter |
|---|---|---|
| `00…00` | `0x024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725` | 0 |
| `00…01` | `0x022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf` | 3 |
| `00…02` | `0x026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f` | 3 |

### 4.2 BDHKE
- key: `k = randomScalar()` (nonzero); `K = G.multiply(k)`.
- blind: `x = randomSecret()`; `Y = hashToCurve(getBytes(x))`; `r = randomScalar()`; `B_ = Y.add(G.multiply(r))`.
- sign: `C_ = pointFrom(B_).multiply(k)` (deterministic).
- unblind: `C = pointFrom(C_).subtract(pointFrom(K).multiply(r)) = k·Y`.
- redeem verify: `hashToCurve(getBytes(x)).multiply(k).equals(pointFrom(C))`.
Correctness `C_ − rK = k(Y+rG) − rkG = kY`. ∎ (Codex probed installed lib — passed.)

### 4.3 DLEQ (Chaum–Pedersen) — proves `K=kG ∧ C_=kB_`
```
challenge(R1,R2,K,C_) = scalarFromBytes( sha256( concat([ toUtf8Bytes("px402-blind-voucher/dleq/v1"), 0x00,
                                     compressed(R1),compressed(R2),compressed(K),compressed(C_) ]) ) )
proveDleq(B_,C_,k,K): w = dleqNonce(k,B_,C_,K) (§4.6); R1=G·w; R2=B_·w; e=challenge(R1,R2,K,C_); s=modN(w+e·k); return {e,s}
verifyDleq(B_,C_,K,{e,s}): try { R1=G·s − K·e; R2=B_·s − C_·e; return challenge(R1,R2,K,C_)==e } catch { return false }
```
Client verifies every issued signature (defeats honest per-denom key bugs; combined with the manifest, defeats equivocation across non-isolated clients). **Transferable check (M9):** a receiver with `{secret,C,r,{e,s}}` + committed `K` computes `B_ = hashToCurve(secret).add(G·r)`, `C_ = C.add(K·r)`, then `verifyDleq(B_,C_,K,{e,s})` — offline, `r` never leaves the holder.

### 4.4 keysetId — FULL 32-byte digest (M8)
`computeKeysetId = sha256( lp(toUtf8Bytes("px402-blind-voucher/keyset/v1")) ‖ lp(asset) ‖ lp(uint64(epoch)) ‖ lp( Σ sorted-by-denom [ lp(denomAtomic) ‖ lp(K) ] ) )` → `0x`+64 hex. No short form. `lp(x)=uint32BE(len(x))‖x` (§4.8).

### 4.5 nullifier
`nullifierOf(x) = sha256( concat([ toUtf8Bytes("px402-blind-voucher/nullifier/v1"), getBytes(x) ]) )`.

### 4.6 Deterministic DLEQ nonce (MINOR 14 — adopted)
`dleqNonce(k,B_,C_,K)`: for `counter=0…`: `v = scalarFromBytes( sha256( lp("…/dleq-nonce/v1") ‖ lp(k_bytes) ‖ lp(B_) ‖ lp(C_) ‖ lp(K) ‖ lp(uint32BE(counter)) ) )`; return first `v` with `1 ≤ v < n`. RFC-6979-spirit: nonce is a deterministic function of `(k, transcript)`, so it never repeats for distinct transcripts and cannot be weakened by a poor RNG (Schnorr nonce reuse across messages leaks `k`).

### 4.7 Nonzero scalar discipline (MINOR 13 — `multiply(0n)` throws)
`randomScalar()` rejection-samples `randomBytes(32) mod n` until `∈[1,n-1]`. `k` from `secp256k1.utils.randomSecretKey()` (already `[1,n-1]`). `r`, DLEQ `w`: nonzero by construction/rejection. If `s = modN(w+e·k) == 0` (astronomically rare) → re-derive `w` at next counter. `verifyDleq`/`verifyRedeemProof`/`verifyTransferredVoucher` wrap point ops in try/catch → `false` on any throw (covers `e`/`s`≡0 and off-curve inputs).

### 4.8 Canonical encodings (M8/M12 — length-prefixed + domain-separated everywhere)
`lp(x)=uint32BE(x.length)‖x`. `meltFingerprint = sha256( lp("…/melt/v1") ‖ lp(asset) ‖ lp(keysetId) ‖ lp(uint64(total)) ‖ lp( Σ sorted-by-(denom,B_) [ lp(denomAtomic) ‖ lp(B_) ] ) )`. `redeemKeyOf = sha256( lp("…/redeem/v1") ‖ lp(asset) ‖ lp(recipientAgentId) ‖ lp(keysetId) ‖ lp( Σ sorted-by-(denom,nullifier) [ lp(denomAtomic) ‖ lp(nullifier) ] ) )` — includes asset + keysetId + denom so a secret valid under two keysets can't collide tombstones (M8).

### 4.9 Manifest signing
Mint identity = secp256k1. `entryHash = sha256(lp("…/manifest-entry/v1") ‖ lp(uint64(seq)) ‖ lp(asset) ‖ lp(uint64(epoch)) ‖ lp(keysetId) ‖ lp(Σ denoms) ‖ lp(uint64(activatesAt)) ‖ lp(redeemUntil ?? 0xFFFF…) ‖ lp(prevEntryHash))`. `signature = secp256k1.sign(entryHash, mintIdentityKey)`. `checkpoint.signature = secp256k1.sign(sha256(lp("…/checkpoint/v1") ‖ lp(uint64(headSeq)) ‖ lp(headEntryHash)), mintIdentityKey)`. Verify with `secp256k1.verify` against the pinned pubkey.

### 4.10 Test-vector strategy
hashToCurve: 3 external NUT-00 KATs (§4.1). BDHKE: per denom `sign→unblind→verifyRedeemProof` true; tamper `C`→false. DLEQ: prove→verify true; flip `e/s/C_`→false; **tagging mutant** (sign with `k'≠k`, attach real `K`)→false. Transferable: `verifyTransferredVoucher` true; wrong `r`→false. keysetId/fingerprint/redeemKey: deterministic + collision checks. Manifest: valid→verify true; tamper entry/sig→false; two divergent checkpoints→`assertCheckpointAgreement` throws.

---

## 5. Ledger accounting + conservation (per-keyset, B3)

| Op | Debit (−) | Credit (+) | Δsum | Idempotency (partitioned by keysetId) |
|---|---|---|---|---|
| melt `A` | agent | `vouchers:<asset>:<keysetId>` | 0 | `voucher-melt:<meltFingerprint>` |
| redeem `A` | `vouchers:<asset>:<keysetId>` | recipient | 0 | `voucher-redeem:<redeemKey>` |
| reclaim retired `A` | `vouchers:<asset>:<keysetId>` | `escrow:<asset>` | 0 | (retirement timer; `A` = exact frozen liability) |
| (existing deposit / transfer / payout) | — | — | 0 | (unchanged) |

**Conservation invariant — form UNCHANGED.** For each asset key `network:token`: `Σ over ALL account labels (agents ∪ {escrow:<asset>} ∪ {vouchers:<asset>:<keysetId> ∀ keysetId}) availableAtomic == 0`. Each `vouchers:<asset>:<keysetId>` is a pseudonymous account label HMAC-derived by `accountId()`; its inner asset-map key remains `network:token`, so `assertState`'s `":"`-check and `totalBalance` zero-sum apply automatically (Codex claim #5). `assertState` gains ONLY a validator for `consumedVoucherRefs` shape (M11).

**Retirement/erasure (B3, safe):** rotate → prev keyset `active→retired` (no longer signable; still redeemable). A key is erased ONLY when its per-keyset liability is provably 0: either (a) natural — all vouchers redeemed (default `redeemUntil:null` ⇒ redeem indefinitely, keys live until liability hits 0); or (b) committed expiry — `redeemUntil` was published in the manifest BEFORE issuance; the timer FREEZES the keyset at `redeemUntil` (refuses new redeems), so its per-keyset liability is now final and exact; `ledger.reclaimRetiredKeyset` sweeps that EXACT balance to escrow → liability 0 → `mint.eraseKeyset` erases keys THEN prunes nullifiers/tombstones (M5 ordering). No arbitrary-amount sweep exists.

---

## 6. Config + env vars

`config.ts` under `agentRpc`:
```ts
blindVouchersEnabled: process.env.PX402_BLIND_VOUCHERS_ENABLED === "true",
blindVoucherDenominationsAtomic: parseDenoms(process.env.PX402_BLIND_VOUCHER_DENOMINATIONS) ?? ["100000","1000000","10000000","100000000"],
blindVoucherKeysetGraceMs: parseSafeMs(process.env.PX402_BLIND_VOUCHER_KEYSET_GRACE_MS, 1000*60*60*24*7),   // finite, ≥0, ≤ 1yr
blindVoucherMintIdentityKey: process.env.PX402_BLIND_VOUCHER_MINT_IDENTITY_KEY,   // required when enabled
blindVoucherMaxOutputsPerRequest: Number(process.env.PX402_BLIND_VOUCHER_MAX_OUTPUTS ?? 64),
blindVoucherMaxProofsPerRequest: Number(process.env.PX402_BLIND_VOUCHER_MAX_PROOFS ?? 64),
```
`parseDenoms` (M12): `JSON.parse` → array; each value canonicalized `BigInt(v).toString()` (rejects `"01"` vs `"1"` divergence); reject non-integer, `≤0`, duplicates (post-canonical), and magnitudes `> 10n**18n`; sort ascending; require ≥1 entry. `parseSafeMs`: reject `NaN`/`Infinity`/negative/`>` bound. `index.ts` throws when `blindVouchersEnabled` and (`!privatePaymentLedger` or `!blindVoucherMintIdentityKey` or `!encryptionKey`).

CLAUDE.md "Environment Variables":
- `PX402_BLIND_VOUCHERS_ENABLED` — enable Chaumian blind-signature vouchers over the private ledger. Requires `PX402_PRIVATE_LEDGER_ENABLED=true`, `PX402_DATA_ENCRYPTION_KEY`, and `PX402_BLIND_VOUCHER_MINT_IDENTITY_KEY`. Default `false`.
- `PX402_BLIND_VOUCHER_MINT_IDENTITY_KEY` — server-only secp256k1 private key that signs the append-only keyset manifest. Its public key is the trust anchor agents must pin out-of-band (alongside their WireGuard config). Never exposed to clients.
- `PX402_BLIND_VOUCHER_DENOMINATIONS` — optional JSON array of atomic denomination values (default `["100000","1000000","10000000","100000000"]`; canonicalized, dedup-checked).
- `PX402_BLIND_VOUCHER_KEYSET_GRACE_MS` — advisory retire→freeze window when a keyset publishes a `redeemUntil`; validated finite/≥0/≤1yr. Default 7 days. With the default `redeemUntil:null` policy keys are never force-erased while liability is nonzero.
- `PX402_BLIND_VOUCHER_MAX_OUTPUTS` / `_MAX_PROOFS` — per-request caps (default 64) bounding curve work + encrypted-file rewrite size.
- Mint stores `data/blind-voucher-keysets.json` / `data/blind-voucher-nullifiers.json` are AES-256-GCM, durable (NOT tmpfs — they back live liabilities), `failClosed`.

---

## 7. Falsification smoke suite — `scripts/blind-voucher-smoke.mjs` (M7)

Conventions per `scripts/private-ledger-smoke.mjs` (tsx, `.ts` imports, `ok(cond,msg)`, `mkdtemp`, real `createPrivateAgentServer`, `finally` cleanup, `process.exitCode`). Wire a real `BlindVoucherMint` into registry + server; a Node `blindVoucherWalletFile` per agent. **Secret hygiene:** the harness NEVER prints voucher `secret`/`r`/bodies; leak checks scan durable files + captured logs for planted **canary** strings only.

Distinguish **algebraic** tests (pure crypto) from **data-flow** tests (implementation leakage):
1. **Algebraic:** hashToCurve 3 KATs (counters 0,3,3); BDHKE round-trip per denom; DLEQ prove/verify + tampers; **tagging mutant** (`k'`+real `K` ⇒ verifyDleq false); transferable-voucher offline verify + wrong-`r`; keysetId/fingerprint/redeemKey determinism + cross-keyset non-collision; manifest sign/verify + tamper.
2. **Issue/redeem round-trip:** melt 3×1.0 (funded payer) → `agent==0`, `voucherLiability(asset,ks)=="3000000"`; redeem crediting payee → payee `+3000000`, liability `0`, global conservation holds.
3. **Unlinkability data-flow (replaces v1 transcript scan):** two SAME-denomination melts from **different** agents, then **permuted** redemptions to two recipients; assert the server cannot reconstruct the melt→redeem mapping from any durable record — i.e. planted canaries tying a melt to its redeem never co-occur in `keysets`/`nullifiers`/ledger files or captured logs. (Shared `network`/`keysetId`/`denom` are EXPECTED and are NOT identifiers of a specific melt.)
4. **Equivocation (B1):** a malicious-discovery double returns two DIFFERENT valid keysets to two clients; `assertCheckpointAgreement` throws (mismatched checkpoint); a manifest-signature tamper is rejected by `verifyManifestEntry`.
5. **Serialized double-spend (B2):** barrier-launch two concurrent redeems of the SAME voucher set to DIFFERENT recipients → exactly one succeeds, the other throws `double_spend`, balances reflect one credit; the nullifier is reserved under the winner's redeemKey.
6. **Intra-request duplicate proof (B2):** a single redeem repeating the same proof twice is rejected (no double-count), no state change.
7. **Crash-idempotent issue via recovery (B4):** simulate a lost response — call `meltToBlindVouchers`, drop the response, then `recoverMelt(pending)` with a FRESH nonce; assert no double debit (`agent` balance moved once) and byte-identical `C_`. (A naive same-nonce retry is asserted to be REJECTED by `consumeNonce` — documenting the fix.)
8. **Crash-idempotent redeem (B4):** redeem twice with identical proofs+recipient → second is a duplicate no-op (credited once); crash between nullifier-reserve and credit (inject) → retry completes the credit, no double-spend, no fund loss.
9. **Bad-DLEQ ⇒ payer NOT debited (B4):** a mint stub returns an invalid DLEQ; server-side self-verify throws before debit; assert payer balance unchanged and no liability created; client keeps pending.
10. **Retirement safety (B3):** rotate; a voucher from the retired (still-redeemable) keyset redeems; with a committed `redeemUntil`, `freezeExpiredKeysets` freezes it, `reclaimRetiredKeyset` sweeps the EXACT per-keyset liability to escrow (conservation holds), THEN `eraseKeyset` erases keys+prunes nullifiers; a post-erase proof from that keyset fails; assert no key is erased while liability > 0.
11. **Fail-closed stores (M5):** wrong key, truncated file, bad auth tag, malformed decrypted JSON on each of keyset/nullifier/wallet stores → throws, never regenerates state (no `ENOENT` fallback).
12. **Membership vs identity (M8):** redeem from an unregistered IP rejected; redeem from a registered peer with NO identity signature succeeds.
13. **Config/limits (M12):** `parseDenoms(["01","1"])` rejects dup; melt of `150000` (0.15) throws "not exactly representable"; a request exceeding `maxOutputs`/`maxProofs` is rejected.
14. **Growth/load (M11):** N melt+redeem cycles across a keyset then `eraseKeyset` prunes that keyset's `consumedVoucherRefs` partition to empty; assert tombstone store does not retain erased-keyset entries.
15. **Meta-test (M7):** a harness that INJECTS each linkage/leak (per-payer keyset, `r=0`, exposed `r` in redeem body, persisted `B_→payer` map, canary in a log) and asserts the corresponding falsification test FAILS — proving the suite actually catches each leak.

---

## 8. Docs + honest privacy statement (M6 — rewritten to the project's honesty bar)

Update `CLAUDE.md` (env §6 + Systems bullet), `README.md` (agent-POV melt→transfer→redeem), `VERIFICATION.md` (`npm run test:blind-vouchers`; stores durable+encrypted+failClosed).

**Privacy statement (verbatim):**
*Removed:* any **direct cryptographic or protocol identifier** linking a melt to the redemption(s) of the vouchers it produced. Blinding hides `Y`/`C` at issue (the server sees only `B'`, returns `C'=k·B'`); at redeem it sees unblinded `(x,C)` unlinkable to any `B'`. A signed append-only manifest + full 32-byte keyset digests + cross-peer checkpoint comparison stop the server re-linking via a per-client keyset (equivocation), *for clients that compare checkpoints*.
*NOT removed — statistical correlation, which may be decisive at current user counts:* the server still observes the melt total + denomination histogram + melting agent identity; the redeem total + denomination histogram + credited account + redeemer VPN IP; both timings; keyset/epoch; and the set of outstanding vs already-redeemed proofs. **The effective anonymity set is not "every agent using the keyset" — it is approximately the outstanding, indistinguishable proofs for the same `(keyset, denomination)`, further reduced by joint amount/timing information; if only one matching-denomination voucher is outstanding, that set is one.** We therefore do NOT claim the server "does not learn" who funded a redeem — only that no direct identifier links the two events; inference remains possible. Splitting redemptions across time can reduce correlation but *distinctive* splitting is itself a fingerprint and is not claimed to collapse the residual to timing+IP.
*Equivocation residual (B1, honest):* without an external transparency log or peer gossip, two fully isolated clients that never compare checkpoints can each be shown a consistent-but-different manifest. Cross-client checkpoint comparison over WireGuard is the shippable mitigation; a witnessed transparency log is an open question.
*Trust model unchanged:* the server already custodies the pool and sees deposits/pool-payouts on-chain; blind vouchers add no trust assumption and remove one linkage class. A malicious custodian can still refuse service or grief (e.g. debit then withhold a valid signature) — no worse than its existing power to freeze the pool.

---

## 9. Rollout — feature flag, default OFF
`PX402_BLIND_VOUCHERS_ENABLED=false` default: mint never constructed, `registry.mint===undefined`, three routes `503`, zero change to existing rails. Requires the private ledger + encryption key + mint identity key (fail-closed at startup). Additive ledger field (`consumedVoucherRefs`) ⇒ existing v3 ledgers load unchanged (no migration, `version===3` asserts stay green). No on-chain component, no settler key, no new external calls. First rollout: enable flag → `test:blind-vouchers` → staging agent loop reconciling every `vouchers:<asset>:<keysetId>` to 0 after redemptions.

---

## 10. Open questions
1. **Transparency log / gossip (B1 residual).** Cross-peer checkpoint comparison is the shippable equivocation defence; a witnessed append-only log (or Merkle-consistency proofs between checkpoints, or posting the checkpoint to the existing `PX402BatchCommitment` contract) would close the isolated-client gap. Which, and is on-chain checkpoint posting worth the metadata leak?
2. **Tombstone indexing at scale (M11).** Partition-by-keyset + prune-on-erase bounds growth per keyset; a keyset that never fully redeems (default `redeemUntil:null`) accumulates indefinitely. Move to an append-only encrypted index or enforce a max-lifetime `redeemUntil` policy?
3. **Pool-payout redeem destination.** Should `voucher-redeem` optionally pay a one-time stealth external recipient from the pool (compose with `payoutFromLedger`)? Deferred — re-adds the pool-payout crash window + a stealth ephemeralPubKey on the redeem path.
4. **Denomination set.** `{0.1,1,10,100}` can't represent sub-0.1 / non-multiples and yields large counts; powers-of-two (Cashu default) give exact arbitrary amounts at a finer bit-histogram leak. Cross-spec decision with the denominations spec.
5. **Cross-asset vouchers.** v1 keysets are per-asset; a voucher redeems only on its asset. Confirmed correct; flag if "swap at redeem" is ever wanted.
6. **Mint identity key rotation.** Rotating `MINT_IDENTITY_KEY` invalidates pinned trust anchors; needs a signed hand-off entry (old key signs the new key's introduction). Spec if operationally required.

---

## 11. Critique responses

Legend: **FIXED** (adopted, evidence cited) / **REBUTTED** (with evidence) / **DEFERRED** (open question). I re-verified every code citation.

**B1 (mint equivocation)** — FIXED. Verified: v1 §4.4 keysetId was deterministic-from-keys but proved nothing about *other* clients' keys; a per-client keyset + valid DLEQ + recognizable id re-links melt↔redeem. Adopted the signed append-only manifest under a stable mint identity key (`§2.1 ManifestEntry/SignedManifestEntry/Checkpoint`, `§4.9`), full 32-byte keyset digest as canonical id (`§4.4`), client checkpoint verification + cross-peer `assertCheckpointAgreement` (`§2.7`), exactly-one-active-keyset-per-(asset,epoch) (`rotateKeyset` §2.2), equivocation + signature-tamper tests (§7.4). Honest isolated-client residual stated (§8) and full transparency log deferred (§10.1).

**B2 (nullifier reservation not serialized; intra-request dup double-credit)** — FIXED. Verified: `EncryptedJsonFile.write` is temp-file+rename with **no lock** (`EncryptedJsonFile.ts:41-48`); the ledger uses `writeQueue`/`serialize()` for exactly this (`PrivatePaymentLedger.ts:161,615-618`); v1's mint had no equivalent, and value summed per-proof against a per-nullifier map would double-count a repeated proof. `verifyAndReserveNullifiers` now runs in a mint-wide `serialize()` critical section, computes ALL nullifiers first, rejects intra-request duplicates before valuation, is all-or-nothing on mixed spent/unspent, clone+rollback on persist failure (§2.2, §0.8); barrier + duplicate-proof tests (§7.5-6).

**B3 (time-based erasure destroys live vouchers; aggregate sweep unauditable)** — FIXED. Verified: v1 allowed signing under retired-in-grace keysets, wall-clock erasure, a single `vouchers:<asset>` bucket, and an arbitrary-amount sweep — a melt-just-before-expiry dies, and the server can't compute an erased keyset's share. Now: per-keyset `vouchers:<asset>:<keysetId>` (Codex claim #5 confirms invariant unchanged), **sign only under active keysets** (§2.4 step 2), **never erase while liability ≠ 0** (§5), retirement policy published in the manifest before issuance, and `reclaimRetiredKeyset` sweeps the EXACT frozen per-keyset liability (no arbitrary amount) — `sweepDeadVouchers` deleted. `PublicKeyset` now exposes `activatesAt/retiredAt/redeemUntil/status` (§2.2).

**B4 (issuance not crash-safe; impossible client persistence; nonce-retry conflict)** — FIXED. Verified: `consumeNonce` throws on a repeated nonce **before** ledger idempotency (`PrivateAgentRegistry.ts:860-865`), so v1's §7.7 same-nonce retry could not pass — corrected to a fresh-nonce `recoverMelt` (§2.7, §7.7). Server computes signatures + **self-verifies DLEQ in memory before** the debit and returns only after it (§2.4); client persists a pending `{x,r,B_,keysetId,fingerprint}` record BEFORE submitting via the injected `VoucherWallet` and finalizes atomically (§2.7, §3.4); fault-injection at every step + bad-DLEQ-not-debited test (§7.7-9).

**M5 (fail-closed + two-file retirement ordering)** — FIXED. Verified: `EncryptedJsonFile.read` returns the fallback on auth/decrypt/JSON/IO errors unless `{failClosed:true}` (`EncryptedJsonFile.ts:26-37`), which the ledger passes (`:174`). All three stores mandate `failClosed` + decrypted-schema validation (§2.2/§2.8/§0.9); retirement erases keys **then** prunes nullifiers (§5, `eraseKeyset`); fail-closed corruption tests (§7.11).

**M6 (privacy overclaim)** — FIXED. Rewrote §8 to "no direct cryptographic or protocol identifier," anonymity set characterized per outstanding `(keyset,denomination)` proof, "set of one" case stated, splitting-is-a-fingerprint caveat, custodian-grief acknowledged.

**M7 (test is theater)** — FIXED. Replaced the transcript scan with the falsification suite (§7): permuted-redemption unlinkability, equivocation, serialized double-spend, duplicate-proof, crash-injection, bad-DLEQ, retirement-with-live-liability, fail-closed, growth, and a **meta-test** that injects each leak and proves the suite catches it. Algebraic vs data-flow tests separated.

**M8 (non-canonical redeemKey; short id)** — FIXED. Full 32-byte keyset digest everywhere (§4.4, no short form); length-prefixed domain-separated `redeemKeyOf` includes version+asset+recipient+keysetId+sorted `(denom,nullifier)` (§4.8); single-keyset-per-redeem enforced (§2.4) so the cross-keyset tombstone-collision path is closed.

**M9 (receiver can't verify offline)** — FIXED. `BlindVoucher` retains `{r, dleq:{e,s}}`; `verifyTransferredVoucher` reconstructs `B_`/`C_` and verifies against committed `K` (§2.1, §4.3); redeem body carries only `{denomAtomic,keysetId,secret,C}` so `r` never reaches the server (§2.7, §3.3).

**M10 (wallet placement/loss/secret handling)** — FIXED. Browser-safe crypto/RPC stay in `src/shared`; the `VoucherWallet` is an injected interface (§2.7); the Node fs implementation moves to `src/node/blindVoucherWalletFile.ts` with a separate 32-byte key, failClosed, serialized+atomic writes, wallet-loss=value-loss documented, secret/`r`/body logging banned + redaction test (§2.8, §7 hygiene note).

**M11 (schema validation; tombstone growth)** — FIXED. `assertState` validates `consumedVoucherRefs` (§2.3); tombstones partitioned by keysetId with O(1) in-memory sets, pruned on `eraseKeyset`, growth/load test (§7.14). Note refined: the *conservation formula* is unchanged but `assertState` gains the new-field validator (matches Codex's precise wording).

**M12 (config/request limits)** — FIXED. Strict `parseDenoms` (canonical `BigInt().toString()`, reject dup/zero/neg/malformed/huge), `parseSafeMs` grace validation, per-request `maxOutputs`/`maxProofs` caps, client denominations derived from the committed keyset (§6, §2.4). 

**MINOR 13** — FIXED. §0.2 states noble's `hashToCurve` is a top-level export (we use our own Cashu impl regardless); `randomSecretKey()` used for `k`; `multiply(0n)` throw handled by nonzero discipline (§4.7); `hashToCurve`/`nullifierOf` pinned to `BytesLike` (§2.1); `toUtf8Bytes` added to imports (§2.1); KAT counters corrected to **0,3,3** (§4.1).

**MINOR 14** — FIXED. §5/§2.3 clarify the `vouchers:<asset>:<keysetId>` label is HMAC-derived by `accountId()` while the inner asset-map key stays `network:token` (matches `PrivatePaymentLedger.ts:625-667`); `mintManifest`/`issue`/`redeem` receive the resolved `token` from the route (§2.4-2.5); the three `version===3` asserts are at lines **272, 361, 411** (§1); deterministic rejection-sampled HMAC DLEQ nonce adopted with rationale (§4.6).

**Codex "verified correct" (1-13)** — retained unchanged: BDHKE/DLEQ algebra, KAT points, noble API surface, liability-bucket invariant, same-write tombstone atomicity, nullifier-before-credit ordering, denom-sum binding, journal exclusion, route style, 6-decimals, dry-safe rollout.
