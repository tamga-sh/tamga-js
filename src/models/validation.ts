/**
 * License validation result types.
 *
 * `ValidationCode` models all 24 wire values documented in the Tamga API
 * protocol specification §2, evaluated server-side in priority order on the
 * by-ID endpoint. Sixteen are currently reachable; the other eight are
 * declared in the server's enum but never emitted (see that specification's
 * Known Server-Side Gaps #4). The unreachable ones are still modeled here for
 * forward-compatibility: a server-side fix that wires one of them up should
 * not require an SDK type change.
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
  // Modeled but not reachable via this field today — see the Tamga API
  // protocol specification §2.
  | "NOT_FOUND"
  | "BANNED"
  | "TOO_MANY_USERS"
  | "HEARTBEAT_DEAD"
  | "HEARTBEAT_NOT_STARTED"
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
}
