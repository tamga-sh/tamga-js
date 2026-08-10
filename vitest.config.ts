import { defineConfig } from "vitest/config";

/**
 * Vitest config for @tamga/sdk. Coverage thresholds are set to 80% across
 * the board and gate CI (`pnpm test:coverage` in .github/workflows/ci.yml)
 * — this mirrors the 80% bar used elsewhere across the Tamga SDK family.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
