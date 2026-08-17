/**
 * AES-256-GCM encrypt/decrypt.
 *
 * Backed by native `crypto.subtle` (WebCrypto) directly — NOT `@noble/*`.
 * AES-GCM is a symmetric primitive with universal, stable, hardware-
 * accelerated WebCrypto support across all 4 target runtimes (Node 18+,
 * Deno, Bun, browser); there is no correctness or portability reason to
 * pull in a userland implementation for it — do not "simplify" this onto
 * `@noble/ciphers` or similar.
 *
 * ⚠️ **Correction to an earlier draft of this comment**: `globalThis.crypto`
 * is NOT present on Node.js 18 — it was only added as a global starting in
 * Node 19 (Node 18 only exposes it via `node:crypto`'s `webcrypto` export).
 * Confirmed the hard way: CI's `node 18` matrix job failed with `Cannot
 * read properties of undefined (reading 'subtle')` before this module
 * switched to the `getWebCrypto()` accessor in `src/internal/webcrypto.ts`,
 * which falls back to `node:crypto`'s export when the global is missing —
 * see that module's doc comment (including why it's a lazy async function,
 * not a top-level-await constant). Do not revert to `globalThis.crypto`
 * directly; it silently breaks Node 18 despite `engines.node >= 18`.
 *
 * Used by:
 * - `src/checkout/licenseFile.ts` — key derived by the naive transform in
 *   `src/crypto/hkdf.ts` with the license-file salt.
 * - `src/checkout/machineFile.ts` — key derived by real HKDF-SHA256
 *   (`src/crypto/hkdf.ts`).
 *
 * Both callers use the same wire layout: `nonce(12B) ‖ ciphertext ‖ tag(16B)`.
 * WebCrypto's `encrypt`/`decrypt` already operate on the combined
 * `ciphertext ‖ tag` form (the tag is appended by `encrypt` and expected
 * appended by `decrypt`), so this module only has to split/join the
 * 12-byte nonce prefix.
 */

import { getWebCrypto } from "../internal/webcrypto.js";

const NONCE_LENGTH = 12;
const TAG_LENGTH_BITS = 128;

/** Imports a raw 32-byte key as a non-extractable AES-GCM `CryptoKey`. */
async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
  const webcrypto = await getWebCrypto();
  return webcrypto.subtle.importKey("raw", toArrayBuffer(key), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Copies a `Uint8Array` into a plain `ArrayBuffer` view WebCrypto accepts uniformly. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Decrypts `ciphertextAndTag` (ciphertext with the 16-byte AEAD tag
 * appended, as produced by the server's AES-GCM seal) with AES-256-GCM.
 * Throws for both a wrong key and a tampered ciphertext/tag — AEAD
 * decryption deliberately doesn't distinguish the two failure modes, since
 * doing so would leak information useful to a chosen-ciphertext attacker.
 */
export async function decryptAesGcm(
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`AES-GCM nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`);
  }
  const webcrypto = await getWebCrypto();
  const cryptoKey = await importAesGcmKey(key);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: TAG_LENGTH_BITS },
    cryptoKey,
    toArrayBuffer(ciphertextAndTag),
  );
  return new Uint8Array(plaintext);
}

/**
 * Encrypts `plaintext` with AES-256-GCM using a fresh random 12-byte nonce,
 * returning `{ nonce, ciphertextAndTag }` separately (callers concatenate
 * per the wire format documented above). Only needed if this SDK ever
 * originates checkout payloads client-side; primarily here for
 * symmetry/testing against server-produced fixtures.
 */
export async function encryptAesGcm(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<{ nonce: Uint8Array; ciphertextAndTag: Uint8Array }> {
  const webcrypto = await getWebCrypto();
  const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const cryptoKey = await importAesGcmKey(key);
  const ciphertextAndTag = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: TAG_LENGTH_BITS },
    cryptoKey,
    toArrayBuffer(plaintext),
  );
  return { nonce, ciphertextAndTag: new Uint8Array(ciphertextAndTag) };
}
