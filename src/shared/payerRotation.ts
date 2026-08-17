import { HDNodeWallet, Mnemonic, randomBytes } from "ethers";

// Phase 2 of on-chain payment privacy: payer-side address rotation. Each x402
// payment is signed from a FRESH, deterministically-derived address rather than
// the agent's persistent identity wallet, so observers cannot cluster an agent's
// payments by sender. Combined with Phase 1 stealth (fresh recipient), a single
// payment links no persistent sender NOR recipient on-chain.
//
// HONEST LIMITS — read before relying on this:
//  - The rotation is recoverable: all fresh keys derive from one seed, so the
//    agent can sweep change/dust. That seed must stay secret.
//  - The FUNDING of each fresh payer address is the linkability bottleneck. A
//    fresh address needs USDC to spend; whoever sends it USDC creates an on-chain
//    link (funder -> fresh payer). EIP-3009 is gasless (the settler pays gas), so
//    the fresh address needs NO ETH — removing the gas-funding link — but the
//    USDC funding link remains. Breaking it fully needs an unlinkable source
//    (e.g. CEX withdrawal per address) or a ZK/shielded pool. Pure rotation
//    hides the *identity* wallet, not the money trail.
//  - Amounts + timing are still public (Phase 3 / ZK territory).

const DERIVATION_BASE = "m/44'/60'/0'/0";

export interface PayerPool {
  mnemonic: string; // the rotation seed — KEEP SECRET; recovers every fresh key
  nextIndex: number;
}

/** Create a fresh payer pool (a new rotation seed). */
export const createPayerPool = (): PayerPool => {
  const mnemonic = Mnemonic.fromEntropy(randomBytes(32)).phrase;
  return { mnemonic, nextIndex: 0 };
};

/** Restore a pool from a saved seed (and the next index to use). */
export const restorePayerPool = (mnemonic: string, nextIndex = 0): PayerPool => ({ mnemonic, nextIndex });

/** Deterministically derive the payer wallet at a given index (recoverable). */
export const derivePayerWallet = (mnemonic: string, index: number): HDNodeWallet =>
  HDNodeWallet.fromPhrase(mnemonic, undefined, `${DERIVATION_BASE}/${index}`);

/**
 * Take the next fresh payer wallet. Returns the wallet, its index, and an
 * advanced pool (immutably — persist `pool.nextIndex` so an address is never
 * reused).
 */
export const nextPayerWallet = (pool: PayerPool): { wallet: HDNodeWallet; index: number; pool: PayerPool } => {
  const index = pool.nextIndex;
  const wallet = derivePayerWallet(pool.mnemonic, index);
  return { wallet, index, pool: { ...pool, nextIndex: index + 1 } };
};

/** Re-derive every used address (e.g. to scan balances / sweep dust). */
export const derivePayerWallets = (mnemonic: string, count: number): HDNodeWallet[] =>
  Array.from({ length: count }, (_unused, i) => derivePayerWallet(mnemonic, i));

/** Convenience: a one-off random fresh payer (non-recoverable — use the pool instead for sweepable funds). */
export const ephemeralPayer = (): HDNodeWallet => HDNodeWallet.createRandom();
