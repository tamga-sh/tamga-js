#!/usr/bin/env node
/**
 * Cross-runtime smoke test — run against the built `dist/index.js` ESM
 * output on Node, Deno, and Bun (see `.github/workflows/ci.yml`'s
 * `smoke` job) to catch runtime-incompatible syntax or API usage that
 * Node-only vitest coverage would miss.
 *
 * No network calls. Two things are proven here:
 *
 * 1. The built ESM entrypoint loads and `TamgaClient`'s constructor
 *    validation runs.
 * 2. Offline machine-file verification actually works on each runtime,
 *    against the server-produced certificates in
 *    `test/fixtures/machine-file-v2/`. That path reaches WebCrypto
 *    (AES-GCM, RSA import/verify), `@noble/curves` (Ed25519, P-256) and
 *    the filesystem, which is exactly where the four runtimes diverge —
 *    and the RSA fixtures are the largest files in the set, so a runtime
 *    that reads them short fails here rather than in production.
 */

import { readFileSync } from "node:fs";

import {
  TamgaClient,
  SigningKeySet,
  effectiveHeartbeatWindowMs,
  heartbeatWindowMsFromMachine,
  signingKeyId,
  verifyAndDecryptMachineFile,
  verifyMachineFileWithClaims,
  verifyMachineFileWithKeySet,
  MACHINE_HEARTBEAT_WINDOW_MS,
} from "../dist/index.js";

const client = new TamgaClient({
  accountId: "acct_smoke",
  baseUrl: "https://api.tamga.sh",
  auth: { kind: "license", key: "lic-smoke" },
});

if (client.config.accountId !== "acct_smoke") {
  throw new Error("smoke test failed: TamgaClient did not retain its config");
}

try {
  // eslint-disable-next-line no-new -- constructing to observe the thrown validation error
  new TamgaClient({ accountId: "", baseUrl: "https://api.tamga.sh" });
  throw new Error("smoke test failed: expected TamgaClient to throw on empty accountId");
} catch (err) {
  if (!(err instanceof Error) || !err.message.includes("accountId")) {
    throw err;
  }
}

// ── Offline machine-file verification, on real server-produced fixtures ──────

const FIXTURE_DIR = new URL("../test/fixtures/machine-file-v2/", import.meta.url);

/** `atob` rather than `Buffer`: a global on all four target runtimes. */
function decodeBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const SCHEME_BY_MANIFEST_NAME = {
  Ed25519Sign: "ED25519_SIGN",
  EcdsaP256Sign: "ECDSA_P256_SIGN",
  Rsa2048Pkcs1Sign: "RSA_2048_PKCS1_SIGN",
  Rsa2048Pkcs1PssSign: "RSA_2048_PKCS1_PSS_SIGN",
};

const manifest = JSON.parse(readFileSync(new URL("manifest.json", FIXTURE_DIR), "utf8"));
const fixtureNames = Object.keys(manifest);
if (fixtureNames.length < 12) {
  throw new Error(
    `smoke test failed: expected at least 12 machine-file fixtures, read ${fixtureNames.length}`,
  );
}

for (const name of fixtureNames) {
  const entry = manifest[name];
  const pem = readFileSync(new URL(entry.file, FIXTURE_DIR), "utf8");
  if (!pem.trimEnd().endsWith("-----END MACHINE FILE-----")) {
    throw new Error(`smoke test failed: ${entry.file} was read short or truncated`);
  }

  const scheme = SCHEME_BY_MANIFEST_NAME[entry.scheme];
  if (scheme === undefined) {
    throw new Error(`smoke test failed: unknown manifest scheme ${entry.scheme}`);
  }
  const publicKey = decodeBase64(entry.public_key_b64);
  const keyMaterial =
    entry.license_key === null
      ? undefined
      : { licenseKey: entry.license_key, fingerprint: entry.fingerprint };

  // A reference clock before any fixture was issued, so the signature and the
  // decryption are what is under test here rather than the expiry.
  const { claims } = await verifyMachineFileWithClaims(pem, scheme, publicKey, keyMaterial, 0);
  if (claims.kid !== entry.kid) {
    throw new Error(`smoke test failed: ${name} reported kid ${claims.kid}, expected ${entry.kid}`);
  }

  // Now anchored to the file's own signed issue time — never the wall clock,
  // since `exp` is `iat ± 3600`.
  let expired = false;
  let machine;
  try {
    machine = await verifyAndDecryptMachineFile(pem, scheme, publicKey, keyMaterial, claims.iat);
  } catch (err) {
    if (err?.kind !== "expired") throw err;
    expired = true;
  }

  if (expired !== entry.expired) {
    throw new Error(
      `smoke test failed: ${name} expiry verdict was ${expired}, manifest says ${entry.expired}`,
    );
  }
  if (!expired && machine?.attributes?.fingerprint !== entry.fingerprint) {
    throw new Error(`smoke test failed: ${name} did not yield the expected machine resource`);
  }
}

// ── Signing-key rotation, on real server-produced fixtures ──────────────────
//
// The `kid` rule checked against the server's own certificates on every
// runtime: hashing the manifest's base64 public-key STRING must reproduce the
// kid the server stamped into the signed payload. This is the one assertion
// that catches a runtime whose SHA-256 or text encoding differs, and it is
// checked against values this SDK did not produce.

for (const name of fixtureNames) {
  const entry = manifest[name];
  const computed = signingKeyId(entry.public_key_b64);
  if (computed !== entry.kid) {
    throw new Error(
      `smoke test failed: ${name} computed kid ${computed}, server stamped ${entry.kid}`,
    );
  }
}

// A rotation, end to end, against a server-minted Ed25519 file: the key set
// holds a newer key first and the file's own (older) key second, and the file
// must still verify — selecting by kid rather than by position or by trying
// each in turn.
const ED25519_FIXTURES = fixtureNames.filter((name) => manifest[name].scheme === "Ed25519Sign");
if (ED25519_FIXTURES.length === 0) {
  throw new Error("smoke test failed: no Ed25519 machine-file fixture to verify through a key set");
}

// 32 zero bytes — a well-formed Ed25519 key encoding standing in for the
// account's post-rotation key. It signs nothing here.
const ROTATED_IN_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

for (const name of ED25519_FIXTURES) {
  const entry = manifest[name];
  const pem = readFileSync(new URL(entry.file, FIXTURE_DIR), "utf8");
  const keyMaterial =
    entry.license_key === null
      ? undefined
      : { licenseKey: entry.license_key, fingerprint: entry.fingerprint };

  const keySet = SigningKeySet.fromPublicKeys([ROTATED_IN_KEY_B64, entry.public_key_b64]);
  if (keySet.size !== 2 || !keySet.has(entry.kid)) {
    throw new Error(`smoke test failed: key set did not index ${name} under ${entry.kid}`);
  }

  let expired = false;
  let verified;
  try {
    verified = await verifyMachineFileWithKeySet(pem, keySet, keyMaterial, 0);
  } catch (err) {
    if (err?.kind !== "expired") throw err;
    expired = true;
  }
  if (expired) {
    throw new Error(`smoke test failed: ${name} reported expired against a pre-issue clock`);
  }
  if (verified?.claims?.kid !== entry.kid) {
    throw new Error(
      `smoke test failed: ${name} verified through a key set but reported kid ${verified?.claims?.kid}`,
    );
  }

  // ...and a set that predates the rotation must fail distinguishably rather
  // than reporting the file as forged.
  const staleSet = SigningKeySet.fromPublicKeys([ROTATED_IN_KEY_B64]);
  let staleKind;
  try {
    await verifyMachineFileWithKeySet(pem, staleSet, keyMaterial, 0);
  } catch (err) {
    staleKind = err?.kind;
  }
  if (staleKind !== "unknown-key-id") {
    throw new Error(
      `smoke test failed: a stale key set reported "${staleKind}", expected "unknown-key-id"`,
    );
  }
}

// ── The heartbeat-window helpers, on every runtime ──────────────────────────
//
// Pure functions with no I/O, so a unit test proves the logic — what this
// proves is that they are actually reachable from the built ESM entrypoint on
// Deno and Bun, which a Node-only vitest run cannot show. A missing re-export
// would otherwise surface as a downstream `undefined is not a function`.

if (effectiveHeartbeatWindowMs({ id: "p", type: "policies", attributes: { heartbeat_duration: 60 } }) !== 60_000) {
  throw new Error("smoke test failed: effectiveHeartbeatWindowMs did not read the policy window");
}
if (effectiveHeartbeatWindowMs({ id: "p", type: "policies", attributes: { heartbeat_duration: null } }) !== MACHINE_HEARTBEAT_WINDOW_MS) {
  throw new Error("smoke test failed: effectiveHeartbeatWindowMs did not fall back to 600s");
}

const windowMs = heartbeatWindowMsFromMachine({
  id: "m",
  type: "machines",
  attributes: {
    last_heartbeat_at: "2026-08-21T00:00:00.000Z",
    next_heartbeat_at: "2026-08-21T00:01:00.000Z",
  },
});
if (windowMs !== 60_000) {
  throw new Error(`smoke test failed: heartbeatWindowMsFromMachine returned ${windowMs}, expected 60000`);
}

// `dispose()` on a client with no timers must be a no-op, not a throw — a
// teardown path calls it unconditionally.
client.dispose();

// Not linted by `pnpm lint` (scoped to src/test — see eslint.config.js);
// console output is fine here, this is a script, not library code.
console.log(
  `smoke: dist/index.js loaded, TamgaClient constructed, constructor validation ran, heartbeat-window helpers resolved, ${fixtureNames.length} server-produced machine files verified, their kids recomputed, and ${ED25519_FIXTURES.length} verified through a rotated signing-key set OK`,
);
