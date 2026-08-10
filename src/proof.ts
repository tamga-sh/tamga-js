/**
 * Machine offline proof (air-gapped verification).
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Section H (⚠️ security-reviewer review MANDATORY before this file ships
 * real logic).
 *
 * `POST /machines/{id}/actions/generate-offline-proof`, body
 * `{ "meta": { "dataset": {...} } }` (`dataset` defaults to `{}`). Always
 * signs with **RSA-2048 PKCS#1 v1.5 / SHA-256**, regardless of the
 * license's `scheme` — do NOT dispatch by scheme here, unlike
 * `src/checkout/machineFile.ts`. Response: `meta.proof = "v1x0.<base64
 * signature>"`.
 *
 * ⚠️ The signature covers
 * `{"account":{"id":...},"machine":{"id":...,"fingerprint":...},"dataset":<dataset>}`
 * serialized EXACTLY as the server produces it — field order matters. A
 * verifier reproducing the same field set in a different order will fail
 * signature verification even though the content is identical
 * (docs/sdk.md §7).
 */

/** TODO: split the `v1x0.` version prefix from the base64 signature. */
export function parseProofToken(_proof: string): { version: string; signature: Uint8Array } {
  throw new Error("parseProofToken: not implemented — see docs/plans/tamga-js.plan.md Section H");
}

/**
 * TODO: rebuild the exact byte-for-byte JSON payload
 * (`{"account":{"id":...},"machine":{"id":...,"fingerprint":...},"dataset":...}`)
 * and RSA-PKCS1v15/SHA-256-verify it against the `v1x0.` proof token, reusing
 * `verifyRsaPkcs1` from `src/crypto/rsa.ts`.
 */
export function verifyOfflineProof(
  _proofToken: string,
  _accountId: string,
  _machineId: string,
  _fingerprint: string,
  _dataset: Record<string, unknown>,
  _publicKey: Uint8Array,
): boolean {
  throw new Error(
    "verifyOfflineProof: not implemented — see docs/plans/tamga-js.plan.md Section H",
  );
}
