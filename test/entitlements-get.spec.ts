import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.getEntitlement", () => {
  it("gets a single entitlement by id", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "e-1",
      type: "entitlements",
      attributes: { name: "Pro", code: "PRO" },
    });

    const entitlement = await client().getEntitlement("lic-1", "e-1");
    expect(entitlement.attributes.code).toBe("PRO");

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/entitlements/e-1");
  });

  it("surfaces kind, max_value and current_value on a directly-attached meter entitlement", async () => {
    mockJsonApiResponse({
      id: "e-1",
      type: "entitlements",
      attributes: {
        name: "API Requests",
        code: "REQUESTS",
        kind: "meter",
        inherited: false,
        max_value: 500,
        current_value: 12,
        metadata: {},
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
    });

    const entitlement = await client().getEntitlement("lic-1", "e-1");
    expect(entitlement.attributes.kind).toBe("meter");
    expect(entitlement.attributes.max_value).toBe(500);
    expect(entitlement.attributes.current_value).toBe(12);
  });
});
