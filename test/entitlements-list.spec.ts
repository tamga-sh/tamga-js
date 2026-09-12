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

  it("surfaces kind, max_value and current_value on a license-scoped meter entitlement", async () => {
    mockJsonApiResponse([
      {
        id: "e-1",
        type: "entitlements",
        attributes: {
          name: "API Requests",
          code: "REQUESTS",
          kind: "meter",
          inherited: false,
          max_value: 1000,
          current_value: 650,
          metadata: {},
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    const [entitlement] = await client().listEntitlements("lic-1");
    expect(entitlement?.attributes.kind).toBe("meter");
    expect(entitlement?.attributes.max_value).toBe(1000);
    expect(entitlement?.attributes.current_value).toBe(650);
  });

  it("surfaces kind: 'flag' on a license-scoped flag entitlement, with max_value null (unlimited)", async () => {
    mockJsonApiResponse([
      {
        id: "e-2",
        type: "entitlements",
        attributes: {
          name: "Pro Plan",
          code: "PRO",
          kind: "flag",
          inherited: true,
          max_value: null,
          current_value: 0,
          metadata: {},
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    const [entitlement] = await client().listEntitlements("lic-1");
    expect(entitlement?.attributes.kind).toBe("flag");
    expect(entitlement?.attributes.max_value).toBeNull();
  });

  it("a policy-scoped entitlement fixture carries max_value but no current_value or inherited", () => {
    // This SDK has no policy-scoped entitlement-listing method today, so this
    // is a model-level check: the policy-scoped shape (§2.3 of the migration
    // doc) is a subset of the license-scoped one — `max_value` only, no
    // `current_value`, no `inherited` — which the single flat
    // `EntitlementAttributes` interface (all three fields optional) admits
    // without a dedicated type.
    const policyScoped: import("../src/models/license.js").EntitlementAttributes = {
      name: "API Requests",
      code: "REQUESTS",
      kind: "meter",
      max_value: 1000,
      metadata: {},
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    };

    expect(policyScoped.max_value).toBe(1000);
    expect(policyScoped.current_value).toBeUndefined();
    expect(policyScoped.inherited).toBeUndefined();
  });
});
