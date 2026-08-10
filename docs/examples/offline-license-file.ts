/**
 * Node example: check out a `.lic` offline license file, then verify and
 * decrypt it fully offline.
 *
 * Checkout requires network access (it's an API call); verification does
 * not — once you have the PEM string and the account's Ed25519 public
 * key, `verifyAndDecryptLicenseFile` never touches the network. This is
 * the pattern for air-gapped/offline license enforcement.
 */
import { TamgaClient, verifyAndDecryptLicenseFile } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const licenseId = process.env.TAMGA_LICENSE_ID ?? "00000000-0000-0000-0000-000000000000";

// `encrypt: true` requests the AES-256-GCM-encrypted variant — omit or set
// `false` for a plain (still Ed25519-signed) file. `ttl` is metadata only:
// it is NOT embedded in the signed payload and NOT re-checked by the
// server later — enforce any expiry yourself, client-side.
const pem = await client.checkOutLicense(licenseId, { encrypt: true, ttl: 30 * 24 * 3600 });

// Embed your account's Ed25519 public key (raw 32 bytes) in the shipped
// application — never fetch it at verify time, that would defeat the
// point of offline verification.
const ed25519PublicKey = new Uint8Array(
  Buffer.from(process.env.TAMGA_ED25519_PUBLIC_KEY_BASE64 ?? "", "base64"),
);

const license = await verifyAndDecryptLicenseFile(
  pem,
  ed25519PublicKey,
  // Only required for the encrypted variant — omit for a plain file.
  process.env.TAMGA_LICENSE_KEY,
);

console.log(`Verified offline: license ${license.id}, status ${license.attributes.status}`);
