import { ed25519 } from "@noble/curves/ed25519";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { randomNonce, SOLANA_USDC, type X402TokenConfig } from "./x402";
import type { SolanaStealthMetaAddress } from "./stealthSolana";
import type { PayoutPolicyAdvertisement } from "./payoutPlan";

export interface SolanaX402PaymentRequirements {
  x402Version: 1;
  scheme: "exact";
  network: "solana";
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  nonce: string;
  validForSeconds: number;
  stealthMetaAddress?: SolanaStealthMetaAddress;
  payoutPolicy?: PayoutPolicyAdvertisement;
}

export interface SolanaX402PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: "solana";
  asset: string;
  payer: string;
  transaction: string;
}

export interface SolanaX402VerifyResult {
  ok: true;
  payer: string;
  payTo: string;
  value: string;
  transaction: Transaction;
}

export type SolanaPaymentBuildConnection = Pick<Connection, "getLatestBlockhash" | "getAccountInfo">;

export const buildSolanaPaymentRequirements = (input: {
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  validForSeconds?: number;
  token?: X402TokenConfig;
}): SolanaX402PaymentRequirements => {
  const token = requireSolanaToken(input.token ?? SOLANA_USDC);
  if (BigInt(input.maxAmountRequired) <= 0n) throw new Error("maxAmountRequired must be positive");
  return {
    x402Version: 1,
    scheme: "exact",
    network: "solana",
    asset: new PublicKey(token.address).toBase58(),
    payTo: new PublicKey(input.payTo).toBase58(),
    maxAmountRequired: input.maxAmountRequired,
    resource: input.resource,
    description: input.description,
    nonce: randomNonce(),
    validForSeconds: input.validForSeconds ?? 600
  };
};

/**
 * The agent-facing Solana quote: pick `payTo` from the payee's stealth meta when
 * it has one, and attach the meta so the payer derives a fresh one-time address.
 *
 * Extracted because this logic existed VERBATIM in two places — `SolanaChainRail
 * .buildQuote` and the no-rail fallback in `PrivateAgentRegistry.buildX402Quote`
 * — so a quote could differ depending on whether a rail happened to be
 * configured. Any future field (the `confidential` advertisement is the next
 * one) would have had to be added to both, and silently degrading privacy on
 * the fallback path is exactly the kind of drift nothing would have caught.
 *
 * Structurally typed on the payee so this module stays free of server imports.
 */
export const buildSolanaAgentQuote = (input: {
  payee: { walletAddress: string; solanaStealthMeta?: SolanaStealthMetaAddress };
  amountAtomic: string;
  resource: string;
  validForSeconds: number;
  token: X402TokenConfig;
}): SolanaX402PaymentRequirements => {
  const requirements = buildSolanaPaymentRequirements({
    payTo: input.payee.solanaStealthMeta?.spendingPubKey ?? input.payee.walletAddress,
    maxAmountRequired: input.amountAtomic,
    resource: input.resource,
    validForSeconds: input.validForSeconds,
    token: input.token
  });
  if (input.payee.solanaStealthMeta) requirements.stealthMetaAddress = input.payee.solanaStealthMeta;
  return requirements;
};

export const createSolanaPaymentPayload = async (input: {
  payerKeypair: { publicKey: PublicKey; secretKey: Uint8Array };
  requirements: SolanaX402PaymentRequirements;
  settlerPubkey: PublicKey | string;
  connection: SolanaPaymentBuildConnection;
  nowSeconds: number;
  token?: X402TokenConfig;
}): Promise<SolanaX402PaymentPayload> => {
  const token = requireSolanaToken(input.token ?? SOLANA_USDC);
  assertRequirements(input.requirements, token);
  void input.nowSeconds;
  const mint = new PublicKey(token.address);
  const payer = input.payerKeypair.publicKey;
  const payTo = new PublicKey(input.requirements.payTo);
  const settler = asPublicKey(input.settlerPubkey);
  const sourceAta = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const transaction = new Transaction({
    feePayer: settler,
    recentBlockhash: (await input.connection.getLatestBlockhash()).blockhash
  });
  if ((await input.connection.getAccountInfo(destinationAta)) === null) {
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(
      settler,
      destinationAta,
      payTo,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }
  transaction.add(createTransferCheckedInstruction(
    sourceAta,
    mint,
    destinationAta,
    payer,
    BigInt(input.requirements.maxAmountRequired),
    token.decimals,
    [],
    TOKEN_PROGRAM_ID
  ));
  transaction.partialSign(input.payerKeypair);
  return {
    x402Version: 1,
    scheme: "exact",
    network: "solana",
    asset: mint.toBase58(),
    payer: payer.toBase58(),
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64")
  };
};

export const verifySolanaPayment = (input: {
  payload: SolanaX402PaymentPayload;
  requirements: SolanaX402PaymentRequirements;
  settlerPubkey: PublicKey | string;
  token?: X402TokenConfig;
  nowSeconds?: number;
}): SolanaX402VerifyResult => {
  const token = requireSolanaToken(input.token ?? SOLANA_USDC);
  const { payload, requirements } = input;
  assertRequirements(requirements, token);
  void input.nowSeconds;
  if (payload.x402Version !== 1 || payload.scheme !== "exact") throw new Error("Unsupported Solana x402 scheme");
  if (payload.network !== "solana") throw new Error("Solana payment network mismatch");
  if (new PublicKey(payload.asset).toBase58() !== new PublicKey(token.address).toBase58()) {
    throw new Error("Solana payment asset mismatch");
  }

  let transaction: Transaction;
  try {
    transaction = Transaction.from(Buffer.from(payload.transaction, "base64"));
  } catch {
    throw new Error("Malformed Solana x402 transaction");
  }
  const payer = new PublicKey(payload.payer);
  const settler = asPublicKey(input.settlerPubkey);
  if (!transaction.feePayer?.equals(settler)) throw new Error("Solana x402 fee payer mismatch");
  if (!transaction.recentBlockhash) throw new Error("Solana x402 transaction is missing a recent blockhash");
  if (transaction.instructions.length < 1 || transaction.instructions.length > 2) {
    throw new Error("Solana x402 transaction has unexpected instructions");
  }

  const mint = new PublicKey(token.address);
  const payTo = new PublicKey(requirements.payTo);
  const sourceAta = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const transferIndex = transaction.instructions.length - 1;
  if (transferIndex === 1) assertIdempotentAtaInstruction(transaction.instructions[0], settler, destinationAta, payTo, mint);

  let transfer: ReturnType<typeof decodeTransferCheckedInstruction>;
  try {
    transfer = decodeTransferCheckedInstruction(transaction.instructions[transferIndex], TOKEN_PROGRAM_ID);
  } catch {
    throw new Error("Solana x402 transaction must end with transferChecked");
  }
  if (!transfer.keys.source.pubkey.equals(sourceAta)) throw new Error("Solana payment source ATA mismatch");
  if (!transfer.keys.mint.pubkey.equals(mint)) throw new Error("Solana payment mint mismatch");
  if (!transfer.keys.destination.pubkey.equals(destinationAta)) throw new Error("Solana payment destination ATA mismatch");
  if (!transfer.keys.owner.pubkey.equals(payer)) throw new Error("Solana payment authority mismatch");
  if (transfer.keys.multiSigners.length !== 0) throw new Error("Solana x402 multisig transfers are unsupported");
  if (transfer.data.amount !== BigInt(requirements.maxAmountRequired)) throw new Error("Solana payment amount mismatch");
  if (transfer.data.decimals !== token.decimals) throw new Error("Solana payment decimals mismatch");

  const payerSignature = transaction.signatures.find(({ publicKey }) => publicKey.equals(payer))?.signature;
  if (!payerSignature) throw new Error("Solana payer signature missing");
  if (!ed25519.verify(payerSignature, transaction.serializeMessage(), payer.toBytes())) {
    throw new Error("Solana payer signature invalid");
  }
  return {
    ok: true,
    payer: payer.toBase58(),
    payTo: payTo.toBase58(),
    value: transfer.data.amount.toString(),
    transaction
  };
};

const assertIdempotentAtaInstruction = (
  instruction: TransactionInstruction,
  settler: PublicKey,
  destinationAta: PublicKey,
  payTo: PublicKey,
  mint: PublicKey
) => {
  if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || instruction.data.length !== 1 || instruction.data[0] !== 1) {
    throw new Error("Solana x402 extra instruction is not idempotent ATA creation");
  }
  const expected = [settler, destinationAta, payTo, mint, SystemProgram.programId, TOKEN_PROGRAM_ID];
  if (instruction.keys.length !== expected.length || instruction.keys.some((key, index) => !key.pubkey.equals(expected[index]))) {
    throw new Error("Solana x402 ATA creation accounts mismatch");
  }
  if (!instruction.keys[0].isSigner || !instruction.keys[0].isWritable || !instruction.keys[1].isWritable) {
    throw new Error("Solana x402 ATA creation privileges mismatch");
  }
};

const assertRequirements = (requirements: SolanaX402PaymentRequirements, token: X402TokenConfig) => {
  if (requirements.x402Version !== 1 || requirements.scheme !== "exact" || requirements.network !== "solana") {
    throw new Error("Unsupported Solana x402 requirements");
  }
  if (new PublicKey(requirements.asset).toBase58() !== new PublicKey(token.address).toBase58()) {
    throw new Error("Solana requirements asset mismatch");
  }
  if (BigInt(requirements.maxAmountRequired) <= 0n) throw new Error("Solana payment amount must be positive");
  new PublicKey(requirements.payTo);
};

const requireSolanaToken = (token: X402TokenConfig) => {
  if (token.kind !== "solana") throw new Error("Solana x402 helpers require a Solana token config");
  return token;
};
const asPublicKey = (value: PublicKey | string) => value instanceof PublicKey ? value : new PublicKey(value);
