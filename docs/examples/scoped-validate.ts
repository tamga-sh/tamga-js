/**
 * Node example: validate a license by ID with a full scope constraint.
 *
 * `validateById` calls `POST /licenses/{license_id}/actions/validate`.
 *
 * Six of the eight scope fields are enforced server-side:
 * `product`/`policy`/`user`/`environment`, plus `entitlements` (entitlement
 * **codes**, matched case-insensitively across both the license's direct
 * attachments and the ones inherited from its policy) and `fingerprint`
 * (matched against any machine on the license — the anti-key-sharing check).
 *
 * `version` and `checksum` are deprecated dead weight: the server answers
 * `422 SCOPE_NOT_SUPPORTED` to a scope carrying either and never runs the
 * validation at all. The SDK strips them before sending so an existing
 * caller degrades to a working validate rather than a hard failure — but
 * stop setting them.
 */
import { TamgaClient } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const licenseId = process.env.TAMGA_LICENSE_ID ?? "00000000-0000-0000-0000-000000000000";

const { meta } = await client.validateById(licenseId, {
  scope: {
    product: process.env.TAMGA_PRODUCT_ID,
    environment: process.env.TAMGA_ENVIRONMENT_ID,
    // Enforced: this license has to hold the PRO entitlement, directly or
    // through its policy.
    entitlements: ["PRO"],
    // Enforced: binds the validation to a machine already activated on this
    // license, so a shared key validated from an unregistered machine fails
    // with FINGERPRINT_SCOPE_MISMATCH.
    fingerprint: process.env.TAMGA_MACHINE_FINGERPRINT,
  },
  // Suppresses the last_validated_at side effect — useful for a
  // "just checking, not activating" probe that shouldn't count as real
  // usage.
  skipTouch: true,
});

console.log(`Validation outcome: ${meta.code} (valid: ${meta.valid})`);

switch (meta.code) {
  case "PRODUCT_SCOPE_MISMATCH":
  case "ENVIRONMENT_SCOPE_MISMATCH":
    console.log("This license isn't scoped to the product/environment you asked about.");
    break;
  case "ENTITLEMENTS_MISSING":
    console.log("The license doesn't hold every entitlement code the scope asked for.");
    break;
  case "FINGERPRINT_SCOPE_MISMATCH":
    console.log("No machine with that fingerprint is activated on this license.");
    break;
  case "TOO_MANY_MACHINES":
  case "TOO_MANY_CORES":
  case "TOO_MUCH_MEMORY":
  case "TOO_MUCH_DISK":
  case "TOO_MANY_PROCESSES":
    console.log("An overage limit was exceeded — see the policy's overage_strategy.");
    break;
  default:
    break;
}
