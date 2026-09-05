/**
 * License validation result types.
 *
 * `ValidationCode` models all 24 wire values documented in the Tamga API
 * protocol specification §2, evaluated server-side in priority order on the
 * by-ID endpoint. Nineteen are reachable; the other five (`NOT_FOUND`,
 * `BANNED`, `COMPONENTS_SCOPE_MISMATCH`, `CHECKSUM_SCOPE_MISMATCH`,
 * `VERSION_SCOPE_MISMATCH`) are declared in the server's enum but never
 * emitted (see that specification's Known Server-Side Gaps #4). The
 * unreachable ones are still modeled here for forward-compatibility: a
 * server-side fix that wires one of them up should not require an SDK type
 * change.
 *
 * ⚠️ `ENTITLEMENTS_MISSING` and `FINGERPRINT_SCOPE_MISMATCH` **are reachable**
 * — they left the unreachable set when the server started genuinely enforcing
 * `scope.entitlements` and `scope.fingerprint`
 * (`validate_license.rs::resolve_scope_facts`). A scoped `validateById` can
 * return either, so code that dismisses them as forward-compat-only is wrong.
 * See {@link import("./license.js").LicenseScope}.
 *
 * The trailing `| (string & {})` member is the standard TypeScript
 * "open union" escape hatch: it accepts any string at the type level
 * (so an unrecognized code from a future server version doesn't force a
 * runtime throw or `as` cast) while still giving autocomplete/narrowing for
 * the known literals. Do not replace it with a bare `string` — that would
 * lose the literal-union autocomplete for the 24 known codes.
 */
export type ValidationCode =
  // Reachable today.
  | "VALID"
  | "SUSPENDED"
  | "EXPIRED"
  | "OVERDUE"
  | "PRODUCT_SCOPE_MISMATCH"
  | "POLICY_SCOPE_MISMATCH"
  | "USER_SCOPE_MISMATCH"
  | "ENVIRONMENT_SCOPE_MISMATCH"
  | "TOO_MANY_MACHINES"
  | "TOO_MANY_CORES"
  | "TOO_MUCH_MEMORY"
  | "TOO_MUCH_DISK"
  | "TOO_MANY_PROCESSES"
  | "TOO_MANY_USES"
  // Also reachable: the server enforces `scope.entitlements` and
  // `scope.fingerprint`, so a scoped `validateById` can fail with either of
  // these — see `LicenseScope` in `./license.ts`.
  | "ENTITLEMENTS_MISSING"
  | "FINGERPRINT_SCOPE_MISMATCH"
  // Also reachable since the API patch: `TOO_MANY_USERS` on every validate
  // endpoint (`users > max_users`); the two `HEARTBEAT_*` codes when
  // `scope.fingerprint` is set and the policy has `require_heartbeat`.
  | "TOO_MANY_USERS"
  | "HEARTBEAT_NOT_STARTED"
  | "HEARTBEAT_DEAD"
  // Modeled but not reachable via this field today: NOT_FOUND short-circuits
  // to HTTP 404, BANNED has no feature behind it, COMPONENTS has no scope
  // field, and the last two are refused with 422 SCOPE_NOT_SUPPORTED first.
  | "NOT_FOUND"
  | "BANNED"
  | "COMPONENTS_SCOPE_MISMATCH"
  | "CHECKSUM_SCOPE_MISMATCH"
  | "VERSION_SCOPE_MISMATCH"
  // Forward-compat escape hatch — see module doc above.
  | (string & {});

/**
 * Shared `meta` shape returned by all three validation endpoints, and what
 * `TamgaClient.validateByKey`/`validateById`/`quickValidate` decode into.
 *
 * Match on `code` — it is the stable, machine-readable outcome. `detail` is
 * human-readable text whose wording can change between server versions.
 */
export interface LicenseValidationResult {
  ts: string;
  valid: boolean;
  detail: string;
  code: ValidationCode;
}

/**
 * Combined response of `validateByKey`/`validateById`: the (possibly
 * touched) license resource plus the validation outcome. Quick-validate
 * returns only a bare {@link LicenseValidationResult} — it has no `data`
 * envelope, so it does not use this combined type.
 */
export interface ValidationResult {
  /**
   * The license resource as of this validation call (reflects
   * `last_validated_at` being bumped, unless `skip_touch: true` was sent).
   */
  license: import("./license.js").License;
  /** The validation outcome. */
  meta: LicenseValidationResult;
  /**
   * The machine this activation resolved to, when the call had one.
   *
   * Only {@link import("../client.js").TamgaClient.activateMachine} ever sets
   * this — `validateByKey`/`validateById` are license-level calls and leave it
   * absent. Present when `activateMachine` created a machine, and also when it
   * recovered a pre-existing one through its idempotent
   * `FINGERPRINT_TAKEN` path.
   *
   * Absent in three cases, each meaning something different:
   * - the create was refused outright by a create-time limit under
   *   `NO_OVERAGE`, so no machine exists;
   * - `autoDeleteOnOverage` rolled back the machine this call created, so the
   *   machine that would have been reported no longer exists;
   * - the call was not `activateMachine`.
   *
   * A machine the caller passed in through the idempotent path is **never**
   * rolled back, so its presence here does not imply this call created it.
   */
  machine?: import("./machine.js").Machine;
}
