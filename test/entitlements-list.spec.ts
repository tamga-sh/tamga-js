import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient, MAX_PAGE_SIZE } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.listEntitlements", () => {
  it("sends limit but never page[after] — the server ignores the cursor on this route", async () => {
    const fetchMock = mockJsonApiResponse([
      { id: "e-1", type: "entitlements", attributes: { name: "Pro", code: "PRO" } },
    ]);

    const entitlements = await client().listEntitlements("lic-1", { limit: 25, after: "e-0" });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]?.attributes.code).toBe("PRO");

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/entitlements");
    expect(url.searchParams.get("limit")).toBe("25");
    // Sending it would silently re-request page one forever: the listing is a
    // union of direct and policy-inherited rows, so no single keyset cursor
    // describes it and the server drops the parameter.
    expect(url.searchParams.has("page[after]")).toBe(false);
  });

  it("sends the server maximum as limit when none is supplied, rather than letting it default to 25", async () => {
    const fetchMock = mockJsonApiResponse([]);
    await client().listEntitlements("lic-1");
    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("limit")).toBe(String(MAX_PAGE_SIZE));
  });

  it("surfaces the inherited flag on a policy-inherited entitlement", async () => {
    mockJsonApiResponse([
      { id: "e-1", type: "entitlements", attributes: { name: "Pro", code: "PRO", inherited: false } },
      { id: "e-2", type: "entitlements", attributes: { name: "Beta", code: "BETA", inherited: true } },
    ]);

    const entitlements = await client().listEntitlements("lic-1");
    expect(entitlements[0]?.attributes.inherited).toBe(false);
    expect(entitlements[1]?.attributes.inherited).toBe(true);
  });
});
