import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.generateOfflineProof", () => {
  it("defaults dataset to {} when none is supplied", async () => {
    const fetchMock = mockJsonApiResponse(
      { id: "m-1", type: "machines", attributes: {} },
      { meta: { proof: "v1x0.abc" } },
    );

    const { proof } = await client().generateOfflineProof("m-1");
    expect(proof).toBe("v1x0.abc");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/actions/generate-offline-proof");
    expect(sentJsonBody(init)).toEqual({ meta: { dataset: {} } });
  });

  it("sends the caller-supplied dataset", async () => {
    const fetchMock = mockJsonApiResponse(
      { id: "m-1", type: "machines", attributes: {} },
      { meta: { proof: "v1x0.def" } },
    );
    await client().generateOfflineProof("m-1", { cores: 4 });
    const [, init] = lastCall(fetchMock);
    expect(sentJsonBody(init)).toEqual({ meta: { dataset: { cores: 4 } } });
  });
});
