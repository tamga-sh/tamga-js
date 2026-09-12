/**
 * The three new entitlement-meter actions from the entitlement-metering
 * migration (§2.5 of `docs/entitlement-metering-migration.md`):
 * `incrementEntitlementUsage` / `decrementEntitlementUsage` /
 * `resetEntitlementUsage`. Mirrors `pingHeartbeat`/`resetHeartbeat`'s own
 * test shape — bare/optional-body `POST .../actions/{verb}`, decoding back
 * into the full resource.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { MeterLimitExceededError } from "../src/errors.js";
import { jsonApi, mockJsonApiResponse, lastCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

const meterFixture = {
  id: "e-1",
  type: "entitlements",
  attributes: {
    name: "API Requests",
    code: "REQUESTS",
    kind: "meter",
    inherited: false,
    max_value: 1000,
    current_value: 3,
    metadata: {},
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  },
};

/** A `422 METER_LIMIT_EXCEEDED` naming the entitlement, per §2.5. */
function meterLimitExceeded(entitlementId: string): Response {
  return jsonApi(
    {
      errors: [
        {
          id: "e1",
          status: "422",
          code: "METER_LIMIT_EXCEEDED",
          title: "Unprocessable Entity",
          detail: "current_value + increment would exceed max_value",
          meta: { entitlement_id: entitlementId },
        },
      ],
    },
    422,
  );
}

describe("TamgaClient.incrementEntitlementUsage", () => {
  it("sends a POST to increment with no body when increment is omitted", async () => {
    const fetchMock = mockJsonApiResponse(meterFixture);
    const entitlement = await client().incrementEntitlementUsage("lic-1", "e-1");
    expect(entitlement.attributes.current_value).toBe(3);

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/entitlements/e-1/actions/increment");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("sends the increment amount in the body when given", async () => {
    const fetchMock = mockJsonApiResponse({
      ...meterFixture,
      attributes: { ...meterFixture.attributes, current_value: 6 },
    });
    const entitlement = await client().incrementEntitlementUsage("lic-1", "e-1", 3);
    expect(entitlement.attributes.current_value).toBe(6);

    const [, init] = lastCall(fetchMock);
    expect(sentJsonBody(init)).toEqual({ increment: 3 });
  });

  it("rejects with MeterLimitExceededError, exposing entitlementId from meta.entitlement_id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(meterLimitExceeded("e-1")));

    const error = await client()
      .incrementEntitlementUsage("lic-1", "e-1", 5)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MeterLimitExceededError);
    expect((error as MeterLimitExceededError).entitlementId).toBe("e-1");
    expect((error as MeterLimitExceededError).code).toBe("METER_LIMIT_EXCEEDED");
  });
});

describe("TamgaClient.decrementEntitlementUsage", () => {
  it("sends a POST to decrement with no body when decrement is omitted", async () => {
    const fetchMock = mockJsonApiResponse({
      ...meterFixture,
      attributes: { ...meterFixture.attributes, current_value: 2 },
    });
    const entitlement = await client().decrementEntitlementUsage("lic-1", "e-1");
    expect(entitlement.attributes.current_value).toBe(2);

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/entitlements/e-1/actions/decrement");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("sends the decrement amount in the body when given", async () => {
    const fetchMock = mockJsonApiResponse({
      ...meterFixture,
      attributes: { ...meterFixture.attributes, current_value: 0 },
    });
    const entitlement = await client().decrementEntitlementUsage("lic-1", "e-1", 3);
    expect(entitlement.attributes.current_value).toBe(0);

    const [, init] = lastCall(fetchMock);
    expect(sentJsonBody(init)).toEqual({ decrement: 3 });
  });
});

describe("TamgaClient.resetEntitlementUsage", () => {
  it("sends a no-body POST to reset", async () => {
    const fetchMock = mockJsonApiResponse({
      ...meterFixture,
      attributes: { ...meterFixture.attributes, current_value: 0 },
    });
    const entitlement = await client().resetEntitlementUsage("lic-1", "e-1");
    expect(entitlement.attributes.current_value).toBe(0);

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/entitlements/e-1/actions/reset");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});
