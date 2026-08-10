/**
 * Test-only fixture builders for `.lic`/`.mach` checkout files, built to
 * exactly mirror the real wire format documented in `docs/sdk.md` §4/§6 and
 * ground-truthed against `tamga-rust`'s own test fixture builders
 * (`src/checkout/license_file.rs`/`machine_file.rs` `#[cfg(test)]` modules).
 *
 * Not part of the public API — used only by
 * `test/license-file-*.spec.ts`/`test/machine-file-*.spec.ts`.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { base64Encode } from "../../src/internal/base64.js";
import { encryptAesGcm } from "../../src/crypto/aesGcm.js";
import type { LicenseScheme } from "../../src/models/policy.js";

const enc = new TextEncoder();

export function representativeLicensePayloadJson(): string {
  return JSON.stringify({
    data: {
      type: "licenses",
      id: "01926b3e-0000-7000-8000-000000000000",
      attributes: {
        name: "Acme Corp",
        key: "lic-abc123",
        status: "ACTIVE",
        expiry: null,
        suspended: false,
        protected: false,
        uses: 0,
        scheme: null,
        encrypted: false,
        strict: false,
        floating: false,
        max_machines: null,
        max_uses: null,
        max_users: null,
        last_validated_at: null,
        last_check_in_at: null,
        last_check_out_at: null,
        machines_count: 0,
        metadata: {},
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
    },
  });
}

export function representativeMachinePayloadJson(): string {
  return JSON.stringify({
    data: {
      type: "machines",
      id: "01926b3e-2222-7000-8000-000000000000",
      attributes: {
        fingerprint: "fp-abc123",
        cores: 4,
        memory: null,
        disk: null,
        ip: null,
        hostname: "host1",
        platform: "linux",
        name: null,
        heartbeat_status: "NOT_STARTED",
        last_heartbeat_at: null,
        next_heartbeat_at: null,
        last_check_out_at: null,
        metadata: {},
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
    },
  });
}

/** Builds a `.lic` PEM the same way the real server does — see `src/checkout/licenseFile.ts`. */
export async function buildLicensePem(
  payloadJson: string,
  signingSecretKey: Uint8Array,
  encryptionKey?: Uint8Array,
): Promise<string> {
  let encValue: string;
  let alg: string;
  if (encryptionKey === undefined) {
    encValue = base64Encode(enc.encode(payloadJson));
    alg = "base64+ed25519";
  } else {
    const { nonce, ciphertextAndTag } = await encryptAesGcm(enc.encode(payloadJson), encryptionKey);
    const combined = new Uint8Array(nonce.length + ciphertextAndTag.length);
    combined.set(nonce, 0);
    combined.set(ciphertextAndTag, nonce.length);
    encValue = base64Encode(combined);
    alg = "aes-256-gcm+ed25519";
  }
  const sig = base64Encode(ed25519.sign(enc.encode(encValue), signingSecretKey));
  const certJson = JSON.stringify({ enc: encValue, sig, alg });
  const pemBody = base64Encode(enc.encode(certJson));
  return `-----BEGIN LICENSE FILE-----\n${pemBody}\n-----END LICENSE FILE-----`;
}

/** Signs `encValue`'s UTF-8 string bytes with the scheme-appropriate key, returning raw signature bytes. */
async function signForScheme(
  scheme: LicenseScheme,
  encValue: string,
): Promise<{ publicKey: Uint8Array; signature: Uint8Array }> {
  const message = enc.encode(encValue);
  switch (scheme) {
    case "ED25519_SIGN": {
      const { secretKey, publicKey } = ed25519.keygen();
      return { publicKey, signature: ed25519.sign(message, secretKey) };
    }
    case "RSA_2048_PKCS1_SIGN": {
      const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      );
      const signature = new Uint8Array(
        await globalThis.crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, message),
      );
      const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", keyPair.publicKey));
      return { publicKey, signature };
    }
    case "RSA_2048_PKCS1_PSS_SIGN": {
      const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      );
      const signature = new Uint8Array(
        await globalThis.crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, keyPair.privateKey, message),
      );
      const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", keyPair.publicKey));
      return { publicKey, signature };
    }
    case "ECDSA_P256_SIGN": {
      const { secretKey } = p256.keygen();
      const publicKey = p256.getPublicKey(secretKey, false);
      const signature = p256.sign(message, secretKey).toBytes("der");
      return { publicKey, signature };
    }
    case "RSA_2048_JWT_RS256":
      throw new Error("RSA_2048_JWT_RS256 fixtures are intentionally not supported — see machine-file-rejected-scheme.spec.ts");
  }
}

const SCHEME_ALG_SUFFIX: Record<LicenseScheme, string> = {
  ED25519_SIGN: "ed25519",
  RSA_2048_PKCS1_SIGN: "rsa-sha256",
  RSA_2048_PKCS1_PSS_SIGN: "rsa-pss-sha256",
  ECDSA_P256_SIGN: "ecdsa-p256",
  RSA_2048_JWT_RS256: "rsa-sha256",
};

/** Builds a `.mach` PEM for `scheme`, returning `{ publicKey, pem }`. */
export async function buildMachinePem(
  scheme: LicenseScheme,
  payloadJson: string,
  encryptionKey?: Uint8Array,
): Promise<{ publicKey: Uint8Array; pem: string }> {
  let encValue: string;
  let encPrefix: string;
  if (encryptionKey === undefined) {
    encValue = base64Encode(enc.encode(payloadJson));
    encPrefix = "base64";
  } else {
    const { nonce, ciphertextAndTag } = await encryptAesGcm(enc.encode(payloadJson), encryptionKey);
    const combined = new Uint8Array(nonce.length + ciphertextAndTag.length);
    combined.set(nonce, 0);
    combined.set(ciphertextAndTag, nonce.length);
    encValue = base64Encode(combined);
    encPrefix = "aes-256-gcm";
  }
  const { publicKey, signature } = await signForScheme(scheme, encValue);
  const sig = base64Encode(signature);
  const alg = `${encPrefix}+${SCHEME_ALG_SUFFIX[scheme]}`;
  const certJson = JSON.stringify({ enc: encValue, sig, alg });
  const pemBody = base64Encode(enc.encode(certJson));
  return { publicKey, pem: `-----BEGIN MACHINE FILE-----\n${pemBody}\n-----END MACHINE FILE-----` };
}
