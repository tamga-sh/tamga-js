/**
 * Node example: generate and verify a machine offline proof token.
 *
 * A lighter-weight alternative to a full `.mach` checkout for periodic
 * "prove this machine is still valid" pings in air-gapped environments —
 * always RSA-2048 PKCS#1 v1.5 / SHA-256, regardless of the license's own
 * `scheme`.
 *
 * ⚠️ `generateOfflineProof` is role-gated server-side and always answers
 * `403` for a license-key credential, so the minting half of this example
 * needs an account-level token (bearer/product/environment). Verification is
 * the half a shipped client runs: `verifyOfflineProof` needs no credential at
 * all. In production, mint the proof in your backend and hand it to the
 * client.
 */
import { TamgaClient, verifyOfflineProof } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const machineId = process.env.TAMGA_MACHINE_ID ?? "00000000-0000-0000-0000-000000000000";
const fingerprint = process.env.TAMGA_MACHINE_FINGERPRINT ?? "fp-abc123";

// dataset defaults to {} if omitted — must be a JSON object (a
// non-object value fails server-side with 422 DATASET_INVALID).
const dataset = { checkedAt: new Date().toISOString() };

const { machine, proof } = await client.generateOfflineProof(machineId, dataset);
console.log(`Got proof token for machine ${machine.id}: ${proof}`);

// Verification is fully offline — embed your account's RSA public key
// (SubjectPublicKeyInfo DER) in the shipped application.
const rsaPublicKey = new Uint8Array(
  Buffer.from(process.env.TAMGA_RSA_PUBLIC_KEY_BASE64 ?? "", "base64"),
);

const valid = await verifyOfflineProof(
  proof,
  process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  machine.id,
  fingerprint,
  dataset,
  rsaPublicKey,
);

console.log(valid ? "Proof verified offline." : "Proof verification FAILED.");
