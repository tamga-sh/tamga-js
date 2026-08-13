/**
 * HKDF-SHA256 key derivation for both offline file formats.
 *
 * Backed by `@noble/hashes/hkdf` for cross-runtime consistency (same
 * rationale as `src/crypto/ed25519.ts`).
 *
 * Machine files always used a proper KDF. License files did not: before file
 * format v2 the AES key was the license key's raw UTF-8 bytes zero-padded to
 * 32, which meant an attacker holding a stolen `.lic` was not attacking a
 * 256-bit key space but the license key's own entropy — a dictionary attack
 * against the AEAD tag on an `XXXX-XXXX-XXXX-XXXX`-shaped string. The
 * `naiveKey.ts` that implemented it is **deleted**, not deprecated: leaving it
 * exported would let a caller silently keep using the weaker derivation.
 *
 * The two derivations differ in salt and `info`, and must not be conflated.
 * Decrypting a machine file needs the target machine's fingerprint too, so it
 * cannot be opened anywhere but on the machine it was issued for; a license
 * file is not bound to a machine.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

/** AES-256-GCM key length, in bytes. */
const KEY_LENGTH = 32;

/**
 * HKDF-SHA256 (RFC 5869): `HKDF-Expand(HKDF-Extract(ikm, salt), info, 32)`.
 * Output length is fixed at 32 bytes for AES-256.
 */
export function deriveHkdfKey(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, salt, info, KEY_LENGTH);
}

/** Fixed HKDF salt for machine-file encryption keys. */
export const MACHINE_FILE_KEY_SALT = new TextEncoder().encode("tamga:machine-file-key-v1");

/** Fixed HKDF salt for license-file encryption keys. */
export const LICENSE_FILE_KEY_SALT = new TextEncoder().encode("tamga:license-file-key-v1");

/** Fixed HKDF `info` for license-file encryption keys. */
export const LICENSE_FILE_KEY_INFO = new TextEncoder().encode("license-file");

/**
 * Derives the AES-256-GCM key for an encrypted `.lic` file:
 * `salt = "tamga:license-file-key-v1"`, `ikm = licenseKey`,
 * `info = "license-file"`.
 *
 * No fingerprint is involved — a license file is not bound to a machine.
 */
export function deriveLicenseFileKey(licenseKey: string): Uint8Array {
  return deriveHkdfKey(
    new TextEncoder().encode(licenseKey),
    LICENSE_FILE_KEY_SALT,
    LICENSE_FILE_KEY_INFO,
  );
}
