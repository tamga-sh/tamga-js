import { describe, expect, it } from "vitest";
import { TamgaClient } from "../src/index.js";

/**
 * Placeholder so `vitest` has something to run before real feature work
 * lands (docs/plans/tamga-js.plan.md Section A). Replace/expand alongside
 * `src/client.ts` once Section B's constructor validation is implemented —
 * at that point this test's expectations will need to change (right now
 * the stub constructor performs no validation).
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
