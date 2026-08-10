import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.listComponents", () => {
  it("sends limit and page[after] keyset pagination params", async () => {
    const fetchMock = mockJsonApiResponse([
      { id: "c-1", type: "components", attributes: { fingerprint: "fp-1" } },
    ]);

    const components = await client().listComponents("m-1", { limit: 50, after: "c-0" });
    expect(components).toHaveLength(1);

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/components");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("page[after]")).toBe("c-0");
  });

  it("omits pagination params when not supplied", async () => {
    const fetchMock = mockJsonApiResponse([]);
    await client().listComponents("m-1");
    const [url] = lastCall(fetchMock);
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("page[after]")).toBe(false);
  });
});
