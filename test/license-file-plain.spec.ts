import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifyAndDecryptLicenseFile } from "../src/checkout/licenseFile.js";
import { CheckoutError } from "../src/errors.js";
import { buildLicensePem, representativeLicensePayloadJson } from "./helpers/checkoutFixtures.js";

describe("verifyAndDecryptLicenseFile — plain (base64+ed25519)", () => {
  it("round-trips against a known-good plain fixture", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey);
    const license = await verifyAndDecryptLicenseFile(pem, publicKey);
    expect(license.attributes.key).toBe("lic-abc123");
    expect(license.id).toBe("01926b3e-0000-7000-8000-000000000000");
  });

  it("fails if the signature is tampered", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    let pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey);
    // Flip a character inside the base64 PEM body — corrupts the encoded
    // `sig` field without breaking base64/JSON parsing.
    const lines = pem.split("\n");
    const bodyLine = 1;
    const mid = Math.floor((lines[bodyLine] as string).length / 2);
    const body = lines[bodyLine] as string;
    const corruptedChar = body[mid] === "A" ? "B" : "A";
    lines[bodyLine] = body.slice(0, mid) + corruptedChar + body.slice(mid + 1);
    pem = lines.join("\n");
    await expect(verifyAndDecryptLicenseFile(pem, publicKey)).rejects.toThrow(CheckoutError);
  });

  it("fails against the wrong public key", async () => {
    const { secretKey } = ed25519.keygen();
    const { publicKey: wrongKey } = ed25519.keygen();
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey);
    await expect(verifyAndDecryptLicenseFile(pem, wrongKey)).rejects.toThrow(CheckoutError);
  });

  it("rejects a malformed PEM envelope", async () => {
    const { publicKey } = ed25519.keygen();
    await expect(verifyAndDecryptLicenseFile("not a pem", publicKey)).rejects.toThrow(CheckoutError);
  });

  it("rejects an unsupported alg value", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey);
    // Re-sign with a bogus alg to prove the dispatcher rejects it rather
    // than silently falling through to the plain path.
    const body = pem.split("\n")[1] as string;
    const certJson = JSON.parse(new TextDecoder().decode(Buffer.from(body, "base64")));
    certJson.alg = "rot13+ed25519";
    const newBody = Buffer.from(JSON.stringify(certJson)).toString("base64");
    const tampered = `-----BEGIN LICENSE FILE-----\n${newBody}\n-----END LICENSE FILE-----`;
    // Signature no longer matches after alg tamper attempt does NOT change
    // `enc`, so signature verification still passes — the alg check must
    // reject afterward.
    await expect(verifyAndDecryptLicenseFile(tampered, publicKey)).rejects.toThrow(CheckoutError);
  });
});
