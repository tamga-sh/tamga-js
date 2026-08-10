/**
 * HKDF-SHA256 key derivation.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Section F.
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

/** TODO: HKDF-SHA256, output length fixed at 32 bytes for AES-256. */
export function deriveHkdfKey(_ikm: Uint8Array, _salt: Uint8Array, _info: Uint8Array): Uint8Array {
  throw new Error("deriveHkdfKey: not implemented — see docs/plans/tamga-js.plan.md Section F");
}
