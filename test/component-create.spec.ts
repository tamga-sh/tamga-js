import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { FingerprintTakenError } from "../src/errors.js";
import { mockJsonApiResponse, mockApiError, lastCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.createComponent", () => {
  it("sends a flat (non-JSON:API) request body", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "c-1",
      type: "components",
      attributes: { fingerprint: "cfp-1", name: "GPU", machine_id: "m-1" },
    });

    const component = await client().createComponent("m-1", "cfp-1", "GPU");
    expect(component.attributes.name).toBe("GPU");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/components");
    expect(sentJsonBody(init)).toEqual({
      machine_id: "m-1",
      fingerprint: "cfp-1",
      name: "GPU",
      metadata: {},
    });
  });

  it("required-field validation is the caller's responsibility at the type level (fingerprint/name required)", async () => {
    mockJsonApiResponse({ id: "c-1", type: "components", attributes: {} });
    // TypeScript enforces fingerprint/name as required parameters — this
    // test documents that contract rather than a runtime check.
    await client().createComponent("m-1", "cfp-1", "GPU");
  });

  it("surfaces FINGERPRINT_TAKEN as a typed error on a duplicate component", async () => {
    mockApiError(409, "FINGERPRINT_TAKEN");
    await expect(client().createComponent("m-1", "cfp-1", "GPU")).rejects.toBeInstanceOf(
      FingerprintTakenError,
    );
  });
});
