/**
 * License-related resource models.
 *
 * STUB — placeholder shapes only. See `docs/plans/tamga-js.plan.md`
 * Sections C, D, E, J for the full field lists and TSDoc gotchas to add:
 *
 * - `License`: JSON:API attributes matching the server License resource
 *   (id, type, key, suspended, expiry, uses, last_check_in_at,
 *   last_validated_at, relationships to policy/product/environment/user).
 * - `LicenseScope`: 8 optional fields (`product`, `policy`, `user`,
 *   `environment`, `entitlements`, `fingerprint`, `version`, `checksum`) —
 *   only the first 4 are enforced server-side today (docs/sdk.md §2);
 *   model all 8 for forward-compat but don't advertise the other 4 as
 *   functioning constraints.
 * - `Entitlement`: `{ name, code, metadata, created, updated }` — full
 *   resources despite the URL's junction-like shape (docs/sdk.md §9).
 */

/** TODO: full License resource — see module doc above. */
export interface License {
  id: string;
  type: "licenses";
}

/** TODO: full 8-field LicenseScope — see module doc above. */
export interface LicenseScope {
  product?: string;
  policy?: string;
  user?: string;
  environment?: string;
}

/** TODO: full Entitlement resource — see module doc above. */
export interface Entitlement {
  name: string;
  code: string;
}
