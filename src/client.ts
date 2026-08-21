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
  sendJsonApiOptional,
  sendJsonApiWithMeta,
  sendFlat,
  sendRaw,
  type AuthCredentials,
  type TransportConfig,
} from "./transport.js";
import { FingerprintTakenError, TamgaApiErrorException } from "./errors.js";
import type { License, LicenseScope } from "./models/license.js";
import type { Entitlement } from "./models/license.js";
import type { LicenseValidationResult, ValidationCode, ValidationResult } from "./models/validation.js";
import type { Machine, Component, Process } from "./models/machine.js";
import {
  MACHINE_HEARTBEAT_INTERVAL_DIVISOR,
  MACHINE_HEARTBEAT_WINDOW_MS,
  toPidString,
} from "./models/machine.js";
import type { Policy } from "./models/policy.js";
import { effectiveHeartbeatWindowMs } from "./models/policy.js";
import type { OffsetPage, OffsetPageMeta } from "./models/page.js";
import { readOffsetPageMeta } from "./models/page.js";
import type { Release } from "./models/release.js";
import type { HealthStatus } from "./models/health.js";
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
   *
   * Bounds the whole attempt — connect, headers **and** the response body
   * read — so a peer that returns headers promptly and then stalls the body
   * still hits the deadline.
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
 * Sortable columns on `GET /machines`, exactly the four the server allowlists
 * (`tamga-api/src/features/machines/queries.rs`, `LIST_SORT`). Anything else is
 * rejected with `400 INVALID_SORT` rather than silently ignored — a deliberate
 * server choice, so a typo fails loudly instead of looking like broken sorting.
 */
export type MachineSortField = "created_at" | "updated_at" | "name" | "last_heartbeat_at";

/** Sort direction for {@link ListMachinesOptions.order}. The server's default is `"desc"`. */
export type SortOrder = "asc" | "desc";

/**
 * Options for {@link TamgaClient.listMachines} — **offset** pagination, not the
 * keyset cursor {@link ListOptions} carries.
 *
 * `GET /machines` is a top-level collection and goes through the server's
 * shared `list_query` module: `page[number]` + `page[size]`, with a real
 * {@link OffsetPageMeta} in `meta.page`. Sending `page[after]` here does
 * nothing at all.
 */
export interface ListMachinesOptions {
  /**
   * 1-based page number. Defaults to `1`. The server floors anything below 1.
   *
   * ⚠️ Bounded: `(page - 1) * size` may not exceed 100 000 rows, or the call
   * fails with `400 PAGE_OUT_OF_RANGE`. Filter instead of paging that deep.
   */
  page?: number;
  /**
   * Page size, clamped to `[1, 100]` server-side. Defaults to
   * {@link MAX_PAGE_SIZE} — **not** the server's own default of 25, which is a
   * silent truncation on any endpoint whose caller does not read `meta.page`.
   */
  size?: number;
  /**
   * `filter[license]` — restrict to machines on these licenses.
   *
   * This is the only way to learn which license a machine belongs to: the
   * `machines` resource does **not** serialize `license_id`, so a machine that
   * arrives without this filter carries no evidence of its owner.
   */
  licenseId?: string | string[];
  /** `filter[owner]` — restrict to machines owned by these users. */
  ownerId?: string | string[];
  /** `filter[group]` — restrict to machines in these groups. */
  groupId?: string | string[];
  /** `filter[platform]` — exact match against the reported `platform` string. */
  platform?: string | string[];
  /**
   * `filter[q]` — free-text search, matched as a **case-insensitive substring**
   * (`ILIKE '%term%'`) across `name`, `hostname` and `fingerprint`.
   *
   * ⚠️ Not an equality filter. A term that is a substring of another machine's
   * fingerprint matches that machine too, and the server truncates the term at
   * 200 characters. Re-check the field you meant client-side — which is what
   * {@link TamgaClient.findMachineByFingerprint} does.
   */
  search?: string;
  /** Sort column. Defaults to `"created_at"`. */
  sort?: MachineSortField;
  /** Sort direction. Defaults to `"desc"`. */
  order?: SortOrder;
}

/**
 * Attributes {@link TamgaClient.updateMachine} can change.
 *
 * ⚠️ **Omission means "leave unchanged", and there is no way to clear a field
 * back to `null`.** The server's `UPDATE` is
 * `name = COALESCE($3, name), ip = COALESCE($4, ip), …`, so a `null` and an
 * omitted field are indistinguishable and both are no-ops. This type therefore
 * has no nullable members: a caller who wants a field gone has to delete and
 * re-create the machine.
 *
 * `fingerprint` is absent on purpose — it is the machine's identity and the
 * handler does not accept it.
 */
export interface UpdateMachineOptions {
  name?: string;
  ip?: string;
  hostname?: string;
  platform?: string;
  cores?: number;
  /** Megabytes, not bytes — same caveat as {@link CreateMachineOptions.memory}. */
  memory?: number;
  /** Megabytes, not bytes — same caveat as {@link CreateMachineOptions.memory}. */
  disk?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Query for {@link TamgaClient.checkForUpgrade}. The first four fields are
 * **required** by the server; a request missing any of them is rejected with
 * `400 INVALID_FILTER` before the upgrade check runs.
 */
export interface UpgradeCheckOptions {
  /**
   * The product to check, as its **UUID** — not its code or slug. Required;
   * an unknown id answers `404`.
   */
  productId: string;
  /**
   * Target platform. Required, and matched **exactly** against the artifact's
   * stored `platform` text (`a.platform = $3`) — there is no normalization, so
   * whatever the artifacts were uploaded with is what has to be sent here.
   */
  platform: string;
  /** Artifact filetype, matched exactly the same way. Required. */
  filetype: string;
  /**
   * The version currently installed — what "newer" is measured against.
   * Required, and it must parse as **semver**: anything else is refused with
   * `422 INVALID_VERSION` before any lookup runs.
   */
  version: string;
  /**
   * Release channel to consider, e.g. `"stable"`.
   *
   * **Required here even though the server allows it to be omitted**, and
   * deliberately so: omitting it drops the channel predicate entirely
   * (`$5::text IS NULL OR r.channel = $5`), which means the check considers
   * *every* channel — alpha, beta, dev included — and can hand a production
   * auto-updater a pre-release build. There is no "current channel" default
   * server-side to fall back on. Callers that really do want to span channels
   * should ask for each one explicitly, so the choice is visible in the code
   * making it.
   */
  channel: string;
  /**
   * Semver requirement the candidate release must satisfy, e.g. `"^1.2"`.
   *
   * ⚠️ **Omitting this is not "no constraint".** The server substitutes a
   * pessimistic `~{major}.{minor}.{patch}` built from `version`, which admits
   * **patch upgrades only**. An updater on `1.2.0` that leaves this unset will
   * never be offered `1.3.0` — it will be told there is nothing available, and
   * be indistinguishable from a genuinely current client. Pass `"^1.2.0"` for
   * minor upgrades, `"*"` for anything newer.
   *
   * Must parse as a semver requirement, or the call fails with
   * `422 INVALID_CONSTRAINT`.
   */
  constraint?: string;
}

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

/**
 * `{scheme}://{host}` — the configured origin, with no path.
 *
 * Split out of {@link buildBaseUrl} because one route this SDK calls is not
 * account-scoped: `GET /v1/health` sits outside `/v1/accounts/{account_id}`
 * and cannot be reached by a builder that appends the account segment
 * unconditionally.
 */
function buildOrigin(host: string): string {
  const trimmed = host.replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) {
    return `http://${trimmed.slice("http://".length)}`;
  }
  const withoutScheme = trimmed.startsWith("https://") ? trimmed.slice("https://".length) : trimmed;
  return `https://${withoutScheme}`;
}

/** `https://<host>/v1/accounts/{account_id}` — see {@link TamgaClientConfig.baseUrl}. */
function buildBaseUrl(host: string, accountId: string): string {
  return `${buildOrigin(host)}/v1/accounts/${accountId}`;
}

/** Joins a filter value (or list of them) into the server's comma-separated form. */
function csvFilter(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.length === 0 ? undefined : values.join(",");
}

/**
 * The shortest interval either heartbeat scheduler will actually run at, in
 * milliseconds — see {@link clampHeartbeatIntervalMs}.
 */
const MIN_HEARTBEAT_INTERVAL_MS = 1000;

/**
 * The longest one: `setInterval`'s delay is a signed 32-bit value, and an
 * interval above it is *not* rounded down — Node clamps it to 1 ms (with a
 * `TimeoutOverflowWarning`) and browsers wrap it, so an over-large interval
 * busy-loops exactly like a zero one.
 */
const MAX_HEARTBEAT_INTERVAL_MS = 2_147_483_647;

/**
 * Confines a caller-supplied ping interval to a range that cannot turn a
 * heartbeat timer into a busy loop.
 *
 * `setInterval` does not honour a degenerate delay, it *shortens* it: `0`,
 * a negative number, `NaN`, `Infinity` and anything above
 * {@link MAX_HEARTBEAT_INTERVAL_MS} all become a 1 ms tick. So an unguarded
 * `intervalMs` of `0` does not mean "ping as fast as asked" — it means
 * roughly a thousand `ping-heartbeat` requests a second, from every machine
 * running that code, indefinitely, each one individually valid and correctly
 * authenticated. Nothing about it looks like a failure from either end.
 *
 * Non-finite values fall back to the floor rather than the ceiling: there is
 * no "never ping" semantics here, and the floor is the safe reading.
 *
 * A sub-second heartbeat is never a real request — the server's window is an
 * integer-seconds column — so the floor cannot cost a legitimate caller
 * anything.
 */
function clampHeartbeatIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return MIN_HEARTBEAT_INTERVAL_MS;
  return Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(intervalMs)),
  );
}

/** The Tamga API client — every endpoint method lives here (plan §2). */
export class TamgaClient {
  readonly config: TamgaClientConfig;
  private readonly transport: TransportConfig;
  /**
   * Same credentials and headers, rooted at the bare origin instead of
   * `/v1/accounts/{account_id}` — used only by {@link health}.
   */
  private readonly originTransport: TransportConfig;
  /**
   * Stop functions for every timer this client started, so {@link dispose} can
   * clear them without the caller having tracked each one.
   */
  private readonly timers = new Set<() => void>();

  constructor(config: TamgaClientConfig) {
    if (!config.accountId) {
      throw new Error("TamgaClientConfig.accountId is required");
    }
    if (!config.baseUrl) {
      throw new Error("TamgaClientConfig.baseUrl is required");
    }
    this.config = config;
    const shared = {
      ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
      ...(config.auth !== undefined ? { auth: config.auth } : {}),
      ...(config.otp !== undefined ? { otp: config.otp } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    };
    this.transport = { baseUrl: buildBaseUrl(config.baseUrl, config.accountId), ...shared };
    this.originTransport = { baseUrl: buildOrigin(config.baseUrl), ...shared };
  }

  /**
   * Registers a timer's stop function so {@link dispose} can reach it, and
   * returns a wrapper that both stops the timer and deregisters it.
   */
  private trackTimer(stop: () => void): () => void {
    this.timers.add(stop);
    return () => {
      this.timers.delete(stop);
      stop();
    };
  }

  /**
   * Stops every heartbeat timer this client started —
   * {@link startHeartbeat}, {@link startProcessHeartbeat} and
   * {@link startHeartbeatFromPolicy} — and forgets them. Idempotent, and safe
   * to call alongside the individual stop functions those methods return.
   *
   * A `setInterval` keeps a Node process alive, so a client whose timers are
   * never cleared holds the process open after the work is done. This is the
   * one call a teardown path needs.
   *
   * ⚠️ **It stops timers; it does not release server-side rows.** In
   * particular a process registered with {@link createProcess} outlives this
   * call: nothing on the server reaps a stale process row — the reaper exists
   * (`find_and_claim_dead_processes`) but the scheduler never dispatches it, so
   * the row and the `max_processes` seat it holds persist indefinitely. A clean
   * shutdown is {@link deleteProcess} for each process, then `dispose()`.
   */
  dispose(): void {
    const stops = [...this.timers];
    this.timers.clear();
    for (const stop of stops) stop();
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
  // License and policy reads
  // ---------------------------------------------------------------------

  /**
   * `GET /licenses/{license_id}` — the license resource, unvalidated.
   *
   * Cheaper than {@link validateById} when the caller wants the current
   * attributes (`expiry`, `status`, `machines_count`, `max_machines`, …) rather
   * than a verdict, and it writes nothing: no `last_validated_at` touch, no
   * use increment. It is **not** a substitute for validation — `status` is the
   * license's own state, not the scoped, policy-aware outcome
   * {@link import("./models/validation.js").ValidationCode} carries.
   *
   * ⚠️ **Under license-key auth this route is not confined to your own
   * license.** `validate`, `validate-key` and `check-out` all call the server's
   * `require_license_scope` guard, which rejects a license-key credential
   * naming a different license; this route and
   * {@link getLicensePolicy} do not. A license-key credential with
   * `license.read` — the default for that role — can therefore read **any**
   * license in the account, and `attributes.key` is returned in plaintext.
   * Reported upstream; the SDK cannot fix it. Do not treat a license key as a
   * credential that confines its holder to one license.
   */
  async getLicense(licenseId: string): Promise<License> {
    const { data } = await sendJsonApi<License>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}`,
    });
    return data;
  }

  /**
   * `GET /licenses/{license_id}/policy` — the policy governing this license.
   *
   * **This is the policy read an embedded client can actually make.** It is
   * gated on `license.read`, which the license-key role holds by default,
   * whereas {@link getPolicy} is gated on `policy.read`, which it does not. If
   * the client is authenticating with `{ kind: "license", key }`, use this one.
   *
   * It answers the questions a licensing client has to ask about itself:
   * `heartbeat_duration` (the real machine heartbeat window — see
   * {@link resolveHeartbeatWindowMs}), `require_heartbeat` (whether missing it
   * can ever cull the machine), `require_check_in` and `check_in_interval`
   * (whether {@link checkIn} is even expected), `overage_strategy` (which of
   * the two limit vocabularies {@link activateMachine} will hit), and `scheme`
   * (which signature to verify a checked-out file against).
   *
   * ⚠️ Shares {@link getLicense}'s missing `require_license_scope` check — a
   * license key can read any license's policy in the account.
   */
  async getLicensePolicy(licenseId: string): Promise<Policy> {
    const { data } = await sendJsonApi<Policy>(this.transport, {
      method: "GET",
      path: `/licenses/${licenseId}/policy`,
    });
    return data;
  }

  /**
   * `GET /policies/{policy_id}` — a policy by its own id.
   *
   * ⚠️ **Not reachable with a license key.** This route requires the
   * `policy.read` permission, and the license-key role's default permission set
   * does not include it — the call answers `403`
   * ({@link import("./errors.js").ForbiddenError}) regardless of the policy's
   * `authentication_strategy`. An embedded client wanting policy fields should
   * call {@link getLicensePolicy}, which needs only `license.read`; this method
   * is for backends holding an account-level token.
   *
   * ⚠️ `max_memory` and `max_disk` are **absent** from the response even though
   * both are enforced during validation — see
   * {@link import("./models/policy.js").PolicyAttributes}.
   */
  async getPolicy(policyId: string): Promise<Policy> {
    const { data } = await sendJsonApi<Policy>(this.transport, {
      method: "GET",
      path: `/policies/${policyId}`,
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
   * Every other create-time failure — `LICENSE_NOT_ALLOWED`, a network error —
   * is thrown, unchanged.
   *
   * ## Re-activating an already-activated fingerprint
   *
   * `FINGERPRINT_TAKEN` is the exception, and only when `reuseExistingMachine`
   * is `true`. The server treats re-registering a known fingerprint as a `409`
   * conflict on purpose — its own comment calls it "already activated, carry
   * on" — but a `409` alone gives a client no way to *carry on*, because the
   * response does not name the machine that already holds the fingerprint. So
   * an application restarting on a machine it activated last week had no path
   * back to its own machine id short of storing it locally and hoping the file
   * survived.
   *
   * With `reuseExistingMachine: true` the conflict is resolved instead of
   * thrown: the existing machine is looked up with
   * {@link findMachineByFingerprint}, validation proceeds as normal, and the
   * machine comes back on
   * {@link import("./models/validation.js").ValidationResult.machine}. The call
   * becomes idempotent — running it twice yields the same machine and the same
   * verdict, and burns no second seat.
   *
   * ⚠️ It stays off by default because it costs an extra request on the
   * conflict path and, more importantly, because "reuse" is a decision about
   * seat accounting that belongs to the caller.
   *
   * ⚠️ The lookup is confined to `licenseId`, and a miss re-throws the original
   * `FingerprintTakenError` rather than widening. The conflict's scope is the
   * policy's `machine_uniqueness_strategy`, which defaults to per-license but
   * can be `UNIQUE_PER_POLICY` or `UNIQUE_PER_ACCOUNT` — under those, the
   * machine holding the fingerprint may sit on a **different** license, and
   * this license really has not been activated. Since the `machines` resource
   * does not serialize `license_id`, a machine found outside the filter could
   * not be shown to belong here anyway.
   *
   * ## The machine on the result
   *
   * {@link import("./models/validation.js").ValidationResult.machine} carries
   * the machine this activation resolved to — freshly created, or recovered
   * through the path above. It is absent when the create was refused by a
   * create-time limit (nothing exists), and when `autoDeleteOnOverage` rolled
   * the new machine back (it no longer exists). A **reused** machine is never
   * rolled back: `autoDeleteOnOverage` only ever deletes a machine this call
   * created.
   */
  async activateMachine(
    licenseId: string,
    fingerprint: string,
    opts: CreateMachineOptions = {},
    scope?: LicenseScope,
    autoDeleteOnOverage = false,
    reuseExistingMachine = false,
  ): Promise<ValidationResult> {
    let machine: Machine | undefined;
    // Tracked separately from `machine`: a machine recovered through the
    // idempotent path was not created by this call, and must never be rolled
    // back by it. Deleting someone else's already-activated machine because
    // *this* validate came back over-limit would destroy working state.
    let createdMachine: Machine | undefined;
    let createLimit: { code: ValidationCode; detail: string } | undefined;

    try {
      createdMachine = await this.createMachine(licenseId, fingerprint, opts);
      machine = createdMachine;
    } catch (error) {
      // Narrow here rather than trusting `createLimitValidationCode`'s
      // internal `instanceof` check: the compiler cannot see that invariant
      // through the helper's `unknown` parameter, and an `as` cast would
      // silently outlive any change to it.
      if (!(error instanceof TamgaApiErrorException)) throw error;
      if (reuseExistingMachine && error instanceof FingerprintTakenError) {
        machine = await this.findMachineByFingerprint(licenseId, fingerprint);
        // Not on this license. The conflict came from a wider uniqueness
        // scope (`UNIQUE_PER_POLICY`/`UNIQUE_PER_ACCOUNT`), so the machine
        // holding the fingerprint belongs to some *other* license and this
        // activation genuinely did not happen. Re-throw rather than hand back
        // a machine the caller's license does not own.
        if (machine === undefined) throw error;
      } else {
        const code = createLimitValidationCode(error);
        if (code === undefined) throw error;
        createLimit = { code, detail: error.apiError.detail };
      }
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

    if (autoDeleteOnOverage && createdMachine !== undefined && OVERAGE_CODES.has(result.meta.code)) {
      await this.deleteMachine(createdMachine.id).catch(() => undefined);
      // The machine is gone (or the delete failed and it is unreachable
      // bookkeeping either way) — reporting it back would name a row the
      // caller should not act on.
      return result;
    }

    return machine !== undefined ? { ...result, machine } : result;
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
   * `GET /machines/{machine_id}` — the machine as the server currently sees it.
   *
   * This is a **read**, and that is what makes it different from every other
   * machine-returning call this SDK has had. The query joins the machine's
   * policy (`queries::find_by_id`), so two fields carry information a write
   * response cannot:
   *
   * - `heartbeat_status` may be `"DEAD"`. A ping/reset/create response derives
   *   the status from the timestamp it just wrote and so can only ever answer
   *   `ALIVE`/`RESURRECTED`/`NOT_STARTED`. Here nothing reset the clock, so the
   *   verdict is genuine. It still does **not** mean the row was culled — see
   *   {@link import("./models/machine.js").HeartbeatStatus}.
   * - `next_heartbeat_at` is computed against the policy's real
   *   `heartbeat_duration`, not the 600 s fallback, so
   *   {@link import("./models/machine.js").heartbeatWindowMsFromMachine} works
   *   on it — returning `undefined`, not a number, until the machine has been
   *   pinged once, so check for that rather than asserting it away with `!`.
   *
   * ⚠️ The `machines` resource does not serialize `license_id`, so a machine
   * fetched by id carries no evidence of which license owns it. Use
   * {@link listMachines} with `licenseId` when that matters — and note that
   * this is not merely an inconvenience: no machine route applies the server's
   * `require_license_scope` guard, and `machine.read`/`machine.update`/
   * `machine.delete` are all in the license-key role's default permission set,
   * so a license key can read, patch and delete **any** machine in the
   * account. Reported upstream; do not treat a machine id as license-confined.
   */
  async getMachine(machineId: string): Promise<Machine> {
    const { data } = await sendJsonApi<Machine>(this.transport, {
      method: "GET",
      path: `/machines/${machineId}`,
    });
    return data;
  }

  /**
   * `GET /machines` — the account's machines, filtered and **offset**-paginated.
   *
   * ⚠️ **Offset, not keyset.** This is the one list in this SDK that is not the
   * `limit` + `page[after]` shape {@link ListOptions} describes: it is a
   * top-level collection and goes through the server's shared `list_query`
   * module, so it takes `page[number]` + `page[size]` and answers with a real
   * `meta.page` — {@link OffsetPageMeta} — carrying `total` and `totalPages`.
   * `page[after]` is not read at all on this route. See
   * {@link ListMachinesOptions}.
   *
   * Every machine returned is **read**-backed, with the same two consequences
   * {@link getMachine} documents: `heartbeat_status` can genuinely be `"DEAD"`,
   * and `next_heartbeat_at` reflects the policy rather than the fallback.
   *
   * Filters are `AND`-ed; a filter given several values matches any of them.
   * The server caps a filter at 50 values of 200 characters each, and splits
   * each value on commas — so a filter value that itself contains a comma is
   * read as two values.
   */
  async listMachines(opts: ListMachinesOptions = {}): Promise<OffsetPage<Machine>> {
    const page = opts.page ?? 1;
    const size = opts.size ?? MAX_PAGE_SIZE;
    const { data, meta } = await sendJsonApiWithMeta<Machine[], { page?: OffsetPageMeta }>(
      this.transport,
      {
        method: "GET",
        path: "/machines",
        query: {
          "page[number]": page,
          "page[size]": size,
          "filter[license]": csvFilter(opts.licenseId),
          "filter[owner]": csvFilter(opts.ownerId),
          "filter[group]": csvFilter(opts.groupId),
          "filter[platform]": csvFilter(opts.platform),
          "filter[q]": opts.search,
          sort: opts.sort,
          order: opts.order,
        },
      },
    );
    const items = data ?? [];
    return { items, page: readOffsetPageMeta(meta, items.length, page, size) };
  }

  /**
   * Finds the machine on `licenseId` whose fingerprint is exactly
   * `fingerprint`, or `undefined` if the license has none.
   *
   * There is no `filter[fingerprint]` on `GET /machines`; the only fingerprint
   * lookup the server offers is the free-text `filter[q]`, which is a
   * case-insensitive **substring** match spanning `name`, `hostname` and
   * `fingerprint`. So this searches, then re-checks
   * `attributes.fingerprint === fingerprint` exactly — a substring hit on some
   * other machine's fingerprint must not be mistaken for this one.
   *
   * The `licenseId` argument is required rather than optional on purpose, and
   * the search is deliberately **not** widened to the account. The `machines`
   * resource omits `license_id`, so a machine found without that filter cannot
   * be shown to belong to the license the caller asked about — and under
   * `machine_uniqueness_strategy: UNIQUE_PER_ACCOUNT` the row holding a
   * fingerprint may belong to a completely different license. Handing that one
   * back would be worse than returning nothing: the caller would heartbeat and
   * check out a machine its license does not own, while its own
   * `machines_count` stayed at zero. Preventing exactly that sharing is what
   * the wider uniqueness scopes are *for*, so an account-wide search here would
   * defeat the feature it is reacting to. Note the scopes still overlap: a
   * genuine re-activation on this license is found under all three strategies,
   * because each of their `EXISTS` checks includes this license's own rows.
   *
   * Walks up to `maxPages` pages of {@link MAX_PAGE_SIZE} rows (default 10, so
   * 1000 rows) and stops early at the last page the server reports.
   */
  async findMachineByFingerprint(
    licenseId: string,
    fingerprint: string,
    opts: { maxPages?: number } = {},
  ): Promise<Machine | undefined> {
    const maxPages = opts.maxPages !== undefined && opts.maxPages > 0 ? opts.maxPages : 10;
    for (let page = 1; page <= maxPages; page++) {
      const result = await this.listMachines({
        licenseId,
        search: fingerprint,
        page,
        size: MAX_PAGE_SIZE,
      });
      const match = result.items.find((m) => m.attributes.fingerprint === fingerprint);
      if (match !== undefined) return match;
      if (page >= result.page.totalPages) return undefined;
    }
    return undefined;
  }

  /**
   * `PATCH /machines/{machine_id}` — updates the mutable machine attributes.
   *
   * ⚠️ **Every field is "leave unchanged" when omitted, and there is no way to
   * clear one.** The server's statement is `name = COALESCE($3, name), …`, so
   * an omitted field and an explicit `null` are the same no-op. Only the keys
   * present on `attrs` are sent; see {@link UpdateMachineOptions}.
   *
   * `cores`/`memory`/`disk` are not free-form: the license carries running
   * totals of all three that `max_cores`/`max_memory`/`max_disk` are enforced
   * against, and this call adjusts them by the delta. Revising a machine's
   * reported resources therefore moves the license's usage — reporting memory
   * in bytes here inflates the license's tally exactly as it would at creation.
   *
   * ⚠️ **Do not read heartbeat state off this response.** It is the one write
   * on this resource that can report `"DEAD"`, and the one whose verdict can be
   * wrong in both directions. `ping-heartbeat` cannot say `DEAD` because it
   * sets `last_heartbeat_at = NOW()` and then judges against that same
   * timestamp; `reset-heartbeat` nulls the column and `POST /machines` never
   * sets it, so both answer `NOT_STARTED`. `PATCH` touches none of them — it
   * leaves whatever was there and still derives a status from it. And its
   * `UPDATE … RETURNING` carries no policy join, so that derivation uses the
   * 600 s **fallback** rather than the policy's `heartbeat_duration`. Under a
   * 3600 s policy a machine last seen 700 s ago reads `DEAD` here and `ALIVE`
   * from {@link getMachine}; under a 60 s policy the disagreement runs the
   * other way. `next_heartbeat_at` is off by the same amount. Re-read with
   * {@link getMachine} when either field matters.
   *
   * ⚠️ **Not confined to the caller's own license.** The `machine.update`
   * permission is in the license-key role's default set and no machine route
   * applies the server's `require_license_scope` guard, so a license key can
   * patch any machine in the account, not only its own. Reported upstream;
   * there is no client-side fix. The same is true of {@link deleteMachine} and
   * {@link getMachine}.
   */
  async updateMachine(machineId: string, attrs: UpdateMachineOptions): Promise<Machine> {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined) attributes[key] = value;
    }
    const { data } = await sendJsonApi<Machine>(this.transport, {
      method: "PATCH",
      path: `/machines/${machineId}`,
      body: { data: { type: "machines", attributes } },
    });
    return data;
  }

  /**
   * Starts a `pingHeartbeat` timer for `machineId`, pinging every
   * `intervalMs`. Pick an interval well inside the heartbeat window (e.g. a
   * third of it). Returns a stop function.
   *
   * ⚠️ **You have to size `intervalMs` yourself, and 600s is only a
   * fallback.** The server's window is `policy.heartbeat_duration` seconds
   * when that column is set, and 600s (10 min) only when it is null. This
   * scheduler does not adapt on its own — `MACHINE_HEARTBEAT_WINDOW_MS` is
   * the 600s fallback, safe to divide only while `heartbeat_duration` is
   * unset. Under a policy with a shorter duration an interval picked against
   * 600s is too slow: the machine falls outside its window between pings,
   * which is what makes it cullable under a `require_heartbeat` policy.
   *
   * You are not without a source for the real value, though. A read-backed
   * machine — one from `verifyAndDecryptMachineFile` or the `machine` half of
   * {@link generateOfflineProof} — carries the effective window as
   * `next_heartbeat_at - last_heartbeat_at`; see
   * {@link import("./models/machine.js").MachineAttributes.next_heartbeat_at}
   * for the recipe and its caveats (read-backed only, needs one prior ping,
   * snapshot from issue time). Size `intervalMs` off that — a third of it is
   * a good default — and fall back to learning the window out of band, from
   * whoever configures the policy, only when no machine file is available.
   *
   * ⚠️ **This timer must never stop on a `heartbeat_status` value**, and it
   * does not — the interval callback discards the response entirely. Two
   * independent reasons that is the right design. First, a ping cannot even
   * report `"DEAD"`: it writes `last_heartbeat_at = NOW()` and then derives
   * the status from that same timestamp, so it answers `ALIVE` or
   * `RESURRECTED`. (`DEAD` is real and does reach this SDK — but through a
   * read-backed response, i.e. a checked-out machine file or the `machine`
   * half of {@link generateOfflineProof} — never through this route.)
   * Second, `DEAD` would not be a stop condition anyway: it does not mean
   * the row was culled, and the ping revives the machine regardless. See
   * {@link import("./models/machine.js").HeartbeatStatus}.
   *
   * Ping failures are swallowed (the timer keeps running) so a single
   * transient network blip doesn't kill the scheduler. That includes the
   * `404 NOT_FOUND` ({@link import("./errors.js").NotFoundError}) that is the
   * only real "the row is gone" signal, so this helper cannot surface it:
   * callers that need to re-activate on deletion should drive
   * {@link pingHeartbeat} on their own timer and catch `NotFoundError`.
   *
   * ⚠️ **The interval contract, exactly.** `intervalMs` is clamped to
   * `[1000, 2147483647]` and truncated to an integer; a non-finite value
   * (`NaN`, `±Infinity`) becomes `1000`. Concretely: `20000` stays `20000`,
   * `500` becomes `1000`, `1` becomes `1000`, `0` and `-1` become `1000`,
   * `NaN` becomes `1000`, and `2**31` becomes `2147483647`. This is a floor,
   * not a rejection — nothing throws, and the returned stop function behaves
   * the same either way.
   *
   * **Why a flat 1 s floor, and not merely a guard on the values
   * `setInterval` refuses to honour.** That narrower rule is tempting, because
   * `0`, a negative, `NaN`, `Infinity` and anything past the 32-bit ceiling
   * are exactly the values the runtime silently rewrites to a 1 ms tick. But
   * the rewrite is not what does the damage, the resulting rate is — and the
   * runtime honours `1` *exactly*, which is the same ~740 `ping-heartbeat`
   * requests a second as `0` (measured: `0` → 1.4 ms/tick, `1` → 1.35, `2` →
   * 2.55, `3` → 3.75). A rule that clamps `0` and passes `1` through would
   * treat two inputs with identical observable behaviour differently, so it
   * describes where a number came from rather than what it does. Only a floor
   * bounds the rate.
   *
   * **What the floor costs.** Nothing a policy can ask for.
   * `heartbeat_duration` is an integer-**seconds** column, so the shortest
   * window the server can express is 1 s and a once-a-second ping is inside
   * every policy that exists. A caller who passed `500` was buying two pings
   * per second against a window measured in seconds; at `1000` they still ping
   * at least once per window under the tightest policy expressible. The
   * clamped range is `1..999` and past 24.8 days, and no configuration needs
   * either. What it buys is that the SDK cannot be made to flood the licensing
   * server — not a crash, but a silent spin of individually valid, correctly
   * authenticated pings from every machine running that code, which is the
   * failure mode nothing on either end reports.
   *
   * The guard lives in this primitive, not in the callers that compute an
   * interval, so it holds however the timer is reached —
   * {@link startHeartbeatFromPolicy} inherits it rather than repeating it, and
   * {@link startProcessHeartbeat} applies the same one.
   *
   * ⚠️ **Two documented compositions can hand this method a degenerate
   * interval**, which is why the floor is here rather than at the call sites.
   * {@link resolveHeartbeatWindowMs} reports the window *verbatim*, including
   * the `0` or negative `heartbeat_duration` the column permits (it carries no
   * `CHECK` constraint), so `startHeartbeat(id, windowMs / 3)` over such a
   * policy is handed `0`. And {@link
   * import("./models/machine.js").heartbeatWindowMsFromMachine} returns
   * `number | undefined`, so the same shape written as
   * `heartbeatWindowMsFromMachine(m)! / 3` — with the non-null assertion the
   * type forces on you — yields `NaN` on a machine that has never been pinged.
   * Prefer an explicit `undefined` check over `!` there; either way this
   * method no longer spins on the result.
   */
  startHeartbeat(machineId: string, intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.pingHeartbeat(machineId).catch(() => undefined);
    }, clampHeartbeatIntervalMs(intervalMs));
    return this.trackTimer(() => clearInterval(timer));
  }

  /**
   * {@link startHeartbeat}, with the interval read off the policy instead of
   * guessed — the answer to "600s is only a fallback, so what is *my* window?".
   *
   * Fetches `GET /licenses/{license_id}/policy`, takes
   * {@link import("./models/policy.js").effectiveHeartbeatWindowMs} (the
   * policy's `heartbeat_duration`, or the 600 s fallback when it is unset), and
   * divides by `divisor` — {@link MACHINE_HEARTBEAT_INTERVAL_DIVISOR}, 3, by
   * default, so two consecutive pings can be lost without the machine falling
   * outside its window.
   *
   * Costs one extra request at startup, once, and removes the failure mode
   * where a policy asking for a 60 s window is served by a scheduler pinging
   * every 200 s — a machine that is outside its window between every pair of
   * pings, and cullable under a `require_heartbeat` policy, with nothing in a
   * ping response to reveal it.
   *
   * Prefer `startHeartbeat(id, windowMs / 3)` with
   * {@link import("./models/machine.js").heartbeatWindowMsFromMachine} when a
   * read-backed machine is already in hand — a checked-out machine file carries
   * the same number for free. Reach for this when one is not. ⚠️ That helper
   * returns `number | undefined`, so write the `undefined` case out rather
   * than reaching for `!`: `heartbeatWindowMsFromMachine(m)! / 3` is `NaN` on a
   * machine that has never been pinged, and `NaN` is a value `setInterval`
   * turns into a 1 ms tick. {@link startHeartbeat} floors it, so the mistake
   * costs a wrong interval rather than a flood — but it is still the wrong
   * interval.
   *
   * ⚠️ Reads the policy through the **license**, not `GET /policies/{id}`. The
   * two are not equivalent under license-key auth: the license route needs only
   * `license.read`, which a license key has, while the policy route needs
   * `policy.read`, which it does not — see {@link getPolicy}.
   *
   * The returned stop function and {@link dispose} both clear the timer.
   * Non-positive `divisor` values fall back to the default, and the resulting
   * interval is floored at 1 s by {@link startHeartbeat} so a pathologically
   * short policy window — `heartbeat_duration` is allowed to be `0` or
   * negative — cannot turn into a busy loop.
   *
   * ⚠️ **What that floor costs on a short window.** The server judges liveness
   * on *truncated whole seconds*: `heartbeat_status_within` compares
   * `(now - last_heartbeat_at).num_seconds() <= window_secs`, and
   * `num_seconds()` truncates, so a machine reads `DEAD` only once its age
   * reaches `window_secs + 1` seconds. Every window therefore carries one free
   * second, and a 1 s window is comfortably served by a 1 s ping — 2 s of
   * slack, not zero. What the floor does cost is the
   * {@link import("./models/machine.js").MACHINE_HEARTBEAT_INTERVAL_DIVISOR}
   * promise of two tolerable consecutive losses: `heartbeat_duration` of 3 is
   * the first where floor and divisor agree, 2 keeps one spare ping, and 1
   * keeps none. Steady state holds the window in all three.
   *
   * ⚠️ **A non-positive window is scheduled against the 600 s platform default
   * instead of being divided.** `heartbeat_duration` of `0` or less is
   * unsatisfiable: the cull job claims rows with
   * `last_heartbeat_at < NOW() - make_interval(secs => COALESCE(p.heartbeat_duration, 600))`
   * (`workers/machine_jobs.rs:214`), and `COALESCE` replaces only `NULL`, so a
   * stored `0` makes that `last_heartbeat_at < NOW()` — true for every machine
   * that has ever pinged, at every instant, **at any ping rate**. No interval
   * saves the row.
   *
   * Note this is decided by the *cull* query, not by `heartbeat_status`. The
   * two disagree here: the status comparison truncates
   * (`num_seconds() <= window_secs`), so a sub-second ping keeps a `0` window
   * reporting `ALIVE` while the SQL comparison — exact timestamps, no
   * truncation — still claims the row. Survival follows the cull job.
   *
   * Since no rate helps, the only thing a rate can change is what the futility
   * costs. Deriving from the raw `0` gave a 1 s interval, i.e. 3600 requests an
   * hour per machine, forever, buying nothing — the same self-inflicted flood
   * the floor exists to prevent, reached from the other side. The platform
   * default gives 200 s (18 an hour), matches the rest of the SDK fleet, and
   * lands on the correct cadence for free if the policy is later fixed to
   * `NULL` or 600.
   *
   * This substitutes a *rate*, not a *window*.
   * {@link resolveHeartbeatWindowMs} and
   * {@link import("./models/policy.js").effectiveHeartbeatWindowMs} still
   * report `0` verbatim — the SDK does not claim a zero window means 600 s,
   * only that it cannot schedule against one. Hand-composing the primitives
   * still yields the 1 s floor instead, because {@link startHeartbeat} gets a
   * bare number with no provenance and cannot tell a misconfigured window from
   * a caller who meant `0`. Both are pinned in `test/policy-read.spec.ts`.
   */
  async startHeartbeatFromPolicy(
    machineId: string,
    licenseId: string,
    opts: { divisor?: number } = {},
  ): Promise<() => void> {
    const windowMs = await this.resolveHeartbeatWindowMs(licenseId);
    const divisor =
      opts.divisor !== undefined && opts.divisor > 0
        ? opts.divisor
        : MACHINE_HEARTBEAT_INTERVAL_DIVISOR;
    // A non-positive window is unsatisfiable at any ping rate (see the doc
    // comment), so schedule against the platform default instead of dividing a
    // number no interval can honour. This is a choice of *rate*, not a claim
    // that the window is 600s — `resolveHeartbeatWindowMs` still reports it
    // verbatim.
    const schedulableWindowMs =
      Number.isFinite(windowMs) && windowMs > 0 ? windowMs : MACHINE_HEARTBEAT_WINDOW_MS;
    return this.startHeartbeat(machineId, schedulableWindowMs / divisor);
  }

  /**
   * The machine heartbeat window this license's policy imposes, in
   * milliseconds — `policy.heartbeat_duration * 1000`, or the 600 s fallback
   * when the column is unset.
   *
   * This is the **window**, not a ping interval; divide it before scheduling.
   * {@link startHeartbeatFromPolicy} does both in one call.
   *
   * The number is whatever the server will judge the machine on, *including*
   * a non-positive one: `heartbeat_duration` carries no `CHECK` constraint,
   * so a policy may store `0`, and this reports it rather than substituting a
   * friendlier value that would hide the misconfiguration — see {@link
   * import("./models/policy.js").effectiveHeartbeatWindowMs}. Feeding it
   * straight to {@link startHeartbeat} is safe regardless: that method floors
   * its interval.
   */
  async resolveHeartbeatWindowMs(licenseId: string): Promise<number> {
    return effectiveHeartbeatWindowMs(await this.getLicensePolicy(licenseId));
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
   *
   * `intervalMs` is confined to the same `[1s, 2147483647ms]` range as
   * {@link startHeartbeat}, for the same reason: this is the identical
   * `setInterval` primitive, so an explicit `0` (or a `NaN` out of some
   * caller-side arithmetic) would spin `ping` at event-loop speed rather
   * than pinging as fast as asked. The default is untouched by the clamp.
   */
  startProcessHeartbeat(processId: string, intervalMs = 10_000): () => void {
    const timer = setInterval(() => {
      this.pingProcess(processId).catch(() => undefined);
    }, clampHeartbeatIntervalMs(intervalMs));
    return this.trackTimer(() => clearInterval(timer));
  }

  /**
   * `DELETE /processes/{process_id}` — 204, no content.
   *
   * ⚠️ **Nothing on the server deletes a process row for you.** The reaper that
   * would (`machine_jobs::find_and_claim_dead_processes` /
   * `process_process_heartbeat`) is written, tested and never dispatched: the
   * job scheduler's `dispatch` handles `cull_dead_machines` and has no
   * process arm. So a process that stops pinging is not "eventually cleaned
   * up" — its row stays forever, and it keeps holding a seat against
   * `policy.max_processes`, because that counter is only decremented by this
   * call (`adjust_license_process_count(-1)`). A long-running application that
   * registers a process per launch and never deletes one eventually gets
   * `422 TOO_MANY_PROCESSES` on every start with no way to recover from the
   * client side.
   *
   * Call this on shutdown, paired with {@link createProcess}. Deleting an
   * already-deleted process answers `404`
   * ({@link import("./errors.js").NotFoundError}), which a teardown path can
   * safely ignore.
   */
  async deleteProcess(processId: string): Promise<void> {
    await sendRaw(this.transport, { method: "DELETE", path: `/processes/${processId}` });
  }

  /**
   * `GET /machines/{machine_id}/processes` — the processes registered against
   * one machine.
   *
   * Genuinely **keyset**-paginated (`limit`, `page[after]`), like
   * {@link listComponents} and unlike {@link listMachines}. `limit` is clamped
   * to 100 server-side and defaults to 25 when omitted; the response carries no
   * `meta.page` and no `links`, so a short page is the only end-of-list signal
   * and this SDK sends 100 when the caller gives no `limit`.
   *
   * Pairs with {@link deleteProcess} for recovering from leaked process rows:
   * nothing server-side reaps them, so enumerating and deleting here is the
   * only way to free `max_processes` seats a previous run left behind.
   */
  async listMachineProcesses(machineId: string, opts: ListOptions = {}): Promise<Process[]> {
    const { data } = await sendJsonApi<Process[]>(this.transport, {
      method: "GET",
      path: `/machines/${machineId}/processes`,
      query: { limit: opts.limit ?? MAX_PAGE_SIZE, "page[after]": opts.after },
    });
    return data;
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

  // ---------------------------------------------------------------------
  // Auto-update & health
  // ---------------------------------------------------------------------

  /**
   * `GET /releases/actions/upgrade` — "is there a newer build I can have?".
   *
   * Returns the {@link Release} to move to, or `undefined` when there is none
   * **that this caller may be offered**.
   *
   * ⚠️ **`undefined` does not mean "you are up to date".** The server answers
   * `204 No Content` in two different situations and will not distinguish them:
   *
   * 1. no release newer than `version` exists; and
   * 2. a newer release *does* exist, but this license is not entitled to it —
   *    an expired license under a policy that stops delivering new builds at
   *    expiry.
   *
   * That collapse is deliberate. A distinct refusal would leak "there is a
   * newer version and you cannot have it", which is exactly the fact the
   * expiry gate exists to withhold, and `204` is the honest answer to "what
   * can I upgrade to?" in both cases: nothing. Word it to users as *no update
   * is available to you*, never as *you are on the latest version* — the second
   * is a claim this endpoint cannot support, and it is wrong precisely for the
   * customers whose licence lapsed.
   *
   * A **suspended** license is the third outcome, and it is *not* collapsed
   * into the `204`: it answers `403`
   * ({@link import("./errors.js").ForbiddenError}) with "The license is
   * suspended and does not have access to this release". So the honest summary
   * is three outcomes, not two — a release, an ambiguous nothing, and an
   * explicit refusal.
   *
   * ⚠️ **A `undefined` here is most often a constraint artefact, not a verdict
   * about releases.** Leaving {@link UpgradeCheckOptions.constraint} unset
   * pins the search to patch upgrades within the caller's current
   * `major.minor`, so a published `1.3.0` is invisible to a client on `1.2.0`
   * that did not ask for it. Read that field's note before concluding the
   * server has nothing.
   *
   * Auth is optional here (`OptionalAuth`), the only such route this SDK calls
   * — but "public" is a property of the **product**, not of the route. Access
   * runs through `enforce_distribution_strategy`: an `Open` product answers an
   * unauthenticated request, deliberately, so that auto-updaters already
   * deployed in the field keep working; a `Licensed` product needs a credential
   * carrying `release.read` and otherwise answers `401`/`403`; a `Closed`
   * product needs an admin, developer or product token. Credentials are sent
   * whenever configured, as everywhere else in this SDK.
   *
   * An unknown `productId` is a `404`
   * ({@link import("./errors.js").NotFoundError}), raised before the upgrade
   * check runs at all — worth distinguishing from the `204`, since it means the
   * updater is configured with the wrong product rather than that it is
   * current.
   *
   * All of `productId`/`platform`/`filetype`/`version` are required by the
   * server, and `channel` is required by this SDK — see
   * {@link UpgradeCheckOptions}. A request missing one is rejected by a bare
   * Axum query extractor, whose `400` carries a **plain-text** body rather than
   * a JSON:API error document; it surfaces as an
   * {@link import("./errors.js").ApiError} with code `"UNKNOWN"` and status
   * `400`, not a parse failure.
   */
  async checkForUpgrade(opts: UpgradeCheckOptions): Promise<Release | undefined> {
    const { data } = await sendJsonApiOptional<Release>(this.transport, {
      method: "GET",
      path: "/releases/actions/upgrade",
      query: {
        product: opts.productId,
        platform: opts.platform,
        filetype: opts.filetype,
        version: opts.version,
        channel: opts.channel,
        constraint: opts.constraint,
      },
    });
    return data;
  }

  /**
   * `GET /v1/health` — the server's liveness probe.
   *
   * The only route this SDK calls that is **not** under
   * `/v1/accounts/{account_id}`, and the only one that answers with a flat
   * `application/json` body instead of a JSON:API envelope. It is public: the
   * server lists it in `PUBLIC_ROUTES` and resolves no credential for it, since
   * there is no account segment to resolve one against. Credentials are still
   * sent, consistently with every other method here, and are simply ignored.
   *
   * **Its real value is diagnostic**, because it is also the one route exempt
   * from the `Host`-header check. If every call is failing with
   * `403 "The Host header does not match any configured host"` and this one
   * succeeds, the fault is the deployment's `TAMGA_ALLOWED_HOSTS`
   * configuration — not the caller's credential, not the account id, and not
   * anything a different key would fix.
   */
  async health(): Promise<HealthStatus> {
    const { data } = await sendFlat<HealthStatus>(this.originTransport, {
      method: "GET",
      path: "/v1/health",
    });
    return data;
  }
}
