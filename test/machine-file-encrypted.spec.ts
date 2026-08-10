import { describe, expect, it } from "vitest";
import { verifyAndDecryptMachineFile } from "../src/checkout/machineFile.js";
import { deriveHkdfKey } from "../src/crypto/hkdf.js";
import { CheckoutError } from "../src/errors.js";
import { buildMachinePem, representativeMachinePayloadJson } from "./helpers/checkoutFixtures.js";

const LICENSE_KEY = "lic-abc123";
const FINGERPRINT = "fp-abc123";
const HKDF_SALT = new TextEncoder().encode("tamga:machine-file-key-v1");

function hkdfKeyFor(licenseKey: string, fingerprint: string): Uint8Array {
  const enc = new TextEncoder();
  return deriveHkdfKey(enc.encode(licenseKey), HKDF_SALT, enc.encode(fingerprint));
}

describe("verifyAndDecryptMachineFile — encrypted, HKDF key derivation", () => {
  it("decrypts with the correct license key and fingerprint", async () => {
    const key = hkdfKeyFor(LICENSE_KEY, FINGERPRINT);
    const { publicKey, pem } = await buildMachinePem(
      "ED25519_SIGN",
      representativeMachinePayloadJson(),
      key,
    );
    const machine = await verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, {
      licenseKey: LICENSE_KEY,
      fingerprint: FINGERPRINT,
    });
    expect(machine.attributes.fingerprint).toBe("fp-abc123");
  });

  it("fails cleanly with the wrong fingerprint (wrong derived key -> AEAD tag mismatch)", async () => {
    const key = hkdfKeyFor(LICENSE_KEY, FINGERPRINT);
    const { publicKey, pem } = await buildMachinePem(
      "ED25519_SIGN",
      representativeMachinePayloadJson(),
      key,
    );
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, {
        licenseKey: LICENSE_KEY,
        fingerprint: "wrong-fingerprint",
      }),
    ).rejects.toThrow(CheckoutError);
  });

  it("throws fingerprintMissing-style licenseKeyMissing when no key material is supplied", async () => {
    const key = hkdfKeyFor(LICENSE_KEY, FINGERPRINT);
    const { publicKey, pem } = await buildMachinePem(
      "ED25519_SIGN",
      representativeMachinePayloadJson(),
      key,
    );
    await expect(verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey)).rejects.toMatchObject({
      kind: "license-key-missing",
    });
  });

  it("rejects a file/scheme alg-suffix mismatch before attempting verification", async () => {
    // File genuinely signed+verifiable under Ed25519, but caller claims
    // RSA-PKCS1 — the alg-suffix cross-check must catch this before any RSA
    // verification is attempted.
    const { publicKey, pem } = await buildMachinePem("ED25519_SIGN", representativeMachinePayloadJson());
    await expect(
      verifyAndDecryptMachineFile(pem, "RSA_2048_PKCS1_SIGN", publicKey),
    ).rejects.toMatchObject({ kind: "unsupported-algorithm" });
  });
});
