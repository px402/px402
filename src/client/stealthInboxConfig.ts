import type { StealthInboxErrorCode } from "../shared/protocol";

/**
 * The eager half of the stealth inbox client.
 *
 * This module is deliberately crypto-free. `StealthInboxClient` pulls in
 * `@noble` secp256k1 + keccak — about 58 kB that every user of the host
 * application would otherwise download and parse on first load for a panel
 * most of them never open. So the client is loaded through a dynamic `import()` and lands in
 * its own chunk, and everything needed to decide WHETHER to load it lives here:
 * the discovery fetch, the origin rule, and the error type.
 *
 * The consequence that matters: when the server reports the surface as
 * disabled — the production default — the crypto chunk is never requested at
 * all. Keep this module free of any import that reaches `stealthReceive`, or
 * the split silently collapses back into the main bundle.
 */

/**
 * Served by `GET /api/stealth/config`, unauthenticated, and answered even when
 * the flag is off — that is what distinguishes "feature disabled" from "server
 * unreachable" without probing for a 404.
 */
export interface StealthInboxConfig {
  /** Bound into every signed intent so a staging signature cannot replay on production. */
  deploymentId: string;
  /** Always "off" at 4a; the browser signs no claims. */
  claimMode: "off";
  mode: "onchain" | "dry-run" | "simulation";
  simulation: boolean;
  pageSize: number;
  /**
   * Prefilled in the pairing form. Taken from the server rather than hardcoded
   * here: the gateway resolves an omitted `network` against its own default,
   * and a client copy that drifted from it would subscribe to the wrong chain
   * and render an empty inbox for an agent that has money waiting.
   */
  defaultNetwork: string;
}

/** Carries the server's opaque code, never a server error string. */
export class StealthInboxRequestError extends Error {
  constructor(
    readonly code: StealthInboxErrorCode | "stealth_unreachable",
    readonly correlationId: string
  ) {
    super(code);
    this.name = "StealthInboxRequestError";
  }
}

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

/**
 * Where `/api/stealth/*` is sent.
 *
 * Deliberately NOT derived from a host-application URL helper. The original
 * helper consulted an `?api=` query parameter, which was the P0-D vulnerability: a hostile origin
 * supplied by a link would receive the pairing ticket, and on the 4b claim path
 * would receive the address the browser is about to sign a payment
 * authorization to. Nothing here reads a query parameter — the target is
 * derived from `window.location` alone (SI-37).
 *
 * The one hop is the local dev split: `vite` serves the page on 5173/4173 while
 * the backend listens on 8787 with no proxy between them. That hop is computed
 * from the page's own hostname and gated on loopback, so it is inert on any
 * deployed origin, where this returns "" and every request is same-origin and
 * relative.
 */
export const stealthApiBase = () => {
  const devPort = window.location.port === "5173" || window.location.port === "4173";
  if (!devPort || !isLoopbackHost(window.location.hostname)) return "";
  return `${window.location.protocol}//${window.location.hostname}:8787`;
};

const asMode = (value: unknown): StealthInboxConfig["mode"] | undefined => {
  if (value === "onchain" || value === "dry-run" || value === "simulation") return value;
  return undefined;
};

/**
 * `null` means "render the disabled panel and load nothing else" — for a flag
 * that is off, a route that is not mounted, an unreachable server, and a
 * malformed payload alike. Only the malformed case warns, because that one is
 * an operator error rather than an expected state.
 */
export const fetchStealthInboxConfig = async (): Promise<StealthInboxConfig | null> => {
  let body: unknown;
  try {
    const response = await fetch(`${stealthApiBase()}/api/stealth/config`, {
      method: "GET",
      cache: "no-store"
    });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    // Not mounted or unreachable. Both are ordinary states, not worth a console
    // entry on every page load.
    return null;
  }

  if (typeof body !== "object" || body === null) return null;
  const payload = body as Record<string, unknown>;
  if (payload.enabled !== true) return null;

  const mode = asMode(payload.mode);
  const deploymentId = typeof payload.deploymentId === "string" ? payload.deploymentId : "";
  if (!deploymentId || !mode) {
    // Enabled but unusable: without a deploymentId no signature this browser
    // produces can verify, so say so rather than failing later as an opaque
    // authorization error.
    console.warn("Stealth inbox is enabled but its config is missing deploymentId or mode; treating it as disabled.");
    return null;
  }

  return {
    deploymentId,
    // 4a signs no claims regardless of what the server advertises.
    claimMode: "off",
    mode,
    simulation: payload.simulation === true || mode === "simulation",
    pageSize: typeof payload.pageSize === "number" && payload.pageSize > 0 ? payload.pageSize : 8,
    // Lenient like pageSize, not strict like deploymentId: an older server that
    // does not publish this still works, the operator just types the network.
    defaultNetwork: typeof payload.defaultNetwork === "string" && payload.defaultNetwork
      ? payload.defaultNetwork
      : "base"
  };
};
