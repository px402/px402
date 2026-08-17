import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateLedgerAssetKey } from "../../shared/privateLedger";
import { BASE_USDC } from "../../shared/x402";
import { EphemeralPaymentJournal } from "./EphemeralPaymentJournal";
import { EncryptedJsonFile } from "../storage/EncryptedJsonFile";

interface LedgerAccount {
  availableAtomic: string;
}

interface LegacyLedgerPosting {
  accountId: string;
  deltaAtomic: string;
}

interface LegacyLedgerTransfer {
  id: string;
  source: "voucher" | "deposit";
  asset: string;
  authorizationHash: string;
  commitment: string;
  salt: string;
  postings: [LegacyLedgerPosting, LegacyLedgerPosting];
  acceptedAt: number;
  batchId?: string;
}

interface SettlementBatchV2 {
  id: string;
  asset: string;
  merkleRoot: string;
  transferCount: number;
  createdAt: number;
  transactionHash?: string;
  settledAt?: number;
}

interface LegacySettlementBatch extends SettlementBatchV2 {
  netPositions: Record<string, string>;
}

interface LedgerFileV1 {
  version: 1;
  accounts: Record<string, LedgerAccount>;
  transfers: LegacyLedgerTransfer[];
  batches: LegacySettlementBatch[];
}

export interface LedgerTransfer {
  id: string;
  source: "voucher" | "deposit" | "payout";
  asset: string;
  authorizationHash: string;
  commitment: string;
  acceptedAt: number;
  epochId: string;
  batchId?: string;
  transactionHash?: string;
  settledAt?: number;
  reversalAccountRef?: string;
  reversalAmountAtomic?: string;
  planHash?: string;
  reservationBinding?: string;
  payoutRef?: string;
}

export interface SettlementBatch {
  id: string;
  asset: string;
  network: string;
  tokenAddress: string;
  merkleRoot: string;
  transferCount: number;
  createdAt: number;
  transactionHash?: string;
  settledAt?: number;
}

interface LedgerFileV2 {
  version: 2;
  accounts: Record<string, LedgerAccount>;
  transfers: LedgerTransfer[];
  batches: SettlementBatchV2[];
  consumedDepositHashes: string[];
}

interface LedgerFileV3 {
  version: 3;
  accounts: Record<string, Record<string, LedgerAccount>>;
  transfers: LedgerTransfer[];
  batches: SettlementBatch[];
  consumedDepositHashes: string[];
  consumedVoucherRefs?: Record<string, string[]>;
}

interface LedgerFile {
  version: 4;
  accounts: Record<string, Record<string, LedgerAccount>>;
  transfers: LedgerTransfer[];
  batches: SettlementBatch[];
  consumedDepositHashes: string[];
  consumedVoucherRefs?: Record<string, string[]>;
}

export interface LedgerTransferInput {
  payerAgentId: string;
  payeeAgentId: string;
  amountAtomic: string;
  assetKey: string;
  authorizationNonce: string;
  resourceHash: string;
  acceptedAt?: number;
}

export interface LedgerTransferResult {
  commitment: string;
  payerBalanceAtomic: string;
  acceptedAt: number;
  duplicate: boolean;
}

export interface LedgerDepositInput {
  agentId: string;
  amountAtomic: string;
  network: string;
  assetKey: string;
  transactionHash: string;
  transferIndex?: number;
  acceptedAt?: number;
}

export interface LedgerPayoutInput {
  agentId: string;
  amountAtomic: string;
  assetKey: string;
  network: string;
  payoutRef: string;
  planHash: string;
  acceptedAt?: number;
}

export interface LedgerPayoutResult {
  commitment: string;
  balanceAtomic: string;
  acceptedAt: number;
  duplicate: boolean;
}

export interface PrivateLedgerBurnResult {
  batchesCompacted: number;
  transfersRemoved: number;
  epochsBurned: number;
}

export interface LedgerVoucherMeltInput {
  agentId: string;
  amountAtomic: string;
  assetKey: string;
  keysetId: string;
  meltKey: string;
  acceptedAt?: number;
}

export interface LedgerVoucherRedeemInput {
  recipientAgentId: string;
  amountAtomic: string;
  assetKey: string;
  keysetId: string;
  redeemKey: string;
  acceptedAt?: number;
}

export interface LedgerVoucherResult {
  balanceAtomic: string;
  duplicate: boolean;
}

export interface PrivatePaymentLedgerOptions {
  journal: EphemeralPaymentJournal;
  retentionMs: number;
  baseAssetKey?: string;
  payoutFinalityVerifier?: (input: {
    network: string;
    transactionHash: string;
  }) => Promise<boolean>;
  migrationReconcilePath?: string;
}

const EMPTY_LEDGER = (): LedgerFile => ({
  version: 4,
  accounts: {},
  transfers: [],
  batches: [],
  consumedDepositHashes: [],
  consumedVoucherRefs: {},
});

/**
 * Current-state-only private accounting. Durable state contains pseudonymous
 * balances and public settlement commitments; transaction detail lives in a
 * per-epoch encrypted tmpfs journal whose key is destroyed after settlement.
 */
export class PrivatePaymentLedger {
  private readonly file: EncryptedJsonFile<LedgerFile | LedgerFileV3 | LedgerFileV2 | LedgerFileV1>;
  private readonly accountKey: Buffer;
  private readonly baseAssetKey: string;
  private state: LedgerFile = EMPTY_LEDGER();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    encryptionKey: string,
    private readonly options: PrivatePaymentLedgerOptions,
  ) {
    if (!encryptionKey.trim()) {
      throw new Error("Private payment ledger requires PX402_DATA_ENCRYPTION_KEY");
    }
    if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) {
      throw new Error("Private payment ledger retention must be a non-negative duration");
    }
    this.file = new EncryptedJsonFile(filePath, encryptionKey, { failClosed: true, durable: true });
    this.migrationReconcilePath = options.migrationReconcilePath
      ?? join(dirname(filePath), "ledger-migration-reconcile.json");
    this.accountKey = createHash("sha256")
      .update("px402-private-ledger/account-index/v2\0")
      .update(encryptionKey)
      .digest();
    this.baseAssetKey = (options.baseAssetKey
      ?? privateLedgerAssetKey("base", BASE_USDC.address)).toLowerCase();
  }

  private readonly migrationReconcilePath: string;

  async load(initialBalances: Record<string, string> = {}) {
    await this.options.journal.assertReady();
    const stored = await this.file.read(EMPTY_LEDGER());
    const migrated = stored.version !== 4;
    const v3 = stored.version === 1
      ? this.migrateV2ToV3(this.migrateV1ToV2(stored))
      : stored.version === 2
        ? this.migrateV2ToV3(stored)
        : stored;
    this.state = v3.version === 3 ? await this.migrateV3ToV4(v3) : v3;
    const missingVoucherRefs = this.state.consumedVoucherRefs === undefined;
    this.state.consumedVoucherRefs ??= {};
    const conservationRepaired = this.repairConservation();
    this.assertState();

    let changed = migrated
      || missingVoucherRefs
      || conservationRepaired
      || this.file.shouldRewriteEncrypted();
    for (const [agentId, amount] of Object.entries(initialBalances)) {
      const accountId = this.accountId(agentId);
      if (this.state.accounts[accountId]?.[this.baseAssetKey]) continue;
      const value = BigInt(amount);
      if (value < 0n) throw new Error(`Negative initial private balance for ${agentId}`);
      this.setBalance(agentId, this.baseAssetKey, value);
      const escrowAccount = `escrow:${this.baseAssetKey}`;
      this.setBalance(
        escrowAccount,
        this.baseAssetKey,
        BigInt(this.balance(escrowAccount, this.baseAssetKey)) - value,
      );
      changed = true;
    }
    this.assertState();
    if (changed) await this.persist();

    const referencedEpochs = new Set(this.state.transfers.map((entry) => entry.epochId));
    await this.options.journal.burnOrphans(referencedEpochs);
    return this;
  }

  balance(agentId: string, assetKey: string) {
    return this.state.accounts[this.accountId(agentId)]?.[assetKey.toLowerCase()]?.availableAtomic ?? "0";
  }

  accountReference(agentId: string): string {
    return this.accountId(agentId);
  }

  meltToVouchers(input: LedgerVoucherMeltInput): Promise<LedgerVoucherResult> {
    return this.serialize(async () => {
      const amount = BigInt(input.amountAtomic);
      if (amount <= 0n) throw new Error("Blind voucher melt amount must be positive");
      const assetKey = input.assetKey.toLowerCase();
      const voucherAccount = `vouchers:${assetKey}:${input.keysetId}`;
      const authHash = hash(`voucher-melt:${input.meltKey}`);
      const consumed = this.state.consumedVoucherRefs![input.keysetId] ?? [];
      if (consumed.includes(authHash)) {
        return {
          balanceAtomic: this.balance(input.agentId, assetKey),
          duplicate: true,
        };
      }
      const agentBalance = BigInt(this.balance(input.agentId, assetKey));
      if (agentBalance < amount) throw new Error("Insufficient private ledger balance");
      const previous = structuredClone(this.state);
      const previousTotal = this.totalBalance(assetKey);
      this.setBalance(input.agentId, assetKey, agentBalance - amount);
      this.setBalance(
        voucherAccount,
        assetKey,
        BigInt(this.balance(voucherAccount, assetKey)) + amount,
      );
      this.state.consumedVoucherRefs![input.keysetId] = [...consumed, authHash];
      this.assertConserved(assetKey, previousTotal);
      this.assertState();
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return {
        balanceAtomic: this.balance(input.agentId, assetKey),
        duplicate: false,
      };
    });
  }

  redeemToAccount(input: LedgerVoucherRedeemInput): Promise<LedgerVoucherResult> {
    return this.serialize(async () => {
      const amount = BigInt(input.amountAtomic);
      if (amount <= 0n) throw new Error("Blind voucher redeem amount must be positive");
      const assetKey = input.assetKey.toLowerCase();
      const voucherAccount = `vouchers:${assetKey}:${input.keysetId}`;
      const authHash = hash(`voucher-redeem:${input.redeemKey}`);
      const consumed = this.state.consumedVoucherRefs![input.keysetId] ?? [];
      if (consumed.includes(authHash)) {
        return {
          balanceAtomic: this.balance(input.recipientAgentId, assetKey),
          duplicate: true,
        };
      }
      if (BigInt(this.voucherLiability(assetKey, input.keysetId)) < amount) {
        throw new Error("Blind voucher liability is insufficient");
      }
      const previous = structuredClone(this.state);
      const previousTotal = this.totalBalance(assetKey);
      this.setBalance(
        voucherAccount,
        assetKey,
        BigInt(this.balance(voucherAccount, assetKey)) - amount,
      );
      this.setBalance(
        input.recipientAgentId,
        assetKey,
        BigInt(this.balance(input.recipientAgentId, assetKey)) + amount,
      );
      this.state.consumedVoucherRefs![input.keysetId] = [...consumed, authHash];
      this.assertConserved(assetKey, previousTotal);
      this.assertState();
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return {
        balanceAtomic: this.balance(input.recipientAgentId, assetKey),
        duplicate: false,
      };
    });
  }

  reclaimRetiredKeyset(input: {
    assetKey: string;
    keysetId: string;
  }): Promise<{ reclaimedAtomic: string }> {
    return this.serialize(async () => {
      const assetKey = input.assetKey.toLowerCase();
      const amount = BigInt(this.voucherLiability(assetKey, input.keysetId));
      const previous = structuredClone(this.state);
      const previousTotal = this.totalBalance(assetKey);
      if (amount > 0n) {
        const voucherAccount = `vouchers:${assetKey}:${input.keysetId}`;
        const escrowAccount = `escrow:${assetKey}`;
        this.setBalance(voucherAccount, assetKey, 0n);
        this.setBalance(
          escrowAccount,
          assetKey,
          BigInt(this.balance(escrowAccount, assetKey)) + amount,
        );
      }
      // M5: when reclaim moves live liability, retain the ledger tombstones
      // until the caller has durably erased the mint keys. A second zero-value
      // call after mint.eraseKeyset performs the final tombstone prune.
      if (amount === 0n) delete this.state.consumedVoucherRefs![input.keysetId];
      this.assertConserved(assetKey, previousTotal);
      this.assertState();
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return { reclaimedAtomic: amount.toString() };
    });
  }

  voucherLiability(assetKey: string, keysetId: string): string {
    return this.balance(`vouchers:${assetKey.toLowerCase()}:${keysetId}`, assetKey);
  }

  transfer(input: LedgerTransferInput): Promise<LedgerTransferResult> {
    return this.serialize(async () => {
      if (input.payerAgentId === input.payeeAgentId) {
        throw new Error("Private ledger payer and payee must differ");
      }
      const amount = BigInt(input.amountAtomic);
      if (amount <= 0n) throw new Error("Private ledger amount must be positive");
      const authorizationHash = hash(`authorization:${input.authorizationNonce}`);
      const existing = this.state.transfers.find((entry) => entry.authorizationHash === authorizationHash);
      if (existing) {
        return {
          commitment: existing.commitment,
          payerBalanceAtomic: this.balance(input.payerAgentId, input.assetKey),
          acceptedAt: existing.acceptedAt,
          duplicate: true,
        };
      }

      const asset = input.assetKey.toLowerCase();
      const payerBalance = BigInt(this.balance(input.payerAgentId, asset));
      if (payerBalance < amount) throw new Error(`Insufficient private balance for asset ${asset}`);
      const payeeBalance = BigInt(this.balance(input.payeeAgentId, asset));
      const acceptedAt = input.acceptedAt ?? Date.now();
      const salt = randomBytes(32).toString("hex");
      const commitment = hash([
        "px402-private-ledger/v2",
        input.payerAgentId,
        input.payeeAgentId,
        amount.toString(),
        asset,
        authorizationHash,
        input.resourceHash,
        String(acceptedAt),
        salt,
      ].join(":"));
      const epochId = await this.options.journal.append(asset, {
        source: "voucher",
        asset,
        payer: input.payerAgentId,
        payee: input.payeeAgentId,
        amountAtomic: amount.toString(),
        resourceHash: input.resourceHash,
        authorizationHash,
        commitment,
        salt,
        acceptedAt,
      });

      const previous = structuredClone(this.state);
      this.setBalance(input.payerAgentId, asset, payerBalance - amount);
      this.setBalance(input.payeeAgentId, asset, payeeBalance + amount);
      this.state.transfers.push({
        id: `ledger-${randomBytes(12).toString("hex")}`,
        source: "voucher",
        asset,
        authorizationHash,
        commitment,
        acceptedAt,
        epochId,
      });
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return {
        commitment,
        payerBalanceAtomic: (payerBalance - amount).toString(),
        acceptedAt,
        duplicate: false,
      };
    });
  }

  creditDeposit(input: LedgerDepositInput): Promise<LedgerTransferResult> {
    return this.serialize(async () => {
      const amount = BigInt(input.amountAtomic);
      if (amount <= 0n) throw new Error("Private ledger deposit must be positive");
      const transactionHash = input.network === "solana"
        ? input.transactionHash
        : input.transactionHash.toLowerCase();
      const legacyAuthorizationHash = this.legacyDepositAuthorizationHash(
        input.network,
        transactionHash,
      );
      const authorizationHash = input.transferIndex === undefined
        ? legacyAuthorizationHash
        : this.indexedDepositAuthorizationHash(
          input.network,
          transactionHash,
          input.transferIndex,
        );
      const existing = this.state.transfers.find((entry) => entry.authorizationHash === authorizationHash);
      if (existing) {
        return {
          commitment: existing.commitment,
          payerBalanceAtomic: this.balance(input.agentId, input.assetKey),
          acceptedAt: existing.acceptedAt,
          duplicate: true,
        };
      }
      if (this.state.consumedDepositHashes.includes(authorizationHash)) {
        throw new Error(`Deposit transaction already credited for asset ${input.assetKey}`);
      }
      if (input.transferIndex !== undefined
        && (this.state.transfers.some((entry) =>
          entry.authorizationHash === legacyAuthorizationHash)
          || this.state.consumedDepositHashes.includes(legacyAuthorizationHash))) {
        throw new Error(`Deposit transaction already credited under the legacy proof key for asset ${input.assetKey}`);
      }

      const acceptedAt = input.acceptedAt ?? Date.now();
      const asset = input.assetKey.toLowerCase();
      const balance = BigInt(this.balance(input.agentId, asset));
      const escrowAccount = `escrow:${asset}`;
      const escrowBalance = BigInt(this.balance(escrowAccount, asset));
      const salt = randomBytes(32).toString("hex");
      const commitment = hash([
        "px402-private-ledger-deposit/v2",
        input.agentId,
        amount.toString(),
        asset,
        authorizationHash,
        String(acceptedAt),
        salt,
      ].join(":"));
      const epochId = await this.options.journal.append(asset, {
        source: "deposit",
        asset,
        payee: input.agentId,
        amountAtomic: amount.toString(),
        authorizationHash,
        commitment,
        salt,
        acceptedAt,
      });

      const previous = structuredClone(this.state);
      this.setBalance(input.agentId, asset, balance + amount);
      this.setBalance(escrowAccount, asset, escrowBalance - amount);
      this.state.consumedDepositHashes.push(authorizationHash);
      this.state.transfers.push({
        id: `deposit-${randomBytes(12).toString("hex")}`,
        source: "deposit",
        asset,
        authorizationHash,
        commitment,
        acceptedAt,
        epochId,
      });
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return {
        commitment,
        payerBalanceAtomic: (balance + amount).toString(),
        acceptedAt,
        duplicate: false,
      };
    });
  }

  depositProofClaim(input: {
    network: string;
    transactionHash: string;
    transferIndex: number;
  }): "indexed" | "legacy" | undefined {
    const transactionHash = input.network === "solana"
      ? input.transactionHash
      : input.transactionHash.toLowerCase();
    const indexed = this.indexedDepositAuthorizationHash(
      input.network,
      transactionHash,
      input.transferIndex,
    );
    if (this.state.transfers.some((entry) => entry.authorizationHash === indexed)
      || this.state.consumedDepositHashes.includes(indexed)) {
      return "indexed";
    }
    const legacy = this.legacyDepositAuthorizationHash(input.network, transactionHash);
    if (this.state.transfers.some((entry) => entry.authorizationHash === legacy)
      || this.state.consumedDepositHashes.includes(legacy)) {
      return "legacy";
    }
    return undefined;
  }

  ledgerLiability(assetKey: string): bigint {
    const escrow = BigInt(this.balance(`escrow:${assetKey.toLowerCase()}`, assetKey));
    return escrow < 0n ? -escrow : 0n;
  }

  payout(input: LedgerPayoutInput): Promise<LedgerPayoutResult> {
    return this.serialize(async () => {
      const amount = BigInt(input.amountAtomic);
      if (amount <= 0n) throw new Error("Private ledger payout must be positive");
      if (!input.planHash) throw new Error("Private ledger payout planHash is required");
      const authorizationHash = hash(`payout:${input.payoutRef}`);
      const asset = input.assetKey.toLowerCase();
      const reversalAccountRef = this.accountReference(input.agentId);
      const reservationBinding = payoutReservationBinding({
        payerAccountRef: reversalAccountRef,
        assetKey: asset,
        network: input.network,
        amountAtomic: amount.toString(),
        planHash: input.planHash,
      });
      const existing = this.state.transfers.find(
        (entry) => entry.authorizationHash === authorizationHash && entry.source === "payout",
      );
      if (existing) {
        if (existing.reservationBinding !== reservationBinding) {
          throw new Error("Private ledger payout reservation binding mismatch");
        }
        return {
          commitment: existing.commitment,
          balanceAtomic: this.balanceByRef(reversalAccountRef, asset),
          acceptedAt: existing.acceptedAt,
          duplicate: true,
        };
      }

      const balance = BigInt(this.balanceByRef(reversalAccountRef, asset));
      if (balance < amount) throw new Error(`Insufficient private balance for asset ${asset}`);
      const escrowAccount = `escrow:${asset}`;
      const escrowBalance = BigInt(this.balance(escrowAccount, asset));
      const acceptedAt = input.acceptedAt ?? Date.now();
      const salt = randomBytes(32).toString("hex");
      const commitment = hash([
        "px402-private-ledger-payout/v1",
        input.agentId,
        amount.toString(),
        asset,
        input.network,
        authorizationHash,
        String(acceptedAt),
        salt,
      ].join(":"));
      const epochId = await this.options.journal.append(asset, {
        source: "payout",
        asset,
        payer: input.agentId,
        payee: escrowAccount,
        amountAtomic: amount.toString(),
        authorizationHash,
        commitment,
        salt,
        acceptedAt,
      });

      const previous = structuredClone(this.state);
      const previousTotal = this.totalBalance(asset);
      this.setBalanceByRef(reversalAccountRef, asset, balance - amount);
      this.setBalance(escrowAccount, asset, escrowBalance + amount);
      this.state.transfers.push({
        id: `payout-${randomBytes(12).toString("hex")}`,
        source: "payout",
        asset,
        authorizationHash,
        commitment,
        acceptedAt,
        epochId,
        reversalAccountRef,
        reversalAmountAtomic: amount.toString(),
        planHash: input.planHash,
        reservationBinding,
        payoutRef: input.payoutRef,
      });
      this.assertConserved(asset, previousTotal);
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return {
        commitment,
        balanceAtomic: (balance - amount).toString(),
        acceptedAt,
        duplicate: false,
      };
    });
  }

  markPayoutSettled(payoutRef: string, transactionHash?: string): Promise<void> {
    return this.serialize(async () => {
      const authorizationHash = hash(`payout:${payoutRef}`);
      const transfer = this.state.transfers.find(
        (entry) => entry.authorizationHash === authorizationHash && entry.source === "payout",
      );
      if (!transfer) throw new Error("Private ledger payout not found");
      const network = transfer.asset.slice(0, transfer.asset.indexOf(":"));
      const normalizedHash = transactionHash
        ? network === "solana" ? transactionHash : transactionHash.toLowerCase()
        : undefined;
      if (transfer.settledAt !== undefined) {
        if (transfer.transactionHash !== normalizedHash) {
          throw new Error("Private ledger payout already settled with a conflicting transaction hash");
        }
        return;
      }
      const previous = {
        transactionHash: transfer.transactionHash,
        settledAt: transfer.settledAt,
      };
      transfer.transactionHash = normalizedHash;
      transfer.settledAt = Date.now();
      try {
        await this.persist();
      } catch (error) {
        transfer.transactionHash = previous.transactionHash;
        transfer.settledAt = previous.settledAt;
        throw error;
      }
    });
  }

  recordPayoutTransaction(payoutRef: string, transactionHash: string): Promise<void> {
    return this.markPayoutSettled(payoutRef, transactionHash);
  }

  reversePayout(payoutRef: string): Promise<boolean> {
    return this.serialize(() => this.reversePayoutUnserialized(payoutRef));
  }

  reverseOrphanPayouts(knownRefs: ReadonlySet<string>): Promise<number> {
    return this.serialize(async () => {
      const orphanRefs = this.state.transfers
        .filter((transfer) => transfer.source === "payout"
          && transfer.settledAt === undefined
          && !transfer.batchId)
        .map((transfer) => transfer.payoutRef)
        .filter((ref): ref is string => typeof ref === "string" && !knownRefs.has(ref));
      let reversed = 0;
      for (const ref of orphanRefs) {
        const didReverse = await this.reversePayoutUnserialized(ref);
        if (didReverse) reversed += 1;
      }
      return reversed;
    });
  }

  pendingPayoutRefs(): string[] {
    return this.state.transfers
      .filter((transfer) => transfer.source === "payout"
        && transfer.settledAt === undefined
        && !transfer.batchId)
      .flatMap((transfer) => transfer.payoutRef ? [transfer.payoutRef] : []);
  }

  findPayoutTransfer(payoutRef: string) {
    const authorizationHash = hash(`payout:${payoutRef}`);
    const transfer = this.state.transfers.find(
      (entry) => entry.source === "payout" && entry.authorizationHash === authorizationHash,
    );
    return transfer ? {
      asset: transfer.asset,
      reversalAccountRef: transfer.reversalAccountRef,
      reversalAmountAtomic: transfer.reversalAmountAtomic,
      settledAt: transfer.settledAt,
      batchId: transfer.batchId,
    } : undefined;
  }

  createSettlementBatch(input: {
    assetKey: string;
    network: string;
    tokenAddress: string;
  }): Promise<SettlementBatch | undefined> {
    return this.serialize(async () => {
      const normalizedAsset = input.assetKey.toLowerCase();
      if (normalizedAsset !== privateLedgerAssetKey(input.network, input.tokenAddress)) {
        throw new Error("Private settlement batch asset key does not match its network and token");
      }
      const pending = this.state.transfers.filter(
        (entry) => !entry.batchId
          && entry.asset === normalizedAsset
          && (entry.source !== "payout" || entry.settledAt != null),
      );
      if (pending.length === 0) return undefined;

      this.options.journal.seal(normalizedAsset);
      const batchId = `batch-${randomBytes(12).toString("hex")}`;
      const batch: SettlementBatch = {
        id: batchId,
        asset: normalizedAsset,
        network: input.network,
        tokenAddress: input.tokenAddress,
        merkleRoot: merkleRoot(pending.map((entry) => entry.commitment)),
        transferCount: pending.length,
        createdAt: Date.now(),
      };
      const previous = structuredClone(this.state);
      for (const transfer of pending) transfer.batchId = batchId;
      this.state.batches.push(batch);
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return structuredClone(batch);
    });
  }

  unsettledBatch(asset: string) {
    const normalizedAsset = asset.toLowerCase();
    const batch = this.state.batches.find(
      (entry) => entry.asset === normalizedAsset && !entry.settledAt,
    );
    return batch ? structuredClone(batch) : undefined;
  }

  markBatchCommitted(batchId: string, transactionHash?: string): Promise<SettlementBatch> {
    return this.serialize(async () => {
      const batch = this.state.batches.find((entry) => entry.id === batchId);
      if (!batch) throw new Error("Private settlement batch not found");
      if (!batch.settledAt) {
        batch.transactionHash = batch.network === "solana"
          ? transactionHash
          : transactionHash?.toLowerCase();
        batch.settledAt = Date.now();
        await this.persist();
      }
      return structuredClone(batch);
    });
  }

  burnExpired(now = Date.now()): Promise<PrivateLedgerBurnResult> {
    return this.serialize(async () => {
      const expiredBatchIds = new Set(
        this.state.batches
          .filter((batch) => batch.settledAt !== undefined
            && batch.settledAt + this.options.retentionMs <= now)
          .map((batch) => batch.id),
      );
      if (expiredBatchIds.size === 0) {
        return { batchesCompacted: 0, transfersRemoved: 0, epochsBurned: 0 };
      }

      const removed = this.state.transfers.filter(
        (transfer) => transfer.batchId && expiredBatchIds.has(transfer.batchId),
      );
      const retained = this.state.transfers.filter((transfer) => !removed.includes(transfer));
      const retainedEpochIds = new Set(retained.map((transfer) => transfer.epochId));
      const erasableEpochIds = new Set(
        removed
          .map((transfer) => transfer.epochId)
          .filter((epochId) => !retainedEpochIds.has(epochId)),
      );

      const epochsBurned = await this.options.journal.burn(erasableEpochIds);
      this.state.transfers = retained;
      await this.persist();
      return {
        batchesCompacted: expiredBatchIds.size,
        transfersRemoved: removed.length,
        epochsBurned,
      };
    });
  }

  close(): void {
    this.options.journal.close();
    this.accountKey.fill(0);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist() {
    return this.file.write(this.state);
  }

  private balanceByRef(accountRef: string, assetKey: string) {
    return this.state.accounts[accountRef]?.[assetKey.toLowerCase()]?.availableAtomic ?? "0";
  }

  private setBalanceByRef(accountRef: string, assetKey: string, value: bigint) {
    const balances = this.state.accounts[accountRef] ?? {};
    balances[assetKey.toLowerCase()] = { availableAtomic: value.toString() };
    this.state.accounts[accountRef] = balances;
  }

  private setBalance(agentId: string, assetKey: string, value: bigint) {
    this.setBalanceByRef(this.accountId(agentId), assetKey, value);
  }

  private async reversePayoutUnserialized(payoutRef: string): Promise<boolean> {
    const authorizationHash = hash(`payout:${payoutRef}`);
    const transferIndex = this.state.transfers.findIndex(
      (entry) => entry.authorizationHash === authorizationHash && entry.source === "payout",
    );
    if (transferIndex < 0) return false;
    const transfer = this.state.transfers[transferIndex];
    if (transfer.batchId) throw new Error("Batched private ledger payout cannot be reversed");
    if (transfer.settledAt !== undefined) {
      throw new Error("Settled private ledger payout cannot be reversed");
    }
    if (!transfer.reversalAccountRef || !transfer.reversalAmountAtomic) {
      throw new Error("Private ledger payout durable reversal data unavailable");
    }
    const amount = BigInt(transfer.reversalAmountAtomic);
    const asset = transfer.asset;
    const escrowAccount = `escrow:${asset}`;
    const previous = structuredClone(this.state);
    const previousTotal = this.totalBalance(asset);
    this.setBalanceByRef(
      transfer.reversalAccountRef,
      asset,
      BigInt(this.balanceByRef(transfer.reversalAccountRef, asset)) + amount,
    );
    this.setBalance(
      escrowAccount,
      asset,
      BigInt(this.balance(escrowAccount, asset)) - amount,
    );
    this.state.transfers.splice(transferIndex, 1);
    this.assertConserved(asset, previousTotal);
    try {
      await this.persist();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return true;
  }

  private totalBalance(assetKey: string): bigint {
    const normalizedAsset = assetKey.toLowerCase();
    let total = 0n;
    for (const balances of Object.values(this.state.accounts)) {
      total += BigInt(balances[normalizedAsset]?.availableAtomic ?? "0");
    }
    return total;
  }

  private assertConserved(assetKey: string, expectedTotal: bigint) {
    if (this.totalBalance(assetKey) !== expectedTotal) {
      throw new Error(`Private ledger conservation invariant failed for asset ${assetKey}`);
    }
  }

  private repairConservation(): boolean {
    const assets = new Set(
      Object.values(this.state.accounts).flatMap((balances) => Object.keys(balances)),
    );
    let changed = false;
    for (const asset of assets) {
      const total = this.totalBalance(asset);
      if (total === 0n) continue;
      const escrowAccount = `escrow:${asset}`;
      this.setBalance(
        escrowAccount,
        asset,
        BigInt(this.balance(escrowAccount, asset)) - total,
      );
      changed = true;
    }
    return changed;
  }

  private accountId(agentId: string): string {
    return `acct_${createHmac("sha256", this.accountKey).update(agentId).digest("hex")}`;
  }

  private legacyDepositAuthorizationHash(network: string, transactionHash: string) {
    // Base retains the v2 hash formula so deposits credited before the v3
    // migration cannot be replayed; other networks include their id.
    return hash(network === "base"
      ? `deposit:${transactionHash}`
      : `deposit:${network}:${transactionHash}`);
  }

  private indexedDepositAuthorizationHash(
    network: string,
    transactionHash: string,
    transferIndex: number,
  ) {
    if (!Number.isSafeInteger(transferIndex) || transferIndex < 0) {
      throw new Error("Deposit transferIndex must be a non-negative safe integer");
    }
    return hash(`depositProof:${network}:${transactionHash}:${transferIndex}`);
  }

  private migrateV1ToV2(legacy: LedgerFileV1): LedgerFileV2 {
    return {
      version: 2,
      accounts: Object.fromEntries(
        Object.entries(legacy.accounts).map(([accountId, account]) => [
          this.accountId(accountId),
          account,
        ]),
      ),
      transfers: legacy.transfers.map((transfer) => ({
        id: transfer.id,
        source: transfer.source,
        asset: transfer.asset.toLowerCase(),
        authorizationHash: transfer.authorizationHash,
        commitment: transfer.commitment,
        acceptedAt: transfer.acceptedAt,
        epochId: `legacy-${createHash("sha256").update(transfer.id).digest("hex").slice(0, 24)}`,
        batchId: transfer.batchId,
      })),
      batches: legacy.batches.map(({ netPositions: _discarded, ...batch }) => batch),
      consumedDepositHashes: legacy.transfers
        .filter((transfer) => transfer.source === "deposit")
        .map((transfer) => transfer.authorizationHash),
    };
  }

  private migrateV2ToV3(legacy: LedgerFileV2): LedgerFileV3 {
    return {
      version: 3,
      accounts: Object.fromEntries(
        Object.entries(legacy.accounts).map(([accountId, account]) => [
          accountId,
          { [this.baseAssetKey]: account },
        ]),
      ),
      transfers: legacy.transfers.map((transfer) => ({
        ...transfer,
        asset: privateLedgerAssetKey("base", transfer.asset),
      })),
      batches: legacy.batches.map((batch) => {
        const tokenAddress = batch.asset.toLowerCase();
        return {
          ...batch,
          asset: privateLedgerAssetKey("base", tokenAddress),
          network: "base",
          tokenAddress,
        };
      }),
      consumedDepositHashes: [...legacy.consumedDepositHashes],
      consumedVoucherRefs: {},
    };
  }

  private async migrateV3ToV4(legacy: LedgerFileV3): Promise<LedgerFile> {
    const next: LedgerFile = {
      ...structuredClone(legacy),
      version: 4,
    };
    const dispositions = await readMigrationDispositions(this.migrationReconcilePath);
    const unresolved: { ref: string; transactionHash?: string; note: string }[] = [];

    for (let index = next.transfers.length - 1; index >= 0; index -= 1) {
      const transfer = next.transfers[index];
      if (transfer.source !== "payout") continue;
      const ref = transfer.payoutRef ?? transfer.authorizationHash;
      let finalized = false;
      if (transfer.transactionHash && this.options.payoutFinalityVerifier) {
        const network = transfer.asset.slice(0, transfer.asset.indexOf(":"));
        finalized = await this.options.payoutFinalityVerifier({
          network,
          transactionHash: transfer.transactionHash,
        });
      }
      if (finalized) {
        transfer.settledAt = transfer.acceptedAt;
        continue;
      }

      const disposition = dispositions.get(ref);
      if (!disposition) {
        unresolved.push({
          ref,
          transactionHash: transfer.transactionHash,
          note: transfer.transactionHash
            ? "transaction hash is not verified canonical under the finalized head"
            : "hashless payout is ambiguous: dry-run settlement or unbroadcast orphan",
        });
        continue;
      }
      if (disposition.disposition === "settled") {
        transfer.settledAt = transfer.acceptedAt;
        continue;
      }

      const journalEntries = await this.options.journal.read(transfer.epochId);
      const detail = journalEntries.find(
        (entry) => entry.source === "payout"
          && entry.authorizationHash === transfer.authorizationHash,
      );
      if (!detail?.payer) {
        unresolved.push({
          ref,
          transactionHash: transfer.transactionHash,
          note: "orphan disposition cannot be applied because legacy tmpfs reversal detail is unavailable",
        });
        continue;
      }
      const asset = transfer.asset;
      const amount = BigInt(detail.amountAtomic);
      const payerRef = this.accountReference(detail.payer);
      const payerBalances = next.accounts[payerRef] ?? {};
      const escrowRef = this.accountReference(`escrow:${asset}`);
      const escrowBalances = next.accounts[escrowRef] ?? {};
      payerBalances[asset] = {
        availableAtomic: (BigInt(payerBalances[asset]?.availableAtomic ?? "0") + amount).toString(),
      };
      escrowBalances[asset] = {
        availableAtomic: (BigInt(escrowBalances[asset]?.availableAtomic ?? "0") - amount).toString(),
      };
      next.accounts[payerRef] = payerBalances;
      next.accounts[escrowRef] = escrowBalances;
      next.transfers.splice(index, 1);
    }

    if (unresolved.length > 0) {
      await writeMigrationManifest(this.migrationReconcilePath, unresolved);
      throw new Error(
        `Private payment ledger v3->v4 migration requires per-row reconciliation: ${this.migrationReconcilePath}`,
      );
    }
    return next;
  }

  private assertState() {
    if (this.state.version !== 4
      || !this.state.accounts
      || !Array.isArray(this.state.transfers)
      || !Array.isArray(this.state.batches)
      || !Array.isArray(this.state.consumedDepositHashes)
      || !this.state.consumedVoucherRefs
      || typeof this.state.consumedVoucherRefs !== "object"
      || Array.isArray(this.state.consumedVoucherRefs)) {
      throw new Error("Private payment ledger file is invalid");
    }
    for (const [keysetId, authHashes] of Object.entries(this.state.consumedVoucherRefs)) {
      if (!keysetId
        || !Array.isArray(authHashes)
        || authHashes.some((entry) => !/^0x[0-9a-fA-F]+$/.test(entry))) {
        throw new Error("Private payment ledger voucher references are invalid");
      }
    }
    for (const balances of Object.values(this.state.accounts)) {
      for (const [assetKey, account] of Object.entries(balances)) {
        if (!assetKey.includes(":")) throw new Error("Private ledger account asset is invalid");
        BigInt(account.availableAtomic);
      }
    }
    for (const transfer of this.state.transfers) {
      if (!transfer.asset.includes(":")
        || !transfer.commitment.startsWith("0x")
        || !transfer.authorizationHash.startsWith("0x")) {
        throw new Error(`Private ledger transfer ${transfer.id} is invalid`);
      }
    }
    for (const batch of this.state.batches) {
      if (batch.asset !== privateLedgerAssetKey(batch.network, batch.tokenAddress)) {
        throw new Error(`Private ledger batch ${batch.id} is invalid`);
      }
    }
    const assets = new Set(
      Object.values(this.state.accounts).flatMap((balances) => Object.keys(balances)),
    );
    for (const asset of assets) {
      if (this.totalBalance(asset) !== 0n) {
        throw new Error(`Private ledger conservation invariant failed for asset ${asset}`);
      }
    }
  }
}

const hash = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}`;

const payoutReservationBinding = (input: {
  payerAccountRef: string;
  assetKey: string;
  network: string;
  amountAtomic: string;
  planHash: string;
}) => hash([
  input.payerAccountRef,
  input.assetKey.toLowerCase(),
  input.network,
  input.amountAtomic,
  input.planHash,
].join(":"));

interface MigrationDisposition {
  disposition: "settled" | "orphan";
  note?: string;
}

const readMigrationDispositions = async (filePath: string) => {
  const result = new Map<string, MigrationDisposition>();
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const rows = parsed && typeof parsed === "object" && "rows" in parsed
      ? (parsed as { rows?: unknown }).rows
      : parsed;
    if (rows && typeof rows === "object" && !Array.isArray(rows)) {
      for (const [ref, value] of Object.entries(rows)) {
        if (value === "settled" || value === "orphan") {
          result.set(ref, { disposition: value });
        } else if (value && typeof value === "object") {
          const row = value as { disposition?: unknown; note?: unknown };
          if (row.disposition === "settled" || row.disposition === "orphan") {
            result.set(ref, {
              disposition: row.disposition,
              note: typeof row.note === "string" ? row.note : undefined,
            });
          }
        }
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return result;
};

const writeMigrationManifest = async (
  filePath: string,
  unresolved: { ref: string; transactionHash?: string; note: string }[],
) => {
  await mkdir(dirname(filePath), { recursive: true });
  const body = JSON.stringify({
    version: 1,
    instructions: "For each row set disposition to settled or orphan and add an evidence note.",
    rows: Object.fromEntries(unresolved.map((row) => [
      row.ref,
      {
        disposition: null,
        transactionHash: row.transactionHash,
        note: row.note,
      },
    ])),
  }, null, 2);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, body, { mode: 0o600 });
  const file = await open(temporaryPath, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, filePath);
  const directory = await open(dirname(filePath), "r");
  try {
    try {
      await directory.sync();
    } catch (error) {
      if (!(process.platform === "win32"
        && typeof error === "object"
        && error !== null
        && "code" in error
        && ["EPERM", "EINVAL", "EBADF"].includes((error as { code?: string }).code ?? ""))) {
        throw error;
      }
    }
  } finally {
    await directory.close();
  }
};

const isMissingFile = (error: unknown) => (
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as { code?: string }).code === "ENOENT"
);

const merkleRoot = (values: string[]) => {
  if (values.length === 0) return hash("");
  let layer: Buffer<ArrayBufferLike>[] = values
    .map((value) => Buffer.from(value.slice(2), "hex"))
    .sort(Buffer.compare);
  while (layer.length > 1) {
    const next: Buffer<ArrayBufferLike>[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index];
      const right = layer[index + 1] ?? left;
      next.push(createHash("sha256").update(Buffer.concat([left, right])).digest());
    }
    layer = next;
  }
  return `0x${layer[0].toString("hex")}`;
};
