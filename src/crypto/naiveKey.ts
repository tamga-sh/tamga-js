/**
 * License-checkout's non-KDF key derivation.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Section E.
 *
 * ⚠️ NOT a KDF. The server derives the AES-256 key for encrypted `.lic`
 * files as the raw UTF-8 bytes of `license.key`, zero-padded (short keys)
 * or truncated (long keys) to exactly 32 bytes — no hashing, no HKDF, no
 * salt. `naiveKeyFromLicenseKey` below must replicate this exact transform
 * bit-for-bit or decryption of a real server-issued `.lic` file will fail.
 *
 * This exists ONLY for wire-format compatibility with the license checkout
 * format (docs/sdk.md §4). Never reuse it as a general-purpose KDF anywhere
 * else in this SDK — for the machine-checkout format, the server uses a
 * real HKDF-SHA256 derivation instead (`src/crypto/hkdf.ts`).
 */

/**
 * TODO: zero-pad or truncate `key`'s raw UTF-8 bytes to exactly 32 bytes.
 * See the module doc above — this is intentionally NOT a hash function.
 */
export function naiveKeyFromLicenseKey(_key: string): Uint8Array {
  throw new Error(
    "naiveKeyFromLicenseKey: not implemented — see docs/plans/tamga-js.plan.md Section E",
  );
}
