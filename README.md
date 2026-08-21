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
| `activateMachine(licenseId, fingerprint, opts?, scope?, autoDeleteOnOverage?, reuseExistingMachine?)` | composed: create + validate |
| `getLicense(licenseId)` | `GET /licenses/{id}` |
| `getLicensePolicy(licenseId)` | `GET /licenses/{id}/policy` |
| `getPolicy(policyId)` | `GET /policies/{id}` |
| `getMachine(machineId)` | `GET /machines/{id}` |
| `listMachines(opts?)` | `GET /machines` (**offset**-paginated) |
| `findMachineByFingerprint(licenseId, fingerprint, opts?)` | composed: search + exact re-check |
| `updateMachine(machineId, attrs)` | `PATCH /machines/{id}` |
| `pingHeartbeat(machineId)` | `POST /machines/{id}/actions/ping-heartbeat` |
| `resetHeartbeat(machineId)` | `POST /machines/{id}/actions/reset-heartbeat` |
| `deleteMachine(machineId)` | `DELETE /machines/{id}` |
| `startHeartbeat(machineId, intervalMs)` | convenience scheduler around `pingHeartbeat` |
| `startHeartbeatFromPolicy(machineId, licenseId, opts?)` | `startHeartbeat`, interval read off the policy |
| `resolveHeartbeatWindowMs(licenseId)` | the policy's real heartbeat window, in ms |
| `generateOfflineProof(machineId, dataset?)` | `POST /machines/{id}/actions/generate-offline-proof` |
| `createComponent(machineId, fingerprint, name, metadata?)` | `POST /components` |
| `listComponents(machineId, { limit?, after? })` | `GET /machines/{id}/components` |
| `createProcess(machineId, pid, metadata?)` | `POST /processes` |
| `pingProcess(processId)` | `POST /processes/{id}/actions/ping` |
| `deleteProcess(processId)` | `DELETE /processes/{id}` |
| `listMachineProcesses(machineId, { limit?, after? })` | `GET /machines/{id}/processes` |
| `startProcessHeartbeat(processId, intervalMs?)` | convenience scheduler around `pingProcess` |
| `listEntitlements(licenseId, { limit?, after? })` | `GET /licenses/{id}/entitlements` |
| `getEntitlement(licenseId, entitlementId)` | `GET /licenses/{id}/entitlements/{entitlementId}` |
| `hasEntitlement(licenseId, code, limit?)` | convenience wrapper around `listEntitlements` |
| `checkForUpgrade(opts)` | `GET /releases/actions/upgrade` |
| `health()` | `GET /v1/health` (not account-scoped) |
| `dispose()` | stops every timer this client started |

Several of these need a caveat before you wire them in:

- `quickValidate` does not record the validation when the request carries an
  `Origin` header — which a browser always adds. See **Known gaps**.
- `resetHeartbeat` and `generateOfflineProof` are role-gated and always `403`
  for a license-key credential. So is `getPolicy`, which needs `policy.read`;
  use `getLicensePolicy` instead, which needs only `license.read`. See
  **Auth transports**.
- `listEntitlements` ignores `after`: that route is not paginable server-side.
- **`listMachines` is offset-paginated and every other list here is not.** It
  takes `page` / `size` and returns `{ items, page: { number, size, total,
  totalPages } }`; `listComponents` and `listMachineProcesses` take
  `limit` / `after` and return a bare array. Sending the wrong one is silent in
  both directions.
- `createMachine`'s `memory` / `disk` are **megabytes**, and so are
  `updateMachine`'s — which also cannot clear a field back to `null`.
- `startHeartbeat` never stops on a `heartbeat_status` value — and a ping
  cannot report `"DEAD"` in the first place (a machine *read* can). See
  **Known gaps**.
- `checkForUpgrade` returning `undefined` does **not** mean you are up to
  date. See **Known gaps**.
- `deleteProcess` is not optional housekeeping: nothing server-side reaps a
  stale process row. See **Known gaps**.

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
| `verifyLicenseFileWithClaims(pem, ed25519PublicKey, licenseKey?, now?)` | The same, also returning the signed `iat`/`exp`/`jti`/`kid` |
| `verifyAndDecryptMachineFile(pem, scheme, publicKey, keyMaterial?, now?)` | Verify, decrypt and expiry-check a `.mach` file (multi-scheme) |
| `verifyMachineFileWithClaims(pem, scheme, publicKey, keyMaterial?, now?)` | The same, also returning the signed `iat`/`exp`/`jti`/`kid` |
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

`publicKey` is your account's public key for `scheme`: 32 raw bytes for Ed25519,
a 65-byte uncompressed P-256 point for ECDSA, or — for either RSA variant — the
RSA public key in DER. Both DER encodings are accepted: the PKCS#1
`RSAPublicKey` blob the API publishes, and SubjectPublicKeyInfo.

A machine file carries the same signed `meta.exp` a license file does, and it is
enforced here too, so pass a trusted timestamp as the fifth argument (`now`)
when the local clock cannot be trusted.

> **Compatibility warning — offline license *and machine* files must be format
> v2.** `alg` must end in `+v2` and the signed payload must carry its `meta`
> claims; a file issued under v1 is **rejected outright, with no fallback path**
> (`src/checkout/licenseFile.ts::verifyLicenseFileWithClaims`,
> `src/checkout/machineFile.ts::verifyMachineFileWithClaims`). This is a real
> behavioural break for any caller still holding a v1-issued file: re-run
> checkout to obtain a v2 file.

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
- **Both formats' expiry is inside the signature and is enforced for you.**
  `meta.exp` is checked with a 60-second clock-skew tolerance and an expired file
  throws `CheckoutError` of kind `"expired"`
  (`src/checkout/licenseFile.ts::verifyLicenseFileWithClaims`,
  `src/checkout/machineFile.ts::verifyMachineFileWithClaims` — one shared
  `CLOCK_SKEW_TOLERANCE_SECONDS`, so the two cannot drift apart). `exp` is
  absent when checkout was made without a `ttl`, which is a file that genuinely
  never expires, not an error. The tolerance is
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
- **Algorithm confusion is guarded three ways.** The scheme is chosen by the
  caller, never parsed from the file; the file's declared `alg` suffix must
  match what that scheme implies; and `RSA_2048_JWT_RS256` is rejected up front,
  before any parsing (`src/checkout/machineFile.ts::verifyMachineFileWithClaims`).
  The suffix cannot stand in for the scheme even in principle — the server emits
  the same `rsa-sha256` for `RSA_2048_PKCS1_SIGN` and `RSA_2048_JWT_RS256`.
- **Machine-file verification is tested against certificates the server
  produced**, not ones this SDK built: 12 fixtures in
  `test/fixtures/machine-file-v2/`, four signing schemes by three variants,
  driven off their manifest by `test/machine-file-server-fixtures.spec.ts` and
  re-run against the built output on Node, Deno and Bun by `scripts/smoke.mjs`.
  A self-generated fixture can only ever encode this SDK's belief about the wire
  format, and when that belief was wrong it hid the defects for two years.
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
  — instead of an opaque local abort. The deadline covers the **whole**
  attempt including the response-body read: `fetch` resolves as soon as
  headers arrive, so a deadline released at that point would leave a peer
  that stalls the body (a wedged proxy, a connection held open) able to hang
  the call indefinitely (`src/transport.ts::doFetch`).

Reporting a vulnerability: see [`SECURITY.md`](./SECURITY.md).

## Known gaps

Things this SDK deliberately does not do, or cannot do yet.

- **Key rotation is not handled.** Both formats' `meta.kid` identifies the
  signing key and is returned by `verifyLicenseFileWithClaims` /
  `verifyMachineFileWithClaims`, but nothing here selects a key by it — you
  still embed exactly one public key per scheme and a rotation invalidates
  files issued under the previous one.
- **The 429 retry budget is not configurable.** It is fixed at three attempts and
  is not plumbed through `TamgaClientConfig`.
- **`X-RateLimit-*` response headers are unavailable** — no server handler sets
  them, so `Retry-After` on a 429 is the only rate-limit signal to read.
- **`checkForUpgrade` answering `undefined` does not mean "you are up to
  date".** `GET /releases/actions/upgrade` returns `204 No Content` in two
  different situations and will not distinguish them: no release newer than
  the version you sent exists, *and* a newer release exists that this license
  is not entitled to (an expired license under a policy that stops delivering
  new builds at expiry). The collapse is deliberate — a distinct refusal would
  leak "there is a newer version and you cannot have it", which is exactly what
  the expiry gate withholds. Word it to users as *no update is available to
  you*, never as *you are on the latest version*: the second is a claim this
  endpoint cannot support, and it is wrong precisely for the customers whose
  licence lapsed. A **suspended** licence is the one case that is not
  collapsed — it answers `403`, which surfaces as `ForbiddenError`.

  Two more traps on this route. Leaving `constraint` unset does not mean "no
  constraint": the server substitutes a pessimistic `~{major}.{minor}.{patch}`
  built from the version you sent, so an updater on `1.2.0` will never be
  offered `1.3.0` and will look indistinguishable from a current client. Pass
  `"^1.2.0"` for minor upgrades. And `channel` is optional server-side but
  **required by this SDK**, because omitting it drops the channel predicate
  entirely and lets alpha and dev builds answer a production updater.

  Artifact download is still not modelled — the route exists but is walled off
  by a permission the license-key role does not hold.
- **A license key is not confined to its own license on the read routes.** The
  server's `require_license_scope` guard — which stops a license-key credential
  naming a different license — is called by `validate`, `validate-key` and
  `check-out`, but **not** by `GET /licenses/{id}` or
  `GET /licenses/{id}/policy`. The license-key role holds `license.read` by
  default, so a key can read any license in the account through `getLicense`,
  and `attributes.key` comes back in plaintext. Reported upstream; there is no
  client-side fix. Do not treat possession of a license key as evidence that
  its holder can only see that license.
- **`getPolicy` is unreachable with a license key.** `GET /policies/{id}`
  requires the `policy.read` permission, which the license-key role's default
  set does not include, so it answers `403` regardless of the policy's
  `authentication_strategy`. `getLicensePolicy` reaches the same resource
  through `GET /licenses/{id}/policy`, which needs only `license.read` — use
  that from an embedded client.
- **Nothing server-side reaps a stale process row.** The reaper exists
  (`find_and_claim_dead_processes` / `process_process_heartbeat`) but the job
  scheduler never dispatches it — its `dispatch` handles `cull_dead_machines`
  and has no process arm. A process that stops pinging is therefore not
  eventually cleaned up: the row persists indefinitely and keeps holding a seat
  against `policy.max_processes`, which only an explicit `deleteProcess`
  decrements. An application that registers a process per launch and never
  deletes one eventually gets `422 TOO_MANY_PROCESSES` on every start, with no
  client-side recovery beyond enumerating `listMachineProcesses` and deleting.
  Call `deleteProcess` on shutdown.
- **`policy.max_memory` and `policy.max_disk` are omitted from the `GET`
  response** even though both are enforced during validation, so `getPolicy` /
  `getLicensePolicy` cannot introspect those two limits — you only observe
  `TOO_MUCH_MEMORY` / `TOO_MUCH_DISK` on a failed validation.
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
- **`heartbeat_status: "DEAD"` never comes back from a ping, and does not
  mean the machine was culled where it does.** The rule is about what the
  request did to `last_heartbeat_at`, not about whether it wrote anything: a
  write that *sets* the column cannot report `DEAD`, because the status is then
  derived from the timestamp it just wrote. `pingHeartbeat` writes
  `last_heartbeat_at = NOW()`, so it answers `ALIVE` or `RESURRECTED`;
  `resetHeartbeat` nulls the column (`NOT_STARTED`); `createMachine` never sets
  it (`NOT_STARTED`); and validate never emits `HEARTBEAT_DEAD`.
  **`updateMachine` is the exception** — `PATCH /machines/{id}` leaves
  `last_heartbeat_at` untouched and still derives a status from it, and its
  `UPDATE … RETURNING` joins no policy, so it judges against the 600s fallback
  and can disagree with a read in either direction. Do not read heartbeat state
  off a patch response. Read-backed responses carry a real verdict, and
  this SDK has two: machine **checkout** resolves the machine through a
  lookup that joins the policy, so the `Machine` returned by
  `verifyAndDecryptMachineFile` carries a genuine staleness verdict that may
  be `DEAD`, and `generateOfflineProof`'s `machine` half is built the same
  way. `getMachine` and `listMachines` are a third and fourth: both resolve
  through the same policy-joining lookup, which is what makes `getMachine` the
  direct way to observe a machine's real staleness. So branch on `DEAD` from a
  read if it is useful — just never from a ping, where it cannot appear. Even from a file it does not mean the row
  was culled: the cull job runs exclusively for
  policies with `require_heartbeat = true`, which **defaults to `false`**, so
  under a default policy no row is ever culled and a machine stays `DEAD`
  indefinitely with its row and its seat intact — and a ping revives it
  regardless (bare `last_heartbeat_at = now`, no resurrection check). The
  practical rule: **a heartbeat scheduler must not stop on any status.** The
  one terminal signal is a `404 NOT_FOUND` (`NotFoundError`) from the ping,
  meaning the row is gone; hang re-activation off that. `startHeartbeat`
  swallows every ping failure, that 404 included, so a client that must react
  to deletion should drive `pingHeartbeat` on its own timer and catch
  `NotFoundError`.
- **The heartbeat window is policy-driven, and `startHeartbeat` does not adapt
  to it — but you can read it off a machine file.** The server uses
  `policy.heartbeat_duration` seconds when that column is set, and falls back to
  600s (10 min) only when it is null
  (`Policy::effective_heartbeat_duration_secs`; the cull job's claim query uses
  `COALESCE(p.heartbeat_duration, 600)`). `MACHINE_HEARTBEAT_WINDOW_MS` is that
  **600s fallback**, not a reading of your policy, so dividing it is only safe
  while `heartbeat_duration` is unset — under a policy that sets it lower, an
  interval sized against 600s leaves the machine outside its window between
  pings, which is what makes it cullable under `require_heartbeat`.

  To get the real value, subtract on a **read-backed** machine —
  `verifyAndDecryptMachineFile`'s return value, or `generateOfflineProof`'s
  `machine`, whose queries join the policy:

  ```ts
  const { last_heartbeat_at: last, next_heartbeat_at: next } = machine.attributes;
  const windowMs = last && next ? Date.parse(next) - Date.parse(last) : undefined;
  ```

  `heartbeatWindowMsFromMachine(machine)` does exactly this, so you need not
  re-derive it. ⚠️ It returns `number | undefined`, and `undefined` is the
  common case, not an edge one — it is what any machine that has not been
  pinged yet gives you, which includes every freshly activated one. So do
  **not** write `heartbeatWindowMsFromMachine(m)! / 3`: that is `NaN` exactly
  when a scheduler is starting up, and `NaN` is a delay `setInterval` turns
  into a 1 ms tick rather than refusing. Branch on the `undefined`.

  Three caveats: a `pingHeartbeat` response does **not** work for this (that
  query carries no policy join, so `next_heartbeat_at` comes back as
  `last_heartbeat_at + 600s` whatever the policy says); both fields are `null`
  until the machine has been pinged once; and the value is a snapshot from the
  file's issue time. `getMachine` is read-backed too and has neither the second
  nor the third problem beyond the moment you read it.

  When no machine is at hand, ask the policy:
  `resolveHeartbeatWindowMs(licenseId)` reads
  `GET /licenses/{id}/policy` and applies the same fallback the server does, and
  `startHeartbeatFromPolicy(machineId, licenseId)` does that and starts the
  timer at a third of the result. One extra request at startup, and the
  scheduler stops guessing 600s at a policy that asked for 60.

  Both of those report the window **verbatim**, including a `heartbeat_duration`
  of `0` or a negative one — the column carries no `CHECK` constraint and
  `effective_heartbeat_duration_secs` returns whatever it holds; only `NULL`
  takes the 600s fallback. That is deliberate: rounding a misconfigured policy
  up to something friendlier in the accessor would hide it. The guard lives in
  the scheduler instead. **`startHeartbeat` clamps `intervalMs` to
  `[1000, 2147483647]`** and truncates it to an integer; a non-finite value
  becomes `1000`. Worked through: `20000` stays `20000`, `500` becomes `1000`,
  `1` becomes `1000`, `0`/`-1`/`NaN` become `1000`, `2**31` becomes
  `2147483647`. Nothing throws. `startProcessHeartbeat` applies the same clamp;
  `startHeartbeatFromPolicy` inherits it.

  The floor is flat rather than a guard on just the values `setInterval`
  refuses to honour, and the reason is that the rewrite is not what does the
  damage — the rate is. `setInterval` honours `1` *exactly*, and `1` is the
  same ~740 pings a second as `0` (measured: `0` → 1.4 ms/tick, `1` → 1.35,
  `2` → 2.55, `3` → 3.75, `500` → 501). A rule clamping `0` but passing `1`
  would give two inputs with identical behaviour opposite treatment. The floor
  costs nothing a policy can ask for: `heartbeat_duration` is an
  integer-**seconds** column, so the shortest expressible window is 1s and a
  once-a-second ping is inside every policy that exists.

  ⚠️ **The server judges liveness on truncated whole seconds**, which is easy
  to get wrong in the pessimistic direction. `heartbeat_status_within` compares
  `(now - last_heartbeat_at).num_seconds() <= window_secs`, and chrono's
  `num_seconds()` truncates — so a machine reads `DEAD` only once its age
  reaches `window_secs + 1` seconds. Every window carries one free second on
  top of its nominal value. A 1s window is therefore served comfortably by a 1s
  ping (2s of slack, not zero), which is what makes the flat floor safe on short
  windows. What the floor *does* cost is the `MACHINE_HEARTBEAT_INTERVAL_DIVISOR`
  promise of two tolerable consecutive losses: `heartbeat_duration` of 3 is the
  first window where floor and divisor agree, 2 keeps one spare ping, 1 keeps
  none.

  ⚠️ **A non-positive `heartbeat_duration` is scheduled at the 600s default
  rate — 200s — rather than divided.** `0` and negatives are storable and are
  unsatisfiable at *any* ping rate: the cull job claims rows with
  `last_heartbeat_at < NOW() - make_interval(secs => COALESCE(p.heartbeat_duration, 600))`,
  and `COALESCE` replaces only `NULL`, so a stored `0` reduces that to
  `last_heartbeat_at < NOW()` — true for every machine that has ever pinged, at
  every instant. Note the cull job and `heartbeat_status` disagree here: the
  status comparison truncates, so a sub-second ping keeps a `0` window
  *reporting* `ALIVE` while the SQL comparison still claims the row. Survival
  follows the cull job. Since no rate helps, the only thing left to choose is
  what the futility costs — 18 requests an hour instead of the 3600 that
  dividing the raw `0` produced. This substitutes a **rate, not a window**:
  `resolveHeartbeatWindowMs` still reports `0` verbatim. Hand-composing the
  primitives yields the 1s floor instead, because `startHeartbeat` receives a
  bare number and cannot know where it came from. The interaction table is
  pinned in `test/policy-read.spec.ts`. The 30s **process** window is genuinely hardcoded
  server-side and needs no such care.
- **Eight of the 24 `ValidationCode` values are not reachable today.** They are
  modelled for forward-compatibility (`src/models/validation.ts`); do not write
  logic that depends on receiving one. `ENTITLEMENTS_MISSING` and
  `FINGERPRINT_SCOPE_MISMATCH` are **not** among them any more — the scope
  fields behind them are enforced now, so a scoped `validateById` really can
  come back with either.

## Documentation

- [`docs/examples/`](./docs/examples) — runnable end-to-end examples.
- <https://tamga.sh> — product and API documentation.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, commands, and the
  security-review requirement for crypto-touching changes.
- [`SECURITY.md`](./SECURITY.md) — vulnerability reporting and what counts as a
  security issue here.

## License

[MIT](./LICENSE) © Tamga
