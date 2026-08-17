# PX-402

Privacy-preserving x402 payment facilitator. TypeScript, Node 22+, no framework — plain `node:http`, `tsx` for execution, `tsc` for typechecking only (`noEmit`).

## Repository identity — STRICT, non-negotiable

This project lives under its **own dedicated PX402 GitHub account and nothing else**. Every outward-facing and version-control artifact carries the PX402 identity only:

- **Git commit author + committer** must be the PX402 account identity (PX402 username + its GitHub `…@users.noreply.github.com` email). Never commit under a personal or any other account's name/email. Set this as a **repo-local** `user.name`/`user.email` so a machine's global git identity can never leak in.
- **Remote** must point only at the PX402 account's repository. No personal-account remotes, forks, or mirrors.
- **No cross-account references anywhere in the tree or history** — no personal usernames, emails, other GitHub handles, private-repo URLs, or org names in code, comments, commit messages, docs, or PR/issue text. The only identity that may appear is PX402.
- If a tool or command would attribute work to another account, stop and correct the identity first — do not push and "fix later".

This rule outranks convenience. A commit or push made under the wrong identity is a defect to be rewritten before it leaves the machine.

## Non-negotiable invariants

- **Dry-run by default.** No settler key ⇒ verify + simulate only. Loading a funded key is the explicit operator act that arms a rail. Never invert this.
- **Privacy flags fail loud.** A half-configured privacy feature must refuse to boot, not silently no-op. A flag that reads as "enabled" while doing nothing is banned (scaffolding theater).
- **No plaintext durable state.** Every book on disk goes through `EncryptedJsonFile` under `PX402_DATA_ENCRYPTION_KEY`. Transfer detail lives only in the ephemeral epoch journal (tmpfs, per-epoch keys, erased by key burn).
- **Wire-format stability.** The `px402-*` domain-separation tags in `src/shared/` (blind voucher domains, intent protocols, ledger schemes) are consumed by deployed clients. Changing one is a breaking protocol change — version it (`/v2`), never edit in place.
- **The privacy panel never overstates or understates.** `/api/privacy` and `/api/stealth/config` report the RESOLVED posture (derived from live rails/keys), never the requested env value.
- **Static payout concentration K>1 is rejected in production.** Privacy guarantees must hold at N=1; use the adaptive target.

## Layout

- `src/server/index.ts` — boot wiring. Order matters: recovery and queue arming complete before either listener binds.
- `src/server/config.ts` — all `PX402_*` env + boot validation. New env vars go here with validation, and into `.env.example` in the same diff.
- `src/server/base/` — facilitators (EIP-3009 EVM, Solana), verifiers, batch committers, transaction coordinator.
- `src/server/payments/` — private ledger, ephemeral journal, blind voucher mint, pool payout queue, deposit + stealth inbox books.
- `src/server/rails/` — per-chain settlement rails behind the `ChainRail` interface.
- `src/server/agents/` — endpoint registry + the private RPC (`/private/a2a/*`).
- `src/shared/` — protocol crypto shared with clients. Server and client MUST import the same module for any signed/blinded byte layout.
- `docs/` — design specs. Code comments cite them (`docs/spec-exit-rounds.md §4`); keep citations valid when editing either side.

## Testing

- `npm run typecheck` must be clean before any commit.
- `npm test` runs the core offline suite (no network, no keys). Run the suite matching what you touched (`test:blind-vouchers`, `test:pool-payout`, `test:stealth`, …) plus `test:x402`.
- Scripts named `*-live` move real funds and carry a settler-key exclusion warning — never run them casually, never in CI.
- Smokes import TS sources directly via `tsx`; keep `src/` layout stable or fix every script in the same diff.

## Conventions

- TypeScript strict; no new dependencies without discussion (the dependency surface is part of the security posture).
- Comments explain invariants and threat-model reasoning, not mechanics. Preserve existing invariant comments when refactoring — they encode incident history.
- Every env var: validated at boot, documented in `.env.example`, prefixed `PX402_`.
