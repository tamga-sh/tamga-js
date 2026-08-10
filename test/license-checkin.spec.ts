import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { CheckInNotRequiredError } from "../src/errors.js";
import { mockJsonApiResponse, mockApiError, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.checkIn", () => {
  it("updates the license resource with a bumped last_check_in_at", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "lic-1",
      type: "licenses",
      attributes: { last_check_in_at: "2026-01-01T00:00:00Z" },
    });

    const license = await client().checkIn("lic-1");
    expect(license.attributes.last_check_in_at).toBe("2026-01-01T00:00:00Z");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/actions/check-in");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("surfaces CHECK_IN_NOT_REQUIRED as a typed error, not retried", async () => {
    mockApiError(422, "CHECK_IN_NOT_REQUIRED", "this license's policy does not require check-in");
    await expect(client().checkIn("lic-1")).rejects.toBeInstanceOf(CheckInNotRequiredError);
  });
});
