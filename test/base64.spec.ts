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

describe("strictness — why an encrypted enc must be split, not decoded whole", () => {
  it("rejects a dot-separated payload rather than silently dropping the separator", () => {
    // `Buffer.from(s, "base64")` discards characters outside the alphabet, so
    // decoding `"<nonce_b64>.<cipher_b64>"` whole yields exactly
    // `nonce ‖ ciphertext ‖ tag` — the pre-fix machine-file reader's 12-byte
    // slice would have landed correctly by pure coincidence. It never got the
    // chance: the pattern check below runs first and is the same on every
    // runtime, so the old single-blob read was a hard failure here, not a lucky
    // one. Keep it strict — the coincidence only holds while the nonce is
    // exactly 12 bytes (16 base64 chars, no padding), and it hides real
    // corruption the rest of the time.
    const nonce = base64Encode(new Uint8Array(12));
    const cipher = base64Encode(new Uint8Array(32));
    expect(nonce).toHaveLength(16);
    expect(() => base64Decode(`${nonce}.${cipher}`)).toThrow();
  });

  it("rejects any interior junk rather than skipping it", () => {
    expect(() => base64Decode("aGVs bG8=")).toThrow();
    expect(() => base64Decode("aGVs\nbG8=")).toThrow();
    expect(() => base64Decode("aGVsbG8=extra")).toThrow();
  });
});
