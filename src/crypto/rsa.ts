/**
 * RSA signature verification (PKCS#1 v1.5 and PSS).
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Sections F, H.
 *
 * Used by:
 * - `src/checkout/machineFile.ts` — `RSA_2048_PKCS1_SIGN` and
 *   `RSA_2048_PKCS1_PSS_SIGN` branches of the multi-algorithm dispatch.
 *   ⚠️ `RSA_2048_JWT_RS256` is explicitly rejected server-side for machine
 *   files (`422 SCHEME_NOT_SUPPORTED`) — the eventual dispatcher in
 *   `machineFile.ts` must throw a clear "unsupported scheme" error for it,
 *   never fall through to one of the verify functions below.
 * - `src/proof.ts` — offline proof is always RSA-2048 PKCS#1 v1.5/SHA-256,
 *   regardless of the license's `scheme`.
 */

/** TODO: RSA PKCS#1 v1.5 / SHA-256 verify. */
export function verifyRsaPkcs1(
  _message: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array,
): boolean {
  throw new Error("verifyRsaPkcs1: not implemented — see docs/plans/tamga-js.plan.md Section F");
}

/** TODO: RSA-PSS / SHA-256 verify. */
export function verifyRsaPss(
  _message: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array,
): boolean {
  throw new Error("verifyRsaPss: not implemented — see docs/plans/tamga-js.plan.md Section F");
}
