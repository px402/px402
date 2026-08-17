// Signs a private-ledger quote (payee) or debit authorization (payer) and prints
// it as JSON. Companion to private-ledger-sign-intent.mjs.
//
// Signing needs no network, but the private RPC authenticates by WireGuard peer
// IP, so the body is signed here and POSTed from inside the agent's namespace:
//
//   npm run ledger:sign-x402 -- quote <amountAtomic> [network]
//     -> POST /private/a2a/private-quote  from the PAYEE namespace
//
//   npm run ledger:sign-x402 -- pay '<requirementsJson>'
//     -> POST /private/a2a/private-pay    from the PAYER namespace
//
// The quote is signed by the payee (it is their charge); the debit
// authorization is signed by the payer over the requirements the server issued.
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { randomNonce, resolveX402Network } from "../src/shared/x402.ts";
import { privateLedgerVoucherIntentMessage, x402QuoteIntentMessage } from "../src/shared/x402AgentIntent.ts";
import { preparePoolPayout } from "../src/shared/privateX402Client.ts";

const readEnv = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].trim()])
  );

const env = readEnv(".env.x402-proof.local");
const payerAgentId = env.PROOF_PAYER_AGENT_ID ?? "proof-payer";
const payeeAgentId = env.PROOF_PAYEE_AGENT_ID ?? "proof-payee";
const [action, first, second] = process.argv.slice(2);

let body;
if (action === "quote") {
  if (!first) throw new Error("usage: quote <amountAtomic> [network]");
  if (BigInt(first) <= 0n) throw new Error("amountAtomic must be positive");
  const network = resolveX402Network(second ?? "base").network;
  const wallet = new Wallet(env.PROOF_PAYEE_IDENTITY_KEY);
  const intent = {
    payeeAgentId,
    payerAgentId,
    amountAtomic: first,
    resource: "px402/private-ledger-proof",
    validForSeconds: 600,
    network,
    intentNonce: randomNonce()
  };
  body = { ...intent, agentSignature: await wallet.signMessage(x402QuoteIntentMessage(intent)) };
  console.error(`quote signed by payee ${payeeAgentId} identity=${wallet.address} network=${network}`);
} else if (action === "pay") {
  if (!first) throw new Error("usage: pay '<requirementsJson>'");
  // requirements come back from the server verbatim; re-signing anything else
  // would not match the quote the server stored against this nonce
  const requirements = JSON.parse(first);
  const authorizationNonce = randomNonce();
  const wallet = new Wallet(env.PROOF_PAYER_IDENTITY_KEY);
  const agentSignature = await wallet.signMessage(
    privateLedgerVoucherIntentMessage({ requirements, authorizationNonce })
  );
  body = { requirements, authorizationNonce, agentSignature };
  console.error(`debit authorized by payer ${payerAgentId} identity=${wallet.address}`);
} else if (action === "payout") {
  if (!first) throw new Error("usage: payout '<requirementsJson>'");
  // requirements verbatim from /private/a2a/quote: preparePoolPayout decomposes
  // the quoted value into standard legs, derives a distinct stealth announcement
  // per leg, and signs the immutable ordered plan
  const requirements = JSON.parse(first);
  const wallet = new Wallet(env.PROOF_PAYER_IDENTITY_KEY);
  body = await preparePoolPayout({
    requirements,
    identitySigner: { signMessage: (message) => wallet.signMessage(message) },
    payerAgentId,
    payeeAgentId,
    network: requirements.network
  });
  const legs = body.plan?.legs ?? [];
  console.error(`payout signed by payer ${payerAgentId} identity=${wallet.address}`);
  console.error(`strategy=${body.plan?.strategy ?? "v1"} legs=${legs.length} total=${body.plan?.totalAtomic ?? "?"}`);
  for (const leg of legs) console.error(`  leg ${leg.index}: ${leg.amountAtomic} -> ${leg.stealthAddress}`);
} else {
  throw new Error(`unknown action ${action ?? "(none)"} (use quote | pay | payout)`);
}

console.log(JSON.stringify(body));
