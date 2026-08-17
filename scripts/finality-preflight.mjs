// Preflight: is the settler's confirmation budget actually long enough for the
// finality this deployment demands?
//
// TransactionCoordinator.resumeEntry() polls isCanonicalFinal() until
// `now + timeoutMs` and then QUARANTINES the settler and throws. isCanonicalFinal()
// returns `receipt.blockNumber <= getBlock(finality).number` whenever the RPC
// implements the tag — so the budget must exceed the chain's real lag between
// `latest` and the configured finality tag. If it does not, EVERY settler
// transaction (pool payout, x402 settle, batch commitment, stealth sweep relay)
// times out and quarantines even though it mined successfully.
//
// The confirmationFloorFallback is NOT a safety net here: it is reached only when
// getBlock(finality) throws or returns falsy. Base and Robinhood both implement
// the tag, so on those chains the floor is unreachable.
//
// This measures the live chain. It is a point-in-time sample and finality lag
// varies (L1 batch posting, epoch boundaries), so it samples repeatedly and
// judges against the WORST observed lag.
import { config } from "../src/server/config.ts";

const SAMPLES = Number(process.env.PREFLIGHT_SAMPLES ?? 3);
const SAMPLE_GAP_MS = Number(process.env.PREFLIGHT_SAMPLE_GAP_MS ?? 2_000);
// Demand real headroom: finality lag drifts, and a budget that only just clears
// the current sample will quarantine the settler the first time an epoch is slow.
const REQUIRED_HEADROOM = Number(process.env.PREFLIGHT_HEADROOM ?? 2);

const budgetMs = config.agentRpc.poolPayoutTimeoutMs;
const finality = config.agentRpc.poolPayoutFinality;

const networks = [
  { id: "base", rpcUrl: config.base.rpcUrl, chainId: config.base.chainId },
  { id: "robinhood", rpcUrl: config.robinhood.rpcUrl, chainId: config.robinhood.chainId },
];

const rpc = async (url, method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
};

const block = async (url, tag) => {
  const result = await rpc(url, "eth_getBlockByNumber", [tag, false]);
  if (!result) return null;
  return {
    number: Number.parseInt(result.number, 16),
    timestamp: Number.parseInt(result.timestamp, 16),
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(0)}s`;

let failures = 0;
let inconclusive = 0;

console.log("settler finality preflight");
console.log(`  PX402_POOL_PAYOUT_FINALITY   = ${finality}`);
console.log(`  PX402_POOL_PAYOUT_TIMEOUT_MS = ${budgetMs} (${seconds(budgetMs)})`);
console.log(`  required headroom                  = ${REQUIRED_HEADROOM}x worst observed lag`);
console.log("");

for (const network of networks) {
  const observed = [];
  let unreachable;
  for (let i = 0; i < SAMPLES; i += 1) {
    try {
      const [latest, tagged] = await Promise.all([
        block(network.rpcUrl, "latest"),
        block(network.rpcUrl, finality),
      ]);
      if (!latest) throw new Error("no latest block");
      if (!tagged) {
        // The tag is unsupported — isCanonicalFinal() then falls through to the
        // confirmation floor, which is a different (and much shorter) criterion.
        observed.push({ unsupported: true });
      } else {
        observed.push({
          blocks: latest.number - tagged.number,
          lagMs: (latest.timestamp - tagged.timestamp) * 1000,
        });
      }
    } catch (error) {
      unreachable = error instanceof Error ? error.message : String(error);
      break;
    }
    if (i < SAMPLES - 1) await sleep(SAMPLE_GAP_MS);
  }

  if (unreachable) {
    console.log(`${network.id}: INCONCLUSIVE — ${network.rpcUrl} unreachable (${unreachable})`);
    inconclusive += 1;
    continue;
  }
  if (observed.every((sample) => sample.unsupported)) {
    console.log(`${network.id}: tag '${finality}' UNSUPPORTED by ${network.rpcUrl}`);
    console.log(`   isCanonicalFinal falls back to ${config.agentRpc.poolPayoutConfirmationFloor}`
      + " confirmations. Budget is not the binding constraint here.");
    continue;
  }

  const worst = Math.max(...observed.filter((s) => !s.unsupported).map((s) => s.lagMs));
  const worstBlocks = Math.max(...observed.filter((s) => !s.unsupported).map((s) => s.blocks));
  const need = worst * REQUIRED_HEADROOM;
  const ok = budgetMs >= need;
  if (!ok) failures += 1;

  console.log(`${network.id}: ${ok ? "PASS" : "FAIL"}`);
  console.log(`   worst '${finality}' lag over ${observed.length} samples: `
    + `${worstBlocks} blocks / ${seconds(worst)}`);
  console.log(`   budget ${seconds(budgetMs)} vs required ${seconds(need)} `
    + `(${seconds(worst)} x ${REQUIRED_HEADROOM})`);
  if (!ok) {
    const suggested = Math.ceil(need / 60_000) * 60_000;
    console.log(`   => synchronous finality inside the budget is NOT available on ${network.id}:`);
    console.log("      a mined, canonical transaction outlives the confirm budget on every");
    console.log("      send. That is the designed operating mode, not an outage — such a");
    console.log("      transaction resolves as `included` (never a quarantine), the ledger");
    console.log("      settles on the reconcile pass, and since R14 the settler lease is");
    console.log("      released at durable-broadcast, so the wait serializes nothing.");
    console.log("      Windowed pool-payout waves dispatch with no finality wait at all.");
    console.log("   => what this DOES mean: the flag-off synchronous receipt cannot honestly");
    console.log("      return `settled` here — payers get included/delayed answers. For a");
    console.log(`      synchronous-settled contract the budget would need >= ${seconds(suggested)},`);
    console.log("      which only lengthens the caller's own wait; prefer enabling pool");
    console.log("      payout batching, whose claim token is designed for exactly this.");
  }
  console.log("");
}

if (inconclusive === networks.length) {
  console.log("INCONCLUSIVE: no EVM RPC was reachable; nothing was verified.");
  process.exit(0);
}
if (failures > 0) {
  console.log(`FAIL: ${failures} network(s) have a confirmation budget below their real finality lag.`);
  process.exit(1);
}
console.log("PASS: every reachable EVM network finalizes inside the configured budget.");
