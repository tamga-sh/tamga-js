/**
 * Format v2: the expiry lives inside the signature.
 *
 * In v1 the `ttl` a caller asked for lived only in the JSON:API envelope around
 * the certificate, never inside the signed bytes. A 24-hour trial file was
 * therefore cryptographically valid forever: the client is the attacker, so any
 * check built on the envelope is bypassed by keeping — or redistributing — the
 * raw `certificate` string.
 */

import { describe, expect, it } from "vitest";

import { verifyAndDecryptLicenseFile, verifyLicenseFileWithClaims } from "../src/checkout/licenseFile.js";
import { deriveLicenseFileKey } from "../src/crypto/hkdf.js";
import {
  buildLicensePem,
  licensePayloadJsonExpiringAt,
  representativeLicensePayloadJson,
} from "./helpers/checkoutFixtures.js";
import { ed25519 } from "@noble/curves/ed25519";

const EXP = 1_767_229_200;

describe("signed expiry", () => {
  it("refuses an expired file even though its signature is valid", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(licensePayloadJsonExpiringAt(EXP), secretKey);

    await expect(
      verifyAndDecryptLicenseFile(pem, publicKey, undefined, EXP + 3600),
    ).rejects.toMatchObject({ kind: "expired" });
  });

  it("accepts a file still inside its ttl", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(licensePayloadJsonExpiringAt(EXP), secretKey);

    const { claims } = await verifyLicenseFileWithClaims(pem, publicKey, undefined, EXP - 3600);
    expect(claims.exp).toBe(EXP);
  });

  it("treats a file with no exp as perpetual, not as expired at the epoch", async () => {
    // Checkout without a `ttl` produces no `exp`.
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey);

    const { claims } = await verifyLicenseFileWithClaims(pem, publicKey, undefined, 2 ** 31 - 1);
    expect(claims.exp).toBeUndefined();
  });

  it("tolerates seconds of clock skew, not hours", async () => {
    // A generous allowance would just be a free extension on every expired
    // file, since the clock belongs to the attacker.
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(licensePayloadJsonExpiringAt(EXP), secretKey);

    await expect(
      verifyAndDecryptLicenseFile(pem, publicKey, undefined, EXP + 30),
    ).resolves.toBeDefined();
    await expect(
      verifyAndDecryptLicenseFile(pem, publicKey, undefined, EXP + 600),
    ).rejects.toMatchObject({ kind: "expired" });
  });

  it("exposes a replay id and a key id", async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const pem = await buildLicensePem(representativeLicensePayloadJson(), secretKey);

    const { claims } = await verifyLicenseFileWithClaims(pem, publicKey);
    expect(claims.jti).toBeTruthy();
    expect(claims.kid).toBeTruthy();
  });
});

describe("key derivation", () => {
  it("no longer leaks the license key into the AES key", async () => {
    // v1 zero-padded the license key, so the derived key literally contained
    // it in cleartext and everything past its length was zero — a stolen
    // `.lic` was a dictionary attack, not a 256-bit one.
    const key = deriveLicenseFileKey("SHORT-KEY");
    expect(key).toHaveLength(32);

    const naive = new Uint8Array(32);
    naive.set(new TextEncoder().encode("SHORT-KEY"));
    expect(Array.from(key)).not.toEqual(Array.from(naive));
    expect(key.slice(9).some((b) => b !== 0)).toBe(true);
  });

  it("is deterministic so a client can re-derive offline", () => {
    expect(Array.from(deriveLicenseFileKey("LK-1"))).toEqual(
      Array.from(deriveLicenseFileKey("LK-1")),
    );
    expect(Array.from(deriveLicenseFileKey("LK-1"))).not.toEqual(
      Array.from(deriveLicenseFileKey("LK-2")),
    );
  });
});
