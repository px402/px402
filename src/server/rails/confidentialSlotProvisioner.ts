/**
 * The PAYEE half of the slot-provisioning ceremony
 * (spec-confidential-x402.md §5.2-P, §15.3 step 2).
 *
 * This is agent-side code that happens to live in the repo, and the separation
 * is not stylistic. Only the OWNER of a confidential account may configure it —
 * measured on devnet as `Missing required signature for instruction
 * (instruction #2)` — and the owner is a one-time stealth key derived from
 * `kSpend`. The server holds only a viewing key, so it structurally cannot build
 * this plan, and the spending scalar must never reach it.
 *
 * What the payee produces is a batch of slots plus a partially-signed plan; the
 * server funds the rent and broadcasts. The payee learns nothing about future
 * payers, and the server learns nothing that lets it spend.
 *
 * WHY THE PAYEE PICKS `R`: nothing in DKSAP requires the payer to choose the
 * ephemeral key, and here it cannot — the account must exist and be configured
 * before any payer is involved. So the payee derives the one-time address, keeps
 * the scalar, and publishes `(address, R, P, ATA)` as a slot the server hands
 * out exactly once.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  deriveSolanaStealthAddress,
  recoverSolanaStealthScalar,
  signSolanaWithScalar,
  type SolanaStealthKeys,
} from "../../shared/stealthSolana";

export interface ProvisionedSlotDraft {
  /** Published: the one-time address that will own the confidential account. */
  stealthAddress: string;
  /** Published: the announcement `R`. Without it the payee cannot re-derive. */
  ephemeralPubKey: string;
  /** Published: `P`, base58 of `ElGamalPubkey.toBytes()`. */
  encryptionPubKey: string;
  /** Published: the Token-2022 ATA the slot's payments credit. */
  tokenAccount: string;
  /**
   * NEVER published. The one-time scalar that owns the account and can sweep it.
   * Recoverable from `(R, kView, kSpend)` alone, so an agent that keeps its seed
   * does not need to retain this — which is exactly why it must not be sent.
   */
  stealthScalar: string;
}

/**
 * Derives a batch of slot drafts from a payee's stealth keys.
 *
 * Pure and offline: no RPC, no chain state, no server round trip. The
 * on-chain part is `buildConfigurePlan`, which needs the Token-2022 stack and is
 * therefore kept separate so this half stays testable without a cluster.
 */
export const deriveSlotDrafts = (input: {
  keys: SolanaStealthKeys;
  mint: string;
  count: number;
  /**
   * Derives the ElGamal + AE keypair for a one-time address. Injected rather
   * than imported so this module carries no WASM dependency: the confidential
   * stack hard-codes `@solana/zk-sdk/bundler`, and a second instance in the same
   * process reads the wrong heap and returns plausible wrong values instead of
   * throwing (§5.3).
   */
  deriveEncryptionPubKey: (draft: { stealthScalar: string; stealthAddress: string; mint: string }) => string;
  /** Token-2022 ATA derivation, injected for the same reason. */
  deriveTokenAccount: (input: { owner: string; mint: string }) => string;
}): ProvisionedSlotDraft[] => {
  if (!Number.isInteger(input.count) || input.count <= 0) {
    throw new Error("slot batch count must be a positive integer");
  }
  const drafts: ProvisionedSlotDraft[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.count; index += 1) {
    const derived = deriveSolanaStealthAddress(input.keys.meta);
    // `R` is freshly random per slot, so a repeat means the RNG is broken —
    // and two slots sharing an address would let the first payer decrypt the
    // second payment. Cheap to check, catastrophic to miss.
    if (seen.has(derived.stealthAddress)) {
      throw new Error("duplicate stealth address in a slot batch — refusing to provision");
    }
    seen.add(derived.stealthAddress);
    const stealthScalar = recoverSolanaStealthScalar({
      ephemeralPubKey: derived.ephemeralPubKey,
      viewingScalar: input.keys.viewingScalar,
      spendingScalar: input.keys.spendingScalar,
      expectedAddress: derived.stealthAddress,
    });
    drafts.push({
      stealthAddress: derived.stealthAddress,
      ephemeralPubKey: derived.ephemeralPubKey,
      encryptionPubKey: input.deriveEncryptionPubKey({
        stealthScalar,
        stealthAddress: derived.stealthAddress,
        mint: input.mint,
      }),
      tokenAccount: input.deriveTokenAccount({ owner: derived.stealthAddress, mint: input.mint }),
      stealthScalar,
    });
  }
  return drafts;
};

/**
 * Strips the batch down to what may cross the wire.
 *
 * An explicit projection rather than a spread-and-delete, so adding a secret
 * field to `ProvisionedSlotDraft` later cannot silently start publishing it.
 */
export const publishableSlots = (drafts: ProvisionedSlotDraft[]) =>
  drafts.map((draft) => ({
    stealthAddress: draft.stealthAddress,
    ephemeralPubKey: draft.ephemeralPubKey,
    encryptionPubKey: draft.encryptionPubKey,
    tokenAccount: draft.tokenAccount,
  }));

/**
 * A signer backed by a RAW stealth SCALAR.
 *
 * A one-time stealth key is `kSpend + H(kView·R)` — a scalar with no ed25519
 * SEED behind it, so `Keypair.fromSecretKey` cannot represent it and every
 * standard signer API is unusable. Signing has to go through the scalar
 * directly.
 */
export const stealthOwnerSigner = (draft: ProvisionedSlotDraft) => ({
  publicKey: new PublicKey(draft.stealthAddress),
  sign: (message: Uint8Array) => signSolanaWithScalar(draft.stealthScalar, message),
});

/** Guard used by the batch tests: a draft must never be logged or serialized. */
export const assertNoScalarLeaked = (payload: unknown, drafts: ProvisionedSlotDraft[]): void => {
  const blob = JSON.stringify(payload).toLowerCase();
  const leaked = drafts
    .map((draft) => draft.stealthScalar.toLowerCase().replace(/^0x/, ""))
    .filter((scalar) => scalar.length > 0 && blob.includes(scalar));
  if (leaked.length > 0) {
    throw new Error(`slot provisioning payload leaked ${leaked.length} spending scalar(s)`);
  }
};

/** Only used by tests that need a throwaway fee payer. */
export const throwawayFeePayer = () => Keypair.generate();
