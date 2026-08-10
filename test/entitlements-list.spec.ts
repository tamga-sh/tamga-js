import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.listEntitlements", () => {
  it("sends limit and page[after] keyset pagination params", async () => {
    const fetchMock = mockJsonApiResponse([
      { id: "e-1", type: "entitlements", attributes: { name: "Pro", code: "PRO" } },
    ]);

    const entitlements = await client().listEntitlements("lic-1", { limit: 25, after: "e-0" });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]?.attributes.code).toBe("PRO");

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/entitlements");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("page[after]")).toBe("e-0");
  });
});
