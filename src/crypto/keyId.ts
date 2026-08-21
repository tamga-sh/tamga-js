/**
 * `kid` computation — the identifier a signed offline file uses to name the
 * key that signed it.
 *
 * Ground-truthed against the server's own function,
 * `tamga-api/src/shared/crypto/license_file.rs::key_id`, and cross-checked
 * against `tamga-rust`'s `src/crypto/ed25519.rs::key_id` (the reference
 * implementation for this SDK family).
 *
 * The rule is the first eight bytes of `SHA-256(public key)` as lowercase hex
 * — a sixteen-character string. Because it is a pure function of the key, an
 * application that embeds a public key can compute the `kid` a file would name
 * without any network access, which is what makes a key rotation solvable
 * offline: embed the key set, compute each id, and select the one the file's
 * `kid` claim names.
 *
 * ⚠️ **CRITICAL — the hash is over the base64 STRING, not the 32 decoded key
 * bytes.** The server stores and publishes the Ed25519 public half as standard
 * base64 and hands that same `&str` straight to `key_id`; it never decodes
 * first. Hashing the decoded bytes produces a different, wrong id — every file
 * then names a key the set cannot find, and an authentic file reports as
 * unverifiable. This is the same class of gotcha as the checkout signature
 * covering `enc`'s base64 string rather than its decoded bytes (see
 * `src/checkout/licenseFile.ts`), and it is pinned by a **negative** vector in
 * `test/fixtures/signing-keys/signing-key-ids.json`: the same key must produce
 * `905f28def18eaac0`, and producing `630dcd2966c43366` means the
 * implementation decoded before hashing.
 *
 * Backed by `@noble/hashes/sha2` — already a dependency (`src/crypto/hkdf.ts`
 * uses the same import), synchronous, and identical across all four target
 * runtimes. `crypto.subtle.digest` would work equally well cryptographically
 * but is Promise-based, which would force every key-set lookup and every
 * key-set construction to become `async` for no benefit.
 */

import { sha256 } from "@noble/hashes/sha2";

/** How many leading digest bytes the server takes. */
const KEY_ID_BYTE_LENGTH = 8;

/** Length of a `kid` string: {@link KEY_ID_BYTE_LENGTH} bytes as lowercase hex. */
export const SIGNING_KEY_ID_LENGTH = 16;

/**
 * The `kid` every file signed by an account with **no published Ed25519 key**
 * carries: `SHA-256("")[0..8]`, lowercase hex.
 *
 * Not a curiosity. The server's checkout handler computes the claim from
 * `account.ed25519_public_key.unwrap_or_default()`, so an account whose key
 * column was never populated signs every `.lic` and `.mach` file it issues with
 * this one id. Recognising it is the difference between two very different
 * support outcomes — *your key set is stale, fetch it again* versus *this
 * server published no signing key at all, which no client-side action can fix*
 * — and {@link import("../checkout/keySet.js").SigningKeySet}-backed
 * verification reports it as its own condition rather than folding it into a
 * generic unknown-key failure.
 */
export const UNBACKFILLED_ACCOUNT_KEY_ID = "e3b0c44298fc1c14";

/**
 * Computes the `kid` for an Ed25519 public key, given as the standard base64
 * **string** the server publishes and stores.
 *
 * ⚠️ Pass the base64 string, never its decoded bytes — see this module's doc
 * comment. Passing the empty string is not an error and returns
 * {@link UNBACKFILLED_ACCOUNT_KEY_ID}.
 *
 * Computing a `kid` locally is a **cross-check, not a requirement**, for keys
 * fetched from the API: `GET /v1/accounts/{account_id}/signing-keys` already
 * serves this exact value as each resource's `id`, so
 * {@link import("../checkout/keySet.js").SigningKeySet.fromResources} indexes
 * by the served id and uses this function only to notice when the two
 * disagree. It is the sole source of a `kid` on the offline path, where a
 * caller embeds public keys in the application and never calls the API.
 */
export function signingKeyId(ed25519PublicKeyBase64: string): string {
  const digest = sha256(new TextEncoder().encode(ed25519PublicKeyBase64));
  let hex = "";
  for (const byte of digest.subarray(0, KEY_ID_BYTE_LENGTH)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
