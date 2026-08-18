# @tamga/sdk

## 0.3.2

### Patch Changes

- 24e52a0: Release automation now opens its version PR with a GitHub App token.

  Release PRs were previously opened with the default `GITHUB_TOKEN`, which GitHub refuses to let
  trigger workflows. CI therefore never reported on the version PR, branch protection blocked it,
  and every release needed an admin override. No package code changed.

## 0.3.1

### Patch Changes

- 3e0ded6: Correct the published documentation and align package metadata.

  The README and the doc comments that render on the package page described
  behaviour the code no longer has: license-file keys documented as a
  zero-pad/truncate transform when they are derived with HKDF-SHA256, and HTTP 429
  documented as never returned and unhandled when the transport parses
  `Retry-After`, backs off with jitter, and retries every `GET` plus the five safe
  `POST` actions. The offline format-v2 compatibility break was undocumented.

  Package keywords and the description are now the same set used across every
  official SDK. No runtime behaviour changed.

## 0.3.0

### Minor Changes

- 74197e1: License-file key derivation replaced with HKDF-SHA256 (the old zero-pad/truncate transform is
  removed, not deprecated). Offline license-file format v2: `alg` must end in `+v2`, signed
  `meta` claims (iat/exp/jti/kid), `exp` enforced with a 60s clock-skew tolerance. HTTP 429
  handling: capped and parsed `Retry-After`, jittered exponential backoff, auto-retry scoped to
  `GET` plus the five safe `POST` actions (`validate`, `validate-key`, `check-in`, `check-out`,
  `ping`) -- creates are deliberately excluded.

  **Compatibility note:** offline license files must be format v2. v1 files are rejected outright
  with no fallback path -- this is a real behavioral break for any caller holding a v1-issued
  `.lic` file, released as a minor version by deliberate choice rather than because the change is
  backward compatible. Treat this note as the actual compatibility warning regardless of the
  semver level.

## 0.2.2

### Patch Changes

- 4db546a: Fix canonical-JSON key sorting to use UTF-8 byte order instead of JS's default UTF-16 code-unit order, matching the server's serde_json BTreeMap ordering. Without this, an offline machine proof whose dataset has keys spanning certain non-ASCII Unicode ranges (BMP Private-Use vs supplementary-plane characters) could fail client-side verification even though it was legitimately signed server-side.

## 0.2.1

### Patch Changes

- 27338ea: Switch npm publishing to Trusted Publishing (OIDC) instead of a stored NPM_TOKEN secret. Fixes a release workflow bug where the auto-generated .npmrc expected NODE_AUTH_TOKEN but the workflow only ever set NPM_TOKEN, so CI publishes were running unauthenticated.

## 0.2.0

### Minor Changes

- 7b6a431: Implement the full `@tamga/sdk` client surface: license validation (by key/by id/quick-validate), check-in, offline license/machine file checkout with signature verification and decryption (Ed25519 + multi-scheme RSA/ECDSA, HKDF and naive-key derivation), machine/component/process management with heartbeat schedulers, machine offline proof generation and verification, entitlements, and a typed JSON:API error hierarchy. Built on native `fetch` and `crypto.subtle` (WebCrypto) plus `@noble/curves`/`@noble/hashes` for cross-runtime (Node/Deno/Bun/browser) consistency.
- 4317819: Initial project scaffold: package/build tooling, stub module layout, CI, and release automation for the `@tamga/sdk` JavaScript/TypeScript SDK. No client, transport, crypto, or checkout logic is implemented yet.
