/**
 * RSA signature verification (PKCS#1 v1.5 and PSS).
 *
 * Backed by native `crypto.subtle` (WebCrypto) — `@noble/curves` has no RSA
 * support (it's an elliptic-curve library), and WebCrypto's RSA verify
 * operations are stable and consistent across all 4 target runtimes (unlike
 * WebCrypto's Ed25519 support — see `src/crypto/ed25519.ts`'s module doc).
 * Because WebCrypto is Promise-based, the verify functions below are `async`,
 * unlike the synchronous `@noble/curves`-backed Ed25519/ECDSA ones.
 *
 * Used by:
 * - `src/checkout/machineFile.ts` — `RSA_2048_PKCS1_SIGN` and
 *   `RSA_2048_PKCS1_PSS_SIGN` branches of the multi-algorithm dispatch.
 *   ⚠️ `RSA_2048_JWT_RS256` is explicitly rejected server-side for machine
 *   files (`422 SCHEME_NOT_SUPPORTED`) — the dispatcher in
 *   `machineFile.ts` must throw a clear "unsupported scheme" error for it,
 *   never fall through to one of the verify functions below.
 * - `src/proof.ts` — offline proof is always RSA-2048 PKCS#1 v1.5/SHA-256,
 *   regardless of the license's `scheme`.
 *
 * `publicKey` for both functions is a SubjectPublicKeyInfo (SPKI) DER blob
 * — the same format `tamga-rust`'s `aws-lc-rs`-backed verifier expects,
 * confirmed against the server's own `extract_public_key`.
 *
 * RSA-PSS salt length is fixed at 32 bytes (SHA-256's digest length) — the
 * conventional default salt length used by essentially every PSS signer,
 * including the server's `aws-lc-rs` implementation (`RSA_PSS_2048_8192_SHA256`
 * uses digest-length salt).
 *
 * Uses the `getWebCrypto()` accessor from `src/internal/webcrypto.ts`, not
 * `globalThis.crypto` directly — the latter is missing on Node 18 (this
 * SDK's documented `engines.node` floor); see that module's doc comment for
 * why it's a lazy async function, not a top-level-await constant (CJS
 * builds don't support top-level await — this package builds to both
 * ESM and CJS).
 */

import { getWebCrypto } from "../internal/webcrypto.js";

const PSS_SALT_LENGTH = 32;

/** Copies a `Uint8Array` into a plain `ArrayBuffer` view WebCrypto accepts uniformly. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** Imports a SPKI DER public key for the given WebCrypto algorithm. */
async function importRsaPublicKey(
  publicKey: Uint8Array,
  algorithm: RsaHashedImportParams,
): Promise<CryptoKey> {
  const webcrypto = await getWebCrypto();
  return webcrypto.subtle.importKey("spki", toArrayBuffer(publicKey), algorithm, false, [
    "verify",
  ]);
}

/** Verifies an RSA-PKCS1v1.5/SHA-256 `signature` over `message`. */
export async function verifyRsaPkcs1(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    const webcrypto = await getWebCrypto();
    const key = await importRsaPublicKey(publicKey, {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    });
    return await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      toArrayBuffer(signature),
      toArrayBuffer(message),
    );
  } catch {
    return false;
  }
}

/** Verifies an RSA-PSS/SHA-256 `signature` over `message`. */
export async function verifyRsaPss(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    const webcrypto = await getWebCrypto();
    const key = await importRsaPublicKey(publicKey, { name: "RSA-PSS", hash: "SHA-256" });
    return await webcrypto.subtle.verify(
      { name: "RSA-PSS", saltLength: PSS_SALT_LENGTH },
      key,
      toArrayBuffer(signature),
      toArrayBuffer(message),
    );
  } catch {
    return false;
  }
}
