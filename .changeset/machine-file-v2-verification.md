---
"@tamga/sdk": patch
---

Fix offline machine-file verification, which could not open a certificate the
server had ever issued.

Five defects on one path, all found by testing against certificates minted by
the Tamga API's own encoder rather than by this SDK:

- **`alg` carries a mandatory `+v2` suffix.** The server emits
  `base64+ed25519+v2` / `aes-256-gcm+rsa-pss-sha256+v2`, and this SDK split at
  the first `+` and compared the whole remainder against the expected signing
  suffix — so `"ed25519+v2" !== "ed25519"` rejected every real file. `alg` is
  now cut at the **first** and **last** `+` (both the encoding prefix and two
  signing suffixes contain hyphens), and the version marker is matched exactly:
  a file without `+v2` is refused, as are `+v3` and `+v2junk`, which a
  substring check would let through. A v1 file carried no `meta.exp` inside the
  signed payload and derived its AES key by zero-padding the license key, so
  accepting one silently reinstates both weaknesses. `alg` is not covered by
  the signature, so this gate does not lean on signature validity.

- **An encrypted `enc` is `"<nonce_b64>.<cipher_b64>"`.** The two halves are
  base64-encoded separately and the ciphertext half already carries the 16-byte
  GCM tag. This SDK treated `enc` as one blob and sliced a nonce off the first
  12 decoded bytes; because the strict base64 decoder rejects the `.`, every
  encrypted file failed with "invalid base64" before decryption was attempted.
  The halves are now decoded independently, still strictly after the signature
  over `enc`'s string bytes has verified — the order is verify, split, decode,
  decrypt, so no attacker-controlled byte reaches a decoder unauthenticated —
  and the branch is on the encoding prefix from `alg`, not on whether a dot
  happens to be present.

- **`meta.exp` is now enforced.** The signed payload is
  `{"data": <Machine>, "meta": {iat, exp?, jti, kid}}` and nothing read it, so
  an expired machine file verified forever. Expiry is checked with the
  license-file path's own `CLOCK_SKEW_TOLERANCE_SECONDS` (60s, now shared
  rather than duplicated) and an expired file throws the same
  `CheckoutError` of kind `"expired"` a license file does, so a caller can tell
  "fetch a fresh one" from "forged or corrupt". A missing `exp` is legitimate —
  checkout without a `ttl` produces a file that genuinely never expires — and
  is not an error. A payload with no signed `meta` at all is rejected.

- **RSA public keys are accepted in the encoding the API actually publishes.**
  `aws-lc-rs` hands back a PKCS#1 `RSAPublicKey` DER, and that blob is what the
  server stores and publishes; this SDK imported it as SPKI, which fails at
  `importKey` with `Invalid keyData` before any signature is examined. Both
  encodings are now accepted (`src/crypto/rsa.ts::toRsaSpki`), which fixes
  `verifyRsaPkcs1`, `verifyRsaPss`, the RSA branches of machine-file
  verification, and `verifyOfflineProof`.

- **ECDSA P-256 verification now hashes the message.** `@noble/curves` takes a
  message *digest*; handing it raw bytes does not throw, it silently truncates
  and verifies against the wrong value. The server signs `SHA-256(enc)`, so no
  server-issued `ECDSA_P256_SIGN` machine file verified. The round trip looked
  correct only because the test fixture builder made the identical mistake on
  the signing side.

Additions: `verifyMachineFileWithClaims` returns the signed
`iat`/`exp`/`jti`/`kid` alongside the machine, mirroring
`verifyLicenseFileWithClaims`, which is now re-exported from the package
entrypoint along with the `LicenseFileClaims` / `VerifiedLicenseFile` /
`MachineFileClaims` / `VerifiedMachineFile` types.
`verifyAndDecryptMachineFile` takes an optional trailing `now` (Unix seconds)
so a caller can supply a trusted timestamp instead of the local clock, which
belongs to whoever holds the file. No existing signature, type or error kind
changed. `kid` is exposed but nothing selects a key by it yet — key rotation is
a separate change.

Also fixed: a `"meta": null` payload reached the license-file expiry check and
died on a property access instead of returning a typed `CheckoutError`, and
`CheckoutError.expired`'s message said "license file" for both formats.

Testing: `test/fixtures/machine-file-v2/` holds 12 certificates produced by the
server's `encode_machine_file` — four signing schemes by three variants —
iterated from their manifest by `test/machine-file-server-fixtures.spec.ts`, so
a fixture added there needs no test edit. `scripts/smoke.mjs` re-runs the whole
set against the built output on Node, Deno and Bun. The self-generated builders
in `test/helpers/checkoutFixtures.ts` are corrected and marked as what they are:
they encode this SDK's belief about the wire format, which is exactly how these
defects stayed green in CI, and they are kept only for the negative cases the
server will not mint.
