---
name: robinhood-x402-reference
description: Robinhood Chain x402 in PX-402 — chain-agnostic network registry, multi-network private ledger, ChainRail unification, and pool-direct payout
---

**Robinhood Chain x402.** PX-402 x402 is chain-agnostic via `X402_NETWORKS` in
`src/shared/x402.ts`: `base` (Circle USDC) + `robinhood` (Paxos USDG
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` on `eip155:4663`, EIP-712 domain "Global
Dollar"/"1" — proven against the live `DOMAIN_SEPARATOR()`). One self-custody
`X402Facilitator` per network; the quote `network` param is bound into the signed intent;
pay routes by the quote's network. USDG reverts with custom errors (`InsufficientFunds()`
= `0x356680b7`) — decoder table in `X402Facilitator.ts`. Live proof:
`npm run test:x402:rh:onchain`. **LIVE-SETTLE PROVEN** (`npm run x402:rh:settle-live`):
0.10 USDG payer→payee settled on-chain; RH gas is dust (~102k gas @ ~0.05 gwei). The RH
facilitator goes on-chain once `PX402_RH_X402_SETTLER_KEY` is set (the same settler
key/address as Base is fine).

**Private ledger is multi-network:** per-asset balances keyed `network:tokenAddress`
(ledger schema v3), per-network deposit verifiers + batch committers, and an RH
`PX402BatchCommitment` deployment addressed by `PX402_RH_PRIVATE_BATCH_CONTRACT`. Base
keeps the legacy deposit replay-hash formula (`deposit:<tx>`); other networks use
`deposit:<network>:<tx>`.

**ChainRail unification + pool-direct payout.** Per-chain x402 dispatch is unified behind
`src/server/rails/ChainRail.ts` with TWO impls: `EvmChainRail` (base+robinhood share it) +
`SolanaChainRail`. A new capability = one method on ChainRail + both impls → lands on all 3
networks. First use: **pool-direct shielded payout** (`POST /private/a2a/pool-payout`) — an
agent spends its private-ledger balance; the shared settler POOL is always the on-chain
sender, the payee gets a stealth address, so observers see only `pool→stealth`
(sender-anonymity set = all pool participants; no per-agent payer). Ledger `payout` is
double-entry (agent−=X, escrow+=X) with an in-code conservation assert + `reversePayout`
compensation; registry debits (refundable)→`rail.payoutFromPool`→refund-on-failure.
**Dry-run by default**; onchain only when `PX402_POOL_PAYOUT_ENABLED=true` + settler key +
pool==treasury (EVM: settler.address==treasury; Solana: settler is treasury by default).
Honest residual: amount/timing stay public; a live-mode crash between debit and confirm
leaves a reserved debit (the persisted pending-payout journal is the live-hardening
follow-up). Test: `npm run test:pool-payout` (15 checks).

**PROVEN LIVE on mainnet (both rails):** RH pool→stealth 0.10 USDG and Solana
pool→ed25519-stealth 0.10 USDC-SPL; both debited the payer ledger 0.2→0.1 and the fresh
stealth recipient received on-chain. Proof script
`npm run x402:pool-payout-live -- --network rh|solana [--confirm]` (bootstraps a payer
balance via `creditDeposit` backed by the real pool).

**Bug found + fixed via the live proof:** `X402Facilitator.ethCall` forwarded only
`{to,data}`, so `simulatePoolTransfer` (a plain ERC-20 transfer, which reverts on
msg.sender balance) simulated as the ZERO ADDRESS → always "insufficient funds" → silently
disabled ALL EVM pool payouts. Fixed by forwarding `from`; regression test added. Mocked
smokes missed it — the live proof caught it.

**Known operational hazard:** a live-proof payout sent to a stealth address whose key was
never persisted is unrecoverable. The proof script therefore persists sweepable demo
records (`data/pool-payout-demos/`) and `npm run x402:stealth-sweep` reclaims them.
