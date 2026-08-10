import { describe, expect, it } from "vitest";
import { verifyAndDecryptMachineFile } from "../src/checkout/machineFile.js";
import { buildMachinePem, representativeMachinePayloadJson } from "./helpers/checkoutFixtures.js";

describe("verifyAndDecryptMachineFile — ECDSA_P256_SIGN", () => {
  it("round-trips a plain (unencrypted) fixture", async () => {
    const { publicKey, pem } = await buildMachinePem(
      "ECDSA_P256_SIGN",
      representativeMachinePayloadJson(),
    );
    const machine = await verifyAndDecryptMachineFile(pem, "ECDSA_P256_SIGN", publicKey);
    expect(machine.attributes.fingerprint).toBe("fp-abc123");
  });
});
