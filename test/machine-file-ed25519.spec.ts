import { describe, expect, it } from "vitest";
import { verifyAndDecryptMachineFile } from "../src/checkout/machineFile.js";
import { buildMachinePem, representativeMachinePayloadJson } from "./helpers/checkoutFixtures.js";

describe("verifyAndDecryptMachineFile — ED25519_SIGN", () => {
  it("round-trips a plain (unencrypted) fixture", async () => {
    const { publicKey, pem } = await buildMachinePem("ED25519_SIGN", representativeMachinePayloadJson());
    const machine = await verifyAndDecryptMachineFile(pem, "ED25519_SIGN", publicKey);
    expect(machine.attributes.fingerprint).toBe("fp-abc123");
  });
});
