/**
 * Machine offline proof (air-gapped verification).
 *
 * Ground-truthed against `tamga-rust`'s `src/proof.rs` (the reference
 * implementation for this SDK family) and the Tamga API protocol
 * specification §7.
 *
 * `POST /machines/{id}/actions/generate-offline-proof`, body
 * `{ "meta": { "dataset": {...} } }` (`dataset` defaults to `{}`). Always
 * signs with **RSA-2048 PKCS#1 v1.5 / SHA-256**, regardless of the
 * license's `scheme` — this module does NOT dispatch by scheme, unlike
 * `src/checkout/machineFile.ts`. Response: `meta.proof = "v1x0.<base64
 * signature>"`.
 *
 * ⚠️ Byte-exact serialization gotcha: the signature covers
 * `{"account":{"id":...},"machine":{"id":...,"fingerprint":...},"dataset":<dataset>}`,
 * but the actual wire bytes are alphabetically sorted at every nesting
 * level (`account`, `dataset`, `machine` — NOT the literal source order),
 * because the server serializes via Rust's `serde_json::json!` macro
 * without the `preserve_order` feature enabled. See
 * `src/internal/canonicalJson.ts`'s module doc comment for the full
 * explanation and ground-truth citation. `buildProofPayloadJson` below
 * builds the payload through that canonical serializer specifically so it
 * self-normalizes to the server's actual byte order regardless of the
 * object-literal order written here — do not "simplify" this to a plain
 * `JSON.stringify` call, and do not manually hardcode a field order.
 */

import { ProofError } from "./errors.js";
import { verifyRsaPkcs1 } from "./crypto/rsa.js";
import { base64Decode } from "./internal/base64.js";
import { canonicalJsonStringify } from "./internal/canonicalJson.js";

const PROOF_PREFIX = "v1x0.";

/** Builds the byte-exact JSON payload the server signs — see the module doc comment. */
function buildProofPayloadJson(
  accountId: string,
  machineId: string,
  fingerprint: string,
  dataset: Record<string, unknown>,
): string {
  return canonicalJsonStringify({
    account: { id: accountId },
    machine: { id: machineId, fingerprint },
    dataset,
  });
}

/** Splits the `v1x0.` version prefix from the base64 signature. */
export function parseProofToken(proof: string): { version: string; signature: Uint8Array } {
  if (!proof.startsWith(PROOF_PREFIX)) {
    throw ProofError.malformedProof();
  }
  const sigB64 = proof.slice(PROOF_PREFIX.length);
  let signature: Uint8Array;
  try {
    signature = base64Decode(sigB64);
  } catch {
    throw ProofError.invalidBase64();
  }
  return { version: PROOF_PREFIX.slice(0, -1), signature };
}

/**
 * Verifies a `"v1x0.<base64 signature>"` offline proof (from
 * `TamgaClient.generateOfflineProof`'s returned `proof` string) against the
 * exact `(accountId, machineId, fingerprint, dataset)` tuple it should have
 * been generated for. Always RSA-2048 PKCS#1 v1.5 / SHA-256, regardless of
 * the license's own `scheme`.
 *
 * Works fully offline once `rsaPublicKey` (SubjectPublicKeyInfo DER) is
 * embedded in the calling application. Returns `true`/`false` rather than
 * throwing on a verification failure — a malformed proof string (bad
 * prefix/base64) still throws {@link ProofError}, since that's a caller
 * usage error distinct from "the signature didn't verify."
 */
export async function verifyOfflineProof(
  proofToken: string,
  accountId: string,
  machineId: string,
  fingerprint: string,
  dataset: Record<string, unknown>,
  rsaPublicKey: Uint8Array,
): Promise<boolean> {
  const { signature } = parseProofToken(proofToken);
  const payloadJson = buildProofPayloadJson(accountId, machineId, fingerprint, dataset);
  return verifyRsaPkcs1(new TextEncoder().encode(payloadJson), signature, rsaPublicKey);
}
