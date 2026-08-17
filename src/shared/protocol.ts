/**
 * Wire types shared between the PX-402 server and its clients.
 *
 * This module carries only the payment-facing surface: EVM payment request
 * shapes used by the ledger deposit verifiers, and the browser stealth-inbox
 * projection. Everything here is safe to serialize to an untrusted client.
 */

export interface BaseNativeTransferRequest {
  kind: "base-native-transfer";
  chainId: 8453;
  rpcUrl: string;
  recipient: string;
  wei: string;
  eth: number;
  reference: string;
}

export interface BaseContractCallRequest {
  kind: "base-contract-call";
  chainId: 8453;
  rpcUrl: string;
  contractAddress: string;
  wei: string;
  eth: number;
  data: string;
  contractMethod: string;
  reference: string;
}

export type BasePaymentRequest = BaseNativeTransferRequest | BaseContractCallRequest;

export interface BasePaymentProof {
  walletAddress: string;
  transactionHash: string;
}

/**
 * The complete set of reasons a stealth browser operation can fail, as seen by
 * a client. Deliberately coarse: the private RPC's error strings carry agent
 * ids and WireGuard IPs, and this channel must not inherit that.
 */
export type StealthInboxErrorCode =
  | "stealth_unavailable"
  | "stealth_unauthorized"
  | "stealth_not_paired"
  | "stealth_rate_limited"
  | "stealth_conflict"
  | "stealth_simulation_unavailable";

export type StealthInboxEntryStatus =
  | "announced"
  | "observed"
  | "sweeping"
  | "swept"
  | "dormant";

/**
 * One stealth output owed to the viewer.
 *
 * `sourceRef` is deliberately absent. It identifies the payout group that
 * produced this output, which is a payer-linking datum the payee does not
 * otherwise hold — it was withheld for that reason and this surface does
 * not reverse the decision. The server still uses it internally.
 */
export interface PublicStealthInboxEntry {
  id: string;
  network: string;
  asset: string;
  assetDecimals: number;
  stealthAddress: string;
  /**
   * The announcement `R`. Without it the one-time key `kSpend + H(kView*R)`
   * cannot be derived and the address cannot even be located, so this is the
   * datum the funds depend on. It also bounds retroactive de-anonymization,
   * which is why the client holds it in memory only and never persists,
   * caches, or logs it.
   */
  ephemeralPubKey: string;
  expectedAmountAtomic: string | null;
  observedAmountAtomic: string | null;
  /**
   * `null` means never checked, which is NOT the same as checked-and-empty.
   * The UI must render these distinctly or it will tell a user with money
   * waiting that they have none.
   */
  observedAt: number | null;
  status: StealthInboxEntryStatus;
  claimable: boolean;
  simulated: boolean;
  /**
   * Set when a previously-funded output fell to zero without our sweep path
   * having moved it — i.e. someone else spent it. Surfaced, never hidden.
   */
  anomaly: "unexplained-drain" | null;
  createdAt: number;
}

export interface PublicStealthInbox {
  agentId: string;
  network?: string;
  /** Padded to a fixed page size so frame length does not leak entry count. */
  entries: PublicStealthInboxEntry[];
  page: number;
  totalObservedAtomic: string;
  balanceAtomic: string;
  balanceAsset: string;
  balanceAssetDecimals: number;
  mode: "onchain" | "dry-run" | "simulation";
  claimMode: "off" | "agent" | "browser";
  subscriptionExpiresAt: number;
  updatedAt: number;
}
