import { defineConfig } from "tsup";

/**
 * Build config for @tamga/sdk.
 *
 * Dual ESM/CJS output is required because this SDK targets four runtimes
 * (Node 18+, Deno, Bun, browser) and Node consumers may still be on CJS.
 * `dts: true` emits `.d.ts` (ESM) and `.d.cts` (CJS) declaration files that
 * back the `exports` map in package.json — keep the two in sync if the
 * entrypoint list ever changes.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
