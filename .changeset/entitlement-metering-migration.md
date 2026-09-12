---
"@tamga/sdk": patch
---

Replace the retired global per-license usage counter with named,
per-entitlement meters, matching the server's entitlement-metering
migration.

- Removed (no back-compat shim): `LicenseAttributes.uses`,
  `LicenseAttributes.max_uses`, `PolicyAttributes.max_uses`, and the
  `TOO_MANY_USES` `ValidationCode` member. The server no longer emits any of
  these on the wire.
- Added `kind: "flag" | "meter"` to `EntitlementAttributes` (always present).
  License-scoped entitlement reads also carry `max_value` (the effective
  cap, `null` = unlimited) and `current_value` (the running count);
  policy-scoped reads carry `max_value` only.
- Added three new `TamgaClient` methods mirroring the existing
  `pingHeartbeat`/`resetHeartbeat` pair: `incrementEntitlementUsage`,
  `decrementEntitlementUsage`, `resetEntitlementUsage` — each posts to
  `/licenses/{id}/entitlements/{entitlementId}/actions/{verb}` and decodes
  back into the full, fresh entitlement resource.
- Added `MeterLimitExceededError` (`422 METER_LIMIT_EXCEEDED`), exposing
  `entitlementId` from `meta.entitlement_id`, replacing the retired
  `TOO_MANY_USES` validation code as the way this condition surfaces.

See `docs/entitlement-metering-migration.md` for the full wire-contract
spec.

## Why this is released as a `patch`, not a `minor` or `major`

By real SemVer, this is a breaking change — the migration spec itself says
so explicitly ("no back-compat shim... every SDK's next release is a major
version bump"), and this repo has its own on-point precedent for treating
an equivalent change (the 0.4.0 removal of `PolicyAttributes.max_memory`/
`max_disk`) as at least a `minor`, specifically because a `minor` is the
smallest bump a `^0.x` consumer range actually receives.

This release is a deliberate, explicitly-confirmed exception to that norm,
scoped to this one coordinated fleet-wide rollout (see
`docs/plans/2026-09-12-entitlement-metering-sdk-rollout.plan.md`, "Patch-only
enforcement"): every one of the 8 Tamga SDKs in this migration is being
released as a patch, on purpose, so the mechanism differs per package (this
one is Changesets; the others are release-please/release-plz) but the
outcome — patch, never major or minor — is the same everywhere. The
tradeoff (a consumer pinned to `.uses`/`.max_uses`/`TOO_MANY_USES` gets a
silent break on what looks like a safe patch upgrade) is accepted knowingly,
not overlooked; it is documented here, in the PR body, and in
`docs/entitlement-metering-migration.md` so it is not a dangling reference.
