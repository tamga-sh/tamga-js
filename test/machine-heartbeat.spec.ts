import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

const machineFixture = {
  id: "m-1",
  type: "machines",
  attributes: { fingerprint: "fp-1", heartbeat_status: "ALIVE" },
};

describe("TamgaClient.pingHeartbeat", () => {
  it("sends a no-body POST to ping-heartbeat", async () => {
    const fetchMock = mockJsonApiResponse(machineFixture);
    const machine = await client().pingHeartbeat("m-1");
    expect(machine.attributes.heartbeat_status).toBe("ALIVE");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/actions/ping-heartbeat");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("TamgaClient.resetHeartbeat", () => {
  it("sends a no-body POST to reset-heartbeat", async () => {
    const fetchMock = mockJsonApiResponse({
      ...machineFixture,
      attributes: { ...machineFixture.attributes, heartbeat_status: "NOT_STARTED" },
    });
    const machine = await client().resetHeartbeat("m-1");
    expect(machine.attributes.heartbeat_status).toBe("NOT_STARTED");

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/actions/reset-heartbeat");
  });
});
