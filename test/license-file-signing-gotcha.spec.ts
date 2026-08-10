import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifyEd25519 } from "../src/crypto/ed25519.js";
import { verifyAndDecryptLicenseFile } from "../src/checkout/licenseFile.js";
import { base64Encode, base64Decode } from "../src/internal/base64.js";
import { representativeLicensePayloadJson } from "./helpers/checkoutFixtures.js";

/**
 * ⚠️ Regression test pinning the single highest-risk interop bug in a
 * from-scratch reimplementation of the `.lic`/`.mach` format: the
 * signature covers `enc`'s base64 **string** bytes, never its decoded
 * bytes. See `src/checkout/licenseFile.ts`'s module doc comment.
 */
describe("license file signing gotcha — string bytes, not decoded bytes", () => {
  it("a signature computed over enc's DECODED bytes does not verify against enc's STRING bytes", () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const payload = representativeLicensePayloadJson();
    const encString = base64Encode(new TextEncoder().encode(payload));
    const decodedEncBytes = base64Decode(encString);

    // Sign over the DECODED bytes — the wrong way to do it.
    const wrongSignature = ed25519.sign(decodedEncBytes, secretKey);

    // verifyEd25519 (used by verifyAndDecryptLicenseFile) always verifies
    // against the base64 STRING bytes, so this signature must NOT verify.
    const stringBytes = new TextEncoder().encode(encString);
    expect(verifyEd25519(stringBytes, wrongSignature, publicKey)).toBe(false);
  });

  it("verifyAndDecryptLicenseFile rejects a full .lic file signed over decoded bytes instead of the base64 string", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const payload = representativeLicensePayloadJson();
    const encString = base64Encode(new TextEncoder().encode(payload));
    const decodedEncBytes = base64Decode(encString);

    // Build a PEM the WRONG way: sign over decoded bytes.
    const wrongSignature = ed25519.sign(decodedEncBytes, secretKey);
    const certJson = JSON.stringify({
      enc: encString,
      sig: base64Encode(wrongSignature),
      alg: "base64+ed25519",
    });
    const pemBody = base64Encode(new TextEncoder().encode(certJson));
    const pem = `-----BEGIN LICENSE FILE-----\n${pemBody}\n-----END LICENSE FILE-----`;

    await expect(verifyAndDecryptLicenseFile(pem, publicKey)).rejects.toThrow();
  });

  it("verifyAndDecryptLicenseFile accepts the same payload signed correctly over the base64 STRING bytes", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const payload = representativeLicensePayloadJson();
    const encString = base64Encode(new TextEncoder().encode(payload));

    const correctSignature = ed25519.sign(new TextEncoder().encode(encString), secretKey);
    const certJson = JSON.stringify({
      enc: encString,
      sig: base64Encode(correctSignature),
      alg: "base64+ed25519",
    });
    const pemBody = base64Encode(new TextEncoder().encode(certJson));
    const pem = `-----BEGIN LICENSE FILE-----\n${pemBody}\n-----END LICENSE FILE-----`;

    const license = await verifyAndDecryptLicenseFile(pem, publicKey);
    expect(license.attributes.key).toBe("lic-abc123");
  });
});
