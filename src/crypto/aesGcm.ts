/**
 * AES-256-GCM encrypt/decrypt.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Sections E, F.
 *
 * Backed by native `crypto.subtle` (WebCrypto) directly — NOT `@noble/*`.
 * AES-GCM is a symmetric primitive with universal, stable, hardware-
 * accelerated WebCrypto support across all 4 target runtimes (Node 18+,
 * Deno, Bun, browser); there is no correctness or portability reason to
 * pull in a userland implementation for it. See
 * `docs/plans/tamga-js.plan.md` §2 "Critical design decision" — do not
 * "simplify" this onto `@noble/ciphers` or similar.
 *
 * Used by:
 * - `src/checkout/licenseFile.ts` — key derived by the naive transform in
 *   `src/crypto/naiveKey.ts` (NOT a KDF).
 * - `src/checkout/machineFile.ts` — key derived by real HKDF-SHA256
 *   (`src/crypto/hkdf.ts`).
 *
 * Both callers use the same wire layout: `nonce(12B) ‖ ciphertext ‖ tag(16B)`.
 */

/**
 * TODO: AES-256-GCM decrypt. Expects `_ciphertext` to already be split into
 * its 12-byte nonce prefix and the ciphertext+tag remainder per the wire
 * format above (or accepts the combined buffer and splits internally —
 * finalize the exact signature during implementation).
 */
export function decryptAesGcm(_ciphertext: Uint8Array, _key: Uint8Array): Uint8Array {
  throw new Error("decryptAesGcm: not implemented — see docs/plans/tamga-js.plan.md Section E");
}

/**
 * TODO: AES-256-GCM encrypt with a fresh random 12-byte nonce per call.
 * Only needed if this SDK ever originates checkout requests client-side;
 * primarily here for symmetry/testing against server-produced fixtures.
 */
export function encryptAesGcm(_plaintext: Uint8Array, _key: Uint8Array): Uint8Array {
  throw new Error("encryptAesGcm: not implemented — see docs/plans/tamga-js.plan.md Section E");
}
