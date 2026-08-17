import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  Signature,
  Transaction,
  Wallet,
  getAddress,
  id as keccakId,
} from "ethers";
import {
  buildPaymentRequirements,
  createPaymentPayload,
  randomNonce,
  verifyPayment,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402TokenConfig,
  BASE_USDC
} from "../../shared/x402";
import {
  deriveEvmDepositAddress,
  deriveEvmDepositPrivateKey,
  deriveEvmTreasuryStealthKeys,
  evmKeyVersion,
  type TreasuryKeyContext,
} from "../../shared/depositStealth";
import type { StealthMetaAddress } from "../../shared/stealth";
import {
  coordinatorLogicalId,
  evmPayloadFingerprint,
  SettlerNotYetFinalError,
  type TransactionCoordinator,
} from "./TransactionCoordinator";
import type { ChainRailPayoutVerdict } from "../rails/ChainRail";

// USDC / EIP-3009 transferWithAuthorization (v,r,s form — Circle USDC on Base).
const TRANSFER_WITH_AUTHORIZATION_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"
];
const ERC20_TRANSFER_ABI = [
  "function transfer(address to,uint256 value) returns (bool)"
];
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)"
];
const COMMIT_BATCH_ABI = [
  "function commitBatch(bytes32 merkleRoot,address asset,uint256 transferCount)"
];

export type X402SettlementMode = "dry-run" | "onchain";

export interface X402Settlement {
  settlement: X402SettlementMode;
  network: string;
  asset: string;
  from: string;
  to: string;
  value: string;
  authorizationNonce: string;
  // present only when settlement === "onchain"
  transactionHash?: string;
  /**
   * How far the broadcast got, present only when settlement === "onchain".
   *
   * `included` means the transaction is mined and canonical but the finality tag
   * does not cover it yet — the ordinary state of every EVM transaction for its
   * first ~20 minutes, and far longer than the confirmation budget. It is a
   * SUCCESS: the tokens have moved. It is reported distinctly because the caller
   * may want to wait for `final` before treating the transfer as irreversible.
   *
   * It must never be reported as a failure. An EIP-3009 authorization is
   * single-use on-chain, so a payer told "failed" cannot retry — the token's
   * authorizationState rejects that nonce — and can only pay again by signing a
   * second authorization, moving the money twice.
   *
   * `submitted` is weaker than both: the RPC accepted the broadcast and nothing
   * has been observed since. Only the coordinator-less operator-script path
   * reports it, because `sendTransaction` resolves on acceptance, not on a
   * receipt.
   */
  standing?: "final" | "included" | "submitted";
  // present only when settlement === "dry-run" — why it did not broadcast
  reason?: string;
}

export interface X402FacilitatorOptions {
  rpcUrl: string;
  settlerPrivateKey?: string; // funds gas to broadcast; absent => dry-run
  token?: X402TokenConfig;
  coordinator?: TransactionCoordinator;
  recoverySettlerPrivateKeys?: readonly string[];
}

/**
 * Verifies x402 payments (pure crypto, no RPC) and settles them. Settlement is
 * gated: with a funded settler key it broadcasts the EIP-3009
 * transferWithAuthorization on Base; without one it returns a clearly-labelled
 * dry-run receipt (verification still ran for real). This mirrors the existing
 * Base "not-configured" pattern — the dry-run path is honest, not a stub of the
 * verification itself.
 */
export class X402Facilitator {
  private readonly token: X402TokenConfig;
  private readonly consumedNonces = new Map<string, number>();
  private readonly depositMeta = new Map<string, StealthMetaAddress>();
  private static readonly NONCE_TTL_MS = 60 * 60 * 1000;

  constructor(private readonly options: X402FacilitatorOptions) {
    this.token = options.token ?? BASE_USDC;
  }

  get mode(): X402SettlementMode {
    return this.options.settlerPrivateKey ? "onchain" : "dry-run";
  }

  get tokenConfig(): X402TokenConfig {
    return this.token;
  }

  get hasSettlerKey(): boolean {
    return Boolean(this.options.settlerPrivateKey);
  }

  get settlerAddress(): string | undefined {
    return this.options.settlerPrivateKey
      ? new Wallet(this.options.settlerPrivateKey).address
      : undefined;
  }

  get hasCoordinator(): boolean {
    return Boolean(this.options.coordinator);
  }

  depositStealthMeta(ctx: TreasuryKeyContext): StealthMetaAddress | undefined {
    const key = this.depositKeyForVersion(ctx.keyVersion);
    if (!key) return undefined;
    this.assertDepositContext(ctx);
    const cacheKey = `${ctx.caip2}:${ctx.tokenAddress.toLowerCase()}:${ctx.keyVersion}`;
    const cached = this.depositMeta.get(cacheKey);
    if (cached) return structuredClone(cached);
    const meta = deriveEvmTreasuryStealthKeys(key, ctx).meta;
    this.depositMeta.set(cacheKey, structuredClone(meta));
    return meta;
  }

  deriveDepositAddress(ctx: TreasuryKeyContext, index: number) {
    const key = this.depositKeyForVersion(ctx.keyVersion);
    if (!key) throw new Error(`No EVM recovery key for deposit keyVersion ${ctx.keyVersion}`);
    this.assertDepositContext(ctx);
    return deriveEvmDepositAddress(key, ctx, index);
  }

  async tokenBalanceOf(address: string): Promise<bigint> {
    const iface = new Interface(ERC20_BALANCE_ABI);
    const call = await this.ethCall({
      to: this.token.address,
      data: iface.encodeFunctionData("balanceOf", [getAddress(address)]),
    });
    if (!call.ok || !call.result) {
      throw new Error(`Token balance query failed: ${call.reason ?? "empty RPC result"}`);
    }
    return BigInt(iface.decodeFunctionResult("balanceOf", call.result)[0]);
  }

  async sweepDepositToPool(input: {
    ctx: TreasuryKeyContext;
    derivationIndex: number;
    expectedStealthAddress: string;
    poolAddress: string;
    amountAtomic: string;
    nowSeconds: number;
    confirmations: number;
    reuseSweepNonce?: string;
  }): Promise<{
    outcome: "confirmed" | "empty" | "submitted-unconfirmed";
    transactionHash?: string;
    sweepNonce?: string;
    observedAmountAtomic: string;
  }> {
    if (!this.options.coordinator) {
      throw new Error("Deposit sweep requires the shared transaction coordinator");
    }
    const settlerKey = this.depositKeyForVersion(input.ctx.keyVersion);
    if (!settlerKey) {
      throw new Error(`No EVM recovery key for deposit keyVersion ${input.ctx.keyVersion}`);
    }
    this.assertDepositContext(input.ctx);
    const currentSettler = this.settlerAddress;
    if (!currentSettler || getAddress(input.poolAddress) !== getAddress(currentSettler)) {
      throw new Error("Deposit sweep pool must equal the configured settler");
    }
    const derived = deriveEvmDepositAddress(settlerKey, input.ctx, input.derivationIndex);
    if (getAddress(derived.stealthAddress) !== getAddress(input.expectedStealthAddress)) {
      throw new Error("Deposit sweep derivation does not match the expected stealth address");
    }
    const privateKey = deriveEvmDepositPrivateKey(settlerKey, input.ctx, input.derivationIndex);
    const observed = await this.tokenBalanceOf(derived.stealthAddress);
    if (observed === 0n) {
      return { outcome: "empty", observedAmountAtomic: "0", sweepNonce: input.reuseSweepNonce };
    }
    if (BigInt(input.amountAtomic) !== observed) {
      // Always sweep the live full balance; the returned amount lets the saga
      // quarantine an overpayment without leaving the surplus behind.
      input = { ...input, amountAtomic: observed.toString() };
    }
    if (!Number.isInteger(input.confirmations) || input.confirmations < 1) {
      throw new Error("Deposit sweep confirmations must be an integer >= 1");
    }
    const requirements = buildPaymentRequirements({
      payTo: input.poolAddress,
      maxAmountRequired: input.amountAtomic,
      resource: `deposit-sweep:${this.token.network}:${input.derivationIndex}`,
      validForSeconds: 3600,
      token: this.token,
      nowSeconds: input.nowSeconds,
    });
    requirements.nonce = input.reuseSweepNonce ?? randomNonce();
    const payment = await createPaymentPayload({
      payerPrivateKey: privateKey,
      requirements,
      token: this.token,
      nowSeconds: input.nowSeconds,
    });
    const simulation = await this.simulateSettle(payment);
    if (!simulation.wouldSettle) {
      throw new Error(`Deposit sweep simulation failed: ${simulation.detail}`);
    }
    const data = encodeTransferWithAuthorization(payment);
    const payloadFingerprint = evmPayloadFingerprint({
      to: this.token.address,
      data,
      value: 0n,
      chainId: this.token.chainId as number,
    });
    const logicalId = coordinatorLogicalId({
      kind: "deposit-sweep",
      ref: requirements.nonce,
      payloadFingerprint,
    });
    try {
      const result = await this.options.coordinator.submit({
        kind: "deposit-sweep",
        ref: requirements.nonce,
        logicalId,
        payloadFingerprint,
        sign: async (fees) => {
          const built = await this.buildTransferWithAuthorization({ payload: payment, ...fees });
          return { signedTx: built.signedTx, txHash: built.txHash };
        },
      });
      return {
        outcome: "confirmed",
        transactionHash: result.txHash,
        sweepNonce: requirements.nonce,
        observedAmountAtomic: observed.toString(),
      };
    } catch (error) {
      const entry = this.options.coordinator.outboxEntryFor(logicalId);
      const transactionHash = entry?.versions[entry.versions.length - 1]?.txHash;
      if (transactionHash) {
        return {
          outcome: "submitted-unconfirmed",
          transactionHash,
          sweepNonce: requirements.nonce,
          observedAmountAtomic: observed.toString(),
        };
      }
      throw error;
    }
  }

  /**
   * Broadcast an EIP-3009 authorization that the DEPOSITOR signed, with the
   * settler paying gas.
   *
   * This is what lets a stealth output be swept without ever funding it with
   * native gas. Funding it would publish a `pool -> stealthAddr` edge and
   * destroy exactly the recipient unlinkability the one-time address exists to
   * provide — which is what `scripts/x402-stealth-sweep.mjs` does, and why that
   * script is not a receiver path.
   *
   * Deliberately NOT a general-purpose relay. Every binding is taken from a
   * durable deposit record by the caller and asserted here before anything is
   * signed or broadcast, so the settler's gas cannot be spent moving value it
   * was not asked to move.
   */
  async relaySignedDeposit(input: {
    payload: X402PaymentPayload;
    expectedFrom: string;
    expectedTo: string;
    expectedValueAtomic: string;
    ref: string;
    nowSeconds: number;
  }): Promise<{
    mode: X402SettlementMode;
    transactionHash?: string;
    /** See `X402Settlement.standing` — same three states, same reasoning. */
    standing?: "final" | "included" | "submitted";
    reason?: string;
    from: string;
    value: string;
  }> {
    const auth = input.payload.authorization;
    // Bindings first. verifyPayment checks signer == auth.from but never that
    // auth.from is the address we expect, so the sender assertion has to be
    // made here or the settler would relay a transfer from anyone.
    if (getAddress(auth.from) !== getAddress(input.expectedFrom)) {
      throw new Error("Deposit relay sender does not match the deposit intent");
    }
    if (getAddress(auth.to) !== getAddress(input.expectedTo)) {
      throw new Error("Deposit relay recipient does not match the deposit intent");
    }
    // Exact, not >=: the credited amount is bound to the intent, so an
    // authorization for more than the intent would move value the ledger will
    // not credit.
    if (BigInt(auth.value) !== BigInt(input.expectedValueAtomic)) {
      throw new Error("Deposit relay value does not match the deposit intent");
    }

    const requirements: X402PaymentRequirements = {
      scheme: "exact",
      network: this.token.network,
      asset: getAddress(this.token.address),
      payTo: getAddress(input.expectedTo),
      maxAmountRequired: input.expectedValueAtomic,
      resource: `deposit-relay:${input.ref}`,
      // the depositor chose the nonce when they signed; verifyPayment only
      // requires requirements.nonce to match, and replay is guarded below and
      // by the token's own authorizationState on-chain
      nonce: auth.nonce,
      // unused by verifyPayment, which reads the authorization's own window
      validForSeconds: 0,
    };
    const verified = verifyPayment({
      payload: input.payload,
      requirements,
      token: this.token,
      nowSeconds: input.nowSeconds,
    });

    this.evictExpiredNonces();
    const key = `${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
    if (this.consumedNonces.has(key)) throw new Error("x402 authorization nonce already used");
    this.consumedNonces.set(key, Date.now() + X402Facilitator.NONCE_TTL_MS);

    if (this.mode === "dry-run") {
      return {
        mode: "dry-run",
        reason: "no settler key configured — verified off-chain only",
        from: verified.signer,
        value: verified.value,
      };
    }

    try {
      // Before any network I/O: the outbox is not optional for a settler-EOA
      // send. Bypassing it corrupts the shared nonce pipeline and breaks
      // pool-payout recovery, so a missing coordinator is a hard configuration
      // error, not something to discover after a simulate round-trip.
      if (!this.options.coordinator) {
        throw new Error("Deposit relay requires the shared transaction coordinator");
      }
      const simulation = await this.simulateSettle(input.payload);
      if (!simulation.wouldSettle) {
        this.consumedNonces.delete(key);
        throw new Error(`deposit relay would revert: ${simulation.detail}`);
      }
      const data = encodeTransferWithAuthorization(input.payload);
      const payloadFingerprint = evmPayloadFingerprint({
        to: this.token.address,
        data,
        value: 0n,
        chainId: this.token.chainId as number,
      });
      const logicalId = coordinatorLogicalId({
        kind: "deposit-relay",
        ref: input.ref,
        payloadFingerprint,
      });
      const result = await this.options.coordinator.submit({
        kind: "deposit-relay",
        ref: input.ref,
        logicalId,
        payloadFingerprint,
        sign: async (fees) => {
          const built = await this.buildTransferWithAuthorization({ payload: input.payload, ...fees });
          if (built.payloadFingerprint !== payloadFingerprint) {
            throw new Error("Deposit relay builder changed its payload fingerprint");
          }
          return { signedTx: built.signedTx, txHash: built.txHash };
        },
      });
      return {
        mode: "onchain",
        transactionHash: result.txHash,
        standing: "final",
        from: verified.signer,
        value: verified.value,
      };
    } catch (error) {
      // Same rule as `verifyAndSettle`: the sweep is mined and canonical, so this
      // is a success that outran the budget. Failing it here would release the
      // one-shot deposit slot and the payee's inbox reservation for an output the
      // chain has already moved, and the depositor's authorization is spent, so
      // the retry that release invites cannot succeed.
      if (error instanceof SettlerNotYetFinalError) {
        return {
          mode: "onchain",
          transactionHash: error.transactionHash,
          standing: "included",
          from: verified.signer,
          value: verified.value,
        };
      }
      this.consumedNonces.delete(key);
      throw new Error(`deposit relay failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  async sweepTxStatus(transactionHash: string): Promise<{
    state: "confirmed-success" | "confirmed-failed" | "pending" | "unknown";
  }> {
    if (this.options.coordinator) {
      const classified = await this.options.coordinator.classifyTransactionHash(transactionHash);
      if (classified.verdict === "landed") return { state: "confirmed-success" };
      if (classified.verdict === "terminal-absent") return { state: "confirmed-failed" };
    }
    const provider = new JsonRpcProvider(this.options.rpcUrl, this.token.chainId);
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (receipt) return { state: "pending" };
    const transaction = await provider.getTransaction(transactionHash);
    return transaction ? { state: "pending" } : { state: "unknown" };
  }

  async simulatePoolTransfer(input: {
    poolAddress: string;
    recipient: string;
    amountAtomic: string;
  }): Promise<X402Simulation> {
    const iface = new Interface(ERC20_TRANSFER_ABI);
    const call = await this.ethCall({
      from: input.poolAddress,
      to: this.token.address,
      data: iface.encodeFunctionData("transfer", [input.recipient, input.amountAtomic])
    });
    return call.ok
      ? { wouldSettle: true, signatureAccepted: true, detail: "pool transfer would succeed" }
      : {
          wouldSettle: false,
          signatureAccepted: true,
          detail: call.reason ? `pool transfer reverted: ${call.reason}` : "pool transfer reverted"
        };
  }

  async buildPoolTransfer(input: {
    recipient: string;
    amountAtomic: string;
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }) {
    const iface = new Interface(ERC20_TRANSFER_ABI);
    const data = iface.encodeFunctionData("transfer", [input.recipient, input.amountAtomic]);
    return this.signPinnedTransaction({
      to: this.token.address,
      data,
      nonce: input.nonce,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      gasLimit: 120_000n,
    });
  }

  async buildTransferWithAuthorization(input: {
    payload: X402PaymentPayload;
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }) {
    const data = encodeTransferWithAuthorization(input.payload);
    return this.signPinnedTransaction({
      to: this.token.address,
      data,
      nonce: input.nonce,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      gasLimit: 250_000n,
    });
  }

  async buildCommitBatch(input: {
    contractAddress: string;
    merkleRoot: string;
    asset: string;
    transferCount: number;
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }) {
    const data = new Interface(COMMIT_BATCH_ABI).encodeFunctionData("commitBatch", [
      input.merkleRoot,
      input.asset,
      input.transferCount,
    ]);
    return this.signPinnedTransaction({
      to: input.contractAddress,
      data,
      nonce: input.nonce,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      gasLimit: 250_000n,
    });
  }

  async broadcastRawTransaction(signedTx: string): Promise<string> {
    const provider = new JsonRpcProvider(this.options.rpcUrl, this.token.chainId);
    try {
      return (await provider.broadcastTransaction(signedTx)).hash;
    } catch (error) {
      if (!/already known|known transaction/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      const hash = Transaction.from(signedTx).hash;
      if (!hash) throw new Error("Signed transaction has no hash");
      return hash;
    }
  }

  async poolTransferStatus(input: {
    logicalId: string;
    nonce: number;
  }): Promise<ChainRailPayoutVerdict> {
    if (!this.options.coordinator) {
      return { status: "uncertain", detail: "transaction coordinator is not configured" };
    }
    const result = await this.options.coordinator.classifyNonce(input);
    if (result.verdict === "landed") {
      return { status: "landed", transactionHash: result.transactionHash as string };
    }
    // `included` used to collapse into `uncertain` here — the exact conflation the
    // verdict type exists to prevent. Same for the young-entry `pending` state.
    if (result.verdict === "included") {
      return { status: "included", transactionHash: result.transactionHash as string };
    }
    if (result.verdict === "pending") {
      return { status: "pending" };
    }
    return result.verdict === "terminal-absent"
      ? { status: "terminal-absent" }
      : { status: "uncertain", detail: "EVM nonce outcome is not finalized-authoritative" };
  }

  /** Verify the payment satisfies the challenge, then settle (gated). */
  async verifyAndSettle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
    nowSeconds: number
  ): Promise<X402Settlement> {
    const result = verifyPayment({ payload, requirements, token: this.token, nowSeconds });

    // Replay guard keyed on (from, authorization nonce). On-chain the token's
    // authorizationState enforces this too, but we reject duplicates up front so
    // a dry-run can't be double-claimed within a session either.
    this.evictExpiredNonces();
    const key = `${payload.authorization.from.toLowerCase()}:${payload.authorization.nonce.toLowerCase()}`;
    if (this.consumedNonces.has(key)) throw new Error("x402 authorization nonce already used");
    this.consumedNonces.set(key, Date.now() + X402Facilitator.NONCE_TTL_MS);

    const auth = payload.authorization;
    const base: X402Settlement = {
      settlement: this.mode,
      network: this.token.network,
      asset: this.token.address,
      from: result.signer,
      to: auth.to,
      value: result.value,
      authorizationNonce: auth.nonce
    };

    if (this.mode === "dry-run") {
      return { ...base, reason: "no settler key configured — verified off-chain only" };
    }

    try {
      // Pre-flight against the live contract so we never spend gas on a settle
      // that would revert (bad signature, consumed nonce, or unfunded payer).
      const sim = await this.simulateSettle(payload);
      if (!sim.wouldSettle) {
        this.consumedNonces.delete(key);
        throw new Error(`x402 settle would revert: ${sim.detail}`);
      }
      if (this.options.coordinator) {
        const data = encodeTransferWithAuthorization(payload);
        const payloadFingerprint = evmPayloadFingerprint({
          to: this.token.address,
          data,
          value: 0n,
          chainId: this.token.chainId as number,
        });
        const logicalId = coordinatorLogicalId({
          kind: "x402-settle",
          ref: auth.nonce,
          payloadFingerprint,
        });
        const result = await this.options.coordinator.submit({
          kind: "x402-settle",
          ref: auth.nonce,
          logicalId,
          payloadFingerprint,
          sign: async (fees) => {
            const built = await this.buildTransferWithAuthorization({ payload, ...fees });
            return { signedTx: built.signedTx, txHash: built.txHash };
          },
        });
        return { ...base, transactionHash: result.txHash, standing: "final" };
      }
      // Standalone operator scripts intentionally do not share the server's
      // process-local coordinator. Their exclusion banner requires the server
      // to be stopped before this compatibility path is used.
      const provider = new JsonRpcProvider(this.options.rpcUrl, this.token.chainId);
      const wallet = new Wallet(this.options.settlerPrivateKey as string, provider);
      const transaction = await wallet.sendTransaction({
        to: this.token.address,
        data: encodeTransferWithAuthorization(payload),
      });
      return { ...base, transactionHash: transaction.hash, standing: "submitted" };
    } catch (error) {
      // Inclusion is a SUCCESS that merely outran the confirmation budget: the
      // transfer is mined and canonical. Reporting it as a failure would be a
      // double-spend generator, because the authorization it consumed is spent
      // on-chain and the payer's only route to "retry" is signing another one.
      // The replay guard deliberately stays consumed here for the same reason.
      if (error instanceof SettlerNotYetFinalError) {
        return { ...base, transactionHash: error.transactionHash, standing: "included" };
      }
      // roll back the nonce so a transient broadcast failure can be retried
      this.consumedNonces.delete(key);
      throw new Error(`x402 on-chain settle failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  /**
   * Simulate the settle against the REAL deployed token via eth_call — no gas,
   * no funded keys, no broadcast. The token contract runs its EIP-712 recovery,
   * validity-window, and nonce checks; only the final balance debit can't pass
   * for a zero-balance payer. So:
   *   - success            -> would transfer (payer is funded)
   *   - reverts on balance  -> signature + domain ACCEPTED by the live contract
   *   - reverts on signature-> our EIP-712 domain/encoding is wrong
   * This is how we prove the on-chain path is correct without spending anything.
   */
  async simulateSettle(payload: X402PaymentPayload): Promise<X402Simulation> {
    const auth = payload.authorization;
    const sig = Signature.from(payload.signature);
    const iface = new Interface(TRANSFER_WITH_AUTHORIZATION_ABI);
    const data = iface.encodeFunctionData("transferWithAuthorization", [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      sig.v,
      sig.r,
      sig.s
    ]);

    const call = await this.ethCall({ to: this.token.address, data });
    if (call.ok) {
      return { wouldSettle: true, signatureAccepted: true, detail: "transfer would succeed (payer funded)" };
    }
    const reason = (call.reason ?? "").toLowerCase();
    if (/balance|insufficient|exceeds/.test(reason)) {
      return { wouldSettle: false, signatureAccepted: true, detail: `signature accepted; payer underfunded (${call.reason})` };
    }
    if (/invalid signature|ecrecover|recover|authorization|caller must|signer/.test(reason)) {
      return { wouldSettle: false, signatureAccepted: false, detail: `contract rejected authorization (${call.reason})` };
    }
    return { wouldSettle: false, signatureAccepted: false, detail: call.reason ? `reverted: ${call.reason}` : "reverted (no decoded reason)" };
  }

  private async ethCall(tx: { from?: string; to: string; data: string }): Promise<{ ok: boolean; result?: string; reason?: string }> {
    const response = await fetch(this.options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `from` must be forwarded: a plain ERC-20 pool transfer reverts on msg.sender's
      // balance, so simulating without it runs as the zero address and always fails.
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: tx.from, to: tx.to, data: tx.data }, "latest"] })
    });
    if (!response.ok) throw new Error(`Base RPC ${response.status}`);
    const payload = (await response.json()) as { result?: string; error?: { message?: string; data?: string | { data?: string } } };
    if (!payload.error) return { ok: true, result: payload.result };
    // try to decode an Error(string) revert from either error.data or the message
    const rawData =
      typeof payload.error.data === "string" ? payload.error.data : payload.error.data?.data;
    const decoded = decodeRevertString(rawData) ?? payload.error.message ?? "execution reverted";
    return { ok: false, reason: decoded };
  }

  private evictExpiredNonces() {
    const now = Date.now();
    for (const [key, expiresAt] of this.consumedNonces) {
      if (expiresAt <= now) this.consumedNonces.delete(key);
    }
  }

  private assertDepositContext(ctx: TreasuryKeyContext) {
    if (ctx.caip2 !== this.token.caip2
      || ctx.tokenAddress.toLowerCase() !== this.token.address.toLowerCase()) {
      throw new Error("Deposit sweep context does not match the facilitator token");
    }
  }

  private depositKeyForVersion(keyVersion: string): string | undefined {
    const candidates = [
      this.options.settlerPrivateKey,
      ...(this.options.recoverySettlerPrivateKeys ?? []),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((candidate) =>
      evmKeyVersion(new Wallet(candidate).address) === keyVersion);
  }

  private async signPinnedTransaction(input: {
    to: string;
    data: string;
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gasLimit: bigint;
  }) {
    if (!this.options.settlerPrivateKey) throw new Error("EVM settler key is not configured");
    const wallet = new Wallet(this.options.settlerPrivateKey);
    const signedTx = await wallet.signTransaction({
      type: 2,
      chainId: this.token.chainId,
      nonce: input.nonce,
      to: input.to,
      data: input.data,
      value: 0n,
      gasLimit: input.gasLimit,
      maxFeePerGas: BigInt(input.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(input.maxPriorityFeePerGas),
    });
    const txHash = Transaction.from(signedTx).hash;
    if (!txHash) throw new Error("Signed EVM transaction has no hash");
    return {
      signedTx,
      txHash,
      payloadFingerprint: evmPayloadFingerprint({
        to: input.to,
        data: input.data,
        value: 0n,
        chainId: this.token.chainId as number,
      }),
    };
  }
}

export interface X402Simulation {
  wouldSettle: boolean; // true only if the payer is actually funded
  signatureAccepted: boolean; // the live contract accepted our EIP-712 signature
  detail: string;
}

// Known 4-byte custom-error selectors mapped to classifiable reason strings.
// Circle USDC reverts with Error(string); Paxos USDG (Robinhood Chain) uses
// custom errors, so the balance-vs-signature classification needs this table.
// e.g. InsufficientFunds() = 0x356680b7 — proven live: a fresh valid signature
// eth_calls to exactly this selector on RH USDG (signature checks all passed).
const CUSTOM_ERROR_REASONS: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      ["InsufficientFunds()", "insufficient funds"],
      ["InsufficientBalance()", "insufficient balance"],
      ["ERC20InsufficientBalance(address,uint256,uint256)", "insufficient balance"],
      ["InvalidSignature()", "invalid signature"],
      ["ECDSAInvalidSignature()", "invalid signature"],
      ["AuthorizationUsed()", "authorization nonce already used"],
      ["AuthorizationExpired()", "authorization expired"],
      ["AuthorizationNotYetValid()", "authorization not yet valid"],
      ["AccountFrozen()", "account frozen"],
      ["EnforcedPause()", "token paused"]
    ] as const
  ).map(([signature, reason]) => [keccakId(signature).slice(0, 10), reason])
);

// Decode a revert: Error(string) payloads (selector 0x08c379a0) carry a reason
// string; otherwise translate known custom-error selectors, or surface the raw
// selector so the failure is still diagnosable.
const decodeRevertString = (data?: string): string | undefined => {
  if (!data || !data.startsWith("0x")) return undefined;
  if (data.startsWith("0x08c379a0") && data.length >= 138) {
    try {
      return AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0] as string;
    } catch {
      return undefined;
    }
  }
  if (data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    const known = CUSTOM_ERROR_REASONS[selector];
    return known ?? `custom error ${selector}`;
  }
  return undefined;
};

const encodeTransferWithAuthorization = (payload: X402PaymentPayload) => {
  const auth = payload.authorization;
  const sig = Signature.from(payload.signature);
  return new Interface(TRANSFER_WITH_AUTHORIZATION_ABI).encodeFunctionData(
    "transferWithAuthorization",
    [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      sig.v,
      sig.r,
      sig.s,
    ],
  );
};
