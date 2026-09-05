/**
 * D17: the `alg` gate runs before any key or signature work on every entry
 * point, so a v1 file gets the same answer whichever key it meets. It used to
 * be a signature failure through the single-key path (when the key was wrong)
 * and "unsupported-algorithm" through the key-set path — one file, two
 * diagnoses.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";

import { SigningKeySet } from "../src/checkout/keySet.js";
import {
  verifyAndDecryptLicenseFile,
  verifyLicenseFileWithKeySet,
} from "../src/checkout/licenseFile.js";
import { CheckoutError } from "../src/errors.js";
import { base64Decode, base64Encode } from "../src/internal/base64.js";
import { buildLicensePem, representativeLicensePayloadJson } from "./helpers/checkoutFixtures.js";

const ISSUED_AT = 1767225600;

/** Rewrites `alg` in place — `alg` is not covered by the signature. */
function rewriteLicenseAlg(pem: string, alg: string): string {
  const body = pem
    .replace("-----BEGIN LICENSE FILE-----", "")
    .replace("-----END LICENSE FILE-----", "")
    .trim();
  const cert = JSON.parse(new TextDecoder().decode(base64Decode(body))) as Record<string, unknown>;
  cert.alg = alg;
  const rebuilt = base64Encode(new TextEncoder().encode(JSON.stringify(cert)));
  return `-----BEGIN LICENSE FILE-----\n${rebuilt}\n-----END LICENSE FILE-----`;
}

async function expectUnsupportedAlgorithm(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    expect.unreachable("a v1 file must be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckoutError);
    expect((error as CheckoutError).kind).toBe("unsupported-algorithm");
  }
}

describe("the license-file alg gate runs before the signature", () => {
  it("refuses a v1 file with the same error whichever key it is presented with", async () => {
    const signer = ed25519.keygen();
    const other = ed25519.keygen();
    const v1 = rewriteLicenseAlg(
      await buildLicensePem(representativeLicensePayloadJson(), signer.secretKey),
      "base64+ed25519",
    );

    for (const publicKey of [signer.publicKey, other.publicKey]) {
      await expectUnsupportedAlgorithm(() =>
        verifyAndDecryptLicenseFile(v1, publicKey, undefined, ISSUED_AT),
      );
    }
    for (const keySet of [
      SigningKeySet.fromPublicKeys([base64Encode(signer.publicKey)]),
      SigningKeySet.fromPublicKeys([base64Encode(other.publicKey)]),
    ]) {
      await expectUnsupportedAlgorithm(() =>
        verifyLicenseFileWithKeySet(v1, keySet, undefined, ISSUED_AT),
      );
    }
  });
});
