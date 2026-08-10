/**
 * `.lic` offline license file parse/verify/decrypt pipeline.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Section E (⚠️ security-reviewer review MANDATORY before this file ships
 * real logic).
 *
 * File format (docs/sdk.md §4):
 * ```
 * -----BEGIN LICENSE FILE-----
 * <base64 of JSON: { "enc": "<base64>", "sig": "<base64 ed25519 sig>", "alg": "<string>" }>
 * -----END LICENSE FILE-----
 * ```
 *
 * `alg` is exactly `"base64+ed25519"` (plain) or `"aes-256-gcm+ed25519"`
 * (encrypted) — Ed25519 only, independent of the license's own `scheme`.
 *
 * ⚠️ CRITICAL — the single highest-risk interop bug in a from-scratch
 * reimplementation of this format: the Ed25519 signature covers `enc`'s
 * ASCII/UTF-8 **string** bytes (the base64 string itself), NOT the
 * base64-decoded payload bytes. Verifying against the decoded bytes will
 * silently accept forged files in some cases and reject valid ones in
 * others — get this exactly right (docs/sdk.md §4, plan Section E).
 *
 * Other gotchas to preserve when implementing:
 * - `includes` is always `[]` server-side — no "embedded relationships"
 *   feature to build around it.
 * - Checkout `id` is a fresh UUIDv7 per call, not idempotent.
 * - `ttl`/`expiry` are metadata only, NOT embedded in the signed payload and
 *   NOT re-checked server-side later — expiry enforcement is entirely this
 *   SDK's/the caller's responsibility.
 * - Encryption key is the NON-KDF transform in `src/crypto/naiveKey.ts`,
 *   not a hash.
 */

import type { License } from "../models/license.js";

/** Discriminated `alg` values for `.lic` files — Ed25519 only. */
export type LicenseFileAlgorithm = "base64+ed25519" | "aes-256-gcm+ed25519";

/** Parsed-but-unverified `.lic` file envelope. */
export interface ParsedLicenseFile {
  enc: string;
  sig: string;
  alg: LicenseFileAlgorithm;
}

/** TODO: strip PEM markers, base64-decode, JSON.parse into {enc, sig, alg}. */
export function parseLicenseFile(_pem: string): ParsedLicenseFile {
  throw new Error("parseLicenseFile: not implemented — see docs/plans/tamga-js.plan.md Section E");
}

/**
 * TODO: Ed25519-verify `sig` against `enc`'s UTF-8 STRING bytes (see the
 * ⚠️ CRITICAL note in the module doc above), then base64-decode `enc` and,
 * if `alg` contains `aes-256-gcm`, AES-256-GCM-open with the naive key
 * derived from the license key string, and parse `{"data": ...}` JSON.
 */
export function verifyAndDecryptLicenseFile(
  _pem: string,
  _publicKey: Uint8Array,
  _licenseKey?: string,
): License {
  throw new Error(
    "verifyAndDecryptLicenseFile: not implemented — see docs/plans/tamga-js.plan.md Section E",
  );
}
