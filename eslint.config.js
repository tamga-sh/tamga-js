// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config (ESLint 9+). Scoped to `src/` and `test/` — build
 * output (`dist/`) and config files at the repo root are ignored below.
 *
 * `no-console` is enforced because this is a library, not an app: consumers
 * own their own logging, and a stray `console.log` left in library code
 * ships to every downstream install.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
