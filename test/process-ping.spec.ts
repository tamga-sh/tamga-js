import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.pingProcess", () => {
  it("sends a no-body POST to the process ping action", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "p-1",
      type: "processes",
      attributes: { pid: "1234" },
    });

    await client().pingProcess("p-1");
    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/processes/p-1/actions/ping");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});
