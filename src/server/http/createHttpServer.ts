import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadavg } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { BrowserInboxGateway } from "../agents/BrowserInboxGateway";
import { createStealthInboxRoutes } from "./createStealthInboxRoutes";

interface HttpDeps {
  /** Absent unless the browser stealth inbox is enabled; absent means unmounted. */
  stealthInbox?: BrowserInboxGateway;
  /**
   * Always present, unlike `stealthInbox` above.
   *
   * This is the ONE deliberate exception to "flag off mounts nothing": a client
   * needs `deploymentId` to build any signed intent, and it needs to know
   * whether the surface exists at all. Without an answer in the disabled case
   * the client cannot tell "feature off" from "server broken" except by probing
   * a 404 and guessing, so it would render an error where it should render an
   * explanation. It is unauthenticated and exposes nothing agent-scoped —
   * anything per-agent stays behind an inbox-key signature.
   */
  stealthConfig: {
    enabled: boolean;
    deploymentId: string;
    claimMode: "off" | "agent" | "browser";
    mode: "onchain" | "dry-run" | "simulation";
    simulation: boolean;
    pageSize: number;
    /**
     * The network a request that omits one resolves against.
     *
     * Published rather than hardcoded on both sides. The gateway already picks
     * a default when `network` is absent, and a client constant that drifts
     * from it would silently subscribe to the wrong chain — an empty inbox for
     * an agent that has money waiting, which is the same class of quiet
     * wrongness as rendering "never checked" as "empty".
     */
    defaultNetwork: string;
  };
  privacy: {
    encryptedStorage: boolean;
    agentRpcEnabled: boolean;
    privateLedgerEnabled: boolean;
    aggregateBatchCommitmentsEnabled: boolean;
    cryptographicErasureEnabled: boolean;
    // Payout-concentration transparency (docs/spec-payout-concentration.md §6/§7).
    // Present only when the pool payout queue exists; each accessor returns
    // undefined unless its own flag is on.
    poolPayoutTransparency?: {
      scheduleCommitment: () => { epoch: number; epochMs: number; commitment: string } | undefined;
      revealSchedule: (epoch: number) => string | undefined;
      kEffHistogram: () => { lagMs: number; buckets: Record<string, number> } | undefined;
      // §14 — the gate's CONFIGURATION posture, and deliberately nothing more.
      // The resolved posture (effectiveTarget, observations, per-rail breakdown)
      // is traffic-derived, and this endpoint is unauthenticated: an observation
      // counter that ticks on every gate evaluation tells a poller when a payout
      // was requested and on which rail. Operators read the full view from
      // `concentrationStatus()` in-process; the public gets static fields only.
      publicConcentrationStatus: () => {
        enabled: boolean;
        adaptive: boolean;
        staticTarget: number;
        ceiling: number;
        evidence: "operator-only";
      };
    };
  };
}

export const createApiServer = ({ stealthInbox, stealthConfig, privacy }: HttpDeps) => {
  // Built once, and only when the gateway exists. With the flag off there is no
  // handler to consult and `/api/stealth/*` 404s like any other unknown path.
  const stealthRoutes = stealthInbox
    ? createStealthInboxRoutes({ gateway: stealthInbox, sendJson, publicOrigin, readBody })
    : undefined;

  const handleRequest = (request: IncomingMessage, response: ServerResponse) => {
    applyCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    // Absolute-form request targets (`GET http://[ HTTP/1.1`) reach here as-is
    // and make `new URL` throw, so the parse must not be bare in the handler.
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      const memory = process.memoryUsage();
      // Ratio against the V8 heap LIMIT (the actual OOM ceiling), not heapTotal:
      // heapTotal is lazily-grown reserved space, so used/total reads near 1 at
      // boot on a healthy process and never predicts exhaustion.
      const heapLimit = getHeapStatistics().heap_size_limit;
      const memoryRatio = heapLimit > 0 ? memory.heapUsed / heapLimit : 0;
      const loadAverage = loadAverage1m();
      const heapUsedRatioMax = 0.9;
      const loadAverage1mMax = 4;
      const degraded = memoryRatio > heapUsedRatioMax || loadAverage > loadAverage1mMax;
      // Still 200 when degraded: the docker healthcheck keys off the HTTP code,
      // and a restart loop on a load spike would be worse than the spike.
      sendJson(response, 200, {
        status: degraded ? "degraded" : "healthy",
        uptime: process.uptime(),
        thresholds: {
          heapUsedRatioMax,
          loadAverage1mMax
        },
        health: {
          heapUsedRatio: Number(memoryRatio.toFixed(3)),
          loadAverage1m: Number(loadAverage.toFixed(2))
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/privacy") {
      sendJson(response, 200, {
        storage: privacy.encryptedStorage ? "encrypted-at-rest" : "plaintext-local-dev",
        privateAgentRpc: privacy.agentRpcEnabled ? "wireguard-bound" : "disabled",
        privatePayments: privacy.privateLedgerEnabled
          ? "identity-signed-x402-current-state-only-ledger"
          : "disabled",
        paymentDetailRetention: privacy.cryptographicErasureEnabled
          ? "ephemeral-epoch-encryption-then-key-erasure"
          : "not-configured",
        paymentPersistentState: privacy.privateLedgerEnabled
          ? "hmac-account-balances-and-public-batch-commitments-only"
          : "not-configured",
        publicSettlement: privacy.aggregateBatchCommitmentsEnabled
          ? "merkle-batch-commitments"
          : "not-configured",
        poolPayoutConcentration: privacy.poolPayoutTransparency
          ? {
            scheduleCommitment: privacy.poolPayoutTransparency.scheduleCommitment() ?? "not-committed",
            kEffHistogram: privacy.poolPayoutTransparency.kEffHistogram() ?? "not-published",
            gate: privacy.poolPayoutTransparency.publicConcentrationStatus(),
          }
          : "not-configured",
        noLogPolicy: "application does not persist request bodies"
      });
      return;
    }

    // §6 reveal — the seed for a CLOSED epoch, so anyone can recompute its jitter
    // draws and verify realized landings. Public and unauthenticated by design; the
    // queue refuses the open/future epoch.
    if (request.method === "GET" && url.pathname === "/api/privacy/pool-payout-schedule") {
      const epoch = Number(url.searchParams.get("epoch"));
      const seed = Number.isInteger(epoch)
        ? privacy.poolPayoutTransparency?.revealSchedule(epoch)
        : undefined;
      sendJson(response, 200, { epoch: Number.isInteger(epoch) ? epoch : null, seed: seed ?? null });
      return;
    }

    // Answered whether or not the inbox is mounted — see `stealthConfig` above.
    // It sits ahead of `stealthRoutes` because that handler is POST-only and
    // would otherwise 404 this GET before it was ever considered.
    if (url.pathname === "/api/stealth/config" && (request.method === "GET" || request.method === "HEAD")) {
      sendJson(response, 200, stealthConfig);
      return;
    }

    if (stealthRoutes?.(request, response, url)) return;

    sendJson(response, 404, { error: "not_found" });
  };

  // A sync throw in the request listener — or an unhandled rejection from a
  // void-ed async branch — escalates to a process crash under Node's defaults,
  // taking every session down with the one bad request. Nothing a client sends
  // may ever do that, so every path out of the handler is caught here.
  return createServer((request, response) => {
    try {
      handleRequest(request, response);
    } catch (error) {
      logHandlerFault(error);
      failRequest(response);
    }
  });
};

const logHandlerFault = (error: unknown) => {
  console.error("HTTP_HANDLER_FAULT", error instanceof Error ? error.stack ?? error.message : String(error));
};

const failRequest = (response: ServerResponse) => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, 500, { error: "internal_error" });
};

const loadAverage1m = () => {
  if (process.platform === "win32") return 0;
  return loadavg()[0] ?? 0;
};

const applyCors = (response: ServerResponse) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
};

const applyPrivacyHeaders = (response: ServerResponse) => {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // CORP blocks cross-origin no-cors embedding of these responses. CORS-mode
  // fetches from browser clients still work — the ACAO:* header governs those.
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
};

const sendJson = (response: ServerResponse, status: number, payload: unknown) => {
  applyPrivacyHeaders(response);
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

export const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

export const publicOrigin = (request: IncomingMessage) => {
  const proto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
};
