// Sweep the full token balance from a persisted pool-payout demo receiver.
// Guarded: --confirm is required for gas funding or token broadcasts.
//
//   npm run x402:stealth-sweep -- --record data/pool-payout-demos/rh-....json --to 0x...
//   npm run x402:stealth-sweep -- --record data/pool-payout-demos/solana-....json --to ...
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  getAddress
} from "ethers";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  publicKeyForSolanaScalar,
  sweepStealth
} from "../src/shared/stealthSolana.ts";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 value) returns (bool)"
];
const GAS_HEADROOM_PERCENT = 20n;

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const confirm = process.argv.includes("--confirm");

const requiredArg = (name) => {
  const value = arg(name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
};

const loadEnv = (file) => {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
};

const requiredString = (value, path) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`demo record is missing ${path}`);
  }
  return value;
};

const loadRecord = (path) => {
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error("demo record permissions are too broad; expected mode 0600");
  }
  const record = JSON.parse(readFileSync(path, "utf8"));
  requiredString(record.network, "network");
  requiredString(record.asset, "asset");
  return record;
};

const addHeadroom = (value) =>
  (value * (100n + GAS_HEADROOM_PERCENT) + 99n) / 100n;

const decodeBase58 = (value) => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Solana settler secret is not valid base58");
    numeric = numeric * 58n + BigInt(digit);
  }
  const decoded = [];
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

const printHeading = (record, recordPath, destination) => {
  console.log("=== stealth demo sweep preflight ===");
  console.log(`record: ${recordPath}`);
  console.log(`network: ${record.network}`);
  console.log(`asset: ${record.asset}`);
  console.log(`from stealth: ${record.receiver.stealthAddress}`);
  console.log(`to: ${destination}`);
};

const runEvm = async ({ record, recordPath, destination }) => {
  const network = record.network.toLowerCase();
  const env = loadEnv(".env.x402.local");
  const settlerKey = env.PX402_BASE_X402_SETTLER_KEY;
  if (!settlerKey) {
    throw new Error("PX402_BASE_X402_SETTLER_KEY is required in .env.x402.local");
  }
  const isRobinhood = network === "rh" || network === "robinhood";
  const rpc = isRobinhood
    ? env.PX402_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
    : env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";
  const chainId = isRobinhood ? 4663 : 8453;
  const explorer = isRobinhood
    ? (transactionHash) => `https://robinhoodchain.blockscout.com/tx/${transactionHash}`
    : (transactionHash) => `https://basescan.org/tx/${transactionHash}`;
  const provider = new JsonRpcProvider(rpc, chainId);
  const settler = new Wallet(settlerKey, provider);
  const stealthWallet = new Wallet(record.receiver.stealthPrivateKey, provider);
  const stealthAddress = getAddress(record.receiver.stealthAddress);
  const to = getAddress(destination);
  if (stealthWallet.address !== stealthAddress) {
    throw new Error("persisted EVM stealth private key does not control the recorded address");
  }
  if (record.onchain?.from && getAddress(record.onchain.from) !== settler.address) {
    throw new Error("configured settler does not match the pool address in the demo record");
  }

  const token = new Contract(record.asset, ERC20_ABI, provider);
  const balance = BigInt(await token.balanceOf(stealthAddress));
  printHeading(record, recordPath, to);
  console.log(`token balance: ${formatUnits(balance, 6)}`);
  console.log("LINKABILITY CAVEAT: settler gas-funding links the pool to the stealth address; acceptable for this demo sweep.");
  if (balance === 0n) {
    console.log("NO BALANCE: nothing to sweep; this is expected for a payout dry-run record.");
    return;
  }

  const transferInterface = new Interface(ERC20_ABI);
  const transferData = transferInterface.encodeFunctionData("transfer", [to, balance]);
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({
      from: stealthAddress,
      to: record.asset,
      data: transferData
    });
  } catch (error) {
    await provider.call({ from: stealthAddress, to: record.asset, data: transferData });
    gasEstimate = 100_000n;
    console.log(`gas estimate fallback: ${gasEstimate} units (${error instanceof Error ? error.message.split("\n")[0] : "RPC estimate unavailable"})`);
  }
  const gasLimit = addHeadroom(gasEstimate);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (gasPrice === null) throw new Error("RPC did not return a gas price");
  const feeOverrides = feeData.maxFeePerGas !== null
    ? {
        maxFeePerGas: feeData.maxFeePerGas,
        ...(feeData.maxPriorityFeePerGas !== null
          ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
          : {})
      }
    : { gasPrice };
  const requiredNative = gasLimit * gasPrice;
  const currentNative = await provider.getBalance(stealthAddress);
  const gasTopUp = requiredNative > currentNative ? requiredNative - currentNative : 0n;

  console.log(`gas limit with ${GAS_HEADROOM_PERCENT}% headroom: ${gasLimit}`);
  console.log(`current native gas balance: ${formatEther(currentNative)}`);
  console.log(`settler gas top-up: ${formatEther(gasTopUp)}`);
  console.log(`${confirm ? "WILL" : "WOULD"} transfer the full ${formatUnits(balance, 6)} token balance to ${to}.`);

  if (!confirm) {
    console.log("DRY RUN: no gas or token transaction was broadcast. Add --confirm to sweep.");
    return;
  }

  if (gasTopUp > 0n) {
    const fundingTransaction = await settler.sendTransaction({ to: stealthAddress, value: gasTopUp });
    const fundingReceipt = await fundingTransaction.wait();
    if (!fundingReceipt || fundingReceipt.status !== 1) throw new Error("stealth gas funding was not confirmed");
    console.log(`gas funding tx: ${fundingTransaction.hash}`);
    console.log(`gas funding explorer: ${explorer(fundingTransaction.hash)}`);
  }

  const tokenFromStealth = new Contract(record.asset, ERC20_ABI, stealthWallet);
  const sweepTransaction = await tokenFromStealth.transfer(to, balance, {
    gasLimit,
    ...feeOverrides
  });
  const sweepReceipt = await sweepTransaction.wait();
  if (!sweepReceipt || sweepReceipt.status !== 1) throw new Error("EVM stealth sweep was not confirmed");
  const remaining = BigInt(await token.balanceOf(stealthAddress));
  if (remaining !== 0n) throw new Error(`EVM stealth sweep left ${remaining} token units behind`);
  console.log(`sweep tx: ${sweepTransaction.hash}`);
  console.log(`sweep explorer: ${explorer(sweepTransaction.hash)}`);
  console.log("PASS: the full stealth token balance was swept.");
};

const runSolana = async ({ record, recordPath, destination }) => {
  const env = loadEnv(".env.x402-solana.local");
  const settlerSecret = env.X402_SOLANA_SECRET_BASE58;
  if (!settlerSecret) {
    throw new Error("X402_SOLANA_SECRET_BASE58 is required in .env.x402-solana.local");
  }
  const rpc = process.env.PX402_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const settler = Keypair.fromSecretKey(decodeBase58(settlerSecret));
  if (env.X402_SOLANA_ADDRESS && settler.publicKey.toBase58() !== env.X402_SOLANA_ADDRESS) {
    throw new Error("Solana settler secret does not match X402_SOLANA_ADDRESS");
  }
  if (record.onchain?.from && settler.publicKey.toBase58() !== record.onchain.from) {
    throw new Error("configured Solana settler does not match the pool address in the demo record");
  }

  const stealthAddress = publicKeyForSolanaScalar(record.receiver.stealthPrivateKey);
  if (stealthAddress.toBase58() !== record.receiver.stealthAddress) {
    throw new Error("persisted Solana stealth scalar does not control the recorded address");
  }
  if (record.receiver.stealthPublicKey
      && record.receiver.stealthPublicKey !== stealthAddress.toBase58()) {
    throw new Error("recorded Solana stealth public key does not match the recovered scalar");
  }
  const mint = new PublicKey(record.asset);
  const destinationOwner = new PublicKey(destination);
  const sourceAta = getAssociatedTokenAddressSync(mint, stealthAddress);
  const destinationAta = getAssociatedTokenAddressSync(mint, destinationOwner);
  let balance = 0n;
  try {
    balance = BigInt((await connection.getTokenAccountBalance(sourceAta)).value.amount);
  } catch {
    balance = 0n;
  }

  printHeading(record, recordPath, destinationOwner.toBase58());
  console.log(`stealth token account: ${sourceAta.toBase58()}`);
  console.log(`destination token account: ${destinationAta.toBase58()} (created idempotently if missing)`);
  console.log(`token balance: ${formatUnits(balance, 6)}`);
  console.log("fee payer: configured settler; the stealth address needs no SOL.");
  if (balance === 0n) {
    console.log("NO BALANCE: nothing to sweep; this is expected for a payout dry-run record.");
    return;
  }

  const sweep = await sweepStealth({
    connection,
    mint,
    destinationOwner,
    settlerPubkey: settler.publicKey,
    stealthScalar: record.receiver.stealthPrivateKey,
    decimals: 6,
    amountAtomic: balance
  });
  sweep.transaction.partialSign(settler);
  const simulation = await connection.simulateTransaction(sweep.transaction);
  if (simulation.value.err !== null) {
    throw new Error(`Solana sweep simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  console.log(`${confirm ? "WILL" : "WOULD"} transfer the full ${formatUnits(balance, 6)} token balance.`);
  if (!confirm) {
    console.log("DRY RUN: the fully signed sweep simulated successfully; no transaction was broadcast. Add --confirm to sweep.");
    return;
  }

  const raw = sweep.transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
  const transactionHash = await connection.sendRawTransaction(raw, { skipPreflight: true });
  await connection.confirmTransaction(transactionHash, "confirmed");
  const remaining = BigInt((await connection.getTokenAccountBalance(sourceAta)).value.amount);
  if (remaining !== 0n) throw new Error(`Solana stealth sweep left ${remaining} token units behind`);
  console.log(`sweep tx: ${transactionHash}`);
  console.log(`sweep explorer: https://solscan.io/tx/${transactionHash}`);
  console.log("PASS: the full stealth token balance was swept.");
};

const run = async () => {
  const recordPath = resolve(requiredArg("--record"));
  const destination = requiredArg("--to");
  const record = loadRecord(recordPath);
  const records = Array.isArray(record.legs) && record.legs.length > 0
    ? record.legs.map((leg) => ({
      ...record,
      ...leg,
      legs: undefined,
      receiver: leg.receiver ?? {
        stealthAddress: leg.stealthAddress,
        stealthPrivateKey: leg.stealthPrivateKey,
        stealthPublicKey: leg.stealthPublicKey
      },
      onchain: leg.onchain ?? record.onchain
    }))
    : [record];
  for (const [index, item] of records.entries()) {
    requiredString(item.receiver?.stealthAddress, `legs[${index}].receiver.stealthAddress`);
    requiredString(item.receiver?.stealthPrivateKey, `legs[${index}].receiver.stealthPrivateKey`);
    const network = item.network.toLowerCase();
    if (network === "solana") {
      await runSolana({ record: item, recordPath, destination });
    } else if (network === "base" || network === "rh" || network === "robinhood") {
      await runEvm({ record: item, recordPath, destination });
    } else {
      throw new Error(`unsupported demo record network ${item.network}`);
    }
  }
};

run().catch((error) => {
  console.error("stealth sweep error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
