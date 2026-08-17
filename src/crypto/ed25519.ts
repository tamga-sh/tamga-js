/**
 * Ed25519 signature verification.
 *
 * Backed by `@noble/curves/ed25519` (audited, pure-TypeScript, zero native
 * deps) rather than `crypto.subtle` — WebCrypto's Ed25519 support is
 * inconsistent across this SDK's 4 target runtimes (Node/Deno/Bun/browser)
 * today, so the asymmetric-signature surface is deliberately kept off
 * WebCrypto entirely — do not "simplify" this onto `crypto.subtle`.
 *
 * Used by:
 * - `src/checkout/licenseFile.ts` — license checkout signing is always
 *   Ed25519, independent of the license's own `scheme`.
 * - `src/checkout/machineFile.ts` — one branch of the multi-algorithm
 *   dispatch (scheme `ED25519_SIGN`).
 *
 * ⚠️ Verified with `{ zip215: false }` — RFC 8032 / FIPS 186-5 strict
 * verification, matching the server's `ed25519-dalek` `VerifyingKey::verify`
 * (which since v2 rejects malleable signatures / non-canonical `S` /
 * small-order components). `@noble/curves`' default mode follows the more
 * permissive ZIP215 batch-verification rules; using the default here would
 * risk accepting a signature the server itself would reject, which is a
 * strictly worse trust posture for a *verifier*.
 */

import { ed25519 } from "@noble/curves/ed25519";

/**
 * Verifies an Ed25519 `signature` over `message` using the account's raw
 * 32-byte public key. Uses `@noble/curves`'s own constant-time verify
 * primitive — never a hand-rolled byte comparison, which would risk a
 * timing side channel.
 *
 * Callers verifying a `.lic`/`.mach` checkout file must pass `message` as
 * the **base64 string bytes of `enc`, not `enc`'s decoded bytes** — see
 * `src/checkout/licenseFile.ts`'s module doc comment's gotcha.
 */
export function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
