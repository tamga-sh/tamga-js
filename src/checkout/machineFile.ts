/**
 * `MACHINE FILE` offline machine file parse/verify/decrypt pipeline.
 *
 * Ground-truthed against `tamga-rust`'s `src/checkout/machine_file.rs` (the
 * reference implementation for this SDK family) and the Tamga API protocol
 * specification §6.
 *
 * Same inner `{enc, sig, alg}` JSON structure as license files, but wrapped
 * in `-----BEGIN MACHINE FILE-----`/`-----END MACHINE FILE-----` markers,
 * with these machine-specific differences from `licenseFile.ts`:
 *
 * - Signing scheme is taken from the **license's** `scheme` field, NOT
 *   hardcoded Ed25519. The verify dispatcher branches by `LicenseScheme`.
 * - ⚠️ `RSA_2048_JWT_RS256` is explicitly rejected server-side for machine
 *   files (`422 SCHEME_NOT_SUPPORTED`). The dispatcher throws a clear
 *   "unsupported scheme" error for it — up front, before any parsing —
 *   never falling through to another verify function, which would silently
 *   mis-verify.
 * - Algorithm selection is driven by the caller-supplied `scheme`
 *   parameter, never by parsing the file's self-declared `alg` string: both
 *   `RSA_2048_PKCS1_SIGN` and `RSA_2048_JWT_RS256` map to the same
 *   `"rsa-sha256"` `alg` suffix server-side, so a self-declared string can't
 *   disambiguate those two schemes — trusting untrusted input to select a
 *   crypto primitive is an algorithm-confusion risk regardless of that
 *   collision. The file's declared suffix is still cross-checked against
 *   what `scheme` implies, so a file/scheme mismatch fails clearly instead
 *   of attempting a verification that can't succeed.
 * - Encryption key (when encrypted) is HKDF-SHA256 (`src/crypto/hkdf.ts`), as
 *   it is for license files — but with different parameters, and the two must
 *   not be conflated. A machine file binds `salt =
 *   "tamga:machine-file-key-v1"`, `ikm = <license key>`, `info =
 *   <fingerprint>`, so decrypting it requires BOTH the license key and the
 *   target machine's fingerprint; a license file uses `salt =
 *   "tamga:license-file-key-v1"`, `info = "license-file"` and needs only the
 *   license key.
 * - There is no `+v2` suffix and no signed `meta` claim set on this format —
 *   that is license-file-only. A machine file's `ttl`/`expiry` are still
 *   envelope metadata that this SDK cannot enforce; see {@link checkTtl}.
 * - `ttl` is validated server-side (`>0`, `<=31536000` / 365 days) — see
 *   {@link checkTtl} for the client-side pre-check mirroring that range.
 */

import { CheckoutError } from "../errors.js";
import { verifyEd25519 } from "../crypto/ed25519.js";
import { verifyRsaPkcs1, verifyRsaPss } from "../crypto/rsa.js";
import { verifyEcdsaP256 } from "../crypto/ecdsa.js";
import { deriveHkdfKey } from "../crypto/hkdf.js";
import { decryptAesGcm } from "../crypto/aesGcm.js";
import { base64Decode } from "../internal/base64.js";
import type { Machine } from "../models/machine.js";
import type { LicenseScheme } from "../models/policy.js";

const PEM_HEADER = "-----BEGIN MACHINE FILE-----";
const PEM_FOOTER = "-----END MACHINE FILE-----";
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = new TextEncoder().encode("tamga:machine-file-key-v1");

/** Maximum `ttl` seconds the server accepts (365 days) — see {@link checkTtl}. */
export const MAX_TTL_SECS = 365 * 24 * 3600;

/**
 * Client-side pre-check mirroring the server's validated `ttl` range
 * (`> 0 && <= 31536000`), so a caller gets a typed error before the round
 * trip instead of only discovering the problem via a `422 TTL_INVALID` API
 * error.
 */
export function checkTtl(ttl: number): void {
  if (ttl <= 0 || ttl > MAX_TTL_SECS) {
    throw CheckoutError.ttlOutOfRange(`must be > 0 and <= ${MAX_TTL_SECS}, got ${ttl}`);
  }
}

/** Parsed-but-unverified machine file envelope. */
export interface ParsedMachineFile {
  enc: string;
  sig: string;
  alg: string;
}

/** The `machine-files` JSON:API resource returned by `POST .../machines/{id}/actions/check-out`. */
export interface MachineFileResource {
  /** Fresh UUIDv7 per call — not idempotent, same as license files. */
  id: string;
  /** Always `"machine-files"`. */
  type: "machine-files";
  attributes: MachineFile;
}

/** `{ certificate, algorithm, includes, ttl, expiry, issued }` — same shape as {@link import("./licenseFile.js").LicenseFile}. */
export interface MachineFile {
  /** The PEM-wrapped `.mach` certificate string — pass to {@link verifyAndDecryptMachineFile}. */
  certificate: string;
  /** `"{base64|aes-256-gcm}+{ed25519|rsa-sha256|rsa-pss-sha256|ecdsa-p256}"`. */
  algorithm: string;
  /** Always `[]` — same caveat as license files. */
  includes: string[];
  /** TTL in seconds, if requested. Metadata only — same caveat as license files. */
  ttl: number | null;
  /** Absolute expiry timestamp, if `ttl` was set. */
  expiry: string | null;
  /** When this checkout call was issued. */
  issued: string;
}

/**
 * Maps a {@link LicenseScheme} to its `alg` suffix, per the Tamga API's
 * `scheme_to_alg_suffix`. Note both `RSA_2048_PKCS1_SIGN` and
 * `RSA_2048_JWT_RS256` map to the same `"rsa-sha256"` suffix server-side —
 * exactly why {@link verifyAndDecryptMachineFile} always dispatches on the
 * caller-supplied `scheme`, never on this string alone.
 */
function schemeAlgSuffix(scheme: LicenseScheme): string {
  switch (scheme) {
    case "ED25519_SIGN":
      return "ed25519";
    case "RSA_2048_PKCS1_SIGN":
    case "RSA_2048_JWT_RS256":
      return "rsa-sha256";
    case "RSA_2048_PKCS1_PSS_SIGN":
      return "rsa-pss-sha256";
    case "ECDSA_P256_SIGN":
      return "ecdsa-p256";
  }
}

/** Strips PEM markers, base64-decodes the body, and parses the inner `{ enc, sig, alg }` JSON. */
export function parseMachineFile(pem: string): ParsedMachineFile {
  const trimmed = pem.trim();
  if (!trimmed.startsWith(PEM_HEADER) || !trimmed.endsWith(PEM_FOOTER)) {
    throw CheckoutError.malformedPem();
  }
  const body = trimmed.slice(PEM_HEADER.length, trimmed.length - PEM_FOOTER.length).trim();

  let certJson: Uint8Array;
  try {
    certJson = base64Decode(body);
  } catch {
    throw CheckoutError.invalidBase64();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(certJson));
  } catch (error) {
    throw CheckoutError.invalidJson(error instanceof Error ? error.message : String(error));
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ParsedMachineFile).enc !== "string" ||
    typeof (parsed as ParsedMachineFile).sig !== "string" ||
    typeof (parsed as ParsedMachineFile).alg !== "string"
  ) {
    throw CheckoutError.invalidJson("expected { enc, sig, alg }");
  }
  return parsed as ParsedMachineFile;
}

/**
 * Parses and fully verifies a `.mach` file, returning the embedded
 * {@link Machine} once the signature (and decryption, if encrypted) has
 * checked out.
 *
 * The returned machine's `heartbeat_status` is a **real staleness verdict**,
 * unlike the one a ping hands back: the server resolves the machine for
 * checkout through a lookup that joins the policy and reads a row nobody
 * just wrote, so this is the one place in this SDK where
 * {@link import("../models/machine.js").HeartbeatStatus} can legitimately be
 * `"DEAD"`. It is a snapshot from issue time, not a live reading, and
 * `DEAD` still does not mean the row was culled — see that type's doc.
 *
 * `scheme` **must** come from the license's own `scheme` field (via
 * whatever license resource governs this machine) — never from parsing the
 * file's `alg` string, which cannot safely disambiguate `RSA_2048_PKCS1_SIGN`
 * from `RSA_2048_JWT_RS256`. If the license has no `scheme` set, pass
 * `"ED25519_SIGN"` — the server's own default when generating a machine
 * file for an unset scheme.
 *
 * `publicKey` is the raw public key for `scheme`: 32 bytes for Ed25519, a
 * SubjectPublicKeyInfo (SPKI) DER blob for either RSA variant, or a 65-byte
 * uncompressed P-256 point for ECDSA.
 *
 * `licenseKey`/`fingerprint` are required only for an encrypted
 * (`aes-256-gcm+...`) file — both are needed to re-derive the HKDF key
 * (see `src/crypto/hkdf.ts`). Decrypting a machine file requires BOTH the
 * license key and the target machine's fingerprint — unlike license-file
 * decryption, which needs only the license key.
 */
export async function verifyAndDecryptMachineFile(
  pem: string,
  scheme: LicenseScheme,
  publicKey: Uint8Array,
  keyMaterial?: { licenseKey: string; fingerprint: string },
): Promise<Machine> {
  // ⚠️ Reject up front — before any parsing — rather than let a JWT-scheme
  // signature attempt fail confusingly downstream.
  if (scheme === "RSA_2048_JWT_RS256") {
    throw CheckoutError.schemeNotSupported();
  }

  const cert = parseMachineFile(pem);

  const separatorIndex = cert.alg.indexOf("+");
  if (separatorIndex < 0) {
    throw CheckoutError.unsupportedAlgorithm(cert.alg);
  }
  const encPrefix = cert.alg.slice(0, separatorIndex);
  const algSuffix = cert.alg.slice(separatorIndex + 1);
  const expectedSuffix = schemeAlgSuffix(scheme);
  if (algSuffix !== expectedSuffix) {
    throw CheckoutError.unsupportedAlgorithm(
      `file declares alg suffix "${algSuffix}", expected "${expectedSuffix}" for the supplied scheme`,
    );
  }

  // ⚠️ Same gotcha as license files: signature covers `enc`'s ASCII/UTF-8
  // STRING bytes, never its decoded bytes.
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64Decode(cert.sig);
  } catch {
    throw CheckoutError.invalidBase64();
  }
  const encStringBytes = new TextEncoder().encode(cert.enc);

  const verified = await verifySignatureForScheme(scheme, encStringBytes, sigBytes, publicKey);
  if (!verified) {
    throw CheckoutError.cryptoFailure("signature verification failed");
  }

  let encBytes: Uint8Array;
  try {
    encBytes = base64Decode(cert.enc);
  } catch {
    throw CheckoutError.invalidBase64();
  }

  let plaintext: Uint8Array;
  if (encPrefix === "base64") {
    plaintext = encBytes;
  } else if (encPrefix === "aes-256-gcm") {
    if (keyMaterial === undefined) {
      throw CheckoutError.licenseKeyMissing();
    }
    if (encBytes.length < NONCE_LENGTH + TAG_LENGTH) {
      throw CheckoutError.cryptoFailure("decryption failed (wrong key or tampered ciphertext)");
    }
    const key = deriveHkdfKey(
      new TextEncoder().encode(keyMaterial.licenseKey),
      HKDF_SALT,
      new TextEncoder().encode(keyMaterial.fingerprint),
    );
    const nonce = encBytes.subarray(0, NONCE_LENGTH);
    const ciphertextAndTag = encBytes.subarray(NONCE_LENGTH);
    try {
      plaintext = await decryptAesGcm(nonce, ciphertextAndTag, key);
    } catch {
      throw CheckoutError.cryptoFailure("decryption failed (wrong key or tampered ciphertext)");
    }
  } else {
    throw CheckoutError.unsupportedAlgorithm(cert.alg);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw CheckoutError.invalidJson(error instanceof Error ? error.message : String(error));
  }
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw CheckoutError.invalidJson('expected {"data": <Machine>}');
  }
  return (payload as { data: Machine }).data;
}

/**
 * Dispatches signature verification to the crypto primitive matching
 * `scheme`. `RSA_2048_JWT_RS256` is provably unreachable here given the
 * early-return guard in {@link verifyAndDecryptMachineFile}, but is handled
 * with a typed error rather than an assertion — a future refactor that
 * moves or removes that guard must still fail safe on attacker-controlled
 * input, not silently fall through to a different verify function.
 */
async function verifySignatureForScheme(
  scheme: LicenseScheme,
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  switch (scheme) {
    case "ED25519_SIGN":
      if (publicKey.length !== 32) throw CheckoutError.cryptoFailure("invalid public key");
      return verifyEd25519(message, signature, publicKey);
    case "RSA_2048_PKCS1_SIGN":
      return verifyRsaPkcs1(message, signature, publicKey);
    case "RSA_2048_PKCS1_PSS_SIGN":
      return verifyRsaPss(message, signature, publicKey);
    case "ECDSA_P256_SIGN":
      return verifyEcdsaP256(message, signature, publicKey);
    case "RSA_2048_JWT_RS256":
      throw CheckoutError.schemeNotSupported();
  }
}
