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

    const stop = client().startProcessHeartbeat("p-1", 500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
