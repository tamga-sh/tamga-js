/**
 * Ed25519 signature verification.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Sections E, F.
 *
 * Backed by `@noble/curves/ed25519` (audited, pure-TypeScript, zero native
 * deps) rather than `crypto.subtle` — WebCrypto's Ed25519 support is
 * inconsistent across this SDK's 4 target runtimes (Node/Deno/Bun/browser)
 * today, so the asymmetric-signature surface is deliberately kept off
 * WebCrypto entirely. See `docs/plans/tamga-js.plan.md` §2 "Critical design
 * decision" for the full rationale — do not "simplify" this onto
 * `crypto.subtle`.
 *
 * Used by:
 * - `src/checkout/licenseFile.ts` — license checkout signing is always
 *   Ed25519, independent of the license's own `scheme`.
 * - `src/checkout/machineFile.ts` — one branch of the multi-algorithm
 *   dispatch (scheme `ED25519_SIGN`).
 */

/**
 * TODO: verify an Ed25519 signature.
 *
 * @param _message - the exact bytes that were signed (see the caller's
 *   module doc for the byte-vs-string gotcha where relevant)
 * @param _signature - raw signature bytes
 * @param _publicKey - raw Ed25519 public key bytes
 */
export function verifyEd25519(
  _message: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array,
): boolean {
  throw new Error("verifyEd25519: not implemented — see docs/plans/tamga-js.plan.md Section E");
}
