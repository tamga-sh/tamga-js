# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@tamga/sdk` is the official JavaScript/TypeScript SDK for Tamga (license activation, offline verification, machine management), one of eight hand-written per-language SDKs rather than a binding over the shared `tamga-c` core. It is the only Tamga SDK that must run correctly across four distinct runtimes — Node.js ≥18, Deno, Bun, and browsers — from one codebase and a single dual ESM/CJS build.

The Tamga API protocol specification is the source of truth for wire format, endpoint paths, and enum values. It is not a public document and is not part of this repository — never link to it from any file published to npm or visible to external readers; link to <https://tamga.sh> instead.

**Current state**: the full client surface (license validate/check-in/checkout, machine/component/process management, offline proof, entitlements), the offline `.lic`/`.mach` verify/decrypt pipelines, and the typed error model all have real implementations backed by tests (not stubs). Offline license files are at format v2: HKDF-SHA256 key derivation, signed `iat`/`exp`/`jti`/`kid` claims, enforced expiry, and outright rejection of v1 files. Crypto-touching work has passed a mandatory security review, which found and fixed a real `__proto__`-keyed signature-bypass vulnerability in `src/internal/canonicalJson.ts`.

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
    hkdf.ts                          # HKDF-SHA256 for both file formats — @noble/hashes/hkdf
  checkout/
    licenseFile.ts              # .lic parse/verify/decrypt pipeline (format v2, Ed25519-only, HKDF key, enforces signed meta.exp)
    machineFile.ts               # Machine file parse/verify/decrypt pipeline (multi-scheme, HKDF key)
  proof.ts                     # Offline proof: byte-exact serialization + RSA-PKCS1v15/SHA-256 verify
  errors.ts                    # TamgaApiError, JSON:API error parsing, typed error code matchers

test/                         # vitest specs, mirrors src/ layout (39 spec files; helpers/ holds shared fetch mocks + checkout fixtures)
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

Server-side realities from the Tamga API protocol specification → Known Server-Side Gaps that constrain what this SDK should (and should not) build:

- **Auth IS enforced server-side, and license-key auth is off by default.** An `Authorization: License <key>` credential is only accepted when the license's policy sets `authentication_strategy` to `LICENSE` or `MIXED`; the column defaults to `TOKEN`, and `NONE` rejects it the same way. Against a default policy every call returns `401 LICENSE_NOT_ALLOWED` — a configuration precondition, not a retryable auth failure, so never put that code in a retry loop. Two more license-key realities: `resetHeartbeat` and `generateOfflineProof` are role-gated and always `403` for it, and an expired license under `expiration_strategy: REVOKE_ACCESS` is rejected at the auth gate with `401 LICENSE_EXPIRED` rather than reaching validate.
- **16 of 24 `ValidationCode` values are reachable today** (gap #4, as amended by M8). `src/models/validation.ts` models all 24 plus a `string & {}` escape hatch — do not write code that treats one of the eight unreachable codes (`BANNED`, `HEARTBEAT_DEAD`, `TOO_MANY_USERS`, etc.) as something a caller needs to handle today; document those as forward-compat only. ⚠️ `ENTITLEMENTS_MISSING` and `FINGERPRINT_SCOPE_MISMATCH` are **no longer** in that set: the server genuinely enforces `scope.entitlements`/`scope.fingerprint` (`validate_license.rs:143-178` `resolve_scope_facts`), so a scoped `validateById` really can return either and every doc surface here must treat them as live outcomes.
- **`429 TOO_MANY_REQUESTS` is live and is handled.** Credential-accepting endpoints run on a tight per-IP budget, and the calls a licensing client makes on a timer sit inside it. `src/transport.ts` parses and caps `Retry-After`, falls back to jittered exponential backoff, and retries `GET` plus seven safe `POST` actions (`validate`, `validate-key`, `check-in`, `check-out`, `ping`, `ping-heartbeat`, `reset-heartbeat`). Creates are excluded on purpose — retrying `POST /machines` can burn a second seat. ⚠️ `ping-heartbeat`/`reset-heartbeat` do **not** end in `/actions/ping` (that is the *process* route) and need their own suffix entries — they were missing, and a dropped heartbeat is what flips a live machine to `DEAD`.
- **`POST /machines` runs the limit checks; they are not all deferred to validate.** The create-time check is routed through the policy's `overage_strategy`, so under `NO_OVERAGE` an over-limit create is refused with `422 MACHINE_LIMIT_EXCEEDED` / `CORE_LIMIT_EXCEEDED` / `MEMORY_LIMIT_EXCEEDED` / `DISK_LIMIT_EXCEEDED`, while an overage-permitting strategy lets the create through and surfaces the same condition later as a `TOO_MANY_*` / `TOO_MUCH_*` `ValidationCode`. `activateMachine` handles both: it normalizes the create-time code onto the validate-time one, and keeps the create→validate→rollback path for the overage case. Do not collapse the two paths — a create-time refusal has no machine to roll back.
- **Machine `memory` and `disk` are MEGABYTES, not bytes.** They feed `licenses.machines_memory_count` / `machines_disk_count` and the activation-time limit check. Reporting 16 GB as `17179869184` inflates the account tally by ~1e6 and gets the next activation refused with `MEMORY_LIMIT_EXCEEDED`. 16 GB is `16384`.
- **`GET /licenses/{id}/entitlements` is not paginable.** The listing is a union of the license's direct attachments and its policy-inherited rows, so no single keyset cursor describes it and the server ignores `page[after]` outright — sending it re-fetches page one forever. `limit` (max 100, default 25) is the only bound, and the response carries no `meta.page`, no `links`, and no total. `listEntitlements` sends 100 when no limit is given and deliberately does not send the cursor; `hasEntitlement`'s `false` is only authoritative below that ceiling. `/machines/{id}/components` is different — its cursor genuinely works.
- **Quick-validate does not always record the validation.** `GET /licenses/{id}/actions/validate` skips the `last_validated_at` write whenever the request carries an `Origin` header, and the response is identical either way. A browser attaches `Origin` to a cross-origin `fetch` itself and script cannot suppress it, so from a browser — this SDK's first-class runtime — quick-validate **never** records a validation. The consequences are real: a license with `machines_count == 0` and a null `last_validated_at` reads as `INACTIVE`, and the check-in-overdue worker keeps firing off the same column. Use `validateById` (the `POST` route, which has no `Origin` branch) when the write matters.
- **RFC 9421 HTTP response signing is fully dead code server-side** (gap #6). No API response is ever signed. This SDK does not implement `Tamga-Accept-Signature` or any response-signature verification — there is nothing to verify.
- **`Tamga-Environment` header is not implemented server-side** (gap #7). Do not add it to `src/transport.ts`, even though it's documented as a planned EE feature — no server code path reads it yet.
- **The machine heartbeat window IS `policy.heartbeat_duration`** (M4 — this reverses the old gap #8 claim, which said the server ignored the field). `Policy::effective_heartbeat_duration_secs` (`tamga-api/src/features/policies/model.rs:262-264`) returns `heartbeat_duration` when set and falls back to 600s only when it is null, and the cull job's claim query agrees (`workers/machine_jobs.rs:213`, `COALESCE(p.heartbeat_duration, 600)`). The **process** window is the one that really is hardcoded — a flat 30s regardless of any policy field — so leave those statements alone. ⚠️ Do not overcorrect into promising adaptivity: this SDK ships no `getPolicy`/`getMachine`, so it cannot read the effective window. `MACHINE_HEARTBEAT_WINDOW_MS` must be documented as the **600s fallback** and `startHeartbeat` as a scheduler the caller sizes by hand — every surface that states the policy-driven fact must state that limitation in the same breath, or a reader concludes the SDK adapts when it does not. Adding a policy read to close that gap is a separate, non-patch change.
- **`DEAD` does NOT mean the machine row was culled** — and any doc, comment or example here that says otherwise is wrong and must be corrected on sight. `Machine::heartbeat_status*` derives the status purely from `last_heartbeat_at` versus the effective window and never consults `require_heartbeat`, while the cull worker returns early for any policy where `require_heartbeat` is false (its claim query requires `AND p.require_heartbeat`) — and that column **defaults to `FALSE`**. On a default policy nothing is ever culled, so a machine reports `DEAD` *forever* with its row and its seat still there. A ping to a `DEAD` machine succeeds and revives it: the handler is a bare `SET last_heartbeat_at = NOW()` with no resurrection check. Therefore: a scheduler must **keep pinging through `DEAD`** — never stop, clear or short-circuit a heartbeat timer on a `DEAD` observation (that exact bug shipped in `tamga-python`) — and the only trustworthy "the row is gone" signal is a **`404 NOT_FOUND` from the ping itself**, which is where re-activation belongs.
- **Freshly-created policies default to enum strings that don't exist** (gap #9) — `overage_strategy: "DENY_ACCESS"` and `heartbeat_resurrection_strategy: "NO_RESURRECTION"` are not real variants and silently behave as `NO_OVERAGE`/`NO_REVIVE`. `src/models/policy.ts` types these fields as the real enum unioned with `string & {}` for exactly this reason — don't "fix" the type to reject them.
- **The release/auto-update endpoint works.** The earlier directive here — that `GET /releases/actions/upgrade` crashes at runtime and that no artifact-download route exists — was wrong on both counts, and it was blocking work rather than describing a constraint. The upgrade handler is live and public (no credential required), answers `204 No Content` when the caller is already current, and returns a `releases` resource otherwise. The artifact download route exists too, though it is currently walled off by a permission the license-key role does not hold. This SDK still ships no release-checking method — that is a scope decision, not an impossibility. If one is added: `channel` should be required at the API surface (omitting it matches *every* channel, alpha and dev included), `constraint` defaults to patch-only `~x.y.z` when omitted, `product` is the product **UUID** and not its code, and the handler uses a bare query extractor so a malformed query comes back as plain-text `400`, not JSON:API — the error decoder has to tolerate that.

## Testing

- Vitest, coverage via `@vitest/coverage-v8`, thresholds fixed at 80% (lines/functions/branches/statements) in `vitest.config.ts` — this is the same bar CI enforces (`.github/workflows/ci.yml`), not a stricter local-only check.
- Run everything: `pnpm test:coverage`. Run one file: `pnpm vitest run test/machine-file-ed25519.spec.ts`.
- Coverage sits comfortably above the 80% gate (low-to-mid 90s on statements/lines). `src/internal/base64.ts`'s ~54% is the main outlier (its `atob`/`btoa` browser-fallback branch is unreachable under Node's test environment, where `Buffer` is always defined — a known, documented cross-runtime gap, not a regression to chase).
- Changes under `src/checkout/*`, `src/crypto/*`, or `src/proof.ts` require a security review before merge (see `SECURITY.md` and `CONTRIBUTING.md`) — this is a human PR gate, not a CI job, and is not satisfied by a general code review alone. One such review found and fixed a real `__proto__`-keyed signature-bypass vulnerability in `src/internal/canonicalJson.ts`.

## Critical Dependency Notes

**Ed25519 and ECDSA P-256 use `@noble/curves`; HKDF-SHA256 uses `@noble/hashes`, not `crypto.subtle`.** These are audited, pure-TypeScript, zero-native-dependency libraries with identical behavior across all 4 target runtimes. `crypto.subtle`'s Ed25519 support in particular is inconsistent across Node/Deno/Bun/browser today — the asymmetric-signature surface for Ed25519/ECDSA is deliberately kept off WebCrypto entirely rather than branching per runtime. Do not "simplify" ed25519.ts/ecdsa.ts onto WebCrypto.

**RSA (PKCS#1 v1.5 + PSS) verify uses native `crypto.subtle` (WebCrypto), NOT `@noble/curves`.** `@noble/curves` is a pure elliptic-curve library (Ed25519, secp256k1, P-256, BLS12-381) with **no RSA support at all**, and WebCrypto's RSA verify operations are stable across all 4 target runtimes (unlike its Ed25519 support). `src/crypto/rsa.ts`'s module doc comment documents this in full. Because WebCrypto is Promise-based, `verifyRsaPkcs1`/`verifyRsaPss` — and consequently `src/proof.ts` and the RSA branches of `src/checkout/machineFile.ts` — are `async`, unlike the synchronous `@noble/curves`-backed `verifyEd25519`/`verifyEcdsaP256`.

**AES-256-GCM uses native `crypto.subtle` (WebCrypto) directly, with zero npm dependency.** AES-GCM is a symmetric primitive with universal, stable, hardware-accelerated WebCrypto support across all 4 runtimes — there's no correctness or portability reason to pull in `@noble/ciphers` or hand-roll it. Do not move this onto `@noble/*` for "consistency" with the asymmetric primitives above; the two choices (and now RSA's WebCrypto choice too) are pinned to per-primitive runtime-compatibility realities, not a general library preference.

**Both file formats derive their AES key with HKDF-SHA256 (`src/crypto/hkdf.ts`), with different parameters.** License files: `salt = "tamga:license-file-key-v1"`, `ikm = <license key>`, `info = "license-file"`. Machine files: `salt = "tamga:machine-file-key-v1"`, `ikm = <license key>`, `info = <fingerprint>`. The pre-v2 zero-pad/truncate transform and its `naiveKey.ts` module were **deleted, not deprecated** — keeping them exported would let a caller silently opt back into the weaker derivation. Don't collapse the two derivations into one helper: the differing salt/`info` is what keeps a machine file undecryptable anywhere but on the machine it was issued for.

**Package manager is pnpm via Corepack** (`packageManager` field in `package.json`). Do not add `package-lock.json` or `yarn.lock`; do not run plain `npm install`.

## Branch & Commit Convention

Branches: `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`
Commits: Conventional Commits (`feat: …`, `fix: …`, etc.) — required for Changesets-adjacent tooling and this SDK family's shared release conventions to stay meaningful across repos.
