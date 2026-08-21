---
"@tamga/sdk": patch
---

Verify offline files against the signing key their `kid` claim names, so a key
rotation no longer locks out a paying customer holding a valid file.

Both file formats have carried a `kid` claim inside their signed payload since
v2, and this SDK parsed it and then ignored it. Verification took one embedded
public key, so a `.lic` or `.mach` file signed *before* the account rotated its
Ed25519 signing key failed — with exactly the error a forged file produces. The
file was authentic and the license was often still valid, but the caller had no
way to tell "my key set is stale" from "this file was tampered with". The first
calls for fetching the key set; the second calls for refusing the customer.
Those are different incidents and they now surface as different errors.

**New, and additive — no existing signature, type or error kind changed.**

- `verifyLicenseFileWithKeySet` and `verifyMachineFileWithKeySet` select the
  public key by the file's own `kid` from a set the caller already trusts.
- `SigningKeySet`, built from the account's published keys
  (`SigningKeySet.fromResources`, or `client.getSigningKeySet()` in one call) or
  from keys pinned in the application binary with no network at all
  (`SigningKeySet.fromPublicKeys`).
- `client.listSigningKeys()` for `GET /signing-keys`, plus the `SigningKey`
  resource type. ⚠️ Gated on `account.read`, which the license-key role does not
  hold — an embedded license-key client gets `403` here regardless of the
  account's `authentication_strategy`. Fetch the set with a back-office token
  and ship the public keys with the application, or proxy the call.
- `signingKeyId(publicKeyBase64)` computes the `kid` for a key you hold.
- `SigningKeyError`, a new error class, carrying the three conditions apart from
  a signature failure: `"unknown-key-id"` (stale key set — refresh it and
  retry), `"no-published-signing-key"` (the issuing account never published an
  Ed25519 key, so it signed with the empty string and no key set can ever verify
  the file), and `"invalid-key"` (a key handed to `fromPublicKeys` is not base64
  of exactly 32 bytes, raised at construction so a typo in a pinned key fails at
  startup rather than in the field).

A `kid` that **is** in the set and whose signature then fails still raises
`CheckoutError` of kind `"crypto"`, unchanged. That one is a forgery.

Three details worth knowing:

- **The `kid` is `SHA-256` of the public key's base64 STRING, not of its 32
  decoded bytes.** The natural assumption is the wrong one, and getting it
  wrong makes every authentic file report as signed by an unknown key. Pinned
  by vectors this repository did not generate, including a negative vector for
  the decode-first result, and cross-checked against the `kid`s the server
  itself stamped into the 12 certificates in `test/fixtures/machine-file-v2/`.
- **Retired keys are kept, deliberately.** Filtering a key set down to active
  keys reintroduces the exact defect this fixes.
- **There is no "try every key" fallback.** Trying them all would verify the
  same files while destroying the distinction above, which is the defect rather
  than the fix. A key set built from `GET /signing-keys` is indexed by the
  server's own resource `id`; the local computation cross-checks it and any
  disagreement is reported on `SigningKeySet.mismatches` rather than thrown.

`verifyMachineFileWithKeySet` handles Ed25519-signed machine files only, and
refuses the other three schemes on the `alg` gate. That is a server-side limit,
not a shortcut: `GET /signing-keys` publishes Ed25519 keys and nothing else, so
no set built from it can hold a key that would verify an RSA or ECDSA signature.
Verify those with `verifyAndDecryptMachineFile` and the license's own `scheme`.

Semver note: `patch`, deliberately. This package is `0.4.x`, where npm treats a
minor as the breaking channel — a `^0.4` consumer does not receive `0.5.0`
automatically, so shipping a security-correctness fix as a minor would keep it
away from the installs that need it. Nothing here removes or reshapes an
existing declaration; the generated `dist/index.d.ts` gains eleven exported
names and loses none.
