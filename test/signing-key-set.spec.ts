/**
 * `SigningKeySet` construction and lookup.
 *
 * The set is what turns "this file does not verify" into a question with two
 * different answers, so its two builders have deliberately opposite policies on
 * a bad key and both are pinned here.
 */

import { describe, expect, it } from "vitest";

import { SigningKeySet, isWellFormedKeyId } from "../src/checkout/keySet.js";
import { signingKeyId } from "../src/crypto/keyId.js";
import { SigningKeyError } from "../src/errors.js";
import type { SigningKey } from "../src/models/signingKey.js";

/** Base64 of 32 zero bytes — a well-formed key encoding, used for its length and its id. */
const ZERO_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ZERO_KEY_KID = "51643eac9777b63a";
/** Bytes 0..31 — the negative vector's key. */
const SEQUENTIAL_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const SEQUENTIAL_KEY_KID = "905f28def18eaac0";

function resource(
  id: string,
  overrides: Partial<SigningKey["attributes"]> = {},
): SigningKey {
  return {
    id,
    type: "signing-keys",
    attributes: {
      algorithm: "ed25519",
      publicKey: ZERO_KEY_B64,
      status: "retired",
      created: "2026-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

describe("SigningKeySet.fromPublicKeys — the offline, keys-in-the-binary path", () => {
  it("indexes an embedded key by its computed kid", () => {
    const set = SigningKeySet.fromPublicKeys([ZERO_KEY_B64]);

    expect(set.size).toBe(1);
    expect(set.has(ZERO_KEY_KID)).toBe(true);
    expect(set.find(ZERO_KEY_KID)).toEqual(new Uint8Array(32));
    expect(set.keyIds).toEqual([ZERO_KEY_KID]);
  });

  it("computes each id with the same rule the server uses", () => {
    const set = SigningKeySet.fromPublicKeys([ZERO_KEY_B64, SEQUENTIAL_KEY_B64]);

    expect(set.keyIds).toEqual([signingKeyId(ZERO_KEY_B64), signingKeyId(SEQUENTIAL_KEY_B64)]);
    expect(set.keyIds).toEqual([ZERO_KEY_KID, SEQUENTIAL_KEY_KID]);
  });

  it("fails loudly on a mistyped key rather than silently dropping it", () => {
    // The alternative — skipping it — produces a set that reports every genuine
    // file as signed by an unknown key, at runtime, in the field.
    expect(() => SigningKeySet.fromPublicKeys(["not base64 at all"])).toThrow(SigningKeyError);
    expect(() => SigningKeySet.fromPublicKeys(["QUJD"])).toThrow(/exactly 32 bytes/);

    try {
      SigningKeySet.fromPublicKeys(["QUJD"]);
      expect.unreachable("a 3-byte key must not build a set");
    } catch (error) {
      expect(error).toBeInstanceOf(SigningKeyError);
      expect((error as SigningKeyError).kind).toBe("invalid-key");
    }
  });

  it("ignores a repeated key rather than double-listing it", () => {
    const set = SigningKeySet.fromPublicKeys([ZERO_KEY_B64, ZERO_KEY_B64]);
    expect(set.size).toBe(1);
  });

  it("records no mismatches — it derives every id itself", () => {
    expect(SigningKeySet.fromPublicKeys([ZERO_KEY_B64]).mismatches).toEqual([]);
  });
});

describe("SigningKeySet.fromResources — the published-key-set path", () => {
  it("takes the kid from the resource id, hashing nothing", () => {
    // The server's `id` *is* the kid. It is authoritative here; the local
    // computation only cross-checks.
    const set = SigningKeySet.fromResources([resource("deadbeefdeadbeef")]);

    expect(set.has("deadbeefdeadbeef")).toBe(true);
    expect(set.has(ZERO_KEY_KID)).toBe(false);
  });

  it("keeps retired keys — dropping them is the defect, not the fix", () => {
    const set = SigningKeySet.fromResources([
      resource("1111111111111111", { status: "active" }),
      resource("2222222222222222", { status: "retired", retired: "2026-06-01T00:00:00Z" }),
    ]);

    expect(set.size).toBe(2);
    expect(set.has("2222222222222222")).toBe(true);
  });

  it("skips one unusable row without stranding the others", () => {
    // A future algorithm and a key that does not decode are both skipped; the
    // Ed25519 rows around them still verify their files.
    const set = SigningKeySet.fromResources([
      resource("0000000000000000", { algorithm: "ml-dsa-44" }),
      resource("1111111111111111", { publicKey: "!!!not base64!!!" }),
      resource("3333333333333333", { publicKey: "QUJD" }),
      resource("2222222222222222"),
    ]);

    expect(set.size).toBe(1);
    expect(set.keyIds).toEqual(["2222222222222222"]);
  });

  it("accepts an unknown status, because a key history is not re-issuable", () => {
    const set = SigningKeySet.fromResources([resource("4444444444444444", { status: "compromised" })]);
    expect(set.has("4444444444444444")).toBe(true);
  });

  it("matches the algorithm case-insensitively", () => {
    const set = SigningKeySet.fromResources([resource("5555555555555555", { algorithm: "Ed25519" })]);
    expect(set.size).toBe(1);
  });

  it("reports a served id that disagrees with the key it was served with", () => {
    // Cross-check, not a gate: the served id still indexes the key, because it
    // is what the server stamps into the file's claim. But a disagreement means
    // this SDK's computation has drifted, the server changed, or the response
    // was altered — all worth an alert.
    const set = SigningKeySet.fromResources([
      resource("ffffffffffffffff"),
      resource(ZERO_KEY_KID),
    ]);

    expect(set.mismatches).toHaveLength(1);
    expect(set.mismatches[0]).toEqual({
      servedKeyId: "ffffffffffffffff",
      computedKeyId: ZERO_KEY_KID,
      publicKey: ZERO_KEY_B64,
    });
    // Still usable under the id it was served as.
    expect(set.has("ffffffffffffffff")).toBe(true);
  });

  it("reports no mismatch when the server's id agrees with the computed one", () => {
    const set = SigningKeySet.fromResources([resource(ZERO_KEY_KID)]);
    expect(set.mismatches).toEqual([]);
  });
});

describe("lookup", () => {
  it("matches exactly and case-sensitively", () => {
    const set = SigningKeySet.fromPublicKeys([ZERO_KEY_B64]);

    expect(set.find(ZERO_KEY_KID.toUpperCase())).toBeUndefined();
    expect(set.find(ZERO_KEY_KID.slice(0, -1))).toBeUndefined();
    expect(set.find("")).toBeUndefined();
  });

  it("an empty set builds and finds nothing", () => {
    const set = SigningKeySet.fromResources([]);

    expect(set.size).toBe(0);
    expect(set.keyIds).toEqual([]);
    expect(set.find(ZERO_KEY_KID)).toBeUndefined();
    expect(SigningKeySet.fromPublicKeys([]).size).toBe(0);
  });

  it("exposes keyIds as a copy, so a caller cannot mutate the set", () => {
    const set = SigningKeySet.fromPublicKeys([ZERO_KEY_B64]);
    (set.keyIds as string[]).push("tampered");

    expect(set.keyIds).toEqual([ZERO_KEY_KID]);
  });
});

describe("isWellFormedKeyId", () => {
  it("accepts exactly 16 lowercase hex characters", () => {
    expect(isWellFormedKeyId(ZERO_KEY_KID)).toBe(true);
    expect(isWellFormedKeyId("0123456789abcdef")).toBe(true);
  });

  it("rejects the wrong length, uppercase, and non-hex", () => {
    expect(isWellFormedKeyId("")).toBe(false);
    expect(isWellFormedKeyId("51643eac9777b63")).toBe(false);
    expect(isWellFormedKeyId("51643eac9777b63a0")).toBe(false);
    expect(isWellFormedKeyId(ZERO_KEY_KID.toUpperCase())).toBe(false);
    expect(isWellFormedKeyId("51643eac9777b63g")).toBe(false);
  });
});
