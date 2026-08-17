# FROZEN SPEC v1 — Confidential x402 (`confidential` scheme, our facilitator, 3-chain parity)

Status: FROZEN v1. Drafted from two spikes that were **executed live on-chain**, not
reasoned about (§14). Every code claim in §0.1 was verified against the live tree or a
live RPC during drafting. Hand verbatim to an implementation agent. TypeScript strict,
never print secrets, match existing conventions.

Owner surfaces: `src/shared/x402.ts`, `src/shared/x402Solana.ts`, `src/shared/stealth*.ts`,
`src/server/rails/*`, `src/server/base/X402Facilitator.ts`, `src/server/payments/*`,
`contracts/`, `src/server/config.ts`.

---

## Thesis (binding — read before any code)

**Our privacy stack currently hides *who*. It does not hide *how much*. That gap is the
one remaining leak that no amount of crowd gets rid of.**

Everything in `spec-payout-concentration.md` and the pool-payout wave buys **graph**
privacy, and graph privacy is *crowd-dependent*: at `k_eff = 1` it buys nothing. At our
current user count it buys nothing. This spec adds the one privacy property that is
**crowd-free** — a confidential amount is confidential when you are the only user on the
system.

Three consequences shape the whole design:

1. **Amount privacy and graph privacy are orthogonal and must both ship.** Confidential
   amounts do not hide the edge. Stealth addresses and payer rotation do not hide the
   value. Neither subsumes the other; the composition is the product.
2. **Every confidential-token system on every chain publishes the edge.** Verified on both
   spikes (§0.1). `sender → receiver` is public on Merces; `sourceATA → destATA` is public
   on Token-2022. Anyone who tells you otherwise is selling a shielded pool, which is a
   different and much larger project (§12).
3. **Parity is a protocol property, not a mechanism property.** Solana has a native
   confidential primitive; Base and Robinhood Chain do not. The `confidential` scheme, its
   wire shape, capability advertisement, and API are **identical on all three from day
   one** — exactly as `exact` is today (EIP-3009 on EVM, `transferChecked` on Solana).
   The mechanism underneath differs per rail. Do not let mechanism asymmetry leak into the
   protocol.

---

## 0. Review record

### 0.1 Verified claims

Re-verified during drafting. EVM rows are from a live Base Sepolia RPC read this session;
Solana rows from the devnet run in §14.2.

| Claim | Evidence | Verdict |
|---|---|---|
| A confidential-token transfer **hides the amount** on EVM | queuing tx `0x761e6e88…` + settle tx `0x210e8370…`: padded-uint256, bare-hex, and ascii-decimal encodings of `1250000` all **absent** from both txs' calldata and every log; **no** `ERC-20 Transfer(value)` log emitted | CONFIRMED |
| …and **publishes sender and receiver in plaintext** | same tx, `transferFrom(sender, receiver, amountCommitment, beta, ciphertext, proof, nonce, deadline, signature)`; event `TransferFrom(actionIndex, sender, receiver)` | CONFIRMED — **the edge is public** |
| Our EIP-5564 one-time stealth address can **receive** a confidential balance | on-chain `receiver` == `0x3e385E0C5AfFbEE2E108f1A931D35b6250a178de` == our derived stealth address | CONFIRMED |
| …and **spend** it holding zero native gas | spend tx `0xd191697b…`, authorization `from` = the stealth address; the stealth EOA never sent a transaction | CONFIRMED — confidential `transferFrom` is EIP-712 signed, relayer broadcasts |
| Token-2022 confidential transfer **hides the amount** natively | devnet tx `2PmvfUqC…`; recipient plaintext `token.amount == 0n`; `137000000` as LE-u64 absent from the recipient account data **and** from all five transfer txs (904 B scanned on the main one) | CONFIRMED |
| A DKSAP one-time **stealth scalar can own and control** a Token-2022 confidential account | `configure-stealth-ct` `521tAtgm…` and `stealth-apply-pending` `3zzJt5FA…` both authorized by the raw scalar; pending → available moved | CONFIRMED |
| The confidential keys derive **from the stealth scalar with nothing extra transmitted** | `ElGamalKeypair.fromSignature(sign(scalar, ElGamalKeypair.signerMessage(stealthAddress‖mint)))`; both seed halves are public, so `R` alone suffices for the payee | CONFIRMED |
| Only the stealth-derived key decrypts the amount | negative control with an unrelated ElGamal/AE keypair fails to recover the value | CONFIRMED |
| The repo already has the raw-scalar Solana signer and DKSAP | `src/shared/stealthSolana.ts:101` `signSolanaWithScalar`, `:84` `recoverSolanaStealthScalar`, `:111` `publicKeyForSolanaScalar`, `:52` `deriveSolanaStealthAddress` | CONFIRMED — no new stealth crypto is needed |
| The x402 scheme is a **hard-coded literal** `"exact"` | `src/shared/x402.ts:126,152,196,237,267` | CONFIRMED — see B1 |
| `ChainRail.resolveRecipient` returns a **bare address** | `src/server/rails/ChainRail.ts:113` → `ChainRailRecipient` = `{ recipient, stealth? }` | CONFIRMED — see B2 |
| The inbox reaps a **confirmed-empty** dormant record | `InboundAnnouncementBook.ts` `observe()` sets `dormant` when `observedAmountAtomic === 0n` past `dormantMs`; `reap()` drops it when `confirmedEmpty && createdAt + dormantMs <= now` | CONFIRMED — see **B3, P0** |

### 0.2 Rejected designs (recorded so they are not re-proposed)

**R1 — Depend on TACEO's hosted facilitator.** Rejected on four independent grounds, any
one sufficient:
- Their **MPC network is the prover**. The npm client ships an ABI and calls out to hosted
  nodes; there is no self-hostable proving path. This is the actual lock-in, and it is not
  removable by redeploying a contract.
- On testnet `getMpcPublicKeys()` returns the **same BabyJubJub point three times** — the
  "3-party MPC" is 1-of-1 in practice. That is the same trust model as our own private
  ledger, with none of the control and an extra external dependency.
- **Base Sepolia only.** No Base mainnet, no Robinhood Chain, no Solana. Parity is
  impossible through them by construction.
- It publishes sender and receiver anyway (§0.1), so what we would be renting is *amount
  privacy alone* — the one part Solana gives us natively for free.

The spike stays in-tree as **evidence and a reference implementation** (§14.1). It must
never become a runtime dependency.

**R2 — Run our own trusted-setup ceremony.** A ceremony with one participant is a
ceremony whose trapdoor we hold. That is strictly worse than the custody we already
disclose, because it is a *silent* forgery capability rather than a disclosed one. Use a
universal/updatable setup over a public perpetual-powers-of-tau transcript (§6.3).

**R3 — Denomination-split confidential payouts.** The amount is already hidden; splitting
buys nothing and costs legs, gas, and a leg-count fingerprint. Denominations stay on the
`exact` rail only (§8.3).

**R4 — Manufacture decoy confidential transfers.** Same reason
`spec-payout-concentration.md` §0.2 rejected a churning note set: operator-relayed decoys
are intra-cluster and removable with a single predicate. Rejecting it again here because
confidential amounts make decoys *look* cheap — they are not, the edge still labels them.

**R5 — Issue our own mainnet Token-2022 confidential mint (house token, reserve-backed
or not).** Rejected by the maintainer (re-affirmed 2026-08-13; do not re-propose). Three
independent grounds. (1) *Capacity:* a reserve-backed house token caps confidential
volume at the reserve — a payment larger than the treasury lock is simply impossible,
and every confidential dollar costs us a locked dollar forever, which is the
zero-seed-capital rule (`spec-privacy-at-scale-one.md`) violated at the asset layer.
(2) *Boundary re-publication:* value enters and exits the house token by converting real
USDC in public transactions with visible amounts — the deposit/withdraw edges the
confidential rail exists to protect are exactly where the amounts reappear. (3) *Trust
collapse:* holding an operator-issued IOU requires trusting the operator precisely as
much as a private-ledger balance does, so the house mint is the ledger's trust model
plus the chain's costs and an issuer surface — a private stablecoin business, not
private x402. Consequence: the Solana confidential rail stays flag-off on mainnet until
the confidential token IS a real settlement asset (a major stablecoin shipping the
extension with a **null** auditor — noting §9's live-mint assertion will, by design,
refuse an auditor-keyed compliance variant). Crowd-free amount privacy meanwhile remains
delivered by the private ledger, which is total at N=1 and touches no chain.

### 0.3 Blockers — fix in this wave, in this order

- **B1 (blocks everything).** `scheme` is the literal `"exact"` in five places. It must
  become `X402Scheme = "exact" | "confidential"` as a discriminated union across
  requirements, payloads, and the verify path *before* any confidential code lands.
  Otherwise every new path is a cast and the compiler stops helping.
- **B2.** `ChainRail` has no confidential capability, and `resolveRecipient` returns a bare
  address. A confidential recipient is an address **plus** a rail-specific public
  encryption key. Widen `ChainRailRecipient`, do not overload `recipient`.
- **B3 — P0, fund loss. FIXED (`InboundAnnouncementBook`, `test:stealth:inbox` 20/20).** The
  guard landed ahead of the rail so no confidential receive path can ever race it.
  A confidential output's plaintext on-chain balance is **zero by
  construction** (§0.1, proven). Feed that into today's inbox and:
  `observe(id, 0n)` → `dormant` → `reap()` sees `confirmedEmpty` → **the record is
  deleted**. The record is the only copy of `R`. Without `R` the payee cannot derive the
  one-time key *or even locate the address*. Result: every confidential stealth output is
  permanently unspendable 24 h after it is created, silently. The `unexplained-drain`
  guard does **not** catch this — it only fires from `status === "observed"`, which
  requires a prior *nonzero* observation that a confidential output can never produce.
  This is the exact D1 failure `spec-stealth-inbox.md` exists to prevent, resurfacing
  through a new door. §8.1 is not optional and must land in the same commit as any
  confidential receive path.

---

## 1. Scope

**In:** a new x402 `confidential` scheme; a `ConfidentialRail` capability on all three
rails; the native Solana Token-2022 mechanism; a `PX402Confidential` contract for Base
and Robinhood Chain; our own `ConfidentialFacilitator`; the B3 inbox fix; composition
rules against every existing privacy wave; config, tests, and the honest statement.

**Out:** shielded pools / full sender-set anonymity (§12.1); off-chain change
(`spec-payout-offchain-change.md`); any change to the `exact` rail's on-chain behavior;
browser-side confidential UI (the Phase-4a inbox renders confidential outputs as
`amount: hidden`, nothing more).

**Non-goal:** hiding the edge. This spec does not claim to and must not be described as
though it does.

---

## 2. Privacy model (normative — this table is the contract)

Per payment, what each layer removes from a **public-chain observer**:

| Fact | `exact` today | `+ confidential` | Removed by | Crowd-dependent? |
|---|---|---|---|---|
| Amount | public | **hidden** | this spec | **no** |
| Receiver identity | hidden | hidden | EIP-5564 / DKSAP stealth | **no** |
| Sender identity | hidden | hidden | payer rotation, or the pool | **no** (rotation) / yes (pool) |
| The edge `sender → receiver` exists | public | **public** | nothing here | — |
| Deposit into the confidential balance | public amount | **public amount** | nothing here | — |
| Withdrawal out of it | public amount | **public amount** | nothing here | — |
| Which of N concurrent payouts is yours | `k_eff` | `k_eff` | concentration wave | **yes** |

Read the table honestly in both directions:

- At `k_eff = 1` — our real situation today — rows 1–3 still hold. **That is the point of
  this wave.** A lone user gets a hidden amount, an unlinkable receiver, and a rotated
  sender. What they do not get is deniability about *that a payment happened*.
- Rows 4–6 are the residual and they are unavoidable at this layer. The deposit/withdraw
  boundary is public on Merces, on Token-2022, and on every confidential-token design that
  is not a shielded pool. Do not paper over it.

---

## 3. Wire protocol — the `confidential` scheme (identical on all three rails)

### 3.1 Scheme union (B1)

```ts
export type X402Scheme = "exact" | "confidential";
```

`X402PaymentRequirements` and `X402PaymentPayload` (and their Solana twins) take
`scheme: X402Scheme`. Every existing constructor keeps emitting `"exact"`; nothing about
the `exact` wire changes. The verify path switches on `scheme` and refuses an unknown one
with the existing opaque error.

### 3.2 Capability advertisement

`X402TokenConfig` gains one optional field, resolved per network at startup:

```ts
confidential?: {
  mechanism: "token2022" | "px402-evm";
  asset: string;            // Token-2022 mint, or the PX402Confidential address
  decimals: number;
  mode: X402SettlementMode; // "dry-run" until a settler key + deployed asset exist
};
```

A quote advertises `confidential` in `accepts[]` **only** when the resolved rail reports
`mode !== undefined` and the payee endpoint carries a `stealthMeta`. Confidential without
stealth is a half-measure that publishes a persistent receiver, so it is refused at quote
time, not at pay time.

### 3.3 Quote → pay

Unchanged in shape from the `exact` private route: `POST /private/a2a/quote` issues a
one-shot nonce-keyed challenge with `payTo` forced to the payee; `POST /private/a2a/pay`
resolves the quote **by the payment's nonce** and routes by the **quote's** network and
scheme — never the payer's payload. That existing anti-redirect rule is load-bearing here
too: a payer must not be able to downgrade a `confidential` quote to `exact` and thereby
publish the amount. **Refuse on scheme mismatch.**

The payload's confidential body is rail-shaped and opaque to the router:

```ts
{ scheme: "confidential", network, payload: { recipient, ciphertext, proof, ...railFields } }
```

---

## 4. `ConfidentialRail` (extends `ChainRail`)

Optional capability, exactly like `relayDeposit` is today — a rail that does not implement
it is refused with a clear reason, not crashed.

```ts
export interface ConfidentialRecipient extends ChainRailRecipient {
  confidential?: { encryptionPubKey: string; accountExists: boolean };
}

export type ConfidentialObservation =
  | { kind: "plaintext"; amountAtomic: bigint }
  | { kind: "ciphertext-present" }   // an entry exists; value NOT knowable
  | { kind: "no-account" }           // provably nothing was ever created
  | { kind: "unknown" };             // RPC failure — never treat as empty

export interface ConfidentialRail {
  readonly confidentialMode: X402SettlementMode;
  resolveConfidentialRecipient(i): Promise<ConfidentialRecipient>;
  ensureConfidentialAccount(i): Promise<...>;   // idempotent
  verifyConfidential(i): Promise<...>;
  simulateConfidential(i): Promise<...>;        // never spends gas
  settleConfidential(i): Promise<ChainRailSettleResult>;
  observeConfidential(i): Promise<ConfidentialObservation>;
}
```

`observeConfidential` returning a **tri-state instead of a number** is the type-level fix
for B3. There is no encoding of "a confidential balance" as a `bigint` that is not a lie,
so the type must not offer one.

---

## 5. Solana mechanism — native Token-2022

> **CORRECTION 2026-07-30 — §5.2 as originally written is WRONG, and the §14.2 "proven"
> claim overstated what was proven.** The devnet spike ran payer and payee **in the same
> process**, which hid a key-availability problem that only exists in the real two-party
> topology. Recorded in full because the mistake is instructive: a proof whose topology
> differs from deployment is not a proof of deployment.
>
> **Measured fact** (`@solana/zk-sdk`, executed, not reasoned): a Solana ElGamal public key
> is `P = s⁻¹·H` on **Ristretto255**, where `H` is a fixed Pedersen generator — NOT the
> ed25519 basepoint. Verified two ways: `P ≠ s·G` and `P ≠ s⁻¹·G` on either curve, and
> `s₁·P₁ = s₂·P₂` for independent secrets, which pins the `s⁻¹·(fixed generator)` form
> without needing to know `H`.
>
> **Consequence.** The stealth address is `s·G` on ed25519. The ElGamal pubkey is `s⁻¹·H`.
> Recovering the second from the first is discrete-log hard, so **neither the payer nor the
> server can derive the recipient's ElGamal pubkey** — and the server structurally never
> can, because `s = kSpend + H(kView·R)` needs the SPENDING key and the server holds only
> the viewing key by design. A Token-2022 confidential transfer requires that pubkey to
> encrypt the amount to the destination.
>
> `ElGamalSecretKey.fromBytes` / `ElGamalPubkey.fromSecretKey` DO accept a raw 32-byte
> scalar and round-trip it exactly, so an arbitrary secret may be used — which is what
> makes §5.2-R below possible.

### 5.2-R Revised recipient-key construction (supersedes §5.2)

Options considered, with the reason each is or is not viable:

| Option | Verdict |
|---|---|
| Payee publishes `P` per payment | Works, but requires the payee's SPENDING key online at quote time. Today the server issues quotes on the payee's behalf holding only a viewing key, so this changes the availability and trust model. Rejected unless the others fail. |
| Long-lived `P` in endpoint registration | **Rejected.** Reused across payments ⇒ the same ElGamal pubkey appears on every payment to that payee ⇒ on-chain linkage, destroying exactly the property this wave buys. |
| Server holds a per-payee ElGamal secret | **Rejected.** Same reuse-linkage as above, and it makes the payee unable to spend without the server. |
| **Payer generates the ElGamal secret** | **Recommended.** |

**SUPERSEDED 2026-07-30 by an on-chain measurement — see §5.2-P below. Kept for the
reasoning trail.** ~~The payer generates a fresh random ElGamal secret `e` per
payment, computes `P = e⁻¹·H`, encrypts the amount to `P`, and delivers `e` to the payee
alongside the announcement `R` in the stealth inbox.

Why this is sound rather than a fudge:
- **Fresh per payment.** Each payment already goes to a fresh stealth address, hence a
  fresh confidential account. One account, one payment, one `e` — no cross-payment linkage.
- **The payer learns nothing new.** `e` decrypts only the account the payer just funded,
  whose amount the payer chose. It grants no visibility into any other payment or balance.
- **No new trust assumption.** `e` rides the same durable encrypted inbox that already
  carries `R`, and the server already sees request amounts as it processes them. This is
  the trust boundary §11 already states: confidential amounts hide value from **chain
  observers, never from the operator**.
- **The payee can still spend unilaterally**, holding `e` (from the inbox) and `s`
  (from their own spending key).

**Inbox consequence:** `e` is now load-bearing for spendability, exactly like `R`. It must
be write-ahead persisted with the announcement before any broadcast, and it falls under the
same B3 never-reap rule.

### 5.2-P Pre-generated one-time receive accounts (SUPERSEDES 5.2-R) — **PROVEN ON DEVNET**

> **Status: PROVEN 2026-07-30, two-party, 11/11.**
> `spikes/solana-confidential/two-party-devnet.ts` +
> `evidence/two-party-devnet-result.json`. Mint `Ha3XxvEW…w6Xy`.
> Isolation is structural, not by convention: `kSpend`/`kView` never leave the payee closure,
> and the payer's whole argument set is grepped for both scalars before it runs.
>
> 1. **Payee configures its own slot** — signed by the raw stealth scalar. (Control.)
> 2. **Payer's variant-B transfer LANDS** — 5 txs, all `err: null`,
>    `destinationElgamalPubkey` supplied and `destinationTokenAccount` absent. The payer
>    derived the destination ATA itself and it matched, so **variant B reads nothing from
>    the destination** — only its address.
> 3. **Amount absent from the entire plan** — 7,410 bytes across 10 blobs (locally-signed
>    wire *and* refetched from chain), three encodings, **0 hits**.
> 4. **Payee decrypts from `(R, kView, kSpend)` alone** — re-derives `s` and the ElGamal/AE
>    keys from scratch, recovers `137000000n`. Unrelated keys cannot. Spendability is real.
> 5. **A wrong `destinationElgamalPubkey` is REJECTED BY THE PROGRAM** —
>    `Error: ElGamal public key mismatch`, custom error `0x1a`. So funds cannot be
>    misdirected into ciphertext the owner cannot read; that failure mode does not exist.
>
> Independently re-verified on-chain by the integrator: destination plaintext
> `token.amount == 0n`, extension present, stored `elgamalPubkey` **is** the payee's
> published `P` (the rogue never took hold), `pendingBalanceCreditCounter == 1`.

**Two operational findings from that run, both binding on the rail:**

- **kit's thrown error DESTROYS the program error.** The real cause arrives as
  `cause: TypeError: Do not know how to serialize a BigInt`, because kit's formatter chokes
  on `{Custom: 26n}`. The wrapper message is useless. The rail MUST simulate each plan
  transaction itself and read `value.err` + `value.logs`, with a bigint-safe JSON replacer
  everywhere — a bare `JSON.stringify` on a rejected verdict throws and silently swallows
  the one verdict that matters. This is exactly what produced a false conclusion on an
  earlier probe in this repo.
- **A rejected transfer LEAKS RENT.** The proof-setup transactions succeed before the
  Transfer fails, so a failed payment leaves **3 proof-context accounts open** (8,539,920
  lamports, §5.4) and the plan's `CloseContextState` never runs. The rail must close them on
  the failure path or leak that on every failed payment.

- **Library trap:** an ElGamal secret is a Ristretto *scalar*, so an arbitrary 32-byte fill
  is out of range and `ElGamalSecretKey.fromBytes` throws `failed to deserialize secret key`.
  Go through `ElGamalKeypair.fromSeed()`, which reduces properly.



**Measured on devnet** (`spikes/solana-confidential/probe-third-party-configure.ts`): a
third party CANNOT configure a confidential account on the owner's behalf. The plan is
`CreateAssociatedTokenIdempotent → Reallocate → ConfigureConfidentialTransferAccount →
verifyPubkeyValidity`; the ATA creation is permissionless and succeeded, then the chain
rejected with **`Missing required signature for instruction (instruction #2)`**. Confirmed
by the library shape independently: `PubkeyValidityProofData` takes the *keypair*, not the
pubkey, and `decryptableZeroBalance` needs the owner's AE key.

So the payer cannot bootstrap the destination, and 5.2-R fails. The constraint is:

> **Only the owner of a one-time stealth address can enable confidential receiving on it.**

The naive consequence is a round trip per payment (payer sends `R`, payee configures and
returns `P`), which would require the payee's SPENDING key online at quote time — a real
regression, since today the server quotes holding only a viewing key.

**The fix inverts who picks `R`.** Nothing in DKSAP requires the *payer* to generate the
ephemeral key; it only requires that `R` be fresh per payment and that the payee can derive
`s = kSpend + H(kView·R)`. So the **payee** generates a batch of `R` values in advance,
derives its own one-time addresses, configures a confidential account for each (signing, as
it must), and registers the resulting **`(stealthAddress, R, P)` triples** as a pool of
one-time receive slots. The server hands out exactly one per payment and never reuses one.

| Property | Result |
|---|---|
| Round trips at payment time | **none** — the slot is already configured |
| Payee spending key online at payment time | **not needed** — only when replenishing |
| Address reuse / linkage | none; one slot per payment, same as today |
| Who holds the ElGamal secret | the payee alone (derived from its own `s`) |
| Payer needs | `(stealthAddress, P)` — and variant B takes `P` explicitly, no account fetch |

Costs, stated plainly: the payee pre-pays rent per slot (a confidential account is larger
than a plain ATA), and slot exhaustion is a liveness condition the registry must monitor and
surface. Both are ordinary engineering, unlike the interactivity they replace.

This is the standard pre-generated one-time-address pattern, and it fits the existing
architecture: the endpoint registration already carries payee-supplied stealth material, so
the pool is an extension of a channel that exists.

### 5.2-M Per-payment ElGamal keys from ONE published key (multiplicative DKSAP)

**Measured:** `s⁻¹` is multiplicatively homomorphic, so `pubkey(a·t) = t⁻¹·pubkey(a)`.
That means a payer can derive a fresh per-payment destination ElGamal pubkey from public
data alone, with zero interaction:

- The payee publishes **one** long-lived `E = ElGamalPubkey(kEG)` beside its stealth meta.
- The payer computes the **same DKSAP shared scalar it already computes for the address**,
  `t = H(r·Kview)`, then `E_t = t⁻¹·E`. Public-point arithmetic only — no spend key, no
  ElGamal secret, no round trip.
- The payee independently computes `t = H(kView·R)` and holds the matching secret `kEG·t`.

Verified end-to-end with the payer holding no payee secret: derived pubkeys match exactly,
encrypt/decrypt round-trips the amount, and two payments to the same payee produce
**different** pubkeys. So the "long-lived reused ElGamal key" option (rejected above for
re-linking every payment) is not forced on us: `E` is long-lived, but nothing on-chain is.

Under §5.2-P the payer could instead just read the pubkey off the pre-configured account,
so this is a **round-trip optimisation, not load-bearing**. Ship §5.2-P first; add this to
drop the destination-account RPC read.

### 5.4 Pool economics (computed from the packages' own codecs, §5.2-P)

Rent formula validated before use: `(128 + size) x 3480 x 2` reproduces the repo's known
plain-ATA constant `2,039,280` exactly. Sizes come from `getTokenSize()` and the
zk-elgamal-proof context-account size constants.

| account | bytes | lamports |
|---|---|---|
| legacy SPL token account | 165 | 2,039,280 |
| Token-2022 ATA (`ImmutableOwner` only) | 170 | **2,074,080** |
| **Token-2022 ATA + ConfidentialTransfer** | **469** | **4,155,120** (0.00415512 SOL) |

**A confidential slot costs ~2x a plain Token-2022 ATA.**

**Constant trap.** `2,039,280` is the **legacy** SPL figure. A Token-2022 account is never
that -- it always carries `ImmutableOwner`, so its floor is `2,074,080`. Reusing the legacy
constant for a Token-2022 account under-funds by 34,800 lamports. Not a live bug (nothing
in `src/` uses Token-2022 today, verified), but it is a wrong constant in a right-looking
place and confidential code must not inherit it.

**Rent is RECOVERABLE -- the pool is a float, not a per-payment cost.** `CloseAccount` takes
`destination` as a free parameter, so reclaimed rent routes straight back to the settler
even though `owner` is the stealth address. Path: `withdraw` (if non-empty) ->
`EmptyAccount` (proves the available ciphertext encrypts zero) -> `CloseAccount`.

Two conditions, both landing on the payee: `owner` must authorize the close (the stealth
scalar), and `EmptyAccount` needs the ElGamal **secret**. So **reclaim requires payee
cooperation, and an abandoned slot is rent the pool never recovers.** Size for an
abandonment rate.

**The float nobody budgets for.** A confidential *transfer* verifies three proofs through
context-state accounts, created and closed within the payment:

| proof | lamports |
|---|---|
| CiphertextCommitmentEquality | 2,011,440 |
| BatchedGroupedCiphertext3HandlesValidity | 3,570,480 |
| BatchedRangeProof | 2,958,000 |
| **held per CONCURRENT payment** | **8,539,920** (0.00853992 SOL) |

That is ~2x a slot's rent, transient, and it scales with **concurrency, not volume** -- the
settler must hold `0.00853992 x max_concurrent_payments` on top of the pool or payments fail
to fund their own proofs under load. This is the most likely production surprise in the
design. Provisioning itself needs no proof float: its pubkey-validity proof is inline,
not context-state.

Worked example -- 100 slots, 8 concurrent payments:
`0.415512` pool float + `0.068319` proof float = **0.483831 SOL** the settler must hold,
plus fees. Both recoverable.

**Free defence-in-depth: set `maximumPendingBalanceCreditCounter = 1`.** It defaults to
65,536 and is a per-account *input* at configure time. A one-payment slot takes the counter
0 -> 1, so the default is inert -- but pinning it to 1 makes each slot **structurally
single-use on-chain**, so a buggy server handing the same slot out twice is rejected by the
program rather than by our bookkeeping. Costs nothing.

**Provisioning is a two-signature ceremony.** The create plan takes `payer` and `owner`
separately, so the **settler funds the rent while authority stays with the payee** -- payees
are not forced to fund their own slots. But the payee must sign, so the server cannot
provision ahead of time alone: the payee comes online once and co-signs a batch. That
interactivity is unavoidable given the measured signature requirement, and batching is what
makes it acceptable.

**One ATA per `(owner, mint, program)`**, and the create helper hardcodes the ATA path. Our
design is safe -- N slots are N distinct stealth owners, hence N distinct ATAs -- but
multiple slots per owner would need non-ATA token accounts, which that helper will not build.

**Not determinable from types, flagged not estimated:** whether `CloseAccount` refuses while
the extension is still present, whether a non-zero *pending* balance blocks `EmptyAccount`
(these decide whether reclaim is 2 or 3 transactions), any program-level per-mint account
cap, transaction packing and therefore total fees, and compute-unit costs.

### 5.3 Toolchain constraints (measured on Node 22.23.2 and 24.17.0)

Non-obvious, and each one is a real failure mode rather than a preference:

- **`@solana/zk-sdk/bundler` EVERYWHERE. Never `/node`.** `token-2022/confidential`
  hard-codes the bundler subpath, so it loads regardless. Importing `/node` as well yields
  **two independent WASM instances** with separate classes and separate linear memory, and a
  cross-instance call **does not throw** — it reads the wrong heap and returns a plausible
  value. Silent corruption in a payment path.
- **`moduleResolution` must be `Bundler`** in both tsconfigs. `Node` cannot resolve
  exports-map-only subpaths (`@solana-program/token-2022/confidential`,
  `@solana/zk-sdk/bundler`) and the build fails with TS2307. Verified a no-op for existing
  sources: 0 errors under either setting, and the emitted client bundle hash is unchanged.
- **Keep every bundling step ESM.** `--format=cjs` fails on Node 22 with
  `ERR_INTERNAL_ASSERTION: WASM is currently unsupported by require(esm)` while working on
  Node 24 — i.e. local dev hides a production break.
- **No transfer-fee mints.** zk-sdk 0.4.2 ships no Pedersen arithmetic, so
  `getConfidentialTransferWithFeeInstructionPlan` throws at runtime. Fine for a mint we
  create; a hard constraint on mint selection.
- **Dependencies** (+58 MB, 58 packages): `@solana/kit`, `@solana/zk-sdk`,
  `@solana-program/token-2022`, `@solana-program/compute-budget`. Do **not** add
  `@solana-program/zk-elgamal-proof` — it arrives transitively and nothing imports it
  directly. Coexists cleanly with `@solana/web3.js` v1; `@noble/curves` dedupes to one
  hoisted copy, and kit's `findAssociatedTokenPda` is byte-identical to v1's
  `getAssociatedTokenAddressSync`.
- **Bundle guard extended** (7/7): the old guard filtered `*.js` only and was therefore
  structurally blind to the ~2.66 MB **separate `.wasm` asset** the bundler emits — the
  single largest thing a leak could ship, invisible while the build exits 0 and every other
  guard passes. PX-402 ships no browser bundler, so the guard itself lives downstream of
  this repo (§10).

**Still unverified, and blocking implementation:** (a) that
`getConfidentialTransferInstructionPlan` accepts an explicit destination ElGamal pubkey
rather than reading one off an already-configured destination account, and (b) whether the
settler can create and configure a confidential account on the stealth owner's behalf, or
whether the owner must sign. If (a) is false the destination must be configured before the
transfer, which reintroduces interactivity and the table above must be re-evaluated.

### 5.1 Mint policy and mechanics (unchanged, still valid)

1. **Mint policy.** `ConfidentialTransferMint` with `autoApproveNewAccounts: true` and
   **`auditorElgamalPubkey: null`**. A non-null auditor key is a universal decryption
   backdoor; it is forbidden by this spec and must be asserted at startup against the
   live mint, not assumed from config.
2. **Recipient keys.** Seed = `stealthAddress ‖ mint` (both public). The payee signs
   `ElGamalKeypair.signerMessage(seed)` and `AeKey.signerMessage(seed)` with the **raw
   one-time stealth scalar** via `signSolanaWithScalar`, then
   `ElGamalKeypair.fromSignature` / `AeKey.fromSignature`. Nothing beyond the existing
   announcement `R` is transmitted, and no long-lived key touches the wire.
3. **Account setup.** `getCreateConfidentialTransferAccountInstructionPlan` with the
   stealth scalar as `owner` and the **settler as fee payer** — the stealth address holds
   no SOL and never needs any.
4. **Transfer.** `getConfidentialTransferInstructionPlan`. It spans several transactions
   (proof-context setup, transfer, context close). Treat the whole plan as one logical
   payout in the outbox; partial completion must be recoverable, not re-signed.
5. **Receive.** Funds land in `pending`; the payee applies pending → available with
   `getApplyConfidentialPendingBalanceInstructionFromToken`, authorized by the raw scalar.

**Two hard-won toolchain facts — do not rediscover them:**
- Use `@solana-program/token-2022@^0.14` (`/confidential` subpath) + `@solana/zk-sdk@^0.4`
  (`/bundler`) + `@solana-program/zk-elgamal-proof@^0.3` + `@solana/kit@^7`.
  **`@solana/spl-token` is a dead end** for this — it exposes size constants only.
- **Do not add a compute-budget instruction to the transfer plan.** The batched range-proof
  instruction needs ~1071 free bytes; a compute-budget ix leaves 1056 and the planner
  silently cannot fit it. Default CU is sufficient.

---

## 6. EVM mechanism — `PX402Confidential` (Base + Robinhood Chain)

Neither chain has a native confidential primitive, so we deploy one. Same contract, same
bytecode, both chains — that is what makes parity real rather than aspirational.

### 6.1 Shape (mirrors what both spikes proved works)

| Op | Amount | Gas payer | Notes |
|---|---|---|---|
| `deposit(amount)` | **public** | depositor | pulls ERC-20 in; boundary is public by design |
| `transferFrom(...)` | **hidden** | **relayer** | EIP-712 signed by the sender; sender needs zero native gas |
| `withdraw(...)` | **public** | relayer | boundary again public |

The gasless `transferFrom` is not a convenience — it is what lets a one-time stealth
address with 0 ETH spend at all, proven by spend tx `0xd191697b…`. It also means the
existing `deposit-relay` EIP-3009 path is **not needed** on the confidential rail: gasless
spend is native to the contract. That is a strict simplification (§8.2).

### 6.2 Balance representation

ElGamal-encrypted balances on BabyJubJub, with a per-account commitment readable on-chain.
Note the observability consequence, which §4 already encodes: a commitment tells you an
account **has an entry**, never what it holds — including that a commitment to zero is
still a commitment. `observeConfidential` therefore returns `ciphertext-present`, never a
number.

### 6.3 Proving system

Groth16 over a **universal/updatable setup with a public perpetual-powers-of-tau
transcript**. Per R2, we run no ceremony of our own. Circuits: `transfer` (balance
conservation + range) and `withdraw` (opening correctness). Verifier contract generated,
not hand-written.

Budget honestly and state it to the user before starting: the spike's client-side proving
artifacts were **~5.8 MB** and payload construction took seconds, not milliseconds. This
is a real UX cost on the payer side and it does not shrink because we self-host.

### 6.4 Deployment gate

Startup binds the deployed address per network and asserts the on-chain verifying key
matches the committed artifact hash. **Mismatch throws.** A confidential contract with an
unverified VK is a contract that can mint.

---

## 7. Our facilitator

`ConfidentialFacilitator`, one instance per network, alongside `X402Facilitator` and
following its conventions exactly:

- `verify` → signature, proof, amount-commitment well-formedness, validity window, replay
  nonce. Off-chain, no RPC spend.
- `simulateSettle` → `eth_call` on EVM / `simulateTransaction` on Solana. **Always
  pre-flights before broadcast** so a doomed settle never wastes gas — same rule the
  `exact` path already follows.
- `settle` → broadcasts **only** when that network's settler key is configured; otherwise
  returns a clearly labelled dry-run. Default is dry-run on every rail.
- Every settler-EOA send goes through the existing transaction coordinator/outbox. A
  bypass corrupts the shared nonce pipeline; this is already true for payouts, x402
  settles, and batch commitments, and confidential settles are not an exception.

No hosted third party appears anywhere in this path. That is the requirement.

---

## 8. Composition with the existing waves

### 8.1 Stealth inbox — B3 fix (P0, same commit as any receive path)

**Status: DONE.** `InboundAnnouncementRecord.confidentiality` ships with `observe()` and
`reap()` both refusing to retire a confidential record, an unrecognised stored value failing
**safe** (treated as confidential ⇒ never reaped, never silently reapable), and four
regression tests. The rest of this section is the remaining rail-side wiring.

1. `InboundAnnouncementRecord` gains `confidentiality: "plain" | "confidential"`,
   defaulting to `"plain"` so existing records migrate untouched.
2. The refresh loop calls `observeConfidential` and stores a
   `ConfidentialObservation`, not a `bigint`.
3. **A `confidential` record may never enter `dormant` and may never be reaped by the
   dormancy path.** Only `swept` past retention may reap it. Rationale: dormancy means
   "provably holds nothing", and for a confidential output that proof does not exist.
4. `ciphertext-present` on a record previously seen present, now absent → `unexplained-drain`,
   sticky, never reaped — preserving the existing evidence rule.
5. `unknown` (RPC failure) is never a reap input. Already true in spirit; make it explicit.

### 8.2 Sweep relay

Unchanged and untouched for `exact`. The confidential rail does **not** use it: gasless
spend is native (§6.1, and the settler is fee payer on Solana). Do not extend
`relayDeposit` to confidential — refuse it, with a reason.

### 8.3 Pool payout, denominations, `k_eff`

- **Denominations off** on the confidential rail (R3). A confidential payout is one leg.
- **`k_eff` gating stays on** and still matters: it protects the *edge*, which confidential
  amounts do not touch. Its `denomination` bucketing key becomes the pair
  `(asset, scheme)` — all confidential legs of an asset are mutually indistinguishable by
  amount, which if anything makes `k_eff` *stronger* here, since amount can no longer
  split the anonymity set.
- Pool-direct payout composes unchanged: the pool is still the on-chain sender.

### 8.4 Private ledger

Unchanged and still the strongest path in the system — an agent↔agent ledger transfer
touches no public chain at all. Confidential x402 is for the payments that *must* cross a
chain boundary. Keep saying so in that order.

### 8.5 Browser (Phase 4a)

The `INBOX` panel renders a confidential output with `amount: hidden`. It must not
attempt decryption: the origin holds only `inboxIdentityKey` and has **no derivational
relationship to any spending key** — decryption would require importing one, which is
exactly the property Phase 4a was built to avoid. Unchanged, deliberately.

---

## 9. Config

Following existing naming. All default off / dry-run.

| Var | Default | Meaning |
|---|---|---|
| `PX402_CONFIDENTIAL_X402_ENABLED` | `false` | master switch; off ⇒ scheme never advertised, no contract constructed |
| `PX402_CONFIDENTIAL_NETWORKS` | `[]` | JSON array of networks opting in |
| `PX402_SOLANA_CONFIDENTIAL_MINT` | — | Token-2022 mint; startup asserts `auditorElgamalPubkey == null` |
| `PX402_BASE_CONFIDENTIAL_CONTRACT` | — | `PX402Confidential` on Base |
| `PX402_RH_CONFIDENTIAL_CONTRACT` | — | same bytecode on Robinhood Chain |
| `PX402_CONFIDENTIAL_VERIFYING_KEY_HASH` | — | required when either contract is set; mismatch **throws** |
| `PX402_CONFIDENTIAL_PROOF_TIMEOUT_MS` | `30_000` | proving budget before refusing the quote |

A rail is confidential-capable only when: the flag is on, the network is listed, the asset
is deployed and asserted, and a settler key exists. Anything less ⇒ dry-run, and the quote
does not advertise it.

---

## 10. Test plan

| Script | `npm run` | Must prove |
|---|---|---|
| `confidential-x402-smoke.mjs` | `test:x402:confidential` | scheme union; quote refuses confidential without `stealthMeta`; pay refuses a scheme downgrade; dry-run labelled; unknown scheme opaque-refused |
| `confidential-inbox-smoke.mjs` | `test:stealth:inbox:confidential` | **B3**: a confidential record with a zero plaintext balance is never dormant and survives `reap()` past `dormantMs`; a plain record still reaps; drain still sticky |
| `confidential-solana-devnet.ts` | `test:confidential:solana:devnet` | the §14.2 run, re-runnable: confidential transfer → stealth address, amount absent from every tx, only the stealth key decrypts, raw scalar controls the account |
| `confidential-evm-fork.mjs` | `test:confidential:evm:fork` | forked Base mainnet: deposit → confidential transfer to a stealth address → gasless spend from it with 0 ETH → withdraw; amount absent from calldata and logs throughout |

Plus the existing suite green with no regression: `test:x402`, `test:pool-payout`,
`test:denominations`, `test:concentration`, `test:stealth:inbox`,
`test:stealth:sweep-relay`.

**Bundle rule:** none of the confidential proving stack may reach a browser bundle.
`src/client/` must not import it — a ~5.8 MB artifact in a browser client's startup path
is not a tradeoff, it is a bug. PX-402 ships no bundler of its own, so any consumer that
bundles `src/client/` must grep its built artifact for it, because typecheck cannot see a
transitive import.

---

## 11. Honest privacy statement (verbatim into `CLAUDE.md` on merge)

> **Confidential x402.** With `PX402_CONFIDENTIAL_X402_ENABLED=true`, a payment to a
> stealth-capable payee settles with an **encrypted amount**: ElGamal + ZK range proofs
> natively via Token-2022 on Solana, and via the `PX402Confidential` contract on Base
> and Robinhood Chain. The facilitator is ours; no third-party prover, MPC network, or
> hosted settlement service is in the path.
>
> *Removed:* the **payment value**, from every public observer, including at `k_eff = 1`.
> This is the first privacy property in the stack that does not depend on having a crowd.
> Combined with stealth receiving and payer rotation, a public-chain observer sees an edge
> between two addresses that each appear once, carrying an amount they cannot read.
>
> *NOT removed — state this first, not last:* **the edge itself.** `sender → receiver` is
> public on both mechanisms — verified on-chain, not assumed. So is **timing**, and so are
> the **deposit and withdrawal amounts** at the confidential-balance boundary. An observer
> who can link a deposit to a later withdrawal by amount and timing recovers value
> information that the transfer itself hid; splitting deposits helps, and *distinctive*
> splitting is itself a fingerprint. Hiding the edge requires a shielded pool, which we
> have not built and do not claim.
>
> *Trust model unchanged:* the server already custodies the pool, already holds every
> payee viewing key, and already sees live requests as it processes them. Confidential
> amounts hide value from **chain observers, never from the operator**. A malicious
> operator can still refuse service or grief. This adds no trust assumption and removes
> one disclosure class.
>
> *Strongest path is still the private ledger:* an agent↔agent transfer that never touches
> a public chain has no edge to hide.

---

## 12. Explicitly deferred, with reasons

1. **Shielded pool / sender-set anonymity.** The only thing that hides the edge. It is a
   note-commitment tree + nullifiers + membership proofs — a larger project than this
   entire wave, with a much heavier audit burden. Deferred as its own spec, not smuggled
   in here.
2. **Confidential balances in the browser.** Requires a spending key on the origin.
   Refused by Phase 4a's design; revisit only with a hardware-key story.
3. **Off-chain change.** Owned by `spec-payout-offchain-change.md`. Note it becomes *less*
   urgent here: `strategy:"single"` leaks the exact value on the `exact` rail, and on the
   confidential rail it does not leak it at all.
4. **Cross-rail confidential atomicity.** Out of scope; each rail settles independently.
5. **Auditor keys / selective disclosure.** Deliberately forbidden (§5.1). A compliance
   story, if ever needed, must be per-payment and payee-initiated, never a mint-wide key.

---

## 13. Open questions

1. **Deposit-boundary batching.** The public deposit amount is the weakest remaining link.
   Does pooling deposits into standard sizes help enough to justify the latency, or does it
   just recreate the denomination fingerprint one layer down?
2. **Proving location on EVM.** Client-side (~5.8 MB, seconds) vs. an agent-local prover
   daemon. Server-side proving is not an option — it would hand the operator the plaintext
   amount and forfeit the entire property.
3. **Solana `maxLegs`.** Already deferred at 3 by the denominations wave for ATA rent;
   confidential accounts are larger still. Reprice before enabling both together.
4. **Robinhood Chain verifier gas.** Groth16 verification cost on eip155:4663 is unmeasured.
   Measure before promising parity in production, not after.

---

## 14. Evidence appendix — both spikes ran live

Both spikes lived under `spikes/` in the originating tree (§14.3) and are **not** shipped
in PX-402. Neither was ever a runtime dependency.

### 14.1 EVM — Base Sepolia (`spikes/evm-confidential-reference/`)

Reference implementation only; proves the *shape* our contract must have, using TACEO's
deployed Merces as a stand-in for `PX402Confidential`.

| Item | Value |
|---|---|
| Queuing tx (value-moving) | `0x761e6e888d8276a2f37646f99311442132871b2a7831cef03f07da2c0f2b336c` (block 44800685) |
| Settle tx (`processMPC`) | `0x210e837025796c404022d848b7dd3227c8c37381c8b1420ea70af1443466bc2d` (block 44800686) |
| Spend-from-stealth tx | `0xd191697b357bead88a89a506835bf82b819df671661581f5e42d74d53b3f7093` |
| Stealth recipient | `0x3e385E0C5AfFbEE2E108f1A931D35b6250a178de` (EIP-5564, one-time) |
| Amount | 1.25 USDC — **absent** from all calldata and logs, in all three encodings |
| Edge | `sender` and `receiver` both **plaintext** in calldata and event |

### 14.2 Solana — devnet, self-built (`spikes/solana-confidential/`)

**Read §5's correction first.** This run is real and its transactions are real, but payer
and payee were the SAME PROCESS, so it does NOT prove the two-party topology we deploy.
What it genuinely proves: the crypto works, the toolchain works, the amount is absent from
the chain, and a stealth scalar can own and control a confidential account. What it does
NOT prove: that a payer who is not the payee can construct the transfer at all.

| Item | Value |
|---|---|
| Mint (`auditorElgamalPubkey: null`) | `FocYWf7ju8kFjjtzZpEuhz642GNbG2wBH7MmRLMRohq8` |
| Stealth address (DKSAP one-time) | `2kM4UaSTVQoxJgE4X3KdnNnd3uh4uFp9mHn7nD4mMGKj` |
| Ephemeral pubkey `R` | `FJ1xdFewSUY6uYzR9P1XobrMBmPuCFpdij8vjMATQioD` |
| Confidential transfer | `2PmvfUqCBEjPSUz3Q82Z2ytCGAWjr1GAXVVJFo5XmroFTBuReW4Vy7RugSmeKWX8DRoinqe8pvBm5PiWmTo2MVxs` |
| Stealth applies pending (raw scalar) | `3zzJt5FAXXvSmHSMzavZaMRVfTRSqiyXoTv1D8WUFWfTASw1eVEu1ySUBU4QR8U3wbTz1HbeMzPmc3jKdE3ozENg` |
| Amount | 137.0 tokens — recipient plaintext `amount == 0`; value absent from account data and all five transfer txs |
| Edge | source ATA and destination ATA both **public** |

### 14.3 Reproduction

Both spikes carried their own `package.json` and were **not** installed by the root
`npm install`; the root dependency tree and the production image were unchanged. See
`spikes/README.md` in the originating tree — the spike trees are not part of PX-402. Key
material was generated locally and gitignored — no spike secret is committed.

---

## 15. Implementation state (2026-07-30) — READ THIS FIRST

### 15.1 Landed, verified, flag-OFF

| Commit | What |
|---|---|
| `1311b13` | **B1+B2** — `X402Scheme` union, `ConfidentialRail`, `ConfidentialObservation` tri-state, `isConfidentialRail` |
| `b88dc93` | Wire contract `src/shared/x402SolanaConfidential.ts` — **dependency-free by design** |
| `d40ee84` | §9 config, fail-closed capability guards |
| `58133fc` | `resolveConfidentialRecipient` made SYNC (the registry write-ahead depends on purity) |
| `376828b` | de-duplicated `buildSolanaAgentQuote` — a latent privacy regression, not tidying |
| `a2e5fc9` | branded `ConfidentialEncryptionPubKey` + §5 correction |
| `7f9d49d` | measured the configure constraint; §5.2-R → §5.2-P |
| `0827ef1` | bundle guard covers `.wasm`; `moduleResolution: Bundler`; §5.2-M, §5.3 |
| `e72ec9a` | dependencies (+58 MB, server-only) |
| `daf9053` | §5.1 mint assertion (auditor-null, fail-safe) — verified against 5 live devnet cases |
| `faa34eb` | §5.4 pool economics |
| `1c3a845` | §5.2-P durable slot pool `ConfidentialSlotBook` |
| `75f38e6` | **§5.2-P PROVEN on devnet, two-party, 11/11** |

Tests: `test:x402:confidential` 27/27, `test:confidential:slots` 15/15, and the
browser-bundle guard 7/7 (guard not ported — §10). No regression anywhere else. Client
bundle byte-identical throughout — none of this ships a byte to the browser.

### 15.2 `settleConfidential` — **LANDED** (`d8f5b21`, 22/22)

Built in `src/server/rails/SolanaConfidentialSettler.ts`, exposed through
`SolanaConfidentialChainRail`, proven offline by `npm run test:confidential:settle`
against real `VersionedTransaction` bytes and a stubbed chain. All four
requirements below are enforced by a test, not by a comment.

**Two corrections this forced into the wire contract:**

- **The plan is FIVE transactions, not one.** `SolanaConfidentialPayload.transaction`
  was a single string and was simply wrong — the devnet evidence shows four setup
  transactions standing up three proof contexts, then one that transfers and closes
  them. It is now `transactions: string[]`, capped at 12.
- **The quote now publishes the §5.2-P slot** (`ephemeralPubKey`, `encryptionPubKey`,
  `destinationTokenAccount`). The payee picks `R`, because only an account's owner may
  configure it. That inversion is also what keeps `resolveConfidentialRecipient`
  synchronous and pure, which the registry's announcement write-ahead depends on.

**One defect found by its own tests:** the settler pubkey and its keypair were one
field, so `decodePlan` threw whenever no key was configured — turning dry-run, the
DEFAULT state of this rail, into a hard failure rather than a verify-and-simulate.
Now split; every binding check needs only the pubkey.

**One design decision worth keeping:** the close set is DERIVED from the submitted
transactions (a `VerifyProof*` instruction whose context authority is our settler),
never declared by the caller. Every context account in flight shares one authority,
so a caller who could name an address would be naming another payment's proofs.

The four non-negotiable requirements, each earned the hard way:

1. **Simulate every plan transaction yourself and read `value.err` + `value.logs`.**
   kit's thrown error DESTROYS the program error — the real cause arrives as
   `TypeError: Do not know how to serialize a BigInt` because kit's formatter chokes on
   `{Custom: 26n}`. Use a bigint-safe JSON replacer everywhere; a bare `JSON.stringify` on
   a rejected verdict throws and silently swallows the one verdict that matters. **This
   already produced one false conclusion in this repo.**
2. **Close the 3 proof-context accounts on the FAILURE path.** Proof setup succeeds before
   the Transfer fails, so a rejected payment leaves them open holding 8,539,920 lamports and
   the plan's `CloseContextState` never runs. Leak per failed payment otherwise.
3. **Write-ahead before broadcast.** Reserve the slot durably (`ConfidentialSlotBook.reserve`,
   which selects inside the write lock) AND write the announcement into
   `InboundAnnouncementBook` with `confidentiality: "confidential"` — the B3 discriminator
   already exists and `indexInboundAnnouncements` does NOT set it yet. That threading is the
   remaining B3 wiring point.
4. **Route through the shared transaction coordinator/outbox.** Every settler-EOA send does
   (`SolanaX402Facilitator.send`, used by sweep/pool/settle). A bypass corrupts the shared
   nonce pipeline.

Plus: `confidentialMode` must be resolved by an async startup assertion using
`assertConfidentialMint` and cached, reading `dry-run` until it runs; and the rail cannot
reuse any existing ATA helper, because every one of them hardcodes `TOKEN_PROGRAM_ID`, which
derives the WRONG address for a Token-2022 mint.

### 15.3 Then, in order

1. ~~Wire the rail into `PrivateAgentRegistry`~~ — **DONE** (`00ef708`, 13/13,
   `npm run test:confidential:wiring`). Quote reserves a slot and publishes it; pay routes
   by the QUOTE's scheme. The signed quote intent now BINDS the scheme, because an unbound
   scheme is a downgrade attack — a transport rewriting `confidential`→`exact` would publish
   the amount while the payee's signature still verified. `exact` stays byte-identical to
   the pre-scheme message, so no existing signature is invalidated.

   **Three bugs this surfaced, all of which type-checked cleanly:**
   - **B3 was never armed.** `indexInboundAnnouncements` hardcoded `?? "plain"` and no
     caller passed otherwise, so the `dd4fb8e` guard could not fire. Now threaded, and a
     confidential leg reports `expectedAmountAtomic: null`.
   - **Wrong meta-address field.** The quote builder read `payee.stealthMeta` (secp256k1
     EIP-5564) where this ed25519 DKSAP rail needs `solanaStealthMeta`. Both exist, both
     optional, so the wrong one compiles and fails only where funds move.
   - **A confidential payload is invisible to the payload discriminators.** It carries
     `transactions` (plural), so `ownsPayment`/`isSolanaPayment` missed it and both the
     nonce lookup and `x402PayIntentMessage` fell through to `.authorization.from` on an
     object with no authorization.

2. ~~Slot-pool provisioning endpoint~~ — **DONE** (`fe79a60`, 18/18,
   `npm run test:confidential:provision`). `POST /private/a2a/slot-provision` plus
   `GET /private/a2a/slot-depth`.

   The ceremony is split because neither party can do the other's job: only the account
   OWNER may run `Configure`, and the owner is a one-time key derived from `kSpend` that
   never leaves the payee; only the settler has SOL for rent. The payee builds and
   owner-signs; we fund and broadcast.

   **We are funding accounts on an agent's say-so, so every claim is re-derived:**
   - The address must recompute from `R` and OUR viewing key — checked **before**
     broadcast, since it is the check that decides whether we pay.
   - The ATA must equal the one WE derive for `(address, mint)`.
   - **`P` must equal what the PROGRAM stored**, read back after confirmation. The server
     can never compute `P` (`s⁻¹·H`, and it holds only a viewing key), so read-back is the
     only available check — and a complete one, since that stored key is exactly what the
     program enforces against a later transfer's `destinationElgamalPubkey`.

   Registration is **per-slot**, so one bad slot does not discard good ones whose rent is
   already spent, and **never before confirmation** — a slot handed out early is one a payer
   could pay into a void. The signed intent binds the ADDRESSES, not a count, because rent
   is per account.

   *The branded `ConfidentialEncryptionPubKey` earned itself here:* the first version
   registered the payee's **claimed** key and refused to compile.

3. ~~Devnet run of the full loop~~ — **DONE** (`3c4ef4a`, 23/23,
   `npm run test:confidential:devnet`). `quote → provision → pay → index → decrypt` on live
   devnet, through the SHIPPED code rather than the spike. Deterministic across runs; ~0.02
   SOL each. Evidence: `spikes/solana-confidential/evidence/production-devnet-result.json`.

   Established on chain, not argued: the transfer plan really is **five transactions**; the
   amount appears in **no encoding** across 3,705 bytes of the signed plan; the announcement
   is indexed `confidentiality: "confidential"`, so B3 is now armed by a real payment; the
   payee reads `41000000` from `(R, kView, kSpend)` alone while the destination's plaintext
   balance stays `0`.

   *Harness facts worth keeping:* kit's transaction plan **executor** cannot build a plan for
   someone else to co-sign — it calls `getSignatureFromTransaction` on every result, which
   throws while the fee-payer slot is empty, and empty is the point. Walk the plan tree
   instead. And the fee-payer signer must be a parameter: the provisioning leg passes a true
   noop signer (that is where "the server co-signs a plan it did not build" is actually
   tested), while the transfer leg must reuse the authority's INSTANCE, because in this
   fixture the funded source account belongs to the settler and kit refuses two distinct
   signers for one address.

**Remaining before MAINNET:** a mainnet Token-2022 mint with the extension and a **null
auditor** set as `PX402_SOLANA_CONFIDENTIAL_MINT`, slot-pool depth sized against
expected traffic, and the flag turned on. The code path is proven; what is left is
deployment and an asset, not engineering.
3. `test:confidential:solana:devnet` as a re-runnable version of `two-party-devnet.ts`.
4. §5.2-M multiplicative derivation — a round-trip optimisation, ship last.
5. EVM (`PX402Confidential`) for Base + Robinhood parity — needs a contract and a proving
   system, so it is a much larger wave than Solana.

### 15.4 Known unknowns, not estimated

- Whether `CloseAccount` refuses while the extension is present, and whether a non-zero
  *pending* balance blocks `EmptyAccount` (decides if reclaim is 2 or 3 transactions).
- Any program-level per-mint confidential-account cap, and pool behaviour at scale.
- Transaction packing, total fees, compute-unit costs.
- The ElGamal-registry program's create-entry signer rules (does not change any conclusion —
  the `PubkeyValidityProofData`-needs-the-keypair argument closes that path regardless).
