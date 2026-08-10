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
 */

/** Recursively rebuilds `value`, sorting object keys alphabetically at every level. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sortedKeys = Object.keys(source).sort();
    const result: Record<string, unknown> = {};
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
