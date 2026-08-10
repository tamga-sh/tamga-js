import { describe, expect, it } from "vitest";
import { base64Encode, base64Decode } from "../src/internal/base64.js";

describe("base64Encode/base64Decode", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 42]);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
  });

  it("round-trips an empty buffer", () => {
    expect(base64Decode(base64Encode(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it("throws for invalid base64 (bad characters)", () => {
    expect(() => base64Decode("not!!valid==base64")).toThrow();
  });

  it("throws for invalid base64 (bad padding)", () => {
    expect(() => base64Decode("abcde")).toThrow();
  });

  it("decodes a known vector", () => {
    expect(new TextDecoder().decode(base64Decode("aGVsbG8="))).toBe("hello");
  });

  it("encodes a known vector", () => {
    expect(base64Encode(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });
});
