import { describe, expect, it } from "vitest";
import { naiveKeyFromLicenseKey } from "../src/crypto/naiveKey.js";

describe("naiveKeyFromLicenseKey", () => {
  it("zero-pads keys shorter than 32 bytes", () => {
    const key = naiveKeyFromLicenseKey("short");
    expect(Array.from(key.subarray(0, 5))).toEqual(Array.from(new TextEncoder().encode("short")));
    expect(Array.from(key.subarray(5))).toEqual(new Array(27).fill(0));
  });

  it("truncates keys longer than 32 bytes", () => {
    const key = naiveKeyFromLicenseKey("a".repeat(50));
    expect(key).toEqual(new Uint8Array(32).fill("a".charCodeAt(0)));
  });

  it("leaves an exact 32-byte key unchanged", () => {
    const key = naiveKeyFromLicenseKey("a".repeat(32));
    expect(key).toEqual(new Uint8Array(32).fill("a".charCodeAt(0)));
  });

  it("is not a hash — same prefix diverges only after the prefix length", () => {
    const a = naiveKeyFromLicenseKey("abc");
    const b = naiveKeyFromLicenseKey("abcdef");
    expect(Array.from(a.subarray(0, 3))).toEqual(Array.from(b.subarray(0, 3)));
  });

  it("always returns exactly 32 bytes", () => {
    expect(naiveKeyFromLicenseKey("").length).toBe(32);
    expect(naiveKeyFromLicenseKey("x").length).toBe(32);
    expect(naiveKeyFromLicenseKey("x".repeat(100)).length).toBe(32);
  });
});
