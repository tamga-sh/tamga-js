/**
 * Node example: validate a license by ID with a full scope constraint.
 *
 * `validateById` calls `POST /licenses/{license_id}/actions/validate`.
 * Only `product`/`policy`/`user`/`environment` are enforced server-side
 * today (Tamga API protocol specification §2) — `entitlements`/
 * `fingerprint`/`version`/`checksum` are accepted and forwarded for
 * forward-compatibility but are currently parsed and silently ignored by
 * the server. Don't rely on them as functioning constraints yet.
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
