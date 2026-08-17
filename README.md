# PX-402

**A privacy-preserving x402 payment facilitator.**

PX-402 is a self-hostable facilitator service for [x402](https://www.x402.org/) machine-to-machine payments. Like other x402 facilitators, it verifies signed payment authorizations and settles them on-chain so that resource servers never need to hold keys or watch chains. Unlike other facilitators, PX-402 is built so that **the payment graph is not reconstructable** — not from the chain, and, to the greatest extent possible, not even from the facilitator's own disk.

## Supported rails

| Network | Asset | Mechanism | Settlement mode |
|---|---|---|---|
| Base (`eip155:8453`) | USDC | EIP-3009 `transferWithAuthorization` | on-chain or dry-run |
| Robinhood Chain (`eip155:4663`) | USDG | EIP-3009 `transferWithAuthorization` | on-chain or dry-run |
| Solana (mainnet) | USDC | SPL token transfer, fee-payer sponsored | on-chain or dry-run |
| Solana Token-2022 | confidential mint | confidential transfer extension (optional) | flag-gated |

Every rail runs **dry-run by default**: with no settler key configured, the facilitator verifies signatures, simulates settlement, and moves nothing. Loading a funded settler key is the explicit operator act that arms a rail.

## What makes it private

- **Private payment ledger** — agents deposit once into the facilitator treasury, then pay each other through identity-signed x402 transfers against a current-state-only ledger. Individual transfers never touch the chain.
- **Cryptographic erasure** — transfer details live in an ephemeral epoch journal (tmpfs-backed, per-epoch encryption keys). Burning the epoch key erases history; what persists is HMAC-keyed account balances and public Merkle batch commitments, nothing else.
- **Blind vouchers** — Chaumian ecash over ledger balances. The mint signs blinded notes in fixed denominations and cannot link issuance to redemption.
- **Batched, jittered exits** — withdrawals leave through a pool payout queue with commit-and-reveal jitter schedules, denomination quantization, adaptive concentration gating (k-effective), and optional denomination-pure exit cohorts.
- **Stealth addresses** — payouts land on one-time addresses derived from a payee meta-address (EVM secp256k1 and Solana ed25519 variants), with an announcement inbox so payees can locate and sweep funds.
- **Payer rotation** — the client SDK rotates one-time payer keys so repeated payments do not share a sender.
- **Public settlement commitments** — an on-chain `PX402BatchCommitment` contract publishes Merkle roots of settled batches: aggregate accountability without per-transfer disclosure.
- **Transparency without leakage** — `/api/privacy` publishes the deployment's actual privacy posture (never the requested one), including pool-payout schedule commitments anyone can verify after the fact.

## Layout

```
src/server/        the facilitator service
  index.ts         boot: verifiers → ledger → vouchers → rails → payout queue → RPC
  config.ts        all PX402_* environment configuration + boot-time validation
  base/            x402 facilitators (EVM + Solana), verifiers, batch committers,
                   transaction coordinator (nonce/fee/finality management)
  payments/        private ledger, ephemeral journal, blind voucher mint,
                   pool payout queue, deposit books, stealth inbox books
  rails/           per-chain settlement rails (Base / Robinhood / Solana)
  agents/          agent registry + the private RPC surface (/private/a2a/*)
  http/            public status server (health, privacy, stealth inbox routes)
src/shared/        protocol crypto shared with clients: x402 payloads, stealth
                   derivation, blind voucher blinding, payout plans, intents
src/client/        browser stealth-inbox client
src/node/          node-side voucher wallet file helper
contracts/         PX402BatchCommitment.sol
scripts/           smoke tests, on-chain sims, audits, deploy helpers
docs/              design specs (privacy invariants, threat models)
```

## Quick start

```bash
npm install
cp .env.example .env       # defaults boot a fully dry-run facilitator
npm start
```

Two listeners come up:

- `http://127.0.0.1:8787` — public status: `/api/health`, `/api/privacy`, `/api/privacy/pool-payout-schedule`, `/api/stealth/*`
- `http://127.0.0.1:3099` — private agent RPC: `/private/a2a/quote`, `/private/a2a/pay`, `/private/a2a/private-quote`, `/private/a2a/private-pay`, deposits, pool payouts, vouchers, stealth inbox, `/private/settlement/batch`

The private RPC is designed to sit behind WireGuard; agent endpoints are bound to VPN peer addresses and wallet identities at registration.

## Tests

```bash
npm test                       # core offline suite (no network, no keys)
npm run test:x402              # x402 sign/verify/settle round trip
npm run test:x402:private-ledger
npm run test:blind-vouchers
npm run test:pool-payout
npm run test:stealth
npm run test:x402:fork         # settle against a local fork
npm run test:confidential:devnet  # Token-2022 confidential proof on devnet
```

Live-settlement scripts (`x402:settle-live`, `x402:pool-payout-live`, …) move real funds and refuse to run alongside a live server holding the same settler key.

## Deploying the batch commitment contract

```bash
npm run contracts:compile
npm run contracts:deploy:private-batch   # needs RPC + deployer key env, see script
```

Set the resulting address as `PX402_PRIVATE_BATCH_CONTRACT` (Base) or `PX402_RH_PRIVATE_BATCH_CONTRACT` (Robinhood Chain).

## Security posture

- No plaintext durable state: every book on disk is AES-encrypted under `PX402_DATA_ENCRYPTION_KEY`.
- The ephemeral epoch journal refuses non-tmpfs storage in production (`PX402_PRIVATE_LEDGER_REQUIRE_TMPFS`).
- Privacy flags fail loud: a half-configured privacy feature refuses to boot rather than silently advertising a capability it does not have.
- Static payout concentration targets above 1 are rejected in production — a privacy guarantee that must hold at N=1 cannot depend on cover traffic arriving.

See `docs/` for the full design specs and threat models.

## License

MIT
