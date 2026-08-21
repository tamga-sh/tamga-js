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

import { TamgaClient, verifyAndDecryptMachineFile, verifyMachineFileWithClaims } from "../dist/index.js";

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

// Not linted by `pnpm lint` (scoped to src/test — see eslint.config.js);
// console output is fine here, this is a script, not library code.
console.log(
  `smoke: dist/index.js loaded, TamgaClient constructed, constructor validation ran, and ${fixtureNames.length} server-produced machine files verified OK`,
);
