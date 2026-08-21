/**
 * `TamgaClient` — the SDK's primary entrypoint.
 *
 * Ground-truthed against `tamga-rust`'s `src/client.rs` (the reference
 * implementation for this SDK family) and the Tamga API protocol
 * specification.
 *
 * Base path: `https://<host>/v1/accounts/{account_id}/...` — `accountId` is
 * required in both singleplayer and multiplayer server modes (Tamga API
 * protocol specification §1); there is no mode where it can be omitted.
 *
 * Auth **is** enforced server-side. Configure an `auth` transport — every
 * method below sends it.
 *
 * ⚠️ A license key is not automatically a valid credential. The server
 * accepts `Authorization: License <key>` only when the license's policy sets
 * `authentication_strategy` to `"LICENSE"` or `"MIXED"`, and that column
 * defaults to `"TOKEN"`. Against a default policy every call here returns
 * `401 LICENSE_NOT_ALLOWED` until the policy is changed — see
 * `src/models/policy.ts`'s `AuthenticationStrategy`.
 *
 * A license-key credential also cannot reach every endpoint it can name:
 * {@link TamgaClient.resetHeartbeat} and
 * {@link TamgaClient.generateOfflineProof} are role-gated and always answer
 * `403` for it.
 */

import {
  sendJsonApi,
  sendJsonApiWithMeta,
  sendFlat,
  sendRaw,
  type AuthCredentials,
  type TransportConfig,
} from "./transport.js";
import { TamgaApiErrorException } from "./errors.js";
import type { License, LicenseScope } from "./models/license.js";
import type { Entitlement } from "./models/license.js";
import type { LicenseValidationResult, ValidationCode, ValidationResult } from "./models/validation.js";
import type { Machine, Component, Process } from "./models/machine.js";
import { toPidString } from "./models/machine.js";
import type { LicenseFileResource } from "./checkout/licenseFile.js";
import { checkTtl, type MachineFileResource } from "./checkout/machineFile.js";

/** Configuration accepted by {@link TamgaClient}. */
export interface TamgaClientConfig {
  /** Required in both singleplayer and multiplayer server modes. */
  accountId: string;
  /**
   * API host, e.g. `https://api.tamga.sh` (scheme optional — `https://` is
   * assumed unless an explicit `http://` is given, to keep this usable
   * against a local plain-HTTP mock server without a separate test-only
   * code path). A trailing slash, if present, is stripped.
   */
  baseUrl: string;
  /** `Tamga-Version` header value. Server default is `"1.8"` if omitted. */
  apiVersion?: string;
  /**
   * Auth transport used to authenticate every request. Optional at the type
   * level only — auth is enforced server-side, so an unauthenticated client
   * gets `401` from every endpoint. `{ kind: "license", key }` is the
   * transport embedded/client applications want, subject to the policy's
   * `authentication_strategy` (see this module's doc comment).
   */
  auth?: AuthCredentials;
  /** `Tamga-OTP` header value (TOTP 2FA code), sent on every request when set. */
  otp?: string;
  /**
   * Per-attempt request deadline in milliseconds. Defaults to
   * {@link import("./transport.js").DEFAULT_TIMEOUT_MS} (45s). Pass `0` to
   * disable the deadline and wait indefinitely.
   */
  timeoutMs?: number;
}

/** Optional attributes for {@link TamgaClient.createMachine}/{@link TamgaClient.activateMachine}. */
export interface CreateMachineOptions {
  name?: string;
  ip?: string;
  hostname?: string;
  platform?: string;
  cores?: number;
  /**
   * Reported memory in **megabytes** — not bytes.
   *
   * ⚠️ The server sums this across the license's machines and checks it
   * against `policy.max_memory`. Reporting 16 GB as `17179869184` inflates
   * that tally by a factor of ~1e6 and gets the next activation on the same
   * license refused with `MEMORY_LIMIT_EXCEEDED`. 16 GB is `16384`.
   */
  memory?: number;
  /** Reported disk in **megabytes** — not bytes. Same caveat as {@link memory}. */
  disk?: number;
  metadata?: Record<string, unknown>;
}

/** Pagination options shared by the list endpoints. */
export interface ListOptions {
  /**
   * Page size, clamped to `[1, 100]` server-side. Omitted means
   * {@link MAX_PAGE_SIZE} — **not** the server's own default of 25, which
   * truncates silently because the response carries no total, no
   * `meta.page`, and no `links`.
   */
  limit?: number;
  /**
   * Keyset cursor: the `id` of the last item on the previous page.
   *
   * ⚠️ Honoured by `listComponents` only.
   * {@link TamgaClient.listEntitlements} ignores it — the server does too,
   * because that listing unions two tables and no single cursor describes
   * it. Kept on the shared type for signature compatibility.
   */
  after?: string;
}

/**
 * The server's maximum (and this SDK's default) page size for list
 * endpoints. Sent explicitly whenever the caller gives no `limit`, so the
 * page boundary is a known number rather than the server's silent 25.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Drops the scope fields the server rejects outright.
 *
 * `version`/`checksum` make the server answer `422 SCOPE_NOT_SUPPORTED`
 * before any validation runs, so forwarding them would convert a caller's
 * working validate into a total failure. Dropping them degrades to a
 * validate that simply doesn't apply those two constraints — which is what
 * the caller already believed was happening.
 */
function enforceableScope(scope: LicenseScope): LicenseScope {
  const { version: _version, checksum: _checksum, ...enforceable } = scope;
  return enforceable;
}

/**
 * Create-time `422` limit codes, mapped to the equivalent validate-time
 * {@link ValidationCode}.
 *
 * The server runs the same limit through two vocabularies: `POST /machines`
 * refuses with `MACHINE_LIMIT_EXCEEDED`, while `POST .../actions/validate`
 * reports the identical condition as `TOO_MANY_MACHINES`. Which one a caller
 * sees depends only on the policy's `overage_strategy`, so
 * {@link TamgaClient.activateMachine} normalizes onto the validate-time
 * vocabulary and callers only have to branch once.
 */
const CREATE_LIMIT_CODE_TO_VALIDATION_CODE: Readonly<Record<string, ValidationCode>> = {
  MACHINE_LIMIT_EXCEEDED: "TOO_MANY_MACHINES",
  CORE_LIMIT_EXCEEDED: "TOO_MANY_CORES",
  MEMORY_LIMIT_EXCEEDED: "TOO_MUCH_MEMORY",
  DISK_LIMIT_EXCEEDED: "TOO_MUCH_DISK",
};

/**
 * Returns the validate-time {@link ValidationCode} equivalent to `error`'s
 * create-time limit code, or `undefined` if `error` is anything else.
 */
function createLimitValidationCode(error: unknown): ValidationCode | undefined {
  if (!(error instanceof TamgaApiErrorException)) return undefined;
  return CREATE_LIMIT_CODE_TO_VALIDATION_CODE[error.code];
}

/** `ValidationCode`s that represent an over-limit outcome — see {@link TamgaClient.activateMachine}. */
const OVERAGE_CODES: ReadonlySet<ValidationCode> = new Set<ValidationCode>([
  "TOO_MANY_MACHINES",
  "TOO_MANY_CORES",
  "TOO_MUCH_MEMORY",
  "TOO_MUCH_DISK",
  "TOO_MANY_PROCESSES",
]);

/** `https://<host>/v1/accounts/{account_id}` — see {@link TamgaClientConfig.baseUrl}. */
function buildBaseUrl(host: string, accountId: string): string {
  const trimmed = host.replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) {
    return `http://${trimmed.slice("http://".length)}/v1/accounts/${accountId}`;
  }
  const withoutScheme = trimmed.startsWith("https://") ? trimmed.slice("https://".length) : trimmed;
  return `https://${withoutScheme}/v1/accounts/${accountId}`;
}

/** The Tamga API client — every endpoint method lives here (plan §2). */
export class TamgaClient {
  readonly config: TamgaClientConfig;
  private readonly transport: TransportConfig;

  constructor(config: TamgaClientConfig) {
    if (!config.accountId) {
      throw new Error("TamgaClientConfig.accountId is required");
    }
    if (!config.baseUrl) {
      throw new Error("TamgaClientConfig.baseUrl is required");
    }
    this.config = config;
    this.transport = {
      baseUrl: buildBaseUrl(config.baseUrl, config.accountId),
      ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
      ...(config.auth !== undefined ? { auth: config.auth } : {}),
      ...(config.otp !== undefined ? { otp: config.otp } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    };
  }

  // ---------------------------------------------------------------------
  // License validation
  // ---------------------------------------------------------------------

  /** `POST /licenses/actions/validate-key` — no scope support on this endpoint. */
  async validateByKey(key: string): Promise<ValidationResult> {
    const { data, meta } = await sendJsonApiWithMeta<License, LicenseValidationResult>(
      this.transport,
      { method: "POST", path: "/licenses/actions/validate-key", body: { key } },
    );
    return { license: data, meta };
  }

  /**
   * `POST /licenses/{license_id}/actions/validate` — scoped.
   *
   * Six scope fields are enforced server-side:
   * `product`/`policy`/`user`/`environment`, plus `entitlements` (matched on
   * entitlement **codes**, case-insensitively, across both direct and
   * policy-inherited rows) and `fingerprint` (matched against any machine on
   * the license). See {@link LicenseScope}.
   *
   * ⚠️ `scope.version` and `scope.checksum` are **stripped before sending**.
   * The server answers `422 SCOPE_NOT_SUPPORTED` to a scope carrying either
   * and never runs the validation at all, so passing them through would turn
   * a working validate into a hard failure. They are deprecated; stop
   * setting them.
   *
   * `skipTouch: true` suppresses the `last_validated_at` side effect.
   */
  async validateById(
    licenseId: string,
    opts: { scope?: LicenseScope; skipTouch?: boolean } = {},
  ): Promise<ValidationResult> {
    const meta: { scope?: LicenseScope; skip_touch: boolean } = {
      skip_touch: opts.skipTouch ?? false,
    };
    if (opts.scope !== undefined) meta.scope = enforceableScope(opts.scope);
    const { data, meta: validationMeta } = await sendJsonApiWithMeta<License, LicenseValidationResult>(
      this.transport,
      { method: "POST", path: `/licenses/${licenseId}/actions/validate`, body: { meta } },
    );
    return { license: data, meta: validationMeta };
  }

  /**
   * `GET /licenses/{license_id}/actions/validate` — quick-validate. Flat
   * `{ ts, valid, detail, code }` body, no `data` envelope — cheaper than
   * {@link validateById} when the caller only needs the outcome. No scope
   * support on this route.
   *
   * ⚠️ **This call does not always record the validation.** The server skips
   * the `last_validated_at` write whenever the request carries an `Origin`
   * header, and the response is byte-identical either way — there is no
   * signal to branch on.
   *
   * That matters most in a browser, this SDK's first-class runtime: the
   * browser attaches `Origin` to a cross-origin `fetch` itself and script
   * cannot suppress it, so quick-validate from a browser **never** records a
   * validation. A license whose `machines_count` is 0 and whose
   * `last_validated_at` is still null reads as `INACTIVE`, and the server's
   * check-in-overdue worker keeps firing `license.check-in-overdue` webhooks
   * off the same column. Check-in does not help — it writes
   * `last_check_in_at`, a different column.
   *
   * Outside a browser, a `{ kind: "cookie" }` auth transport sends `Origin`
   * too, and any proxy is free to add one.
   *
   * If the validation has to be recorded, call {@link validateById} — the
   * `POST` route has no `Origin` branch and writes unconditionally unless
   * `skipTouch: true` is passed.
   */
  async quickValidate(licenseId: string): Promise<LicenseValidationResult> {
    const { data } = await sendFlat<LicenseValidationResult>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/actions/validate`,
    });
    return data;
  }

  // ---------------------------------------------------------------------
  // License check-in
  // ---------------------------------------------------------------------

  /**
   * `POST /licenses/{license_id}/actions/check-in` — no body. Throws
   * {@link import("./errors.js").CheckInNotRequiredError} if the license's
   * policy has `require_check_in: false` — check that flag before
   * scheduling periodic check-ins, rather than reacting to this error with
   * retry logic.
   */
  async checkIn(licenseId: string): Promise<License> {
    const { data } = await sendJsonApi<License>(this.transport, {
      method: "POST",
      path: `/licenses/${licenseId}/actions/check-in`,
    });
    return data;
  }

  // ---------------------------------------------------------------------
  // License checkout
  // ---------------------------------------------------------------------

  /**
   * `GET /licenses/{license_id}/actions/check-out` — raw
   * `application/octet-stream` `.lic` file body. Pass the returned PEM
   * string to `verifyAndDecryptLicenseFile`. Non-idempotent — a fresh
   * UUIDv7 backs each call.
   */
  async checkOutLicense(
    licenseId: string,
    opts: { encrypt?: boolean; ttl?: number } = {},
  ): Promise<string> {
    const { data } = await sendRaw(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/actions/check-out`,
      query: { encrypt: opts.encrypt ?? false, ttl: opts.ttl },
    });
    return data;
  }

  /**
   * `POST /licenses/{license_id}/actions/check-out` — JSON:API variant,
   * returning a full {@link LicenseFileResource} instead of raw PEM bytes.
   * Throws a `LICENSE_NOT_ENCRYPTED` API error if `encrypt: true` is
   * requested for a license with no `key` set.
   */
  async checkOutLicenseJson(
    licenseId: string,
    opts: { encrypt?: boolean; ttl?: number } = {},
  ): Promise<LicenseFileResource> {
    const { data } = await sendJsonApi<LicenseFileResource>(this.transport, {
      method: "POST",
      path: `/licenses/${licenseId}/actions/check-out`,
      body: { meta: { encrypt: opts.encrypt ?? false, ttl: opts.ttl ?? null } },
    });
    return data;
  }

  // ---------------------------------------------------------------------
  // Machine checkout
  // ---------------------------------------------------------------------

  /**
   * `GET /machines/{machine_id}/actions/check-out` — raw
   * `application/octet-stream` `.mach` file body. If `ttl` is set, it's
   * pre-checked client-side via `checkTtl` before the round trip.
   */
  async checkOutMachine(
    machineId: string,
    opts: { encrypt?: boolean; ttl?: number } = {},
  ): Promise<string> {
    if (opts.ttl !== undefined) checkTtl(opts.ttl);
    const { data } = await sendRaw(this.transport, {
      method: "GET",
      path: `/machines/${machineId}/actions/check-out`,
      query: { encrypt: opts.encrypt ?? false, ttl: opts.ttl },
    });
    return data;
  }

  /**
   * `POST /machines/{machine_id}/actions/check-out` — JSON:API variant,
   * returning a full {@link MachineFileResource}. Throws `LICENSE_KEY_MISSING`
   * if `encrypt: true` is requested for a machine whose license has no
   * `key` set, or `SCHEME_NOT_SUPPORTED` if the license's scheme is
   * `RSA_2048_JWT_RS256`.
   */
  async checkOutMachineJson(
    machineId: string,
    opts: { encrypt?: boolean; ttl?: number } = {},
  ): Promise<MachineFileResource> {
    if (opts.ttl !== undefined) checkTtl(opts.ttl);
    const { data } = await sendJsonApi<MachineFileResource>(this.transport, {
      method: "POST",
      path: `/machines/${machineId}/actions/check-out`,
      body: { meta: { encrypt: opts.encrypt ?? false, ttl: opts.ttl ?? null } },
    });
    return data;
  }

  // ---------------------------------------------------------------------
  // Machine management
  // ---------------------------------------------------------------------

  /**
   * `POST /machines` — registers a machine against `licenseId`. Unique per
   * `(account_id, license_id, fingerprint)` — a duplicate fingerprint on
   * the same license throws {@link import("./errors.js").FingerprintTakenError}.
   *
   * ⚠️ **Creation does run the machine/core/memory/disk limit checks** —
   * they are not all deferred to validate. Whether they fire here depends on
   * the policy's `overage_strategy`, because the create-time check is routed
   * through it:
   *
   * - Under `NO_OVERAGE`, an over-limit create is refused with `422`
   *   `MACHINE_LIMIT_EXCEEDED` / `CORE_LIMIT_EXCEEDED` /
   *   `MEMORY_LIMIT_EXCEEDED` / `DISK_LIMIT_EXCEEDED`.
   * - Under `ALLOW_ACCESS` / `ALLOW_1_25X_OVERAGE` / … the create succeeds
   *   and the same condition surfaces later as a `TOO_MANY_*` / `TOO_MUCH_*`
   *   {@link ValidationCode}.
   *
   * The two paths use different vocabularies for the same limit;
   * {@link activateMachine} normalizes them onto the validate-time one.
   *
   * Note also that the fingerprint-uniqueness pre-check runs **before** the
   * limit checks, so re-registering an existing fingerprint reports
   * `FINGERPRINT_TAKEN` rather than a limit error.
   */
  async createMachine(
    licenseId: string,
    fingerprint: string,
    opts: CreateMachineOptions = {},
  ): Promise<Machine> {
    const { data } = await sendJsonApi<Machine>(this.transport, {
      method: "POST",
      path: "/machines",
      body: {
        data: {
          type: "machines",
          attributes: {
            fingerprint,
            name: opts.name ?? null,
            ip: opts.ip ?? null,
            hostname: opts.hostname ?? null,
            platform: opts.platform ?? null,
            cores: opts.cores ?? null,
            memory: opts.memory ?? null,
            disk: opts.disk ?? null,
            metadata: opts.metadata ?? {},
          },
          relationships: {
            license: { data: { type: "licenses", id: licenseId } },
          },
        },
      },
    });
    return data;
  }

  /**
   * `createMachine` + {@link validateById} composed into the recommended
   * "activate machine" flow.
   *
   * A license limit can stop an activation at either of two points, and
   * which one depends on the policy's `overage_strategy` (see
   * {@link createMachine}). Both are handled here and both come back as a
   * single `ValidationResult` shape, so callers branch on `meta.code` once:
   *
   * - **Refused at create time** (`NO_OVERAGE`). The `422`'s code is
   *   normalized onto the validate-time vocabulary —
   *   `MACHINE_LIMIT_EXCEEDED` → `TOO_MANY_MACHINES`, `CORE_LIMIT_EXCEEDED`
   *   → `TOO_MANY_CORES`, `MEMORY_LIMIT_EXCEEDED` → `TOO_MUCH_MEMORY`,
   *   `DISK_LIMIT_EXCEEDED` → `TOO_MUCH_DISK` — and returned with
   *   `valid: false` and the server's own `detail`. No machine was created,
   *   so nothing is rolled back and `autoDeleteOnOverage` does not apply.
   *   The license resource still comes from a real validate call, so
   *   `license.attributes` is current.
   * - **Reported at validate time** (any overage-permitting strategy). The
   *   machine exists and counts against the license. If
   *   `autoDeleteOnOverage` is `true` and the code is one of
   *   `TOO_MANY_MACHINES` / `TOO_MANY_CORES` / `TOO_MUCH_MEMORY` /
   *   `TOO_MUCH_DISK` / `TOO_MANY_PROCESSES`, the just-created machine is
   *   deleted before returning. The SDK does not auto-delete unless the
   *   caller opts in. Deletion failures are not surfaced (the validation
   *   result is what the caller asked for); a machine left behind after a
   *   failed auto-delete is still visible to normal machine-management calls
   *   for manual cleanup.
   *
   * Every other create-time failure — `FINGERPRINT_TAKEN`,
   * `LICENSE_NOT_ALLOWED`, a network error — is thrown, unchanged.
   */
  async activateMachine(
    licenseId: string,
    fingerprint: string,
    opts: CreateMachineOptions = {},
    scope?: LicenseScope,
    autoDeleteOnOverage = false,
  ): Promise<ValidationResult> {
    let machine: Machine | undefined;
    let createLimit: { code: ValidationCode; detail: string } | undefined;

    try {
      machine = await this.createMachine(licenseId, fingerprint, opts);
    } catch (error) {
      // Narrow here rather than trusting `createLimitValidationCode`'s
      // internal `instanceof` check: the compiler cannot see that invariant
      // through the helper's `unknown` parameter, and an `as` cast would
      // silently outlive any change to it.
      if (!(error instanceof TamgaApiErrorException)) throw error;
      const code = createLimitValidationCode(error);
      if (code === undefined) throw error;
      createLimit = { code, detail: error.apiError.detail };
    }

    const result = await this.validateById(licenseId, scope !== undefined ? { scope } : {});

    if (createLimit !== undefined) {
      // The create-time check is `count + 1 > max`, validate's is
      // `count > max` — so a license sitting exactly on its limit refuses the
      // create and then reports VALID. The create-time verdict is the one
      // that describes what just happened.
      return {
        license: result.license,
        meta: { ts: result.meta.ts, valid: false, detail: createLimit.detail, code: createLimit.code },
      };
    }

    if (autoDeleteOnOverage && machine !== undefined && OVERAGE_CODES.has(result.meta.code)) {
      await this.deleteMachine(machine.id).catch(() => undefined);
    }

    return result;
  }

  /** `POST /machines/{machine_id}/actions/ping-heartbeat` — no body, sets `last_heartbeat_at = now`. */
  async pingHeartbeat(machineId: string): Promise<Machine> {
    const { data } = await sendJsonApi<Machine>(this.transport, {
      method: "POST",
      path: `/machines/${machineId}/actions/ping-heartbeat`,
    });
    return data;
  }

  /**
   * `POST /machines/{machine_id}/actions/reset-heartbeat` — no body, rewinds
   * heartbeat state to `NOT_STARTED`.
   *
   * ⚠️ **Role-gated: always `403` for a license-key credential.** The server
   * restricts this to admin, developer, product-token and environment-token
   * roles; the license-key role is not among them, regardless of the
   * permissions attached to it. (Contrast {@link pingHeartbeat}, which is
   * permission-only and works for a license key.)
   *
   * This is the only server-side way to unstick a machine whose heartbeat
   * job is wedged — so a license-key client has no recovery path here and
   * should not offer one to its users.
   */
  async resetHeartbeat(machineId: string): Promise<Machine> {
    const { data } = await sendJsonApi<Machine>(this.transport, {
      method: "POST",
      path: `/machines/${machineId}/actions/reset-heartbeat`,
    });
    return data;
  }

  /** `DELETE /machines/{machine_id}`. */
  async deleteMachine(machineId: string): Promise<void> {
    await sendRaw(this.transport, { method: "DELETE", path: `/machines/${machineId}` });
  }

  /**
   * Starts a `pingHeartbeat` timer for `machineId`, pinging every
   * `intervalMs`. Pick an interval well inside the hardcoded 600s window
   * (e.g. a third of it) — see `src/models/machine.ts`'s
   * `MACHINE_HEARTBEAT_WINDOW_MS`. Returns a stop function.
   *
   * ⚠️ **Never stop this timer because `heartbeat_status` reads `"DEAD"`.**
   * `DEAD` means only that the last ping is older than the window — not that
   * the row was culled. Culling runs only under `require_heartbeat = true`,
   * which is **not** the default, so a machine can sit at `DEAD` indefinitely
   * with its row and its seat intact. A ping to a `DEAD` machine succeeds and
   * revives it, so this scheduler deliberately keeps pinging straight through
   * `DEAD` — see {@link import("./models/machine.js").HeartbeatStatus}.
   *
   * Ping failures are swallowed (the timer keeps running) so a single
   * transient network blip doesn't kill the scheduler. That includes the
   * `404 NOT_FOUND` ({@link import("./errors.js").NotFoundError}) that is the
   * only real "the row is gone" signal, so this helper cannot surface it:
   * callers that need to re-activate on deletion should drive
   * {@link pingHeartbeat} on their own timer and catch `NotFoundError`.
   */
  startHeartbeat(machineId: string, intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.pingHeartbeat(machineId).catch(() => undefined);
    }, intervalMs);
    return () => clearInterval(timer);
  }

  // ---------------------------------------------------------------------
  // Machine offline proof
  // ---------------------------------------------------------------------

  /**
   * `POST /machines/{machine_id}/actions/generate-offline-proof` —
   * `dataset` defaults to `{}` (must be a JSON object; a non-object fails
   * server-side with `422 DATASET_INVALID`). Pass the returned `proof`,
   * plus the exact `accountId`/`machineId`/`fingerprint`/`dataset` tuple
   * used here, to `verifyOfflineProof` to verify it fully offline.
   *
   * ⚠️ **Role-gated: always `403` for a license-key credential**, same as
   * {@link resetHeartbeat} — the license-key role is not on the allowed list
   * even though it carries the `machine.proofs.generate` permission. Proofs
   * have to be minted by a backend holding an account-level token and then
   * handed to the client; `verifyOfflineProof` (which needs no credential at
   * all) is the half an embedded client can run.
   */
  async generateOfflineProof(
    machineId: string,
    dataset: Record<string, unknown> = {},
  ): Promise<{ machine: Machine; proof: string }> {
    const { data, meta } = await sendJsonApiWithMeta<Machine, { proof: string }>(this.transport, {
      method: "POST",
      path: `/machines/${machineId}/actions/generate-offline-proof`,
      body: { meta: { dataset } },
    });
    return { machine: data, proof: meta.proof };
  }

  // ---------------------------------------------------------------------
  // Components & processes
  // ---------------------------------------------------------------------

  /**
   * `POST /components` — registers a component against `machineId`. **Not**
   * JSON:API-enveloped on the request side (unlike `createMachine`) — the
   * server expects a flat `{ machine_id, fingerprint, name, metadata }`
   * body; this is a real asymmetry in the Tamga API, not an SDK oversight.
   * Unique per `(account_id, machine_id, fingerprint)`.
   */
  async createComponent(
    machineId: string,
    fingerprint: string,
    name: string,
    metadata: Record<string, unknown> = {},
  ): Promise<Component> {
    const { data } = await sendJsonApi<Component>(this.transport, {
      method: "POST",
      path: "/components",
      body: { machine_id: machineId, fingerprint, name, metadata },
    });
    return data;
  }

  /**
   * `GET /machines/{machine_id}/components` — genuinely keyset-paginated
   * (`limit`, `page[after]`), unlike {@link listEntitlements}.
   *
   * `limit` is clamped to 100 server-side and defaults to **25** when
   * omitted. The response carries no `meta.page` and no `links`, so a short
   * page is the only end-of-list signal — which means the page size has to be
   * known. This SDK sends 100 when no explicit `limit` is given; pass
   * `after` with the last item's `id` to walk further.
   */
  async listComponents(machineId: string, opts: ListOptions = {}): Promise<Component[]> {
    const { data } = await sendJsonApi<Component[]>(this.transport, {
      method: "GET",
      path: `/machines/${machineId}/components`,
      query: { limit: opts.limit ?? MAX_PAGE_SIZE, "page[after]": opts.after },
    });
    return data;
  }

  /**
   * `POST /processes` — registers a process against `machineId`. Same flat
   * (non-JSON:API) request body shape as {@link createComponent}. Unique
   * PID per machine. Unlike a machine (which starts `NOT_STARTED`), a
   * process starts `ALIVE` immediately.
   *
   * Spawning is limit-checked: a license already at `policy.max_processes`
   * gets `422 TOO_MANY_PROCESSES` (see
   * {@link import("./errors.js").TooManyProcessesError}).
   */
  async createProcess(
    machineId: string,
    pid: string | number,
    metadata: Record<string, unknown> = {},
  ): Promise<Process> {
    const { data } = await sendJsonApi<Process>(this.transport, {
      method: "POST",
      path: "/processes",
      body: { machine_id: machineId, pid: toPidString(pid), metadata },
    });
    return data;
  }

  /**
   * `POST /processes/{process_id}/actions/ping` — no body. ⚠️ The process
   * heartbeat window is a **hardcoded 30 seconds** with no resurrection
   * grace period — see `src/models/machine.ts`'s `PROCESS_HEARTBEAT_WINDOW_MS`.
   */
  async pingProcess(processId: string): Promise<Process> {
    const { data } = await sendJsonApi<Process>(this.transport, {
      method: "POST",
      path: `/processes/${processId}/actions/ping`,
    });
    return data;
  }

  /**
   * Starts a `pingProcess` timer for `processId`, defaulting to a safe 10s
   * interval — comfortably inside the hardcoded 30s process heartbeat
   * window. Returns a stop function; ping failures are swallowed (the
   * timer keeps running), same rationale as {@link startHeartbeat}.
   */
  startProcessHeartbeat(processId: string, intervalMs = 10_000): () => void {
    const timer = setInterval(() => {
      this.pingProcess(processId).catch(() => undefined);
    }, intervalMs);
    return () => clearInterval(timer);
  }

  // ---------------------------------------------------------------------
  // Entitlements
  // ---------------------------------------------------------------------

  /**
   * `GET /licenses/{license_id}/entitlements` — returns full
   * {@link Entitlement} resources despite the junction-shaped URL, unioning
   * the license's direct attachments with the ones inherited from its
   * policy. Check {@link EntitlementAttributes.inherited} to tell them apart.
   *
   * ⚠️ **This route is not paginable.** The response is a union across two
   * tables, so a single keyset cursor cannot describe it and the server
   * ignores `page[after]` outright — sending it would silently re-fetch page
   * one forever. {@link ListOptions.after} is accepted here for signature
   * compatibility and deliberately **not** sent.
   *
   * `limit` is the only bound, clamped to 100 server-side and defaulting to
   * **25** when omitted — which is a silent truncation, since the response
   * carries no `meta.page`, no `links`, and no total. This SDK sends 100 (the
   * server maximum) when no explicit `limit` is given, so the ceiling is
   * knowable. A license with more than 100 effective entitlements cannot be
   * fully enumerated through this endpoint at all.
   */
  async listEntitlements(licenseId: string, opts: ListOptions = {}): Promise<Entitlement[]> {
    const { data } = await sendJsonApi<Entitlement[]>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/entitlements`,
      query: { limit: opts.limit ?? MAX_PAGE_SIZE },
    });
    return data;
  }

  /**
   * `GET /licenses/{license_id}/entitlements/{entitlement_id}`.
   *
   * ⚠️ Resolves **direct** attachments only. An entitlement the license
   * inherits from its policy is returned by {@link listEntitlements} but
   * answers `404` here, so list-then-get-each is not a valid pattern on this
   * resource. Read the fields off the list response instead, or check
   * {@link EntitlementAttributes.inherited} before calling this.
   */
  async getEntitlement(licenseId: string, entitlementId: string): Promise<Entitlement> {
    const { data } = await sendJsonApi<Entitlement>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/entitlements/${entitlementId}`,
    });
    return data;
  }

  /**
   * Fetches this license's entitlements (up to `limit`, default 100 — the
   * server's own maximum) and checks whether any has the given `code`.
   * Matches on `code` (the stable, developer-facing identifier) — **never**
   * on `name` (just a display label). Inherited entitlements count: the
   * listing this reads is the union of direct and policy-inherited rows.
   *
   * ⚠️ A `false` result is only authoritative below that 100-row ceiling.
   * The endpoint cannot be paginated (see {@link listEntitlements}), so on a
   * license with more than 100 effective entitlements this can answer
   * `false` for a code the license actually holds. Do not gate a paid
   * feature on a `false` from an unbounded catalogue.
   */
  async hasEntitlement(licenseId: string, code: string, limit = 100): Promise<boolean> {
    const entitlements = await this.listEntitlements(licenseId, { limit });
    return entitlements.some((e) => e.attributes.code === code);
  }
}
