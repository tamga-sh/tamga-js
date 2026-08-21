import { describe, expect, it } from "vitest";
import { verifyAndDecryptMachineFile } from "../src/checkout/machineFile.js";
import { deriveHkdfKey } from "../src/crypto/hkdf.js";
import { CheckoutError } from "../src/errors.js";
import {
  buildMachinePem,
  buildSignedMachinePemFromEnc,
  representativeMachinePayloadJson,
} from "./helpers/checkoutFixtures.js";

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

/**
 * Structural failures inside an already-authenticated encrypted payload.
 *
 * These have to be built here rather than taken from
 * `test/fixtures/machine-file-v2/`: the server cannot be asked to mint a
 * malformed certificate, and the fixture set ships no signing key, so a
 * hand-edited fixture would fail at the signature and never reach the code
 * under test. The signature on each file below is genuine.
 */
describe("verifyAndDecryptMachineFile — malformed encrypted payload", () => {
  const ALG = "aes-256-gcm+ed25519+v2";
  const KEY_MATERIAL = { licenseKey: LICENSE_KEY, fingerprint: FINGERPRINT };
  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

  it("refuses a payload with no . separator instead of slicing a nonce off the front", async () => {
    // The pre-fix reading of this format: one base64 blob, nonce = first 12
    // decoded bytes. A file shaped that way is not something the server emits.
    const oneBlob = b64(new Uint8Array(64));
    const { publicKey, pem } = await buildSignedMachinePemFromEnc("ED25519_SIGN", oneBlob, ALG);
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).rejects.toMatchObject({ kind: "crypto" });
  });

  it("refuses a nonce that is not 12 bytes", async () => {
    const enc = `${b64(new Uint8Array(11))}.${b64(new Uint8Array(32))}`;
    const { publicKey, pem } = await buildSignedMachinePemFromEnc("ED25519_SIGN", enc, ALG);
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).rejects.toMatchObject({ kind: "crypto" });
  });

  it("refuses a ciphertext too short to hold a GCM tag", async () => {
    const enc = `${b64(new Uint8Array(12))}.${b64(new Uint8Array(15))}`;
    const { publicKey, pem } = await buildSignedMachinePemFromEnc("ED25519_SIGN", enc, ALG);
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).rejects.toMatchObject({ kind: "crypto" });
  });

  it("reports invalid base64 when either half is not base64", async () => {
    const { publicKey, pem } = await buildSignedMachinePemFromEnc(
      "ED25519_SIGN",
      "not-base64!.also-not-base64!",
      ALG,
    );
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).rejects.toMatchObject({ kind: "invalid-base64" });
  });

  it("refuses an alg whose signing suffix is empty", async () => {
    const { publicKey, pem } = await buildSignedMachinePemFromEnc(
      "ED25519_SIGN",
      b64(new Uint8Array(32)),
      "base64++v2",
    );
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey),
    ).rejects.toMatchObject({ kind: "unsupported-algorithm" });
  });

  it("refuses an unknown encoding prefix before any crypto is attempted", async () => {
    const { publicKey, pem } = await buildSignedMachinePemFromEnc(
      "ED25519_SIGN",
      b64(new Uint8Array(32)),
      "rot13+ed25519+v2",
    );
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey),
    ).rejects.toMatchObject({ kind: "unsupported-algorithm" });
  });
});

describe("verifyAndDecryptMachineFile — enc separator handling", () => {
  const ALG = "aes-256-gcm+ed25519+v2";
  const KEY_MATERIAL = { licenseKey: LICENSE_KEY, fingerprint: FINGERPRINT };
  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

  it("refuses a second . separator instead of decoding past it", async () => {
    const enc = `${b64(new Uint8Array(12))}.${b64(new Uint8Array(32))}.${b64(new Uint8Array(8))}`;
    const { publicKey, pem } = await buildSignedMachinePemFromEnc("ED25519_SIGN", enc, ALG);
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).rejects.toMatchObject({ kind: "invalid-base64" });
  });

  it("refuses junk characters inside either half", async () => {
    const enc = `${b64(new Uint8Array(12))}.${b64(new Uint8Array(32))}!!`;
    const { publicKey, pem } = await buildSignedMachinePemFromEnc("ED25519_SIGN", enc, ALG);
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).rejects.toMatchObject({ kind: "invalid-base64" });
  });

  it("round-trips the real layout, proving the halves are decoded independently", async () => {
    // The positive control for the two refusals above: same builder, same
    // scheme, correct `"<nonce_b64>.<cipher_b64>"` shape.
    const key = hkdfKeyFor(LICENSE_KEY, FINGERPRINT);
    const { publicKey, pem } = await buildMachinePem(
      "ED25519_SIGN",
      representativeMachinePayloadJson(),
      key,
    );
    const cert = JSON.parse(
      Buffer.from(
        pem.trim().split("\n")[1] as string,
        "base64",
      ).toString("utf8"),
    ) as { enc: string };
    expect(cert.enc.split(".")).toHaveLength(2);
    await expect(
      verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey, KEY_MATERIAL),
    ).resolves.toBeDefined();
  });
});
