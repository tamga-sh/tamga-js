import { describe, expect, it } from "vitest";
import { verifyAndDecryptMachineFile } from "../src/checkout/machineFile.js";
import { CheckoutError } from "../src/errors.js";
import { buildMachinePem, representativeMachinePayloadJson } from "./helpers/checkoutFixtures.js";

describe("verifyAndDecryptMachineFile — RSA_2048_JWT_RS256 rejection", () => {
  it("throws scheme-not-supported before any parsing or crypto attempt, never silently succeeds", async () => {
    // Build a file genuinely signed+verifiable under Ed25519, but ask the
    // dispatcher to treat it as RSA_2048_JWT_RS256 — proves rejection
    // happens up front, not as a side effect of a parse failure, and that
    // the dispatcher never falls through to a different verify function.
    const { publicKey, pem } = await buildMachinePem("ED25519_SIGN", representativeMachinePayloadJson());

    await expect(
      verifyAndDecryptMachineFile(pem, "RSA_2048_JWT_RS256", publicKey),
    ).rejects.toMatchObject({ kind: "scheme-not-supported" });
  });

  it("the error is a CheckoutError instance", async () => {
    const { publicKey, pem } = await buildMachinePem("ED25519_SIGN", representativeMachinePayloadJson());
    await expect(
      verifyAndDecryptMachineFile(pem, "RSA_2048_JWT_RS256", publicKey),
    ).rejects.toBeInstanceOf(CheckoutError);
  });
});
