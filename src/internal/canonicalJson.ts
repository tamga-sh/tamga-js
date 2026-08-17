/**
 * Canonical (alphabetical-key) JSON serialization.
 *
 * Not part of the public API — used exclusively by `src/proof.ts` to
 * reproduce the exact byte layout the Tamga API signs for a machine offline
 * proof.
 *
 * ⚠️ Plain `JSON.stringify` in JS/TS serializes object keys in **insertion
 * order**, not alphabetically. The server builds its signed payload via
 * Rust's `serde_json::json!(...)` macro, and `serde_json::Map` is
 * `BTreeMap`-backed (alphabetically sorted output) unless the
 * `preserve_order` crate feature is enabled — which it is not anywhere in
 * the server's dependency graph (ground-truth-verified in `tamga-rust`'s
 * `src/proof.rs` module doc comment: no `indexmap` next to `serde_json` in
 * either lockfile). So despite the server's source code literally
 * writing `{"account": ..., "machine": ..., "dataset": ...}` in that order,
 * the actual bytes on the wire are alphabetically sorted at *every*
 * nesting level: `{"account":...,"dataset":...,"machine":...}` (dataset
 * before machine), and within `machine`, `fingerprint` before `id`.
 *
 * `canonicalJsonStringify` recursively rebuilds every plain object with its
 * keys sorted by UTF-8 byte order (see `compareUtf8Bytes` below) before
 * calling `JSON.stringify` — since JS engines preserve insertion order for
 * string object keys, stringifying an already-key-sorted object produces
 * the same canonical order `serde_json`'s `BTreeMap` does, which orders
 * `String`/`str` keys by their raw UTF-8 byte sequence.
 *
 * ⚠️ **UTF-16-vs-UTF-8 sort divergence (SECURITY, found via audit)**: this
 * module used to sort with plain `Array.prototype.sort()` (default
 * UTF-16-code-unit lexicographic order), which only agrees with Rust's
 * UTF-8 byte-wise order for the ASCII range. Caller-supplied `dataset` keys
 * are not restricted to ASCII, and the two orders diverge for keys mixing a
 * BMP Private-Use-Area character (e.g. U+E000, 3-byte UTF-8) with a
 * supplementary-plane character (e.g. U+10000, 4-byte UTF-8, encoded in
 * UTF-16 as a surrogate pair starting with 0xD800): UTF-16-code-unit order
 * puts the surrogate-pair-leading key first (0xD800 < 0xE000), while UTF-8
 * byte order puts the other key first (0xEE < 0xF0). A legitimate proof
 * signed server-side over a dataset with such keys would fail client-side
 * verification (fail-safe, not a forged-proof acceptance) because the
 * reconstructed payload bytes would differ from what was actually signed.
 * `compareUtf8Bytes` fixes this by comparing each key's actual UTF-8 byte
 * sequence instead of relying on `sort()`'s default comparator.
 *
 * ⚠️ **`__proto__`-keyed rebuild trap**: the accumulator below is built with
 * `Object.create(null)`, not `{}`. A caller-supplied `dataset` can
 * legitimately contain an own property literally named `"__proto__"` (e.g.
 * anything that went through `JSON.parse`, which — per spec — creates it as
 * a normal own data property, not through the inherited legacy accessor).
 * If the accumulator were a plain `{}`, `result["__proto__"] = value`
 * would *not* create an own `"__proto__"` property at all: it would invoke
 * `Object.prototype`'s legacy `__proto__` setter and reassign the
 * accumulator's own prototype instead, silently dropping that key (and its
 * value) from the object entirely — `Object.keys`/`JSON.stringify` never
 * see it again. In `serde_json::Map` (`BTreeMap`-backed) on the Rust side,
 * `"__proto__"` is just an ordinary string key with no special meaning, so
 * the server includes it normally. That mismatch would let two
 * byte-distinct `dataset` payloads (one with an extra `"__proto__"` key,
 * one without) canonicalize to identical JSON and therefore verify against
 * the same signature — a real integrity-check bypass, not just a cosmetic
 * quirk. `Object.create(null)` has no inherited `__proto__` accessor, so
 * assigning that key behaves like any other string key, matching Rust.
 */

const utf8Encoder = new TextEncoder();

/**
 * Compares two strings by their UTF-8 byte sequences, matching Rust's
 * `String`/`str` `Ord` (and therefore `serde_json::Map`'s `BTreeMap`-backed
 * key order) — NOT JS's default `Array.prototype.sort()`, which compares
 * UTF-16 code units and diverges from UTF-8 byte order for characters
 * outside the ASCII range. See module doc comment's "UTF-16-vs-UTF-8 sort
 * divergence" note.
 */
function compareUtf8Bytes(a: string, b: string): number {
  const bytesA = utf8Encoder.encode(a);
  const bytesB = utf8Encoder.encode(b);
  const len = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < len; i++) {
    if (bytesA[i] !== bytesB[i]) {
      return bytesA[i]! - bytesB[i]!;
    }
  }
  return bytesA.length - bytesB.length;
}

/** Recursively rebuilds `value`, sorting object keys by UTF-8 byte order at every level. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sortedKeys = Object.keys(source).sort(compareUtf8Bytes);
    // Object.create(null): see module doc comment's `__proto__`-keyed rebuild trap.
    const result: Record<string, unknown> = Object.create(null);
    for (const key of sortedKeys) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

/**
 * Serializes `value` to JSON with object keys sorted alphabetically at
 * every nesting level — see module doc comment for why this, and not plain
 * `JSON.stringify`, is required to reproduce the server's signed payload.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
