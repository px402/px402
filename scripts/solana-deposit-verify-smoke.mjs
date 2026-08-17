import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SolanaPaymentVerifier } from "../src/server/base/SolanaPaymentVerifier.ts";
import { SOLANA_USDC_MINT } from "../src/shared/x402.ts";

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition
  ? (pass++, console.log("PASS", message))
  : (fail++, console.log("FAIL", message));

const depositor = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const sourceAccount = Keypair.generate().publicKey;
const mint = new PublicKey(SOLANA_USDC_MINT);
const transactionHash = Keypair.generate().publicKey.toBase58();
let fixture;
let requestedConfig;
const connection = {
  getParsedTransaction: async (_signature, config) => {
    requestedConfig = config;
    return fixture;
  },
};
const verifier = new SolanaPaymentVerifier({ rpcUrl: "http://unused", connection });
const proof = {
  transactionHash,
  tokenAddress: SOLANA_USDC_MINT,
  fromAddress: depositor.toBase58(),
  recipient: treasury.toBase58(),
  amountAtomic: "250000",
};

const tokenAmount = (amount) => ({
  amount: String(amount),
  decimals: 6,
  uiAmount: Number(amount) / 1_000_000,
  uiAmountString: (Number(amount) / 1_000_000).toString(),
});

const buildFixture = ({
  fixtureMint = mint,
  destinationOwner = treasury,
  sourceOwner = depositor,
  authority = sourceOwner,
  amount = 250000n,
  type = "transferChecked",
  metaErr = null,
} = {}) => {
  const destination = getAssociatedTokenAddressSync(fixtureMint, treasury);
  const info = {
    source: sourceAccount.toBase58(),
    destination: destination.toBase58(),
    authority: authority.toBase58(),
    ...(type === "transferChecked"
      ? { mint: fixtureMint.toBase58(), tokenAmount: tokenAmount(amount) }
      : { amount: amount.toString() }),
  };
  return {
    slot: 123,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: {
      signatures: [transactionHash],
      message: {
        accountKeys: [
          { pubkey: depositor, signer: true, writable: true },
          { pubkey: sourceAccount, signer: false, writable: true },
          { pubkey: destination, signer: false, writable: true },
          { pubkey: fixtureMint, signer: false, writable: false },
        ],
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [{
          program: "spl-token",
          programId: TOKEN_PROGRAM_ID,
          parsed: { type, info },
        }],
      },
    },
    meta: {
      err: metaErr,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: [],
      logMessages: [],
      preTokenBalances: [
        { accountIndex: 1, mint: fixtureMint.toBase58(), owner: sourceOwner.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(1_000_000n) },
        { accountIndex: 2, mint: fixtureMint.toBase58(), owner: destinationOwner.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(0n) },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: fixtureMint.toBase58(), owner: sourceOwner.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(1_000_000n - amount) },
        { accountIndex: 2, mint: fixtureMint.toBase58(), owner: destinationOwner.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: tokenAmount(amount) },
      ],
      rewards: [],
    },
  };
};

const rejects = async (candidate, candidateProof = proof) => {
  fixture = candidate;
  try {
    await verifier.verifyErc20Transfer(candidateProof);
    return false;
  } catch {
    return true;
  }
};

fixture = buildFixture();
const accepted = await verifier.verifyErc20Transfer(proof);
ok(accepted.transactionHash === transactionHash
  && requestedConfig.commitment === "confirmed"
  && requestedConfig.maxSupportedTransactionVersion === 0,
"confirmed transferChecked into the treasury ATA is accepted");

fixture = buildFixture({ type: "transfer" });
await verifier.verifyErc20Transfer(proof);
ok(true, "parsed transfer resolves its mint from token-balance metadata");

ok(await rejects(buildFixture({ fixtureMint: Keypair.generate().publicKey })),
  "a transfer of the wrong mint is rejected");
ok(await rejects(buildFixture({ destinationOwner: Keypair.generate().publicKey })),
  "a destination token account with the wrong treasury owner is rejected");
ok(await rejects(buildFixture({ sourceOwner: Keypair.generate().publicKey })),
  "a source token account with the wrong depositor owner is rejected");
ok(await rejects(buildFixture({ amount: 249999n })),
  "an amount below the required atomic amount is rejected");
ok(await rejects(buildFixture({ metaErr: { InstructionError: [0, "Custom"] } })),
  "a failed transaction is rejected");
ok(await rejects(null), "a transaction not found at confirmed commitment is rejected");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
