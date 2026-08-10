/**
 * `MACHINE FILE` offline machine file parse/verify/decrypt pipeline.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Section F (⚠️ security-reviewer review MANDATORY before this file ships
 * real logic).
 *
 * Same inner `{enc, sig, alg}` JSON structure as license files, but wrapped
 * in `-----BEGIN MACHINE FILE-----`/`-----END MACHINE FILE-----` markers,
 * with these machine-specific differences from `licenseFile.ts`
 * (docs/sdk.md §6):
 *
 * - Signing scheme is taken from the **license's** `scheme` field, NOT
 *   hardcoded Ed25519. The verify dispatcher must branch by
 *   `LicenseScheme`.
 * - ⚠️ `RSA_2048_JWT_RS256` is explicitly rejected server-side for machine
 *   files (`422 SCHEME_NOT_SUPPORTED`). The dispatcher must throw a clear
 *   "unsupported scheme" error for it — never fall through to another
 *   verify function, which would silently mis-verify.
 * - Encryption key (when encrypted) is a REAL HKDF-SHA256 derivation
 *   (`src/crypto/hkdf.ts`), not the naive transform used by license files.
 *   Decrypting a machine file requires BOTH the license key and the target
 *   machine's fingerprint — document this two-input requirement clearly on
 *   the eventual public API.
 * - `ttl` is validated server-side (`>0`, `<=31536000` / 365 days).
 */

import type { Machine } from "../models/machine.js";
import type { LicenseScheme } from "../models/policy.js";

/** Parsed-but-unverified machine file envelope. */
export interface ParsedMachineFile {
  enc: string;
  sig: string;
  alg: string;
}

/** TODO: strip PEM markers, base64-decode, JSON.parse into {enc, sig, alg}. */
export function parseMachineFile(_pem: string): ParsedMachineFile {
  throw new Error("parseMachineFile: not implemented — see docs/plans/tamga-js.plan.md Section F");
}

/**
 * TODO: dispatch verification by `scheme` (Ed25519/RSA-PKCS1/RSA-PSS/
 * ECDSA-P256), rejecting `RSA_2048_JWT_RS256` outright, then HKDF-derive
 * the decryption key from `licenseKey` + `fingerprint` when encrypted.
 */
export function verifyAndDecryptMachineFile(
  _pem: string,
  _scheme: LicenseScheme,
  _publicKey: Uint8Array,
  _keyMaterial: { licenseKey: string; fingerprint: string },
): Machine {
  throw new Error(
    "verifyAndDecryptMachineFile: not implemented — see docs/plans/tamga-js.plan.md Section F",
  );
}
