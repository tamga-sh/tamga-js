/**
 * `kid` computation, against vectors this repository did not generate.
 *
 * The vectors come from `test/fixtures/signing-keys/signing-key-ids.json` —
 * produced by an independent SHA-256 implementation and confirmed against
 * `tamga-rust`'s committed vector. See that directory's `PROVENANCE.md` for why
 * a self-generated vector would be worthless here: this repo has already
 * shipped a green suite over a verifier that could not read anything the server
 * emitted, because the fixture builder made the identical mistake on the other
 * side.
 *
 * The file is read from disk and iterated, so a vector added to it is exercised
 * with no edit to this spec.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { signingKeyId, UNBACKFILLED_ACCOUNT_KEY_ID, SIGNING_KEY_ID_LENGTH } from "../src/crypto/keyId.js";

interface KeyIdVectors {
  vectors: { name: string; publicKey: string; kid: string; note: string }[];
  negative: {
    name: string;
    publicKey: string;
    correctKid: string;
    wrongKidIfDecodedFirst: string;
    note: string;
  };
}

const vectorPath = fileURLToPath(
  new URL("./fixtures/signing-keys/signing-key-ids.json", import.meta.url),
);
const fixtures = JSON.parse(readFileSync(vectorPath, "utf8")) as KeyIdVectors;

describe("signingKeyId reproduces the server's key_id()", () => {
  it("has vectors to run at all", () => {
    // Guards against a fixture that silently became empty — an `it.each` over
    // an empty array reports as a pass.
    expect(fixtures.vectors.length).toBeGreaterThanOrEqual(5);
  });

  it.each(fixtures.vectors)("$name — $note", ({ publicKey, kid }) => {
    expect(signingKeyId(publicKey)).toBe(kid);
  });

  it.each(fixtures.vectors)("$name is 16 lowercase hex characters", ({ publicKey }) => {
    const kid = signingKeyId(publicKey);
    expect(kid).toHaveLength(SIGNING_KEY_ID_LENGTH);
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the base64-string-versus-decoded-bytes trap", () => {
  /**
   * ⚠️ The assertion that actually bites. The server hands `key_id` the stored
   * base64 **string**, never the 32 decoded bytes, and the natural assumption
   * is the wrong one. A port that decodes first produces a plausible id that
   * matches nothing the server emits, so every authentic file reports as signed
   * by an unknown key.
   *
   * Both halves are asserted on purpose: the positive alone does not name what
   * went wrong when it fails, and — more importantly — it does not prove the
   * implementation isn't arriving at the right answer by some other route.
   */
  it("hashes the base64 string, and specifically does not hash the decoded bytes", () => {
    const { publicKey, correctKid, wrongKidIfDecodedFirst } = fixtures.negative;

    expect(signingKeyId(publicKey)).toBe(correctKid);
    expect(signingKeyId(publicKey)).not.toBe(wrongKidIfDecodedFirst);
  });

  it("the two ids really are different, so the assertion above is not vacuous", () => {
    // If the fixture ever carried the same value twice, the `not.toBe` above
    // would pass against a decode-first implementation.
    expect(fixtures.negative.correctKid).not.toBe(fixtures.negative.wrongKidIfDecodedFirst);
  });
});

describe("the unbackfilled-account key id", () => {
  it("is the id of the empty string", () => {
    // `check_out_license.rs` passes `ed25519_public_key.unwrap_or_default()`,
    // so an account whose key column was never populated signs every file with
    // this one id.
    expect(signingKeyId("")).toBe(UNBACKFILLED_ACCOUNT_KEY_ID);
  });

  it("matches the value the independent vector set carries", () => {
    const vector = fixtures.vectors.find((v) => v.publicKey === "");
    expect(vector).toBeDefined();
    expect(UNBACKFILLED_ACCOUNT_KEY_ID).toBe(vector?.kid);
  });
});

/**
 * The strongest evidence available in this repository: the `kid` rule checked
 * against certificates the **server itself** minted.
 *
 * `test/fixtures/machine-file-v2/manifest.json` records, for each of the 12
 * server-produced machine files, both the `kid` the server stamped into the
 * signed payload and the base64 public key it signed with. If `signingKeyId`
 * reproduces the server's `key_id()`, hashing the manifest's `public_key_b64`
 * must reproduce the manifest's `kid` — for every entry, with no exceptions.
 *
 * Unlike `signing-key-ids.json`, which is independent of this SDK but still not
 * the server, these values came out of the server's own encoder. See
 * `test/fixtures/machine-file-v2/PROVENANCE.md`.
 */
interface MachineFileManifestEntry {
  scheme: string;
  kid: string;
  public_key_b64: string;
}

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/machine-file-v2/manifest.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, MachineFileManifestEntry>;

describe("the server's own certificates agree with signingKeyId", () => {
  const entries = Object.entries(manifest);

  it("has certificates to check", () => {
    expect(entries.length).toBe(12);
  });

  it.each(entries)("%s — the stamped kid is the hash of the key that signed it", (_name, entry) => {
    expect(signingKeyId(entry.public_key_b64)).toBe(entry.kid);
  });

  /**
   * ⚠️ Recorded because it contradicts a claim carried by `tamga-rust`'s
   * `src/models/signing_key.rs` — that both checkout handlers compute the `kid`
   * from `account.ed25519_public_key` whatever scheme actually signed the
   * bytes, so on an RSA- or ECDSA-signed file the claim names a key that did
   * not sign it.
   *
   * These 12 server-minted certificates do not show that. They carry four
   * distinct kids, one per signing scheme, and each is the hash of that
   * scheme's own public key — a 65-byte P-256 point for the ECDSA files and a
   * 270-byte RSA key for the RSA ones, neither of which is an Ed25519 key. Were
   * the claim true of the code that produced these files, all 12 would share a
   * single kid.
   *
   * This does not change what this SDK does: a key set is built from the
   * published `signing-keys` route, which serves Ed25519 keys only, so a
   * non-Ed25519 file cannot be verified through one either way. It is pinned
   * here so the question is settled by measurement if it is ever revisited.
   */
  it("stamps a distinct kid per signing scheme, not one account-wide kid", () => {
    const kids = new Set(entries.map(([, entry]) => entry.kid));
    const schemes = new Set(entries.map(([, entry]) => entry.scheme));

    expect(kids.size).toBe(4);
    expect(kids.size).toBe(schemes.size);
  });
});
