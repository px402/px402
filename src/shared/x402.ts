import {
  Wallet,
  verifyTypedData,
  getAddress,
  hexlify,
  randomBytes,
  type TypedDataDomain
} from "ethers";
import type { StealthMetaAddress } from "./stealth";
import type { PayoutPolicyAdvertisement } from "./payoutPlan";

// x402 "exact" payment scheme, settled via EIP-3009 transferWithAuthorization
// (a gasless, signature-authorized token transfer). The payer signs an
// authorization off-chain; a facilitator verifies it and (optionally)
// broadcasts it on-chain. Negotiation can therefore happen over a private
// channel while only the final token transfer touches the public chain.
//
// Chain-agnostic: every quote/payment is tagged with a network id resolved
// through X402_NETWORKS. Any EVM chain whose settlement token implements
// EIP-3009 works — Base (Circle USDC) and Robinhood Chain (Paxos USDG) ship
// as built-ins.

export const BASE_CHAIN_ID = 8453;

// Native Circle USDC on Base mainnet (6 decimals, EIP-3009 enabled).
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_USDC_DECIMALS = 6;

// EIP-712 domain MUST match the deployed token's name()/version() for an
// on-chain settle to succeed. These are Circle USDC's values; overridable for
// other tokens / testnets via the facilitator config.
export const BASE_USDC_DOMAIN_NAME = "USD Coin";
export const BASE_USDC_DOMAIN_VERSION = "2";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;

// Robinhood Chain mainnet (an Arbitrum Orbit L2). Settlement token is Paxos
// Global Dollar (USDG), which implements EIP-3009. The EIP-712 domain
// ("Global Dollar", "1") is proven against the live contract: the computed
// domain separator matches on-chain DOMAIN_SEPARATOR(), and an eth_call of
// transferWithAuthorization with a fresh signature reverts with
// InsufficientFunds() — i.e. signature/domain/nonce checks all passed.
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ROBINHOOD_USDG_DECIMALS = 6;
export const ROBINHOOD_USDG_DOMAIN_NAME = "Global Dollar";
export const ROBINHOOD_USDG_DOMAIN_VERSION = "1";

export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDC_DECIMALS = 6;

/** Friendly network id used on the x402 wire ("base", "robinhood", ...). */
export type X402Network = string;

export interface X402TokenConfig {
  kind: "evm" | "solana";
  network: X402Network; // friendly id carried in requirements/payloads
  caip2: string; // canonical CAIP-2 chain reference
  address: string;
  chainId?: number;
  domainName?: string;
  domainVersion?: string;
  decimals: number;
  /**
   * Confidential-scheme capability for this network (spec-confidential-x402.md §3.2).
   * Absent ⇒ the network cannot serve `confidential` and never advertises it.
   *
   * `mechanism` differs per rail on purpose — Solana has a native confidential
   * primitive and the EVM chains do not — while the wire, the API, and the scheme
   * stay identical across all three. Parity is a protocol property, not a
   * mechanism one; this is the same split `exact` already has (EIP-3009 vs
   * `transferChecked`).
   */
  confidential?: X402ConfidentialCapability;
}

export interface X402ConfidentialCapability {
  mechanism: "token2022" | "px402-evm";
  /** Token-2022 mint, or the deployed `PX402Confidential` address. */
  asset: string;
  decimals: number;
}

export const BASE_USDC: X402TokenConfig = {
  kind: "evm",
  network: "base",
  caip2: `eip155:${BASE_CHAIN_ID}`,
  address: BASE_USDC_ADDRESS,
  chainId: BASE_CHAIN_ID,
  domainName: BASE_USDC_DOMAIN_NAME,
  domainVersion: BASE_USDC_DOMAIN_VERSION,
  decimals: BASE_USDC_DECIMALS
};

export const ROBINHOOD_USDG: X402TokenConfig = {
  kind: "evm",
  network: "robinhood",
  caip2: `eip155:${ROBINHOOD_CHAIN_ID}`,
  address: ROBINHOOD_USDG_ADDRESS,
  chainId: ROBINHOOD_CHAIN_ID,
  domainName: ROBINHOOD_USDG_DOMAIN_NAME,
  domainVersion: ROBINHOOD_USDG_DOMAIN_VERSION,
  decimals: ROBINHOOD_USDG_DECIMALS
};

export const SOLANA_USDC: X402TokenConfig = {
  kind: "solana",
  network: "solana",
  caip2: SOLANA_CAIP2,
  address: SOLANA_USDC_MINT,
  decimals: SOLANA_USDC_DECIMALS
};

/** Built-in networks; servers may override token params per network via config. */
export const X402_NETWORKS: Readonly<Record<string, X402TokenConfig>> = {
  base: BASE_USDC,
  robinhood: ROBINHOOD_USDG,
  solana: SOLANA_USDC
};

/** Accepts a friendly id ("robinhood") or its CAIP-2 alias ("eip155:4663"). */
export const resolveX402Network = (
  network: string,
  registry: Readonly<Record<string, X402TokenConfig>> = X402_NETWORKS
): X402TokenConfig => {
  const direct = registry[network];
  if (direct) return direct;
  const byCaip2 = Object.values(registry).find((token) => token.caip2 === network);
  if (byCaip2) return byCaip2;
  throw new Error(`Unknown x402 network: ${network}`);
};

/**
 * Payment schemes (spec-confidential-x402.md B1/§3.1).
 *
 * `exact`        — the shipped rail: a public transfer of a public amount.
 * `confidential` — the amount is encrypted (ElGamal + ZK range proofs) and never
 *                  appears on-chain. Native Token-2022 on Solana; a
 *                  `PX402Confidential` contract on Base and Robinhood Chain.
 *
 * This is a union rather than a literal because every confidential code path
 * must be reachable only through an exhaustive check. With `"exact"` hard-coded
 * in five places, every new path would have been a cast and the compiler would
 * have stopped helping — which is why B1 blocks the rest of the wave.
 *
 * The scheme is bound into the signed quote intent, and `/private/a2a/pay`
 * routes by the QUOTE's scheme, never the payer's payload. A payer therefore
 * cannot downgrade a `confidential` quote to `exact` and publish the amount.
 */
export type X402Scheme = "exact" | "confidential";

export interface X402PaymentRequirements {
  scheme: X402Scheme;
  network: X402Network;
  asset: string; // token contract (USDC)
  payTo: string; // recipient address
  maxAmountRequired: string; // atomic token units (string to preserve precision)
  resource: string; // what is being paid for (offer id, item id, route, ...)
  description?: string;
  nonce: string; // bytes32 — unique per requirement, also the on-chain auth nonce
  validForSeconds: number; // window the payment authorization stays valid
  // When present, the payee wants payment to a fresh EIP-5564 stealth address:
  // the payer derives one from this meta-address and pays that instead of payTo.
  stealthMetaAddress?: StealthMetaAddress;
  payoutPolicy?: PayoutPolicyAdvertisement;
}

export interface EIP3009Authorization {
  from: string;
  to: string;
  value: string; // atomic
  validAfter: string; // unix seconds
  validBefore: string; // unix seconds
  nonce: string; // bytes32
}

export interface X402PaymentPayload {
  x402Version: 1;
  /** EIP-3009 payloads are `exact` by construction; see `X402ConfidentialPayload`. */
  scheme: "exact";
  network: X402Network;
  asset: string;
  authorization: EIP3009Authorization;
  signature: string; // EIP-712 signature over TransferWithAuthorization
}

const tokenDomain = (token: X402TokenConfig): TypedDataDomain => {
  assertEvmToken(token);
  return {
    name: token.domainName,
    version: token.domainVersion,
    chainId: token.chainId,
    verifyingContract: getAddress(token.address)
  };
};

export const randomNonce = () => hexlify(randomBytes(32));

/** atomic USDC units for a given decimal USDC amount (e.g. 0.25 -> "250000"). */
export const usdcAtomic = (usdc: number, decimals = BASE_USDC_DECIMALS) => {
  if (!Number.isFinite(usdc) || usdc < 0) throw new Error("Invalid USDC amount");
  // round to the token's smallest unit without floating drift
  const scaled = Math.round(usdc * 10 ** decimals);
  return BigInt(scaled).toString();
};

/**
 * Build the 402 payment requirements a resource/seller agent challenges with.
 * `nowSeconds` is injected so this stays deterministic/testable.
 */
export const buildPaymentRequirements = (input: {
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  validForSeconds?: number;
  token?: X402TokenConfig;
  nowSeconds?: number;
}): X402PaymentRequirements => {
  const token = input.token ?? BASE_USDC;
  assertEvmToken(token);
  if (BigInt(input.maxAmountRequired) <= 0n) throw new Error("maxAmountRequired must be positive");
  return {
    scheme: "exact",
    network: token.network,
    asset: getAddress(token.address),
    payTo: getAddress(input.payTo),
    maxAmountRequired: input.maxAmountRequired,
    resource: input.resource,
    description: input.description,
    nonce: randomNonce(),
    validForSeconds: input.validForSeconds ?? 600
  };
};

/**
 * Payer side: construct + sign the EIP-3009 authorization that satisfies a 402
 * challenge. Pays exactly `maxAmountRequired` to `payTo`.
 */
export const createPaymentPayload = async (input: {
  payerPrivateKey: string;
  requirements: X402PaymentRequirements;
  token?: X402TokenConfig;
  nowSeconds: number;
}): Promise<X402PaymentPayload> => {
  const token = input.token ?? BASE_USDC;
  assertEvmToken(token);
  const wallet = new Wallet(input.payerPrivateKey);
  const authorization: EIP3009Authorization = {
    from: getAddress(wallet.address),
    to: getAddress(input.requirements.payTo),
    value: input.requirements.maxAmountRequired,
    // small backdate absorbs clock skew between payer and facilitator
    validAfter: String(input.nowSeconds - 60),
    validBefore: String(input.nowSeconds + input.requirements.validForSeconds),
    nonce: input.requirements.nonce
  };
  const signature = await wallet.signTypedData(
    tokenDomain(token),
    TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, { name: string; type: string }[]>,
    authorization
  );
  return {
    x402Version: 1,
    scheme: "exact",
    network: token.network,
    asset: getAddress(token.address),
    authorization,
    signature
  };
};

export interface X402VerifyResult {
  ok: true;
  signer: string;
  value: string;
}

/**
 * Facilitator side: pure-crypto verification of a payment against requirements.
 * No RPC — recovers the EIP-712 signer and checks the authorization satisfies
 * the challenge (recipient, amount, validity window, asset/network). On-chain
 * nonce-uniqueness/balance is the settle step's job.
 */
export const verifyPayment = (input: {
  payload: X402PaymentPayload;
  requirements: X402PaymentRequirements;
  token?: X402TokenConfig;
  nowSeconds: number;
}): X402VerifyResult => {
  const token = input.token ?? BASE_USDC;
  assertEvmToken(token);
  const { payload, requirements } = input;

  if (payload.scheme !== "exact") throw new Error("Unsupported x402 scheme");
  if (payload.network !== token.network) {
    throw new Error(`Payment network mismatch: got ${payload.network}, expected ${token.network}`);
  }
  if (requirements.network !== token.network) {
    throw new Error(`Requirements network mismatch: got ${requirements.network}, expected ${token.network}`);
  }
  if (lc(payload.asset) !== lc(token.address)) throw new Error("Payment asset mismatch");

  const auth = payload.authorization;
  if (lc(auth.to) !== lc(requirements.payTo)) throw new Error("Payment recipient mismatch");
  if (auth.nonce !== requirements.nonce) throw new Error("Payment nonce mismatch");

  const value = BigInt(auth.value);
  if (value < BigInt(requirements.maxAmountRequired)) throw new Error("Payment amount below required");

  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (!(input.nowSeconds >= validAfter)) throw new Error("Payment not yet valid");
  if (!(input.nowSeconds < validBefore)) throw new Error("Payment authorization expired");

  let signer: string;
  try {
    signer = verifyTypedData(
      tokenDomain(token),
      TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      auth,
      payload.signature
    );
  } catch {
    throw new Error("Payment signature invalid");
  }
  if (lc(signer) !== lc(auth.from)) throw new Error("Payment signer does not match authorization.from");

  return { ok: true, signer: getAddress(signer), value: value.toString() };
};

// X-PAYMENT header transport (base64 JSON), matching the x402 header convention.
export const encodePaymentHeader = (payload: X402PaymentPayload) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

export const decodePaymentHeader = (header: string): X402PaymentPayload => {
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as X402PaymentPayload;
  if (payload.x402Version !== 1 || !payload.authorization || !payload.signature) {
    throw new Error("Malformed X-PAYMENT payload");
  }
  return payload;
};

const lc = (value: string) => value.toLowerCase();

type EvmX402TokenConfig = X402TokenConfig & {
  kind: "evm";
  chainId: number;
  domainName: string;
  domainVersion: string;
};

const assertEvmToken: (token: X402TokenConfig) => asserts token is EvmX402TokenConfig = (token) => {
  if (token.kind !== "evm") throw new Error("EIP-3009 x402 helpers do not support Solana tokens");
  if (token.chainId === undefined || token.domainName === undefined || token.domainVersion === undefined) {
    throw new Error("EVM x402 token config is missing its EIP-712 domain");
  }
};
