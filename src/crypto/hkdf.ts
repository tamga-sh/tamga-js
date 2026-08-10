/**
 * HKDF-SHA256 key derivation.
 *
 * Backed by `@noble/hashes/hkdf` for cross-runtime consistency (same
 * rationale as `src/crypto/ed25519.ts`).
 *
 * Used exclusively by `src/checkout/machineFile.ts` to derive the AES-256
 * decryption key for encrypted machine files:
 * `salt = "tamga:machine-file-key-v1"`, `ikm = <license key>`,
 * `info = <machine fingerprint>` → 32-byte AES key. This is a REAL KDF,
 * unlike license file decryption's naive transform
 * (`src/crypto/naiveKey.ts`) — do not conflate the two.
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
