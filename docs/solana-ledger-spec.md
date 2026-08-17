# SPEC: Extend the private ledger to Solana USDC-SPL (deposits + vouchers + batch anchor)

Repo: the PX-402 tree (TypeScript strict, Node, npm). Work in the tree; do NOT commit. Leave changes uncommitted for review.

## Context — what exists

The private payment ledger (`src/server/payments/PrivatePaymentLedger.ts`, schema v3) is already MULTI-ASSET: per-asset balances keyed by `assetKey = privateLedgerAssetKey(network, tokenAddress)` (which LOWERCASES the token address), with Base USDC + Robinhood USDG working. Flow: `deposit-intent` -> agent sends the on-chain token to a treasury -> `deposit-confirm` (server verifies the transfer, credits the assetKey balance) -> `private-quote`/`private-pay` (identity-signed vouchers debit/credit balances, NO per-trade on-chain tx) -> admin `POST /private/settlement/batch` (aggregate Merkle root published on-chain per network via a `PrivateBatchCommitter`). Deposit verification is EVM JSON-RPC (`BasePaymentVerifier.verifyErc20Transfer`); batch commitment is the EVM `PX402BatchCommitment` contract. Per-network deposit verifiers + batch committers already exist as maps (`deposits`, `batchCommitters`) with base fallbacks — the Robinhood port generalized this.

The Solana x402 DIRECT rail already exists (commit aa00e1a): `SolanaX402Facilitator`, `src/shared/x402Solana.ts`, ed25519 stealth + SLIP-0010 rotation, network `solana` (Circle USDC-SPL mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, caip2 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `X402TokenConfig.kind: "solana"`). `@solana/web3.js` + `@solana/spl-token` are already deps.

## Goal

Add `solana` as a THIRD private-ledger asset so verified USDC-SPL deposits fund a `solana:<mint>` balance, vouchers debit/credit it exactly like the EVM assets, and batches publish an aggregate Merkle root anchored on Solana. This closes the amount/timing leak on the Solana rail (currently Solana only has direct stealth+rotation). The voucher debit/credit path is already network-agnostic — the real work is: (1) a Solana deposit verifier, (2) a Solana batch anchor, (3) case-sensitivity fixes, (4) wiring + tests.

## CRITICAL: Solana base58 is CASE-SENSITIVE

The existing ledger lowercases addresses everywhere because EVM hex is case-insensitive. Solana mints/pubkeys are base58 and case-sensitive — lowercasing `EPjFWdd5…Dt1v` produces a DIFFERENT, invalid mint. Rule:
- The internal `assetKey` MAY stay lowercased (it is an opaque map/dedup key, and BOTH the deposit path and the quote path build it via `privateLedgerAssetKey`, so they stay consistent — do NOT change `privateLedgerAssetKey`).
- EVERY value used for ON-CHAIN verification or commitment must be CASE-PRESERVED: the depositor address, the treasury recipient, and the mint passed to the Solana verifier and the Solana batch committer.

Concrete sites to fix (all currently lowercase unconditionally — branch by the resolved network's `kind`, or preserve case for non-EVM):
1. `PrivateAgentRegistry.createPrivateLedgerDepositIntent`: `fromAddress` validation `^0x[a-fA-F0-9]{40}$` is EVM-only; for `kind:"solana"` validate a base58 pubkey (`new PublicKey(input.fromAddress)` — throws if invalid) and store it CASE-PRESERVED (do NOT `.toLowerCase()`). The response `asset`/`recipient` must also not be lowercased for solana.
2. `PrivatePaymentLedger.createSettlementBatch`: it stores `tokenAddress: input.tokenAddress.toLowerCase()`. Change to store `tokenAddress` case-preserved (keep the lowercased `asset`=assetKey as the grouping/dedup key). Safe for EVM (committer normalizes addresses anyway).
3. `createPrivateAgentServer` settlement-batch route: `const tokenAddress = String(body.asset ?? resolved.deposit.asset).toLowerCase()` — do NOT lowercase; pass the mint case-preserved into `createSettlementBatch({ tokenAddress })`.
4. Anywhere else a Solana mint/pubkey flows into verification or commitment, preserve case. Audit `confirmPrivateLedgerDeposit` — it passes `intent.fromAddress` (must be case-preserved for solana) + `deposit.asset`/`deposit.recipient` (from config, keep as-is) to `verifyTransfer`.

A test MUST catch a regression here (see tests): use the REAL mixed-case mint + a real base58 depositor, with a mock Solana verifier that asserts it received the EXACT case-preserved mint/from/recipient.

## 1. Solana deposit verifier (`src/server/base/SolanaPaymentVerifier.ts`, new)

Mirror the `verifyErc20Transfer` interface so it drops into the existing `PrivateLedgerDepositConfig.verifyTransfer` shape:
`async verifyErc20Transfer(input: { transactionHash; tokenAddress; fromAddress; recipient; amountAtomic }): Promise<unknown>` (keep the method name for interface compatibility, or introduce a shared `TokenTransferVerifier` interface both implement — your call, but the deposit config must accept either).
- Construct with `{ rpcUrl, connection? }` (allow DI of a `Connection` for tests).
- Fetch `connection.getParsedTransaction(transactionHash, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })`.
- Reject if: not found, `meta.err !== null`, or older than what a confirmed tx should be.
- Find a parsed SPL Token program instruction (`programId == TOKEN_PROGRAM_ID`, type `transfer` or `transferChecked`) where: the mint == `tokenAddress` (for `transferChecked` the mint is explicit; for `transfer` resolve via the destination ATA's mint from `meta.postTokenBalances`), the DESTINATION is the treasury's ATA for that mint (`getAssociatedTokenAddressSync(mint, new PublicKey(recipient))`), the SOURCE authority/owner == `fromAddress`, and the transferred amount `>= amountAtomic`. Prefer verifying via `meta.preTokenBalances`/`postTokenBalances` deltas on the treasury ATA (robust against instruction shape): the treasury ATA's USDC balance must increase by `>= amountAtomic` and the owner of the debited account must be `fromAddress`.
- Do NOT lowercase any base58 value. Compare with `PublicKey.equals`.
- Replay is already handled by the ledger (`consumedDepositHashes` with the `deposit:solana:<sig>` formula — verify the Robinhood port's `creditDeposit` uses `deposit:<network>:<tx>` for non-base; solana gets that automatically).

Security: the verifier is the trust boundary for crediting balances from public deposits. Be strict — wrong mint, wrong destination-owner, wrong source-owner, insufficient amount, unconfirmed, or failed tx must all reject.

## 2. Solana batch anchor (`src/server/base/SolanaBatchCommitter.ts`, new)

Same `commit(batch)` surface as `PrivateBatchCommitter`: `async commit(batch: { merkleRoot; tokenAddress; transferCount }): Promise<{ transactionHash?: string; alreadyCommitted: boolean }>`.
- Construct with `{ rpcUrl, settlerSecretKey, connection? }`. Reuse the base58 keypair decode already in `SolanaX402Facilitator` (extract it to a shared helper if clean, or duplicate the small decoder — do not add a dep).
- Build a tx whose only instruction is an SPL Memo (`new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from(memo, "utf8") })`), fee payer = settler, recent blockhash, sign with the settler, `sendRawTransaction` + confirm, return the signature.
- Memo format: `px402-batch:v1:<merkleRoot>:<tokenAddress>:<transferCount>` (mint CASE-PRESERVED). The tx signature is the public anchor; the ledger stores it via `markBatchCommitted`.
- No `committedAt` mapping exists on Solana; idempotency is already provided by the ledger (`unsettledBatch` returns the existing batch before creating a new one, `markBatchCommitted` sets `settledAt` once). Return `alreadyCommitted: false` on a fresh commit.

## 3. Config (`src/server/config.ts`)

Add under `solana`: `treasury: process.env.PX402_SOLANA_TREASURY ?? ""` (base58 pubkey that RECEIVES deposits; may be the settler's own pubkey). The Solana private-ledger deposit path is OPTIONAL — only wired when a treasury is available (explicit env, or derivable from the settler key). Batch anchoring needs the settler key. Do NOT fail startup when Solana ledger isn't configured (unlike the REQUIRED Base/Robinhood treasuries — keep that strict check for EVM only).

## 4. Wiring (`src/server/index.ts`)

Currently: `privateLedgerVerifiers` map has base+robinhood (required, `size !== 2` check); `privateLedgerDeposits` map has base+robinhood; `privateBatchCommitters` has base (+robinhood if configured).
- Add a Solana deposit entry ONLY when Solana ledger deposits are available: a `SolanaPaymentVerifier(config.solana.rpcUrl)` + a treasury (explicit `config.solana.treasury`, else the settler pubkey derived from `config.solana.x402.settlerSecretKey`, else skip). recipient = that treasury, asset = `config.solana.usdcMint` (CASE-PRESERVED).
- Add a Solana batch committer under "solana" when `config.solana.x402.settlerSecretKey` is set.
- Do NOT change the `size !== 2` EVM requirement (Solana is additive/optional). Keep base+robinhood exactly as-is.

## 5. Registry / server (`PrivateAgentRegistry.ts`, `createPrivateAgentServer.ts`)

The `private-quote`/`private-pay` voucher path is already network-generic (resolves the token via `resolveLedgerDeposit` -> `resolveX402Network`). Verify a `network: "solana"` private-quote resolves `SOLANA_USDC` and produces requirements with assetKey `solana:<lowercased-mint>` consistent with the deposit path. The only registry changes should be the CASE-SENSITIVITY fixes in section CRITICAL (deposit-intent fromAddress validation/storage by kind). Do NOT alter EVM behavior.

## Tests (all existing must stay green)

Extend `scripts/private-ledger-smoke.mjs` (currently 24 checks) with a Solana block:
- A Solana deposit via a MOCK `verifyErc20Transfer` that ASSERTS it received the exact CASE-PRESERVED mint (`EPjF…Dt1v`), a case-preserved base58 `fromAddress`, and the case-preserved treasury `recipient` (fail the test if any arrives lowercased) — credits the `solana:<mint>` assetKey and NOT base/robinhood.
- A Solana private voucher debits only the Solana balance; a base-only agent cannot pay a Solana voucher (cross-asset overspend rejected).
- A Solana settlement batch produces a distinct Merkle root, and a MOCK Solana committer receives the CASE-PRESERVED mint in `batch.tokenAddress` (fail if lowercased) + returns a signature that `markBatchCommitted` stores.
- assetKey consistency: the Solana deposit path and the Solana quote path resolve to the SAME assetKey.

New `scripts/solana-deposit-verify-smoke.mjs` (wire to `npm run test:ledger:solana`): unit-test `SolanaPaymentVerifier` with a DEPENDENCY-INJECTED `Connection` returning canned `getParsedTransaction` fixtures — accepts a valid confirmed USDC-SPL transfer to the treasury ATA of the right amount; rejects wrong mint, wrong destination owner, wrong source owner, amount below required, `meta.err != null`, and not-found. ~7+ checks. No network access.

## Docs (same diff)

- `CLAUDE.md` + `AGENTS.md`: new env var `PX402_SOLANA_TREASURY`; extend the private-ledger section to say Solana USDC-SPL is now a ledger asset (deposits verified via Solana RPC, batches anchored via SPL Memo `px402-batch:v1:...`), and that Solana batch anchoring uses a memo tx (no on-chain `committedAt` mapping — the tx signature is the anchor).
- `VERIFICATION.md`: add `npm run test:ledger:solana` and the new private-ledger Solana coverage line.

## Hard constraints

- Do NOT commit/push/touch git config or any `.env*`. Do NOT modify the x402 live-settle scripts or the direct Solana x402 files (`x402Solana.ts`, `SolanaX402Facilitator.ts`, `stealthSolana.ts`, `payerRotationSolana.ts`) EXCEPT to extract a shared base58 keypair decoder if you choose to (keep behavior identical).
- No NEW dependencies (use @solana/web3.js + @solana/spl-token, already present).
- TypeScript strict. Never log/hardcode secrets. Do NOT change EVM ledger behavior, the direct x402 rails, stealth, or rotation.
- Preserve case for all Solana base58 values in verification/commitment paths (see CRITICAL).

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
npm run proof:private-ledger-burn
npm run proof:private-ledger-adversary
```

All exit 0, zero FAIL lines (`test:x402:solana:onchain` network-dependent, INCONCLUSIVE offline is fine). Final report: files changed (absolute paths), per-suite passed/failed counts, build exit status, and any deviation from this spec with rationale.
