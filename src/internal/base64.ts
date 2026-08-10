/**
 * Cross-runtime standard base64 encode/decode. Not part of the public API —
 * an internal helper shared by `src/checkout/*.ts` and `src/proof.ts`.
 *
 * Uses `Buffer` when available (Node.js/Bun/Deno's Node-compat layer) and
 * falls back to `atob`/`btoa` (browser, and Deno's own globals) otherwise —
 * both paths produce identical standard (non-URL-safe) base64.
 */

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Encodes `bytes` as a standard base64 string. */
export function base64Encode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decodes a standard base64 string to bytes. Throws `Error` for malformed
 * base64 (non-alphabet characters, wrong padding) — callers map this to a
 * typed {@link import("../errors.js").CheckoutError}/{@link
 * import("../errors.js").ProofError}.
 */
export function base64Decode(b64: string): Uint8Array {
  const trimmed = b64.trim();
  if (!BASE64_PATTERN.test(trimmed)) {
    throw new Error("invalid base64 input");
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(trimmed, "base64"));
  }
  const binary = atob(trimmed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
