import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { PidTakenError } from "../src/errors.js";
import { mockJsonApiResponse, mockApiError, lastCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.createProcess", () => {
  it("sends pid as a string even when the caller passes a numeric literal", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "p-1",
      type: "processes",
      attributes: { pid: "1234", machine_id: "m-1" },
    });

    const process = await client().createProcess("m-1", 1234);
    expect(process.attributes.pid).toBe("1234");
    expect(typeof process.attributes.pid).toBe("string");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/processes");
    const body = sentJsonBody(init) as { pid: unknown };
    expect(body.pid).toBe("1234");
    expect(typeof body.pid).toBe("string");
  });

  it("passes a string pid through unchanged", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "p-1",
      type: "processes",
      attributes: { pid: "5678" },
    });
    await client().createProcess("m-1", "5678");
    const [, init] = lastCall(fetchMock);
    expect(sentJsonBody(init)).toMatchObject({ pid: "5678" });
  });

  it("surfaces PID_TAKEN as a typed error on a duplicate pid", async () => {
    mockApiError(409, "PID_TAKEN");
    await expect(client().createProcess("m-1", 1234)).rejects.toBeInstanceOf(PidTakenError);
  });
});
