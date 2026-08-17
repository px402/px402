export const PRIVATE_LEDGER_SCHEME = "px402-private-batch" as const;

export const privateLedgerAssetKey = (network: string, tokenAddress: string) =>
  `${network}:${tokenAddress.toLowerCase()}`;

export interface PrivateLedgerRequirements {
  x402Version: 2;
  scheme: typeof PRIVATE_LEDGER_SCHEME;
  network: string;
  asset: string;
  amountAtomic: string;
  payerAgentId: string;
  payeeAgentId: string;
  quoteNonce: string;
  resourceHash: string;
  validBefore: number;
}

export interface PrivateLedgerVoucher {
  requirements: PrivateLedgerRequirements;
  authorizationNonce: string;
  agentSignature: string;
}

export interface PrivateLedgerPaymentAccepted {
  status: "accepted";
  scheme: typeof PRIVATE_LEDGER_SCHEME;
  commitment: string;
  payerBalanceAtomic: string;
  acceptedAt: number;
}
