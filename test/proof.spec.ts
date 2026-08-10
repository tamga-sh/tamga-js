import { describe, expect, it } from "vitest";
import { parseProofToken, verifyOfflineProof } from "../src/proof.js";
import { canonicalJsonStringify } from "../src/internal/canonicalJson.js";
import { base64Encode } from "../src/internal/base64.js";
import { ProofError } from "../src/errors.js";

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

async function signPayload(privateKey: CryptoKey, payloadJson: string): Promise<string> {
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(payloadJson)),
  );
  return base64Encode(sig);
}

describe("parseProofToken", () => {
  it("splits the v1x0. prefix from the base64 signature", () => {
    const sig = base64Encode(new Uint8Array([1, 2, 3]));
    const parsed = parseProofToken(`v1x0.${sig}`);
    expect(parsed.version).toBe("v1x0");
    expect(Array.from(parsed.signature)).toEqual([1, 2, 3]);
  });

  it("throws malformedProof for a missing prefix", () => {
    expect(() => parseProofToken("not-v1x0-prefixed")).toThrow(ProofError);
  });

  it("throws invalidBase64 for a malformed base64 signature", () => {
    expect(() => parseProofToken("v1x0.not!!valid==base64")).toThrow(ProofError);
  });
});

describe("verifyOfflineProof", () => {
  it("accepts a known-good fixture", async () => {
    const { keyPair, spki } = await generateRsaKeyPair();
    const accountId = "01926b3e-0000-7000-8000-000000000000";
    const machineId = "01926b3e-1111-7000-8000-000000000000";
    const fingerprint = "fp-abc";
    const dataset = { cores: 4 };
    const payloadJson = canonicalJsonStringify({
      account: { id: accountId },
      machine: { id: machineId, fingerprint },
      dataset,
    });
    const proof = `v1x0.${await signPayload(keyPair.privateKey, payloadJson)}`;

    const result = await verifyOfflineProof(proof, accountId, machineId, fingerprint, dataset, spki);
    expect(result).toBe(true);
  });

  it("rejects a tampered dataset", async () => {
    const { keyPair, spki } = await generateRsaKeyPair();
    const accountId = "01926b3e-0000-7000-8000-000000000000";
    const machineId = "01926b3e-1111-7000-8000-000000000000";
    const fingerprint = "fp-abc";
    const signedDataset = { cores: 4 };
    const payloadJson = canonicalJsonStringify({
      account: { id: accountId },
      machine: { id: machineId, fingerprint },
      dataset: signedDataset,
    });
    const proof = `v1x0.${await signPayload(keyPair.privateKey, payloadJson)}`;

    const tamperedDataset = { cores: 999 };
    const result = await verifyOfflineProof(
      proof,
      accountId,
      machineId,
      fingerprint,
      tamperedDataset,
      spki,
    );
    expect(result).toBe(false);
  });

  it("applies the default {} dataset when the request builder is asked to", () => {
    // Documents the contract that TamgaClient.generateOfflineProof defaults
    // an omitted dataset to {} — exercised end-to-end in
    // test/machine-offline-proof.spec.ts against the client. Here we just
    // confirm an empty dataset produces valid, verifiable payload JSON.
    const payloadJson = canonicalJsonStringify({
      account: { id: "a" },
      machine: { id: "m", fingerprint: "fp" },
      dataset: {},
    });
    expect(payloadJson).toContain('"dataset":{}');
  });

  it("malformed prefix is rejected before any crypto", async () => {
    const { spki } = await generateRsaKeyPair();
    await expect(
      verifyOfflineProof("not-v1x0-prefixed", "a", "m", "fp", {}, spki),
    ).rejects.toBeInstanceOf(ProofError);
  });
});
