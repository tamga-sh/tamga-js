# @tamga/sdk

## 0.2.0

### Minor Changes

- 7b6a431: Implement the full `@tamga/sdk` client surface: license validation (by key/by id/quick-validate), check-in, offline license/machine file checkout with signature verification and decryption (Ed25519 + multi-scheme RSA/ECDSA, HKDF and naive-key derivation), machine/component/process management with heartbeat schedulers, machine offline proof generation and verification, entitlements, and a typed JSON:API error hierarchy. Built on native `fetch` and `crypto.subtle` (WebCrypto) plus `@noble/curves`/`@noble/hashes` for cross-runtime (Node/Deno/Bun/browser) consistency.
- 4317819: Initial project scaffold: package/build tooling, stub module layout, CI, and release automation for the `@tamga/sdk` JavaScript/TypeScript SDK. No client, transport, crypto, or checkout logic is implemented yet — see `docs/plans/tamga-js.plan.md` for the remaining implementation tasks (Sections B–M).
