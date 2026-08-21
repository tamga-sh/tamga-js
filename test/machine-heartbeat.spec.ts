import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { NotFoundError } from "../src/errors.js";
import { mockJsonApiResponse, mockApiError, lastCall } from "./helpers/mockFetch.js";

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

describe("pingHeartbeat against a DEAD machine", () => {
  it("succeeds and revives it — DEAD is not a terminal state", async () => {
    // The ping handler is a bare `last_heartbeat_at = now` write with no
    // resurrection check, so a DEAD machine answers a ping normally and
    // comes back RESURRECTED. Nothing about DEAD implies the row was culled:
    // culling only runs under a `require_heartbeat = true` policy, which is
    // not the default.
    const fetchMock = mockJsonApiResponse({
      ...machineFixture,
      attributes: { ...machineFixture.attributes, heartbeat_status: "RESURRECTED" },
    });

    const machine = await client().pingHeartbeat("m-1");

    expect(machine.attributes.heartbeat_status).toBe("RESURRECTED");
    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/actions/ping-heartbeat");
  });

  it("rejects with NotFoundError once the row really is gone", async () => {
    // This 404 — not a DEAD status — is the signal that the machine row was
    // removed, and the only thing a client should hang re-activation off.
    mockApiError(404, "NOT_FOUND", "machine not found");

    await expect(client().pingHeartbeat("m-1")).rejects.toBeInstanceOf(NotFoundError);
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
