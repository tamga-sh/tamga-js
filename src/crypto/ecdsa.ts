/**
 * ECDSA P-256 signature verification.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md` Section F.
 *
 * Backed by `@noble/curves/p256` for the same cross-runtime-consistency
 * reasons as `src/crypto/ed25519.ts`.
 *
 * Used by `src/checkout/machineFile.ts` — `ECDSA_P256_SIGN` branch of the
 * multi-algorithm dispatch.
 */

/** TODO: ECDSA P-256 / SHA-256 verify. */
export function verifyEcdsaP256(
  _message: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array,
): boolean {
  throw new Error("verifyEcdsaP256: not implemented — see docs/plans/tamga-js.plan.md Section F");
}
