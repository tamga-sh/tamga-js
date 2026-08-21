import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { verifyEd25519 } from "../src/crypto/ed25519.js";
import { verifyEcdsaP256 } from "../src/crypto/ecdsa.js";
import { toRsaSpki, verifyRsaPkcs1, verifyRsaPss } from "../src/crypto/rsa.js";
import { getWebCrypto } from "../src/internal/webcrypto.js";

const enc = new TextEncoder();

describe("verifyEd25519", () => {
  it("accepts a valid signature", () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const message = enc.encode("the base64 enc string bytes");
    const signature = ed25519.sign(message, secretKey);
    expect(verifyEd25519(message, signature, publicKey)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const signature = ed25519.sign(enc.encode("original"), secretKey);
    expect(verifyEd25519(enc.encode("tampered!"), signature, publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = ed25519.keygen();
    const b = ed25519.keygen();
    const message = enc.encode("data");
    const signature = ed25519.sign(message, b.secretKey);
    expect(verifyEd25519(message, signature, a.publicKey)).toBe(false);
  });

  it("rejects malformed signature/key lengths without throwing", () => {
    expect(verifyEd25519(enc.encode("data"), enc.encode("too-short"), new Uint8Array(32))).toBe(
      false,
    );
    expect(verifyEd25519(enc.encode("data"), new Uint8Array(64), new Uint8Array(5))).toBe(false);
  });
});

/** Uncompressed (65-byte, `0x04 ‖ X ‖ Y`) public key — matches aws-lc-rs's convention. */
function uncompressedPublicKey(secretKey: Uint8Array): Uint8Array {
  return p256.getPublicKey(secretKey, false);
}

/**
 * Signs the way the server does: `@noble/curves` takes a message DIGEST, so the
 * SHA-256 has to be applied here, exactly as `ECDSA_P256_SHA256_ASN1` does
 * server-side. Signing the raw message instead round-trips against a verifier
 * that also skips the hash and matches nothing the server emits — the mistake
 * this suite used to make on both sides at once.
 */
function signEcdsaLikeTheServer(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return p256.sign(sha256(message), secretKey).toBytes("der");
}

describe("verifyEcdsaP256", () => {
  it("accepts a valid DER signature over the SHA-256 digest", () => {
    const { secretKey } = p256.keygen();
    const publicKey = uncompressedPublicKey(secretKey);
    const message = enc.encode("data");
    expect(verifyEcdsaP256(message, signEcdsaLikeTheServer(message, secretKey), publicKey)).toBe(
      true,
    );
  });

  it("rejects a signature taken over the unhashed message", () => {
    // Regression guard for the defect this module shipped with: noble's
    // `verify` accepts any byte string as a "digest" and silently truncates it,
    // so an unhashed signature verified fine against an unhashed verifier.
    const { secretKey } = p256.keygen();
    const publicKey = uncompressedPublicKey(secretKey);
    const message = enc.encode("data");
    const unhashed = p256.sign(message, secretKey).toBytes("der");
    expect(verifyEcdsaP256(message, unhashed, publicKey)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const { secretKey } = p256.keygen();
    const publicKey = uncompressedPublicKey(secretKey);
    const message = enc.encode("data");
    const signature = signEcdsaLikeTheServer(message, secretKey);
    const lastIndex = signature.length - 1;
    signature[lastIndex] = (signature[lastIndex] ?? 0) ^ 0xff;
    expect(verifyEcdsaP256(message, signature, publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = p256.keygen();
    const b = p256.keygen();
    const publicKeyA = uncompressedPublicKey(a.secretKey);
    const message = enc.encode("data");
    expect(verifyEcdsaP256(message, signEcdsaLikeTheServer(message, b.secretKey), publicKeyA)).toBe(
      false,
    );
  });
});

/** Generates an RSA-2048 keypair and returns SPKI DER public key + CryptoKeyPair. */
async function generateRsaKeyPair(usage: "RSASSA-PKCS1-v1_5" | "RSA-PSS") {
  const webcrypto = await getWebCrypto();
  const keyPair = await webcrypto.subtle.generateKey(
    { name: usage, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", keyPair.publicKey));
  return { keyPair, spki };
}

describe("verifyRsaPkcs1", () => {
  it("accepts a valid signature", async () => {
    const webcrypto = await getWebCrypto();
    const { keyPair, spki } = await generateRsaKeyPair("RSASSA-PKCS1-v1_5");
    const message = enc.encode("data");
    const signature = new Uint8Array(
      await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, message),
    );
    await expect(verifyRsaPkcs1(message, signature, spki)).resolves.toBe(true);
  });

  it("rejects a tampered message", async () => {
    const webcrypto = await getWebCrypto();
    const { keyPair, spki } = await generateRsaKeyPair("RSASSA-PKCS1-v1_5");
    const signature = new Uint8Array(
      await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, enc.encode("original")),
    );
    await expect(verifyRsaPkcs1(enc.encode("tampered"), signature, spki)).resolves.toBe(false);
  });
});

describe("verifyRsaPss", () => {
  it("accepts a valid signature", async () => {
    const webcrypto = await getWebCrypto();
    const { keyPair, spki } = await generateRsaKeyPair("RSA-PSS");
    const message = enc.encode("data");
    const signature = new Uint8Array(
      await webcrypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, keyPair.privateKey, message),
    );
    await expect(verifyRsaPss(message, signature, spki)).resolves.toBe(true);
  });

  it("rejects a tampered message", async () => {
    const webcrypto = await getWebCrypto();
    const { keyPair, spki } = await generateRsaKeyPair("RSA-PSS");
    const signature = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "RSA-PSS", saltLength: 32 },
        keyPair.privateKey,
        enc.encode("original"),
      ),
    );
    await expect(verifyRsaPss(enc.encode("tampered"), signature, spki)).resolves.toBe(false);
  });

  it("a PKCS1 signature does not verify as PSS (cross-scheme confusion check)", async () => {
    const webcrypto = await getWebCrypto();
    const { keyPair, spki } = await generateRsaKeyPair("RSASSA-PKCS1-v1_5");
    const message = enc.encode("data");
    const signature = new Uint8Array(
      await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, message),
    );
    await expect(verifyRsaPss(message, signature, spki)).resolves.toBe(false);
  });
});

describe("toRsaSpki — the API publishes PKCS#1, WebCrypto imports SPKI", () => {
  /**
   * Strips an SPKI down to the PKCS#1 `RSAPublicKey` it wraps — the encoding
   * the Tamga API publishes.
   *
   * RSA-2048 SPKI has fixed offsets: `30 82 xx xx` outer header (4), the
   * 15-byte rsaEncryption `AlgorithmIdentifier`, `03 82 xx xx` BIT STRING
   * header (4), then one "unused bits" byte, then the RSAPublicKey.
   */
  function spkiToPkcs1(spki: Uint8Array): Uint8Array {
    const OUTER_HEADER = 4;
    const ALGORITHM_IDENTIFIER = 15;
    const BIT_STRING_HEADER = 4;
    const UNUSED_BITS_BYTE = 1;
    return spki.subarray(
      OUTER_HEADER + ALGORITHM_IDENTIFIER + BIT_STRING_HEADER + UNUSED_BITS_BYTE,
    );
  }

  it("verifies a signature against the PKCS#1 form of the same key", async () => {
    const { spki, keyPair } = await generateRsaKeyPair("RSASSA-PKCS1-v1_5");
    const message = enc.encode("data");
    const webcrypto = await getWebCrypto();
    const signature = new Uint8Array(
      await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, message),
    );

    const pkcs1 = spkiToPkcs1(spki);
    expect(pkcs1[0]).toBe(0x30);
    expect(pkcs1.length).toBeLessThan(spki.length);

    // Both encodings of one key must reach the same verdict.
    expect(await verifyRsaPkcs1(message, signature, spki)).toBe(true);
    expect(await verifyRsaPkcs1(message, signature, pkcs1)).toBe(true);
  });

  it("re-encodes a PKCS#1 key and leaves an SPKI alone", async () => {
    const { spki } = await generateRsaKeyPair("RSASSA-PKCS1-v1_5");
    const pkcs1 = spkiToPkcs1(spki);
    expect(Array.from(toRsaSpki(pkcs1))).toEqual(Array.from(spki));
    expect(Array.from(toRsaSpki(spki))).toEqual(Array.from(spki));
  });

  it("passes malformed input through untouched, for importKey to reject", () => {
    // No DER parsing beyond one tag byte, and every read is bounds-checked, so
    // a short or nonsense blob must not throw here.
    for (const junk of [
      new Uint8Array(),
      Uint8Array.from([0x30]),
      Uint8Array.from([0x30, 0x82]),
      Uint8Array.from([0x30, 0x03, 0x05, 0x00, 0x00]),
      Uint8Array.from([0x02, 0x01, 0x00]),
    ]) {
      expect(Array.from(toRsaSpki(junk))).toEqual(Array.from(junk));
    }
  });
});
