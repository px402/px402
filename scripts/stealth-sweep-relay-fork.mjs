// Gold-standard proof for spec-stealth-inbox.md section 9 (Component B, "Fork-
// mainnet"): the depositor-signed gasless sweep relay actually broadcasts on a
// forked Base mainnet, through the SAME coordinator/outbox pipeline the server
// uses, and the whole receive -> sweep -> deposit-confirm -> ledger-credit path
// completes with the stealth output holding ZERO native gas throughout.
//
// The offline smoke (test:stealth:sweep-relay) proves the seven binding rules
// and that on-chain mode refuses without the outbox. What it CANNOT prove is
// that the coordinator submit, real broadcast, finality wait, and same-nonce
// classification behave for kind="deposit-relay" against a live chain. That is
// exactly this file.
//
// Prerequisite: an anvil fork of Base mainnet with interval mining so the
// `finalized` tag advances (the coordinator waits for finalized before it
// returns):
//   anvil --fork-url https://mainnet.base.org --chain-id 8453 --port 8545 \
//         --slots-in-an-epoch 1 --block-time 1
// Then: npm run test:stealth:sweep-relay:fork
//
// No real funds: the stealth output's USDC balance is written directly into fork
// storage, and the settler is anvil's pre-funded dev account 0.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Wallet,
  JsonRpcProvider,
  Contract,
  Transaction,
  getAddress,
  keccak256,
  AbiCoder,
  zeroPadValue,
  toBeHex,
} from "ethers";
import { BASE_USDC, createPaymentPayload, randomNonce } from "../src/shared/x402.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import {
  computeStealthPrivateKey,
  deriveStealthAddress,
  generateStealthKeys,
} from "../src/shared/stealth.ts";
import {
  depositRelayIntentMessage,
  privateLedgerDepositConfirmMessage,
  privateLedgerDepositIntentMessage,
} from "../src/shared/x402AgentIntent.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { EvmChainRail } from "../src/server/rails/EvmChainRail.ts";
import { BasePaymentVerifier } from "../src/server/base/BasePaymentVerifier.ts";
import { DepositAddressBook } from "../src/server/payments/DepositAddressBook.ts";
import { InboundAnnouncementBook } from "../src/server/payments/InboundAnnouncementBook.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { TransactionCoordinator, TransactionOutbox } from "../src/server/base/TransactionCoordinator.ts";

const RPC = process.env.PX402_FORK_RPC_URL ?? "http://127.0.0.1:8545";
// anvil dev account 0 — pre-funded with ETH on the fork; is the settler AND the
// pool/treasury so the rail is deposit-capable, exactly like production.
const SETTLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN_ID = 8453;
const AMOUNT = "250000"; // 0.25 USDC atomic
const PAYEE_IP = "10.77.2.10";

const now = () => Math.floor(Date.now() / 1000);
const assert = (condition, message) => {
  if (!condition) throw new Error(message ?? "assertion failed");
};

const inconclusive = (reason) => {
  console.log(`INCONCLUSIVE: ${reason}`);
  process.exitCode = 0;
};

const run = async () => {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID);
  try {
    await provider.getBlockNumber();
  } catch {
    return inconclusive(
      `no fork RPC at ${RPC}. Start anvil first:\n`
      + "  anvil --fork-url https://mainnet.base.org --chain-id 8453 --port 8545 --slots-in-an-epoch 1 --block-time 1",
    );
  }

  const usdc = new Contract(
    BASE_USDC.address,
    ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"],
    provider,
  );
  try {
    if ((await usdc.symbol()) !== "USDC") throw new Error("not USDC");
  } catch {
    return inconclusive(`${RPC} is not a Base mainnet fork (USDC not found).`);
  }
  try {
    const finalized = await provider.getBlock("finalized");
    const latest = await provider.getBlock("latest");
    if (!finalized || !latest) throw new Error("no finalized tag");
    // The coordinator only returns once the including block is <= finalized. On
    // a fork that never advances the finalized tag, this proof would hang until
    // the coordinator timeout, so refuse rather than mislead.
    if (finalized.number === latest.number) {
      const again = await provider.getBlock("latest");
      if (again && again.number === latest.number) {
        return inconclusive(
          "the fork is not interval-mining — the finalized tag will not advance, so the "
          + "coordinator can never finalize. Restart anvil with --block-time 1 --slots-in-an-epoch 1.",
        );
      }
    }
  } catch {
    return inconclusive("this RPC does not implement the finalized block tag; the coordinator needs it.");
  }

  const settler = new Wallet(SETTLER_KEY);
  const dir = await mkdtemp(join(tmpdir(), "sweep-relay-fork-"));
  const KEY = randomBytes(32).toString("hex");
  const ENC = randomBytes(32).toString("hex");
  const assetKey = privateLedgerAssetKey("base", BASE_USDC.address);

  // First-broadcast WAL snapshot: proves the relay is written to the durable
  // outbox BEFORE any bytes hit the wire. The coordinator's provider is wrapped
  // so the first broadcastTransaction records the live outbox state.
  let outbox;
  let walSnapshotAtFirstBroadcast = null;
  const wrappedProvider = new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "broadcastTransaction") {
        return async (signedTx) => {
          if (walSnapshotAtFirstBroadcast === null && outbox) {
            walSnapshotAtFirstBroadcast = outbox.nonterminalNoncesAscending(CHAIN_ID, settler.address);
          }
          return target.broadcastTransaction(signedTx);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    outbox = await new TransactionOutbox(join(dir, "outbox.json"), ENC).load();
    const coordinator = new TransactionCoordinator({
      provider: wrappedProvider,
      address: settler.address,
      chainId: CHAIN_ID,
      outbox,
      finality: "finalized",
      confirmationFloorFallback: 6,
      bumpAfterMs: 45_000, // large: no fee-bump before finality on a live fork
      timeoutMs: 120_000,
      recoveryBudgetMs: 15_000,
    });
    const facilitator = new X402Facilitator({
      rpcUrl: RPC,
      settlerPrivateKey: SETTLER_KEY,
      coordinator,
      token: BASE_USDC,
    });
    const rail = new EvmChainRail({
      facilitator,
      coordinator,
      treasury: settler.address,
      poolPayoutEnabled: false,
    });
    assert(rail.depositCapable, "rail must be deposit-capable (settler == treasury, coordinator present)");

    const ledger = await new PrivatePaymentLedger(join(dir, "ledger.json"), ENC, {
      journal: new EphemeralPaymentJournal(join(dir, "epochs")),
      retentionMs: 60_000,
      baseAssetKey: assetKey,
    }).load();
    const deposits = await new DepositAddressBook(join(dir, "deposits.json"), {
      retentionMs: 900_000,
      encryptionKey: ENC,
    }).load();
    const inbox = await new InboundAnnouncementBook(join(dir, "inbox.json"), {
      retentionMs: 900_000,
      dormantMs: 86_400_000,
      encryptionKey: ENC,
    }).load();

    const payeeIdentity = new Wallet(`0x${KEY}`);
    const registry = new PrivateAgentRegistry([
      {
        agentId: "payee",
        label: "payee",
        vpnIp: PAYEE_IP,
        walletAddress: Wallet.createRandom().address,
        identityAddress: payeeIdentity.address,
        sharedSecret: "s".repeat(32),
        credits: 0,
        inventory: [],
      },
    ], {
      privateLedger: ledger,
      rails: new Map([["base", rail]]),
      depositAddressBook: deposits,
      inboundAnnouncements: inbox,
      stealthDepositsEnabled: true,
      sweepRelayEnabled: true,
    });

    const verifier = new BasePaymentVerifier(RPC, 1);
    const depositConfigs = new Map([["base", {
      recipient: settler.address,
      asset: BASE_USDC.address.toLowerCase(),
      verifyTransfer: (proof) => verifier.verifyErc20Transfer(proof),
    }]]);

    // ---- the stealth output: a payout leg holding USDC and zero native gas ----
    const keys = generateStealthKeys();
    const derived = deriveStealthAddress(keys.meta);
    const outputPrivateKey = computeStealthPrivateKey({
      ephemeralPubKey: derived.ephemeralPubKey,
      viewingKey: keys.viewingKey,
      spendingKey: keys.spendingKey,
    });
    const stealthAddress = derived.stealthAddress;

    // fund the stealth output with USDC by writing fork storage (slot 9 = balances)
    const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [stealthAddress, 9]));
    try {
      await provider.send("anvil_setStorageAt", [BASE_USDC.address, slot, zeroPadValue(toBeHex(BigInt(AMOUNT)), 32)]);
    } catch (error) {
      return inconclusive(`RPC does not support anvil_setStorageAt — ${error instanceof Error ? error.message : error}`);
    }
    assert((await usdc.balanceOf(stealthAddress)) === BigInt(AMOUNT), "stealth output was not funded with USDC");
    assert((await provider.getBalance(stealthAddress)) === 0n, "stealth output must start with zero native gas");

    // ---- a real durable deposit intent (the production stealth-deposit path) ----
    const intentNonce = randomBytes(16).toString("hex");
    const intentFields = {
      agentId: "payee",
      fromAddress: stealthAddress,
      amountAtomic: AMOUNT,
      network: "base",
      intentNonce,
    };
    const intent = await registry.createPrivateLedgerDepositIntent(
      {
        ...intentFields,
        agentSignature: await payeeIdentity.signMessage(privateLedgerDepositIntentMessage(intentFields)),
      },
      PAYEE_IP,
      { recipient: settler.address, asset: BASE_USDC.address.toLowerCase() },
      now(),
    );
    const depositAddress = getAddress(intent.recipient); // fresh one-time deposit address
    assert(getAddress(depositAddress) !== getAddress(stealthAddress), "deposit address must differ from the output");

    // seed the payee's inbox with this output so we can watch observed->sweeping->swept
    const [inboxEntry] = await inbox.addMany([{
      accountId: ledger.accountReference("payee"),
      network: "base",
      caip2: BASE_USDC.caip2,
      tokenAddress: BASE_USDC.address.toLowerCase(),
      stealthAddress,
      ephemeralPubKey: derived.ephemeralPubKey,
      expectedAmountAtomic: AMOUNT,
      source: "pool-payout",
      sourceRef: "fork-proof:0",
    }]);
    await inbox.observe(inboxEntry.id, BigInt(AMOUNT));
    assert(inbox.byStealthAddress("base", stealthAddress).status === "observed", "inbox entry should be observed");

    // ---- the payee signs a gasless EIP-3009 authorization for the sweep ----
    const payload = await createPaymentPayload({
      payerPrivateKey: outputPrivateKey,
      requirements: {
        scheme: "exact",
        network: BASE_USDC.network,
        asset: BASE_USDC.address,
        payTo: depositAddress,
        maxAmountRequired: AMOUNT,
        resource: "sweep",
        nonce: randomNonce(),
        validForSeconds: 600,
      },
      token: BASE_USDC,
      nowSeconds: now(),
    });

    const relayBody = {
      agentId: "payee",
      depositId: intent.depositId,
      network: "base",
      payment: payload,
      agentSignature: await payeeIdentity.signMessage(depositRelayIntentMessage({
        agentId: "payee",
        depositId: intent.depositId,
        network: "base",
        authorizationNonce: payload.authorization.nonce,
      })),
    };

    const ref = `deposit-relay:${intent.depositId}`;
    assert(coordinator.outboxEntriesByRef(ref).length === 0, "outbox must be empty for this ref before the relay");

    console.log("relaying the depositor-signed authorization (settler broadcasts, pays gas)...");
    const poolEthBefore = await provider.getBalance(settler.address);
    // The deposit address is derived from (settlerKey, index); against a shared,
    // long-lived fork it can carry balance from an earlier run, so assert the
    // DELTA this sweep produces, never an absolute balance.
    const depositUsdcBefore = await usdc.balanceOf(depositAddress);
    const relay = await registry.relayPrivateLedgerDeposit(relayBody, PAYEE_IP, depositConfigs, now());

    assert(relay.status === "relayed", `expected relayed, got ${relay.status}`);
    assert(relay.mode === "onchain", `expected onchain broadcast, got ${relay.mode}`);
    assert(relay.transactionHash, "relay produced no transaction hash");
    const relayTx = relay.transactionHash;

    // ---- outbox: WAL-before-broadcast, and finalized winning hash ----
    assert(
      Array.isArray(walSnapshotAtFirstBroadcast) && walSnapshotAtFirstBroadcast.length >= 1,
      "the relay transaction was not written to the durable outbox before it was broadcast",
    );
    assert(
      walSnapshotAtFirstBroadcast.some((entry) => entry.kind === "deposit-relay"),
      "the pre-broadcast outbox entry was not kind=deposit-relay",
    );
    const outboxEntries = coordinator.outboxEntriesByRef(ref);
    assert(outboxEntries.length === 1, `expected one outbox entry for ${ref}, got ${outboxEntries.length}`);
    const settled = outboxEntries[0];
    assert(settled.kind === "deposit-relay", `outbox kind should be deposit-relay, got ${settled.kind}`);
    assert(settled.state === "finalized", `outbox entry should be finalized, got ${settled.state}`);
    assert(
      settled.winningHash && settled.winningHash.toLowerCase() === relayTx.toLowerCase(),
      "outbox winning hash does not match the settlement transaction",
    );

    // ---- classification: the landed hash is classified landed; a stranger is not ----
    const classifiedLanded = await coordinator.classifyTransactionHash(relayTx);
    assert(classifiedLanded.verdict === "landed", `landed tx should classify landed, got ${classifiedLanded.verdict}`);
    assert(
      classifiedLanded.transactionHash?.toLowerCase() === relayTx.toLowerCase(),
      "landed classification returned the wrong transaction hash",
    );
    const classifiedNonce = await coordinator.classifyNonce({ nonce: settled.nonce, logicalId: settled.logicalId });
    assert(classifiedNonce.verdict === "landed", "classifyNonce on the settled entry should be landed");
    const classifiedUnknown = await coordinator.classifyTransactionHash(`0x${"ab".repeat(32)}`);
    assert(classifiedUnknown.verdict === "uncertain", "an unknown hash must not classify as landed");

    // ---- on-chain movement + gas ownership ----
    const receipt = await provider.getTransactionReceipt(relayTx);
    assert(receipt && Number(receipt.status) === 1, "relay transaction did not succeed on-chain");
    const onChainTx = await provider.getTransaction(relayTx);
    assert(
      getAddress(onChainTx.from) === getAddress(settler.address),
      `gas was paid by ${onChainTx.from}, expected the settler ${settler.address}`,
    );
    assert(
      getAddress(onChainTx.to) === getAddress(BASE_USDC.address),
      "the relay must call the USDC token contract, not send native value",
    );
    assert((await usdc.balanceOf(stealthAddress)) === 0n, "the stealth output should be drained after the sweep");
    assert(
      (await usdc.balanceOf(depositAddress)) - depositUsdcBefore === BigInt(AMOUNT),
      "the deposit address did not receive exactly the swept USDC",
    );
    assert(
      (await provider.getBalance(stealthAddress)) === 0n,
      "the stealth output must NEVER hold native gas — the whole point of the relay",
    );
    const poolEthAfter = await provider.getBalance(settler.address);
    assert(poolEthAfter < poolEthBefore, "the settler should have spent gas broadcasting the sweep");

    // inbox moved observed -> sweeping
    assert(
      inbox.byStealthAddress("base", stealthAddress).status === "sweeping",
      "the inbox entry should be sweeping after the relay reserved it",
    );

    // ---- deposit-confirm -> ledger credit (the durable stealth-deposit path) ----
    const confirmFields = { agentId: "payee", depositId: intent.depositId, transactionHash: relayTx, network: "base" };
    const confirmed = await registry.confirmPrivateLedgerDeposit(
      {
        ...confirmFields,
        agentSignature: await payeeIdentity.signMessage(privateLedgerDepositConfirmMessage(confirmFields)),
      },
      PAYEE_IP,
      depositConfigs,
    );
    assert(confirmed.status === "credited", `deposit-confirm should credit, got ${confirmed.status}`);
    assert(confirmed.balanceAtomic === AMOUNT, `credited balance should be ${AMOUNT}, got ${confirmed.balanceAtomic}`);
    // ledger.creditDeposit runs assertConserved/assertState on every mutation; a
    // successful credit is itself the per-asset zero-sum conservation proof.
    assert(ledger.balance("payee", assetKey) === AMOUNT, "payee ledger balance should equal the swept amount");
    assert(
      inbox.byStealthAddress("base", stealthAddress).status === "swept",
      "the inbox entry should be swept after the deposit is credited",
    );

    await ledger.close?.();
    await deposits.close();
    await inbox.close();
    coordinator.close();

    console.log(`\nrelay tx: ${relayTx}`);
    console.log(`stealth output ${stealthAddress}: 0.25 USDC -> 0, native gas 0 throughout`);
    console.log(`deposit address ${depositAddress}: received 0.25 USDC (from the settler-broadcast tx)`);
    console.log(`ledger: payee credited ${AMOUNT} (conservation held)`);
    console.log("\nPASS: forked-mainnet sweep relay — depositor-signed EIP-3009 broadcast by the settler through the");
    console.log("      coordinator/outbox, stealth output drained without ever holding gas, deposit credited.");
    process.exitCode = 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error("\nFAIL: sweep relay fork proof crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
