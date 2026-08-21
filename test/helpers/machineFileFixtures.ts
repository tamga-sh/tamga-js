/**
 * Loader for the server-produced machine-file fixtures in
 * `test/fixtures/machine-file-v2/`.
 *
 * ⚠️ Nothing here builds a certificate. Every byte under test comes from the
 * Tamga API's own `encode_machine_file` — see that directory's
 * `PROVENANCE.md` for why a self-generated fixture is worse than no fixture
 * on this code path.
 *
 * Reading is deliberately `node:fs` + `new URL(..., import.meta.url)`: that
 * pair resolves and reads identically on Node, Deno (`--allow-read`) and Bun,
 * which is what `scripts/smoke.mjs` exercises the built output with. A bundler
 * -specific JSON import or a `process.cwd()`-relative path would work under
 * vitest and break on one of the other two.
 */

import { hkdfSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

import type { LicenseScheme } from "../../src/models/policy.js";

const FIXTURE_DIR = new URL("../fixtures/machine-file-v2/", import.meta.url);

/**
 * One `manifest.json` entry. Field meanings are documented in
 * `test/fixtures/machine-file-v2/PROVENANCE.md`.
 */
export interface MachineFixtureEntry {
  file: string;
  alg: string;
  encrypted: boolean;
  enc_is_dot_separated: boolean;
  public_key_b64: string;
  kid: string;
  license_key: string | null;
  fingerprint: string;
  expired: boolean;
  /** The server's Rust variant name — map with {@link schemeFromManifest}. */
  scheme: string;
}

/**
 * The manifest's `scheme` is the server's `LicenseScheme` **Rust variant
 * name**, not this SDK's wire literal. Mapping here rather than in the specs
 * keeps the fixtures loadable verbatim: the manifest is copied byte-for-byte
 * from the generator's output and must not be rewritten to suit the SDK.
 */
const SCHEME_BY_MANIFEST_NAME: Record<string, LicenseScheme> = {
  Ed25519Sign: "ED25519_SIGN",
  EcdsaP256Sign: "ECDSA_P256_SIGN",
  Rsa2048Pkcs1Sign: "RSA_2048_PKCS1_SIGN",
  Rsa2048Pkcs1PssSign: "RSA_2048_PKCS1_PSS_SIGN",
  Rsa2048JwtRs256: "RSA_2048_JWT_RS256",
};

/** Maps a manifest `scheme` string onto the SDK's {@link LicenseScheme}. */
export function schemeFromManifest(name: string): LicenseScheme {
  const scheme = SCHEME_BY_MANIFEST_NAME[name];
  if (scheme === undefined) {
    throw new Error(
      `unknown manifest scheme "${name}" — add it to SCHEME_BY_MANIFEST_NAME, do not skip the fixture`,
    );
  }
  return scheme;
}

/** Every fixture in the manifest, as `[name, entry]` pairs, sorted by name. */
export function loadMachineFixtureManifest(): [string, MachineFixtureEntry][] {
  const raw = readFileSync(new URL("manifest.json", FIXTURE_DIR), "utf8");
  const parsed = JSON.parse(raw) as Record<string, MachineFixtureEntry>;
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error("machine-file fixture manifest is empty — the fixture set failed to load");
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

/** Reads a fixture's PEM text. */
export function readMachineFixturePem(entry: MachineFixtureEntry): string {
  return readFileSync(new URL(entry.file, FIXTURE_DIR), "utf8");
}

/** The `{ licenseKey, fingerprint }` an encrypted fixture needs, or `undefined`. */
export function keyMaterialFor(
  entry: MachineFixtureEntry,
): { licenseKey: string; fingerprint: string } | undefined {
  if (entry.license_key === null) return undefined;
  return { licenseKey: entry.license_key, fingerprint: entry.fingerprint };
}

/**
 * Decodes a fixture's raw public key.
 *
 * Standard base64 via `Buffer` rather than the SDK's own `base64Decode`: a
 * test must not depend on the module it is testing to read its own inputs.
 */
export function publicKeyFor(entry: MachineFixtureEntry): Uint8Array {
  return new Uint8Array(Buffer.from(entry.public_key_b64, "base64"));
}

/**
 * Re-wraps a certificate into a PEM after mutating its `{ enc, sig, alg }`
 * fields — for the negative cases (tampered `enc`, stripped `+v2`).
 *
 * Note `alg` is **not** covered by the signature; only `enc`'s string bytes
 * are. Rewriting `alg` therefore needs no re-signing, which is precisely why
 * the `+v2` gate has to hold on its own rather than riding on signature
 * validity.
 */
export function rewrapMachinePem(
  pem: string,
  patch: Partial<{ enc: string; sig: string; alg: string }>,
): string {
  const trimmed = pem.trim();
  const header = "-----BEGIN MACHINE FILE-----";
  const footer = "-----END MACHINE FILE-----";
  const body = trimmed.slice(header.length, trimmed.length - footer.length).trim();
  const cert = JSON.parse(Buffer.from(body, "base64").toString("utf8")) as {
    enc: string;
    sig: string;
    alg: string;
  };
  const next = { ...cert, ...patch };
  const encoded = Buffer.from(JSON.stringify(next), "utf8").toString("base64");
  return `${header}\n${encoded}\n${footer}`;
}

/** Reads a fixture's inner `{ enc, sig, alg }` without going through the SDK. */
export function readMachineCert(entry: MachineFixtureEntry): {
  enc: string;
  sig: string;
  alg: string;
} {
  const trimmed = readMachineFixturePem(entry).trim();
  const header = "-----BEGIN MACHINE FILE-----";
  const footer = "-----END MACHINE FILE-----";
  const body = trimmed.slice(header.length, trimmed.length - footer.length).trim();
  return JSON.parse(Buffer.from(body, "base64").toString("utf8")) as {
    enc: string;
    sig: string;
    alg: string;
  };
}

/**
 * Reads a fixture's signed `meta` claims **without** using `src/` — Node's own
 * crypto only, so the specs can anchor their reference clock to the file's own
 * `iat` before trusting anything the SDK says about it.
 *
 * This is not a second implementation of the verifier: no signature is checked
 * here and nothing is asserted about the format. It exists because a fixture's
 * `exp` is `iat ± 3600`, so any test comparing against the wall clock would go
 * green for one hour after the fixtures were minted and red forever after.
 * Anchoring to `iat` makes the expiry assertions reproducible on any machine at
 * any date.
 */
export async function signedClaimsOf(entry: MachineFixtureEntry): Promise<{
  iat: number;
  exp?: number;
  jti: string;
  kid: string;
}> {
  const { enc } = readMachineCert(entry);

  let plaintext: Buffer;
  if (entry.license_key === null) {
    plaintext = Buffer.from(enc, "base64");
  } else {
    const dot = enc.indexOf(".");
    const nonce = Buffer.from(enc.slice(0, dot), "base64");
    const ciphertextAndTag = Buffer.from(enc.slice(dot + 1), "base64");
    const key = new Uint8Array(
      hkdfSync(
        "sha256",
        Buffer.from(entry.license_key, "utf8"),
        Buffer.from("tamga:machine-file-key-v1", "utf8"),
        Buffer.from(entry.fingerprint, "utf8"),
        32,
      ),
    );
    const cryptoKey = await webcrypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    plaintext = Buffer.from(
      await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, tagLength: 128 },
        cryptoKey,
        ciphertextAndTag,
      ),
    );
  }

  const payload = JSON.parse(plaintext.toString("utf8")) as {
    meta: { iat: number; exp?: number; jti: string; kid: string };
  };
  return payload.meta;
}
