/**
 * ECDSA P-256/SHA-256 signature verification.
 *
 * Backed by `@noble/curves/p256` for the same cross-runtime-consistency
 * reasons as `src/crypto/ed25519.ts`.
 *
 * Used by `src/checkout/machineFile.ts` — `ECDSA_P256_SIGN` branch of the
 * multi-algorithm dispatch.
 *
 * The server signs with `ECDSA_P256_SHA256_ASN1` (`aws-lc-rs`): it hashes the
 * message with SHA-256 and emits an ASN.1 DER `(r, s)` signature. Both halves
 * of that have to be mirrored here.
 *
 * ⚠️ **`@noble/curves` does not hash for you.** `p256.verify(sig, msgHash, pk)`
 * takes a message **digest** as its second argument, not the message. Handing
 * it the raw signed bytes does not throw — `bits2int` quietly takes the
 * leftmost 32 bytes of whatever it is given and verifies against that — so an
 * SDK that signs and verifies the same wrong way round-trips its own fixtures
 * perfectly while rejecting every certificate the server has ever produced.
 * That is exactly what happened here, and it survived because the only ECDSA
 * fixture in the suite was one this repository generated. The digest is
 * computed explicitly below rather than through the `prehash` option, which is
 * not present across the whole `^1.6.0` range this package allows.
 */

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Verifies an ECDSA P-256/SHA-256 ASN.1 DER `signature` over `message`.
 *
 * `message` is the raw signed bytes — the SHA-256 digest is taken here, so
 * callers must not pre-hash. `publicKey` is the raw 65-byte uncompressed P-256
 * point (`0x04 ‖ X ‖ Y`), which is what the server publishes.
 */
export function verifyEcdsaP256(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return p256.verify(signature, sha256(message), publicKey, { format: "der" });
  } catch {
    return false;
  }
}
