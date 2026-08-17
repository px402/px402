import type { IncomingMessage, ServerResponse } from "node:http";
import {
  StealthInboxFailure,
  type BrowserInboxGateway,
} from "../agents/BrowserInboxGateway";

/**
 * The public half of the browser stealth inbox.
 *
 * Mounted ONLY when `PX402_STEALTH_INBOX_BROWSER_ENABLED` is on — with the
 * flag off this factory is never called, nothing is constructed, and every path
 * below falls through to the server's ordinary 404. Zero new surface is a
 * property of the wiring, not of a runtime check inside each handler.
 *
 * There are NO claim routes here. Phase 4a is subscribe, push, render; the claim
 * saga is 4b and its absence is asserted by the smoke suite, so an early mount
 * would be caught rather than shipped.
 *
 * This layer is deliberately dumb: parse a body, resolve an origin, call one
 * gateway method, render an opaque code. Every authorization decision lives in
 * `BrowserInboxGateway`.
 */

export interface StealthInboxRouteDeps {
  gateway: BrowserInboxGateway;
  /** Reuses the server's own JSON sender so privacy headers stay in one place. */
  sendJson: (response: ServerResponse, status: number, payload: unknown) => void;
  publicOrigin: (request: IncomingMessage) => string;
  readBody: (request: IncomingMessage) => Promise<string>;
}

type StealthRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => boolean;

const STEALTH_PREFIX = "/api/stealth/";

const HTTP_STATUS: Record<string, number> = {
  stealth_unavailable: 503,
  stealth_simulation_unavailable: 503,
  stealth_unauthorized: 401,
  stealth_not_paired: 401,
  stealth_rate_limited: 429,
  stealth_conflict: 409,
};

export const createStealthInboxRoutes = (deps: StealthInboxRouteDeps): StealthRouteHandler =>
  (request, response, url) => {
    if (!url.pathname.startsWith(STEALTH_PREFIX)) return false;
    if (request.method !== "POST") {
      // Every route here is a POST. Anything else is answered exactly like an
      // unmounted path so the method itself is not a probe.
      deps.sendJson(response, 404, { error: "not_found" });
      return true;
    }

    // Narrower than the server-wide `*`: the wildcard is fine for the public
    // world/agents endpoints, but these responses carry announcements. A
    // cross-origin page gets no header at all and so cannot read the body.
    const serverOrigin = deps.publicOrigin(request);
    const requestOrigin = typeof request.headers.origin === "string"
      ? request.headers.origin
      : undefined;
    const origin = deps.gateway.resolveOrigin(requestOrigin, serverOrigin);
    response.removeHeader("Access-Control-Allow-Origin");
    if (origin && requestOrigin) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin);
      response.setHeader("Vary", "Origin");
    }
    if (!origin) {
      // The origin is bound into every signature, so a request that cannot claim
      // one could never have produced a valid one either.
      fail(deps, response, "stealth_unauthorized", `origin ${requestOrigin ?? "none"} refused`);
      return true;
    }

    const tls = request.headers["x-forwarded-proto"] === "https"
      || Boolean((request.socket as { encrypted?: boolean }).encrypted);

    void deps.readBody(request)
      .then(async (body) => {
        const payload = parseJsonObject(body);
        switch (url.pathname) {
          case "/api/stealth/pair-ticket": {
            const ticket = await deps.gateway.mintPairingTicket({
              agentId: text(payload.agentId),
              adminAuthorization: request.headers.authorization,
              replace: payload.replace === true,
            });
            deps.sendJson(response, 200, ticket);
            return;
          }
          case "/api/stealth/pair": {
            const result = await deps.gateway.pair({
              agentId: text(payload.agentId),
              network: optionalText(payload.network),
              inboxIdentityAddress: text(payload.inboxIdentityAddress),
              ticket: text(payload.ticket),
              intentNonce: text(payload.intentNonce),
              agentSignature: text(payload.agentSignature),
              issuedAt: integer(payload.issuedAt),
              expiresAt: integer(payload.expiresAt),
            }, { tls, origin });
            deps.sendJson(response, 200, result);
            return;
          }
          case "/api/stealth/inbox": {
            const inbox = await deps.gateway.inbox({
              agentId: text(payload.agentId),
              network: optionalText(payload.network),
              intentNonce: text(payload.intentNonce),
              agentSignature: text(payload.agentSignature),
              issuedAt: integer(payload.issuedAt),
              expiresAt: integer(payload.expiresAt),
            }, { origin });
            deps.sendJson(response, 200, { inbox });
            return;
          }
          case "/api/stealth/dev/inbound": {
            const entry = await deps.gateway.simulateInbound({
              agentId: text(payload.agentId),
              network: text(payload.network),
              amountAtomic: text(payload.amountAtomic),
              intentNonce: text(payload.intentNonce),
              agentSignature: text(payload.agentSignature),
              issuedAt: integer(payload.issuedAt),
              expiresAt: integer(payload.expiresAt),
            }, { origin });
            deps.sendJson(response, 200, { entry });
            return;
          }
          default:
            deps.sendJson(response, 404, { error: "not_found" });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof StealthInboxFailure) {
          respond(deps, response, error);
          return;
        }
        // A malformed body must look like every other refusal. Echoing a parser
        // message here is how the private RPC ended up leaking agent ids.
        fail(deps, response, "stealth_unauthorized", describe(error));
      });
    return true;
  };

const respond = (
  deps: StealthInboxRouteDeps,
  response: ServerResponse,
  failure: StealthInboxFailure,
) => {
  deps.sendJson(response, HTTP_STATUS[failure.code] ?? 400, {
    error: failure.code,
    correlationId: failure.correlationId,
  });
};

const fail = (
  deps: StealthInboxRouteDeps,
  response: ServerResponse,
  code: "stealth_unauthorized",
  detail: string,
) => {
  const failure = new StealthInboxFailure(code, detail);
  console.warn(`STEALTH_INBOX_REJECTED code=${code} correlation=${failure.correlationId} ${detail}`);
  respond(deps, response, failure);
};

const parseJsonObject = (body: string): Record<string, unknown> => {
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }
  return parsed as Record<string, unknown>;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

const optionalText = (value: unknown) => (typeof value === "string" ? value : undefined);

const integer = (value: unknown) => (typeof value === "number" ? value : Number.NaN);

const describe = (error: unknown) => (error instanceof Error ? error.message : "unknown error");
