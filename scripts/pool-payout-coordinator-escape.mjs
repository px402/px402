const EXCLUSION = [
  "!!! SETTLER-KEY EXCLUSION: do NOT run while a separate PX-402 server is live.",
  "!!! This guarded client mutates the live server's coordinator/queue state; run exactly one",
  "!!! escape command at a time and never run a separate settler-key script concurrently.",
].join("\n");
console.error(EXCLUSION);

const args = parseArgs(process.argv.slice(2));
const adminToken = process.env.PX402_ADMIN_TOKEN;
if (!adminToken) throw new Error("PX402_ADMIN_TOKEN is required");
const rpcUrl = process.env.PX402_AGENT_RPC_URL
  ?? `http://${process.env.PX402_AGENT_RPC_HOST ?? "127.0.0.1"}:${process.env.PX402_AGENT_RPC_PORT ?? "3099"}`;

let path;
let body;
if (args.leg) {
  const [groupRef, rawIndex] = args.leg.split(":");
  const index = Number(rawIndex);
  if (!groupRef || !Number.isInteger(index)) throw new Error("--leg must be groupRef:index");
  path = "/private/admin/pool-payout/resolve-leg";
  body = args.landed
    ? { groupRef, index, landed: true, signature: required(args.signature, "--signature") }
    : {
      groupRef,
      index,
      absent: true,
      attestation: required(args.attestation, "--attestation"),
    };
} else {
  const nonce = Number(required(args.nonce, "--nonce"));
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error("--nonce must be a non-negative integer");
  const network = args.network ?? "base";
  path = "/private/admin/pool-payout/resolve-nonce";
  body = {
    network,
    resolution: args.cancel
      ? { nonce, mode: "cancel" }
      : {
        nonce,
        mode: "disposition",
        landedHash: args.landed,
        absent: Boolean(args.absent),
      },
  };
}

const response = await fetch(new URL(path, rpcUrl), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${adminToken}`,
  },
  body: JSON.stringify(body),
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.error ?? `escape request failed (${response.status})`);
console.log(JSON.stringify(payload.result, null, 2));

function required(value, name) {
  if (value === undefined || value === true || value === "") throw new Error(`${name} is required`);
  return value;
}

function parseArgs(values) {
  const parsed = {};
  const flags = new Set(["--cancel", "--absent"]);
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (flags.has(key)) parsed[name] = true;
    else parsed[name] = values[++index];
  }
  const modes = [parsed.cancel, parsed.landed, parsed.absent].filter(Boolean).length;
  if (modes !== 1) throw new Error("Choose exactly one of --cancel, --landed HASH, or --absent");
  if (Boolean(parsed.leg) === Boolean(parsed.nonce)) {
    throw new Error("Choose exactly one target: --leg groupRef:index or --nonce N");
  }
  return parsed;
}
