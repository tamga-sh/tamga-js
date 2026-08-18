#!/usr/bin/env node
/**
 * Cross-runtime smoke test — run against the built `dist/index.js` ESM
 * output on Node, Deno, and Bun (see `.github/workflows/ci.yml`'s
 * `smoke` job) to catch runtime-incompatible syntax or API usage that
 * Node-only vitest coverage would miss.
 *
 * No network calls — this only proves the built ESM entrypoint loads
 * without throwing on each runtime and that `TamgaClient`'s constructor
 * validation actually runs.
 */

import { TamgaClient } from "../dist/index.js";

const client = new TamgaClient({
  accountId: "acct_smoke",
  baseUrl: "https://api.tamga.sh",
  auth: { kind: "license", key: "lic-smoke" },
});

if (client.config.accountId !== "acct_smoke") {
  throw new Error("smoke test failed: TamgaClient did not retain its config");
}

try {
  // eslint-disable-next-line no-new -- constructing to observe the thrown validation error
  new TamgaClient({ accountId: "", baseUrl: "https://api.tamga.sh" });
  throw new Error("smoke test failed: expected TamgaClient to throw on empty accountId");
} catch (err) {
  if (!(err instanceof Error) || !err.message.includes("accountId")) {
    throw err;
  }
}

// Not linted by `pnpm lint` (scoped to src/test — see eslint.config.js);
// console output is fine here, this is a script, not library code.
console.log("smoke: dist/index.js loaded, TamgaClient constructed, and constructor validation ran OK");
