# SPEC: Self-custody Solana x402 rail with full privacy stack (stealth + payer rotation)

Repo: the PX-402 tree (TypeScript strict, Node, npm). Work in the tree; do NOT commit. Leave changes uncommitted for review.

## What already exists (do not break)

The x402 system today is EVM-only: EIP-3009 `transferWithAuthorization` signed with EIP-712, verified/settled by `X402Facilitator`. Two networks: `base` (Circle USDC) and `robinhood` (Paxos USDG), both self-custody (the server holds a settler key and broadcasts). Privacy layers on the EVM rail: EIP-5564 stealth (`src/shared/stealth.ts`, secp256k1) and payer rotation (`src/shared/payerRotation.ts`, BIP32 m/44'/60'). The private A2A flow runs over WireGuard: payee quotes (`/private/a2a/quote`), payer signs, pays (`/private/a2a/pay`); the QUOTE's network decides settlement. Multi-network private ledger exists too but is OUT OF SCOPE here.

## Goal

Add a THIRD network, `solana` (Circle USDC-SPL on Solana mainnet), as a **self-custody** x402 rail with the SAME privacy properties the EVM rail has: recipient stealth + payer rotation, negotiated over the existing WireGuard quote/pay routes. Solana is NOT EIP-3009 — it needs a parallel payment scheme. The crypto for stealth + rotation on ed25519 has ALREADY BEEN PROVEN (see "Proven primitives" below) — implement exactly that, do not invent alternatives.

## New dependencies (justified — Solana cannot be done without them)

Add to package.json dependencies: `@solana/web3.js@^1.95.0` and `@solana/spl-token@^0.4.9`. Run `npm install`. The stealth/rotation crypto uses the EXISTING `@noble/curves` (ed25519) + `@noble/hashes` — do NOT add other crypto libs.

## Constants (Solana mainnet)

- Friendly network id: `solana`
- CAIP-2: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- USDC-SPL mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- decimals: 6
- Default RPC: `https://api.mainnet-beta.solana.com` (env override `PX402_SOLANA_RPC_URL`)
- Settler keypair: server-only, base58 secret in env `PX402_SOLANA_X402_SETTLER_KEY`. Absent ⇒ facilitator runs dry-run (verify only, no broadcast).

## Proven primitives — implement EXACTLY these (validated against @noble/curves)

Let `L = ed25519.CURVE.n`, `Point = ed25519.ExtendedPoint` (fallback `.Point`), `B = Point.BASE`, `mod(x) = ((x % L)+L)%L`, `bytesToBigLE` = little-endian decode, `numTo32LE` = 32-byte LE encode, `hashToScalar(bytes) = mod(bytesToBigLE(sha512(bytes)))`.

**Stealth (ed25519 dual-key DKSAP), `src/shared/stealthSolana.ts`:**
- Payee keys: `spend`, `view` scalars (from `mod(bytesToBigLE(randomPrivateKey()))`); pubkeys `S = B·spend`, `V = B·view`. Meta-address = base58(S) + base58(V) (or hex — pick one and be consistent).
- Payer derive (per payment): random ephemeral `r`; `R = B·r` (the announcement / ephemeral pubkey); `shared = hashToScalar((V·r).toRawBytes())`; one-time pubkey `P = S + B·shared`. The Solana **stealth address = base58(P.toRawBytes())**.
- Payee detect: `shared = hashToScalar((R·view).toRawBytes())`; recompute `P' = S + B·shared`; must equal the paid address.
- Payee recover spend scalar: `p = mod(spend + shared)`; assert `B·p == P` (this is the key that controls the stealth address).
- Sweep signer (spending from a stealth address — Solana Keypair CANNOT do this, hand-roll it): given scalar `p`, pubkey `A = (B·p).toRawBytes()`, message `M`:
  `nonce = mod(bytesToBigLE(sha512([...numTo32LE(p), ...M])))`; `Rsig = B·nonce`; `k = hashToScalar([...Rsig.toRawBytes(), ...A, ...M])`; `s = mod(nonce + k·p)`; signature = `[...Rsig.toRawBytes(), ...numTo32LE(s)]` (64 bytes). This verifies via `ed25519.verify(sig, M, A)`.
- Provide a `sweepStealth` helper that builds+signs a Solana tx moving the SPL balance out of the stealth ATA using this raw-scalar signer (fee payer = settler). It does NOT need to run on the settle hot path; it's the payee's later action, but must be implemented + tested.

**Payer rotation (SLIP-0010 ed25519, m/44'/501'/i'/0'), `src/shared/payerRotationSolana.ts`:**
- `master(seed)`: `I = hmac(sha512, utf8("ed25519 seed"), seed)`; `{key:I[0:32], chain:I[32:64]}`.
- `ckd(node, index)` hardened-only: `i = (index | 0x80000000)>>>0`; `data = 0x00 || node.key(32) || ser32BE(i)`; `I = hmac(sha512, node.chain, data)`; `{key:I[0:32], chain:I[32:64]}`.
- `derive(seed, idx)`: start master, apply ckd for [44, 501, idx, 0]; return the 32-byte `key` = the ed25519 SEED for `Keypair.fromSeed(key)`.
- Pool shape mirrors `payerRotation.ts`: `{ seed, nextIndex }`, `createSolanaPayerPool()`, `nextSolanaPayerKeypair(pool) -> { keypair, index, pool }`. The rotation seed is recoverable (agent can sweep dust) and MUST stay secret.

Include one comment noting these were validated end-to-end (stealth address match, scalar-controls-address, raw-scalar-sig verifies, SLIP-0010 distinct+deterministic) before implementation.

## Payment scheme + facilitator

**`src/shared/x402.ts`:** add `kind: "evm" | "solana"` to `X402TokenConfig`; existing BASE_USDC/ROBINHOOD_USDG get `kind: "evm"`. Make the EVM-only fields (`chainId`, `domainName`, `domainVersion`) optional so a Solana config is valid without them. Add `SOLANA_USDC` (`kind:"solana"`, network `solana`, caip2 + mint + decimals 6 above) and register it in `X402_NETWORKS`. `resolveX402Network` already handles friendly id + caip2 — verify the solana caip2 resolves. The EVM builders (`buildPaymentRequirements`/`createPaymentPayload`/`verifyPayment`) must throw a clear error if handed a `kind:"solana"` token (they are EIP-712-specific).

**`src/shared/x402Solana.ts` (new):**
- `SolanaX402PaymentRequirements`: `{ x402Version:1, scheme:"exact", network:"solana", asset:mint, payTo:base58, maxAmountRequired:atomic, resource, nonce, validForSeconds, stealthMetaAddress? }` (mirror the EVM requirements shape so the registry/quote flow can treat them uniformly where possible).
- `SolanaX402PaymentPayload`: `{ x402Version:1, scheme:"exact", network:"solana", asset:mint, payer:base58, transaction:base64 }` where `transaction` is a serialized Solana tx: a single (or ATA-create + ) `transferChecked` moving `maxAmountRequired` of `mint` from the payer's ATA to `payTo`'s ATA, `feePayer = settler pubkey`, recentBlockhash set, PARTIALLY signed by the payer (source authority) only. If the recipient ATA may not exist, include an idempotent `createAssociatedTokenAccountIdempotent` instruction (payer/settler funds rent via fee payer).
- `buildSolanaPaymentRequirements(...)`, `createSolanaPaymentPayload({ payerKeypair, requirements, settlerPubkey, connection, nowSeconds })` (builds + payer-signs the tx), `verifySolanaPayment({ payload, requirements, settlerPubkey })` (decode; assert exactly the expected transferChecked with correct mint/amount/destination-ATA; assert feePayer==settler; assert payer signature present + valid over the message; assert no extra instructions that move value). Verification must NOT require network unless simulating.

**`src/server/base/SolanaX402Facilitator.ts` (new):** mirror `X402Facilitator`'s public surface as closely as makes sense: `mode: "dry-run"|"onchain"`, `tokenConfig`, `async verifyAndSettle(payload, requirements, nowSeconds)`, and a `simulateSettle`-equivalent (`connection.simulateTransaction`). Settle: add the settler signature as fee payer, `sendRawTransaction`, confirm; return `{ settlement:"onchain"|"dry-run", network:"solana", asset:mint, from:payer, to:payTo, value, transactionHash? }` shaped compatibly with `X402Settlement` (add fields as needed). Dry-run (no settler key): verify + simulate only, `settlement:"dry-run"`. Replay guard: track consumed payment identifiers (the tx's blockhash+payer+nonce or the requirements nonce) like the EVM facilitator tracks nonces.

## Registry + server integration

**`src/server/agents/PrivateAgentRegistry.ts`:** `quoteX402` and `payX402` currently assume EVM. Branch by the resolved network's `kind`:
- Quote: for `kind:"solana"`, build `SolanaX402PaymentRequirements` (stealth meta published same as EVM when the payee has `stealthMeta` — but a SOLANA stealth meta; see below). Keep the quote-network binding in the signed intent unchanged (network friendly id in the intent).
- Pay: for `kind:"solana"`, accept a `SolanaX402PaymentPayload`, verify + settle via the Solana facilitator. The payment payload type becomes a discriminated union on `network`/`scheme`. Keep the receipt shape (`X402TradeReceipt`) working — add solana-appropriate fields (stealthAddress, ephemeralPubKey already exist).
- Stealth on Solana: `PrivateAgentEndpoint` gains optional `solanaStealthMeta` + `solanaStealthViewingKey` (distinct from the secp256k1 `stealthMeta`/`stealthViewingKey`, which stay EVM-only). The server recomputes the expected solana stealth address from the announcement via the solana viewing key (detect-only), exactly like the EVM path in `checkStealthAddress`.

**`src/server/agents/createPrivateAgentServer.ts`:** add a `solanaFacilitator?` (or extend the `facilitators` map to hold it under `"solana"`; a Solana facilitator is a different class, so a separate optional field is cleaner). The `/private/a2a/quote` + `/private/a2a/pay` routes resolve it by the quote/payment network; unsupported ⇒ 503, matching existing behavior.

**`src/server/config.ts`:** add `solana: { rpcUrl (PX402_SOLANA_RPC_URL default mainnet-beta), usdcMint (PX402_SOLANA_USDC_MINT default EPjF…Dt1v), x402: { settlerSecretKey?: PX402_SOLANA_X402_SETTLER_KEY } }`.

**`src/server/index.ts`:** build a `SolanaX402Facilitator` when `config.agentRpc.enabled` (dry-run unless the settler key is set), pass it to the server, and include `solana ${facilitator.mode}` in the ready line.

**Client (`src/shared/privateX402Client.ts`):** add a Solana payer path — `prepareRotatingSolanaX402Payment({ payerPool (solana), requirements, settlerPubkey, connection, nowSeconds })` that rotates a fresh SLIP-0010 payer keypair, derives the solana stealth address when the requirements carry a solana stealth meta, builds+signs the payload, and returns `{ payment, ephemeralPubKey?, payerAddress, payerIndex, nextPayerPool, requirements, stealth? }` mirroring `prepareRotatingX402Payment`.

## Tests (all must pass; keep every existing check green)

- **`scripts/stealth-solana-smoke.mjs` (new, wire to `npm run test:stealth:solana`)**: prove the ed25519 stealth path offline — meta generation, payer derivation, payee detect, scalar recovery, `B·p == P`, raw-scalar signature verifies under P, unlinkability (address != payee spend pubkey), and a `sweepStealth`-built tx has the stealth pubkey as an authorizing signer. ~8+ checks.
- **`scripts/payer-rotation-solana-smoke.mjs` (new, `npm run test:rotation:solana`)**: SLIP-0010 pool derives distinct + deterministic keypairs, each a valid Solana `Keypair`, index advances, restore-from-seed reproduces the same address sequence. ~6+ checks.
- **`scripts/x402-solana-smoke.mjs` (new, `npm run test:x402:solana`)**: OFFLINE deterministic — build requirements, build+sign a payload against a mocked/blockhash-injected connection (do NOT hit mainnet in the smoke; stub the `Connection` with a fixed blockhash + a `simulateTransaction` that returns success, and a `getAccountInfo` for ATA existence), verify accepts a good payload, rejects wrong-mint / wrong-amount / wrong-destination / wrong-fee-payer / missing-payer-signature, dry-run facilitator labels `settlement:"dry-run"`, replay rejected, and a full stealth+rotation prepared payment settles (dry-run) to a one-time stealth address whose controlling scalar the payee can recover. ~15+ checks. Use dependency injection for the `Connection` so the test never needs the network.
- **`scripts/x402-solana-onchain-sim.mjs` (new, `npm run test:x402:solana:onchain`)**: like the RH onchain sim — against live mainnet RPC, `simulateTransaction` a well-formed (unfunded) payment and assert the simulation FAILS only on insufficient funds / uninitialized-account (i.e. the tx STRUCTURE is accepted), proving the payload is chain-valid without spending. INCONCLUSIVE (exit 0) if offline. Do NOT broadcast.

## Docs (same diff)

- `CLAUDE.md` + `AGENTS.md`: new env vars (`PX402_SOLANA_RPC_URL`, `PX402_SOLANA_USDC_MINT`, `PX402_SOLANA_X402_SETTLER_KEY`); a "Solana x402 (self-custody, SPL exact scheme)" systems section describing the transferChecked+fee-payer flow, ed25519 stealth, SLIP-0010 rotation, and that private-ledger-on-Solana is NOT yet included.
- `VERIFICATION.md`: add the four new test commands + note stealth/rotation are ed25519 variants.

## Hard constraints

- Do NOT commit / push / touch git config or any `.env*`. Do NOT modify `scripts/x402-rh-settle-live.mjs`, `scripts/x402-settle-live.mjs`.
- TypeScript strict clean. Never log or hardcode secrets. Settler secret is server-only.
- Do NOT change the EVM quote/pay/settle behavior, EVM stealth, or EVM rotation. Solana is additive — branch by `kind`, never rewrite the EVM path.
- Follow existing code style (comments explain constraints only).
- The live mainnet money proof is OUT OF SCOPE (settler needs SOL+USDC funding) — deliver code + offline tests + the onchain SIM only.

## Verification gates (run ALL; paste summaries)

```
npm install
npm run build
npm run test:x402
npm run test:x402:client
npm run test:x402:private-ledger
npm run test:stealth
npm run test:rotation
npm run test:stealth:solana
npm run test:rotation:solana
npm run test:x402:solana
```

All must exit 0 with zero FAIL lines (`test:x402:solana:onchain` is network-dependent — INCONCLUSIVE offline is acceptable). Final report: files changed (absolute paths), per-suite passed/failed counts, `npm run build` exit status, new deps added, and any deviation from this spec with rationale.

## Implementation notes (addendum)

Two traps that cost real debugging time. Neither is inferable from the code alone.

- **`@noble/curves` exposes no `package.json` exports subpath.** `require('@noble/curves/package.json')` throws, so version-sniffing the package fails. Import the curve directly via ESM: `import { ed25519 } from "@noble/curves/ed25519"`. The point class is named `ExtendedPoint` (`const Point = ed25519.ExtendedPoint`), the base point is `Point.BASE`, and the group order is `ed25519.CURVE.n`.
- **base58 is case-SENSITIVE — never lowercase a Solana identifier.** The EVM verifiers lowercase hex addresses freely because hex is case-insensitive; the Solana rail must not. Deposit `fromAddress`, `recipient`, `mint`, batch `tokenAddress`, and transaction signatures stay byte-exact on the solana path — lowercasing silently breaks address equality and deposit replay-hash matching. The one deliberate exception is the internal ledger `assetKey` (`${network}:${tokenAddress.toLowerCase()}`), lowercased for ALL networks so the key stays consistent; it is an internal key, never an on-chain identifier.
