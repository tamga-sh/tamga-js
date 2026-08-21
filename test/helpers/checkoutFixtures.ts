/**
 * Test-only fixture builders for `.lic`/`.mach` checkout files.
 *
 * ⚠️ **SELF-GENERATED — NOT GROUND TRUTH.** Everything here is built by this
 * repository, so it can only ever encode this repository's *belief* about the
 * wire format. When that belief was wrong, these builders reproduced the error
 * on the signing side and the suite stayed green over a verifier that could not
 * open a single certificate the server had ever emitted. That is not a
 * hypothetical: this file previously wrote `alg` without its mandatory `+v2`
 * marker, concatenated an encrypted payload as `nonce‖ciphertext‖tag` instead
 * of `"{nonce_b64}.{cipher_b64}"`, and signed ECDSA over the unhashed message —
 * three defects, mirrored on both sides, invisible to CI.
 *
 * **The ground truth is `test/fixtures/machine-file-v2/`** — certificates
 * produced by the server's own `encode_machine_file`, exercised by
 * `test/machine-file-server-fixtures.spec.ts`. Anything asserting that this SDK
 * can read what the server writes belongs there, not here.
 *
 * What remains legitimate here is the negative and structural space the server
 * will not mint for you: a scheme it refuses outright, a caller/file mismatch,
 * a key the file was not signed with. The builders below were corrected against
 * the server source so those cases start from a *valid* file, but they are
 * still not evidence of interop.
 *
 * Not part of the public API — used only by
 * `test/license-file-*.spec.ts`/`test/machine-file-*.spec.ts`.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { base64Encode } from "../../src/internal/base64.js";
import { getWebCrypto } from "../../src/internal/webcrypto.js";
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
    // Format v2 puts the claims inside the signed bytes. A payload without
    // them is a v1 file and no longer verifies.
    meta: { iat: 1767225600, jti: "test-jti", kid: "test-kid" },
  });
}

/** The same payload with an `exp` claim, for the expiry tests. */
export function licensePayloadJsonExpiringAt(exp: number): string {
  const parsed = JSON.parse(representativeLicensePayloadJson()) as {
    meta: Record<string, unknown>;
  };
  parsed.meta.exp = exp;
  return JSON.stringify(parsed);
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
    // Format v2 puts the claims inside the signed bytes. A payload without
    // them is a v1 file and no longer verifies.
    meta: { iat: 1767225600, jti: "test-jti", kid: "test-kid" },
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
    alg = "base64+ed25519+v2";
  } else {
    const { nonce, ciphertextAndTag } = await encryptAesGcm(enc.encode(payloadJson), encryptionKey);
    const combined = new Uint8Array(nonce.length + ciphertextAndTag.length);
    combined.set(nonce, 0);
    combined.set(ciphertextAndTag, nonce.length);
    encValue = base64Encode(combined);
    alg = "aes-256-gcm+ed25519+v2";
  }
  const sig = base64Encode(ed25519.sign(enc.encode(encValue), signingSecretKey));
  const certJson = JSON.stringify({ enc: encValue, sig, alg });
  const pemBody = base64Encode(enc.encode(certJson));
  return `-----BEGIN LICENSE FILE-----\n${pemBody}\n-----END LICENSE FILE-----`;
}

/**
 * Wraps an arbitrary, caller-supplied `enc` string into a correctly **signed**
 * machine file.
 *
 * For the structural failures the server will never mint: an encrypted payload
 * with no `.` separator, a wrong-length nonce, a truncated ciphertext. The
 * signature is genuine, so these reach the parsing that follows verification
 * instead of being turned away at the signature.
 */
export async function buildSignedMachinePemFromEnc(
  scheme: LicenseScheme,
  encValue: string,
  alg: string,
): Promise<{ publicKey: Uint8Array; pem: string }> {
  const { publicKey, signature } = await signForScheme(scheme, encValue);
  const certJson = JSON.stringify({ enc: encValue, sig: base64Encode(signature), alg });
  const pemBody = base64Encode(enc.encode(certJson));
  return { publicKey, pem: `-----BEGIN MACHINE FILE-----\n${pemBody}\n-----END MACHINE FILE-----` };
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
      const webcrypto = await getWebCrypto();
      const keyPair = await webcrypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      );
      const signature = new Uint8Array(
        await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, message),
      );
      const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("spki", keyPair.publicKey));
      return { publicKey, signature };
    }
    case "RSA_2048_PKCS1_PSS_SIGN": {
      const webcrypto = await getWebCrypto();
      const keyPair = await webcrypto.subtle.generateKey(
        { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      );
      const signature = new Uint8Array(
        await webcrypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, keyPair.privateKey, message),
      );
      const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("spki", keyPair.publicKey));
      return { publicKey, signature };
    }
    case "ECDSA_P256_SIGN": {
      // ⚠️ `@noble/curves` takes a message DIGEST, not a message. The server
      // signs `SHA-256(enc)` (`ECDSA_P256_SHA256_ASN1`); this used to pass
      // `message` straight through, which round-tripped against a verifier
      // making the identical mistake and matched nothing the server produces.
      const { secretKey } = p256.keygen();
      const publicKey = p256.getPublicKey(secretKey, false);
      const signature = p256.sign(sha256(message), secretKey).toBytes("der");
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

/**
 * Builds a `.mach` PEM for `scheme`, returning `{ publicKey, pem }`.
 *
 * Corrected against `tamga-api`'s `encode_machine_file`: `alg` carries the
 * mandatory `+v2` marker, and an encrypted `enc` is `"{nonce_b64}.{cipher_b64}"`
 * — two independently base64-encoded halves, per `FieldEncryption::encrypt`.
 * Read the file header before trusting anything built here.
 */
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
    encValue = `${base64Encode(nonce)}.${base64Encode(ciphertextAndTag)}`;
    encPrefix = "aes-256-gcm";
  }
  const { publicKey, signature } = await signForScheme(scheme, encValue);
  const sig = base64Encode(signature);
  const alg = `${encPrefix}+${SCHEME_ALG_SUFFIX[scheme]}+v2`;
  const certJson = JSON.stringify({ enc: encValue, sig, alg });
  const pemBody = base64Encode(enc.encode(certJson));
  return { publicKey, pem: `-----BEGIN MACHINE FILE-----\n${pemBody}\n-----END MACHINE FILE-----` };
}

/**
 * Builds an Ed25519-signed `.mach` PEM with a **caller-supplied** signing key,
 * so a test can name a `kid` in the payload and control which key actually
 * signed the bytes — the two must be varied independently to tell a stale key
 * set apart from a forgery.
 *
 * {@link buildMachinePem} generates its own keypair and cannot express that.
 *
 * ⚠️ Still self-generated, and still not evidence of interop — see this file's
 * header. What it is used for here is the negative space: a file naming a key
 * nobody holds, and a file naming a key held by someone who did not sign it.
 */
export async function buildEd25519MachinePemWithKey(
  payloadJson: string,
  signingSecretKey: Uint8Array,
  encryptionKey?: Uint8Array,
): Promise<string> {
  let encValue: string;
  let encPrefix: string;
  if (encryptionKey === undefined) {
    encValue = base64Encode(enc.encode(payloadJson));
    encPrefix = "base64";
  } else {
    const { nonce, ciphertextAndTag } = await encryptAesGcm(enc.encode(payloadJson), encryptionKey);
    encValue = `${base64Encode(nonce)}.${base64Encode(ciphertextAndTag)}`;
    encPrefix = "aes-256-gcm";
  }
  const sig = base64Encode(ed25519.sign(enc.encode(encValue), signingSecretKey));
  const certJson = JSON.stringify({ enc: encValue, sig, alg: `${encPrefix}+ed25519+v2` });
  const pemBody = base64Encode(enc.encode(certJson));
  return `-----BEGIN MACHINE FILE-----\n${pemBody}\n-----END MACHINE FILE-----`;
}

/** The representative license payload with a chosen `kid` claim. */
export function licensePayloadJsonWithKid(kid: string): string {
  const parsed = JSON.parse(representativeLicensePayloadJson()) as { meta: Record<string, unknown> };
  parsed.meta.kid = kid;
  return JSON.stringify(parsed);
}

/** The representative machine payload with a chosen `kid` claim. */
export function machinePayloadJsonWithKid(kid: string): string {
  const parsed = JSON.parse(representativeMachinePayloadJson()) as { meta: Record<string, unknown> };
  parsed.meta.kid = kid;
  return JSON.stringify(parsed);
}
