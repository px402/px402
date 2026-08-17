// Signs a private-ledger deposit intent / confirm body with an agent identity
// key and prints it as JSON.
//
// It deliberately does NOT post. The private RPC authenticates the caller by
// WireGuard peer IP, so the request has to originate from inside the agent's
// namespace on the VPS. Signing needs no network, so we sign here and POST
// there:
//
//   npm run ledger:sign-intent -- intent  <fromAddress> <amountAtomic> [network]
//   npm run ledger:sign-intent -- confirm <depositId>   <txHash>       [network]
//
//   ssh <vps> 'sudo ip netns exec cr-sender curl -s -X POST \
//     -H "content-type: application/json" -d "<body>" \
//     http://10.77.0.1:3099/private/a2a/deposit-intent'
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { randomNonce, resolveX402Network } from "../src/shared/x402.ts";
import { privateLedgerDepositConfirmMessage, privateLedgerDepositIntentMessage } from "../src/shared/x402AgentIntent.ts";

const readEnv = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].trim()])
  );

const env = readEnv(".env.x402-proof.local");
const agentId = process.env.LEDGER_AGENT_ID ?? env.PROOF_PAYER_AGENT_ID ?? "proof-payer";
const identityKey = process.env.LEDGER_IDENTITY_KEY ?? env.PROOF_PAYER_IDENTITY_KEY;
if (!identityKey) throw new Error("PROOF_PAYER_IDENTITY_KEY is required in .env.x402-proof.local");

const [action, first, second, networkArg] = process.argv.slice(2);
const network = resolveX402Network(networkArg ?? "base").network;
const wallet = new Wallet(identityKey);

let body;
if (action === "intent") {
  if (!first || !second) throw new Error("usage: intent <fromAddress> <amountAtomic> [network]");
  if (BigInt(second) <= 0n) throw new Error("amountAtomic must be positive");
  const intentNonce = randomNonce();
  const agentSignature = await wallet.signMessage(
    privateLedgerDepositIntentMessage({ agentId, fromAddress: first, amountAtomic: second, network, intentNonce })
  );
  body = { agentId, fromAddress: first, amountAtomic: second, network, intentNonce, agentSignature };
} else if (action === "confirm") {
  if (!first || !second) throw new Error("usage: confirm <depositId> <transactionHash> [network]");
  const agentSignature = await wallet.signMessage(
    privateLedgerDepositConfirmMessage({ agentId, depositId: first, transactionHash: second, network })
  );
  body = { agentId, depositId: first, transactionHash: second, network, agentSignature };
} else {
  throw new Error(`unknown action ${action ?? "(none)"} (use intent | confirm)`);
}

// signer identity is printed to stderr so stdout stays a clean pipeable body
console.error(`signing as ${agentId} identity=${wallet.address} network=${network}`);
console.log(JSON.stringify(body));
