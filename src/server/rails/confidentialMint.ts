/**
 * Startup assertion for a Token-2022 confidential mint
 * (spec-confidential-x402.md §5.1, §9).
 *
 * `confidentialMode` is `readonly` on `ConfidentialRail`, so it cannot be a
 * promise — but one of its conjuncts is an async RPC fact: does this mint
 * actually exist, does it carry the ConfidentialTransferMint extension, and is
 * its auditor key null? A config value cannot answer that. A config value can
 * only tell you what someone TYPED.
 *
 * So the rail resolves this once at startup and caches it, and reads `dry-run`
 * until it has. The auditor check is the load-bearing one: a non-null
 * `auditorElgamalPubkey` is a universal decryption backdoor — whoever holds that
 * key reads every amount on the mint, forever, and the confidentiality we would
 * be advertising would be a lie against a party we cannot see.
 *
 * `@solana/zk-sdk/bundler` is imported nowhere in this file on purpose: it is
 * only reachable through `@solana-program/token-2022/confidential`, which
 * hard-codes that subpath. Importing `/node` anywhere in the process would
 * create a SECOND WASM instance whose cross-instance calls do not throw — they
 * read the wrong heap and return plausible values (§5.3).
 */
import { fetchMint, type Mint } from "@solana-program/token-2022";
import { address, type Address, type Rpc, type GetAccountInfoApi } from "@solana/kit";

export type ConfidentialMintVerdict =
  | { capable: true; mint: string; decimals: number }
  | { capable: false; reason: ConfidentialMintRejection; detail?: string };

export type ConfidentialMintRejection =
  | "not-configured" // no mint set — the ordinary flag-off state
  | "unreadable" // RPC failure or missing account; NEVER treated as capable
  | "not-confidential" // a real mint, but without the extension
  | "auditor-present" // the backdoor case
  | "manual-approval"; // every account needs the issuer's signature — see below

/** The extension name as Codama generates it on the decoded mint. */
const CONFIDENTIAL_EXTENSION = "ConfidentialTransferMint";

interface ConfidentialTransferMintExtension {
  __kind: typeof CONFIDENTIAL_EXTENSION;
  auditorElgamalPubkey?: unknown;
  autoApproveNewAccounts?: unknown;
}

/**
 * Reads the extension off a decoded mint. Kept separate and pure so the
 * auditor rule can be unit-tested without an RPC.
 */
export const readConfidentialExtension = (
  mint: Pick<Mint, "extensions">,
): ConfidentialTransferMintExtension | undefined => {
  const extensions = mint.extensions;
  if (!extensions || extensions.__option !== "Some") return undefined;
  const found = (extensions.value as { __kind: string }[])
    .find((extension) => extension.__kind === CONFIDENTIAL_EXTENSION);
  return found as ConfidentialTransferMintExtension | undefined;
};

/**
 * True only when the mint provably has NO auditor.
 *
 * Codama encodes the optional as `{ __option: "None" }` / `{ __option: "Some" }`,
 * but a plain `null`/`undefined` is also possible depending on the decoder
 * version. Anything we do not positively recognise as absent is treated as
 * PRESENT — the failure direction matters here, and refusing to serve a mint we
 * cannot vet is free while serving one with a backdoor is not.
 */
export const auditorIsAbsent = (extension: ConfidentialTransferMintExtension): boolean => {
  const auditor = extension.auditorElgamalPubkey;
  if (auditor === null || auditor === undefined) return true;
  if (typeof auditor === "object" && (auditor as { __option?: string }).__option === "None") {
    return true;
  }
  return false;
};

/**
 * True only when new accounts are provably auto-approved.
 *
 * MEASURED against mainnet, and it is the check that decides whether this rail
 * can work on a given asset at all. A confidential account must be APPROVED
 * before it can receive, and with `autoApproveNewAccounts: false` that approval
 * is a separate instruction signed by the mint's confidential-transfer
 * authority — the ISSUER, not us.
 *
 * §5.2-P provisions a fresh one-time slot per payment, so "the issuer signs for
 * every account" is not a hurdle, it is a contradiction: we would have to ask
 * Paxos to approve each stealth address, which is operationally impossible AND
 * would hand them the very linkage the scheme exists to destroy.
 *
 * This is not hypothetical. Mainnet **PYUSD** (`2b1kV6Dk…`) and **USDG**
 * (`2u1tszSe…`) both carry `ConfidentialTransferMint` with a null auditor and
 * both set this to `false`. Without this check they read as CAPABLE: the rail
 * would go `onchain`, provisioning would spend real rent creating accounts, the
 * ElGamal read-back would succeed, slots would register — and then every
 * payment into them would fail. Burned rent and a pool of dead slots.
 *
 * Fails the same direction as the auditor check: anything not positively
 * recognised as `true` is treated as manual approval.
 */
export const autoApprovesNewAccounts = (extension: ConfidentialTransferMintExtension): boolean =>
  extension.autoApproveNewAccounts === true;

/**
 * Resolve whether a mint may serve the confidential rail. Never throws for
 * ordinary "not configured" or RPC failure — those are verdicts, and the caller
 * stays in dry-run. Only a programming error escapes.
 */
export const assertConfidentialMint = async (input: {
  rpc: Rpc<GetAccountInfoApi>;
  mint: string;
}): Promise<ConfidentialMintVerdict> => {
  if (!input.mint) return { capable: false, reason: "not-configured" };
  let decoded: Mint;
  try {
    const account = await fetchMint(input.rpc as never, address(input.mint) as Address, {
      commitment: "confirmed",
    });
    decoded = account.data;
  } catch (error) {
    // An unreadable mint is NOT an absent auditor. Stay dry-run.
    return {
      capable: false,
      reason: "unreadable",
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }
  const extension = readConfidentialExtension(decoded);
  if (!extension) return { capable: false, reason: "not-confidential" };
  if (!auditorIsAbsent(extension)) {
    // Loud: this is a silent-confidentiality-loss configuration, and an
    // operator who set it probably believes the opposite.
    console.error(
      `CONFIDENTIAL_MINT_REJECTED mint=${input.mint} reason=auditor_present`
      + " — a non-null auditorElgamalPubkey decrypts every amount on this mint",
    );
    return { capable: false, reason: "auditor-present" };
  }
  if (!autoApprovesNewAccounts(extension)) {
    // Loud, because this mint looks perfect on every other axis and an operator
    // who set it is about to spend real rent on slots that can never receive.
    console.error(
      `CONFIDENTIAL_MINT_REJECTED mint=${input.mint} reason=manual_approval`
      + " — autoApproveNewAccounts is false, so the issuer must sign for every"
      + " account; §5.2-P provisions a fresh one per payment",
    );
    return { capable: false, reason: "manual-approval" };
  }
  return { capable: true, mint: input.mint, decimals: decoded.decimals };
};
