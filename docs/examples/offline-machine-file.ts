/**
 * Node example: check out a `.mach` offline machine file, then verify and
 * decrypt it fully offline — multi-scheme, HKDF-keyed variant of
 * `offline-license-file.ts`.
 *
 * The signing scheme is NOT self-declared by the file in a trustworthy
 * way — it must come from the license's own `scheme` field (a
 * `LicenseScheme` value you already know from having fetched/validated
 * the license). Passing the wrong scheme fails cleanly (an
 * "unsupported-algorithm" CheckoutError), it never silently verifies
 * under the wrong algorithm.
 */
import { TamgaClient, verifyAndDecryptMachineFile, type LicenseScheme } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const machineId = process.env.TAMGA_MACHINE_ID ?? "00000000-0000-0000-0000-000000000000";
const fingerprint = process.env.TAMGA_MACHINE_FINGERPRINT ?? "fp-abc123";

// ttl is validated client-side too (checkTtl, called internally) before
// the round trip — must be in (0, 31536000] seconds (365 days).
const pem = await client.checkOutMachine(machineId, { encrypt: true, ttl: 7 * 24 * 3600 });

// The scheme comes from the governing license's `scheme` field. If the
// license has no `scheme` set, the server signs machine files with
// Ed25519 by default — pass "ED25519_SIGN" to match.
const scheme: LicenseScheme =
  (process.env.TAMGA_LICENSE_SCHEME as LicenseScheme | undefined) ?? "ED25519_SIGN";

// The public key format depends on the scheme: 32 raw bytes for Ed25519,
// a SubjectPublicKeyInfo (SPKI) DER blob for either RSA variant, or a
// 65-byte uncompressed P-256 point for ECDSA.
const publicKey = new Uint8Array(Buffer.from(process.env.TAMGA_SCHEME_PUBLIC_KEY_BASE64 ?? "", "base64"));

const machine = await verifyAndDecryptMachineFile(pem, scheme, publicKey, {
  // Both are required for the encrypted variant — decrypting a machine
  // file needs the license key AND the target machine's fingerprint
  // (unlike license-file decryption, which needs only the license key).
  licenseKey: process.env.TAMGA_LICENSE_KEY ?? "",
  fingerprint,
});

console.log(`Verified offline: machine ${machine.id}, fingerprint ${machine.attributes.fingerprint}`);
