---
"@tamga/sdk": minor
---

Implement the full `@tamga/sdk` client surface: license validation (by key/by id/quick-validate), check-in, offline license/machine file checkout with signature verification and decryption (Ed25519 + multi-scheme RSA/ECDSA, HKDF and naive-key derivation), machine/component/process management with heartbeat schedulers, machine offline proof generation and verification, entitlements, and a typed JSON:API error hierarchy. Built on native `fetch` and `crypto.subtle` (WebCrypto) plus `@noble/curves`/`@noble/hashes` for cross-runtime (Node/Deno/Bun/browser) consistency.
