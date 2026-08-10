/**
 * Canonical (alphabetical-key) JSON serialization.
 *
 * Not part of the public API — used exclusively by `src/proof.ts` to
 * reproduce the exact byte layout `tamga-api` signs for a machine offline
 * proof.
 *
 * ⚠️ Plain `JSON.stringify` in JS/TS serializes object keys in **insertion
 * order**, not alphabetically. The server builds its signed payload via
 * Rust's `serde_json::json!(...)` macro, and `serde_json::Map` is
 * `BTreeMap`-backed (alphabetically sorted output) unless the
 * `preserve_order` crate feature is enabled — which it is not anywhere in
 * `tamga-api`'s dependency graph (ground-truth-verified in `tamga-rust`'s
 * `src/proof.rs` module doc comment: no `indexmap` next to `serde_json` in
 * either repo's lockfile). So despite the server's source code literally
 * writing `{"account": ..., "machine": ..., "dataset": ...}` in that order,
 * the actual bytes on the wire are alphabetically sorted at *every*
 * nesting level: `{"account":...,"dataset":...,"machine":...}` (dataset
 * before machine), and within `machine`, `fingerprint` before `id`.
 *
 * `canonicalJsonStringify` recursively rebuilds every plain object with its
 * keys in sorted (`Array.prototype.sort`, default lexicographic) order
 * before calling `JSON.stringify` — since JS engines preserve insertion
 * order for string object keys, stringifying an already-key-sorted object
 * produces the same canonical order `serde_json`'s `BTreeMap` does. This is
 * correct for the ASCII field names this protocol actually uses (`account`,
 * `machine`, `dataset`, `id`, `fingerprint`, and caller-supplied dataset
 * keys) — Rust's byte-wise `Ord` and JS's UTF-16-code-unit `sort()` agree
 * for the ASCII range.
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

/** Recursively rebuilds `value`, sorting object keys alphabetically at every level. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sortedKeys = Object.keys(source).sort();
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
