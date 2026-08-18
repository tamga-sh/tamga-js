import { describe, expect, it } from "vitest";
import { TamgaClient } from "../src/index.js";

/**
 * The narrowest possible check that the package's public entrypoint is
 * importable and `TamgaClient` retains the config it was constructed with.
 * Constructor validation itself is covered by `scripts/smoke.mjs`, which runs
 * the same assertions against the built `dist/` output on Deno and Bun.
 */
describe("smoke", () => {
  it("constructs a TamgaClient and stores the config it was given", () => {
    const client = new TamgaClient({
      accountId: "acct_test",
      baseUrl: "https://api.tamga.sh",
    });

    expect(client.config.accountId).toBe("acct_test");
    expect(client.config.baseUrl).toBe("https://api.tamga.sh");
  });
});
