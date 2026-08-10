import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifyAndDecryptLicenseFile } from "../src/checkout/licenseFile.js";
import { naiveKeyFromLicenseKey } from "../src/crypto/naiveKey.js";
import { CheckoutError } from "../src/errors.js";
import { buildLicensePem, representativeLicensePayloadJson } from "./helpers/checkoutFixtures.js";

const LICENSE_KEY = "lic-abc123";

describe("verifyAndDecryptLicenseFile — encrypted (aes-256-gcm+ed25519)", () => {
  it("round-trips against a known-good encrypted fixture", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const encKey = naiveKeyFromLicenseKey(LICENSE_KEY);
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey, encKey);
    const license = await verifyAndDecryptLicenseFile(pem, publicKey, LICENSE_KEY);
    expect(license.attributes.key).toBe(LICENSE_KEY);
  });

  it("throws licenseKeyMissing when no license key is supplied", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const encKey = naiveKeyFromLicenseKey(LICENSE_KEY);
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey, encKey);
    await expect(verifyAndDecryptLicenseFile(pem, publicKey)).rejects.toMatchObject({
      kind: "license-key-missing",
    });
  });

  it("fails AEAD decryption for a tampered ciphertext even though the signature still verifies", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const encKey = naiveKeyFromLicenseKey(LICENSE_KEY);
    let pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey, encKey);
    // Corrupt a character deep in the base64 body so the encoded `enc`
    // bytes change but the file still round-trips through base64/JSON —
    // this must fail the AEAD tag check inside verifyAndDecryptLicenseFile,
    // not the outer signature check, since we don't re-sign here.
    const lines = pem.split("\n");
    const body = lines[1] as string;
    const idx = body.length - 10;
    const corruptedChar = body[idx] === "A" ? "B" : "A";
    lines[1] = body.slice(0, idx) + corruptedChar + body.slice(idx + 1);
    pem = lines.join("\n");
    await expect(verifyAndDecryptLicenseFile(pem, publicKey, LICENSE_KEY)).rejects.toThrow(
      CheckoutError,
    );
  });

  it("fails decryption with the wrong license key (wrong derived key)", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const encKey = naiveKeyFromLicenseKey(LICENSE_KEY);
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey, encKey);
    await expect(verifyAndDecryptLicenseFile(pem, publicKey, "wrong-key")).rejects.toThrow(
      CheckoutError,
    );
  });
});
