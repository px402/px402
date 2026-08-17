// One-shot REAL pool-direct shielded payout proof on a live network. The shared
// settler POOL pays a fresh stealth address on-chain; the payer's private-ledger
// balance is debited. Guarded: --confirm required; preflight moves no funds.
//
//   npm run x402:pool-payout-live -- --network base|rh|solana        # preflight (no broadcast)
//   npm run x402:pool-payout-live -- --network rh --confirm      # real ~0.10 USDG pool payout
//   npm run x402:pool-payout-live -- --network solana --confirm  # real ~0.10 USDC-SPL pool payout
//
// Uses existing pool funds (settler==treasury). Bootstraps a demo sender's ledger
// balance via creditDeposit (backed by the real pool), then proves: pool -> stealth
// recipient on-chain, sender ledger debited, conservation preserved.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Wallet, JsonRpcProvider, Contract, formatUnits } from "ethers";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BASE_USDC, ROBINHOOD_USDG, SOLANA_USDC } from "../src/shared/x402.ts";
import { privateLedgerAssetKey } from "../src/shared/privateLedger.ts";
import {
  DEFAULT_MAX_PAYOUT_LEGS,
  DEFAULT_MAX_PAYOUT_LEGS_SOLANA,
  PAYOUT_POLICY_VERSION,
  defaultDenominationsAtomic
} from "../src/shared/denominations.ts";
import {
  addressForPrivateKey,
  computeStealthPrivateKey,
  generateStealthKeys
} from "../src/shared/stealth.ts";
import {
  generateSolanaStealthKeys,
  publicKeyForSolanaScalar,
  recoverSolanaStealthScalar
} from "../src/shared/stealthSolana.ts";

console.warn(`!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.`);
import { poolPayoutClaimIntentMessage, x402QuoteIntentMessage } from "../src/shared/x402AgentIntent.ts";
import { preparePoolPayout } from "../src/shared/privateX402Client.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";
import { SolanaX402Facilitator } from "../src/server/base/SolanaX402Facilitator.ts";
import { EvmChainRail } from "../src/server/rails/EvmChainRail.ts";
import { SolanaChainRail } from "../src/server/rails/SolanaChainRail.ts";
import { PrivatePaymentLedger } from "../src/server/payments/PrivatePaymentLedger.ts";
import { EphemeralPaymentJournal } from "../src/server/payments/EphemeralPaymentJournal.ts";
import { PendingPayoutJournal } from "../src/server/payments/PendingPayoutJournal.ts";
import { PoolPayoutQueue } from "../src/server/payments/PoolPayoutQueue.ts";
import { TransactionCoordinator, TransactionOutbox } from "../src/server/base/TransactionCoordinator.ts";

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const network = arg("--network") ?? "rh";
const confirm = process.argv.includes("--confirm");
const senderLabel = arg("--sender-label") ?? "agent-kaito";
const receiverLabel = arg("--receiver-label") ?? "agent-yuki";
const amount = arg("--amount") ?? "100000"; // atomic (6 decimals); e.g. 800000 = 0.80
const bootstrap = arg("--bootstrap") ?? (BigInt(amount) + 100000n).toString(); // sender ledger balance
const IP = "127.0.0.1";
// A mainnet leg is INCLUDED long before it is final, so the proof has to wait for a
// reconcile rather than assert settled straight after the flush. Default 30 min covers
// the ~1462s Base / ~1128s Robinhood finality lag measured 2026-07-31.
const POOL_PAYOUT_SETTLE_TIMEOUT_MS = Number(
  process.env.PX402_POOL_PAYOUT_LIVE_SETTLE_TIMEOUT_MS ?? 1_800_000,
);
const POOL_PAYOUT_SETTLE_POLL_MS = Number(
  process.env.PX402_POOL_PAYOUT_LIVE_SETTLE_POLL_MS ?? 15_000,
);
const DEMO_DIR = join("data", "pool-payout-demos");

const loadEnv = (file) => {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
};

const requireArgValue = (name, value) => {
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a non-empty value`);
  return value;
};

const syncDirectory = async (path) => {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms. The record itself is
    // always fsynced; production Linux also gets the directory sync.
  }
};

const writeFileSynced = async (path, record, flags) => {
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
};

const createDemoRecord = async (record) => {
  await mkdir(DEMO_DIR, { recursive: true, mode: 0o700 });
  await chmod(DEMO_DIR, 0o700);
  let timestamp = Math.floor(Date.now() / 1000);
  while (true) {
    const path = join(DEMO_DIR, `${network}-${timestamp}.json`);
    try {
      await writeFileSynced(path, record, "wx");
      await syncDirectory(DEMO_DIR);
      return path;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      timestamp += 1;
    }
  }
};

const replaceDemoRecord = async (path, record) => {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let renamed = false;
  try {
    await writeFileSynced(temporaryPath, record, "wx");
    await rename(temporaryPath, path);
    renamed = true;
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
};

const displayPath = (path) => relative(process.cwd(), path).split(sep).join("/");

const buildViews = ({ legs, poolAddress, timestamp, dryRun, symbol }) => ({
  publicView: [
    ...(dryRun ? ["This rehearsal created no on-chain transaction."] : []),
    ...legs.map((leg) =>
      `${dryRun ? "A broadcast would show" : "The chain shows"} shared pool ${poolAddress} paying `
      + `${formatUnits(leg.amountAtomic, 6)} ${symbol} to fresh address ${leg.stealthAddress} at ${timestamp}.`),
    "Each leg amount, time, pool sender, and fresh recipient are public; the grouped payout total is not written as one transfer."
  ],
  privateView: [
    "The identity of the agent whose private-ledger balance funded the payout.",
    "The identity controlling each fresh receiver address and the sender-to-receiver link.",
    "The sender's private-ledger balance before and after the payout."
  ]
});

const printTranscript = ({ record, recordPath, symbol }) => {
  console.log("\nSENDER");
  console.log(`  label: ${record.sender.label}`);
  console.log(`  off-chain ledger balance before: ${formatUnits(record.sender.balanceBefore, 6)} ${symbol}`);

  console.log("\nPAYOUT LEGS");
  for (const leg of record.legs) {
    const chain = leg.onchain;
    console.log(`  [${leg.index}] ${formatUnits(leg.amountAtomic, 6)} ${symbol} -> ${leg.stealthAddress}`);
    console.log(`      tx: ${chain?.dryRun ? "DRY RUN (not broadcast)" : chain?.transactionHash ?? "not submitted"}`);
    console.log(`      explorer: ${chain?.dryRun ? "not available" : chain?.explorer ?? "not available"}`);
    console.log(`      from=pool: ${chain?.from ?? "not submitted"}`);
  }

  console.log("\nWHAT AN OBSERVER SEES");
  for (const line of record.publicView) console.log(`  - ${line}`);

  console.log("\nWHAT STAYED PRIVATE");
  for (const line of record.privateView) console.log(`  - ${line}`);

  console.log("\nSWEEP");
  console.log(`  npm run x402:stealth-sweep -- --record "${displayPath(recordPath)}" --to <destination-address> --confirm`);
};

const run = async () => {
  requireArgValue("--sender-label", senderLabel);
  requireArgValue("--receiver-label", receiverLabel);
  const dir = await mkdtemp(join(tmpdir(), "pool-live-"));
  try {
    const ledger = await new PrivatePaymentLedger(join(dir, "ledger.json"), "pool-live-key", {
      journal: new EphemeralPaymentJournal(join(dir, "epochs")),
      retentionMs: 60_000
    }).load();

    const payeeIdentity = Wallet.createRandom();
    const payerIdentity = Wallet.createRandom();
    const senderAgentId = `demo-sender-${randomBytes(12).toString("hex")}`;
    const receiverAgentId = `demo-receiver-${randomBytes(12).toString("hex")}`;
    let rail, token, friendly, poolBalance, recipientBalance, explorer, poolAddr, symbol;
    let coordinator;

    // Both EVM rails share one settler EOA and differ only by RPC / chainId / token,
    // so they run through the same construction path.
    if (network === "rh" || network === "base") {
      const evm = network === "base"
        ? {
          rpcVar: "PX402_BASE_RPC_URL",
          rpcDefault: "https://mainnet.base.org",
          chainId: 8453,
          token: BASE_USDC,
          friendly: "base",
          symbol: "USDC",
          explorerBase: "https://basescan.org/tx/"
        }
        : {
          rpcVar: "PX402_RH_RPC_URL",
          rpcDefault: "https://rpc.mainnet.chain.robinhood.com",
          chainId: 4663,
          token: ROBINHOOD_USDG,
          friendly: "robinhood",
          symbol: "USDG",
          explorerBase: "https://robinhoodchain.blockscout.com/tx/"
        };
      const env = loadEnv(".env.x402.local");
      const key = env.PX402_BASE_X402_SETTLER_KEY;
      if (!key) throw new Error("PX402_BASE_X402_SETTLER_KEY is required in .env.x402.local");
      const rpc = env[evm.rpcVar] ?? evm.rpcDefault;
      const settler = new Wallet(key);
      poolAddr = settler.address;
      const outbox = await new TransactionOutbox(join(dir, "outbox.json"), "pool-live-key").load();
      const provider = new JsonRpcProvider(rpc, evm.chainId);
      coordinator = new TransactionCoordinator({
        provider,
        address: settler.address,
        chainId: evm.chainId,
        outbox,
        finality: "finalized",
        confirmationFloorFallback: 6,
        bumpAfterMs: 45_000,
        timeoutMs: 120_000,
        recoveryBudgetMs: 15_000
      });
      const facilitator = new X402Facilitator({
        rpcUrl: rpc,
        settlerPrivateKey: key,
        coordinator,
        token: evm.token
      });
      rail = new EvmChainRail({
        facilitator,
        coordinator,
        treasury: settler.address,
        poolPayoutEnabled: true
      });
      token = evm.token;
      friendly = evm.friendly;
      symbol = evm.symbol;
      const erc20 = new Contract(
        evm.token.address,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      );
      poolBalance = async () => erc20.balanceOf(settler.address);
      recipientBalance = async (address) => erc20.balanceOf(address);
      explorer = (transactionHash) => `${evm.explorerBase}${transactionHash}`;
    } else if (network === "solana") {
      const env = loadEnv(".env.x402-solana.local");
      const secret = env.X402_SOLANA_SECRET_BASE58;
      const settlerPubkey = env.X402_SOLANA_ADDRESS;
      if (!secret || !settlerPubkey) {
        throw new Error("X402_SOLANA_SECRET_BASE58 and X402_SOLANA_ADDRESS are required in .env.x402-solana.local");
      }
      const rpc = process.env.PX402_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
      poolAddr = settlerPubkey;
      const facilitator = new SolanaX402Facilitator({
        rpcUrl: rpc,
        settlerSecretKey: secret,
        token: SOLANA_USDC
      });
      rail = new SolanaChainRail({
        facilitator,
        treasury: settlerPubkey,
        poolPayoutEnabled: true
      });
      token = SOLANA_USDC;
      friendly = "solana";
      symbol = "USDC-SPL";
      const connection = new Connection(rpc, "confirmed");
      const mint = new PublicKey(SOLANA_USDC.address);
      poolBalance = async () => {
        const ata = getAssociatedTokenAddressSync(mint, new PublicKey(settlerPubkey));
        return BigInt((await connection.getTokenAccountBalance(ata)).value.amount);
      };
      recipientBalance = async (address) => {
        try {
          const ata = getAssociatedTokenAddressSync(mint, new PublicKey(address));
          return BigInt((await connection.getTokenAccountBalance(ata)).value.amount);
        } catch {
          return 0n;
        }
      };
      explorer = (transactionHash) => `https://solscan.io/tx/${transactionHash}`;
    } else {
      throw new Error(`unknown --network ${network} (use base|rh|solana)`);
    }

    const assetKey = privateLedgerAssetKey(friendly, token.address);
    const pendingJournal = new PendingPayoutJournal(join(dir, "pending.json"), "pool-live-key");
    const queue = new PoolPayoutQueue({
      journal: pendingJournal,
      ledger,
      rails: new Map([[friendly, rail]]),
      flushMs: 60_000,
      maxJitterMs: 0,
      maxAttempts: 3,
      reconcileMs: 120_000,
      recoveryBudgetMs: 15_000,
      claimTtlMs: 900_000
    });
    await queue.recover();
    const stealth = network === "solana" ? generateSolanaStealthKeys() : generateStealthKeys();
    const viewingKey = network === "solana" ? stealth.viewingScalar : stealth.viewingKey;
    const registry = new PrivateAgentRegistry([
      {
        agentId: senderAgentId,
        label: senderLabel,
        vpnIp: IP,
        walletAddress: network === "solana"
          ? Keypair.generate().publicKey.toBase58()
          : Wallet.createRandom().address,
        identityAddress: payerIdentity.address,
        sharedSecret: "p",
        credits: 0,
        inventory: []
      },
      {
        agentId: receiverAgentId,
        label: receiverLabel,
        vpnIp: IP,
        walletAddress: network === "solana"
          ? Keypair.generate().publicKey.toBase58()
          : Wallet.createRandom().address,
        identityAddress: payeeIdentity.address,
        sharedSecret: "q",
        credits: 0,
        inventory: [],
        ...(network === "solana"
          ? { solanaStealthMeta: stealth.meta, solanaStealthViewingKey: viewingKey }
          : { stealthMeta: stealth.meta, stealthViewingKey: viewingKey })
      }
    ], {
      privateLedger: ledger,
      rails: new Map([[friendly, rail]]),
      payoutQueue: queue,
      poolPayoutBatchingEnabled: true,
      payout: {
        enabled: true,
        policyVersion: PAYOUT_POLICY_VERSION,
        byNetwork: new Map([[friendly, {
          denominationsAtomic: defaultDenominationsAtomic(6),
          maxLegs: network === "solana"
            ? DEFAULT_MAX_PAYOUT_LEGS_SOLANA
            : DEFAULT_MAX_PAYOUT_LEGS
        }]])
      }
    });

    const pool = await poolBalance();
    console.log(`=== pool-direct payout preflight (${friendly} mainnet) ===`);
    console.log(`amount: ${formatUnits(amount, 6)} ${symbol}`);
    console.log(`POOL ${poolAddr} balance=${formatUnits(pool, 6)}`);
    console.log(`poolMode: ${rail.poolMode}`);
    if (rail.poolMode !== "onchain") {
      throw new Error("rail is not in onchain pool mode (check settler key + treasury match)");
    }

    await ledger.creditDeposit({
      agentId: senderAgentId,
      amountAtomic: bootstrap,
      network: friendly,
      assetKey,
      transactionHash: `0x${randomBytes(32).toString("hex")}`
    });
    const balanceBefore = ledger.balance(senderAgentId, assetKey);
    const now = Math.floor(Date.now() / 1000);
    const intentNonce = `0x${randomBytes(32).toString("hex")}`;
    const resource = `pool-live-proof:${senderLabel}->${receiverLabel}`;
    const agentSignature = await payeeIdentity.signMessage(x402QuoteIntentMessage({
      payeeAgentId: receiverAgentId,
      payerAgentId: senderAgentId,
      amountAtomic: amount,
      resource,
      validForSeconds: 600,
      network: friendly,
      intentNonce
    }));
    const quote = await registry.quoteX402({
      payeeAgentId: receiverAgentId,
      payerAgentId: senderAgentId,
      amountAtomic: amount,
      resource,
      validForSeconds: 600,
      network: friendly,
      intentNonce,
      agentSignature
    }, IP, token, now);
    const prepared = await preparePoolPayout({
      requirements: quote,
      identitySigner: payerIdentity,
      payerAgentId: senderAgentId,
      payeeAgentId: receiverAgentId,
      network: friendly
    });
    if (!("plan" in prepared)) throw new Error("denominations-enabled quote did not produce a v2 payout plan");
    const legRecords = prepared.plan.legs.map((leg) => {
      if (!leg.ephemeralPubKey) throw new Error(`payout leg ${leg.index} has no stealth announcement`);
      const resolved = rail.resolveRecipient({
        requirements: quote,
        payee: {
          walletAddress: quote.payTo,
          ...(network === "solana"
            ? { solanaStealthViewingKey: stealth.viewingScalar }
            : { stealthViewingKey: stealth.viewingKey })
        },
        ephemeralPubKey: leg.ephemeralPubKey
      });
      if (resolved.recipient !== leg.recipient) {
        throw new Error(`payout leg ${leg.index} announcement does not resolve to its planned recipient`);
      }
      const stealthPrivateKey = network === "solana"
        ? recoverSolanaStealthScalar({
            ephemeralPubKey: leg.ephemeralPubKey,
            viewingScalar: stealth.viewingScalar,
            spendingScalar: stealth.spendingScalar,
            expectedAddress: leg.recipient
          })
        : computeStealthPrivateKey({
            ephemeralPubKey: leg.ephemeralPubKey,
            viewingKey: stealth.viewingKey,
            spendingKey: stealth.spendingKey
          });
      const controlsExpectedAddress = network === "solana"
        ? publicKeyForSolanaScalar(stealthPrivateKey).toBase58() === leg.recipient
        : addressForPrivateKey(stealthPrivateKey) === leg.recipient;
      if (!controlsExpectedAddress) {
        throw new Error(`persisted stealth key does not control payout leg ${leg.index}`);
      }
      return {
        index: leg.index,
        payoutRef: leg.payoutRef,
        amountAtomic: leg.amountAtomic,
        denominationAtomic: leg.denominationAtomic,
        stealthAddress: leg.recipient,
        ephemeralPubKey: leg.ephemeralPubKey,
        spendPrivateKey: network === "solana" ? stealth.spendingScalar : stealth.spendingKey,
        viewPrivateKey: network === "solana" ? stealth.viewingScalar : stealth.viewingKey,
        stealthPrivateKey,
        ...(network === "solana" ? { stealthPublicKey: leg.recipient } : {}),
        onchain: null
      };
    });

    const createdAt = new Date().toISOString();
    const amountDisplay = `${formatUnits(amount, 6)} ${symbol}`;
    const plannedViews = buildViews({
      legs: legRecords,
      poolAddress: poolAddr,
      timestamp: createdAt,
      dryRun: true,
      symbol
    });
    const record = {
      version: 2,
      createdAt,
      network: friendly,
      asset: token.address,
      strategy: prepared.plan.strategy,
      totalAtomic: prepared.plan.totalAtomic,
      onchainAtomic: prepared.plan.onchainAtomic,
      offchainChangeAtomic: prepared.plan.offchainChangeAtomic,
      amountDisplay,
      sender: {
        label: senderLabel,
        ledgerAccountHint: senderAgentId,
        balanceBefore,
        balanceAfter: null
      },
      legs: legRecords,
      ...plannedViews
    };

    // This fsynced 0600 record exists before the only call that can broadcast.
    const recordPath = await createDemoRecord(record);
    const before = await Promise.all(legRecords.map((leg) => recipientBalance(leg.stealthAddress)));

    if (!confirm || pool < BigInt(amount)) {
      const reason = pool < BigInt(amount)
        ? `pool holds less than ${amountDisplay}`
        : "preflight only; --confirm was not supplied";
      const dryRunRecord = {
        ...record,
        sender: { ...record.sender, balanceAfter: ledger.balance(senderAgentId, assetKey) },
        legs: record.legs.map((leg) => ({
          ...leg,
          onchain: {
            state: "planned",
            dryRun: true,
            transactionHash: null,
            explorer: null,
            from: poolAddr,
            reason
          }
        }))
      };
      await replaceDemoRecord(recordPath, dryRunRecord);
      console.log(`demo record: ${displayPath(recordPath)} (receiver secrets persisted; owner-only mode requested)`);
      if (pool < BigInt(amount)) console.log(`NOT READY: ${reason}`);
      else console.log(`READY: re-run with --confirm to broadcast a real pool payout.`);
      printTranscript({ record: dryRunRecord, recordPath, symbol });
      return;
    }

    console.log("\nbroadcasting pool payout...");
    const queued = await registry.enqueuePoolPayout(prepared, IP, now);
    if (queued.kind !== "pool-payout" || queued.version !== 2 || queued.status !== "queued") {
      throw new Error("denominations-enabled proof did not return a v2 queue acknowledgement");
    }
    await queue.flushGroup(queued.groupRef);
    const claimLegs = async () => {
      const intentNonce = `0x${randomBytes(32).toString("hex")}`;
      return registry.claimPoolPayout({
        payerAgentId: senderAgentId,
        groupRef: queued.groupRef,
        intentNonce,
        agentSignature: await payerIdentity.signMessage(poolPayoutClaimIntentMessage({
          payerAgentId: senderAgentId,
          groupRef: queued.groupRef,
          intentNonce
        }))
      }, IP);
    };
    // A real chain does not finalize inside the confirm budget — measured 2026-07-31,
    // Base's `finalized` tag trails `latest` by ~1462s against a 120s budget. So the
    // legs land `included` first and only a later reconcile promotes them. Asserting
    // `settled` immediately after flushGroup would fail on every genuine mainnet run
    // while passing against any harness that fakes instant finality, which is exactly
    // the blind spot this whole wave exists to remove. Drive the reconcile explicitly.
    let claim = await claimLegs();
    const settleDeadline = Date.now() + POOL_PAYOUT_SETTLE_TIMEOUT_MS;
    while (Date.now() < settleDeadline
      && claim.legs.some((leg) => leg.state !== "settled")) {
      const pending = claim.legs.filter((leg) => leg.state !== "settled").length;
      console.log(
        `  awaiting finality: ${pending}/${claim.legs.length} leg(s) still in flight`
        + ` (${Math.round((settleDeadline - Date.now()) / 1000)}s of budget left)`,
      );
      await new Promise((resolve) => setTimeout(resolve, POOL_PAYOUT_SETTLE_POLL_MS));
      await queue.sweep(rail.network);
      claim = await claimLegs();
    }
    if (claim.legs.length !== record.legs.length
      || claim.legs.some((leg) => leg.state !== "settled" || !leg.transactionHash)) {
      const states = claim.legs.map((leg) => `${leg.index}:${leg.state}`).join(" ");
      throw new Error(
        `not every payout leg settled with a transaction hash within`
        + ` ${POOL_PAYOUT_SETTLE_TIMEOUT_MS}ms (${states}).`
        + " Legs stuck at `broadcasting`/`included` mined but have not finalized;"
        + " raise PX402_POOL_PAYOUT_LIVE_SETTLE_TIMEOUT_MS above the chain's"
        + " finality lag (npm run preflight:finality reports it).",
      );
    }
    const claimedByIndex = new Map(claim.legs.map((leg) => [leg.index, leg]));
    const settledLegs = record.legs.map((leg) => {
      const claimed = claimedByIndex.get(leg.index);
      if (!claimed?.transactionHash) throw new Error(`payout leg ${leg.index} has no transaction hash`);
      return {
        ...leg,
        onchain: {
          state: "settled",
          transactionHash: claimed.transactionHash,
          explorer: explorer(claimed.transactionHash),
          from: poolAddr
        }
      };
    });
    const settledAt = new Date(Math.max(
      ...claim.legs.map((leg) => leg.terminalAt ?? Date.now())
    )).toISOString();
    const finalViews = buildViews({
      legs: settledLegs,
      poolAddress: poolAddr,
      timestamp: settledAt,
      dryRun: false,
      symbol
    });
    const settledRecord = {
      ...record,
      sender: { ...record.sender, balanceAfter: queued.payerBalanceAtomic },
      legs: settledLegs,
      ...finalViews
    };
    await replaceDemoRecord(recordPath, settledRecord);

    const after = await Promise.all(record.legs.map((leg) => recipientBalance(leg.stealthAddress)));
    const delta = after.reduce((sum, value, index) => sum + value - before[index], 0n);
    const ledgerOk = BigInt(queued.payerBalanceAtomic) === BigInt(bootstrap) - BigInt(amount);
    const chainOk = delta === BigInt(amount);
    console.log(`demo record: ${displayPath(recordPath)} (receiver secrets persisted; owner-only mode requested)`);
    record.legs.forEach((leg, index) => {
      console.log(
        `leg ${leg.index} balance: ${formatUnits(before[index], 6)} -> ${formatUnits(after[index], 6)} ${symbol}`
      );
    });
    console.log((ledgerOk && chainOk)
      ? "PASS: pool paid the stealth recipient on-chain and the sender ledger balance was debited."
      : `FAIL: ledgerOk=${ledgerOk} chainOk=${chainOk}`);
    process.exitCode = ledgerOk && chainOk ? 0 : 1;
    printTranscript({ record: settledRecord, recordPath, symbol });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error("pool payout live error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
