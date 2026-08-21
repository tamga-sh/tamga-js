import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse } from "./helpers/mockFetch.js";

/**
 * Serves one `machines` resource per call, walking `statuses` and repeating
 * the last entry once exhausted. Records what it actually served so a test
 * can assert the scheduler really did observe a `DEAD` response — a shared
 * `Response` instance cannot be read twice, so each call gets a fresh one.
 */
function mockHeartbeatStatusSequence(statuses: readonly string[]): {
  fetchMock: Mock;
  served: string[];
} {
  const served: string[] = [];
  const fetchMock = vi.fn().mockImplementation(() => {
    const status = statuses[Math.min(served.length, statuses.length - 1)] ?? "ALIVE";
    served.push(status);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: { id: "m-1", type: "machines", attributes: { heartbeat_status: status } },
        }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      ),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, served };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.startHeartbeat", () => {
  it("pings on the configured interval until stopped", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "m-1",
      type: "machines",
      attributes: { heartbeat_status: "ALIVE" },
    });

    const stop = client().startHeartbeat("m-1", 1000);

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps pinging across three consecutive DEAD responses", async () => {
    // Regression guard. `DEAD` means only "last ping older than the
    // heartbeat window" — the row is NOT culled (culling needs a policy with
    // `require_heartbeat = true`, which is not the default) and the very
    // ping that reports `DEAD` already revived the machine. A scheduler
    // that stopped, cleared itself or short-circuited here would abandon a
    // machine that is still perfectly alive. The fourth response comes back
    // `ALIVE` precisely because the timer never stopped.
    const { fetchMock, served } = mockHeartbeatStatusSequence(["DEAD", "DEAD", "DEAD", "ALIVE"]);

    const stop = client().startHeartbeat("m-1", 1000);

    await vi.advanceTimersByTimeAsync(3000);
    expect(served).toEqual(["DEAD", "DEAD", "DEAD"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1000);
    expect(served).toEqual(["DEAD", "DEAD", "DEAD", "ALIVE"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the timer running through a 404, which it cannot surface", async () => {
    // A `404 NOT_FOUND` from the ping is the only real "the row is gone"
    // signal, but `startHeartbeat` swallows every ping failure — so it keeps
    // pinging a deleted machine. Callers that need to re-activate have to
    // drive `pingHeartbeat` themselves and catch `NotFoundError`; this test
    // pins that documented tradeoff.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            errors: [{ id: "e1", status: "404", code: "NOT_FOUND", title: "NOT_FOUND", detail: "gone" }],
          }),
          { status: 404, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stop = client().startHeartbeat("m-1", 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
  });

  it("keeps the timer running through a single failed ping", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const stop = client().startHeartbeat("m-1", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
  });
});
