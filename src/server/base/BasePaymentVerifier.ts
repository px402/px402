import type { BasePaymentProof, BasePaymentRequest } from "../../shared/protocol";

interface BaseTransaction {
  hash: string;
  from: string;
  to?: string;
  value: string;
  input?: string;
}

interface BaseReceipt {
  transactionHash: string;
  status: string;
  blockNumber?: string;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
}

export class BasePaymentVerifier {
  private readonly settledHashes = new Set<string>();

  constructor(
    private readonly rpcUrl: string,
    private readonly minConfirmations = 1,
  ) {
    if (!Number.isInteger(minConfirmations) || minConfirmations < 1) {
      throw new Error("Base payment minimum confirmations must be an integer >= 1");
    }
  }

  async verify(request: BasePaymentRequest, proof?: BasePaymentProof) {
    if (!proof) throw new Error("Base payment transaction required");
    const hash = normalizeHash(proof.transactionHash);
    if (this.settledHashes.has(hash)) throw new Error("Base payment transaction already settled");

    const wallet = normalizeAddress(proof.walletAddress);
    const transaction = await this.rpc<BaseTransaction>("eth_getTransactionByHash", [hash]);
    if (!transaction) throw new Error("Base transaction not found");
    if (normalizeAddress(transaction.from) !== wallet) throw new Error("Base transaction sender mismatch");
    if (request.kind === "base-native-transfer") {
      const recipient = normalizeAddress(request.recipient);
      if (!transaction.to || normalizeAddress(transaction.to) !== recipient) throw new Error("Base transaction recipient mismatch");
    } else {
      const contractAddress = normalizeAddress(request.contractAddress);
      if (!transaction.to || normalizeAddress(transaction.to) !== contractAddress) throw new Error("Base contract transaction target mismatch");
      if (normalizeHex(transaction.input ?? "") !== normalizeHex(request.data)) throw new Error("Base contract transaction calldata mismatch");
    }
    if (BigInt(transaction.value) < BigInt(request.wei)) throw new Error("Base transaction value below quote");

    const receipt = await this.waitForReceipt(hash);
    if (!receipt) throw new Error("Base transaction not confirmed");
    if (receipt.status !== "0x1") throw new Error("Base transaction failed");

    this.settledHashes.add(hash);
  }

  async verifyErc20Transfer(input: {
    transactionHash: string;
    tokenAddress: string;
    fromAddress: string;
    recipient: string;
    amountAtomic: string;
  }) {
    const hash = normalizeHash(input.transactionHash);
    const transaction = await this.rpc<BaseTransaction | null>("eth_getTransactionByHash", [hash]);
    if (!transaction) throw new Error("Base deposit transaction not found");
    // Deliberately NOT compared against transaction.from. For a relayed transfer
    // — EIP-3009 transferWithAuthorization above all — transaction.from is the
    // relayer that paid gas, while the token-level sender is the Transfer log's
    // topics[1], asserted below. Binding the deposit to the broadcaster made
    // every gasless deposit unverifiable, which defeats the point of accepting
    // EIP-3009 at all: a depositor holding USDC but no ETH could never fund a
    // balance. The log assertion (token, from, recipient, amount) is what
    // actually binds the value movement; the broadcaster is irrelevant to it.
    const receipt = await this.waitForReceipt(hash);
    if (!receipt || receipt.status !== "0x1") throw new Error("Base deposit transaction failed or is unconfirmed");
    await this.assertConfirmationDepth(receipt);
    const token = normalizeAddress(input.tokenAddress);
    const fromTopic = addressTopic(input.fromAddress);
    const recipientTopic = addressTopic(input.recipient);
    const amount = BigInt(input.amountAtomic);
    const transferIndex = receipt.logs?.findIndex((log) =>
      normalizeAddress(log.address) === token
      && log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC
      && log.topics[1]?.toLowerCase() === fromTopic
      && log.topics[2]?.toLowerCase() === recipientTopic
      && BigInt(log.data) >= amount
    ) ?? -1;
    if (transferIndex < 0) throw new Error("Required USDC deposit transfer not found in transaction receipt");
    return {
      transactionHash: hash,
      amountAtomic: BigInt(receipt.logs![transferIndex].data).toString(),
      transferIndex,
    };
  }

  private async assertConfirmationDepth(receipt: BaseReceipt) {
    if (this.minConfirmations === 1) return;
    if (!receipt.blockNumber) throw new Error("Base deposit receipt omitted block number");
    const latest = await this.rpc<string>("eth_blockNumber", []);
    const confirmations = Number(BigInt(latest) - BigInt(receipt.blockNumber) + 1n);
    if (confirmations < this.minConfirmations) {
      throw new Error(`Base deposit requires ${this.minConfirmations} confirmations`);
    }
  }

  private async waitForReceipt(hash: string) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const receipt = await this.rpc<BaseReceipt | null>("eth_getTransactionReceipt", [hash]);
      if (receipt) return receipt;
      await delay(2500);
    }
    return undefined;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (!response.ok) throw new Error(`Base RPC ${response.status}`);
    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message ?? "Base RPC rejected");
    return payload.result as T;
  }
}

const normalizeAddress = (value: string) => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error("Invalid Base address");
  return value.toLowerCase();
};

const normalizeHash = (value: string) => {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error("Invalid Base transaction hash");
  return value.toLowerCase();
};

const normalizeHex = (value: string) => {
  if (!/^0x[a-fA-F0-9]*$/.test(value)) throw new Error("Invalid Base calldata");
  return value.toLowerCase();
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addressTopic = (value: string) => `0x${normalizeAddress(value).slice(2).padStart(64, "0")}`;
