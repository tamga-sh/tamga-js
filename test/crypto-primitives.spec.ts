import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { verifyEd25519 } from "../src/crypto/ed25519.js";
import { verifyEcdsaP256 } from "../src/crypto/ecdsa.js";
import { verifyRsaPkcs1, verifyRsaPss } from "../src/crypto/rsa.js";
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

describe("verifyEcdsaP256", () => {
  it("accepts a valid DER signature", () => {
    const { secretKey } = p256.keygen();
    const publicKey = uncompressedPublicKey(secretKey);
    const message = enc.encode("data");
    const signature = p256.sign(message, secretKey).toBytes("der");
    expect(verifyEcdsaP256(message, signature, publicKey)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const { secretKey } = p256.keygen();
    const publicKey = uncompressedPublicKey(secretKey);
    const message = enc.encode("data");
    const signature = p256.sign(message, secretKey).toBytes("der");
    const lastIndex = signature.length - 1;
    signature[lastIndex] = (signature[lastIndex] ?? 0) ^ 0xff;
    expect(verifyEcdsaP256(message, signature, publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = p256.keygen();
    const b = p256.keygen();
    const publicKeyA = uncompressedPublicKey(a.secretKey);
    const message = enc.encode("data");
    const signature = p256.sign(message, b.secretKey).toBytes("der");
    expect(verifyEcdsaP256(message, signature, publicKeyA)).toBe(false);
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
