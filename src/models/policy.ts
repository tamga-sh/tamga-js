/**
 * Policy resource model and policy-derived enums.
 *
 * Field set ground-truthed against `tamga-rust`'s `src/models/policy.rs`
 * (itself verified against the Tamga API's `PolicyResource`/`PolicyAttributes`
 * serializer) — several fields here (`product_id`, `duration`,
 * `expiration_basis`, `machine_uniqueness_strategy`, `use_pool`,
 * `protected`, `check_in_interval_count`, `require_heartbeat`, `max_users`)
 * are real server fields that the abbreviated protocol summary omits — the
 * serializer, not the summary, is the authority here.
 */

import { MACHINE_HEARTBEAT_WINDOW_MS } from "./machine.js";

/**
 * Signing scheme used for license/machine checkout files (and, always,
 * regardless of this value, machine offline proofs — see `src/proof.ts`).
 *
 * The wire field (`license.scheme`/`policy.scheme`) is `string | null` —
 * `null`/`""` means "legacy plain/unsigned key" and has no corresponding
 * literal here. When generating a **machine** file, the server defaults an
 * unset scheme to `"ED25519_SIGN"` — callers of
 * `verifyAndDecryptMachineFile` whose license has no `scheme` set must pass
 * `"ED25519_SIGN"` to match, not skip verification.
 */
export type LicenseScheme =
  | "ED25519_SIGN"
  | "RSA_2048_PKCS1_SIGN"
  | "RSA_2048_PKCS1_PSS_SIGN"
  | "ECDSA_P256_SIGN"
  | "RSA_2048_JWT_RS256";

/**
 * Overage handling for machine/core/memory/disk/process limits — how far
 * over `policy.max_*` a count is still permitted before validation fails
 * with the corresponding `TOO_MANY_*`/`TOO_MUCH_*` {@link
 * import("./validation.js").ValidationCode}.
 *
 * Multiplies the relevant limit before comparing; applies to
 * machines/cores/memory/disk/processes — **not** to `uses` (server always
 * enforces strict `count >= max_uses` for uses, regardless of strategy).
 */
export type OverageStrategy =
  | "NO_OVERAGE"
  | "ALLOW_1_25X_OVERAGE"
  | "ALLOW_1_5X_OVERAGE"
  | "ALLOW_2X_OVERAGE"
  | "ALWAYS_ALLOW_OVERAGE";

/**
 * Returns whether `count` is permitted under `strategy` given a `max`
 * limit — mirrors the server's own `OverageStrategy::allows` (including its
 * floating-point multiplication), so a client-side pre-check reaches the
 * identical verdict.
 */
export function overageStrategyAllows(strategy: OverageStrategy, count: number, max: number): boolean {
  switch (strategy) {
    case "NO_OVERAGE":
      return count <= max;
    case "ALLOW_1_25X_OVERAGE":
      return count <= max * 1.25;
    case "ALLOW_1_5X_OVERAGE":
      return count <= max * 1.5;
    case "ALLOW_2X_OVERAGE":
      return count <= max * 2.0;
    case "ALWAYS_ALLOW_OVERAGE":
      return true;
  }
}

/**
 * Resolves a raw `overage_strategy` wire string to its typed
 * {@link OverageStrategy}, falling back to `"NO_OVERAGE"` for any
 * unrecognized value. ⚠️ Freshly-created policies default this field to the
 * **non-existent** string `"DENY_ACCESS"`, which the server itself silently
 * treats as `NO_OVERAGE` — this resolver reproduces that exact fallback
 * behavior rather than throwing on it.
 */
export function resolveOverageStrategy(raw: string): OverageStrategy {
  switch (raw) {
    case "NO_OVERAGE":
    case "ALLOW_1_25X_OVERAGE":
    case "ALLOW_1_5X_OVERAGE":
    case "ALLOW_2X_OVERAGE":
    case "ALWAYS_ALLOW_OVERAGE":
      return raw;
    default:
      return "NO_OVERAGE";
  }
}

/**
 * What the server's cull job does with a machine row whose heartbeat window
 * has elapsed.
 *
 * ⚠️ **Only consulted when the policy sets `require_heartbeat = true`**, and
 * that column defaults to `false`: the cull job returns early for such a
 * policy and never claims its machines, so under a default policy neither
 * variant here ever runs and no row is ever culled. A machine's
 * `heartbeat_status` sitting at `"DEAD"` — as a checked-out machine file can
 * report — is therefore not evidence that this strategy was applied; see
 * {@link import("./machine.js").HeartbeatStatus}.
 */
export type HeartbeatCullStrategy = "DEACTIVATE_DEAD" | "KEEP_DEAD";

/**
 * How long after heartbeat expiry the cull job still lets a dead machine be
 * revived, before {@link HeartbeatCullStrategy} takes effect.
 *
 * ⚠️ This governs the cull job only — it is **not** a window on
 * `ping-heartbeat`. The ping handler is a bare `last_heartbeat_at = now`
 * write with no resurrection check, so a ping revives a `DEAD` machine
 * whatever this says, for as long as the row exists.
 */
export type HeartbeatResurrectionStrategy =
  | "NO_REVIVE"
  | "1_MINUTE_REVIVE"
  | "2_MINUTE_REVIVE"
  | "5_MINUTE_REVIVE"
  | "10_MINUTE_REVIVE"
  | "15_MINUTE_REVIVE"
  | "ALWAYS_REVIVE";

/**
 * Resolves a raw `heartbeat_resurrection_strategy` wire string to its typed
 * {@link HeartbeatResurrectionStrategy}, falling back to `"NO_REVIVE"` for
 * any unrecognized value. ⚠️ Freshly-created policies default this field to
 * the **non-existent** string `"NO_RESURRECTION"`, which the server itself
 * silently treats as `NO_REVIVE` — this resolver reproduces that exact
 * fallback behavior rather than throwing on it.
 */
export function resolveHeartbeatResurrectionStrategy(raw: string): HeartbeatResurrectionStrategy {
  switch (raw) {
    case "NO_REVIVE":
    case "1_MINUTE_REVIVE":
    case "2_MINUTE_REVIVE":
    case "5_MINUTE_REVIVE":
    case "10_MINUTE_REVIVE":
    case "15_MINUTE_REVIVE":
    case "ALWAYS_REVIVE":
      return raw;
    default:
      return "NO_REVIVE";
  }
}

/**
 * Check-in cadence unit. ⚠️ Wire values are lowercase **adverbs** —
 * `"daily"`/`"weekly"`/`"monthly"`/`"yearly"` — inconsistent with the
 * `SCREAMING_SNAKE_CASE` convention every other enum on this resource uses.
 * Preserved as-is, not normalized.
 *
 * Unlike `overage_strategy` and `heartbeat_resurrection_strategy`, this one
 * needs no lenient resolver: the column carries its own `CHECK` constraint
 * (`check_in_interval IS NULL OR check_in_interval IN ('daily', 'weekly',
 * 'monthly', 'yearly')`) and `policies::enums::CHECK_IN_INTERVALS` repeats it,
 * so the four values above are the only ones the database can hold.
 *
 * > **Corrected in 0.4.0.** This union previously read
 * > `"day" | "week" | "month" | "year"`, spellings the column rejects, so it
 * > could not describe any policy that exists. Comparing this field against
 * > `"day"` is now a compile error — the noun forms were never on the wire.
 *
 * ⚠️ **Knowing the cadence does not tell you when the server expects a
 * check-in.** `validate_license.rs::check_in_interval_days` matches on the
 * *noun* spellings the column cannot store, so every configured cadence falls
 * through its `_ => 30` arm: a `"daily"` policy is enforced at thirty days,
 * and `check_in_interval_count` is discarded on that path rather than
 * multiplied. Filed upstream as `tamga-api-internal#3`. No SDK can correct it
 * — read this field as "what the policy was configured to mean", not as the
 * deadline {@link import("../client.js").TamgaClient.checkIn} is judged
 * against.
 */
export type CheckInInterval = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Named recognized values for the free-text `expiration_strategy` policy
 * field — the server branches on literal string match, not a closed enum,
 * so this is documentation/autocomplete only, not a validated type.
 * `"RESTRICT_ACCESS"` is the default. Any value outside this list is
 * branched as "deny/default" server-side — treat unrecognized values the
 * same way client-side.
 *
 * The distinction that matters at the **auth gate**: under
 * `"MAINTAIN_ACCESS"` / `"ALLOW_ACCESS"` / `"RESTRICT_ACCESS"` an expired
 * license still authenticates, and the expiry shows up as an `EXPIRED`
 * validation code on a 200 response. Under `"REVOKE_ACCESS"` the credential
 * itself is rejected with `401 LICENSE_EXPIRED` — see
 * {@link import("../errors.js").LicenseExpiredError} — so no endpoint,
 * including validate, is reachable at all.
 */
export const ExpirationStrategy = {
  RESTRICT_ACCESS: "RESTRICT_ACCESS",
  MAINTAIN_ACCESS: "MAINTAIN_ACCESS",
  ALLOW_ACCESS: "ALLOW_ACCESS",
  REVOKE_ACCESS: "REVOKE_ACCESS",
} as const;

/**
 * Named recognized values for the free-text `renewal_basis` policy field.
 * `"FROM_EXPIRY"` is the default vs. `"FROM_NOW"`. See {@link
 * ExpirationStrategy}'s doc comment for the "free-text, not a closed enum"
 * caveat — it applies here too.
 */
export const RenewalBasis = {
  FROM_EXPIRY: "FROM_EXPIRY",
  FROM_NOW: "FROM_NOW",
} as const;

/**
 * Named recognized values for the free-text `authentication_strategy`
 * policy field. See {@link ExpirationStrategy}'s doc comment for the
 * "free-text, not a closed enum" caveat — it applies here too.
 *
 * ⚠️ **License-key auth is off by default.** The server accepts an
 * `Authorization: License <key>` credential only under `"LICENSE"` or
 * `"MIXED"`; the column defaults to `"TOKEN"`, and `"NONE"` behaves the same
 * way `"TOKEN"` does at this gate. Under either, every call made with
 * `{ kind: "license", key }` comes back `401 LICENSE_NOT_ALLOWED` — a
 * configuration precondition, not a retryable auth failure. See
 * {@link import("../errors.js").LicenseNotAllowedError}.
 */
export const AuthenticationStrategy = {
  TOKEN: "TOKEN",
  LICENSE: "LICENSE",
  MIXED: "MIXED",
  NONE: "NONE",
} as const;

/** The `policies` JSON:API resource: `{ id, type, attributes }`. */
export interface Policy {
  /** UUIDv7 policy ID. */
  id: string;
  /** Always `"policies"`. */
  type: "policies";
  attributes: PolicyAttributes;
}

/**
 * Attributes of a {@link Policy}.
 *
 * Field-for-field with the server's own `PolicyAttributes` serializer
 * (`tamga-api/src/features/policies/serializer.rs:22-52`), which is the only
 * thing that decides what a policy read carries.
 *
 * ⚠️ **`max_memory` and `max_disk` are deliberately not modeled.** Both exist
 * on the server's `Policy` model and both are enforced during validation
 * (`policies/model.rs:187-188`, `:302`, `:309`), but the serializer never
 * emits them — it emits `max_machines`, `max_cores`, `max_uses`,
 * `max_processes` and `max_users` and stops. They are settable through the
 * policy create/update request bodies, which this SDK does not expose, and
 * unreadable through every route it does. So the two limits are observable
 * only as `TOO_MUCH_MEMORY`/`TOO_MUCH_DISK` on a failed validation, or as
 * `MEMORY_LIMIT_EXCEEDED`/`DISK_LIMIT_EXCEEDED` on a refused machine create.
 *
 * > **Changed in 0.4.0.** Both were previously declared here as optional
 * > properties documented as "always `undefined`". Nothing could ever
 * > populate them, so the declarations only invited callers to branch on a
 * > value that never arrives; reading either is now a compile error.
 */
export interface PolicyAttributes {
  /** The product this policy belongs to. */
  product_id: string;
  /** Display name. */
  name: string;
  /** Default license duration in seconds, if set. */
  duration: number | null;
  /** Strict mode flag (server-side semantics not yet SDK-relevant). */
  strict: boolean;
  /** Floating license flag (server-side semantics not yet SDK-relevant). */
  floating: boolean;
  /** Signing scheme — see {@link LicenseScheme}. `null`/absent means legacy plain/unsigned key. */
  scheme: string | null;
  /** Whether checkout files are encrypted by default under this policy. */
  encrypted: boolean;
  /** Use-pool flag (server-side semantics not yet SDK-relevant). */
  use_pool: boolean;
  /** Whether checkout/download of a license's key is protected under this policy. */
  protected: boolean;
  /** Whether licenses under this policy must periodically check in. */
  require_check_in: boolean;
  /** Check-in cadence unit — see {@link CheckInInterval}. */
  check_in_interval: CheckInInterval | null;
  /**
   * Check-in cadence multiplier — `2` + `"weekly"` reads as "every 2 weeks".
   * ⚠️ Server-side this multiplier is currently dead: the arm that would
   * apply it never matches, so the fallback discards it. See
   * {@link CheckInInterval}.
   */
  check_in_interval_count: number | null;
  /**
   * Whether machines under this policy must send heartbeats. **Defaults to
   * `false`**, and the server's cull job returns early for any policy where
   * it is `false` — so on a default policy a machine that stops pinging
   * stays in `heartbeat_status: "DEAD"` indefinitely (as a checked-out
   * machine file will show, though a ping never will) and is never culled,
   * deactivated or deleted. See {@link import("./machine.js").HeartbeatStatus}
   * and {@link HeartbeatCullStrategy}.
   */
  require_heartbeat: boolean;
  /**
   * The machine heartbeat window in **seconds**. This genuinely drives the
   * window: the server uses it when set and falls back to 600s only when it
   * is `null` (`Policy::effective_heartbeat_duration_secs`, and
   * `COALESCE(p.heartbeat_duration, 600)` in the cull job's claim query).
   *
   * ⚠️ Two caveats. It does **not** affect processes — that window really is
   * a hardcoded 30s regardless of this value (see
   * `src/models/machine.ts`'s `PROCESS_HEARTBEAT_WINDOW_MS`). And there is no
   * policy getter here, so `MACHINE_HEARTBEAT_WINDOW_MS` stays pinned to the
   * 600s fallback and
   * {@link import("../client.js").TamgaClient.startHeartbeat} does not adapt
   * on its own — size the interval yourself when your policy sets this. You
   * can recover the value without reading the policy: a checked-out machine
   * file reports it as `next_heartbeat_at - last_heartbeat_at` (see
   * {@link import("./machine.js").MachineAttributes.next_heartbeat_at}).
   */
  heartbeat_duration: number | null;
  /**
   * Raw wire string (not the typed {@link HeartbeatCullStrategy}) — unlike
   * `heartbeat_resurrection_strategy` this field has no documented
   * invalid-default gotcha requiring lenient fallback parsing. ⚠️ Inert
   * unless {@link require_heartbeat} is `true`.
   */
  heartbeat_cull_strategy: string;
  /**
   * ⚠️ Raw wire string — freshly-created policies default this to the
   * **non-existent** string `"NO_RESURRECTION"`. Kept as `string` here so a
   * `Policy` fetch never fails to interpret that known-bogus value; resolve
   * with {@link resolveHeartbeatResurrectionStrategy} when you need the
   * typed form.
   */
  heartbeat_resurrection_strategy: string;
  /**
   * Whether machine fingerprints must be unique per-license or per-account
   * (server-side semantics not yet SDK-relevant beyond the
   * `FINGERPRINT_TAKEN` conflict this SDK already models).
   */
  machine_uniqueness_strategy: string;
  /** See {@link ExpirationStrategy}. Default `"RESTRICT_ACCESS"`. */
  expiration_strategy: string;
  /** What a license's expiry is computed relative to (server-side semantics not yet SDK-relevant). */
  expiration_basis: string;
  /** See {@link RenewalBasis}. Default `"FROM_EXPIRY"`. */
  renewal_basis: string;
  /** See {@link AuthenticationStrategy}. Default `"TOKEN"`. */
  authentication_strategy: string;
  /**
   * ⚠️ Raw wire string — freshly-created policies default this to the
   * **non-existent** string `"DENY_ACCESS"`. Resolve with
   * {@link resolveOverageStrategy} when you need the typed form.
   */
  overage_strategy: string;
  /** Machine activation limit, if set. */
  max_machines: number | null;
  /** Total CPU core limit across machines, if set. */
  max_cores: number | null;
  /** Total process limit across machines, if set. */
  max_processes: number | null;
  /** Use-count limit, if set (compared with strict `>=`, ignoring `overage_strategy`). */
  max_uses: number | null;
  /** Associated-user limit, if set. */
  max_users: number | null;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}

/**
 * The machine heartbeat window this policy actually imposes, in milliseconds.
 *
 * Mirrors the server's `Policy::effective_heartbeat_duration_secs`
 * (`tamga-api/src/features/policies/model.rs`) exactly: the policy's
 * `heartbeat_duration` seconds when the column is set, and the
 * {@link import("./machine.js").MACHINE_HEARTBEAT_WINDOW_MS} fallback (600 s)
 * only when it is `null`. The cull job's claim query uses the same
 * `COALESCE(p.heartbeat_duration, 600)`, so this is the number a machine is
 * really judged against.
 *
 * ⚠️ This is the **window**, not a ping interval. Divide it — by
 * {@link import("./machine.js").MACHINE_HEARTBEAT_INTERVAL_DIVISOR}, say — before
 * handing it to a scheduler; pinging exactly on the window boundary loses the
 * race every time the network is slow.
 *
 * The value is returned as the server reports it, including a non-positive
 * `heartbeat_duration` if a policy somehow carries one. That is deliberate:
 * this function's job is to say what the server will judge the machine on, and
 * silently substituting a friendlier number here would hide a misconfigured
 * policy rather than surface it.
 */
export function effectiveHeartbeatWindowMs(policy: Policy): number {
  const seconds = policy.attributes.heartbeat_duration;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? seconds * 1000
    : MACHINE_HEARTBEAT_WINDOW_MS;
}
