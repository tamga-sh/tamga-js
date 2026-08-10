/**
 * Cross-runtime WebCrypto accessor. Not part of the public API — an
 * internal helper shared by `src/crypto/aesGcm.ts` and `src/crypto/rsa.ts`.
 *
 * `globalThis.crypto` (the Web Crypto API exposed as a global, not via
 * `require("crypto")`/`import "node:crypto"`) is universal across Deno,
 * Bun, and browsers, but was only added to Node.js as a global starting in
 * Node 19 — Node 18 (this package's documented floor, `engines.node
 * ">=18"`) only exposes it via `node:crypto`'s `webcrypto` export, not as a
 * global.
 *
 * ⚠️ Deliberately a lazy async function, NOT a top-level-await constant.
 * This module is built to both ESM and CJS output (see `tsup.config.ts`)
 * and CJS does not support top-level await at all — `tsup`/Rollup fail the
 * CJS build outright if this resolves eagerly at module-evaluation time.
 * The dynamic `import("node:crypto")` is only ever reached (and only ever
 * awaited) inside a call to `getWebCrypto()`, which every caller already
 * awaits as part of an async WebCrypto operation — so this costs nothing
 * beyond the first call, after which the resolved value is cached.
 */
let webcryptoPromise: Promise<Crypto> | undefined;

export function getWebCrypto(): Promise<Crypto> {
  webcryptoPromise ??= globalThis.crypto
    ? Promise.resolve(globalThis.crypto)
    : import("node:crypto").then((m) => m.webcrypto as unknown as Crypto);
  return webcryptoPromise;
}
