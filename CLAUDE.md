# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@tamga/sdk` is the official JavaScript/TypeScript SDK for Tamga (license activation, offline verification, machine management), one of five hand-written per-language SDKs rather than a binding over the shared `tamga-c` core. It is the only Tamga SDK that must run correctly across four distinct runtimes — Node.js ≥18, Deno, Bun, and browsers — from one codebase and a single dual ESM/CJS build.

Full spec and task list: [`docs/plans/tamga-js.plan.md`](../docs/plans/tamga-js.plan.md) — **NOTE**: this file lives one directory up, in the sibling `tamga-sdk` monorepo (`tamga-sdk/docs/plans/tamga-js.plan.md`), not inside this repo — a pre-existing broken relative link in this file pointed at `./docs/plans/tamga-js.plan.md`, which does not exist here; corrected to `../docs/plans/tamga-js.plan.md`. It is the source of truth for scope and checkbox status. Protocol reference this SDK implements against: [`docs/sdk.md`](https://github.com/tamga-sh/tamga-api/blob/main/docs/sdk.md) in `tamga-api` — every field name, endpoint path, and enum value in this codebase should trace back to that file, not to `tamga-api/docs/plans/`.

**Current state**: Sections A–M of `docs/plans/tamga-js.plan.md` are implemented — the full client surface (license validate/check-in/checkout, machine/component/process management, offline proof, entitlements), the offline `.lic`/`.mach` verify/decrypt pipelines, and the typed error model all have real implementations backed by tests (not stubs). Crypto-touching sections (E, F, H) have each passed a mandatory security-reviewer pass (see `docs/plans/tamga-js.plan.md`'s checkboxes for the specific findings, including one real vulnerability found and fixed in `src/internal/canonicalJson.ts`). Check the plan file's checkbox state for the authoritative per-item status before assuming a specific method/field is done.

## Architecture

```
package.json                # "type": "module", exports map (import/require/types), engines.node >=18, packageManager (pnpm via Corepack)
tsup.config.ts               # format: ["esm", "cjs"], dts: true, target: "es2022"
tsconfig.json                 # strict: true, target ES2022, moduleResolution "bundler"
eslint.config.js               # flat config, @typescript-eslint parser+plugin directly (not the typescript-eslint meta-package's recommended presets, to match the pinned dependency set) + no-console
vitest.config.ts                # coverage.provider "v8", 80% thresholds (lines/functions/branches/statements)

src/
  index.ts                   # Public re-exports: TamgaClient, models, errors, checkout, proof
  client.ts                  # TamgaClient: config, all endpoint methods, composed helpers (activate-machine, heartbeat scheduler)
  transport.ts                # fetch-based HTTP layer: 5 auth transports, Tamga-Version/Tamga-OTP headers, quick-validate response special-case
  models/
    validation.ts             # ValidationCode union (24 values, "string & {}" escape hatch), LicenseValidationResult
    license.ts                 # License, LicenseScope (8 fields), Entitlement resource models
    machine.ts                  # Machine, Component, Process resource models, HeartbeatStatus union
    policy.ts                    # Policy, LicenseScheme, OverageStrategy, HeartbeatCullStrategy, HeartbeatResurrectionStrategy
  crypto/
    ed25519.ts                  # Ed25519 verify — @noble/curves/ed25519
    rsa.ts                        # RSA PKCS#1 v1.5 + RSA-PSS verify — native crypto.subtle (WebCrypto), see note below
    ecdsa.ts                       # ECDSA P-256 verify — @noble/curves/p256
    aesGcm.ts                       # AES-256-GCM encrypt/decrypt — native crypto.subtle (WebCrypto)
    hkdf.ts                          # HKDF-SHA256 — @noble/hashes/hkdf
    naiveKey.ts                       # License-checkout's non-KDF key derivation (zero-pad/truncate to 32 bytes)
  checkout/
    licenseFile.ts              # .lic parse/verify/decrypt pipeline (Ed25519-only, naive key)
    machineFile.ts               # Machine file parse/verify/decrypt pipeline (multi-scheme, HKDF key)
  proof.ts                     # Offline proof: byte-exact serialization + RSA-PKCS1v15/SHA-256 verify
  errors.ts                    # TamgaApiError, JSON:API error parsing, typed error code matchers

test/                         # vitest specs, mirrors src/ layout (test/smoke.spec.ts is the only real spec today)
scripts/smoke.mjs             # cross-runtime (Deno/Bun) smoke test against the built dist/ output
```

## Dev Commands

```bash
pnpm install         # first-time setup (corepack enable first if pnpm isn't shimmed yet)
pnpm dev             # tsup --watch
pnpm build           # tsup — verifies dual ESM+CJS + .d.ts/.d.cts output
pnpm lint            # eslint .
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest run
pnpm test:coverage   # vitest run --coverage (80% gate — see Testing below)
pnpm changeset       # record a changeset for the current change
```

There is no `fmt`/`fmt-check` script in this repo — Prettier is not wired in yet; `eslint` is the only style gate. If you add Prettier, wire it into both `pnpm lint` and a `PostToolUse` hook per `~/.claude/rules/ecc/web/hooks.md`, don't hand-run it ad hoc.

**No JS/TS build-resolver agent exists for this stack.** The ecc agent catalogue has `build-error-resolver` (generic) and `react-build-resolver` (React/JSX-specific — not relevant, this SDK has no React dependency). When `tsup`/`tsc` build failures occur here, fall back to `build-error-resolver` first; if that proves insufficiently TS-aware, fall back further to `code-reviewer` for a manual pass. This is a known gap, not an oversight — don't spend time hunting for a Node/TypeScript-library-specific build agent that doesn't exist.

## GOTCHAS

Server-side realities from `docs/sdk.md` → Known Server-Side Gaps that constrain what this SDK should (and should not) build:

- **Auth is not enforced on license or machine endpoints server-side** (gap #3). Every client method still sends `Authorization: License <key>` (or the configured transport) for forward-compatibility — a missing/wrong credential is not currently rejected, but the wire format must be correct for when enforcement lands.
- **Only 14 of 24 `ValidationCode` values are reachable today** (gap #4). `src/models/validation.ts` models all 24 plus a `string & {}` escape hatch — do not write code that treats an unreachable code (`BANNED`, `ENTITLEMENTS_MISSING`, `HEARTBEAT_DEAD`, etc.) as something a caller needs to handle today; document them as forward-compat only.
- **No in-app rate limiting; `429 TOO_MANY_REQUESTS` is never actually returned** (gap #5). Do not build client-side 429/backoff handling — it would be dead code exercised by nothing, and would misrepresent server behavior to SDK consumers reading the source.
- **RFC 9421 HTTP response signing is fully dead code server-side** (gap #6). No API response is ever signed. This SDK does not implement `Tamga-Accept-Signature` or any response-signature verification — there is nothing to verify.
- **`Tamga-Environment` header is not implemented server-side** (gap #7). Do not add it to `src/transport.ts`, even though it's documented as a planned EE feature — no server code path reads it yet.
- **Heartbeat culling ignores `policy.heartbeat_duration`** (gap #8) — both the 600s machine window and the 30s process window are hardcoded server-side. `src/models/machine.ts` and any heartbeat-scheduler helper must document (and default to) those hardcoded windows, not the per-policy field, which the server itself ignores.
- **Freshly-created policies default to enum strings that don't exist** (gap #9) — `overage_strategy: "DENY_ACCESS"` and `heartbeat_resurrection_strategy: "NO_RESURRECTION"` are not real variants and silently behave as `NO_OVERAGE`/`NO_REVIVE`. `src/models/policy.ts` types these fields as the real enum unioned with `string & {}` for exactly this reason — don't "fix" the type to reject them.
- **The release/auto-update endpoint (`GET /releases/actions/upgrade`) crashes at runtime and has no working download-URL endpoint at all** (gaps #1, #2). This SDK does not implement release checking in any form — it is not a v1 deliverable per `docs/sdk.md` §12, not merely deferred tooling. Do not add a "check for update" method.

## Testing

- Vitest, coverage via `@vitest/coverage-v8`, thresholds fixed at 80% (lines/functions/branches/statements) in `vitest.config.ts` — this is the same bar CI enforces (`.github/workflows/ci.yml`), not a stricter local-only check.
- Run everything: `pnpm test:coverage`. Run one file: `pnpm vitest run test/machine-file-ed25519.spec.ts`.
- Coverage sits around 93% statements/lines, 87% branches, 97.5% functions as of Sections A–M landing — comfortably above the 80% gate. `src/internal/base64.ts`'s ~54% is the main outlier (its `atob`/`btoa` browser-fallback branch is unreachable under Node's test environment, where `Buffer` is always defined — a known, documented cross-runtime gap, not a regression to chase).
- Crypto-adjacent test files (`src/checkout/*`, `src/crypto/*`, `src/proof.ts`) require `security-reviewer` sign-off before merge per the plan's Quality Gates table (plan §4) — this is not optional and not satisfied by `code-reviewer` alone. All three mandatory reviews (Sections E, F, H) have been completed; H's review found and fixed a real `__proto__`-keyed signature-bypass vulnerability in `src/internal/canonicalJson.ts` (see git history and the plan file's Section H checkboxes).

## Critical Dependency Notes

**Ed25519 and ECDSA P-256 use `@noble/curves`; HKDF-SHA256 uses `@noble/hashes`, not `crypto.subtle`.** These are audited, pure-TypeScript, zero-native-dependency libraries with identical behavior across all 4 target runtimes. `crypto.subtle`'s Ed25519 support in particular is inconsistent across Node/Deno/Bun/browser today — the asymmetric-signature surface for Ed25519/ECDSA is deliberately kept off WebCrypto entirely rather than branching per runtime. Do not "simplify" ed25519.ts/ecdsa.ts onto WebCrypto.

**⚠️ Deviation from this file's earlier (pre-implementation) draft: RSA (PKCS#1 v1.5 + PSS) verify uses native `crypto.subtle` (WebCrypto), NOT `@noble/curves`.** `@noble/curves` is a pure elliptic-curve library (Ed25519, secp256k1, P-256, BLS12-381, etc.) — it has **no RSA support at all**, so the scaffold-era description above (and the abbreviated Architecture table entry) claiming `rsa.ts` would use `@noble/curves` was never actually implementable. The real `docs/plans/tamga-js.plan.md` §2 always documented the correct alternative in its own parenthetical: *"RSA PKCS#1 v1.5 + RSA-PSS verify — @noble/curves (or WebCrypto RSASSA-*)"* — this implementation takes that WebCrypto branch, which is also consistent with the plan's own reasoning elsewhere ("WebCrypto's RSA verify operations are stable and consistent across all 4 target runtimes, unlike Ed25519"). `src/crypto/rsa.ts`'s module doc comment documents this in full. Because WebCrypto is Promise-based, `verifyRsaPkcs1`/`verifyRsaPss` (and consequently `src/proof.ts` and the RSA branches of `src/checkout/machineFile.ts`) are `async`, unlike the synchronous `@noble/curves`-backed `verifyEd25519`/`verifyEcdsaP256`.

**AES-256-GCM uses native `crypto.subtle` (WebCrypto) directly, with zero npm dependency.** AES-GCM is a symmetric primitive with universal, stable, hardware-accelerated WebCrypto support across all 4 runtimes — there's no correctness or portability reason to pull in `@noble/ciphers` or hand-roll it. Do not move this onto `@noble/*` for "consistency" with the asymmetric primitives above; the two choices (and now RSA's WebCrypto choice too) are pinned to per-primitive runtime-compatibility realities, not a general library preference.

**License-file key derivation (`src/crypto/naiveKey.ts`) is intentionally NOT a KDF** — raw UTF-8 bytes of the license key, zero-padded/truncated to 32 bytes, replicating a real server-side non-hash transform. **Machine-file key derivation (`src/crypto/hkdf.ts`) is a real HKDF-SHA256.** These are two different, correct-for-their-format derivations — don't unify them into one "the license key becomes the AES key" helper.

**Package manager is pnpm via Corepack** (`packageManager` field in `package.json`). Do not add `package-lock.json` or `yarn.lock`; do not run plain `npm install`.

## Branch & Commit Convention

Branches: `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`
Commits: Conventional Commits (`feat: …`, `fix: …`, etc.) — required for Changesets-adjacent tooling and this SDK family's shared release conventions to stay meaningful across repos.
