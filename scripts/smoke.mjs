#!/usr/bin/env node
/**
 * Cross-runtime smoke test — run against the built `dist/index.js` ESM
 * output on Node, Deno, and Bun (see `.github/workflows/ci.yml`'s
 * `smoke` job) to catch runtime-incompatible syntax or API usage that
 * Node-only vitest coverage would miss.
 *
 * TODO (docs/plans/tamga-js.plan.md Section M): once `TamgaClient`'s
 * constructor validates `accountId`/`baseUrl` (Section B), replace this
 * placeholder with a real no-network assertion, e.g.:
 *
 *   import { TamgaClient } from "../dist/index.js";
 *   try {
 *     new TamgaClient({ accountId: "", baseUrl: "https://api.tamga.sh" });
 *     throw new Error("expected TamgaClient to throw on empty accountId");
 *   } catch (err) {
 *     if (!(err instanceof Error) || !err.message.includes("accountId")) {
 *       throw err;
 *     }
 *   }
 *
 * Until then, this only proves the built ESM entrypoint loads without
 * throwing on each runtime — a real assertion, not a no-op, but a much
 * weaker one than the TODO above.
 */

import { TamgaClient } from "../dist/index.js";

const client = new TamgaClient({
  accountId: "acct_smoke",
  baseUrl: "https://api.tamga.sh",
});

if (client.config.accountId !== "acct_smoke") {
  throw new Error("smoke test failed: TamgaClient did not retain its config");
}

// Not linted by `pnpm lint` (scoped to src/test — see eslint.config.js);
// console output is fine here, this is a script, not library code.
console.log("smoke: dist/index.js loaded and TamgaClient constructed OK");
