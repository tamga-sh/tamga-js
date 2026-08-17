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
 * No auth is currently enforced server-side on the license validate/
 * check-in endpoints, but this client sends whatever `auth` transport is
 * configured on every request anyway, for forward-compatibility — see
 * `src/transport.ts`.
 */

import {
  sendJsonApi,
  sendJsonApiWithMeta,
  sendFlat,
  sendRaw,
  type AuthCredentials,
  type TransportConfig,
} from "./transport.js";
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
   * Auth transport used to authenticate every request. Optional — but the
   * Tamga API protocol specification recommends every caller configure
   * `{ kind: "license", key }` for forward-compatibility with auth
   * enforcement landing server-side later.
   */
  auth?: AuthCredentials;
  /** `Tamga-OTP` header value (TOTP 2FA code), sent on every request when set. */
  otp?: string;
}

/** Optional attributes for {@link TamgaClient.createMachine}/{@link TamgaClient.activateMachine}. */
export interface CreateMachineOptions {
  name?: string;
  ip?: string;
  hostname?: string;
  platform?: string;
  cores?: number;
  memory?: number;
  disk?: number;
  metadata?: Record<string, unknown>;
}

/** Pagination options shared by every keyset-paginated list endpoint. */
export interface ListOptions {
  limit?: number;
  after?: string;
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
   * `POST /licenses/{license_id}/actions/validate` — scoped. Only
   * `product`/`policy`/`user`/`environment` on `scope` are enforced
   * server-side today (Tamga API protocol specification §2).
   * `skipTouch: true` suppresses the `last_validated_at` side effect.
   */
  async validateById(
    licenseId: string,
    opts: { scope?: LicenseScope; skipTouch?: boolean } = {},
  ): Promise<ValidationResult> {
    const meta: { scope?: LicenseScope; skip_touch: boolean } = {
      skip_touch: opts.skipTouch ?? false,
    };
    if (opts.scope !== undefined) meta.scope = opts.scope;
    const { data, meta: validationMeta } = await sendJsonApiWithMeta<License, LicenseValidationResult>(
      this.transport,
      { method: "POST", path: `/licenses/${licenseId}/actions/validate`, body: { meta } },
    );
    return { license: data, meta: validationMeta };
  }

  /**
   * `GET /licenses/{license_id}/actions/validate` — quick-validate. Flat
   * `{ ts, valid, detail, code }` body, no `data` envelope — cheaper than
   * {@link validateById} when the caller only needs the outcome.
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
   * **No machine/core/etc. limit is checked at creation time** — those
   * limits only surface later via {@link validateById}. See
   * {@link activateMachine} for the recommended create→validate flow.
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
   * "activate machine" flow — creation alone doesn't enforce limits (see
   * {@link createMachine}'s doc comment).
   *
   * If validation fails with an over-limit {@link ValidationCode}
   * (`TOO_MANY_MACHINES`, `TOO_MANY_CORES`, `TOO_MUCH_MEMORY`,
   * `TOO_MUCH_DISK`, `TOO_MANY_PROCESSES`) and `autoDeleteOnOverage` is
   * `true`, the just-created machine is deleted before returning — SDK does
   * not auto-delete unless the caller opts in. Deletion failures are not
   * surfaced (the validation result is what the caller asked for); a
   * machine left behind after a failed auto-delete is still visible to
   * normal machine-management calls for manual cleanup.
   */
  async activateMachine(
    licenseId: string,
    fingerprint: string,
    opts: CreateMachineOptions = {},
    scope?: LicenseScope,
    autoDeleteOnOverage = false,
  ): Promise<ValidationResult> {
    const machine = await this.createMachine(licenseId, fingerprint, opts);
    const result = await this.validateById(licenseId, scope !== undefined ? { scope } : {});

    if (autoDeleteOnOverage && OVERAGE_CODES.has(result.meta.code)) {
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

  /** `POST /machines/{machine_id}/actions/reset-heartbeat` — no body, rewinds heartbeat state to `NOT_STARTED`. */
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
   * `MACHINE_HEARTBEAT_WINDOW_MS`. Treat a resulting `heartbeat_status` of
   * `"DEAD"` as "machine likely deleted server-side — re-activate rather
   * than retry ping." Returns a stop function; ping failures are swallowed
   * (the timer keeps running) so a single transient network blip doesn't
   * kill the scheduler — callers wanting failure visibility should poll
   * `pingHeartbeat` directly instead.
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

  /** `GET /machines/{machine_id}/components` — keyset-paginated (`limit`, `page[after]`). */
  async listComponents(machineId: string, opts: ListOptions = {}): Promise<Component[]> {
    const { data } = await sendJsonApi<Component[]>(this.transport, {
      method: "GET",
      path: `/machines/${machineId}/components`,
      query: { limit: opts.limit, "page[after]": opts.after },
    });
    return data;
  }

  /**
   * `POST /processes` — registers a process against `machineId`. Same flat
   * (non-JSON:API) request body shape as {@link createComponent}. Unique
   * PID per machine. Unlike a machine (which starts `NOT_STARTED`), a
   * process starts `ALIVE` immediately.
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
   * `GET /licenses/{license_id}/entitlements` — keyset-paginated. Despite
   * the URL nesting, returns full {@link Entitlement} resources, not
   * lightweight junction records. No auth/permission check beyond the
   * license existing.
   */
  async listEntitlements(licenseId: string, opts: ListOptions = {}): Promise<Entitlement[]> {
    const { data } = await sendJsonApi<Entitlement[]>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/entitlements`,
      query: { limit: opts.limit, "page[after]": opts.after },
    });
    return data;
  }

  /** `GET /licenses/{license_id}/entitlements/{entitlement_id}`. */
  async getEntitlement(licenseId: string, entitlementId: string): Promise<Entitlement> {
    const { data } = await sendJsonApi<Entitlement>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/entitlements/${entitlementId}`,
    });
    return data;
  }

  /**
   * Fetches this license's entitlements (a single page, up to `limit`,
   * default 100 — the server's own max page size) and checks whether any
   * has the given `code`. Matches on `code` (the stable, developer-facing
   * identifier) — **never** on `name` (just a display label). For licenses
   * with more entitlements than fit on one page, paginate via
   * {@link listEntitlements} directly instead.
   */
  async hasEntitlement(licenseId: string, code: string, limit = 100): Promise<boolean> {
    const entitlements = await this.listEntitlements(licenseId, { limit });
    return entitlements.some((e) => e.attributes.code === code);
  }
}
