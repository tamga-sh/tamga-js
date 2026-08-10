/**
 * AES-256-GCM encrypt/decrypt.
 *
 * Backed by native `crypto.subtle` (WebCrypto) directly — NOT `@noble/*`.
 * AES-GCM is a symmetric primitive with universal, stable, hardware-
 * accelerated WebCrypto support across all 4 target runtimes (Node 18+,
 * Deno, Bun, browser); there is no correctness or portability reason to
 * pull in a userland implementation for it. `globalThis.crypto.subtle` is
 * present on Node.js starting with v18 (experimental status pre-v19, but
 * functionally available as a global — see Node's Web Crypto API docs) —
 * this SDK's `engines.node >= 18` floor. See
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
 * WebCrypto's `encrypt`/`decrypt` already operate on the combined
 * `ciphertext ‖ tag` form (the tag is appended by `encrypt` and expected
 * appended by `decrypt`), so this module only has to split/join the
 * 12-byte nonce prefix.
 */

const NONCE_LENGTH = 12;
const TAG_LENGTH_BITS = 128;

/** Imports a raw 32-byte key as a non-extractable AES-GCM `CryptoKey`. */
async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", toArrayBuffer(key), { name: "AES-GCM" }, false, [
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
  const cryptoKey = await importAesGcmKey(key);
  const plaintext = await globalThis.crypto.subtle.decrypt(
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
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const cryptoKey = await importAesGcmKey(key);
  const ciphertextAndTag = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: TAG_LENGTH_BITS },
    cryptoKey,
    toArrayBuffer(plaintext),
  );
  return { nonce, ciphertextAndTag: new Uint8Array(ciphertextAndTag) };
}
