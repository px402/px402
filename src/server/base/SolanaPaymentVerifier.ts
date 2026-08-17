import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type TokenBalance,
} from "@solana/web3.js";
import type { TokenTransferProof, TokenTransferVerifier } from "../agents/PrivateAgentRegistry";

const MAX_CONFIRMED_TRANSACTION_AGE_SECONDS = 15 * 60;
const MAX_CLOCK_SKEW_SECONDS = 60;

export interface SolanaPaymentVerifierOptions {
  rpcUrl: string;
  connection?: Connection;
}

/** Strictly verifies a confirmed SPL-token deposit before private-ledger credit. */
export class SolanaPaymentVerifier implements TokenTransferVerifier {
  private readonly connection: Connection;

  constructor(options: SolanaPaymentVerifierOptions) {
    this.connection = options.connection ?? new Connection(options.rpcUrl, "confirmed");
  }

  async verifyErc20Transfer(input: TokenTransferProof) {
    const mint = parsePublicKey(input.tokenAddress, "mint");
    const depositor = parsePublicKey(input.fromAddress, "depositor");
    const recipient = parsePublicKey(input.recipient, "recipient");
    const requiredAmount = BigInt(input.amountAtomic);
    if (requiredAmount <= 0n) throw new Error("Solana deposit amount must be positive");
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

    const transaction = await this.connection.getParsedTransaction(input.transactionHash, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    this.assertConfirmedAndRecent(transaction);

    const meta = transaction.meta!;
    const accountKeys = transaction.transaction.message.accountKeys;
    const preBalances = meta.preTokenBalances ?? [];
    const postBalances = meta.postTokenBalances ?? [];
    const instructions = [
      ...transaction.transaction.message.instructions,
      ...(meta.innerInstructions?.flatMap((entry) => entry.instructions) ?? []),
    ];

    let matchedTransferIndex = -1;
    let observedAmount = 0n;
    instructions.some((instruction, transferIndex) => {
      if (!("parsed" in instruction) || !instruction.programId.equals(TOKEN_PROGRAM_ID)) return false;
      const parsed = (instruction as ParsedInstruction).parsed as unknown;
      const parsedRecord = asRecord(parsed);
      const type = parsedRecord && typeof parsedRecord.type === "string" ? parsedRecord.type : undefined;
      if (type !== "transfer" && type !== "transferChecked") return false;
      const info = parsedRecord ? asRecord(parsedRecord.info) : undefined;
      if (!info) return false;

      const source = publicKeyField(info.source);
      const destination = publicKeyField(info.destination);
      const authority = publicKeyField(info.authority);
      if (!source || !destination || !authority
        || !destination.equals(recipientAta)
        || !authority.equals(depositor)) return false;

      if (type === "transferChecked") {
        const instructionMint = publicKeyField(info.mint);
        if (!instructionMint?.equals(mint)) return false;
      }

      const instructionAmount = amountField(info);
      if (instructionAmount === undefined || instructionAmount < requiredAmount) return false;

      const sourceIndex = accountKeys.findIndex((account) => account.pubkey.equals(source));
      const destinationIndex = accountKeys.findIndex((account) => account.pubkey.equals(destination));
      if (sourceIndex < 0 || destinationIndex < 0) return false;

      const preSource = findTokenBalance(preBalances, sourceIndex, mint);
      const postSource = findTokenBalance(postBalances, sourceIndex, mint);
      const preDestination = findTokenBalance(preBalances, destinationIndex, mint);
      const postDestination = findTokenBalance(postBalances, destinationIndex, mint);
      if (!preSource || !postDestination
        || !ownerEquals(preSource, depositor)
        || !ownerEquals(postDestination, recipient)) return false;

      const sourceDebit = atomicAmount(preSource) - (postSource ? atomicAmount(postSource) : 0n);
      const destinationIncrease = atomicAmount(postDestination)
        - (preDestination ? atomicAmount(preDestination) : 0n);
      if (sourceDebit < requiredAmount || destinationIncrease < requiredAmount) return false;
      matchedTransferIndex = transferIndex;
      observedAmount = instructionAmount;
      return true;
    });

    if (matchedTransferIndex < 0) {
      throw new Error("Required Solana USDC-SPL deposit transfer not found in confirmed transaction");
    }
    return {
      transactionHash: input.transactionHash,
      amountAtomic: observedAmount.toString(),
      transferIndex: matchedTransferIndex,
    };
  }

  private assertConfirmedAndRecent(
    transaction: ParsedTransactionWithMeta | null,
  ): asserts transaction is ParsedTransactionWithMeta & { meta: NonNullable<ParsedTransactionWithMeta["meta"]> } {
    if (!transaction) throw new Error("Solana deposit transaction not found");
    if (!transaction.meta || transaction.meta.err !== null) {
      throw new Error("Solana deposit transaction failed or is unconfirmed");
    }
    const now = Math.floor(Date.now() / 1000);
    if (transaction.blockTime === null
      || transaction.blockTime === undefined
      || transaction.blockTime < now - MAX_CONFIRMED_TRANSACTION_AGE_SECONDS
      || transaction.blockTime > now + MAX_CLOCK_SKEW_SECONDS) {
      throw new Error("Solana deposit transaction is outside the confirmed deposit window");
    }
  }
}

const parsePublicKey = (value: string, label: string) => {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid Solana ${label} public key`);
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const publicKeyField = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  try {
    return new PublicKey(value);
  } catch {
    return undefined;
  }
};

const amountField = (info: Record<string, unknown>) => {
  const direct = info.amount;
  const tokenAmount = asRecord(info.tokenAmount);
  const value = typeof direct === "string"
    ? direct
    : tokenAmount && typeof tokenAmount.amount === "string"
      ? tokenAmount.amount
      : undefined;
  if (!value || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
};

const findTokenBalance = (balances: TokenBalance[], accountIndex: number, mint: PublicKey) =>
  balances.find((balance) => balance.accountIndex === accountIndex
    && publicKeyEquals(balance.mint, mint)
    && (!balance.programId || publicKeyEquals(balance.programId, TOKEN_PROGRAM_ID)));

const ownerEquals = (balance: TokenBalance, owner: PublicKey) =>
  Boolean(balance.owner && publicKeyEquals(balance.owner, owner));

const publicKeyEquals = (value: string, expected: PublicKey) => {
  try {
    return new PublicKey(value).equals(expected);
  } catch {
    return false;
  }
};

const atomicAmount = (balance: TokenBalance) => BigInt(balance.uiTokenAmount.amount);
