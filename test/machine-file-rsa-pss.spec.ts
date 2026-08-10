import { describe, expect, it } from "vitest";
import { verifyAndDecryptMachineFile } from "../src/checkout/machineFile.js";
import { buildMachinePem, representativeMachinePayloadJson } from "./helpers/checkoutFixtures.js";

describe("verifyAndDecryptMachineFile — RSA_2048_PKCS1_PSS_SIGN", () => {
  it("round-trips a plain (unencrypted) fixture", async () => {
    const { publicKey, pem } = await buildMachinePem(
      "RSA_2048_PKCS1_PSS_SIGN",
      representativeMachinePayloadJson(),
    );
    const machine = await verifyAndDecryptMachineFile(pem, "RSA_2048_PKCS1_PSS_SIGN", publicKey);
    expect(machine.attributes.fingerprint).toBe("fp-abc123");
  });
});
