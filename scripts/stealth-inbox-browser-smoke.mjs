// Phase 4a of spec-stealth-inbox-phase4: the in-product stealth inbox, read side.
//
// What 4a claims, and therefore what this suite has to be able to falsify:
//
//   1. The browser holds ONE credential — a standalone random inbox key with no
//      derivational relationship to any spending key. No seed, no spend key, no
//      viewing key ever exists on the origin at 4a. If that split were only a
//      convention, the first refactor would collapse it.
//   2. That credential can enumerate announcements and do NOTHING else.
//   3. A session id is never authorization. Session ids are broadcast to every
//      client every tick, so anything that accepts one as proof is already
//      compromised.
//   4. Errors are opaque: unknown agent, unpaired agent and bad signature are
//      indistinguishable, so this channel is not an agent-existence oracle.
//   5. Nothing client-side derives its target origin from a query parameter.
//
//   npm run test:stealth:inbox:browser
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMessage, getAddress, Wallet } from "ethers";
import { EncryptedJsonFile } from "../src/server/storage/EncryptedJsonFile.ts";
import { InboundAnnouncementBook } from "../src/server/payments/InboundAnnouncementBook.ts";
import {
  generateStealthInboxIdentity,
  signStealthInboxMessage,
  stealthInboxAddressForKey,
  toChecksumAddress,
} from "../src/shared/stealthReceive.ts";
import {
  stealthInboxBrowserIntentMessage,
  stealthInboxIntentMessage,
  stealthInboxPairIntentMessage,
} from "../src/shared/x402AgentIntent.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const tests = [];
let passed = 0;
let failed = 0;

const test = (name, run) => tests.push({ name, run });
const assert = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};

/**
 * Every stub prints itself. A suite that silently stubs the interesting half of
 * a path reads green and proves nothing, so the stubs are part of the output
 * rather than a footnote in a spec.
 */
const stub = (name) => console.log(`STUBBED: ${name}`);

/**
 * Strip comments before pattern-matching source.
 *
 * The first version of these guards matched raw text and fired on comments that
 * said "deliberately NOT defaultApiBase" — punishing the code for explaining
 * itself, and training the next person to delete the explanation to get a green
 * build. A guard that can only be satisfied by removing the reasoning is worse
 * than no guard. String literals are preserved: a URL or key name built as a
 * string is real code and should still be caught.
 */
const stripComments = (source) => {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (ch === "\\") { out += "  "; i += 2; continue; }
      if (ch === quote) quote = null;
      out += ch; i += 1; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " "; i += 1;
      }
      out += "  "; i += 2; continue;
    }
    out += ch; i += 1;
  }
  return out;
};

const codeOf = (file) => stripComments(readFileSync(file, "utf8"));

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts)$/.test(entry)) out.push(full);
  }
  return out;
};

// ------------------------------------------- the scanner's own non-vacuity

test("the comment stripper removes prose but keeps code and strings", () => {
  // Every structural guard below is only as good as this function. If it
  // over-stripped — returned "", ate a whole file after one apostrophe — the
  // guards would all pass while checking nothing, which is the failure mode
  // that makes static checks worthless. So it is tested in both directions.
  const stripped = stripComments([
    '// deliberately NOT defaultApiBase',
    '/* localStorage is wrong here */',
    'const url = "/api/stealth/inbox";',
    "const note = 'defaultApiBase in a string is still code';",
    'const ratio = a / b; // trailing',
    'const re = "http://example.com/x";',
  ].join("\n"));

  assert(!/deliberately NOT/.test(stripped), "line comments survived");
  assert(!/localStorage is wrong/.test(stripped), "block comments survived");
  assert(!/trailing/.test(stripped), "trailing line comments survived");
  assert(/"\/api\/stealth\/inbox"/.test(stripped), "a string literal was destroyed");
  assert(/defaultApiBase in a string/.test(stripped), "strings must still be scanned — that is real code");
  assert(/const ratio = a \/ b;/.test(stripped), "division was mistaken for a comment");
  assert(/http:\/\/example\.com\/x/.test(stripped), "a URL inside a string was eaten");
  assert(stripped.split("\n").length === 6, "line numbering drifted, so failure messages would misreport");
});

// ------------------------------------------------------- the 4a credential

test("B-37a inbox identity is a well-formed independent secp256k1 key", () => {
  const id = generateStealthInboxIdentity();
  assert(/^0x[0-9a-f]{64}$/.test(id.inboxIdentityKey), "inbox key is not 32-byte lowercase hex");
  assert(
    stealthInboxAddressForKey(id.inboxIdentityKey) === id.inboxIdentityAddress,
    "address does not round-trip from the key",
  );
});

test("B-37b two generations are independent (the key is random, not derived)", () => {
  // If a refactor ever made the inbox key a function of a seed or of the agent
  // id, this collapses immediately: repeated calls in one process would start
  // agreeing. That is the whole 4a/4b split, so it gets a real sample.
  const seen = new Set();
  for (let i = 0; i < 256; i += 1) seen.add(generateStealthInboxIdentity().inboxIdentityKey);
  assert(seen.size === 256, `expected 256 distinct keys, got ${seen.size}`);
});

test("B-37c the 4a module exposes no seed, spend, or viewing key derivation", () => {
  // 4a must not even be ABLE to materialize spend authority. Enforced against
  // the module's own export surface rather than a promise in a doc.
  const source = readFileSync(join(repoRoot, "src/shared/stealthReceive.ts"), "utf8");
  for (const forbidden of [
    "generateStealthReceiveSeed",
    "stealthReceiveKeysFromSeed",
    "spendingKey",
    "viewingKey",
    "computeStealthPrivateKey",
  ]) {
    assert(
      !new RegExp(`export const ${forbidden}\\b|export function ${forbidden}\\b`).test(source),
      `stealthReceive.ts exports ${forbidden} — 4a has collapsed into 4b`,
    );
  }
});

// ------------------------------------------------ EIP-191 wire compatibility

test("browser signatures recover under the server's ethers verifyMessage", () => {
  // The browser signs with @noble (no ethers in the browser bundle) and the server
  // verifies with ethers. If these two ever disagree, every browser read fails
  // closed — which is safe but silent, so it is worth an explicit check.
  const id = generateStealthInboxIdentity();
  const message = stealthInboxBrowserIntentMessage({
    agentId: "agent-one",
    network: "base",
    intentNonce: "abc123",
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_300,
    deploymentId: "local-dev",
    origin: "http://127.0.0.1:5173",
  });
  assert(verifyMessage(message, signStealthInboxMessage(id.inboxIdentityKey, message)) === id.inboxIdentityAddress);
});

test("a non-ASCII agent label still verifies (UTF-8 byte length, not code points)", () => {
  // EIP-191 prefixes the BYTE length. Using code-point length would pass every
  // ASCII test and fail the first time an agent label contained kanji.
  const id = generateStealthInboxIdentity();
  const message = stealthInboxBrowserIntentMessage({
    agentId: "新宿駅-operator",
    network: "base",
    intentNonce: "n",
    issuedAt: 1,
    expiresAt: 2,
    deploymentId: "d",
    origin: "o",
  });
  assert(verifyMessage(message, signStealthInboxMessage(id.inboxIdentityKey, message)) === id.inboxIdentityAddress);
});

test("a tampered intent does not recover to the signer", () => {
  const id = generateStealthInboxIdentity();
  const base = { agentId: "agent-one", network: "base", intentNonce: "n", issuedAt: 1, expiresAt: 2, deploymentId: "d", origin: "o" };
  const signature = signStealthInboxMessage(id.inboxIdentityKey, stealthInboxBrowserIntentMessage(base));
  const tampered = stealthInboxBrowserIntentMessage({ ...base, agentId: "agent-two" });
  assert(verifyMessage(tampered, signature) !== id.inboxIdentityAddress, "swapping the agent id kept the signature valid");
});

test("EIP-55 checksums and address derivation agree with ethers", () => {
  // toChecksumAddress is hand-rolled so the client does not pull in ethers.
  // A wrong checksum would only surface as a comparison mismatch deep in
  // pairing, so it is compared against the real implementation in bulk.
  for (let i = 0; i < 100; i += 1) {
    const wallet = Wallet.createRandom();
    assert(toChecksumAddress(wallet.address.toLowerCase()) === getAddress(wallet.address), "checksum mismatch");
    assert(stealthInboxAddressForKey(wallet.privateKey) === getAddress(wallet.address), "address derivation mismatch");
  }
});

// --------------------------------------------- SI-1: the WireGuard path bytes

test("SI-1 the pre-existing WireGuard inbox intent bytes are unchanged", () => {
  // Agents already sign this message. Changing a single byte silently breaks
  // every deployed agent's inbox read, so it is pinned to a literal rather than
  // to a re-derivation of itself.
  assert(
    stealthInboxIntentMessage({ agentId: "payee", network: "base", intentNonce: "abc" }) ===
      '{"protocol":"px402-stealth-inbox/v1","action":"inbox","agentId":"payee","network":"base","intentNonce":"abc"}',
    "the WireGuard stealth-inbox intent bytes changed — every deployed agent breaks",
  );
});

test("the browser intent is a DIFFERENT message from the WireGuard one", () => {
  // If these collided, a browser-scoped signature would authorize a WireGuard
  // operation and vice versa, and the expiry/deployment binding would be
  // bypassable by just signing the older shape.
  const shared = { agentId: "payee", network: "base", intentNonce: "abc" };
  const browser = stealthInboxBrowserIntentMessage({ ...shared, issuedAt: 1, expiresAt: 2, deploymentId: "d", origin: "o" });
  assert(browser !== stealthInboxIntentMessage(shared), "browser and wireguard intents are byte-identical");
  assert(JSON.parse(browser).protocol === "px402-stealth-inbox-browser/v1");
});

test("the pair intent binds ticket, inbox address, deployment and origin", () => {
  // Each of these is load-bearing: without ticketId a captured pairing
  // signature replays against a later ticket; without origin/deploymentId a
  // staging signature replays against production.
  const message = stealthInboxPairIntentMessage({
    agentId: "agent-one",
    network: "base",
    inboxIdentityAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
    metaFingerprint: null,
    ticketId: "ticket-1",
    intentNonce: "n",
    issuedAt: 1,
    expiresAt: 2,
    deploymentId: "prod",
    origin: "https://example-origin.test",
  });
  const parsed = JSON.parse(message);
  assert(parsed.action === "pair");
  assert(parsed.ticketId === "ticket-1", "ticket not bound");
  assert(parsed.deploymentId === "prod", "deployment not bound");
  assert(parsed.origin === "https://example-origin.test", "origin not bound");
  assert(parsed.metaFingerprint === null, "stage 1 must not bind a meta-address");
  assert(
    parsed.inboxIdentityAddress === "0xabcdef0123456789abcdef0123456789abcdef01",
    "inbox address must be case-normalized so a checksum variant is not a different message",
  );
});

// ------------------------------- SI-37: no client-controlled request origin

test("B-40 no client payment code reads an api/ws override or defaultApiBase", () => {
  // P0-D: `?api=` and `?ws=` were attacker-controllable origins. The stealth
  // routes carry a pairing ticket and (at 4b) an address the browser signs a
  // payment to, so inheriting that helper would be a direct drain rather than
  // mere disclosure. Enforced structurally — a future edit cannot reintroduce
  // it without failing here.
  const dir = join(repoRoot, "src/client");
  let scanned = 0;
  for (const file of walk(dir)) {
    scanned += 1;
    const source = codeOf(file);
    const where = relative(repoRoot, file);
    assert(!/defaultApiBase/.test(source), `${where} references defaultApiBase`);
    assert(!/\bpostJson\b/.test(source), `${where} references postJson`);
    assert(
      !/URLSearchParams|location\.search/.test(source),
      `${where} reads a query parameter — request origins must come from the page origin only`,
    );
  }
  assert(scanned > 0, "scanned no files under src/client — the scan target is wrong, so this check proves nothing");
});

test("B-36/SI-19 no client code puts stealth key material or announcements in localStorage", () => {
  // localStorage already holds a live bearer control token, so one XSS would
  // take both. IndexedDB is not a defence against script execution, but it does
  // keep the key out of the file commodity infostealers scrape.
  const dir = join(repoRoot, "src/client");
  let scanned = 0;
  for (const file of walk(dir)) {
    scanned += 1;
    const source = codeOf(file);
    const where = relative(repoRoot, file);
    assert(!/localStorage/.test(source), `${where} touches localStorage`);
    assert(!/LocalStore/.test(source), `${where} imports LocalStore`);
    assert(!/ephemeralPubKey\s*:/.test(source) || !/(setItem|put\(|add\()/.test(source),
      `${where} may be persisting an announcement — announcements are memory-only (spec §5.4)`);
  }
  assert(scanned > 0, "scanned no files under src/client");
});

test("a v1 announcement book migrates to v2 without losing a single R", async () => {
  // 4a adds `generation` and `anomaly` to every record, which bumps the file
  // version. This book holds the ONLY copy of every ephemeral pubkey, and
  // without `R` a payee cannot derive the one-time key or even locate the
  // address — so a migration that drops or rewrites a record destroys real
  // money with no recovery path. Tested against a literal v1 file rather than
  // one produced by the current code, because the current code can no longer
  // emit v1 and a round-trip through it would prove nothing.
  const root = await mkdtemp(join(tmpdir(), "inbox-migration-"));
  try {
    const encryptionKey = randomBytes(32).toString("hex");
    const path = join(root, "book.json");
    const accountId = `acct_${createHmac("sha256", "k").update("payee").digest("hex")}`;
    const announcement = `0x02${"ab".repeat(32)}`;

    await new EncryptedJsonFile(path, encryptionKey, { failClosed: true, durable: true }).write({
      version: 1,
      records: [{
        id: "inbound-a", accountId, network: "base", caip2: "eip155:8453",
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        stealthAddress: "0x1111111111111111111111111111111111111111",
        ephemeralPubKey: announcement, expectedAmountAtomic: "200000",
        observedAmountAtomic: "200000", source: "pool-payout", sourceRef: "g:0",
        status: "observed", sweepIntentId: null, sweepTxHash: null,
        createdAt: 1, observedAt: 2, sweptAt: null,
      }],
    });

    const open = () => new InboundAnnouncementBook(path, {
      retentionMs: 900_000, dormantMs: 86_400_000, encryptionKey,
    }).load();

    const migrated = (await open()).forAccount(accountId);
    assert(migrated.length === 1, "the v1 record did not survive migration");
    assert(migrated[0].ephemeralPubKey === announcement, "the announcement R was not byte-preserved");
    assert(migrated[0].generation === 0, "generation did not default to 0");
    assert(migrated[0].anomaly === null, "anomaly did not default to null");
    assert(migrated[0].observedAmountAtomic === "200000", "the observed balance was lost");

    // Reload proves the on-disk rewrite is itself valid — a migration that only
    // works in memory leaves the next boot reading a file it will reject.
    const reloaded = (await open()).forAccount(accountId);
    assert(reloaded.length === 1 && reloaded[0].ephemeralPubKey === announcement, "R was lost on rewrite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SI-4 no spend-side registry method accepts a browser caller", () => {
  // The browser key is receive-only, and the strongest way to say that is to
  // make it un-typeable rather than merely rejected: every value-moving method
  // keeps `remoteIp: string`, so handing one a `{channel:"browser-inbox"}`
  // context is a compile error. The obvious future regression is someone
  // "tidying up" by widening these to PrivateCaller, at which point the only
  // thing standing between a read key and a spend would be a runtime scope
  // string. This fails the moment that happens.
  const registry = codeOf(join(repoRoot, "src/server/agents/PrivateAgentRegistry.ts"));
  const spendSide = [
    "issueBlindVouchers",
    "redeemBlindVouchers",
    "claimPoolPayout",
    "createPrivateLedgerDepositIntent",
    "confirmPrivateLedgerDeposit",
  ];
  for (const method of spendSide) {
    const match = new RegExp(`async ${method}\\s*\\(([^)]*)\\)`, "s").exec(registry);
    assert(match, `${method} not found — this guard is scanning for a method that no longer exists`);
    assert(
      /remoteIp\s*:\s*string/.test(match[1]),
      `${method} no longer takes remoteIp: string — a browser caller may now be able to reach it`,
    );
    assert(
      !/PrivateCaller/.test(match[1]),
      `${method} was widened to PrivateCaller — the receive-only key is no longer receive-only by type`,
    );
  }

  // And the converse: only the read/simulate paths may take PrivateCaller.
  const widened = [...registry.matchAll(/async\s+(\w+)\s*\(([^)]*)\)/gs)]
    .filter(([, , params]) => /PrivateCaller/.test(params))
    .map(([, name]) => name)
    .sort();
  assert(
    JSON.stringify(widened) === JSON.stringify(["simulateInboundAnnouncement", "stealthInbox"]),
    `unexpected methods accept PrivateCaller: ${widened.join(", ") || "(none)"}`,
  );
});

test("the signature-free snapshot read is never reachable from an HTTP route", () => {
  // `stealthInboxSnapshot` intentionally takes no signature and no nonce: it
  // exists to push to a subscription whose signature was already verified. That
  // makes it the single most dangerous method in this feature to wire up by
  // mistake — an unauthenticated route over it would hand out every payee's
  // `ephemeralPubKey`, and `R` is what bounds retroactive de-anonymization.
  // Leaking it is not a disclosure that can be revoked; it permanently destroys
  // recipient unlinkability for every output already announced.
  const registry = codeOf(join(repoRoot, "src/server/agents/PrivateAgentRegistry.ts"));
  assert(
    /\bstealthInboxSnapshot\s*\(/.test(registry),
    "stealthInboxSnapshot is missing from the registry — this check would otherwise pass vacuously",
  );
  for (const file of walk(join(repoRoot, "src/server/http"))) {
    assert(
      !/stealthInboxSnapshot/.test(codeOf(file)),
      `${relative(repoRoot, file)} references stealthInboxSnapshot — an HTTP route must use the signed path`,
    );
  }
});

test("SI-16 client code never imports ethers (bundle size + no accidental key surface)", () => {
  for (const dir of ["src/client"]) {
    for (const file of walk(join(repoRoot, dir))) {
      const source = codeOf(file);
      assert(
        !/from\s+["']ethers["']/.test(source),
        `${relative(repoRoot, file)} imports ethers — it would be pulled into the client bundle`,
      );
    }
  }
});

// ------------------------------------------------------------------ run

// Asserted against a constant so a check that silently stops executing — an
// early return, a rename, a file that no longer matches a glob — fails the run
// instead of quietly shrinking the suite.
const EXPECTED_CHECKS = 17;

for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const executed = passed + failed;
if (executed !== EXPECTED_CHECKS) {
  console.error(`\nFAIL executed ${executed} checks, expected ${EXPECTED_CHECKS}`);
  process.exitCode = 1;
}

console.log(`\n${passed} passed, ${failed} failed (${executed}/${EXPECTED_CHECKS} executed)`);
if (failed > 0) process.exitCode = 1;
