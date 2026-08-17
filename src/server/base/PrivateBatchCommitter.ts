import { Contract, JsonRpcProvider, Wallet } from "ethers";
import type { SettlementBatch } from "../payments/PrivatePaymentLedger";
import type { X402Facilitator } from "./X402Facilitator";
import {
  coordinatorLogicalId,
  evmPayloadFingerprint,
  type TransactionCoordinator,
} from "./TransactionCoordinator";

const ABI = [
  "function commitBatch(bytes32 merkleRoot, address asset, uint256 transferCount)",
  "function committedAt(bytes32 merkleRoot) view returns (uint64)"
];

export interface SettlementBatchCommitter {
  commit(batch: Pick<SettlementBatch, "merkleRoot" | "tokenAddress" | "transferCount">): Promise<{
    transactionHash?: string;
    alreadyCommitted: boolean;
  }>;
}

export class PrivateBatchCommitter implements SettlementBatchCommitter {
  private readonly contract: Contract;
  private readonly coordinator?: TransactionCoordinator;
  private readonly facilitator?: X402Facilitator;
  private readonly contractAddress: string;
  private readonly chainId: number;

  constructor(input: {
    rpcUrl: string;
    privateKey: string;
    contractAddress: string;
    chainId?: number;
    coordinator?: TransactionCoordinator;
    facilitator?: X402Facilitator;
  }) {
    const signer = new Wallet(input.privateKey, new JsonRpcProvider(input.rpcUrl));
    this.contract = new Contract(input.contractAddress, ABI, signer);
    this.coordinator = input.coordinator;
    this.facilitator = input.facilitator;
    this.contractAddress = input.contractAddress;
    this.chainId = input.chainId ?? 8453;
  }

  async commit(batch: Pick<SettlementBatch, "merkleRoot" | "tokenAddress" | "transferCount">) {
    const existing = BigInt(await this.contract.committedAt(batch.merkleRoot));
    if (existing > 0n) return { transactionHash: undefined, alreadyCommitted: true };
    if (this.coordinator && this.facilitator) {
      const data = this.contract.interface.encodeFunctionData("commitBatch", [
        batch.merkleRoot,
        batch.tokenAddress,
        batch.transferCount,
      ]);
      const payloadFingerprint = evmPayloadFingerprint({
        to: this.contractAddress,
        data,
        value: 0n,
        chainId: this.chainId,
      });
      const logicalId = coordinatorLogicalId({
        kind: "batch-commit",
        ref: batch.merkleRoot,
        payloadFingerprint,
      });
      const result = await this.coordinator.submit({
        kind: "batch-commit",
        ref: batch.merkleRoot,
        logicalId,
        payloadFingerprint,
        sign: async (fees) => {
          const built = await this.facilitator!.buildCommitBatch({
            contractAddress: this.contractAddress,
            merkleRoot: batch.merkleRoot,
            asset: batch.tokenAddress,
            transferCount: batch.transferCount,
            ...fees,
          });
          if (built.payloadFingerprint !== payloadFingerprint) {
            throw new Error("Batch commit builder changed its payload fingerprint");
          }
          return { signedTx: built.signedTx, txHash: built.txHash };
        },
      });
      return { transactionHash: result.txHash, alreadyCommitted: false };
    }
    const transaction = await this.contract.commitBatch(batch.merkleRoot, batch.tokenAddress, batch.transferCount);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error("Private settlement batch commitment failed");
    return { transactionHash: transaction.hash as string, alreadyCommitted: false };
  }
}
