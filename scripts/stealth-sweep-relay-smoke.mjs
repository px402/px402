// Phase 2 of spec-stealth-inbox: the receiver-signed gasless sweep relay.
//
// A stealth output holds tokens and zero native gas. Funding it with gas
// publishes a `pool -> stealthAddr` edge and destroys the recipient
// unlinkability the one-time address exists to provide. Instead the payee signs
// an EIP-3009 authorization and the settler broadcasts it, so the only public
// edge is `stealthAddr -> depositAddr` -- the same shape as every other deposit.
//
// The settler pays that gas, so the relay must never be usable as a general
// "broadcast anything" oracle. These tests are mostly about that.
//
//   npm run test:stealth:sweep-relay
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction, Wallet, getAddress } from "ethers";
import { BASE_USDC, createPaymentPayload, randomNonce } from "../src/shared/x402.ts";
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
import { DepositAddressBook } from "../src/server/payments/DepositAddressBook.ts";
import { InboundAnnouncementBook } from "../src/server/payments/InboundAnnouncementBook.ts";
import { PrivateAgentRegistry } from "../src/server/agents/PrivateAgentRegistry.ts";

const root = await mkdtemp(join(tmpdir(), "sweep-relay-smoke-"));
const KEY = randomBytes(32).toString("hex");
const TREASURY = Wallet.createRandom().address;
const PAYEE_IP = "10.77.2.10";
const INTRUDER_IP = "10.77.1.10";
const AMOUNT = "200000";

const tests = [];
let passed = 0;
let failed = 0;
let seq = 0;

const test = (name, run) => tests.push({ name, run });
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};
const rejects = async (operation, pattern) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `expected /${pattern.source}/, got: ${message}`);
    return message;
  }
  throw new Error("expected rejection but the call resolved");
};

const now = () => Math.floor(Date.now() / 1000);

// A payee whose stealth output we are sweeping. The one-time key is derived the
// real way -- meta-address -> announcement -> spending key -- so the relay is
// fed exactly what a real receiver would produce.
const stealthOutput = () => {
  const keys = generateStealthKeys();
  const derived = deriveStealthAddress(keys.meta);
  const privateKey = computeStealthPrivateKey({
    ephemeralPubKey: derived.ephemeralPubKey,
    viewingKey: keys.viewingKey,
    spendingKey: keys.spendingKey,
  });
  return { ...derived, privateKey };
};

const IDENTITY = Wallet.createRandom();
const OTHER_IDENTITY = Wallet.createRandom();

const harness = async ({ settlerPrivateKey, sweepRelayEnabled = true, coordinator } = {}) => {
  seq += 1;
  const deposits = await new DepositAddressBook(join(root, `dep-${seq}.json`), {
    retentionMs: 900_000,
    encryptionKey: KEY,
  }).load();
  const inbox = await new InboundAnnouncementBook(join(root, `inbox-${seq}.json`), {
    retentionMs: 900_000,
    dormantMs: 86_400_000,
    encryptionKey: KEY,
  }).load();
  const facilitator = new X402Facilitator({
    // unreachable on purpose: the dry-run path must never touch the network
    rpcUrl: "http://127.0.0.1:1",
    token: BASE_USDC,
    settlerPrivateKey,
    coordinator,
  });
  const rail = new EvmChainRail({ facilitator, treasury: TREASURY });
  const ledger = {
    accountReference: (agentId) => `acct_${Buffer.from(agentId.padEnd(32, "0")).toString("hex").slice(0, 64)}`,
    creditDeposit: async () => ({ commitment: "0xcommit", payerBalanceAtomic: AMOUNT, acceptedAt: Date.now() }),
  };
  const registry = new PrivateAgentRegistry([
    {
      agentId: "payee",
      label: "payee",
      vpnIp: PAYEE_IP,
      walletAddress: Wallet.createRandom().address,
      identityAddress: IDENTITY.address,
      sharedSecret: "s".repeat(32),
      credits: 0,
      inventory: [],
    },
    {
      agentId: "intruder",
      label: "intruder",
      vpnIp: INTRUDER_IP,
      walletAddress: Wallet.createRandom().address,
      identityAddress: OTHER_IDENTITY.address,
      sharedSecret: "t".repeat(32),
      credits: 0,
      inventory: [],
    },
  ], {
    privateLedger: ledger,
    rails: new Map([["base", rail]]),
    depositAddressBook: deposits,
    inboundAnnouncements: inbox,
    sweepRelayEnabled,
  });
  const depositConfigs = new Map([["base", {
    recipient: TREASURY,
    asset: BASE_USDC.address.toLowerCase(),
    verifyTransfer: async () => ({ transactionHash: "0x", amountAtomic: AMOUNT, transferIndex: 0 }),
  }]]);
  return { registry, deposits, inbox, rail, facilitator, depositConfigs };
};

/** Durable deposit record: a one-time deposit address awaiting `output`'s sweep. */
const seedIntent = async (deposits, output, overrides = {}) => {
  const intentId = `deposit-intent-${randomBytes(8).toString("hex")}`;
  await deposits.add({
    intentId,
    accountId: deposits.accountId("payee"),
    network: "base",
    caip2: BASE_USDC.caip2,
    tokenAddress: BASE_USDC.address.toLowerCase(),
    keyVersion: "v1",
    derivationIndex: 0,
    stealthAddress: Wallet.createRandom().address, // the deposit address
    ephemeralPubKey: `0x${randomBytes(33).toString("hex")}`,
    fromAddress: output.stealthAddress, // the payout leg being swept
    expectedAmountAtomic: AMOUNT,
    creditValidBefore: now() + 900,
    ...overrides,
  });
  return { intentId, record: deposits.byIntentId(intentId) };
};

const signedRelay = async ({ depositId, payload, signer = IDENTITY, agentId = "payee" }) => ({
  agentId,
  depositId,
  network: "base",
  payment: payload,
  agentSignature: await signer.signMessage(depositRelayIntentMessage({
    agentId,
    depositId,
    network: "base",
    authorizationNonce: payload.authorization.nonce,
  })),
});

const authorization = async ({ output, record, value = AMOUNT, to, validForSeconds = 600 }) =>
  createPaymentPayload({
    payerPrivateKey: output.privateKey,
    requirements: {
      scheme: "exact",
      network: BASE_USDC.network,
      asset: BASE_USDC.address,
      payTo: to ?? record.stealthAddress,
      maxAmountRequired: value,
      resource: "sweep",
      nonce: randomNonce(),
      validForSeconds,
    },
    token: BASE_USDC,
    nowSeconds: now(),
  });

// ------------------------------------------------- happy path + lifecycle

test("a payee-signed authorization relays and reserves the announcement", async () => {
  const { registry, deposits, inbox, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  await inbox.addMany([{
    accountId: "acct_" + "a".repeat(64),
    network: "base",
    caip2: BASE_USDC.caip2,
    tokenAddress: BASE_USDC.address.toLowerCase(),
    stealthAddress: output.stealthAddress,
    ephemeralPubKey: output.ephemeralPubKey,
    expectedAmountAtomic: AMOUNT,
    source: "pool-payout",
    sourceRef: "group-1:0",
  }]);

  const payload = await authorization({ output, record });
  const result = await registry.relayPrivateLedgerDeposit(
    await signedRelay({ depositId: intentId, payload }),
    PAYEE_IP,
    depositConfigs,
    now(),
  );
  assert(result.status === "relayed");
  assert(result.mode === "dry-run", `expected dry-run without a settler key, got ${result.mode}`);
  const entry = inbox.byStealthAddress("base", output.stealthAddress);
  assert(entry.status === "sweeping", `expected sweeping, got ${entry.status}`);
  assert(entry.sweepIntentId === intentId);
  await deposits.close();
  await inbox.close();
});

test("the settler signs and pays gas; the stealth output never sends a transaction", async () => {
  const settler = Wallet.createRandom();
  const { deposits, facilitator } = await harness({ settlerPrivateKey: settler.privateKey });
  const output = stealthOutput();
  const { record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });

  // This is the transaction the relay would broadcast. Its sender is what
  // decides whether the stealth address needs native gas.
  const built = await facilitator.buildTransferWithAuthorization({
    payload,
    nonce: 0,
    maxFeePerGas: "1000000000",
    maxPriorityFeePerGas: "1000000",
  });
  const tx = Transaction.from(built.signedTx);
  assert(
    getAddress(tx.from) === getAddress(settler.address),
    `gas is paid by ${tx.from}, expected the settler ${settler.address}`,
  );
  assert(getAddress(tx.to) === getAddress(BASE_USDC.address), "relay must call the token contract");
  // the holder only ever produced a signature, never a transaction
  assert(getAddress(payload.authorization.from) === getAddress(output.stealthAddress));
  assert(
    getAddress(tx.from) !== getAddress(output.stealthAddress),
    "the stealth address is the tx sender, so it would need native gas -- the leak this exists to avoid",
  );
  await deposits.close();
});

test("confirming a deposit sent from a stealth output retires its announcement", async () => {
  const { registry, deposits, inbox, depositConfigs } = await harness();
  const output = stealthOutput();
  const [entry] = await inbox.addMany([{
    accountId: "acct_" + "b".repeat(64),
    network: "base",
    caip2: BASE_USDC.caip2,
    tokenAddress: BASE_USDC.address.toLowerCase(),
    stealthAddress: output.stealthAddress,
    ephemeralPubKey: output.ephemeralPubKey,
    expectedAmountAtomic: AMOUNT,
    source: "pool-payout",
    sourceRef: "group-2:0",
  }]);
  await inbox.observe(entry.id, 200_000n);

  // real deposit intent + confirm, driven through the public registry path
  const intentNonce = randomBytes(16).toString("hex");
  const intentFields = {
    agentId: "payee",
    fromAddress: output.stealthAddress,
    amountAtomic: AMOUNT,
    network: "base",
    intentNonce,
  };
  const intent = await registry.createPrivateLedgerDepositIntent(
    {
      ...intentFields,
      agentSignature: await IDENTITY.signMessage(privateLedgerDepositIntentMessage(intentFields)),
    },
    PAYEE_IP,
    { recipient: TREASURY, asset: BASE_USDC.address.toLowerCase() },
    now(),
  );

  const transactionHash = `0x${"ab".repeat(32)}`;
  const confirmFields = {
    agentId: "payee",
    depositId: intent.depositId,
    transactionHash,
    network: "base",
  };
  const confirmed = await registry.confirmPrivateLedgerDeposit(
    {
      ...confirmFields,
      agentSignature: await IDENTITY.signMessage(privateLedgerDepositConfirmMessage(confirmFields)),
    },
    PAYEE_IP,
    depositConfigs,
  );

  assert(confirmed.status === "credited", `expected credited, got ${confirmed.status}`);
  const after = inbox.byStealthAddress("base", output.stealthAddress);
  assert(after.status === "swept", `expected swept, got ${after.status}`);
  assert(after.observedAmountAtomic === "0", "a swept output must not still report a balance");
  assert(after.sweepTxHash === transactionHash);
  await deposits.close();
  await inbox.close();
});

// ------------------------------------------------------- the 7 binding rules

test("rule 1a: an unknown deposit intent is rejected", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });
  const body = await signedRelay({ depositId: "deposit-intent-nope", payload });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(body, PAYEE_IP, depositConfigs, now()),
    /intent unavailable or expired/,
  );
  await deposits.close();
});

test("rule 1b: another agent's deposit intent is rejected", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output, {
    accountId: deposits.accountId("intruder"),
  });
  const payload = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /agent mismatch/,
  );
  await deposits.close();
});

test("rule 1c: an already-paid intent cannot be relayed again", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  await deposits.transition(record.id, "awaiting-payment", (current) => {
    current.status = "proof-verified";
    current.proofId = "base:0xabc:0";
    current.proofTxHash = "0xabc";
    current.proofTransferIndex = 0;
    current.observedAmountAtomic = AMOUNT;
    current.proofVerifiedAt = Date.now();
  });
  const payload = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /requires an unpaid deposit intent/,
  );
  await deposits.close();
});

test("rule 2: an authorization paying somewhere else is rejected", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const attacker = Wallet.createRandom().address;
  const payload = await authorization({ output, record, to: attacker });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /recipient does not match the deposit intent/,
  );
  await deposits.close();
});

test("rule 3: an authorization from a different holder is rejected", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const other = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  // validly signed, but by someone who is not the bound depositor
  const payload = await authorization({ output: other, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /sender does not match the deposit intent/,
  );
  await deposits.close();
});

test("rule 4: a value other than the intent's amount is rejected (both directions)", async () => {
  for (const value of ["199999", "400000"]) {
    const { registry, deposits, depositConfigs } = await harness();
    const output = stealthOutput();
    const { intentId, record } = await seedIntent(deposits, output);
    const payload = await authorization({ output, record, value });
    await rejects(
      async () => registry.relayPrivateLedgerDeposit(
        await signedRelay({ depositId: intentId, payload }),
        PAYEE_IP, depositConfigs, now(),
      ),
      /value does not match the deposit intent/,
    );
    await deposits.close();
  }
});

test("rule 5: an authorization outliving the intent is rejected", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record, validForSeconds: 86_400 });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /outlives the deposit intent/,
  );
  await deposits.close();
});

test("rule 6: the relay slot is one-shot", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const first = await authorization({ output, record });
  await registry.relayPrivateLedgerDeposit(
    await signedRelay({ depositId: intentId, payload: first }),
    PAYEE_IP, depositConfigs, now(),
  );
  // a DIFFERENT valid authorization for the same intent must not buy a second
  // broadcast on the settler's gas
  const second = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload: second }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /Replayed agent intent nonce/,
  );
  await deposits.close();
});

test("rule 7a: a wrong VPN peer cannot relay", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });
  const body = await signedRelay({ depositId: intentId, payload });
  for (const peer of [INTRUDER_IP, "10.77.9.9"]) {
    await rejects(
      async () => registry.relayPrivateLedgerDeposit(body, peer, depositConfigs, now()),
      /VPN peer mismatch/,
    );
  }
  await deposits.close();
});

test("rule 7b: a wrong or missing identity signature cannot relay", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload, signer: OTHER_IDENTITY }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /signer does not match registered identity/,
  );
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      { agentId: "payee", depositId: intentId, network: "base", payment: payload, agentSignature: "" },
      PAYEE_IP, depositConfigs, now(),
    ),
    /signature required/,
  );
  await deposits.close();
});

test("a signature for one payload cannot relay a different payload", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const approved = await authorization({ output, record });
  const swapped = await authorization({ output, record });
  const body = await signedRelay({ depositId: intentId, payload: approved });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      { ...body, payment: swapped },
      PAYEE_IP, depositConfigs, now(),
    ),
    /signer does not match registered identity/,
  );
  await deposits.close();
});

// ------------------------------------------------------------- guardrails

test("the relay is refused entirely when the flag is off", async () => {
  const { registry, deposits, depositConfigs } = await harness({ sweepRelayEnabled: false });
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /not enabled/,
  );
  await deposits.close();
});

test("on-chain mode refuses to broadcast without the transaction outbox", async () => {
  // A settler-EOA send that bypasses the coordinator corrupts the shared nonce
  // pipeline and breaks pool-payout recovery, so this must be a hard error --
  // and must be raised before any network I/O.
  const settler = Wallet.createRandom();
  const { registry, deposits, depositConfigs } = await harness({
    settlerPrivateKey: settler.privateKey,
  });
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /requires the shared transaction coordinator/,
  );
  await deposits.close();
});

test("a failed relay releases the sweep reservation", async () => {
  const settler = Wallet.createRandom();
  const { registry, deposits, inbox, depositConfigs } = await harness({
    settlerPrivateKey: settler.privateKey, // on-chain, no coordinator -> throws
  });
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const [entry] = await inbox.addMany([{
    accountId: "acct_" + "c".repeat(64),
    network: "base",
    caip2: BASE_USDC.caip2,
    tokenAddress: BASE_USDC.address.toLowerCase(),
    stealthAddress: output.stealthAddress,
    ephemeralPubKey: output.ephemeralPubKey,
    expectedAmountAtomic: AMOUNT,
    source: "pool-payout",
    sourceRef: "group-3:0",
  }]);
  await inbox.observe(entry.id, 200_000n);
  const payload = await authorization({ output, record });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      await signedRelay({ depositId: intentId, payload }),
      PAYEE_IP, depositConfigs, now(),
    ),
    /coordinator/,
  );
  const after = inbox.byStealthAddress("base", output.stealthAddress);
  assert(after.status === "observed", `stuck in ${after.status}; the output could never be swept again`);
  await deposits.close();
  await inbox.close();
});

test("an unsupported network is refused (Solana relay is phase 3)", async () => {
  const { registry, deposits, depositConfigs } = await harness();
  const output = stealthOutput();
  const { intentId, record } = await seedIntent(deposits, output);
  const payload = await authorization({ output, record });
  const body = await signedRelay({ depositId: intentId, payload });
  await rejects(
    async () => registry.relayPrivateLedgerDeposit(
      { ...body, network: "solana", agentSignature: await IDENTITY.signMessage(
        depositRelayIntentMessage({
          agentId: "payee",
          depositId: intentId,
          network: "solana",
          authorizationNonce: payload.authorization.nonce,
        }),
      ) },
      PAYEE_IP, depositConfigs, now(),
    ),
    /not supported on network solana/,
  );
  await deposits.close();
});

// ------------------------------------------------------------------ run

for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

await rm(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
