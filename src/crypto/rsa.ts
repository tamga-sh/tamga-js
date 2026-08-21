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
 * `publicKey` for both functions is the account's RSA public key in DER, in
 * **either** encoding:
 *
 * - SubjectPublicKeyInfo (SPKI) — what WebCrypto's `importKey` accepts, and
 *   what most tooling hands you.
 * - PKCS#1 `RSAPublicKey` (a bare `SEQUENCE { modulus, exponent }`) — what the
 *   Tamga API actually publishes. `aws-lc-rs`'s `RsaKeyPair::public_key()`
 *   returns PKCS#1, and the server stores that blob verbatim in
 *   `accounts.rsa_public_key`. The server's own doc comments
 *   (`key_material.rs:37`, `license_signing.rs:142`) call it SPKI and are
 *   wrong; its `rsa_public_key_is_spki_der` test only asserts `len > 256`,
 *   which a 270-byte PKCS#1 RSA-2048 key also satisfies, so nothing caught it.
 *
 * WebCrypto has no PKCS#1 import format, so {@link toRsaSpki} below wraps one
 * into an SPKI before import. Without that, this SDK could not verify a single
 * RSA-signed machine file or offline proof against the key the server hands
 * out — `importKey` fails with `Invalid keyData` before any signature is even
 * looked at.
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

/** DER `AlgorithmIdentifier` for `rsaEncryption` with the required NULL params. */
const RSA_ENCRYPTION_ALGORITHM_ID = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

const DER_TAG_INTEGER = 0x02;
const DER_TAG_BIT_STRING = 0x03;
const DER_TAG_SEQUENCE = 0x30;

/** Encodes a DER definite-form length. */
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>>= 8) bytes.unshift(n & 0xff);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

/** Emits a DER tag-length-value triple. */
function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const length = derLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

/**
 * Offset of the first byte after the DER length at `offset`, or `-1` if the
 * header is truncated or uses the indefinite form (illegal in DER).
 */
function afterDerLength(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  if (first === undefined) return -1;
  if (first < 0x80) return offset + 1;
  const count = first & 0x7f;
  if (count === 0 || offset + 1 + count > bytes.length) return -1;
  return offset + 1 + count;
}

/**
 * True when `bytes` is a bare PKCS#1 `RSAPublicKey` rather than an SPKI.
 *
 * Both are an outer `SEQUENCE`; they differ in the first element. PKCS#1 opens
 * with the modulus, an `INTEGER`; SPKI opens with the `AlgorithmIdentifier`, a
 * `SEQUENCE`. One tag byte separates them, so no real parsing is needed.
 */
function isPkcs1RsaPublicKey(bytes: Uint8Array): boolean {
  if (bytes[0] !== DER_TAG_SEQUENCE) return false;
  const contentStart = afterDerLength(bytes, 1);
  if (contentStart < 0) return false;
  return bytes[contentStart] === DER_TAG_INTEGER;
}

/**
 * Returns `publicKey` as SPKI DER, wrapping a PKCS#1 `RSAPublicKey` in the
 * `rsaEncryption` `AlgorithmIdentifier` and `BIT STRING` an SPKI needs.
 *
 * Anything that does not look like PKCS#1 is passed through untouched, so a
 * genuine SPKI — or a malformed blob — reaches `importKey` unchanged and is
 * accepted or rejected there. The public key is embedded by the application,
 * not attacker-supplied, but the inspection above is bounds-checked regardless.
 */
export function toRsaSpki(publicKey: Uint8Array): Uint8Array {
  if (!isPkcs1RsaPublicKey(publicKey)) return publicKey;
  const bitString = new Uint8Array(publicKey.length + 1);
  bitString.set(publicKey, 1); // leading byte: 0 unused bits
  return derTlv(
    DER_TAG_SEQUENCE,
    concat(RSA_ENCRYPTION_ALGORITHM_ID, derTlv(DER_TAG_BIT_STRING, bitString)),
  );
}

/** Concatenates two byte arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Imports an RSA public key (SPKI or PKCS#1 DER) for the given WebCrypto algorithm. */
async function importRsaPublicKey(
  publicKey: Uint8Array,
  algorithm: RsaHashedImportParams,
): Promise<CryptoKey> {
  const webcrypto = await getWebCrypto();
  return webcrypto.subtle.importKey("spki", toArrayBuffer(toRsaSpki(publicKey)), algorithm, false, [
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
