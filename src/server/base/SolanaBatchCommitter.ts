import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { SettlementBatchCommitter } from "./PrivateBatchCommitter";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface SolanaBatchCommitterOptions {
  rpcUrl: string;
  settlerSecretKey: string;
  connection?: Connection;
  sendCoordinator?: { send<T>(operation: () => Promise<T>): Promise<T> };
}

export class SolanaBatchCommitter implements SettlementBatchCommitter {
  private readonly connection: Connection;
  private readonly settler: Keypair;

  constructor(private readonly options: SolanaBatchCommitterOptions) {
    this.connection = options.connection ?? new Connection(options.rpcUrl, "confirmed");
    this.settler = solanaKeypairFromBase58(options.settlerSecretKey);
  }

  async commit(batch: Parameters<SettlementBatchCommitter["commit"]>[0]) {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const memo = `px402-batch:v1:${batch.merkleRoot}:${batch.tokenAddress}:${batch.transferCount}`;
    const transaction = new Transaction({
      feePayer: this.settler.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(memo, "utf8"),
    }));
    transaction.sign(this.settler);

    const signature = await (
      this.options.sendCoordinator?.send(() =>
        this.connection.sendRawTransaction(transaction.serialize()))
      ?? this.connection.sendRawTransaction(transaction.serialize())
    );
    const confirmation = await this.connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) throw new Error("Solana private settlement batch commitment failed");
    return { transactionHash: signature, alreadyCommitted: false };
  }
}

export const solanaKeypairFromBase58 = (value: string) => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Solana settler secret is not valid base58");
    numeric = numeric * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (numeric > 0n) {
    decoded.push(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  decoded.reverse();
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  const bytes = new Uint8Array(leadingZeros + decoded.length);
  bytes.set(decoded, leadingZeros);
  if (bytes.length !== 64) throw new Error("Solana settler secret must decode to a 64-byte keypair");
  return Keypair.fromSecretKey(bytes);
};
