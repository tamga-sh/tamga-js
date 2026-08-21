/**
 * Machine file v2 — verified against certificates the **server** produced.
 *
 * Every case here is driven off `test/fixtures/machine-file-v2/manifest.json`,
 * so a fixture added to that directory is exercised with no edit to this file.
 * Nothing in this suite builds a certificate; see that directory's
 * `PROVENANCE.md` for why that rule exists.
 *
 * What these prove that `test/helpers/checkoutFixtures.ts` could not:
 *
 * - `alg` carries a mandatory `+v2` marker (`base64+ed25519+v2`), and the
 *   signing suffix sits between the first and last `+`. Encoding prefixes
 *   (`aes-256-gcm`) and signing suffixes (`rsa-pss-sha256`, `ecdsa-p256`) both
 *   contain hyphens, so a parser that splits once and compares the remainder —
 *   what this SDK did — rejects every file the server emits.
 * - An encrypted `enc` is `"<nonce_b64>.<cipher_b64>"`: two separately
 *   base64-encoded halves, not one blob with a 12-byte nonce prefix.
 * - The signed payload carries `meta` claims, and `meta.exp` is enforced.
 * - The signing scheme comes from the caller, never from `alg`: the server
 *   emits the identical `rsa-sha256` suffix for `RSA_2048_PKCS1_SIGN` and
 *   `RSA_2048_JWT_RS256`, so the file cannot name its own algorithm.
 */

import { describe, expect, it } from "vitest";

import { parseMachineFile, verifyAndDecryptMachineFile, verifyMachineFileWithClaims } from "../src/checkout/machineFile.js";
import {
  keyMaterialFor,
  loadMachineFixtureManifest,
  publicKeyFor,
  readMachineCert,
  readMachineFixturePem,
  rewrapMachinePem,
  schemeFromManifest,
  signedClaimsOf,
} from "./helpers/machineFileFixtures.js";

/**
 * A reference clock before any fixture was issued, for the cases that care
 * about the signature rather than the expiry: `0 - 60 > exp` is false for every
 * positive `exp`, so nothing has expired at the Unix epoch.
 */
const BEFORE_ANY_FIXTURE_WAS_ISSUED = 0;

const FIXTURES = loadMachineFixtureManifest();

it("loads the whole server-produced fixture set", () => {
  // Guards against a silently truncated copy: a manifest-driven suite that
  // iterates an empty or half-copied directory reports zero failures.
  expect(FIXTURES.length).toBeGreaterThanOrEqual(12);
  const schemes = new Set(FIXTURES.map(([, entry]) => schemeFromManifest(entry.scheme)));
  expect(schemes.size).toBeGreaterThanOrEqual(4);
});

describe.each(FIXTURES)("%s", (_name, entry) => {
  const scheme = schemeFromManifest(entry.scheme);
  const pem = () => readMachineFixturePem(entry);
  const publicKey = () => publicKeyFor(entry);

  it("declares the alg the manifest records, ending in the mandatory +v2 marker", () => {
    const cert = parseMachineFile(pem());
    expect(cert.alg).toBe(entry.alg);
    expect(cert.alg.endsWith("+v2")).toBe(true);
  });

  it("encodes enc the way the manifest records", () => {
    const cert = readMachineCert(entry);
    expect(cert.enc.includes(".")).toBe(entry.enc_is_dot_separated);
    expect(cert.enc.includes(".")).toBe(entry.encrypted);
  });

  it("verifies, decrypts and yields the machine resource", async () => {
    const machine = await verifyAndDecryptMachineFile(
      pem(),
      scheme,
      publicKey(),
      keyMaterialFor(entry),
      BEFORE_ANY_FIXTURE_WAS_ISSUED,
    );
    expect(machine.type).toBe("machines");
    expect(machine.attributes.fingerprint).toBe(entry.fingerprint);
  });

  it("exposes the signed claims, including the key id the manifest records", async () => {
    const { claims } = await verifyMachineFileWithClaims(
      pem(),
      scheme,
      publicKey(),
      keyMaterialFor(entry),
      BEFORE_ANY_FIXTURE_WAS_ISSUED,
    );
    expect(claims.kid).toBe(entry.kid);
    expect(claims.jti).toBeTruthy();
    expect(typeof claims.iat).toBe("number");
  });

  it(
    entry.expired
      ? "is refused as expired — distinctly from a forgery — at its own issue time"
      : "is still inside its ttl at its own issue time",
    async () => {
      // Anchored to the file's own signed `iat`, never the wall clock: `exp` is
      // `iat ± 3600`, so a wall-clock comparison would pass for one hour after
      // the fixtures were minted and fail every day after that.
      const { iat } = await signedClaimsOf(entry);
      const attempt = verifyAndDecryptMachineFile(
        pem(),
        scheme,
        publicKey(),
        keyMaterialFor(entry),
        iat,
      );
      if (entry.expired) {
        await expect(attempt).rejects.toMatchObject({ kind: "expired" });
      } else {
        await expect(attempt).resolves.toBeDefined();
      }
    },
  );

  it("rejects a tampered enc on the signature, before decoding or decrypting it", async () => {
    // `enc` is replaced with something that is not base64 at all. A verifier
    // that decodes before it verifies answers "invalid base64"; the signature
    // has to be the thing that fails, because attacker-controlled bytes must
    // not reach a decoder.
    const tampered = rewrapMachinePem(pem(), { enc: "!!! not base64 at all !!!" });
    await expect(
      verifyAndDecryptMachineFile(
        tampered,
        scheme,
        publicKey(),
        keyMaterialFor(entry),
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).rejects.toMatchObject({ kind: "crypto" });
  });

  it("rejects a single flipped character inside enc", async () => {
    const cert = readMachineCert(entry);
    const flipped = cert.enc.startsWith("A")
      ? `B${cert.enc.slice(1)}`
      : `A${cert.enc.slice(1)}`;
    await expect(
      verifyAndDecryptMachineFile(
        rewrapMachinePem(pem(), { enc: flipped }),
        scheme,
        publicKey(),
        keyMaterialFor(entry),
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).rejects.toMatchObject({ kind: "crypto" });
  });

  it("rejects the same file with the +v2 marker stripped", async () => {
    // `alg` is not covered by the signature — only `enc`'s string bytes are —
    // so this file is otherwise byte-for-byte authentic. The v2 gate has to
    // hold on its own: a v1 file carried no `meta.exp` in the signed payload
    // and derived its AES key by zero-padding the license key.
    const v1 = rewrapMachinePem(pem(), { alg: entry.alg.replace("+v2", "") });
    await expect(
      verifyAndDecryptMachineFile(
        v1,
        scheme,
        publicKey(),
        keyMaterialFor(entry),
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).rejects.toMatchObject({ kind: "unsupported-algorithm" });
  });

  it.each([
    ["a later format marker", (alg: string) => alg.replace("+v2", "+v3")],
    ["a marker with trailing junk", (alg: string) => `${alg}junk`],
    ["a prefixed encoding name", (alg: string) => `x${alg}`],
    ["a doubled marker", (alg: string) => `${alg}+v2`],
  ])("rejects %s — a substring check would let this through", async (_label, mutate) => {
    await expect(
      verifyAndDecryptMachineFile(
        rewrapMachinePem(pem(), { alg: mutate(entry.alg) }),
        scheme,
        publicKey(),
        keyMaterialFor(entry),
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).rejects.toMatchObject({ kind: "unsupported-algorithm" });
  });

  it("refuses RSA_2048_JWT_RS256 up front, whatever the file says", async () => {
    await expect(
      verifyAndDecryptMachineFile(
        pem(),
        "RSA_2048_JWT_RS256",
        publicKey(),
        keyMaterialFor(entry),
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).rejects.toMatchObject({ kind: "scheme-not-supported" });
  });

  if (entry.encrypted) {
    it("fails to decrypt under the wrong fingerprint", async () => {
      // The fingerprint is HKDF `info`, so a machine file cannot be opened
      // anywhere but on the machine it was issued for.
      await expect(
        verifyAndDecryptMachineFile(
          pem(),
          scheme,
          publicKey(),
          { licenseKey: entry.license_key ?? "", fingerprint: "not-this-machine" },
          BEFORE_ANY_FIXTURE_WAS_ISSUED,
        ),
      ).rejects.toMatchObject({ kind: "crypto" });
    });

    it("fails to decrypt under the wrong license key", async () => {
      await expect(
        verifyAndDecryptMachineFile(
          pem(),
          scheme,
          publicKey(),
          { licenseKey: "TAMGA-WRONG-KEY", fingerprint: entry.fingerprint },
          BEFORE_ANY_FIXTURE_WAS_ISSUED,
        ),
      ).rejects.toMatchObject({ kind: "crypto" });
    });

    it("asks for key material rather than guessing when none is supplied", async () => {
      await expect(
        verifyAndDecryptMachineFile(
          pem(),
          scheme,
          publicKey(),
          undefined,
          BEFORE_ANY_FIXTURE_WAS_ISSUED,
        ),
      ).rejects.toMatchObject({ kind: "license-key-missing" });
    });
  }
});

describe("the signing scheme comes from the caller, not from alg", () => {
  const byName = new Map(FIXTURES);

  it("accepts rsa-sha256 as PKCS#1 and refuses the same bytes as JWT RS256", async () => {
    // The server emits `rsa-sha256` for both `RSA_2048_PKCS1_SIGN` and
    // `RSA_2048_JWT_RS256`, so the suffix cannot identify the scheme. Same
    // file, same suffix, two outcomes — decided entirely by the caller's
    // `scheme` argument.
    const entry = byName.get("rsa_pkcs1_plain_valid");
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    expect(entry.alg).toContain("rsa-sha256");

    await expect(
      verifyAndDecryptMachineFile(
        readMachineFixturePem(entry),
        "RSA_2048_PKCS1_SIGN",
        publicKeyFor(entry),
        undefined,
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).resolves.toBeDefined();

    await expect(
      verifyAndDecryptMachineFile(
        readMachineFixturePem(entry),
        "RSA_2048_JWT_RS256",
        publicKeyFor(entry),
        undefined,
        BEFORE_ANY_FIXTURE_WAS_ISSUED,
      ),
    ).rejects.toMatchObject({ kind: "scheme-not-supported" });
  });

  it.each([
    ["ed25519_plain_valid", "ECDSA_P256_SIGN"],
    ["ecdsa_p256_plain_valid", "ED25519_SIGN"],
    ["rsa_pss_plain_valid", "RSA_2048_PKCS1_SIGN"],
    ["rsa_pkcs1_plain_valid", "RSA_2048_PKCS1_PSS_SIGN"],
  ] as const)(
    "cross-checks %s against a caller claiming %s and fails on the suffix",
    async (fixtureName, claimed) => {
      const entry = byName.get(fixtureName);
      expect(entry).toBeDefined();
      if (entry === undefined) return;

      await expect(
        verifyAndDecryptMachineFile(
          readMachineFixturePem(entry),
          claimed,
          publicKeyFor(entry),
          undefined,
          BEFORE_ANY_FIXTURE_WAS_ISSUED,
        ),
      ).rejects.toMatchObject({ kind: "unsupported-algorithm" });
    },
  );
});

describe("expiry is enforced with the license-file path's own tolerance", () => {
  const byName = new Map(FIXTURES);

  it("tolerates seconds of clock skew on a machine file, not hours", async () => {
    // Same 60-second allowance the license-file path uses. A generous window
    // is a free extension on every expired file, since the clock belongs to
    // whoever holds the file.
    const entry = byName.get("ed25519_plain_valid");
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const { exp } = await signedClaimsOf(entry);
    expect(typeof exp).toBe("number");
    const expiry = exp ?? 0;

    await expect(
      verifyAndDecryptMachineFile(
        readMachineFixturePem(entry),
        schemeFromManifest(entry.scheme),
        publicKeyFor(entry),
        undefined,
        expiry + 30,
      ),
    ).resolves.toBeDefined();

    await expect(
      verifyAndDecryptMachineFile(
        readMachineFixturePem(entry),
        schemeFromManifest(entry.scheme),
        publicKeyFor(entry),
        undefined,
        expiry + 600,
      ),
    ).rejects.toMatchObject({ kind: "expired" });
  });

  it("reports the expiry timestamp on the error, so a caller can say when", async () => {
    const entry = byName.get("ed25519_plain_expired");
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const { iat, exp } = await signedClaimsOf(entry);
    await expect(
      verifyAndDecryptMachineFile(
        readMachineFixturePem(entry),
        schemeFromManifest(entry.scheme),
        publicKeyFor(entry),
        undefined,
        iat,
      ),
    ).rejects.toThrow(String(exp));
  });
});
