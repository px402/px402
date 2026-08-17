import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, isAddress } from "ethers";

console.warn(`!!! SETTLER-KEY EXCLUSION: do NOT run while the PX-402 server is live. This
!!! script signs from the shared settler/treasury EOA; concurrent sends corrupt the
!!! pool-payout nonce pipeline. Stop the server (or its agent RPC) first.`);

const deployNetwork = process.env.PX402_DEPLOY_NETWORK ?? "base";
if (deployNetwork !== "base" && deployNetwork !== "robinhood") {
  throw new Error(`Unsupported PX402_DEPLOY_NETWORK: ${deployNetwork}`);
}
const robinhood = deployNetwork === "robinhood";
const rpcUrl = robinhood
  ? process.env.PX402_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
  : process.env.PX402_BASE_RPC_URL ?? "https://mainnet.base.org";
const expectedChainId = robinhood ? 4663n : 8453n;
const privateKey = process.env.PX402_DEPLOYER_PRIVATE_KEY
  ?? (robinhood ? process.env.PX402_RH_X402_SETTLER_KEY : undefined)
  ?? process.env.PX402_BASE_X402_SETTLER_KEY;
const operator = process.env.PX402_PRIVATE_BATCH_OPERATOR;
if (!privateKey) throw new Error("A deployer or network settler private key is required");
if (operator && !isAddress(operator)) throw new Error("PX402_PRIVATE_BATCH_OPERATOR must be an EVM address");
const artifact = JSON.parse(await readFile(resolve("build", "contracts", "PX402BatchCommitment.json"), "utf8"));
const provider = new JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (network.chainId !== expectedChainId) throw new Error(`Refusing batch-contract deployment on chain ${network.chainId}`);
const wallet = new Wallet(privateKey, provider);
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const deployment = await factory.getDeployTransaction(operator ?? wallet.address);
const gas = await provider.estimateGas({ ...deployment, from: wallet.address });
const fee = await provider.getFeeData();
const balance = await provider.getBalance(wallet.address);
const estimatedCost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
console.log(`DEPLOYER ${wallet.address}`);
console.log(`CHAIN ${network.chainId}`);
console.log(`BALANCE_ETH ${formatEther(balance)}`);
console.log(`ESTIMATED_MAX_COST_ETH ${formatEther(estimatedCost)}`);
if (balance < estimatedCost) throw new Error("Batch-contract deployer has insufficient native gas token");
if (process.argv.includes("--check")) process.exit(0);
const contract = await factory.deploy(operator ?? wallet.address);
console.log(`DEPLOY_TX ${contract.deploymentTransaction()?.hash}`);
await contract.waitForDeployment();
console.log(`PX402_BATCH_COMMITMENT_CONTRACT ${await contract.getAddress()}`);
