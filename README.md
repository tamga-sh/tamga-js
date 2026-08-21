# @tamga/sdk

[![CI](https://github.com/tamga-sh/tamga-js/actions/workflows/ci.yml/badge.svg)](https://github.com/tamga-sh/tamga-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40tamga%2Fsdk.svg)](https://www.npmjs.com/package/@tamga/sdk)
[![coverage](https://codecov.io/gh/tamga-sh/tamga-js/branch/main/graph/badge.svg)](https://codecov.io/gh/tamga-sh/tamga-js)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Official JavaScript/TypeScript SDK for Tamga. Integrate license activation,
offline verification, and machine management into your JavaScript/TypeScript
applications.

## Install

```bash
npm install @tamga/sdk
```

Also available via `pnpm add @tamga/sdk` or `yarn add @tamga/sdk`. Published on
the npm registry under the `@tamga` scope; the bare `tamga` name on npm belongs
to an unrelated package.

Node.js ≥18, Deno, Bun, and browsers are all supported from a single dual
ESM/CJS build. CI runs lint, typecheck and tests on Node 18/20/22, then executes
the built `dist/` output on Deno and Bun in a separate job
(`.github/workflows/ci.yml`).

- **Node.js / Bun** — install as above.
- **Deno** — import via an `npm:` specifier, no install step:
  [`docs/examples/deno-quickstart.ts`](./docs/examples/deno-quickstart.ts).
- **Browser** — import the built ESM bundle in a `<script type="module">`:
  [`docs/examples/browser-quickstart.html`](./docs/examples/browser-quickstart.html).

## Quickstart

```ts
import { TamgaClient } from "@tamga/sdk";

const licenseKey = "YOUR-LICENSE-KEY";

const client = new TamgaClient({
  accountId: "your-account-id",
  baseUrl: "https://api.tamga.sh",
  auth: { kind: "license", key: licenseKey },
});

const { license, meta } = await client.validateByKey(licenseKey);

if (meta.valid) {
  console.log(`License ${license.id} is valid.`);
} else {
  // Match on `meta.code` — it is the stable, machine-readable outcome.
  // `meta.detail` is human text whose wording changes between server versions.
  console.log(`License ${license.id} is not valid: ${meta.code}`);
}
```

Every networked operation is a method on `TamgaClient`. `licenseId` /
`machineId` / `processId` / `entitlementId` are the resource's UUID, and every
method sends whatever `auth` transport was configured.

| Method | Endpoint |
|---|---|
| `validateByKey(key)` | `POST /licenses/actions/validate-key` |
| `validateById(licenseId, { scope?, skipTouch? })` | `POST /licenses/{id}/actions/validate` |
| `quickValidate(licenseId)` | `GET /licenses/{id}/actions/validate` |
| `checkIn(licenseId)` | `POST /licenses/{id}/actions/check-in` |
| `checkOutLicense(licenseId, { encrypt?, ttl? })` | `GET /licenses/{id}/actions/check-out` (raw PEM) |
| `checkOutLicenseJson(licenseId, { encrypt?, ttl? })` | `POST /licenses/{id}/actions/check-out` (JSON:API resource) |
| `checkOutMachine(machineId, { encrypt?, ttl? })` | `GET /machines/{id}/actions/check-out` (raw PEM) |
| `checkOutMachineJson(machineId, { encrypt?, ttl? })` | `POST /machines/{id}/actions/check-out` (JSON:API resource) |
| `createMachine(licenseId, fingerprint, opts?)` | `POST /machines` |
| `activateMachine(licenseId, fingerprint, opts?, scope?, autoDeleteOnOverage?)` | composed: create + validate |
| `pingHeartbeat(machineId)` | `POST /machines/{id}/actions/ping-heartbeat` |
| `resetHeartbeat(machineId)` | `POST /machines/{id}/actions/reset-heartbeat` |
| `deleteMachine(machineId)` | `DELETE /machines/{id}` |
| `startHeartbeat(machineId, intervalMs)` | convenience scheduler around `pingHeartbeat` |
| `generateOfflineProof(machineId, dataset?)` | `POST /machines/{id}/actions/generate-offline-proof` |
| `createComponent(machineId, fingerprint, name, metadata?)` | `POST /components` |
| `listComponents(machineId, { limit?, after? })` | `GET /machines/{id}/components` |
| `createProcess(machineId, pid, metadata?)` | `POST /processes` |
| `pingProcess(processId)` | `POST /processes/{id}/actions/ping` |
| `startProcessHeartbeat(processId, intervalMs?)` | convenience scheduler around `pingProcess` |
| `listEntitlements(licenseId, { limit?, after? })` | `GET /licenses/{id}/entitlements` |
| `getEntitlement(licenseId, entitlementId)` | `GET /licenses/{id}/entitlements/{entitlementId}` |
| `hasEntitlement(licenseId, code, limit?)` | convenience wrapper around `listEntitlements` |

Four of these need a caveat before you wire them in:

- `quickValidate` does not record the validation when the request carries an
  `Origin` header — which a browser always adds. See **Known gaps**.
- `resetHeartbeat` and `generateOfflineProof` are role-gated and always `403`
  for a license-key credential. See **Auth transports**.
- `listEntitlements` ignores `after`: that route is not paginable server-side.
- `createMachine`'s `memory` / `disk` are **megabytes**.

Errors are typed subclasses of `TamgaError` (`NotFoundError`,
`FingerprintTakenError`, `MachineLimitExceededError`,
`LicenseNotAllowedError`, `CheckInNotRequiredError`, …). Match on the stable
`.code`, never on `.message` / `.detail`.

More runnable examples — scoped validation, machine heartbeats, offline `.lic` /
`.mach` verification, offline proof tokens, Deno and browser quickstarts — live
in [`docs/examples/`](./docs/examples).

## Auth transports

Five transports are modelled; pass one as `auth` in `TamgaClientConfig`
(`src/transport.ts::authHeaders`, `src/transport.ts::authQueryParam`).

```ts
import type { AuthCredentials } from "@tamga/sdk";

// The primary transport for embedded/client SDKs.
const license: AuthCredentials = { kind: "license", key: "YOUR-LICENSE-KEY" };

const bearer: AuthCredentials = { kind: "bearer", token: "tok-..." };

// Basic has three sub-forms: "email-password", "token", "license-key".
const basic: AuthCredentials = { kind: "basic", form: "token", token: "tok-..." };

// Browser/portal-only — requires a matching Origin header.
const cookie: AuthCredentials = {
  kind: "cookie",
  sessionId: "00000000-0000-0000-0000-000000000000",
  origin: "https://app.example.com",
};

// Sent as ?token=… instead of a header.
const query: AuthCredentials = { kind: "query", token: "tok-..." };
```

Tokens are treated as opaque strings throughout — there is no prefix-based type
detection. A raw license key embedded in browser-shipped code is inherently
visible to the end user; that is expected for the `license` transport. Never
embed a Bearer or Basic *account* credential in client-side code.

> [!IMPORTANT]
> **Auth is enforced server-side, and a license key is not automatically a
> valid credential.** The server accepts `Authorization: License <key>` only
> when the license's policy sets `authentication_strategy` to `"LICENSE"` or
> `"MIXED"`. That column **defaults to `"TOKEN"`**, and `"NONE"` rejects the
> key the same way — so against a default policy every call returns
> `401 LICENSE_NOT_ALLOWED` (`LicenseNotAllowedError`). It is a configuration
> precondition, not a retryable auth failure: no retry, key rotation, or
> re-prompt can fix it, only a policy change.
>
> Two further limits on a license-key credential:
>
> - `resetHeartbeat` and `generateOfflineProof` are **role**-gated, not
>   permission-gated, and always answer `403` for it. Proofs have to be minted
>   by a backend holding an account-level token; `verifyOfflineProof` needs no
>   credential and is the half a client can run.
> - An expired license whose policy uses `expiration_strategy:
>   "REVOKE_ACCESS"` is rejected at the auth gate with `401 LICENSE_EXPIRED`,
>   so validate is not reachable to report the expiry. Under the other three
>   strategies it authenticates and comes back as an `EXPIRED` validation code.

## Offline verification

These functions never touch the network once the relevant public key is embedded
in your application, so they work in air-gapped environments.

| Function | Purpose |
|---|---|
| `verifyAndDecryptLicenseFile(pem, ed25519PublicKey, licenseKey?, now?)` | Verify, decrypt and expiry-check a `.lic` file |
| `verifyAndDecryptMachineFile(pem, scheme, publicKey, keyMaterial?)` | Verify and decrypt a `.mach` file (multi-scheme) |
| `verifyOfflineProof(proof, accountId, machineId, fingerprint, dataset, rsaPublicKey)` | Verify a `"v1x0."` offline proof token |

```ts
import { TamgaClient, CheckoutError, verifyAndDecryptLicenseFile } from "@tamga/sdk";

declare const client: TamgaClient;
declare const licenseId: string;
// Your account's Ed25519 public key: 32 raw bytes, embedded at build time.
// Fetching it at verify time would defeat the point of offline verification.
declare const ed25519PublicKey: Uint8Array;

const pem = await client.checkOutLicense(licenseId, { encrypt: true, ttl: 24 * 3600 });

try {
  const license = await verifyAndDecryptLicenseFile(pem, ed25519PublicKey, "YOUR-LICENSE-KEY");
  console.log(`Verified offline: ${license.id} (${license.attributes.status})`);
} catch (error) {
  if (error instanceof CheckoutError && error.kind === "expired") {
    console.log("Authentic, but past its signed expiry — check out a fresh file.");
  } else {
    throw error;
  }
}
```

Pass a trusted timestamp as the fourth argument (`now`, in Unix seconds) when
you are defending against a user winding the local clock back.

Machine files are multi-scheme: the signing algorithm comes from the governing
license's own `scheme` field, which you pass in — never from the file's
self-declared `alg` string.

```ts
import { verifyAndDecryptMachineFile, type LicenseScheme } from "@tamga/sdk";

declare const machPem: string;
declare const publicKey: Uint8Array;

// If the license has no scheme set, the server signs with Ed25519 by default.
const scheme: LicenseScheme = "ED25519_SIGN";

const machine = await verifyAndDecryptMachineFile(machPem, scheme, publicKey, {
  licenseKey: "YOUR-LICENSE-KEY",
  fingerprint: "fp-abc123",
});
```

> **Compatibility warning — offline license files must be format v2.**
> `alg` must end in `+v2` and the signed payload must carry its `meta` claims.
> A `.lic` file issued under v1 is **rejected outright, with no fallback path**
> (`src/checkout/licenseFile.ts::verifyLicenseFileWithClaims`). This is a real
> behavioural break for any caller still holding a v1-issued file: re-run
> checkout to obtain a v2 file. Machine files are unaffected — they have no v2
> format.

## Security notes

This SDK reimplements Tamga's offline file cryptography from scratch, on audited
primitives (`@noble/curves`, `@noble/hashes`) and native `crypto.subtle`. Every
claim below names the code that implements it.

- **License-file and machine-file AES keys are both HKDF-SHA256 (RFC 5869).**
  License files bind `salt = "tamga:license-file-key-v1"`, `ikm = <license key>`,
  `info = "license-file"` (`src/crypto/hkdf.ts::deriveLicenseFileKey`). Machine
  files bind `salt = "tamga:machine-file-key-v1"`, `ikm = <license key>`,
  `info = <fingerprint>` (`src/checkout/machineFile.ts::verifyAndDecryptMachineFile`,
  via `src/crypto/hkdf.ts::deriveHkdfKey`), so a machine file cannot be decrypted
  anywhere but on the machine it was issued for. The pre-v2 transform that
  zero-padded the raw license key to 32 bytes was **deleted, not deprecated** —
  no code path can produce that key any more.
- **A license file's expiry is inside the signature and is enforced for you.**
  `meta.exp` is checked with a 60-second clock-skew tolerance and an expired file
  throws `CheckoutError` of kind `"expired"`
  (`src/checkout/licenseFile.ts::verifyLicenseFileWithClaims`). The tolerance is
  deliberately small: the client's clock belongs to the attacker, so a generous
  allowance would be a free extension on every expired file. The `ttl` / `expiry`
  fields on the checkout *envelope* remain unsigned metadata and must not be
  trusted.
- **The signature covers `enc`'s base64 *string* bytes, not its decoded bytes.**
  A non-obvious wire-format detail, and the highest-risk interop bug in any
  from-scratch reimplementation — verifying against decoded bytes accepts some
  forgeries and rejects some valid files
  (`src/checkout/licenseFile.ts::verifyLicenseFileWithClaims`, regression test
  `test/license-file-signing-gotcha.spec.ts`).
- **Ed25519 verification is strict.** `zip215: false`, i.e. RFC 8032 / FIPS 186-5
  semantics, rejecting malleable signatures and non-canonical `S`
  (`src/crypto/ed25519.ts::verifyEd25519`).
- **Algorithm confusion is guarded twice.** The scheme is chosen by the caller,
  never parsed from the file, and the file's declared `alg` suffix must match
  what that scheme implies; `RSA_2048_JWT_RS256` is rejected up front, before any
  parsing (`src/checkout/machineFile.ts::verifyAndDecryptMachineFile`).
- **Offline-proof payloads are canonicalised before verification**, sorted by
  UTF-8 byte order and rebuilt on a null-prototype accumulator so a
  `"__proto__"`-keyed dataset cannot silently drop a field from the signed bytes
  (`src/internal/canonicalJson.ts::canonicalJsonStringify`, exercised by
  `test/canonical-json-utf8-sort.spec.ts` and `test/proof-field-order.spec.ts`).
- **HTTP 429 is retried with backoff.** `Retry-After` is parsed as delta-seconds
  and capped at 60s (`src/transport.ts::parseRetryAfter`,
  `src/transport.ts::retryDelayMs`); without it, exponential backoff with jitter
  so a fleet does not reconverge into the spike it was backing off from. Retries
  are scoped to `GET` plus seven effectively-idempotent `POST` actions —
  `validate`, `validate-key`, `check-in`, `check-out`, `ping`,
  `ping-heartbeat`, `reset-heartbeat` (`src/transport.ts::isRetryable`).
  **Creates are deliberately excluded**: retrying `POST /machines` can burn a
  second seat, and only you know whether that is acceptable. The budget is
  three retries (`src/transport.ts::doFetch`).
- **Requests have a deadline.** Each attempt is capped at
  `DEFAULT_TIMEOUT_MS` (45s), overridable per client via
  `TamgaClientConfig.timeoutMs`, or disabled with `0`. It sits deliberately
  past the API's own 30s gateway timeout so the server wins that race and you
  get its `504` — the response that carries the `X-Request-Id` support needs
  — instead of an opaque local abort.

Reporting a vulnerability: see [`SECURITY.md`](./SECURITY.md).

## Known gaps

Things this SDK deliberately does not do, or cannot do yet.

- **Signed license-file claims are not reachable from the published package.**
  `verifyLicenseFileWithClaims` returns `jti` (replay detection) and `kid` (key
  rotation) alongside the license, and accepts an injectable clock, but it is
  not re-exported from the package entrypoint and the `exports` map has no deep
  import path. `verifyAndDecryptLicenseFile` still enforces `exp`; only the
  claim values are unavailable.
- **Machine files have no signed expiry.** Format v2 covers `.lic` only. A
  `.mach` file's `ttl` / `expiry` are unsigned envelope metadata, so nothing here
  can enforce a machine file's lifetime — treat it as perpetual once issued.
- **The 429 retry budget is not configurable.** It is fixed at three attempts and
  is not plumbed through `TamgaClientConfig`.
- **`X-RateLimit-*` response headers are unavailable** — no server handler sets
  them, so `Retry-After` on a 429 is the only rate-limit signal to read.
- **No release / auto-update checking.** Not implemented in any form. (Earlier
  versions of this note claimed the upgrade endpoint crashed at runtime and
  that no artifact-download route existed. Both were wrong: the upgrade
  handler is live and public, and the download route exists. Not shipping a
  release-check method is a scope decision here, not a server limitation.)
- **`GET /licenses/{id}/entitlements` cannot be paginated.** The listing is a
  union of the license's direct entitlements and the ones inherited from its
  policy, so no single keyset cursor describes it and the server ignores
  `page[after]`. `listEntitlements` sends the server maximum (`limit=100`)
  when you give no explicit limit, and does not send the cursor;
  `ListOptions.after` is accepted on the shared type but has no effect on
  this route. A license with more than 100 effective entitlements cannot be
  fully enumerated, so a `false` from `hasEntitlement` is only authoritative
  below that ceiling. `listComponents` is unaffected — its cursor works.
- **`quickValidate` does not always record the validation.** The server skips
  the `last_validated_at` write whenever the request carries an `Origin`
  header, and the response is byte-identical either way, so there is nothing
  to branch on. In a browser this is unavoidable: the browser adds `Origin`
  to a cross-origin `fetch` itself and script cannot suppress it, so
  quick-validate from a browser **never** records a validation. That leaves a
  license with no machines reading as `INACTIVE` and keeps the
  check-in-overdue worker firing. Use `validateById` when the write matters —
  the `POST` route has no `Origin` branch.
- **No RFC 9421 response-signature verification.** No API response is signed, so
  there is nothing to verify.
- **No `Tamga-Environment` request header.** No server code path reads it yet.
- **`scope.version` and `scope.checksum` are dead.** The server answers
  `422 SCOPE_NOT_SUPPORTED` to a scope carrying either and never runs the
  validation, so `validateById` strips both before sending rather than letting
  them fail the whole call. They are deprecated and will be removed in the
  next minor release. The other six scope fields — including `entitlements`
  (matched on entitlement **codes**, case-insensitively, across direct and
  inherited rows) and `fingerprint` (matched against any machine on the
  license) — are genuinely enforced.
- **Machine `memory` and `disk` are megabytes, not bytes.** They feed the
  license's memory/disk tallies and the activation limit check, so reporting
  16 GB as `17179869184` instead of `16384` inflates the account tally by
  roughly a million and gets the next activation on that license refused with
  `MEMORY_LIMIT_EXCEEDED`.
- **Ten of the 24 `ValidationCode` values are not reachable today.** They are
  modelled for forward-compatibility (`src/models/validation.ts`); do not write
  logic that depends on receiving one. (`ENTITLEMENTS_MISSING` and
  `FINGERPRINT_SCOPE_MISMATCH` have since become reachable — the scope fields
  behind them are enforced now.)

## Documentation

- [`docs/examples/`](./docs/examples) — runnable end-to-end examples.
- <https://tamga.sh> — product and API documentation.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, commands, and the
  security-review requirement for crypto-touching changes.
- [`SECURITY.md`](./SECURITY.md) — vulnerability reporting and what counts as a
  security issue here.

## License

[MIT](./LICENSE) © Tamga
