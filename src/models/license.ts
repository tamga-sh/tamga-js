/**
 * License-related resource models.
 *
 * Field set ground-truthed against `tamga-rust`'s `src/models/license.rs`
 * (which itself was ground-truth-verified against the Tamga API's actual
 * `LicenseResource`/`LicenseAttributes` serializer) — notably **no
 * `relationships` object exists on this resource today**; do not model one.
 */

/** The `licenses` JSON:API resource: `{ id, type, attributes }`. */
export interface License {
  /** UUIDv7 license ID. */
  id: string;
  /** Always `"licenses"`. */
  type: "licenses";
  attributes: LicenseAttributes;
}

/** Attributes of a {@link License}, matching the server's field set exactly. */
export interface LicenseAttributes {
  /** Optional display name. */
  name: string | null;
  /** The raw license key string, if one is set (some licenses are keyless/token-only). */
  key: string | null;
  /**
   * Server-computed status string (not the same as {@link
   * import("./validation.js").ValidationCode}) — the license's own state,
   * e.g. `"ACTIVE"`/`"EXPIRED"`/`"SUSPENDED"`.
   */
  status: string;
  /** Absolute expiry timestamp, if the license expires. */
  expiry: string | null;
  /** Manually suspended by an account admin. */
  suspended: boolean;
  /** Whether checkout/download of this license's key is protected. */
  protected: boolean;
  /** Current use count, compared against `max_uses` (strict `>=`, regardless of overage strategy). */
  uses: number;
  /**
   * Signing scheme for checkout files — see {@link
   * import("./policy.js").LicenseScheme}. `null` means a legacy plain/unsigned key.
   */
  scheme: string | null;
  /** Whether checkout files for this license are encrypted by default. */
  encrypted: boolean;
  /** Strict mode flag (server-side semantics not yet SDK-relevant). */
  strict: boolean;
  /** Floating license flag (server-side semantics not yet SDK-relevant). */
  floating: boolean;
  /** Per-license override of `policy.max_machines`, if set. */
  max_machines: number | null;
  /** Per-license override of `policy.max_uses`, if set. */
  max_uses: number | null;
  /** Per-license override of `policy.max_users`, if set. */
  max_users: number | null;
  /** Timestamp of the last successful validation, unless suppressed via `skip_touch`. */
  last_validated_at: string | null;
  /** Timestamp of the last successful check-in. */
  last_check_in_at: string | null;
  /** Timestamp of the last license-file checkout. */
  last_check_out_at: string | null;
  /** Current count of activated machines. */
  machines_count: number;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}

/**
 * Scope constraints for `validateById`, sent as `meta.scope` in the request
 * body. Every field is optional — omitted means "no constraint, skip this
 * check."
 *
 * Only `product`/`policy`/`user`/`environment` are enforced server-side
 * today (Tamga API protocol specification §2); `entitlements`/
 * `fingerprint`/`version`/`checksum` are parsed and silently ignored. Kept
 * here for forward-compatibility — do not advertise the latter 4 as
 * functioning constraints.
 */
export interface LicenseScope {
  /** Enforced. Must match the license's product. */
  product?: string;
  /** Enforced. Must match the license's policy. */
  policy?: string;
  /** Enforced. Must match the license's owner. */
  user?: string;
  /** Enforced. Must match the license's environment. */
  environment?: string;
  /** Not enforced server-side yet — parsed and ignored. */
  entitlements?: string[];
  /** Not enforced server-side yet — parsed and ignored. */
  fingerprint?: string;
  /** Not enforced server-side yet — parsed and ignored. */
  version?: string;
  /** Not enforced server-side yet — parsed and ignored. */
  checksum?: string;
}

/** The `entitlements` JSON:API resource: `{ id, type, attributes }`. */
export interface Entitlement {
  /** UUIDv7 entitlement ID. */
  id: string;
  /** Always `"entitlements"`. */
  type: "entitlements";
  attributes: EntitlementAttributes;
}

/**
 * Attributes of an {@link Entitlement}. Despite the URL's junction-like
 * shape (`/licenses/{id}/entitlements`), these are full resources — not
 * lightweight relationship records.
 */
export interface EntitlementAttributes {
  /** Display label — **never** match on this; see `code`. */
  name: string;
  /** The stable, developer-facing identifier. `hasEntitlement` matches on this, never `name`. */
  code: string;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}
