import { describe, expect, it } from "vitest";
import { checkTtl, MAX_TTL_SECS } from "../src/checkout/machineFile.js";
import { CheckoutError } from "../src/errors.js";

describe("checkTtl", () => {
  it("accepts the valid range boundaries", () => {
    expect(() => checkTtl(1)).not.toThrow();
    expect(() => checkTtl(MAX_TTL_SECS)).not.toThrow();
  });

  it("rejects 0", () => {
    expect(() => checkTtl(0)).toThrow(CheckoutError);
  });

  it("rejects values over the max (365 days)", () => {
    expect(() => checkTtl(MAX_TTL_SECS + 1)).toThrow(CheckoutError);
  });

  it("rejects negative values", () => {
    expect(() => checkTtl(-1)).toThrow(CheckoutError);
  });
});
