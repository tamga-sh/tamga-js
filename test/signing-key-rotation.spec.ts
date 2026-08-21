/**
 * The defect this change exists to fix: an offline file signed **before** a
 * signing-key rotation must still verify, and must fail distinguishably when it
 * cannot.
 *
 * ⚠️ These files are built by this repository (`test/helpers/checkoutFixtures.ts`)
 * and are therefore **not** evidence of interop — see that file's header and
 * `test/fixtures/machine-file-v2/PROVENANCE.md`. They are used here for the
 * negative and structural space the server will not mint on demand: a file
 * naming a key nobody holds, and a file naming a key held by someone who did
 * not sign it. The wire-format claims they rest on are pinned elsewhere, by
 * server-minted certificates; the `kid` rule itself is pinned by independent
 * vectors in `test/signing-key-id.spec.ts`.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";

import { SigningKeySet } from "../src/checkout/keySet.js";
import { verifyLicenseFileWithKeySet } from "../src/checkout/licenseFile.js";
import { verifyMachineFileWithKeySet } from "../src/checkout/machineFile.js";
import { signingKeyId, UNBACKFILLED_ACCOUNT_KEY_ID } from "../src/crypto/keyId.js";
import { deriveLicenseFileKey, deriveHkdfKey, MACHINE_FILE_KEY_SALT } from "../src/crypto/hkdf.js";
import { CheckoutError, SigningKeyError } from "../src/errors.js";
import { base64Decode, base64Encode } from "../src/internal/base64.js";
import {
  buildLicensePem,
  buildEd25519MachinePemWithKey,
  licensePayloadJsonWithKid,
  machinePayloadJsonWithKid,
  licensePayloadJsonExpiringAt,
} from "./helpers/checkoutFixtures.js";

const ISSUED_AT = 1767225600;
const LICENSE_KEY = "TEST-KEY-0000-1111";
const FINGERPRINT = "fp-abc123";

/**
 * Rewrites a machine file's `alg` field in place, leaving the signature over
 * `enc` intact — `alg` is not covered by the signature, so this produces a file
 * the signature gate would happily pass.
 */
function rewriteAlg(pem: string, alg: string): string {
  const body = pem
    .replace("-----BEGIN MACHINE FILE-----", "")
    .replace("-----END MACHINE FILE-----", "")
    .trim();
  const cert = JSON.parse(new TextDecoder().decode(base64Decode(body))) as Record<string, unknown>;
  cert.alg = alg;
  const rebuilt = base64Encode(new TextEncoder().encode(JSON.stringify(cert)));
  return `-----BEGIN MACHINE FILE-----\n${rebuilt}\n-----END MACHINE FILE-----`;
}

/** A keypair plus the base64 public key and the `kid` the server would name it by. */
function signingKeypair(): { secretKey: Uint8Array; publicKeyB64: string; kid: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  const publicKeyB64 = base64Encode(publicKey);
  return { secretKey, publicKeyB64, kid: signingKeyId(publicKeyB64) };
}

describe("a license file signed before a key rotation still verifies", () => {
  it("verifies against the retired key its kid names, not the current one", async () => {
    const oldKey = signingKeypair();
    const newKey = signingKeypair();
    const pem = await buildLicensePem(licensePayloadJsonWithKid(oldKey.kid), oldKey.secretKey);

    // The account has rotated: the new key is active, the old one retired but
    // still published. Both are in the set.
    const keySet = SigningKeySet.fromPublicKeys([newKey.publicKeyB64, oldKey.publicKeyB64]);

    const verified = await verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT);

    expect(verified.claims.kid).toBe(oldKey.kid);
    expect(verified.license.id).toBe("01926b3e-0000-7000-8000-000000000000");
  });

  it("is exactly the case a single-key set gets wrong", async () => {
    // The regression this whole change is about, stated as a test: with only
    // the post-rotation key on hand, the authentic file is refused.
    const oldKey = signingKeypair();
    const newKey = signingKeypair();
    const pem = await buildLicensePem(licensePayloadJsonWithKid(oldKey.kid), oldKey.secretKey);

    const staleSet = SigningKeySet.fromPublicKeys([newKey.publicKeyB64]);

    await expect(verifyLicenseFileWithKeySet(pem, staleSet, undefined, ISSUED_AT)).rejects.toThrow(
      SigningKeyError,
    );
    // ...and adding the retired key is all it takes to fix it.
    const fullSet = SigningKeySet.fromPublicKeys([newKey.publicKeyB64, oldKey.publicKeyB64]);
    await expect(
      verifyLicenseFileWithKeySet(pem, fullSet, undefined, ISSUED_AT),
    ).resolves.toBeDefined();
  });

  it("verifies an encrypted file signed before the rotation", async () => {
    const oldKey = signingKeypair();
    const pem = await buildLicensePem(
      licensePayloadJsonWithKid(oldKey.kid),
      oldKey.secretKey,
      deriveLicenseFileKey(LICENSE_KEY),
    );
    const keySet = SigningKeySet.fromPublicKeys([signingKeypair().publicKeyB64, oldKey.publicKeyB64]);

    const verified = await verifyLicenseFileWithKeySet(pem, keySet, LICENSE_KEY, ISSUED_AT);

    expect(verified.claims.kid).toBe(oldKey.kid);
  });

  it("still enforces the signed exp claim", async () => {
    // Selecting the right key must not become a way round expiry.
    const key = signingKeypair();
    const payload = JSON.parse(licensePayloadJsonExpiringAt(ISSUED_AT - 3600)) as {
      meta: Record<string, unknown>;
    };
    payload.meta.kid = key.kid;
    const pem = await buildLicensePem(JSON.stringify(payload), key.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    await expect(verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      /expired/,
    );
  });
});

describe("an unknown kid is a different incident from a forged signature", () => {
  it("names a key nobody holds → SigningKeyError, not a crypto failure", async () => {
    const key = signingKeypair();
    const pem = await buildLicensePem(licensePayloadJsonWithKid("0f0f0f0f0f0f0f0f"), key.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    try {
      await verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT);
      expect.unreachable("an unknown kid must not verify");
    } catch (error) {
      expect(error).toBeInstanceOf(SigningKeyError);
      expect(error).not.toBeInstanceOf(CheckoutError);
      expect((error as SigningKeyError).kind).toBe("unknown-key-id");
      expect((error as SigningKeyError).keyId).toBe("0f0f0f0f0f0f0f0f");
    }
  });

  it("names a key the set holds, but a different key signed it → CheckoutError crypto", async () => {
    // A real forgery. The remedy is to refuse the file, and it must not be
    // reported as a stale key set.
    const trusted = signingKeypair();
    const attacker = signingKeypair();
    const pem = await buildLicensePem(
      licensePayloadJsonWithKid(trusted.kid),
      attacker.secretKey,
    );
    const keySet = SigningKeySet.fromPublicKeys([trusted.publicKeyB64]);

    try {
      await verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT);
      expect.unreachable("a forged signature must not verify");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutError);
      expect(error).not.toBeInstanceOf(SigningKeyError);
      expect((error as CheckoutError).kind).toBe("crypto");
    }
  });

  it("does not fall back to trying every key in the set", async () => {
    // Trying them all would verify this file — and would destroy the very
    // distinction above, which is the defect rather than the fix.
    const signer = signingKeypair();
    const other = signingKeypair();
    const pem = await buildLicensePem(licensePayloadJsonWithKid(other.kid), signer.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([other.publicKeyB64, signer.publicKeyB64]);

    // `signer`'s key IS in the set and DID sign the bytes; only the kid points
    // elsewhere. It must still fail.
    await expect(verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      CheckoutError,
    );
  });
});

describe("an account that never published a signing key", () => {
  it("is its own condition, not a generic unknown key", async () => {
    // `check_out_license.rs` signs with `unwrap_or_default()`, so every file
    // such an account issues names `SHA-256("")`. "Your key set is stale" and
    // "this server published no key at all" need different support responses:
    // the first is fixable client-side, the second is not.
    const key = signingKeypair();
    const pem = await buildLicensePem(
      licensePayloadJsonWithKid(UNBACKFILLED_ACCOUNT_KEY_ID),
      key.secretKey,
    );
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    try {
      await verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT);
      expect.unreachable("an empty-key file must not verify");
    } catch (error) {
      expect(error).toBeInstanceOf(SigningKeyError);
      expect((error as SigningKeyError).kind).toBe("no-published-signing-key");
      expect((error as SigningKeyError).keyId).toBe(UNBACKFILLED_ACCOUNT_KEY_ID);
      expect((error as SigningKeyError).message).toMatch(/no published Ed25519 public key/);
    }
  });

  it("yields to a set that genuinely holds that id", async () => {
    // The set is authoritative; the special case only refines a lookup that was
    // going to fail anyway, and never rejects a key the caller supplied.
    const key = signingKeypair();
    const pem = await buildLicensePem(
      licensePayloadJsonWithKid(UNBACKFILLED_ACCOUNT_KEY_ID),
      key.secretKey,
    );
    const keySet = SigningKeySet.fromResources([
      {
        id: UNBACKFILLED_ACCOUNT_KEY_ID,
        type: "signing-keys",
        attributes: {
          algorithm: "ed25519",
          publicKey: key.publicKeyB64,
          status: "active",
          created: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    await expect(
      verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT),
    ).resolves.toBeDefined();
  });
});

describe("a payload with no usable kid claim", () => {
  it("reports invalid JSON rather than selecting a key", async () => {
    const key = signingKeypair();
    const payload = JSON.parse(licensePayloadJsonWithKid("x")) as { meta: Record<string, unknown> };
    delete payload.meta.kid;
    const pem = await buildLicensePem(JSON.stringify(payload), key.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    await expect(verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      /no 'kid'/,
    );
  });

  it("rejects a non-string kid rather than coercing it", async () => {
    const key = signingKeypair();
    const payload = JSON.parse(licensePayloadJsonWithKid("x")) as { meta: Record<string, unknown> };
    payload.meta.kid = 12345;
    const pem = await buildLicensePem(JSON.stringify(payload), key.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    await expect(verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      CheckoutError,
    );
  });

  it("reports invalid JSON when the payload is not JSON at all", async () => {
    const key = signingKeypair();
    const pem = await buildLicensePem("this is not JSON", key.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    try {
      await verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT);
      expect.unreachable("a non-JSON payload must not verify");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutError);
      expect((error as CheckoutError).kind).toBe("invalid-json");
    }
  });

  it("rejects a payload that is valid JSON but not an object", async () => {
    // `typeof null === "object"` and so is an array, so a scalar, a null and an
    // array all have to be turned away before anything reads `meta.kid` off
    // them.
    const key = signingKeypair();
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    for (const payload of ["12345", '"a string"', "null", "[1,2,3]"]) {
      const pem = await buildLicensePem(payload, key.secretKey);
      try {
        await verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT);
        expect.unreachable(`payload ${payload} must not verify`);
      } catch (error) {
        expect(error).toBeInstanceOf(CheckoutError);
        expect((error as CheckoutError).kind).toBe("invalid-json");
      }
    }
  });

  it("rejects a pre-v2 payload with no signed meta at all", async () => {
    const key = signingKeypair();
    const pem = await buildLicensePem(JSON.stringify({ data: { id: "x" } }), key.secretKey);
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    await expect(verifyLicenseFileWithKeySet(pem, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      /pre-v2 file/,
    );
  });
});

describe("machine files through a key set", () => {
  it("verifies one signed before the rotation", async () => {
    const oldKey = signingKeypair();
    const newKey = signingKeypair();
    const pem = await buildEd25519MachinePemWithKey(
      machinePayloadJsonWithKid(oldKey.kid),
      oldKey.secretKey,
    );
    const keySet = SigningKeySet.fromPublicKeys([newKey.publicKeyB64, oldKey.publicKeyB64]);

    const verified = await verifyMachineFileWithKeySet(pem, keySet, undefined, ISSUED_AT);

    expect(verified.claims.kid).toBe(oldKey.kid);
    expect(verified.machine.attributes.fingerprint).toBe(FINGERPRINT);
  });

  it("handles the dot-separated encrypted enc", async () => {
    // The kid is inside the ciphertext, so both halves have to be decoded and
    // opened before a key can be selected at all.
    const key = signingKeypair();
    const encryptionKey = deriveHkdfKey(
      new TextEncoder().encode(LICENSE_KEY),
      MACHINE_FILE_KEY_SALT,
      new TextEncoder().encode(FINGERPRINT),
    );
    const pem = await buildEd25519MachinePemWithKey(
      machinePayloadJsonWithKid(key.kid),
      key.secretKey,
      encryptionKey,
    );
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    const verified = await verifyMachineFileWithKeySet(
      pem,
      keySet,
      { licenseKey: LICENSE_KEY, fingerprint: FINGERPRINT },
      ISSUED_AT,
    );

    expect(verified.claims.kid).toBe(key.kid);
  });

  it("keeps an unknown kid distinct from a forged signature", async () => {
    const trusted = signingKeypair();
    const attacker = signingKeypair();
    const keySet = SigningKeySet.fromPublicKeys([trusted.publicKeyB64]);

    const unknown = await buildEd25519MachinePemWithKey(
      machinePayloadJsonWithKid("0f0f0f0f0f0f0f0f"),
      trusted.secretKey,
    );
    await expect(verifyMachineFileWithKeySet(unknown, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      SigningKeyError,
    );

    const forged = await buildEd25519MachinePemWithKey(
      machinePayloadJsonWithKid(trusted.kid),
      attacker.secretKey,
    );
    await expect(verifyMachineFileWithKeySet(forged, keySet, undefined, ISSUED_AT)).rejects.toThrow(
      CheckoutError,
    );
  });

  it("refuses a non-Ed25519 file rather than matching a kid that cannot describe it", async () => {
    // Both checkout handlers compute the kid from the account's *Ed25519* key
    // whatever scheme actually signed the bytes, so on an RSA- or ECDSA-signed
    // file the claim names a key that did not sign it. Matching on it would be
    // worse than useless.
    const { buildMachinePem } = await import("./helpers/checkoutFixtures.js");
    const { pem } = await buildMachinePem("ECDSA_P256_SIGN", machinePayloadJsonWithKid("00"));
    const keySet = SigningKeySet.fromPublicKeys([signingKeypair().publicKeyB64]);

    try {
      await verifyMachineFileWithKeySet(pem, keySet, undefined, ISSUED_AT);
      expect.unreachable("a key set cannot verify an ECDSA machine file");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutError);
      expect((error as CheckoutError).kind).toBe("unsupported-algorithm");
      expect((error as CheckoutError).message).toMatch(/ecdsa-p256/);
    }
  });

  it("still rejects a v1 alg, before any key is selected", async () => {
    // `alg` is not covered by the signature, so this gate cannot lean on
    // signature validity — and the key-set path must not become a way round it.
    const key = signingKeypair();
    const pem = await buildEd25519MachinePemWithKey(
      machinePayloadJsonWithKid(key.kid),
      key.secretKey,
    );
    const keySet = SigningKeySet.fromPublicKeys([key.publicKeyB64]);

    for (const badAlg of ["base64+ed25519", "base64+ed25519+v2junk", "base64+ed25519+v3"]) {
      const downgraded = rewriteAlg(pem, badAlg);
      try {
        await verifyMachineFileWithKeySet(downgraded, keySet, undefined, ISSUED_AT);
        expect.unreachable(`alg "${badAlg}" must be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(CheckoutError);
        expect((error as CheckoutError).kind).toBe("unsupported-algorithm");
      }
    }
  });
});
