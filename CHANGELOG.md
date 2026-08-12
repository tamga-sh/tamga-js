# @tamga/sdk

## 0.2.2

### Patch Changes

- 4db546a: Fix canonical-JSON key sorting to use UTF-8 byte order instead of JS's default UTF-16 code-unit order, matching the server's serde_json BTreeMap ordering. Without this, an offline machine proof whose dataset has keys spanning certain non-ASCII Unicode ranges (BMP Private-Use vs supplementary-plane characters) could fail client-side verification even though it was legitimately signed server-side.

## 0.2.1

### Patch Changes

- 27338ea: Switch npm publishing to Trusted Publishing (OIDC) instead of a stored NPM_TOKEN secret. Fixes a release workflow bug where the auto-generated .npmrc expected NODE_AUTH_TOKEN but the workflow only ever set NPM_TOKEN, so CI publishes were running unauthenticated.

## 0.2.0

### Minor Changes

- 7b6a431: Implement the full `@tamga/sdk` client surface: license validation (by key/by id/quick-validate), check-in, offline license/machine file checkout with signature verification and decryption (Ed25519 + multi-scheme RSA/ECDSA, HKDF and naive-key derivation), machine/component/process management with heartbeat schedulers, machine offline proof generation and verification, entitlements, and a typed JSON:API error hierarchy. Built on native `fetch` and `crypto.subtle` (WebCrypto) plus `@noble/curves`/`@noble/hashes` for cross-runtime (Node/Deno/Bun/browser) consistency.
- 4317819: Initial project scaffold: package/build tooling, stub module layout, CI, and release automation for the `@tamga/sdk` JavaScript/TypeScript SDK. No client, transport, crypto, or checkout logic is implemented yet — see `docs/plans/tamga-js.plan.md` for the remaining implementation tasks (Sections B–M).
