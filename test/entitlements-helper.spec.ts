import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.hasEntitlement", () => {
  it("matches by code", async () => {
    mockJsonApiResponse([
      { id: "e-1", type: "entitlements", attributes: { name: "Pro Plan", code: "PRO" } },
    ]);
    expect(await client().hasEntitlement("lic-1", "PRO")).toBe(true);
  });

  it("ignores name collisions — never matches on name", async () => {
    mockJsonApiResponse([
      { id: "e-1", type: "entitlements", attributes: { name: "PRO", code: "premium-tier" } },
    ]);
    // The display name happens to equal the code we're searching for, but
    // the actual `code` field doesn't match — must return false.
    expect(await client().hasEntitlement("lic-1", "PRO")).toBe(false);
  });

  it("returns false when no entitlement matches", async () => {
    mockJsonApiResponse([]);
    expect(await client().hasEntitlement("lic-1", "PRO")).toBe(false);
  });

  it("defaults the page limit to 100", async () => {
    const fetchMock = mockJsonApiResponse([]);
    await client().hasEntitlement("lic-1", "PRO");
    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("limit")).toBe("100");
  });
});
