import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/internal/canonicalJson.js";
import { verifyOfflineProof } from "../src/proof.js";
import { base64Encode } from "../src/internal/base64.js";

const enc = new TextEncoder();

async function generateRsaKeyPair() {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", keyPair.publicKey));
  return { keyPair, spki };
}

/**
 * ⚠️ Regression test pinning the byte-exact JSON field-order gotcha: the
 * server serializes the offline-proof payload with `serde_json::json!`,
 * whose `Map` is `BTreeMap`-backed (alphabetical), NOT the literal
 * `account, machine, dataset` source order. See
 * `src/internal/canonicalJson.ts`'s module doc comment.
 */
describe("offline proof payload field order — alphabetical, not source order", () => {
  it("top level is account, dataset, machine (alphabetical) — not account, machine, dataset", () => {
    const json = canonicalJsonStringify({
      account: { id: "00000000-0000-0000-0000-000000000000" },
      machine: { id: "00000000-0000-0000-0000-000000000000", fingerprint: "fp-abc" },
      dataset: { b: 1, a: 2 },
    });
    const accountPos = json.indexOf('"account"');
    const datasetPos = json.indexOf('"dataset"');
    const machinePos = json.indexOf('"machine"');
    expect(accountPos).toBeLessThan(datasetPos);
    expect(datasetPos).toBeLessThan(machinePos);
  });

  it("nested machine object is fingerprint before id (alphabetical) — not id before fingerprint", () => {
    const json = canonicalJsonStringify({
      account: { id: "x" },
      machine: { id: "m-id", fingerprint: "fp-abc" },
      dataset: {},
    });
    const machinePos = json.indexOf('"machine"');
    const fingerprintPos = json.indexOf('"fingerprint"');
    const idPosInMachine = json.indexOf('"id"', machinePos);
    expect(fingerprintPos).toBeLessThan(idPosInMachine);
  });

  it("nested dataset keys canonicalize alphabetically regardless of insertion order", () => {
    const json = canonicalJsonStringify({
      account: { id: "x" },
      machine: { id: "m", fingerprint: "fp" },
      dataset: { b: 1, a: 2 },
    });
    expect(json.indexOf('"a":2')).toBeLessThan(json.indexOf('"b":1'));
  });

  it("matches a known-good server-produced fixture byte-for-byte", () => {
    const accountId = "01926b3e-0000-7000-8000-000000000000";
    const machineId = "01926b3e-1111-7000-8000-000000000000";
    const json = canonicalJsonStringify({
      account: { id: accountId },
      machine: { id: machineId, fingerprint: "fp-abc" },
      dataset: { cores: 4 },
    });
    const expected = `{"account":{"id":"${accountId}"},"dataset":{"cores":4},"machine":{"fingerprint":"fp-abc","id":"${machineId}"}}`;
    expect(json).toBe(expected);
  });

  it("a signature computed over reordered (but semantically identical) JSON must NOT verify", async () => {
    const { keyPair, spki } = await generateRsaKeyPair();
    const accountId = "00000000-0000-0000-0000-000000000000";
    const machineId = "00000000-0000-0000-0000-000000000001";
    const fingerprint = "fp-abc";
    const dataset = { cores: 4 };

    const canonicalPayload = canonicalJsonStringify({
      account: { id: accountId },
      machine: { id: machineId, fingerprint },
      dataset,
    });
    // Hand-reorder to "account, machine, dataset" — the literal
    // source-code order, NOT the canonical alphabetical order.
    const reorderedPayload = `{"account":{"id":"${accountId}"},"machine":{"id":"${machineId}","fingerprint":"${fingerprint}"},"dataset":{"cores":4}}`;
    expect(reorderedPayload).not.toBe(canonicalPayload);

    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keyPair.privateKey,
        enc.encode(reorderedPayload),
      ),
    );
    const proof = `v1x0.${base64Encode(sig)}`;

    const result = await verifyOfflineProof(proof, accountId, machineId, fingerprint, dataset, spki);
    expect(result).toBe(false);
  });

  it("preserves a caller-supplied dataset key literally named __proto__ instead of silently dropping it", () => {
    // Regression test: a plain `{}` accumulator in canonicalize() would
    // route `result["__proto__"] = value` through Object.prototype's
    // legacy __proto__ setter instead of creating an own property,
    // silently vanishing the key/value from the JSON output entirely.
    // `JSON.parse` legitimately produces such an own property (per spec,
    // it bypasses the setter on the *source* side), so a dataset like
    // `JSON.parse('{"cores":4,"__proto__":{"evil":true}}')` is a realistic
    // input, not a contrived one.
    const dataset = JSON.parse('{"cores":4,"__proto__":{"evil":true}}') as Record<string, unknown>;
    expect(Object.keys(dataset)).toEqual(["cores", "__proto__"]);

    const json = canonicalJsonStringify({
      account: { id: "a" },
      machine: { id: "m", fingerprint: "fp" },
      dataset,
    });

    expect(json).toContain('"__proto__":{"evil":true}');
    expect(json).toContain('"cores":4');
  });

  it("a signature over a dataset with an extra __proto__ key must NOT verify against a dataset lacking it", async () => {
    // Proves the __proto__ fix actually affects the signed bytes, not just
    // the string output cosmetically: two semantically-different datasets
    // (one carrying a poisoned __proto__ key, one without) must produce
    // different canonical JSON and therefore must not cross-verify.
    const { keyPair, spki } = await generateRsaKeyPair();
    const accountId = "00000000-0000-0000-0000-000000000000";
    const machineId = "00000000-0000-0000-0000-000000000001";
    const fingerprint = "fp-abc";

    const poisonedDataset = JSON.parse(
      '{"cores":4,"__proto__":{"evil":true}}',
    ) as Record<string, unknown>;
    const payloadJson = canonicalJsonStringify({
      account: { id: accountId },
      machine: { id: machineId, fingerprint },
      dataset: poisonedDataset,
    });
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, enc.encode(payloadJson)),
    );
    const proof = `v1x0.${base64Encode(sig)}`;

    const plainDataset = { cores: 4 };
    const result = await verifyOfflineProof(proof, accountId, machineId, fingerprint, plainDataset, spki);
    expect(result).toBe(false);
  });
});
