# @tamga/sdk

[![CI](https://github.com/tamga-sh/tamga-js/actions/workflows/ci.yml/badge.svg)](https://github.com/tamga-sh/tamga-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40tamga%2Fsdk.svg)](https://www.npmjs.com/package/@tamga/sdk)
[![coverage](https://codecov.io/gh/tamga-sh/tamga-js/branch/main/graph/badge.svg)](https://codecov.io/gh/tamga-sh/tamga-js)

Official JavaScript/TypeScript SDK for Tamga. Integrate license activation,
offline verification, and machine management into Node.js, Deno, Bun, and
browser applications.

## Install

```bash
npm install @tamga/sdk
```

Also available via `pnpm add @tamga/sdk` or `yarn add @tamga/sdk`. Published
on the npm registry under the `@tamga` scope (the bare `tamga` name on npm
belongs to an unrelated, unmaintained package).

## Quickstart

```ts
import { TamgaClient } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: "your-account-id",
  baseUrl: "https://api.tamga.sh",
  auth: { kind: "license", key: "YOUR-LICENSE-KEY" },
});

const { license, meta } = await client.validateByKey("YOUR-LICENSE-KEY");
console.log(meta.valid, meta.code); // e.g. true "VALID"
```

More end-to-end examples (scoped validation, offline `.lic`/`.mach` file
verification, machine heartbeats, offline proof tokens, Deno/browser
quickstarts) live in [`docs/examples/`](./docs/examples).

## API reference

All methods live on `TamgaClient`. `licenseId`/`machineId`/`processId`/
`entitlementId` are the resource's UUID; every method sends whatever `auth`
transport was configured in `TamgaClientConfig`.

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

Offline verification (no network access, once the relevant public key is
embedded in your application) lives outside `TamgaClient`:

| Function | Purpose |
|---|---|
| `verifyAndDecryptLicenseFile(pem, ed25519PublicKey, licenseKey?)` | Verify + decrypt a `.lic` file |
| `verifyAndDecryptMachineFile(pem, scheme, publicKey, keyMaterial?)` | Verify + decrypt a `.mach` file (multi-scheme) |
| `verifyOfflineProof(proof, accountId, machineId, fingerprint, dataset, rsaPublicKey)` | Verify a `"v1x0."` offline proof token |

Errors are typed subclasses of `TamgaError` (e.g. `NotFoundError`,
`FingerprintTakenError`, `CheckInNotRequiredError`) — match on `.code`
(stable), never on `.message`/`detail` (human text that may change).

## Runtime support

Node.js ≥18, Deno, Bun, and browsers (ESM), from a single dual ESM/CJS
build — the only Tamga SDK that targets all four from one codebase. See
`.github/workflows/ci.yml` for the exact runtime matrix this repo tests
against (a dedicated `smoke` job runs the built output on Deno and Bun,
separate from the Node-only lint/typecheck/test job).

- **Node.js / Bun**: `npm install @tamga/sdk` as usual.
- **Deno**: import via an `npm:` specifier — see
  [`docs/examples/deno-quickstart.ts`](./docs/examples/deno-quickstart.ts).
- **Browser**: import the built ESM bundle directly in a
  `<script type="module">` — see
  [`docs/examples/browser-quickstart.html`](./docs/examples/browser-quickstart.html).
  A raw license key embedded client-side is inherently visible to the end
  user; that's expected for the `License` auth transport (the primary
  transport for embedded/client SDKs) — don't embed a Bearer/Basic account
  credential in browser-shipped code.

## Security notes

This SDK reimplements Tamga's offline license/machine file cryptography
from scratch (no dependency on the reference Rust implementation) — see
`src/checkout/*.ts`, `src/crypto/*.ts`, and `src/proof.ts`.

- **The `.lic`/`.mach` signature covers the base64 **string** bytes of the
  encrypted/plain payload (`enc`), not `enc`'s decoded bytes.** This is a
  deliberate, non-obvious server wire-format detail — see the module doc
  comment on `src/checkout/licenseFile.ts` and the regression test at
  `test/license-file-signing-gotcha.spec.ts`.
- **License-file decryption keys are NOT derived via a KDF.** `naiveKeyFromLicenseKey`
  (`src/crypto/naiveKey.ts`) zero-pads/truncates the raw license key string
  to 32 bytes — intentionally weak, kept only for wire-format compatibility.
  Machine-file decryption keys, by contrast, use a real HKDF-SHA256
  derivation (`src/crypto/hkdf.ts`).
- Every crypto-touching module here required a dedicated security review
  before merge — see `SECURITY.md`.

## Documentation

- [`docs/examples/`](./docs/examples) — runnable end-to-end examples.
- [`docs/sdk.md`](https://github.com/tamga-sh/tamga-api/blob/main/docs/sdk.md)
  — the Tamga SDK protocol reference this repo implements against, including
  the "Known Server-Side Gaps" section describing what this SDK deliberately
  does not implement (release/auto-update checking, RFC 9421 response
  signing, `Tamga-Environment`, client-side rate-limit backoff).
- `docs/plans/tamga-js.plan.md` (in the `tamga-sdk` monorepo) — this repo's
  implementation plan and task list.
- `CONTRIBUTING.md` — dev setup, commands, and the security-review
  requirement for crypto-touching changes.

## License

[MIT](./LICENSE) © Tamga
