import { Keypair } from "@solana/web3.js";
import {
  createSolanaPayerPool,
  deriveSolanaPayerKeypair,
  deriveSolanaPayerSeed,
  nextSolanaPayerKeypair,
  restoreSolanaPayerPool
} from "../src/shared/payerRotationSolana.ts";

let pass = 0, fail = 0;
const ok = (condition, message) => condition
  ? (pass += 1, console.log("PASS", message))
  : (fail += 1, console.log("FAIL", message));

const run = () => {
  const original = createSolanaPayerPool();
  const first = nextSolanaPayerKeypair(original);
  const second = nextSolanaPayerKeypair(first.pool);
  ok(first.index === 0 && second.index === 1 && second.pool.nextIndex === 2, "pool advances its hardened child index");
  ok(first.keypair.publicKey.toBase58() !== second.keypair.publicKey.toBase58(), "successive payer addresses are distinct");
  ok(first.keypair instanceof Keypair && first.keypair.secretKey.length === 64, "derived payer is a valid Solana Keypair");
  ok(deriveSolanaPayerKeypair(original.seed, 0).publicKey.equals(first.keypair.publicKey), "index zero is deterministic from the seed");
  ok(deriveSolanaPayerKeypair(original.seed, 1).publicKey.equals(second.keypair.publicKey), "index one is deterministic from the seed");

  const restored = restoreSolanaPayerPool(original.seed);
  const restoredFirst = nextSolanaPayerKeypair(restored);
  const restoredSecond = nextSolanaPayerKeypair(restoredFirst.pool);
  ok(restoredFirst.keypair.publicKey.equals(first.keypair.publicKey) && restoredSecond.keypair.publicKey.equals(second.keypair.publicKey), "restoring the seed reproduces the address sequence");
  ok(Buffer.from(deriveSolanaPayerSeed(original.seed, 0)).equals(Buffer.from(first.keypair.secretKey.subarray(0, 32))), "SLIP-0010 output is the Keypair seed");
  ok(original.seed.length === 64 && original.nextIndex === 0, "pool retains a recoverable 256-bit seed without mutation");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
};

try {
  run();
} catch (error) {
  console.error("Solana payer rotation smoke crashed:", error);
  process.exitCode = 1;
}
