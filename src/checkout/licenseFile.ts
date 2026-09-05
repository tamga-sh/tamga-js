/**
 * `.lic` offline license file parse/verify/decrypt pipeline.
 *
 * Ground-truthed against `tamga-rust`'s `src/checkout/license_file.rs` (the
 * reference implementation for this SDK family) and the Tamga API protocol
 * specification §4.
 *
 * **File format**:
 * ```text
 * -----BEGIN LICENSE FILE-----
 * <base64 of JSON: { "enc": "<base64>", "sig": "<base64 ed25519 sig over enc's UTF-8 bytes>", "alg": "<algorithm string>" }>
 * -----END LICENSE FILE-----
 * ```
 *
 * **Format v2, and why v1 files are refused.** In v1 the `ttl`/`expiry` a
 * caller asked for lived only in the JSON:API envelope *around* the
 * certificate, never inside the signed bytes. A 24-hour trial file was
 * therefore cryptographically valid forever: the client is the attacker, so
 * any check built on the envelope is bypassed by keeping — or redistributing —
 * the raw `certificate` string. v2 moves `iat`/`exp`/`jti`/`kid` inside the
 * signature. Accepting both formats would give the old behaviour back, so a
 * file whose `alg` lacks the `+v2` suffix is rejected.
 *
 * `alg` is exactly `"base64+ed25519+v2"` (plain) or `"aes-256-gcm+ed25519+v2"`
 * (encrypted) — **Ed25519 only** for the checkout signature, independent of
 * the license's own key `scheme`.
 *
 * ⚠️ CRITICAL — the single highest-risk interop bug in a from-scratch
 * reimplementation of this format: the Ed25519 signature covers `enc`'s
 * ASCII/UTF-8 **string** bytes (the base64 string itself), NOT the
 * base64-decoded payload bytes. Verifying against the decoded bytes will
 * silently accept forged files in some cases and reject valid ones in
 * others.
 *
 * Verification flow:
 * 1. Strip the `-----BEGIN/END LICENSE FILE-----` PEM markers.
 * 2. Base64-decode the body → parse the inner `{ enc, sig, alg }` JSON.
 * 3. Base64-decode `sig`.
 * 4. Ed25519-verify `sig` against **`enc`'s ASCII/UTF-8 bytes — the base64
 *    STRING itself, not its decoded bytes**.
 * 5. Base64-decode `enc`.
 * 6. If `alg` contains `aes-256-gcm`: split `nonce(12B) ‖ ciphertext ‖
 *    tag(16B)`, AES-256-GCM-open with the key from
 *    `src/crypto/hkdf.ts::deriveLicenseFileKey` — HKDF-SHA256 (RFC 5869) with
 *    `salt = "tamga:license-file-key-v1"`, `ikm = <license key>`,
 *    `info = "license-file"`. The pre-v2 zero-pad/truncate transform is gone,
 *    not deprecated; there is no code path that still produces that key.
 * 7. Parse the resulting bytes as `{"data": <License>, "meta": <claims>}`.
 * 8. **Enforce `meta.exp`.** Steps 1-7 only establish that the file is
 *    authentic; without this step v2 buys nothing over v1.
 *
 * Other gotchas preserved here (doc comments, and enforced where code can):
 * - `includes` on the checkout response is **always `[]`** — there is no
 *   working `include[]` param despite the field existing; do not build a
 *   "checkout with embedded relationships" feature around it.
 * - `id` is a fresh UUIDv7 per call, **not idempotent** — calling checkout
 *   twice yields two different certificates (different signature nonce for
 *   the encrypted variant).
 * - The envelope's `ttl`/`expiry` fields are still metadata and still must not
 *   be trusted; the authoritative expiry is `meta.exp` inside the signed
 *   payload, which this module enforces. Historical note: `ttl`/`expiry` were **metadata only, not embedded in the signed
 *   payload**, and are **not re-checked by the server on any later
 *   validation** — expiry enforcement for an offline file is entirely this
 *   SDK's/caller's responsibility on the client side.
 */

import { CheckoutError } from "../errors.js";
import { verifyEd25519 } from "../crypto/ed25519.js";
import { decryptAesGcm } from "../crypto/aesGcm.js";
import { deriveLicenseFileKey } from "../crypto/hkdf.js";
import { base64Decode } from "../internal/base64.js";
import { findVerifyingKey, labelKeySetFailure, probeKeyIdClaim, type SigningKeySet } from "./keySet.js";
import type { License } from "../models/license.js";

const PEM_HEADER = "-----BEGIN LICENSE FILE-----";
const PEM_FOOTER = "-----END LICENSE FILE-----";
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/** Discriminated `alg` values for `.lic` files — Ed25519 only. */
export type LicenseFileAlgorithm = "base64+ed25519+v2" | "aes-256-gcm+ed25519+v2";

/** Parsed-but-unverified `.lic` file envelope. */
export interface ParsedLicenseFile {
  enc: string;
  sig: string;
  alg: string;
}

/** The `license-files` JSON:API resource returned by `POST .../licenses/{id}/actions/check-out`. */
export interface LicenseFileResource {
  /** Fresh UUIDv7 per call — **not idempotent**. */
  id: string;
  /** Always `"license-files"`. */
  type: "license-files";
  attributes: LicenseFile;
}

/** `{ certificate, algorithm, includes, ttl, expiry, issued }` — the checkout response attributes. */
export interface LicenseFile {
  /** The PEM-wrapped `.lic` certificate string — pass to {@link verifyAndDecryptLicenseFile}. */
  certificate: string;
  /** `"base64+ed25519+v2"` or `"aes-256-gcm+ed25519+v2"`, matching `certificate`'s inner `alg` field. */
  algorithm: LicenseFileAlgorithm;
  /**
   * **Always `[]`** — there is no working `include[]` param despite this
   * field existing; do not build a "checkout with embedded relationships"
   * feature around it.
   */
  includes: string[];
  /**
   * TTL in seconds, if requested. **Metadata only** — not embedded in the
   * signed payload, and not re-checked by the server on any later
   * validation.
   */
  ttl: number | null;
  /** Absolute expiry timestamp derived from `issued + ttl`, if `ttl` was set. */
  expiry: string | null;
  /** When this checkout call was issued. */
  issued: string;
}

/** Strips PEM markers, base64-decodes the body, and parses the inner `{ enc, sig, alg }` JSON. */
export function parseLicenseFile(pem: string): ParsedLicenseFile {
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
    typeof (parsed as ParsedLicenseFile).enc !== "string" ||
    typeof (parsed as ParsedLicenseFile).sig !== "string" ||
    typeof (parsed as ParsedLicenseFile).alg !== "string"
  ) {
    throw CheckoutError.invalidJson("expected { enc, sig, alg }");
  }
  return parsed as ParsedLicenseFile;
}

/**
 * The `alg` gate. Runs before any key or signature work on every entry point,
 * single-key and key-set alike, so a v1 file gets the same answer whichever
 * key it meets. Exactly two strings are legal; there is no v1 fallback — see
 * the module doc for why.
 */
function assertSupportedLicenseFileAlg(alg: string): LicenseFileAlgorithm {
  if (alg === "base64+ed25519+v2" || alg === "aes-256-gcm+ed25519+v2") return alg;
  throw CheckoutError.unsupportedAlgorithm(alg);
}

function decodeSignature(sig: string): Uint8Array {
  try {
    return base64Decode(sig);
  } catch {
    throw CheckoutError.invalidBase64();
  }
}

/**
 * Parses and fully verifies a `.lic` file (from either the client's raw PEM
 * string or a {@link LicenseFileResource}'s `certificate` field), returning
 * the embedded {@link License} once the signature (and decryption, if
 * encrypted) has checked out. Works fully offline — no network access
 * required — once `ed25519PublicKey` is embedded in the calling
 * application.
 *
 * `licenseKey` is required only for the encrypted (`aes-256-gcm+ed25519`)
 * variant; omit it for a plain (`base64+ed25519`) file.
 *
 * Only format v2 is accepted: `alg` must carry the `+v2` suffix and the signed
 * payload must carry its `meta` claims. A v1 file is rejected outright, with no
 * fallback — see the module doc comment for why.
 *
 * `meta.exp` is enforced here, not left to the caller: expiry is checked
 * against `now` (Unix seconds, defaulting to the system clock) with a
 * 60-second clock-skew tolerance, and an expired file throws a
 * `CheckoutError` of kind `"expired"`.
 *
 * See the module doc comment for the full verification flow this implements,
 * and `src/crypto/ed25519.ts` for the critical signing gotcha: the signature
 * covers the base64 **string**, not its decoded bytes. The AES key comes from
 * `src/crypto/hkdf.ts::deriveLicenseFileKey` (HKDF-SHA256).
 */
export async function verifyAndDecryptLicenseFile(
  pem: string,
  ed25519PublicKey: Uint8Array,
  licenseKey?: string,
  now?: number,
): Promise<License> {
  return (await verifyLicenseFileWithClaims(pem, ed25519PublicKey, licenseKey, now)).license;
}

/**
 * The claims carried *inside* the signed bytes.
 *
 * These are the point of format v2: unlike the response envelope, they cannot
 * be edited by whoever holds the file.
 */
export interface LicenseFileClaims {
  /** Issued-at, seconds since the Unix epoch. */
  iat: number;
  /**
   * Expiry, seconds since the Unix epoch. Absent means the file never expires
   * (checkout was made without a `ttl`).
   */
  exp?: number;
  /** Unique per checkout — usable for replay detection. */
  jti: string;
  /** Identifies the signing key, so a file survives a key rotation. */
  kid: string;
}

/** A verified license file: the resource plus the claims signed alongside it. */
export interface VerifiedLicenseFile {
  license: License;
  claims: LicenseFileClaims;
}

/**
 * How much clock skew to tolerate when checking `exp`.
 *
 * Deliberately small. The client's clock is under the attacker's control, so a
 * generous allowance is just a free extension on every expired file; this
 * covers ordinary NTP drift and nothing more.
 *
 * Exported so `src/checkout/machineFile.ts` enforces its own `meta.exp` with
 * this exact value rather than a second copy. The two formats carry the same
 * `LicenseFileClaims` and are issued by the same handler; if the constants ever
 * drifted, one of the two file types would silently get a different grace
 * period, and nothing in the build would notice.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/**
 * As {@link verifyAndDecryptLicenseFile}, also returning the signed claims.
 *
 * Use this when you want `jti` for replay detection or `kid` for key-rotation
 * bookkeeping. Expiry is enforced either way — it is not opt-in.
 *
 * `now` overrides the clock, in Unix seconds. Pass a server-supplied timestamp
 * if you are defending against a user winding their clock back to revive an
 * expired file.
 */
export async function verifyLicenseFileWithClaims(
  pem: string,
  ed25519PublicKey: Uint8Array,
  licenseKey?: string,
  now?: number,
): Promise<VerifiedLicenseFile> {
  const cert = parseLicenseFile(pem);
  const alg = assertSupportedLicenseFileAlg(cert.alg);
  const sigBytes = decodeSignature(cert.sig);

  // ⚠️ The signature covers `enc`'s ASCII/UTF-8 STRING bytes — the base64
  // STRING itself, never its decoded bytes. See src/crypto/ed25519.ts.
  const encStringBytes = new TextEncoder().encode(cert.enc);
  if (!verifyEd25519(encStringBytes, sigBytes, ed25519PublicKey)) {
    throw CheckoutError.cryptoFailure("signature verification failed", "signature");
  }

  const plaintext = await decodeLicenseFilePlaintext(cert, alg, licenseKey);
  return finishLicenseFile(plaintext, now);
}

/**
 * As {@link verifyLicenseFileWithClaims}, selecting the public key by the
 * file's own `kid` claim from a set of keys the caller already trusts.
 *
 * **This is what makes a signing-key rotation survivable.** Verifying against
 * one embedded key reports a file signed before the rotation with exactly the
 * error a forged file produces. Through a key set the two are distinct
 * outcomes:
 *
 * - no held key verifies the signature and the `kid` is not in the set →
 *   {@link import("../errors.js").SigningKeyError} of kind `"unknown-key-id"`
 *   (or `"no-published-signing-key"` when the file names the id of an empty
 *   key). Fetch the account's key set, or ship an application update, and try
 *   again — do not accuse the file;
 * - no held key verifies and the `kid` *is* in the set →
 *   {@link import("../errors.js").CheckoutError} of kind `"crypto"` with
 *   `reason: "signature"`. Refuse the file.
 *
 * Build the set with
 * {@link import("../client.js").TamgaClient.getSigningKeySet} (one call,
 * cacheable for the life of the process) or, with no network at all, from
 * public keys pinned in the binary via
 * {@link import("./keySet.js").SigningKeySet.fromPublicKeys}.
 *
 * `licenseKey` is required only for an encrypted file, and `meta.exp` is
 * enforced, both exactly as in {@link verifyLicenseFileWithClaims}. `now`
 * overrides the clock, in Unix seconds.
 *
 * The order is the same as {@link verifyLicenseFileWithClaims}'s: the `alg`
 * gate, then every held key against the signature over `enc`'s string bytes,
 * and only then is `enc` decoded — so nothing attacker-chosen reaches the
 * decoder, the cipher or the JSON parser on the success path. When no key
 * verifies, `enc` is decoded — and, when encrypted, decrypted under the
 * license key — solely to read `meta.kid` and label the failure. Once a
 * signature has verified, a `"crypto"` failure with `reason: "decryption"`
 * usually means the wrong license key — but not always: `alg` is not covered
 * by the signature, so a verified file whose `alg` was flipped from the plain
 * to the encrypted variant produces this same reason even with the correct
 * key. See {@link import("../errors.js").CheckoutError}'s `reason` doc
 * comment for the full explanation.
 */
export async function verifyLicenseFileWithKeySet(
  pem: string,
  keySet: SigningKeySet,
  licenseKey?: string,
  now?: number,
): Promise<VerifiedLicenseFile> {
  const cert = parseLicenseFile(pem);
  const alg = assertSupportedLicenseFileAlg(cert.alg);
  const sigBytes = decodeSignature(cert.sig);

  // ⚠️ Every held key against `enc`'s STRING bytes, before a byte of `enc`
  // is decoded — the same order as the single-key path.
  const encStringBytes = new TextEncoder().encode(cert.enc);
  if (findVerifyingKey(keySet, encStringBytes, sigBytes) === undefined) {
    // No held key signed this. `enc` is opened now, and only now, and only
    // so the `kid` it names can label the failure.
    throw await labelKeySetFailure(keySet, () =>
      decodeLicenseFilePlaintext(cert, alg, licenseKey),
    );
  }

  const plaintext = await decodeLicenseFilePlaintext(cert, alg, licenseKey);
  // Every v2 file names its key. A verified payload without a `kid` is
  // malformed, not merely unlabelled — the same rule as tamga-rust's `finish`.
  probeKeyIdClaim(plaintext);
  return finishLicenseFile(plaintext, now);
}

/**
 * Base64-decodes `enc` and — for the encrypted variant — AES-256-GCM-opens it
 * with the HKDF-derived license-file key. `alg` comes from
 * {@link assertSupportedLicenseFileAlg}, which every caller has already run.
 *
 * Shared by {@link verifyLicenseFileWithClaims} and
 * {@link verifyLicenseFileWithKeySet}; on both it runs after the signature has
 * verified, with one exception — the key-set failure path opens `enc` solely
 * to read the `kid` that labels the failure.
 */
async function decodeLicenseFilePlaintext(
  cert: ParsedLicenseFile,
  alg: LicenseFileAlgorithm,
  licenseKey: string | undefined,
): Promise<Uint8Array> {
  let encBytes: Uint8Array;
  try {
    encBytes = base64Decode(cert.enc);
  } catch {
    throw CheckoutError.invalidBase64();
  }

  if (alg === "base64+ed25519+v2") {
    return encBytes;
  }
  if (licenseKey === undefined) {
    throw CheckoutError.licenseKeyMissing();
  }
  if (encBytes.length < NONCE_LENGTH + TAG_LENGTH) {
    throw CheckoutError.cryptoFailure("decryption failed (wrong key or tampered ciphertext)");
  }
  const key = deriveLicenseFileKey(licenseKey);
  const nonce = encBytes.subarray(0, NONCE_LENGTH);
  const ciphertextAndTag = encBytes.subarray(NONCE_LENGTH);
  try {
    return await decryptAesGcm(nonce, ciphertextAndTag, key);
  } catch {
    throw CheckoutError.cryptoFailure(
      "decryption failed (wrong key or tampered ciphertext)",
      "decryption",
    );
  }
}

/**
 * Parses an authenticated payload and enforces its signed `exp` claim.
 *
 * Only ever called on bytes whose signature has verified.
 */
function finishLicenseFile(plaintext: Uint8Array, now: number | undefined): VerifiedLicenseFile {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw CheckoutError.invalidJson(error instanceof Error ? error.message : String(error));
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload)
  ) {
    throw CheckoutError.invalidJson('expected {"data": <License>}');
  }
  // Second line behind the `alg` gate: a file must not reach the expiry check
  // with nothing to check.
  // `typeof null === "object"` and so is an array, so neither extra check is
  // redundant: without the null check a `"meta": null` payload reaches the
  // expiry check and dies on a property access instead of returning a typed
  // CheckoutError, and an array `meta` would read `claims.exp` as `undefined`
  // and skip expiry enforcement silently.
  const meta = (payload as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw CheckoutError.invalidJson(
      "payload is missing the signed 'meta' claims (this looks like a pre-v2 file)",
    );
  }
  const claims = meta as LicenseFileClaims;

  // The signature proves the file is authentic. It does not prove it is still
  // valid — that is this check, and skipping it is what made v1 files
  // permanent.
  if (typeof claims.exp === "number") {
    const reference = now ?? Math.floor(Date.now() / 1000);
    if (reference - CLOCK_SKEW_TOLERANCE_SECONDS > claims.exp) {
      throw CheckoutError.expired(claims.exp);
    }
  }

  return { license: (payload as { data: License }).data, claims };
}
