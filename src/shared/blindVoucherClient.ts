import { getBytes, hexlify, randomBytes } from "ethers";
import type { AgentIdentitySigner } from "./privateX402Client";
import {
  blindSecret,
  computeKeysetId,
  decomposeAmount,
  meltFingerprint,
  randomSecret,
  unblindSignature,
  verifyCheckpoint,
  verifyDleq,
  verifyManifestEntry,
  type BlindSignature,
  type BlindVoucher,
  type BlindVoucherOutput,
  type ManifestCheckpoint,
  type SignedManifestEntry,
} from "./blindVoucher";
import { blindVoucherIssueIntentMessage } from "./x402AgentIntent";
import { resolveX402Network } from "./x402";
import type { PublicKeyset } from "../server/payments/BlindVoucherMint";

export interface PendingIssuance {
  fingerprint: string;
  asset: string;
  keysetId: string;
  createdAt: number;
  contexts: { denomAtomic: string; secret: string; r: string; B_: string }[];
}

/** Persistence is injected so this protocol module stays browser-safe. */
export interface VoucherWallet {
  loadPending(): Promise<PendingIssuance[]>;
  savePending(rec: PendingIssuance): Promise<void>;
  finalize(fingerprint: string, vouchers: BlindVoucher[]): Promise<void>;
  loadVouchers(): Promise<BlindVoucher[]>;
  removeVouchers(ids: string[]): Promise<void>;
}

export interface DiscoveredMint {
  network: string;
  asset: string;
  mintIdentityPubKey: string;
  checkpoint: ManifestCheckpoint;
  manifest: SignedManifestEntry[];
  keysets: PublicKeyset[];
}

export const discoverMint = async (input: {
  rpcUrl: string;
  network?: string;
  pinnedMintPubKey: string;
}): Promise<DiscoveredMint> => {
  const network = resolveX402Network(input.network ?? "base").network;
  const query = new URLSearchParams({ network });
  const discovered = await getJson<DiscoveredMint>(
    input.rpcUrl,
    `/private/a2a/mint-keys?${query.toString()}`,
  );
  if (!sameBytes(discovered.mintIdentityPubKey, input.pinnedMintPubKey)) {
    throw new Error("Mint identity public key does not match the pinned trust anchor");
  }
  verifyDiscoveredMint(discovered, input.pinnedMintPubKey);
  return discovered;
};

/** Throws only when two checkpoints claiming the same head sequence disagree. */
export const assertCheckpointAgreement = (
  a: ManifestCheckpoint,
  b: ManifestCheckpoint,
): void => {
  if (a.headSeq === b.headSeq
    && (a.headEntryHash !== b.headEntryHash || a.signature !== b.signature)) {
    throw new Error("Mint checkpoint equivocation detected");
  }
};

export const meltToBlindVouchers = async (input: {
  rpcUrl: string;
  payerAgentId: string;
  amountAtomic: string;
  network?: string;
  mint: DiscoveredMint;
  identitySigner: AgentIdentitySigner;
  wallet: VoucherWallet;
}): Promise<BlindVoucher[]> => {
  verifyDiscoveredMint(input.mint, input.mint.mintIdentityPubKey);
  const keyset = requireActiveKeyset(input.mint);
  const denominations = decomposeAmount(
    input.amountAtomic,
    keyset.denominations.map((denomination) => denomination.denomAtomic),
  );
  const contexts = denominations.map((denomAtomic) => {
    const context = blindSecret(randomSecret());
    return {
      denomAtomic,
      secret: context.secret,
      r: context.r,
      B_: context.B_,
    };
  });
  const outputs = contexts.map(({ denomAtomic, B_ }) => ({ denomAtomic, B_ }));
  const pending: PendingIssuance = {
    fingerprint: meltFingerprint({
      asset: input.mint.asset,
      keysetId: keyset.keysetId,
      outputs,
      totalAtomic: input.amountAtomic,
    }),
    asset: input.mint.asset,
    keysetId: keyset.keysetId,
    createdAt: Date.now(),
    contexts,
  };
  await input.wallet.savePending(pending);
  return submitPending({
    ...input,
    pending,
  });
};

export const recoverMelt = async (input: {
  rpcUrl: string;
  payerAgentId: string;
  pending: PendingIssuance;
  network?: string;
  mint: DiscoveredMint;
  identitySigner: AgentIdentitySigner;
  wallet: VoucherWallet;
}): Promise<BlindVoucher[]> => {
  verifyDiscoveredMint(input.mint, input.mint.mintIdentityPubKey);
  if (input.pending.asset !== input.mint.asset) throw new Error("Pending issuance asset mismatch");
  const outputs = input.pending.contexts.map(({ denomAtomic, B_ }) => ({ denomAtomic, B_ }));
  const expected = meltFingerprint({
    asset: input.pending.asset,
    keysetId: input.pending.keysetId,
    outputs,
    totalAtomic: sumContextAtomic(input.pending),
  });
  if (expected !== input.pending.fingerprint) throw new Error("Pending issuance fingerprint mismatch");
  return submitPending(input);
};

export const redeemBlindVouchers = async (input: {
  rpcUrl: string;
  recipientAgentId: string;
  vouchers: BlindVoucher[];
  network?: string;
}): Promise<{ status: "redeemed"; valueAtomic: string }> => {
  if (input.vouchers.length === 0) throw new Error("At least one blind voucher is required");
  const { asset, keysetId } = input.vouchers[0];
  if (input.vouchers.some((voucher) => voucher.asset !== asset || voucher.keysetId !== keysetId)) {
    throw new Error("multiple keysets in one redeem");
  }
  const response = await postJson<{
    result?: { status: "redeemed"; valueAtomic: string };
  }>(input.rpcUrl, "/private/a2a/voucher-redeem", {
    network: resolveX402Network(input.network ?? "base").network,
    recipientAgentId: input.recipientAgentId,
    keysetId,
    proofs: input.vouchers.map((voucher) => ({
      denomAtomic: voucher.denomAtomic,
      secret: voucher.secret,
      C: voucher.C,
    })),
  });
  if (!response.result || response.result.status !== "redeemed") {
    throw new Error("Blind voucher redeem response is invalid");
  }
  return response.result;
};

const submitPending = async (input: {
  rpcUrl: string;
  payerAgentId: string;
  pending: PendingIssuance;
  network?: string;
  mint: DiscoveredMint;
  identitySigner: AgentIdentitySigner;
  wallet: VoucherWallet;
}): Promise<BlindVoucher[]> => {
  const keyset = input.mint.keysets.find((candidate) =>
    candidate.keysetId === input.pending.keysetId);
  if (!keyset) throw new Error("Pending issuance keyset is not in the committed manifest");
  const outputs: BlindVoucherOutput[] = input.pending.contexts.map(
    ({ denomAtomic, B_ }) => ({ denomAtomic, B_ }),
  );
  const totalAtomic = sumContextAtomic(input.pending);
  const fingerprint = meltFingerprint({
    asset: input.pending.asset,
    keysetId: input.pending.keysetId,
    outputs,
    totalAtomic,
  });
  if (fingerprint !== input.pending.fingerprint) {
    throw new Error("Pending issuance fingerprint mismatch");
  }
  const intentNonce = hexlify(randomBytes(32));
  const network = resolveX402Network(input.network ?? input.mint.network).network;
  const agentSignature = await input.identitySigner.signMessage(
    blindVoucherIssueIntentMessage({
      payerAgentId: input.payerAgentId,
      network,
      keysetId: input.pending.keysetId,
      outputsFingerprint: fingerprint,
      totalAtomic,
      intentNonce,
    }),
  );
  const response = await postJson<{
    result?: { keysetId: string; signatures: BlindSignature[] };
  }>(input.rpcUrl, "/private/a2a/voucher-issue", {
    payerAgentId: input.payerAgentId,
    network,
    keysetId: input.pending.keysetId,
    outputs,
    totalAtomic,
    intentNonce,
    agentSignature,
  });
  if (!response.result || response.result.keysetId !== input.pending.keysetId) {
    throw new Error("Blind voucher issue response is invalid");
  }
  if (response.result.signatures.length !== input.pending.contexts.length) {
    throw new Error("Blind voucher issue response has the wrong signature count");
  }
  const vouchers = response.result.signatures.map((signature, index) => {
    const context = input.pending.contexts[index];
    if (signature.denomAtomic !== context.denomAtomic) {
      throw new Error("Blind voucher issue response changed output order");
    }
    const denomination = keyset.denominations.find((candidate) =>
      candidate.denomAtomic === context.denomAtomic);
    if (!denomination || !verifyDleq({
      B_: context.B_,
      C_: signature.C_,
      K: denomination.K,
      dleq: signature.dleq,
    })) {
      throw new Error("Blind voucher DLEQ verification failed");
    }
    return {
      id: `vch_${hexlify(randomBytes(16)).slice(2)}`,
      asset: input.pending.asset,
      keysetId: input.pending.keysetId,
      denomAtomic: context.denomAtomic,
      secret: context.secret,
      C: unblindSignature({ C_: signature.C_, r: context.r, K: denomination.K }),
      r: context.r,
      dleq: signature.dleq,
    };
  });
  await input.wallet.finalize(input.pending.fingerprint, vouchers);
  return vouchers;
};

const verifyDiscoveredMint = (mint: DiscoveredMint, pinnedMintPubKey: string): void => {
  if (!sameBytes(mint.mintIdentityPubKey, pinnedMintPubKey)) {
    throw new Error("Mint identity public key does not match the pinned trust anchor");
  }
  if (!verifyCheckpoint(mint.checkpoint, pinnedMintPubKey)) {
    throw new Error("Mint checkpoint signature is invalid");
  }
  let previousHash = `0x${"00".repeat(32)}`;
  let previousSeq = -1;
  for (const signed of mint.manifest) {
    if (!verifyManifestEntry(signed, pinnedMintPubKey)) {
      throw new Error("Mint manifest signature is invalid");
    }
    if (signed.entry.asset !== mint.asset
      || signed.entry.prevEntryHash !== previousHash
      || signed.entry.seq !== previousSeq + 1) {
      throw new Error("Mint manifest hash chain is invalid");
    }
    previousHash = signed.entryHash;
    previousSeq = signed.entry.seq;
  }
  if (mint.manifest.length === 0
    || mint.checkpoint.headSeq !== previousSeq
    || mint.checkpoint.headEntryHash !== previousHash) {
    throw new Error("Mint checkpoint does not commit to the manifest head");
  }
  const manifestIds = new Set<string>();
  for (const signed of mint.manifest) {
    const recomputed = computeKeysetId({
      asset: signed.entry.asset,
      epoch: signed.entry.epoch,
      denominations: signed.entry.denominations,
    });
    if (recomputed !== signed.entry.keysetId) throw new Error("Mint keyset id is invalid");
    manifestIds.add(recomputed);
  }
  let active = 0;
  for (const keyset of mint.keysets) {
    if (keyset.asset !== mint.asset
      || computeKeysetId(keyset) !== keyset.keysetId
      || !manifestIds.has(keyset.keysetId)) {
      throw new Error("Published keyset is not committed by the mint manifest");
    }
    if (keyset.status === "active") active += 1;
  }
  if (active !== 1) throw new Error("Mint must publish exactly one active keyset");
};

const requireActiveKeyset = (mint: DiscoveredMint): PublicKeyset => {
  const keyset = mint.keysets.find((candidate) => candidate.status === "active");
  if (!keyset) throw new Error("Mint has no active keyset");
  return keyset;
};

const sumContextAtomic = (pending: PendingIssuance): string =>
  pending.contexts.reduce((sum, context) => sum + BigInt(context.denomAtomic), 0n).toString();

const sameBytes = (a: string, b: string): boolean => {
  try {
    return hexlify(getBytes(a)) === hexlify(getBytes(b));
  } catch {
    return false;
  }
};

const getJson = async <T>(rpcUrl: string, path: string): Promise<T> => {
  const response = await fetch(`${rpcUrl.replace(/\/$/, "")}${path}`, {
    headers: { Accept: "application/json" },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Private agent RPC returned ${response.status}`);
  return body;
};

const postJson = async <T>(
  rpcUrl: string,
  path: string,
  body: unknown,
): Promise<T> => {
  const response = await fetch(`${rpcUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `Private agent RPC returned ${response.status}`);
  return parsed;
};
