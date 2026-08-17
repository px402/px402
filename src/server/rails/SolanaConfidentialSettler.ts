/**
 * Broadcasts a Token-2022 confidential transfer plan (spec-confidential-x402.md
 * §15.2). This is the settle half of the confidential rail; the proving half is
 * deliberately client-side and never appears here.
 *
 * A confidential transfer is NOT one transaction. The proofs do not fit, so the
 * plan is an ordered sequence — measured at FIVE on devnet: four that stand up
 * three ZK proof-context accounts, then one that performs the transfer and
 * closes them again. Everything unpleasant about this file follows from that
 * shape:
 *
 *  - The four setup transactions SUCCEED before the transfer is ever attempted.
 *    A transfer that then fails leaves three funded context accounts behind and
 *    the closes — which ride in the same transaction as the transfer — revert
 *    with it. That is 8,539,920 lamports per failed payment, leaked silently.
 *    So failure has a cleanup path, and it is not optional.
 *  - We can run that cleanup because `buildContextStateProofPlan` defaults the
 *    context-state authority to the FEE PAYER and sends closed rent to the fee
 *    payer's address. The fee payer is our settler. So the server can reclaim
 *    the accounts alone, without the payer's cooperation.
 *  - Each transaction is simulated immediately before its own broadcast, never
 *    all up-front: transaction N+1 reads accounts that transaction N creates,
 *    so an up-front simulation of the tail is meaningless.
 *
 * The close set is DERIVED from the submitted transactions, never declared by
 * the caller. A declared list is a griefing primitive — every context account in
 * flight shares one authority (the settler), so a caller who could name an
 * arbitrary address would be naming another payment's proof accounts and closing
 * them mid-flight.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/** The ZK ElGamal proof program that owns every proof-context account. */
export const ZK_ELGAMAL_PROOF_PROGRAM = new PublicKey(
  "ZkE1Gama1Proof11111111111111111111111111111",
);

/** `CloseContextState` is discriminator 0; every `VerifyProof*` is nonzero. */
const CLOSE_CONTEXT_STATE_DISCRIMINATOR = 0;

/**
 * Rent for one proof-context account, measured. Three of these ride on every
 * confidential payment and they scale with CONCURRENCY, not volume — the float
 * that is easiest to under-budget.
 */
export const PROOF_CONTEXT_RENT_LAMPORTS = 2_846_640n;

/** Sanity ceiling. The measured plan is 5; anything far above it is not our plan. */
const MAX_PLAN_TRANSACTIONS = 12;

export type ConfidentialSettleOutcome =
  | {
      status: "settled";
      signatures: string[];
      destinationTokenAccount: string;
    }
  | {
      status: "refused";
      /** Opaque to the payer; detail is for our logs. */
      reason: string;
      detail: string;
      /** Transactions that DID land before the failure. */
      signatures: string[];
      cleanup: ConfidentialCleanupReport;
    };

export interface ConfidentialCleanupReport {
  /** Proof-context accounts we attempted to reclaim. */
  contextAccounts: string[];
  status: "not-needed" | "reclaimed" | "failed" | "dry-run";
  signature?: string;
  detail?: string;
  /** Lamports still stranded if cleanup failed — the number an operator needs. */
  strandedLamports?: string;
}

export interface ConfidentialSettleInput {
  /** Ordered, base64 wire transactions, partially signed by the payer. */
  transactions: string[];
  /**
   * The ATA this payment must credit, derived by US from the quote's stealth
   * recipient. Never read from the payload.
   */
  expectedDestinationTokenAccount: string;
  /** The mint from the quote. */
  expectedMint: string;
  /**
   * Durable write-ahead, awaited before the FIRST broadcast and never after.
   *
   * A parameter rather than a convention because the ordering is load-bearing:
   * the payee's one-time key is `kSpend + H(kView·R)`, so an announcement lost
   * between broadcast and index-write leaves funds that nobody — including us —
   * can locate again. If this throws, nothing is broadcast and the payment is
   * refused with the money still in the payer's account.
   */
  writeAheadAnnouncement: () => Promise<void>;
}

/** JSON that survives `{ Custom: 26n }`. See `describeSolanaError`. */
export const bigintSafeReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/**
 * Walks the whole error graph.
 *
 * `@solana/kit`'s own error formatter throws `TypeError: Do not know how to
 * serialize a BigInt` on `{ Custom: 26n }`, which DESTROYS the program error and
 * replaces it with a generic wrapper message. Reading `.message` once already
 * produced one false conclusion in this repo — the probe reported the on-chain
 * verdict as a `ReferenceError` thrown by our own script. Hence: recurse through
 * `cause`, pull `context` and `logs`, and never let a serialization failure
 * masquerade as a chain answer.
 */
export const describeSolanaError = (error: unknown, depth = 0): string => {
  const pad = "  ".repeat(depth);
  if (error === null || error === undefined) return `${pad}(none)`;
  if (typeof error !== "object") return `${pad}${String(error)}`;
  const node = error as Record<string, unknown>;
  const lines: string[] = [];
  const name = (node.constructor as { name?: string } | undefined)?.name ?? "Object";
  lines.push(`${pad}[${name}] ${String(node.message ?? "")}`);
  if ("code" in node) lines.push(`${pad}  code: ${String(node.code)}`);
  if (node.context) {
    try {
      lines.push(`${pad}  context: ${JSON.stringify(node.context, bigintSafeReplacer)}`);
    } catch {
      lines.push(`${pad}  context: (unserializable)`);
    }
  }
  for (const key of ["logs", "transactionLogs"]) {
    const value = node[key];
    if (Array.isArray(value)) {
      lines.push(`${pad}  ${key}:`);
      for (const line of value.slice(0, 24)) lines.push(`${pad}    ${String(line)}`);
    }
  }
  if (node.cause && depth < 6) {
    lines.push(`${pad}  cause:`);
    lines.push(describeSolanaError(node.cause, depth + 2));
  }
  return lines.join("\n");
};

/**
 * The proof-context accounts these transactions create, read off the wire.
 *
 * A `VerifyProof*` instruction carrying an inline proof takes exactly
 * `[contextState (writable), contextStateAuthority (readonly)]`. We take the
 * first account of every such instruction whose authority is OUR settler — the
 * authority check is what makes this safe to act on, because closing is only
 * possible for accounts we already control, and refusing to look at any other
 * account means a caller cannot point us at someone else's.
 */
export const deriveProofContextAccounts = (
  transactions: VersionedTransaction[],
  settler: PublicKey,
): string[] => {
  const found = new Set<string>();
  for (const transaction of transactions) {
    const keys = transaction.message.staticAccountKeys;
    for (const instruction of transaction.message.compiledInstructions) {
      const programId = keys[instruction.programIdIndex];
      if (!programId?.equals(ZK_ELGAMAL_PROOF_PROGRAM)) continue;
      const data = instruction.data;
      if (data.length === 0) continue;
      if (data[0] === CLOSE_CONTEXT_STATE_DISCRIMINATOR) continue;
      // Inline-proof verify with a context account: [contextState, authority].
      if (instruction.accountKeyIndexes.length < 2) continue;
      const contextState = keys[instruction.accountKeyIndexes[0]];
      const authority = keys[instruction.accountKeyIndexes[1]];
      if (!contextState || !authority) continue;
      if (!authority.equals(settler)) continue;
      found.add(contextState.toBase58());
    }
  }
  return [...found];
};

export interface SolanaConfidentialSettlerOptions {
  connection: Connection;
  /**
   * The settler's PUBLIC key — required even in dry-run.
   *
   * Split from the signing keypair on purpose. Every binding check ("is the
   * settler the fee payer", "is the settler this context account's authority")
   * needs only the pubkey, and dry-run is the DEFAULT state of this rail. Making
   * the two one field meant `decodePlan` threw with no key configured, which
   * turned the default configuration into a hard failure instead of a
   * verify-and-simulate.
   */
  settlerPubkey: PublicKey;
  /** Absent ⇒ dry-run: verified and simulated, never broadcast. */
  settler?: Keypair;
  /** Shared settler-EOA serializer. A send that bypasses it corrupts the pipeline. */
  sendCoordinator?: { send<T>(operation: () => Promise<T>): Promise<T> };
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class SolanaConfidentialSettler {
  private readonly connection: Connection;
  private readonly settler?: Keypair;
  private readonly settlerAddress: PublicKey;
  private readonly sendCoordinator?: { send<T>(operation: () => Promise<T>): Promise<T> };
  private readonly confirmTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: SolanaConfidentialSettlerOptions) {
    this.connection = options.connection;
    this.settler = options.settler;
    this.settlerAddress = options.settlerPubkey;
    if (options.settler && !options.settler.publicKey.equals(options.settlerPubkey)) {
      // Silently preferring one would make every binding check assert against a
      // different key than the one that actually signs.
      throw new Error("confidential settler keypair does not match the configured settler pubkey");
    }
    this.sendCoordinator = options.sendCoordinator;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 90_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  get hasSettlerKey(): boolean {
    return Boolean(this.settler);
  }

  /**
   * Decode + statically validate a plan without touching the chain.
   *
   * Every binding here is checked against values WE derived from the quote. The
   * payload is a transport, not a source of truth.
   */
  decodePlan(input: {
    transactions: string[];
    expectedDestinationTokenAccount: string;
    expectedMint: string;
  }): {
    transactions: VersionedTransaction[];
    contextAccounts: string[];
  } {
    if (!Array.isArray(input.transactions) || input.transactions.length === 0) {
      throw new Error("confidential plan carries no transactions");
    }
    if (input.transactions.length > MAX_PLAN_TRANSACTIONS) {
      throw new Error(
        `confidential plan has ${input.transactions.length} transactions, over the ${MAX_PLAN_TRANSACTIONS} cap`,
      );
    }
    const settler = this.settlerPubkey();
    const decoded = input.transactions.map((wire, index) => {
      let transaction: VersionedTransaction;
      try {
        transaction = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
      } catch (error) {
        throw new Error(
          `confidential plan transaction ${index} is not a decodable versioned transaction: `
          + (error instanceof Error ? error.message : "unknown"),
        );
      }
      const feePayer = transaction.message.staticAccountKeys[0];
      if (!feePayer || !feePayer.equals(settler)) {
        // If this were not asserted we would be co-signing a transaction whose
        // fees and rent we pay but whose shape we never chose.
        throw new Error(
          `confidential plan transaction ${index} does not name the settler as fee payer`,
        );
      }
      return transaction;
    });

    // The destination ATA is the whole point of the binding: it is derived from
    // the quote's stealth recipient, so a payload that credits anything else is
    // paying someone we did not quote.
    const destination = new PublicKey(input.expectedDestinationTokenAccount);
    const mint = new PublicKey(input.expectedMint);
    const referencesDestination = decoded.some((transaction) =>
      transaction.message.staticAccountKeys.some((key) => key.equals(destination)),
    );
    if (!referencesDestination) {
      throw new Error("confidential plan never references the quoted destination token account");
    }
    const referencesMint = decoded.some((transaction) =>
      transaction.message.staticAccountKeys.some((key) => key.equals(mint)),
    );
    if (!referencesMint) {
      throw new Error("confidential plan never references the quoted mint");
    }

    return { transactions: decoded, contextAccounts: deriveProofContextAccounts(decoded, settler) };
  }

  /**
   * Simulate every transaction without broadcasting any.
   *
   * Only the FIRST transaction's verdict is trustworthy — the rest read accounts
   * their predecessors create, so they legitimately fail against current state.
   * That asymmetry is why the real per-transaction simulation lives inline in
   * `settle` and this exists only as a cheap pre-flight.
   */
  async simulateFirst(transactions: VersionedTransaction[]): Promise<{ ok: boolean; reason?: string }> {
    const first = transactions[0];
    if (!first) return { ok: false, reason: "empty plan" };
    const signed = this.withSettlerSignature(first);
    const verdict = await this.simulate(signed);
    return verdict.err
      ? { ok: false, reason: `simulation failed: ${verdict.errText}` }
      : { ok: true };
  }

  async settle(input: ConfidentialSettleInput): Promise<ConfidentialSettleOutcome> {
    const { transactions, contextAccounts } = this.decodePlan(input);

    if (!this.settler) {
      // Dry-run: verified and simulated, never broadcast. The announcement is
      // NOT written — nothing was created for anyone to sweep.
      const verdict = await this.simulateFirst(transactions);
      return verdict.ok
        ? {
            status: "refused",
            reason: "confidential_dry_run",
            detail: "no Solana settler key configured — verified and simulated only",
            signatures: [],
            cleanup: { contextAccounts, status: "dry-run" },
          }
        : {
            status: "refused",
            reason: "confidential_simulation_failed",
            detail: verdict.reason ?? "unknown",
            signatures: [],
            cleanup: { contextAccounts, status: "dry-run" },
          };
    }

    // Requirement 3: durable before broadcastable. If this throws we have not
    // moved anything, and the payer keeps its money.
    await input.writeAheadAnnouncement();

    const signatures: string[] = [];
    for (const [index, transaction] of transactions.entries()) {
      const signed = this.withSettlerSignature(transaction);

      // Requirement 1: simulate this transaction, now, against the state its
      // predecessors just created — and read `value.err` rather than catching a
      // thrown wrapper whose formatter would have eaten the program error.
      const verdict = await this.simulate(signed);
      if (verdict.err) {
        const cleanup = await this.reclaimContextAccounts(contextAccounts);
        return {
          status: "refused",
          reason: "confidential_simulation_failed",
          detail: `transaction ${index}: ${verdict.errText}`
            + (verdict.logs.length ? `\nlogs:\n  ${verdict.logs.slice(-12).join("\n  ")}` : ""),
          signatures,
          cleanup,
        };
      }

      try {
        const signature = await this.send(signed);
        await this.confirm(signature);
        signatures.push(signature);
      } catch (error) {
        // Requirement 2: proof setup already landed, so the accounts exist and
        // the closes that would have freed them died with the transfer.
        const cleanup = await this.reclaimContextAccounts(contextAccounts);
        return {
          status: "refused",
          reason: "confidential_broadcast_failed",
          detail: `transaction ${index}: ${describeSolanaError(error)}`,
          signatures,
          cleanup,
        };
      }
    }

    return {
      status: "settled",
      signatures,
      destinationTokenAccount: input.expectedDestinationTokenAccount,
    };
  }

  /**
   * Broadcast a payee-signed slot-provisioning plan (§5.2-P, the second
   * signature of the ceremony).
   *
   * Deliberately NOT `settle`: there is no announcement to write ahead (nothing
   * of value moves — this creates an empty account), and there are no proof
   * contexts to reclaim, because `ConfigureConfidentialTransferAccount` carries
   * its `PubkeyValidityProof` inline. The failure mode is a wasted rent payment,
   * not a leaked one, so the cleanup machinery would be dead weight.
   *
   * The plan cannot be built server-side at all: `Reallocate` and `Configure`
   * require the ACCOUNT OWNER's signature — measured on devnet as
   * `Missing required signature for instruction (instruction #2)` — and the
   * owner is a one-time stealth key only the payee can derive.
   */
  async provision(input: { transactions: string[] }): Promise<{
    status: "provisioned" | "refused";
    signatures: string[];
    detail?: string;
  }> {
    if (!Array.isArray(input.transactions) || input.transactions.length === 0) {
      throw new Error("confidential provisioning plan carries no transactions");
    }
    if (input.transactions.length > MAX_PLAN_TRANSACTIONS) {
      throw new Error("confidential provisioning plan exceeds the transaction cap");
    }
    const settler = this.settlerPubkey();
    const decoded = input.transactions.map((wire, index) => {
      const transaction = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
      const feePayer = transaction.message.staticAccountKeys[0];
      if (!feePayer || !feePayer.equals(settler)) {
        // We fund the rent, so we insist on being the fee payer we agreed to be.
        throw new Error(`provisioning transaction ${index} does not name the settler as fee payer`);
      }
      return transaction;
    });
    if (!this.settler) {
      return {
        status: "refused",
        signatures: [],
        detail: "no Solana settler key configured — provisioning verified only",
      };
    }
    const signatures: string[] = [];
    for (const [index, transaction] of decoded.entries()) {
      const signed = this.withSettlerSignature(transaction);
      const verdict = await this.simulate(signed);
      if (verdict.err) {
        return {
          status: "refused",
          signatures,
          detail: `transaction ${index}: ${verdict.errText}`
            + (verdict.logs.length ? `\nlogs:\n  ${verdict.logs.slice(-12).join("\n  ")}` : ""),
        };
      }
      try {
        const signature = await this.send(signed);
        await this.confirm(signature);
        signatures.push(signature);
      } catch (error) {
        return {
          status: "refused",
          signatures,
          detail: `transaction ${index}: ${describeSolanaError(error)}`,
        };
      }
    }
    return { status: "provisioned", signatures };
  }

  /**
   * Close the proof-context accounts a failed plan left funded.
   *
   * Only reaches accounts that still exist — a plan that failed on a setup
   * transaction may have created none, and the successful path closes its own.
   * Best-effort by design: a cleanup that throws must never convert a refusal
   * into an exception, because the refusal is the answer the payer is owed. What
   * it must do instead is report the stranded lamports loudly enough for an
   * operator to act.
   */
  private async reclaimContextAccounts(
    contextAccounts: string[],
  ): Promise<ConfidentialCleanupReport> {
    if (contextAccounts.length === 0 || !this.settler) {
      return { contextAccounts, status: "not-needed" };
    }
    const settler = this.settler;
    try {
      const live: PublicKey[] = [];
      for (const account of contextAccounts) {
        const pubkey = new PublicKey(account);
        const info = await this.connection.getAccountInfo(pubkey, "confirmed");
        if (info) live.push(pubkey);
      }
      if (live.length === 0) return { contextAccounts, status: "not-needed" };

      const instructions = live.map(
        (contextState) =>
          new TransactionInstruction({
            programId: ZK_ELGAMAL_PROOF_PROGRAM,
            keys: [
              { pubkey: contextState, isSigner: false, isWritable: true },
              { pubkey: settler.publicKey, isSigner: false, isWritable: true },
              { pubkey: settler.publicKey, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([CLOSE_CONTEXT_STATE_DISCRIMINATOR]),
          }),
      );
      const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({
        payerKey: settler.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([settler]);
      const signature = await this.send(transaction);
      await this.confirm(signature);
      return {
        contextAccounts: live.map((key) => key.toBase58()),
        status: "reclaimed",
        signature,
      };
    } catch (error) {
      const stranded = BigInt(contextAccounts.length) * PROOF_CONTEXT_RENT_LAMPORTS;
      console.error(
        `CONFIDENTIAL_PROOF_CONTEXT_LEAK accounts=${contextAccounts.join(",")}`
        + ` lamports=${stranded} — close these manually; rent returns to the settler\n`
        + describeSolanaError(error),
      );
      return {
        contextAccounts,
        status: "failed",
        detail: describeSolanaError(error).slice(0, 400),
        strandedLamports: stranded.toString(),
      };
    }
  }

  private settlerPubkey(): PublicKey {
    return this.settlerAddress;
  }

  /** Adds our signature in place; the payer's existing signatures are preserved. */
  private withSettlerSignature(transaction: VersionedTransaction): VersionedTransaction {
    if (!this.settler) return transaction;
    const copy = VersionedTransaction.deserialize(transaction.serialize());
    copy.sign([this.settler]);
    return copy;
  }

  private async simulate(transaction: VersionedTransaction): Promise<{
    err: unknown;
    errText: string;
    logs: string[];
  }> {
    try {
      const result = await this.connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: false,
        sigVerify: false,
        commitment: "confirmed",
      });
      const err = result.value.err ?? null;
      return {
        err,
        // The bigint-safe stringify is the whole point: `{ Custom: 26n }` is
        // exactly the shape that throws inside a naive formatter.
        errText: err ? safeJson(err) : "",
        logs: result.value.logs ?? [],
      };
    } catch (error) {
      // A simulate that THREW is not a chain verdict. Surface it as one failure
      // with its real cause rather than letting it read as a program rejection.
      return {
        err: { simulateThrew: true },
        errText: `simulate threw (not a program verdict): ${describeSolanaError(error)}`,
        logs: [],
      };
    }
  }

  /** Requirement 4: every settler-EOA send goes through the shared coordinator. */
  private send(transaction: VersionedTransaction): Promise<string> {
    const operation = () =>
      this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true, // we just simulated; preflight would re-do it
        maxRetries: 3,
      });
    return this.sendCoordinator ? this.sendCoordinator.send(operation) : operation();
  }

  /**
   * Poll to a bounded deadline rather than using blockhash expiry.
   *
   * The payer chose these blockhashes and we never received their
   * `lastValidBlockHeight`, so the height-based confirmation strategy is not
   * available. A timeout here is genuinely ambiguous — it is reported as a
   * failure, and the cleanup path is idempotent against the case where the
   * transaction lands afterwards.
   */
  private async confirm(signature: string): Promise<void> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    for (;;) {
      const statuses = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });
      const status = statuses.value[0];
      if (status?.err) {
        throw new Error(`transaction ${signature} failed on-chain: ${safeJson(status.err)}`);
      }
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`transaction ${signature} did not confirm within ${this.confirmTimeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, bigintSafeReplacer) ?? String(value);
  } catch {
    return String(value);
  }
};
