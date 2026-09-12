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
 * Six of the eight fields are enforced server-side:
 * `product`/`policy`/`user`/`environment`, plus `entitlements` and
 * `fingerprint`.
 *
 * ⚠️ `version` and `checksum` are **not** inert. The server rejects a scope
 * carrying either with `422 SCOPE_NOT_SUPPORTED`, failing the entire
 * validate call — no `meta.valid` comes back at all. `validateById` strips
 * both before sending so an existing caller degrades to a working validate
 * rather than a hard failure, but they are deprecated and will be removed in
 * the next minor release.
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
  /**
   * **Enforced.** The license must hold every entitlement listed, whether
   * attached directly or inherited from its policy.
   *
   * Takes entitlement **`code`s** — not the UUIDs the attach/detach bodies
   * use. Compared case-insensitively and de-duplicated server-side. An empty
   * array asserts nothing and always passes. A failure comes back as the
   * `ENTITLEMENTS_MISSING` {@link
   * import("./validation.js").ValidationCode}.
   */
  entitlements?: string[];
  /**
   * **Enforced.** Must match the fingerprint of *some* machine on this
   * license — heartbeat state is irrelevant, and it need not be the machine
   * the caller is running on. This is the anti-key-sharing check. A failure
   * comes back as the `FINGERPRINT_SCOPE_MISMATCH` {@link
   * import("./validation.js").ValidationCode}.
   */
  fingerprint?: string;
  /**
   * @deprecated Rejected server-side with `422 SCOPE_NOT_SUPPORTED`, which
   * fails the whole validate call. Stripped before sending — see this
   * interface's doc comment.
   */
  version?: string;
  /**
   * @deprecated Rejected server-side with `422 SCOPE_NOT_SUPPORTED`, which
   * fails the whole validate call. Stripped before sending — see this
   * interface's doc comment.
   */
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
  /**
   * `"flag"` (a boolean grant — the only kind that existed before entitlement
   * metering) or `"meter"` (a named, per-license counter with an independent
   * cap). Always present on every response — not optional/nullable — though a
   * create request may omit it, in which case the server defaults it to
   * `"flag"`. There is no update path for this field: an entitlement's kind is
   * fixed at creation.
   */
  kind: "flag" | "meter";
  /**
   * `true` when the license holds this entitlement through its **policy**
   * rather than directly.
   *
   * Two consequences worth coding against:
   * - An inherited entitlement cannot be detached from the license.
   * - `GET /licenses/{id}/entitlements/{eid}` resolves *direct* attachments
   *   only, so
   *   {@link import("../client.js").TamgaClient.getEntitlement} answers `404`
   *   for one of these even though the list endpoint just returned it —
   *   list-then-get-each is not a valid pattern on this resource.
   *
   * Only the license-scoped listing emits this field; account-, policy- and
   * release-scoped entitlement responses omit it, hence optional.
   */
  inherited?: boolean;
  /**
   * The effective cap for a `kind: "meter"` entitlement — the license's own
   * override if it has one, else the policy's default, else `null` =
   * unlimited (the same "nullable = unlimited" convention every other
   * `max_*` field on `licenses`/`policies` uses). Meaningless, but present,
   * for `kind: "flag"`.
   *
   * Emitted by both the license-scoped and policy-scoped entitlement
   * listings, hence optional here rather than on a third split type — the
   * plain (account-/release-scoped) listing omits it.
   */
  max_value?: number | null;
  /**
   * The running count for a `kind: "meter"` entitlement, `0` if never
   * incremented. **Only emitted by the license-scoped listing** — the
   * policy-scoped listing carries `max_value` but never this field, since
   * usage is never pooled at the policy level.
   *
   * ⚠️ `0` does not necessarily mean "never used" — it also means "this
   * entitlement is only inherited from the license's policy and has never
   * been directly attached to this license", because only a direct
   * `license_entitlements` row carries a counter at all. Check {@link
   * inherited} to tell the two apart if that distinction matters.
   */
  current_value?: number;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}
