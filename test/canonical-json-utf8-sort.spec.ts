import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/internal/canonicalJson.js";

// Regression tests for a sort-order divergence found during a cross-repo
// security audit: canonicalize() sorted object keys with JS's default
// Array.prototype.sort() (UTF-16 code-unit order), which diverges from the
// server's serde_json BTreeMap<String> (UTF-8 byte-wise) order for dataset
// keys mixing a BMP Private-Use-Area character with a supplementary-plane
// (astral) character. Concretely: "" (BMP private-use, 3-byte UTF-8:
// EE 80 80) vs "\u{10000}" (supplementary plane, 4-byte UTF-8: F0 90 80 80)
// -- UTF-16 code-unit order puts the surrogate-pair leading unit (0xD800)
// before 0xE000, so JS's default sort puts "\u{10000}" first; UTF-8 byte
// order (matching Rust) puts "" first, since 0xEE < 0xF0.
//
// This fails SAFE today (a legitimate proof with such keys is rejected, not
// a forged one accepted) -- these tests lock in the fix, not a demonstrated
// bypass.

describe("canonicalJsonStringify key ordering", () => {
  it("sorts a BMP private-use key before a supplementary-plane key, matching UTF-8 byte order", () => {
    const value = { "\u{10000}": "a", "": "b" };

    expect(canonicalJsonStringify(value)).toBe('{"":"b","\u{10000}":"a"}');
  });

  it("matches the UTF-8-byte-sorted order for a larger mixed-range key set", () => {
    // Independently computed expected order by sorting the raw UTF-8 byte
    // sequences of each key, not by re-deriving it from the implementation
    // under test.
    const keys = ["z", "a", "\u{1F600}", "", "é", "middle"];
    const expectedOrder = [...keys].sort((a, b) => {
      const bytesA = new TextEncoder().encode(a);
      const bytesB = new TextEncoder().encode(b);
      const len = Math.min(bytesA.length, bytesB.length);
      for (let i = 0; i < len; i++) {
        if (bytesA[i] !== bytesB[i]) return bytesA[i]! - bytesB[i]!;
      }
      return bytesA.length - bytesB.length;
    });

    const value: Record<string, number> = {};
    keys.forEach((k, i) => (value[k] = i));
    const actualOrder = Object.keys(JSON.parse(canonicalJsonStringify(value)) as Record<string, number>);

    expect(actualOrder).toEqual(expectedOrder);
  });

  it("still sorts plain ASCII keys correctly (no regression on the common case)", () => {
    const value = { machine: 1, account: 2, dataset: 3 };

    expect(canonicalJsonStringify(value)).toBe('{"account":2,"dataset":3,"machine":1}');
  });

  it("still sorts nested object keys correctly (no regression)", () => {
    const value = { machine: { id: "x", fingerprint: "y" }, account: { id: "z" } };

    expect(canonicalJsonStringify(value)).toBe(
      '{"account":{"id":"z"},"machine":{"fingerprint":"y","id":"x"}}',
    );
  });
});
