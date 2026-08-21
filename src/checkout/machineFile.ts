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
 * - `ttl` is validated server-side (`>0`, `<=31536000` / 365 days) — see
 *   {@link checkTtl} for the client-side pre-check mirroring that range.
 *
 * ## `alg` is three segments, and the last one is mandatory
 *
 * `machine_file_alg_str` builds `"{encoding}+{signing suffix}+v2"`:
 *
 * | segment | values |
 * | --- | --- |
 * | encoding | `base64` · `aes-256-gcm` |
 * | signing suffix | `ed25519` · `ecdsa-p256` · `rsa-sha256` · `rsa-pss-sha256` |
 *
 * So a default plain file is `base64+ed25519+v2` and an encrypted one is
 * `aes-256-gcm+ed25519+v2`. Both the encoding prefix and two of the signing
 * suffixes contain hyphens, so the segments are cut at the **first** and
 * **last** `+`, never at a fixed index and never by comparing the whole
 * remainder after one split.
 *
 * A file whose `alg` lacks `+v2` is **rejected**, with no fallback. A v1 file
 * carried no `meta.exp` inside the signed payload and derived its AES key by
 * zero-padding the license key instead of through HKDF; accepting one
 * reinstates both weaknesses. The check is exact, not a substring test —
 * `base64+ed25519+v3` and `base64+ed25519+v2junk` are refused too. Note `alg`
 * is not covered by the signature, so this gate has to hold on its own rather
 * than riding on signature validity.
 *
 * ## An encrypted `enc` is two base64 strings, not one
 *
 * `FieldEncryption::encrypt` returns `"{nonce_b64}.{cipher_b64}"` — the halves
 * are encoded **separately**, and `cipher_b64` already carries the 16-byte GCM
 * tag. Decode each side independently; do not decode once and slice 12 bytes
 * off the front. (The server's own doc comment at `machine_file.rs:59` says
 * `base64(nonce‖ciphertext‖tag)` and contradicts the code five lines below it;
 * that stale comment is why every SDK in this family implemented the same
 * wrong thing. Reported upstream as `tamga-api-internal#2`.)
 *
 * Order matters: the signature covers `enc`'s **string** bytes, so it is
 * verified first, and only then is `enc` split, decoded and decrypted. Never
 * decode attacker-controlled bytes before authenticating them. Plain files
 * remain a single base64 blob with no dot — the branch is on the encoding
 * prefix from `alg`, not on whether a dot happens to be present.
 *
 * ## The payload carries signed claims, and `exp` is enforced
 *
 * The signed bytes are `{"data": <Machine>, "meta": <claims>}`, where `meta` is
 * the same `LicenseFileClaims` a license file carries (`iat`/`exp`/`jti`/
 * `kid`) — the checkout handler builds both from the same struct. `exp` is
 * enforced here with the license-file path's own
 * {@link import("./licenseFile.js").CLOCK_SKEW_TOLERANCE_SECONDS}, and an
 * expired file throws a `CheckoutError` of kind `"expired"` — the same
 * outcome an expired license file produces, so a caller can tell "fetch a
 * fresh one" from "forged or corrupt".
 *
 * `exp` is optional by design: `check_out_machine.rs` sets it to `ttl.map(..)`,
 * so a checkout made without a TTL genuinely never expires. A missing `exp` is
 * legitimate and is not an error. The envelope's `ttl`/`expiry` fields remain
 * unsigned metadata and are still not trustworthy; `meta.exp` is the
 * authoritative one.
 */

import { CheckoutError } from "../errors.js";
import { verifyEd25519 } from "../crypto/ed25519.js";
import { verifyRsaPkcs1, verifyRsaPss } from "../crypto/rsa.js";
import { verifyEcdsaP256 } from "../crypto/ecdsa.js";
import { deriveHkdfKey, MACHINE_FILE_KEY_SALT } from "../crypto/hkdf.js";
import { decryptAesGcm } from "../crypto/aesGcm.js";
import { base64Decode } from "../internal/base64.js";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "./licenseFile.js";
import type { LicenseFileClaims } from "./licenseFile.js";
import type { Machine } from "../models/machine.js";
import type { LicenseScheme } from "../models/policy.js";

const PEM_HEADER = "-----BEGIN MACHINE FILE-----";
const PEM_FOOTER = "-----END MACHINE FILE-----";
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * The mandatory trailing segment of a machine file's `alg`. Its absence marks
 * a v1 file, which is refused — see the module doc comment.
 */
const FORMAT_VERSION_MARKER = "v2";

/** Separator between an encrypted `enc`'s two independently-base64'd halves. */
const ENC_PART_SEPARATOR = ".";

/** The two encoding prefixes `machine_file_alg_str` can emit. */
const ENCODING_PREFIX_PLAIN = "base64";
const ENCODING_PREFIX_ENCRYPTED = "aes-256-gcm";

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
  /**
   * `"{base64|aes-256-gcm}+{ed25519|rsa-sha256|rsa-pss-sha256|ecdsa-p256}+v2"`.
   *
   * Same string the certificate carries in its own `alg` field — the server
   * formats both from `machine_file_alg_str`, after a period when the two were
   * built independently and the certificate advertised `v1` while the response
   * beside it advertised `v2`.
   */
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

/** The encoding half of a machine file's `alg`, once validated. */
type MachineFileEncoding = typeof ENCODING_PREFIX_PLAIN | typeof ENCODING_PREFIX_ENCRYPTED;

/**
 * Splits `alg` into its encoding prefix and signing suffix, enforcing the
 * mandatory `+v2` marker.
 *
 * Cut at the **first** and **last** `+`: `aes-256-gcm` and `rsa-pss-sha256`
 * both contain hyphens but neither contains a `+`, so the outer two separators
 * are unambiguous while a fixed index or a single `split_once` is not. The
 * middle segment is the signing suffix; it is returned for the caller to
 * cross-check against the scheme it was given, never to select a primitive.
 *
 * The version marker is compared for equality, not containment: a substring
 * test would also accept `base64+ed25519+v3` and `base64+ed25519+v2junk`.
 */
function parseMachineFileAlg(alg: string): { encoding: MachineFileEncoding; suffix: string } {
  const firstPlus = alg.indexOf("+");
  const lastPlus = alg.lastIndexOf("+");
  // Fewer than three segments — a v1 `"{encoding}+{suffix}"` string, or junk.
  if (firstPlus < 0 || lastPlus === firstPlus) {
    throw CheckoutError.unsupportedAlgorithm(alg);
  }
  if (alg.slice(lastPlus + 1) !== FORMAT_VERSION_MARKER) {
    throw CheckoutError.unsupportedAlgorithm(alg);
  }

  const encoding = alg.slice(0, firstPlus);
  if (encoding !== ENCODING_PREFIX_PLAIN && encoding !== ENCODING_PREFIX_ENCRYPTED) {
    throw CheckoutError.unsupportedAlgorithm(alg);
  }

  const suffix = alg.slice(firstPlus + 1, lastPlus);
  if (suffix.length === 0) {
    throw CheckoutError.unsupportedAlgorithm(alg);
  }
  return { encoding, suffix };
}

/**
 * Splits an already-authenticated encrypted `enc` into its nonce and
 * ciphertext-with-tag, decoding the two halves independently.
 *
 * Only ever called after the signature over `enc`'s string bytes has verified.
 */
function decodeEncryptedEnc(enc: string): { nonce: Uint8Array; ciphertextAndTag: Uint8Array } {
  const separator = enc.indexOf(ENC_PART_SEPARATOR);
  if (separator < 0) {
    throw CheckoutError.cryptoFailure(
      'encrypted payload is not "<nonce_b64>.<ciphertext_b64>" (missing separator)',
    );
  }

  let nonce: Uint8Array;
  let ciphertextAndTag: Uint8Array;
  try {
    nonce = base64Decode(enc.slice(0, separator));
    ciphertextAndTag = base64Decode(enc.slice(separator + 1));
  } catch {
    throw CheckoutError.invalidBase64();
  }

  if (nonce.length !== NONCE_LENGTH || ciphertextAndTag.length < TAG_LENGTH) {
    throw CheckoutError.cryptoFailure("decryption failed (wrong key or tampered ciphertext)");
  }
  return { nonce, ciphertextAndTag };
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
 * The same read gives you the machine's **effective heartbeat window**:
 * `next_heartbeat_at - last_heartbeat_at` is `policy.heartbeat_duration` in
 * milliseconds, which no other response in this SDK reports truthfully. See
 * {@link import("../models/machine.js").MachineAttributes.next_heartbeat_at}.
 *
 * `scheme` **must** come from the license's own `scheme` field (via
 * whatever license resource governs this machine) — never from parsing the
 * file's `alg` string, which cannot safely disambiguate `RSA_2048_PKCS1_SIGN`
 * from `RSA_2048_JWT_RS256`. If the license has no `scheme` set, pass
 * `"ED25519_SIGN"` — the server's own default when generating a machine
 * file for an unset scheme.
 *
 * `publicKey` is the account's public key for `scheme`: 32 raw bytes for
 * Ed25519, a 65-byte uncompressed P-256 point for ECDSA, or — for either RSA
 * variant — the RSA public key in DER, in **either** the PKCS#1
 * `RSAPublicKey` encoding the server publishes or SPKI. See
 * `src/crypto/rsa.ts`.
 *
 * `licenseKey`/`fingerprint` are required only for an encrypted
 * (`aes-256-gcm+...`) file — both are needed to re-derive the HKDF key
 * (see `src/crypto/hkdf.ts`). Decrypting a machine file requires BOTH the
 * license key and the target machine's fingerprint — unlike license-file
 * decryption, which needs only the license key.
 *
 * `meta.exp` is enforced here, not left to the caller, exactly as it is for
 * license files: an expired file throws a `CheckoutError` of kind `"expired"`.
 * `now` overrides the clock, in Unix seconds — pass a server-supplied
 * timestamp if you are defending against a user winding their clock back to
 * revive an expired file, since the local clock belongs to whoever holds the
 * file. Use {@link verifyMachineFileWithClaims} when you also want `jti` or
 * `kid` back.
 */
export async function verifyAndDecryptMachineFile(
  pem: string,
  scheme: LicenseScheme,
  publicKey: Uint8Array,
  keyMaterial?: { licenseKey: string; fingerprint: string },
  now?: number,
): Promise<Machine> {
  return (await verifyMachineFileWithClaims(pem, scheme, publicKey, keyMaterial, now)).machine;
}

/**
 * The claims carried *inside* a machine file's signed bytes.
 *
 * The same set a license file carries, and deliberately the same type: the
 * checkout handler builds both from one `LicenseFileClaims` struct
 * (`check_out_machine.rs:119-133`), so a separate machine-file copy could only
 * ever drift away from the wire format.
 */
export type MachineFileClaims = LicenseFileClaims;

/** A verified machine file: the resource plus the claims signed alongside it. */
export interface VerifiedMachineFile {
  machine: Machine;
  claims: MachineFileClaims;
}

/**
 * As {@link verifyAndDecryptMachineFile}, also returning the signed claims.
 *
 * Use this when you want `jti` for replay detection or `kid` for key-rotation
 * bookkeeping. Expiry is enforced either way — it is not opt-in.
 *
 * `now` overrides the clock, in Unix seconds; see
 * {@link verifyAndDecryptMachineFile}.
 */
export async function verifyMachineFileWithClaims(
  pem: string,
  scheme: LicenseScheme,
  publicKey: Uint8Array,
  keyMaterial?: { licenseKey: string; fingerprint: string },
  now?: number,
): Promise<VerifiedMachineFile> {
  // ⚠️ Reject up front — before any parsing — rather than let a JWT-scheme
  // signature attempt fail confusingly downstream.
  if (scheme === "RSA_2048_JWT_RS256") {
    throw CheckoutError.schemeNotSupported();
  }

  const cert = parseMachineFile(pem);

  // Throws for a missing/incorrect `+v2` marker or an unknown encoding prefix.
  const { encoding, suffix } = parseMachineFileAlg(cert.alg);
  const expectedSuffix = schemeAlgSuffix(scheme);
  if (suffix !== expectedSuffix) {
    throw CheckoutError.unsupportedAlgorithm(
      `file declares alg suffix "${suffix}", expected "${expectedSuffix}" for the supplied scheme`,
    );
  }

  // ⚠️ Same gotcha as license files: signature covers `enc`'s ASCII/UTF-8
  // STRING bytes, never its decoded bytes. This runs before `enc` is split or
  // decoded, so nothing attacker-controlled reaches a decoder unauthenticated.
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

  // Branch on the encoding prefix from `alg`, never on whether `enc` happens to
  // contain a dot.
  let plaintext: Uint8Array;
  if (encoding === ENCODING_PREFIX_PLAIN) {
    try {
      plaintext = base64Decode(cert.enc);
    } catch {
      throw CheckoutError.invalidBase64();
    }
  } else {
    if (keyMaterial === undefined) {
      throw CheckoutError.licenseKeyMissing();
    }
    const { nonce, ciphertextAndTag } = decodeEncryptedEnc(cert.enc);
    const key = deriveHkdfKey(
      new TextEncoder().encode(keyMaterial.licenseKey),
      MACHINE_FILE_KEY_SALT,
      new TextEncoder().encode(keyMaterial.fingerprint),
    );
    try {
      plaintext = await decryptAesGcm(nonce, ciphertextAndTag, key);
    } catch {
      throw CheckoutError.cryptoFailure("decryption failed (wrong key or tampered ciphertext)");
    }
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
  // Second line behind the `alg` gate: a file must not reach the expiry check
  // with nothing to check.
  // `typeof null === "object"` and so is an array, so neither check is
  // redundant. An array `meta` would read `claims.exp` as `undefined` and skip
  // expiry enforcement silently — the exact failure this whole change exists to
  // remove. Only the signing key can produce one, since `meta` lives inside the
  // authenticated bytes; this is defence in depth against a server regression.
  const meta = (payload as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw CheckoutError.invalidJson(
      "payload is missing the signed 'meta' claims (this looks like a pre-v2 file)",
    );
  }
  const claims = meta as MachineFileClaims;

  // The signature proves the file is authentic. It does not prove it is still
  // valid — that is this check. `exp` is absent when checkout was made without
  // a `ttl`, which is a file that genuinely never expires, not an error.
  if (typeof claims.exp === "number") {
    const reference = now ?? Math.floor(Date.now() / 1000);
    if (reference - CLOCK_SKEW_TOLERANCE_SECONDS > claims.exp) {
      throw CheckoutError.expired(claims.exp);
    }
  }

  return { machine: (payload as { data: Machine }).data, claims };
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
