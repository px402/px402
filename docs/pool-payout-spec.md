# SPEC: Pool-direct shielded payout (ledger-funded), written once against ChainRail

Repo: `px402` (TypeScript strict, Node, npm). Work in the tree; do NOT commit.

## What & why

Add a `pool-direct payout` rail: an agent spends its encrypted private-ledger balance to make a REAL on-chain payment to a payee, where the SHARED settler pool is always the on-chain sender and the payee is received at a fresh stealth address. On-chain an observer sees only `pool -> stealth-address`, identical for every agent, so the sender-anonymity set is the whole pool and there is NO per-agent payer address. This is the strongest sender+recipient privacy for a real on-chain payout; the residual public facts are the amount, timing, and that the pool paid someone. It is written ONCE against the `ChainRail` interface (added in the prior commit) and implemented per chain-kind, so it lands on base + robinhood (EvmChainRail) and solana (SolanaChainRail) together.

**Rollout: DRY-RUN FIRST.** The on-chain payout must default to dry-run (verify + simulate + do the ledger accounting, no broadcast) unless that network's settler key is present AND the pool payout is explicitly enabled. Deploy in dry-run; go live per network later by funding the pool.

## Ledger model (conservation must hold)

The private ledger is double-entry: on deposit, `creditDeposit` does `agent += X; escrow:<assetKey> -= X`, so `escrow = -(sum of agent balances)` and real pool tokens held on-chain `= -(escrow)`. A pool payout of X on behalf of agent A spends A's balance and reduces the pool's real on-chain tokens by X: `agent A -= X; escrow:<assetKey> += X`. The sum stays 0 and the invariant `real pool tokens == sum(agent balances)` is preserved.

Add a ledger method `PrivatePaymentLedger.payout(input: { agentId; amountAtomic; assetKey; network; payoutRef; acceptedAt? }): Promise<{ commitment; balanceAtomic; acceptedAt; duplicate }>`:
- Reject if `amount <= 0` or `balance(agentId, assetKey) < amount`.
- Idempotency: `authorizationHash = hash("payout:" + payoutRef)` (payoutRef = the one-shot quote nonce); if a transfer with that hash exists, return it as `duplicate:true` (no double-debit).
- Do: append the encrypted journal entry (source `"payout"` — extend the journal entry `source` union to include `"payout"`), `setBalance(agent, balance - amount)`, `setBalance("escrow:<assetKey>", escrowBalance + amount)`, push a transfer record (`source:"payout"`, the assetKey, authorizationHash, commitment, epochId), persist with the existing rollback-on-error pattern. Include the payout in settlement batches exactly like vouchers/deposits.
- Add a way to record the on-chain tx hash on the payout entry after a successful broadcast, OR accept an optional `transactionHash` recorded at creation for onchain mode (dry-run mode records none). Keep it consistent with how deposits store nothing sensitive.
- A `reversePayout(payoutRef)` (or make `payout` callable in a compensating direction) to REFUND when the on-chain payout fails after the debit: re-credit the agent, re-debit escrow, and remove/mark the payout entry so the quote can't be considered paid. Must be safe/idempotent.

Assert the conservation invariant in the existing `assertState` where practical, and the smoke must check `sum(all balances including escrow) === 0` after payouts.

## ChainRail additions (`src/server/rails/ChainRail.ts` + both impls)

```ts
readonly poolMode: "dry-run" | "onchain";   // onchain iff the settler/pool key is present AND pool payout is enabled for this rail

// Detect-only: compute the on-chain recipient for a quote given the payer's
// announcement — the payee's one-time stealth address for THIS chain when the
// quote carries a stealth meta, else the payee's main wallet. Reuses the same
// stealth detection settle() already does (factor it out; settle() should call this too).
resolveRecipient(input: {
  requirements: X402PaymentRequirements | SolanaX402PaymentRequirements;
  payee: PrivateAgentEndpoint;
  ephemeralPubKey?: string;
}): { recipient: string; stealth?: { stealthAddress: string; ephemeralPubKey: string } };

// Pay `amountAtomic` of this rail's token from the shared settler POOL to `recipient`.
// dry-run: verify the pool could pay (simulate / balance read), no broadcast, mode "dry-run".
// onchain: settler signs+broadcasts the transfer from the pool, confirm, return the tx hash.
payoutFromPool(input: { recipient: string; amountAtomic: string; nowSeconds: number }):
  Promise<{ transactionHash?: string; settled: boolean; mode: "dry-run" | "onchain" }>;
```

- **EvmChainRail.payoutFromPool**: an ERC-20 `transfer(recipient, amount)` of the token from the pool address, signed by the settler key. REQUIRE that the pool address the settler controls == the configured treasury for that network (the deposits' recipient) — pass the treasury/pool context into the rail (via constructor options) and assert `settler.address == treasury`; if they differ, `poolMode` is "dry-run" and log why (do NOT broadcast from a mismatched pool). Dry-run: eth_call/estimateGas simulate, no send.
- **SolanaChainRail.payoutFromPool**: a `transferChecked` of USDC-SPL from the pool ATA to the recipient's ATA (idempotent-create the recipient ATA, fee payer = settler), signed by the settler (the Solana treasury defaults to the settler pubkey, so pool==settler naturally). Dry-run: `simulateTransaction`, no send.
- `resolveRecipient`: lift the stealth-detection logic (EVM `checkStealthAddress` / Solana `checkSolanaStealthAddress`) out of `settle` into `resolveRecipient`, and have `settle` call it so there is ONE stealth-derivation path (behavior unchanged for settle — keep its existing error strings and the EVM `to === expected` check inside settle).

## Registry flow (`PrivateAgentRegistry`)

Add `async payoutFromLedger(input: PoolPayoutInput, remoteIp, nowSeconds): Promise<PoolPayoutReceipt>`:
- `PoolPayoutInput = { payerAgentId; payeeAgentId; quoteNonce; ephemeralPubKey?; agentSignature }` (NO on-chain payment payload — the agent authorizes via its identity key + a fresh ephemeral for stealth).
- Require the private ledger to be configured. Resolve the rail for the quote's network (`this.resolveRail`); the quote is the existing x402 quote stored by `quoteNonce` (reuse the normal `quoteX402` challenge — the payee quotes as usual; only the PAY step differs).
- Verify: VPN peer (payer endpoint), the pay-intent identity signature over a NEW canonical message `poolPayoutIntentMessage({ payerAgentId, payeeAgentId, quoteNonce, ephemeralPubKey, network })` (add to `src/shared/x402AgentIntent.ts`), and that the quote exists + matches payer/payee.
- `rail.resolveRecipient(...)` -> `{ recipient, stealth }`. If the quote is stealth, `ephemeralPubKey` is required (reuse the existing error strings).
- Determine the assetKey for the quote's network (`privateLedgerAssetKey(network, tokenAddress)` — Solana case-preserved mint from the rail's tokenConfig).
- **Order**: (1) `ledger.payout({ agentId: payer, amountAtomic, assetKey, network, payoutRef: quoteNonce })` — reserve/debit; rejects on insufficient balance BEFORE any chain action. (2) `rail.payoutFromPool({ recipient, amountAtomic, nowSeconds })`. (3) on payout throw/`settled:false` in onchain mode -> `ledger.reversePayout(quoteNonce)` and rethrow. (4) delete the one-shot quote. Return a receipt `{ kind:"pool-payout"; network; recipient/stealthAddress; ephemeralPubKey?; mode; transactionHash?; payerBalanceAtomic; settledAt }` with NO counterparty identity and NO retained history (receipt endpoints stay disabled).
- Document (comment) the live-mode crash window between debit and payout-confirm: because quotes are ephemeral, a crash there leaves a reserved debit; live hardening (a persisted pending-payout journal) is a follow-up — acceptable under dry-run-first.

## Server route (`createPrivateAgentServer.ts`)

`POST /private/a2a/pool-payout` -> `registry.payoutFromLedger(body, remoteIp, now)`; 503 if the ledger or the network's rail isn't configured; return `{ receipt }`. Keep receipt-history endpoints disabled.

## Client (`src/shared/privateX402Client.ts`)

`preparePoolPayout({ requirements, identitySigner, payerAgentId, payeeAgentId, network })`: derive the stealth announcement for the quote (chain-appropriate: `deriveStealthAddress` / `deriveSolanaStealthAddress` when the requirements carry a stealth meta), sign `poolPayoutIntentMessage`, and `submitPoolPayout({ rpcUrl, ... })` POSTs it. No on-chain payer key is created (that is the whole point).

## Config / wiring (`config.ts`, `index.ts`)

- Add `PX402_POOL_PAYOUT_ENABLED` (default false) — the master switch; when false, `poolMode` is "dry-run" everywhere regardless of keys.
- EvmChainRail construction gains the pool/treasury context: pass `{ facilitator, treasury: config.<net>.treasury, poolPayoutEnabled }`. SolanaChainRail gains `{ facilitator, treasury: solanaLedgerTreasury, poolPayoutEnabled }`.
- `poolMode` = "onchain" iff `poolPayoutEnabled` AND the rail's settler key is present AND (EVM: settler.address == treasury; Solana: pool ATA == treasury ATA, which holds by default). Otherwise "dry-run".
- Log each rail's `poolMode` in the ready line.

## Tests

Extend `scripts/private-ledger-smoke.mjs` (or a new `scripts/pool-payout-smoke.mjs` wired to `npm run test:pool-payout`) — OFFLINE, mock the rail's `payoutFromPool` (dependency-injected) and use the real ledger:
- Funded agent pool-payout: ledger balance debited by the amount, escrow credited by the amount, conservation `sum(all balances incl escrow) === 0` holds, receipt carries the stealth recipient + `mode:"dry-run"`, no counterparty identity in the response.
- Insufficient balance: rejected with NO call to `payoutFromPool` (assert the mock was not invoked) and the balance unchanged.
- Payout FAILURE compensation: mock `payoutFromPool` to throw in onchain mode -> `reversePayout` restores the exact prior balance and escrow; the quote is NOT consumed as paid (a retry can succeed).
- Idempotency: replaying the same quoteNonce does not double-debit.
- Cross-network: a base-only-funded agent cannot pool-payout on solana (insufficient solana:<mint> balance).
- A pool payout is included in a settlement batch (transferCount reflects it).
- Rail unit: `payoutFromPool` in dry-run returns `mode:"dry-run"` and does not broadcast (assert against a mock connection/provider that records sends); `resolveRecipient` returns the stealth address for a stealth quote and the payee wallet otherwise (both chains).

Every EXISTING suite must stay green with the same counts (x402 46, client 8, private-ledger >=30, stealth 8, rotation 8, stealth:solana 11, rotation:solana 8, x402:solana 21, ledger:solana 8) + burn/adversary safe.

## Docs (same diff)

- `CLAUDE.md` + `AGENTS.md`: new `PX402_POOL_PAYOUT_ENABLED` env var; a "Pool-direct shielded payout" systems section: ledger-funded, pool is the universal on-chain sender (sender-anonymity set = pool participants), stealth recipient, dry-run until enabled+funded, conservation invariant, and the honest residual (amount/timing/that-the-pool-paid remain public; live-mode crash-window follow-up).
- `VERIFICATION.md`: add `npm run test:pool-payout` and the pool-payout coverage line.

## Hard constraints

- Do NOT commit/push/touch git or `.env*`. No new deps.
- On-chain payout DEFAULTS to dry-run; only "onchain" when explicitly enabled + keyed + pool==treasury.
- Do NOT change existing x402/ledger/stealth/rotation behavior or error strings; pool payout is additive. Reuse the ChainRail from the prior commit — implement `payoutFromPool`/`resolveRecipient`/`poolMode` on BOTH rails (base+robinhood via EvmChainRail, solana via SolanaChainRail).
- TypeScript strict. Never log/hardcode secrets. Preserve Solana base58 case in all on-chain paths.

## Verification gates (run ALL; paste summaries)

```
npm run build
npm run test:x402
npm run test:x402:client
npm run test:x402:private-ledger
npm run test:stealth
npm run test:rotation
npm run test:stealth:solana
npm run test:rotation:solana
npm run test:x402:solana
npm run test:ledger:solana
npm run test:pool-payout
npm run proof:private-ledger-burn
npm run proof:private-ledger-adversary
```

All exit 0, zero FAIL lines. Final report: files changed, per-suite passed/failed, build exit, new env var, and any deviation from this spec with rationale.

## Denominations-wave addendum

`PX402_POOL_PAYOUT_DENOMINATIONS_ENABLED=true` enables the negotiated
`px402-pool-payout/v2` path for stealth-capable quotes. The quote advertises
the versioned per-network denomination set and hard `maxLegs`; the client
produces and identity-signs an immutable `PayoutGroupPlan`, with one fresh,
distinct stealth announcement per ordered leg. The server treats plan
validation as the safety boundary and maps only a validated plan into the
batching queue; `planHash` is the sole plan-binding field that crosses that
boundary. The flag defaults to false, preserving the scalar v1 quote and
receipt path.

Wave 1 always preserves the full value on-chain:
`offchainChangeAtomic === "0"` and there is no change component. An amount
that cannot be tiled within the configured leg cap—including an amount below
the smallest denomination—uses one exact leg with the bare quote nonce as its
payout reference. Split legs use `${groupRef}:${index}`. Demo records persist
`legs[]`, including each leg's receiver material and terminal on-chain result,
before any permitted broadcast; the sweep tool consumes every leg while
retaining the legacy single-`receiver` fallback.

Denominations make common payout values less distinctive but do not hide the
public amount or timing, and they do not make the pool payment itself private.
The pool remains the universal sender and each leg uses a fresh stealth
recipient. Off-chain change and amount-hiding require a later, separately
gated design.
