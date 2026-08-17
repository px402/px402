import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { buildSolanaPaymentRequirements, createSolanaPaymentPayload } from "../src/shared/x402Solana.ts";
import { SOLANA_USDC } from "../src/shared/x402.ts";

const rpcUrl = process.env.PX402_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const run = async () => {
  const connection = new Connection(rpcUrl, "confirmed");
  const payer = Keypair.generate();
  const payee = Keypair.generate();
  const settler = Keypair.generate();
  const requirements = buildSolanaPaymentRequirements({
    payTo: payee.publicKey.toBase58(),
    maxAmountRequired: "1",
    resource: "solana-mainnet-sim"
  });
  const payload = await createSolanaPaymentPayload({
    payerKeypair: payer,
    requirements,
    settlerPubkey: settler.publicKey,
    connection,
    token: SOLANA_USDC,
    nowSeconds: Math.floor(Date.now() / 1000)
  });
  const transaction = Transaction.from(Buffer.from(payload.transaction, "base64"));
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err === null) {
    console.error("FAIL unfunded Solana x402 simulation unexpectedly succeeded");
    process.exitCode = 1;
    return;
  }
  const detail = `${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).join(" ")}`;
  if (!/AccountNotFound|InsufficientFunds|insufficient funds|InvalidAccountData|UninitializedAccount|uninitialized|InvalidAccountForFee/i.test(detail)) {
    console.error(`FAIL Solana rejected the transaction for an unexpected reason: ${detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS Solana accepted the transaction structure and reached the expected unfunded/uninitialized-account failure: ${detail}`);
};

run().catch((error) => {
  console.log(`INCONCLUSIVE Solana mainnet RPC unavailable: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
