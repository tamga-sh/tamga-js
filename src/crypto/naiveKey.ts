/**
 * License-checkout's non-KDF key derivation.
 *
 * ⚠️ NOT a KDF. The server derives the AES-256 key for encrypted `.lic`
 * files as the raw UTF-8 bytes of `license.key`, zero-padded (short keys)
 * or truncated (long keys) to exactly 32 bytes — no hashing, no HKDF, no
 * salt. `naiveKeyFromLicenseKey` below must replicate this exact transform
 * bit-for-bit or decryption of a real server-issued `.lic` file will fail.
 *
 * Ground-truth verified against `tamga-rust`'s `src/crypto/naive_key.rs`,
 * itself verified against the server's own derivation in
 * `tamga-api/src/features/licenses/check_out_license.rs`:
 * ```rust,ignore
 * let kb = key_str.as_bytes();
 * let mut key_bytes = vec![0u8; 32];
 * let len = kb.len().min(32);
 * key_bytes[..len].copy_from_slice(&kb[..len]);
 * ```
 *
 * This exists ONLY for wire-format compatibility with the license checkout
 * format (docs/sdk.md §4). Never reuse it as a general-purpose KDF anywhere
 * else in this SDK — for the machine-checkout format, the server uses a
 * real HKDF-SHA256 derivation instead (`src/crypto/hkdf.ts`).
 */

/** AES-256-GCM key length, in bytes. */
const KEY_LENGTH = 32;

/**
 * Zero-pads or truncates `key`'s raw UTF-8 bytes to exactly 32 bytes. See
 * the module doc above — this is intentionally NOT a hash function.
 */
export function naiveKeyFromLicenseKey(key: string): Uint8Array {
  const keyBytes = new TextEncoder().encode(key);
  const out = new Uint8Array(KEY_LENGTH);
  out.set(keyBytes.subarray(0, KEY_LENGTH));
  return out;
}
