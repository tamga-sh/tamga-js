import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse } from "./helpers/mockFetch.js";
import { PROCESS_HEARTBEAT_WINDOW_MS } from "../src/models/machine.js";

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

describe("TamgaClient.startProcessHeartbeat", () => {
  it("defaults to a 10s interval, safely under the hardcoded 30s window", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "p-1",
      type: "processes",
      attributes: { pid: "1" },
    });

    const stop = client().startProcessHeartbeat("p-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();

    expect(10_000).toBeLessThan(PROCESS_HEARTBEAT_WINDOW_MS);
  });

  it("honors a custom interval and stops correctly", async () => {
    const fetchMock = mockJsonApiResponse({
      id: "p-1",
      type: "processes",
      attributes: { pid: "1" },
    });

    // Any interval at or above the 1s floor is passed through untouched.
    const stop = client().startProcessHeartbeat("p-1", 5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clamps a degenerate interval — same primitive, same busy loop", async () => {
    // This wraps the same unguarded `setInterval` as `startHeartbeat`. The
    // 10s default is safe, but an explicit `0` — or a `NaN` out of
    // caller-side arithmetic — would spin `POST /processes/{id}/actions/ping`
    // at event-loop speed in exactly the same way, so it takes the same
    // floor. 1s is still 30 pings inside the hardcoded 30s window.
    const fetchMock = mockJsonApiResponse({
      id: "p-1",
      type: "processes",
      attributes: { pid: "1" },
    });

    const stop = client().startProcessHeartbeat("p-1", 0);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();

    expect(1000).toBeLessThan(PROCESS_HEARTBEAT_WINDOW_MS);
  });
});
