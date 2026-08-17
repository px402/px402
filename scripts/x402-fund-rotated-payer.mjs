// Funds the first disposable rotated payer from the existing test wallet using
// a real EIP-3009 USDC authorization. Guarded: --confirm is required.
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { buildPaymentRequirements, createPaymentPayload, usdcAtomic, BASE_USDC } from "../src/shared/x402.ts";
import { derivePayerWallet } from "../src/shared/payerRotation.ts";
import { X402Facilitator } from "../src/server/base/X402Facilitator.ts";

console.warn(`!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.`);

const readEnv = (path) => Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]));
const test = readEnv(".env.x402.local");
const proof = readEnv(".env.x402-proof.local");
for (const key of ["PX402_BASE_X402_SETTLER_KEY", "X402_PAYER_KEY"]) if (!test[key]) throw new Error(`${key} is required in .env.x402.local`);
for (const key of ["PROOF_PAYER_ROTATION_MNEMONIC", "PROOF_PAYER_ROTATION_INDEX"]) if (!proof[key]) throw new Error(`${key} is required in .env.x402-proof.local`);

const amountUsdc = Number(process.env.PROOF_FUND_AMOUNT_USDC ?? "0.25");
const amountAtomic = usdcAtomic(amountUsdc);
const rpcUrl = test.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";
const provider = new JsonRpcProvider(rpcUrl, 8453);
const funder = new Wallet(test.X402_PAYER_KEY);
const settler = new Wallet(test.PX402_BASE_X402_SETTLER_KEY);
const target = derivePayerWallet(proof.PROOF_PAYER_ROTATION_MNEMONIC, Number(proof.PROOF_PAYER_ROTATION_INDEX));
const usdc = new Contract(BASE_USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);
const [funderUsdc, targetUsdc, settlerEth] = await Promise.all([usdc.balanceOf(funder.address), usdc.balanceOf(target.address), provider.getBalance(settler.address)]);

console.log("=== disposable rotated-payer funding preflight ===");
console.log(`SETTLER ${settler.address} ETH=${formatEther(settlerEth)}`);
console.log(`FUNDER  ${funder.address} USDC=${formatUnits(funderUsdc, 6)}`);
console.log(`TARGET  ${target.address} USDC=${formatUnits(targetUsdc, 6)}`);
console.log(`AMOUNT  ${amountUsdc} USDC`);
if (funderUsdc < BigInt(amountAtomic)) throw new Error("Test funder has insufficient USDC");
if (settlerEth === 0n) throw new Error("Settler has no ETH for Base gas");
if (!process.argv.includes("--confirm")) {
  console.log("READY. Re-run with --confirm to fund the disposable rotated payer.");
  process.exit(0);
}

const nowSeconds = (await provider.getBlock("latest")).timestamp;
const requirements = buildPaymentRequirements({ payTo: target.address, maxAmountRequired: amountAtomic, resource: "x402-wireguard-proof-funding", nowSeconds });
const payment = await createPaymentPayload({ payerPrivateKey: test.X402_PAYER_KEY, requirements, nowSeconds });
const facilitator = new X402Facilitator({ rpcUrl, settlerPrivateKey: test.PX402_BASE_X402_SETTLER_KEY, token: BASE_USDC });
const settlement = await facilitator.verifyAndSettle(payment, requirements, nowSeconds);
if (!settlement.transactionHash) throw new Error("Funding did not enter on-chain settlement mode");
console.log(`FUNDING_TX ${settlement.transactionHash}`);
console.log(`BASESCAN https://basescan.org/tx/${settlement.transactionHash}`);
await provider.waitForTransaction(settlement.transactionHash, 1, 120_000);
const after = await usdc.balanceOf(target.address);
if (after - targetUsdc !== BigInt(amountAtomic)) throw new Error("Funding transaction confirmed without the expected USDC balance change");
console.log(`PASS funded ${target.address} with ${amountUsdc} USDC`);
