/**
 * Policy resource model and policy-derived enums.
 *
 * STUB — placeholder shapes only. See `docs/plans/tamga-js.plan.md`
 * Section K for the full field list and TSDoc gotchas to add:
 *
 * - `LicenseScheme`: `ED25519_SIGN`, `RSA_2048_PKCS1_SIGN`,
 *   `RSA_2048_PKCS1_PSS_SIGN`, `ECDSA_P256_SIGN`, `RSA_2048_JWT_RS256`;
 *   unset = legacy plain key string, unsigned.
 * - `OverageStrategy`: `NO_OVERAGE` .. `ALWAYS_ALLOW_OVERAGE` — applies to
 *   machines/cores/memory/disk/processes, NOT to `uses` (always strict
 *   `>=` regardless of strategy).
 * - `HeartbeatCullStrategy`, `HeartbeatResurrectionStrategy`.
 * - ⚠️ Freshly-created policies default `overage_strategy` to
 *   `"DENY_ACCESS"` and `heartbeat_resurrection_strategy` to
 *   `"NO_RESURRECTION"` — **neither is a real enum variant**; both silently
 *   behave as `NO_OVERAGE`/`NO_REVIVE` server-side (docs/sdk.md §10).
 * - The policy `GET` response omits `max_memory`/`max_disk` even though
 *   both are enforced during validation.
 */

export type LicenseScheme =
  | "ED25519_SIGN"
  | "RSA_2048_PKCS1_SIGN"
  | "RSA_2048_PKCS1_PSS_SIGN"
  | "ECDSA_P256_SIGN"
  | "RSA_2048_JWT_RS256";

export type OverageStrategy =
  | "NO_OVERAGE"
  | "ALLOW_1_25X_OVERAGE"
  | "ALLOW_1_5X_OVERAGE"
  | "ALLOW_2X_OVERAGE"
  | "ALWAYS_ALLOW_OVERAGE";

export type HeartbeatCullStrategy = "DEACTIVATE_DEAD" | "KEEP_DEAD";

export type HeartbeatResurrectionStrategy =
  | "NO_REVIVE"
  | "1_MINUTE_REVIVE"
  | "2_MINUTE_REVIVE"
  | "5_MINUTE_REVIVE"
  | "10_MINUTE_REVIVE"
  | "15_MINUTE_REVIVE"
  | "ALWAYS_REVIVE";

/** TODO: full Policy resource — see module doc above. */
export interface Policy {
  id: string;
  type: "policies";
  max_machines?: number;
  max_cores?: number;
  max_processes?: number;
  max_uses?: number;
  overage_strategy: OverageStrategy | (string & {});
  heartbeat_cull_strategy: HeartbeatCullStrategy;
  heartbeat_resurrection_strategy: HeartbeatResurrectionStrategy | (string & {});
  scheme?: LicenseScheme;
}
