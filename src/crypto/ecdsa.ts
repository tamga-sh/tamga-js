/**
 * ECDSA P-256/SHA-256 signature verification.
 *
 * Backed by `@noble/curves/p256` for the same cross-runtime-consistency
 * reasons as `src/crypto/ed25519.ts`.
 *
 * Used by `src/checkout/machineFile.ts` — `ECDSA_P256_SIGN` branch of the
 * multi-algorithm dispatch.
 *
 * The server signs with `ECDSA_P256_SHA256_ASN1` (ASN.1 DER-encoded
 * signature, message hashed internally with SHA-256) — `p256.verify` is
 * called with `{ format: "der" }` to match, and hashes `message` internally
 * (SHA-256 is p256's default hash), so callers pass the raw signed bytes,
 * not a pre-hashed digest.
 */

import { p256 } from "@noble/curves/nist";

/**
 * Verifies an ECDSA P-256/SHA-256 ASN.1 DER `signature` over `message`.
 * `publicKey` is the raw 65-byte uncompressed P-256 point (`0x04 ‖ X ‖ Y`).
 */
export function verifyEcdsaP256(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return p256.verify(signature, message, publicKey, { format: "der" });
  } catch {
    return false;
  }
}
