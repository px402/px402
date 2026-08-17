import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { SOLANA_USDC, type X402TokenConfig } from "../../shared/x402";
import {
  deriveSolanaDepositAddress,
  deriveSolanaDepositScalar,
  deriveSolanaTreasuryStealthKeys,
  solanaKeyVersion,
  type TreasuryKeyContext,
} from "../../shared/depositStealth";
import { sweepStealth, type SolanaStealthMetaAddress } from "../../shared/stealthSolana";
import {
  verifySolanaPayment,
  type SolanaX402PaymentPayload,
  type SolanaX402PaymentRequirements
} from "../../shared/x402Solana";
import type { X402Settlement, X402SettlementMode } from "./X402Facilitator";
import type { ChainRailPayoutVerdict } from "../rails/ChainRail";

export interface SolanaX402FacilitatorOptions {
  rpcUrl: string;
  settlerSecretKey?: string;
  settlerPubkey?: PublicKey | string;
  token?: X402TokenConfig;
  connection?: Connection;
  historyConnection?: Connection;
  historyRpcUrl?: string;
  recoverySettlerSecretKeys?: readonly string[];
  sendCoordinator?: { send<T>(operation: () => Promise<T>): Promise<T> };
}

export interface SolanaX402Simulation {
  wouldSettle: boolean;
  detail: string;
  logs?: string[];
}

export class SolanaX402Facilitator {
  private readonly token: X402TokenConfig;
  private readonly connection: Connection;
  private readonly historyConnection?: Connection;
  private readonly settler?: Keypair;
  private readonly feePayer: PublicKey;
  private readonly consumedPayments = new Map<string, number>();
  private readonly depositMeta = new Map<string, SolanaStealthMetaAddress>();
  private static readonly PAYMENT_TTL_MS = 60 * 60 * 1000;

  constructor(private readonly options: SolanaX402FacilitatorOptions) {
    this.token = options.token ?? SOLANA_USDC;
    if (this.token.kind !== "solana") throw new Error("Solana facilitator requires a Solana token config");
    this.connection = options.connection ?? new Connection(options.rpcUrl, "confirmed");
    this.historyConnection = options.historyConnection
      ?? (options.historyRpcUrl ? new Connection(options.historyRpcUrl, "finalized") : undefined);
    this.settler = options.settlerSecretKey
      ? Keypair.fromSecretKey(decodeBase58(options.settlerSecretKey))
      : undefined;
    this.feePayer = this.settler?.publicKey
      ?? (options.settlerPubkey instanceof PublicKey ? options.settlerPubkey : new PublicKey(options.settlerPubkey ?? "11111111111111111111111111111111"));
  }

  get mode(): X402SettlementMode {
    return this.settler ? "onchain" : "dry-run";
  }

  get tokenConfig(): X402TokenConfig {
    return this.token;
  }

  get settlerPubkey(): PublicKey {
    return this.feePayer;
  }

  get hasSettlerKey(): boolean {
    return Boolean(this.settler);
  }

  depositStealthMeta(ctx: TreasuryKeyContext): SolanaStealthMetaAddress | undefined {
    const key = this.depositKeyForVersion(ctx.keyVersion);
    if (!key) return undefined;
    this.assertDepositContext(ctx);
    const cacheKey = `${ctx.caip2}:${ctx.tokenAddress}:${ctx.keyVersion}`;
    const cached = this.depositMeta.get(cacheKey);
    if (cached) return structuredClone(cached);
    const meta = deriveSolanaTreasuryStealthKeys(key, ctx).meta;
    this.depositMeta.set(cacheKey, structuredClone(meta));
    return meta;
  }

  deriveDepositAddress(ctx: TreasuryKeyContext, index: number) {
    const key = this.depositKeyForVersion(ctx.keyVersion);
    if (!key) throw new Error(`No Solana recovery key for deposit keyVersion ${ctx.keyVersion}`);
    this.assertDepositContext(ctx);
    return deriveSolanaDepositAddress(key, ctx, index);
  }

  /**
   * Reads a Token-2022 confidential account's STRUCTURE, not its value
   * (spec-confidential-x402.md §5).
   *
   * Deliberately separate from `stealthAtaBalance`, and not a refactor of it:
   * every existing ATA helper in this file hardcodes `TOKEN_PROGRAM_ID`, which
   * derives a DIFFERENT address under Token-2022 — reusing one would silently
   * read an account that does not exist and report "empty" for a live slot.
   *
   * Returns whether the confidential extension is present rather than a balance,
   * because a confidential account's plaintext balance is zero by construction
   * and reporting that zero as a balance is what caused B3.
   */
  async confidentialAccountState(input: { owner: string; mint: string }): Promise<{
    exists: boolean;
    confidential: boolean;
    amountAtomic: bigint;
    /**
     * The ElGamal key the PROGRAM stored, which is the one it will enforce
     * against a transfer's `destinationElgamalPubkey`. Reading it back is the
     * only way the server can check a payee-registered `P`: `P = s⁻¹·H` and the
     * server holds only the viewing key, so it can never derive it.
     */
    encryptionPubKey?: string;
  }> {
    const ata = this.confidentialTokenAccount(input);
    const account = await this.connection.getAccountInfo(ata, "confirmed");
    if (!account) return { exists: false, confidential: false, amountAtomic: 0n };
    return {
      exists: true,
      confidential: hasConfidentialTransferExtension(account.data),
      amountAtomic: readTokenAmount(account.data),
      encryptionPubKey: readConfidentialElGamalPubkey(account.data),
    };
  }

  /**
   * The Token-2022 ATA for a confidential slot.
   *
   * `allowOwnerOffCurve` is true because a DKSAP one-time address is a derived
   * point with no guarantee of being on the ed25519 curve in the way a wallet
   * pubkey is, and `TOKEN_2022_PROGRAM_ID` is mandatory — every other ATA helper
   * in this file passes the legacy program and would derive a DIFFERENT address,
   * silently reporting a live slot as absent.
   */
  confidentialTokenAccount(input: { owner: string; mint: string }): PublicKey {
    return getAssociatedTokenAddressSync(
      new PublicKey(input.mint),
      new PublicKey(input.owner),
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async stealthAtaBalance(stealthOwnerBase58: string): Promise<{
    exists: boolean;
    amountAtomic: bigint;
  }> {
    const owner = new PublicKey(stealthOwnerBase58);
    const mint = new PublicKey(this.token.address);
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const account = await this.connection.getAccountInfo(ata, "confirmed");
    if (!account) return { exists: false, amountAtomic: 0n };
    const balance = await this.connection.getTokenAccountBalance(ata, "confirmed");
    return { exists: true, amountAtomic: BigInt(balance.value.amount) };
  }

  async sweepDepositToPool(input: {
    ctx: TreasuryKeyContext;
    derivationIndex: number;
    expectedStealthAddress: string;
    poolOwner: string;
    nowSeconds: number;
    reuseSweepNonce?: string;
  }): Promise<{
    outcome: "confirmed" | "empty" | "submitted-unconfirmed";
    transactionHash?: string;
    observedAmountAtomic: string;
  }> {
    void input.nowSeconds;
    void input.reuseSweepNonce;
    if (!this.settler) throw new Error("Solana deposit sweep settler key is not configured");
    const key = this.depositKeyForVersion(input.ctx.keyVersion);
    if (!key) {
      throw new Error(`No Solana recovery key for deposit keyVersion ${input.ctx.keyVersion}`);
    }
    this.assertDepositContext(input.ctx);
    if (new PublicKey(input.poolOwner).toBase58() !== this.settler.publicKey.toBase58()) {
      throw new Error("Solana deposit sweep pool must equal the configured settler");
    }
    const derivation = deriveSolanaDepositAddress(key, input.ctx, input.derivationIndex);
    if (derivation.stealthAddress !== new PublicKey(input.expectedStealthAddress).toBase58()) {
      throw new Error("Solana deposit sweep derivation does not match the expected stealth address");
    }
    const balance = await this.stealthAtaBalance(derivation.stealthAddress);
    if (!balance.exists || balance.amountAtomic === 0n) {
      return { outcome: "empty", observedAmountAtomic: "0" };
    }
    const built = await sweepStealth({
      connection: this.connection,
      mint: this.token.address,
      destinationOwner: input.poolOwner,
      settlerPubkey: this.settler.publicKey,
      stealthScalar: deriveSolanaDepositScalar(key, input.ctx, input.derivationIndex),
      decimals: this.token.decimals,
      amountAtomic: balance.amountAtomic,
    });
    built.transaction.partialSign(this.settler);
    const raw = built.transaction.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    });
    let signature: string | undefined;
    try {
      signature = await this.send(() =>
        this.connection.sendRawTransaction(raw, { skipPreflight: true }));
      const confirmation = await this.connection.confirmTransaction(signature, "finalized");
      if (confirmation.value.err !== null) {
        throw new Error(`Solana sweep finalized with error: ${JSON.stringify(confirmation.value.err)}`);
      }
      return {
        outcome: "confirmed",
        transactionHash: signature,
        observedAmountAtomic: balance.amountAtomic.toString(),
      };
    } catch (error) {
      if (signature) {
        return {
          outcome: "submitted-unconfirmed",
          transactionHash: signature,
          observedAmountAtomic: balance.amountAtomic.toString(),
        };
      }
      throw error;
    }
  }

  async sweepTxStatus(signature: string): Promise<{
    state: "confirmed-success" | "confirmed-failed" | "pending" | "unknown";
  }> {
    const status = (await this.connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    )).value[0];
    if (!status) return { state: "unknown" };
    if (status.confirmationStatus !== "finalized") return { state: "pending" };
    return status.err === null
      ? { state: "confirmed-success" }
      : { state: "confirmed-failed" };
  }

  async simulatePoolTransfer(input: {
    treasury: string;
    recipient: string;
    amountAtomic: string;
  }): Promise<SolanaX402Simulation> {
    const transaction = await this.buildPoolTransfer(input);
    if (this.settler?.publicKey.toBase58() === input.treasury) transaction.partialSign(this.settler);
    return this.simulateTransaction(transaction);
  }

  async preparePoolTransfer(input: {
    treasury: string;
    recipient: string;
    amountAtomic: string;
  }): Promise<{
    signedTx: string;
    signature: string;
    lastValidBlockHeight: number;
    contextSlot: number;
  }> {
    if (!this.settler) throw new Error("Solana pool payout settler key is not configured");
    const latest = await this.connection.getLatestBlockhashAndContext("finalized");
    const transaction = await this.buildPoolTransfer(input, latest.value.blockhash);
    transaction.partialSign(this.settler);
    const simulation = await this.simulateTransaction(transaction);
    if (!simulation.wouldSettle) {
      throw new Error(`Solana pool payout simulation failed: ${simulation.detail}`);
    }
    const raw = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
    const signature = transaction.signatures[0]?.signature;
    if (!signature) throw new Error("Prepared Solana pool payout has no fee-payer signature");
    return {
      signedTx: raw.toString("base64"),
      signature: encodeBase58(signature),
      lastValidBlockHeight: latest.value.lastValidBlockHeight,
      contextSlot: latest.context.slot,
    };
  }

  async broadcastRawPoolTransfer(signedTx: string): Promise<string> {
    const raw = Buffer.from(signedTx, "base64");
    return this.send(() => this.connection.sendRawTransaction(raw, { skipPreflight: true }));
  }

  async poolTransferStatus(input: {
    signature: string;
    lastValidBlockHeight: number;
  }): Promise<ChainRailPayoutVerdict> {
    const response = await this.connection.getSignatureStatuses(
      [input.signature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (!status) {
      // Absence alone is ambiguous — the transaction may simply not have
      // propagated yet. But a Solana transaction is only valid while its
      // blockhash is: once the FINALIZED head passes `lastValidBlockHeight`, the
      // cluster can never accept it, so absence at that point is proof it did not
      // land, not a lack of information. Without this the leg stayed `uncertain`
      // forever and releasing the payer's funds needed an archival RPC and an
      // operator — for a transfer the chain had already refused to make.
      // Deliberately gated on the finalized head, not `latest`: a not-yet-final
      // head could still be reorged back below the expiry.
      const finalizedHeight = await this.finalizedBlockHeight().catch(() => undefined);
      if (finalizedHeight !== undefined && finalizedHeight > input.lastValidBlockHeight) {
        return { status: "terminal-absent" };
      }
      // Inside the validity window, absence is EXPECTED — this path is polled
      // milliseconds after broadcast, before the signature has propagated. Solana
      // needs no grace clock: the blockhash validity IS the liveness bound, and
      // once the finalized head passes it the same inputs become terminal-absent
      // above. Reporting `uncertain` here was the H7 flap on this rail: every
      // status poll that outran propagation wrote the journal `uncertain` and
      // promoted a healthy group into operator disposition. `pending` still never
      // reverses the payout — that stays gated on the expired blockhash.
      return { status: "pending" };
    }
    if (status.confirmationStatus !== "finalized") {
      // The cluster has seen it. `processed`/`confirmed` with no error means it is in
      // a block and simply not rooted yet (~13s). This path is polled milliseconds
      // after broadcast, so treating "not yet finalized" as ambiguity marked EVERY
      // healthy Solana payout `uncertain` — unrecoverable without an archival RPC and
      // an operator. An error at this depth is still not terminal: a fork could drop
      // the containing block, and only a finalized failure justifies reversing a payout.
      return status.err === null
        ? { status: "included", transactionHash: input.signature }
        : { status: "uncertain", detail: "Solana signature failed but is not yet finalized" };
    }
    return status.err === null
      // §2.9 H11 — the landing slot is the Solana landing coordinate. It comes
      // from the same finalized SignatureStatus that proved the landing, so it
      // is exactly as trustworthy as the verdict itself.
      ? { status: "landed", transactionHash: input.signature, blockNumber: status.slot }
      : { status: "terminal-absent" };
  }

  async operatorPoolTransferStatus(input: {
    signature: string;
    lastValidBlockHeight: number;
  }): Promise<ChainRailPayoutVerdict> {
    if (!this.historyConnection) {
      throw new Error("PX402_SOLANA_HISTORY_RPC_URL is required for landed disposition");
    }
    const response = await this.historyConnection.getSignatureStatuses(
      [input.signature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (!status || status.confirmationStatus !== "finalized" || status.err !== null) {
      throw new Error("Solana disposition signature is not finalized-canonical on the archival RPC");
    }
    return { status: "landed", transactionHash: input.signature, blockNumber: status.slot };
  }

  finalizedBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight("finalized");
  }

  async verifyAndSettle(
    payload: SolanaX402PaymentPayload,
    requirements: SolanaX402PaymentRequirements,
    nowSeconds: number
  ): Promise<X402Settlement> {
    const result = verifySolanaPayment({
      payload,
      requirements,
      settlerPubkey: this.feePayer,
      token: this.token,
      nowSeconds
    });
    this.evictExpiredPayments();
    const replayKey = `${result.payer}:${requirements.nonce}`;
    if (this.consumedPayments.has(replayKey)) throw new Error("Solana x402 payment already used");
    this.consumedPayments.set(replayKey, Date.now() + SolanaX402Facilitator.PAYMENT_TTL_MS);

    const base: X402Settlement = {
      settlement: this.mode,
      network: "solana",
      asset: this.token.address,
      from: result.payer,
      to: result.payTo,
      value: result.value,
      authorizationNonce: requirements.nonce
    };

    try {
      if (this.settler) result.transaction.partialSign(this.settler);
      const simulation = await this.simulateTransaction(result.transaction);
      if (this.mode === "dry-run") {
        return {
          ...base,
          reason: simulation.wouldSettle
            ? "no Solana settler key configured — verified and simulated only"
            : `no Solana settler key configured — verified; simulation did not settle (${simulation.detail})`
        };
      }
      if (!simulation.wouldSettle) throw new Error(`Solana x402 settle simulation failed: ${simulation.detail}`);
      const raw = result.transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
      const transactionHash = await this.send(() =>
        this.connection.sendRawTransaction(raw, { skipPreflight: true }));
      try {
        await this.connection.confirmTransaction(transactionHash, "confirmed");
      } catch (error) {
        // `confirmTransaction` gives up on blockhash expiry or its own timeout, and
        // neither means the transaction failed — it routinely lands anyway. Ask the
        // cluster what actually happened before calling this a failure: the payer's
        // transaction is single-use, so a false failure makes them sign a second one
        // and pay twice.
        const observed = (await this.connection.getSignatureStatuses(
          [transactionHash],
          { searchTransactionHistory: true },
        )).value[0];
        if (!observed || observed.err !== null) throw error;
        return {
          ...base,
          transactionHash,
          standing: observed.confirmationStatus === "finalized" ? "final" : "included",
        };
      }
      // Deliberately NOT "final": this path waits for `confirmed`, which is one
      // vote-depth short of rooted. Claiming finality here would be the same
      // overclaim the `standing` field exists to prevent.
      return { ...base, transactionHash, standing: "included" };
    } catch (error) {
      this.consumedPayments.delete(replayKey);
      throw new Error(`Solana x402 settle failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  async simulateSettle(payload: SolanaX402PaymentPayload): Promise<SolanaX402Simulation> {
    let transaction: Transaction;
    try {
      transaction = Transaction.from(Buffer.from(payload.transaction, "base64"));
    } catch {
      throw new Error("Malformed Solana x402 transaction");
    }
    if (this.settler) transaction.partialSign(this.settler);
    return this.simulateTransaction(transaction);
  }

  private async simulateTransaction(transaction: Transaction): Promise<SolanaX402Simulation> {
    const simulation = await this.connection.simulateTransaction(transaction);
    const error = simulation.value.err;
    return {
      wouldSettle: error === null,
      detail: error === null ? "transaction would succeed" : JSON.stringify(error),
      logs: simulation.value.logs ?? undefined
    };
  }

  private async buildPoolTransfer(input: {
    treasury: string;
    recipient: string;
    amountAtomic: string;
  }, recentBlockhash?: string): Promise<Transaction> {
    const amount = BigInt(input.amountAtomic);
    if (amount <= 0n) throw new Error("Pool payout amount must be positive");
    const mint = new PublicKey(this.token.address);
    const treasury = new PublicKey(input.treasury);
    const recipient = new PublicKey(input.recipient);
    const sourceAta = getAssociatedTokenAddressSync(
      mint,
      treasury,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const destinationAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const transaction = new Transaction({
      feePayer: treasury,
      recentBlockhash: recentBlockhash ?? (await this.connection.getLatestBlockhash()).blockhash
    });
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        treasury,
        destinationAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        treasury,
        amount,
        this.token.decimals,
        [],
        TOKEN_PROGRAM_ID
      )
    );
    return transaction;
  }

  private evictExpiredPayments() {
    const now = Date.now();
    for (const [key, expiresAt] of this.consumedPayments) {
      if (expiresAt <= now) this.consumedPayments.delete(key);
    }
  }

  private send<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.sendCoordinator?.send(operation) ?? operation();
  }

  private assertDepositContext(ctx: TreasuryKeyContext) {
    if (ctx.caip2 !== this.token.caip2 || ctx.tokenAddress !== this.token.address) {
      throw new Error("Solana deposit sweep context does not match the facilitator token");
    }
  }

  private depositKeyForVersion(keyVersion: string): string | undefined {
    const candidates = [
      this.options.settlerSecretKey,
      ...(this.options.recoverySettlerSecretKeys ?? []),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((candidate) => {
      const keypair = Keypair.fromSecretKey(decodeBase58(candidate));
      return solanaKeyVersion(keypair.publicKey.toBase58()) === keyVersion;
    });
  }
}

/** SPL token account layout: `amount` is a u64 LE at offset 64. */
const TOKEN_AMOUNT_OFFSET = 64;
/** Base account size; extensions begin after this plus the account-type byte. */
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_ACCOUNT_TYPE_SIZE = 1;
/** `ExtensionType.ConfidentialTransferAccount`, confirmed against the package. */
const CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION = 5;

const readTokenAmount = (data: Uint8Array): bigint => {
  if (data.length < TOKEN_AMOUNT_OFFSET + 8) return 0n;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(TOKEN_AMOUNT_OFFSET, true);
};

/**
 * Walks the Token-2022 extension TLV for `ConfidentialTransferAccount` and
 * returns its payload.
 *
 * Hand-rolled rather than routed through the package decoder because this runs
 * on the failure-analysis path: a decoder that throws on an unfamiliar extension
 * would turn "I could not parse this" into "there is no confidential balance
 * here", and that particular mistranslation loses funds. An unparseable tail
 * ends the scan and reports what was positively found — never more.
 */
const readConfidentialExtensionData = (data: Uint8Array): Uint8Array | undefined => {
  let offset = TOKEN_ACCOUNT_SIZE + TOKEN_ACCOUNT_TYPE_SIZE;
  if (data.length <= offset) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const body = offset + 4;
    if (type === CONFIDENTIAL_TRANSFER_ACCOUNT_EXTENSION) {
      return body + length <= data.length ? data.subarray(body, body + length) : undefined;
    }
    const next = body + length;
    if (next <= offset || next > data.length) break; // malformed tail: stop, do not guess
    offset = next;
  }
  return undefined;
};

const hasConfidentialTransferExtension = (data: Uint8Array): boolean =>
  readConfidentialExtensionData(data) !== undefined;

/**
 * `ConfidentialTransferAccount` begins `approved: bool` then
 * `elgamal_pubkey: [u8; 32]`, so the key the program will enforce against a
 * transfer's `destinationElgamalPubkey` starts at offset 1.
 */
const CONFIDENTIAL_ELGAMAL_OFFSET = 1;
const ELGAMAL_PUBKEY_BYTES = 32;

const readConfidentialElGamalPubkey = (data: Uint8Array): string | undefined => {
  const extension = readConfidentialExtensionData(data);
  if (!extension || extension.length < CONFIDENTIAL_ELGAMAL_OFFSET + ELGAMAL_PUBKEY_BYTES) {
    return undefined;
  }
  return encodeBase58(extension.subarray(
    CONFIDENTIAL_ELGAMAL_OFFSET,
    CONFIDENTIAL_ELGAMAL_OFFSET + ELGAMAL_PUBKEY_BYTES,
  ));
};

const decodeBase58 = (value: string): Uint8Array => {
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
  return bytes;
};

export const solanaSignatureFromSignedTransaction = (signedTx: string): string => {
  const transaction = Transaction.from(Buffer.from(signedTx, "base64"));
  const signature = transaction.signatures[0]?.signature;
  if (!signature) throw new Error("Persisted Solana transaction has no fee-payer signature");
  return encodeBase58(signature);
};

const encodeBase58 = (bytes: Uint8Array): string => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const byte of bytes) numeric = numeric * 256n + BigInt(byte);
  let encoded = "";
  while (numeric > 0n) {
    const remainder = Number(numeric % 58n);
    numeric /= 58n;
    encoded = alphabet[remainder] + encoded;
  }
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  return "1".repeat(leadingZeros) + encoded;
};
