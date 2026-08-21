/**
 * Process teardown — `deleteProcess`, `listMachineProcesses`, and `dispose`.
 *
 * These exist because nothing on the server cleans up after a client. The
 * process reaper (`find_and_claim_dead_processes` /
 * `process_process_heartbeat`) is written and tested but the job scheduler's
 * `dispatch` has no arm that calls it, so a stale process row persists forever
 * — holding a seat against `policy.max_processes`, which only an explicit
 * delete decrements.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient } from "../src/client.js";
import { NotFoundError } from "../src/errors.js";
import { errorDoc, jsonApi, lastCall, mockSequence } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

const processFixture = {
  id: "prc-1",
  type: "processes",
  attributes: { pid: "4242", machine_id: "m-1" },
};

describe("TamgaClient.deleteProcess", () => {
  it("issues a DELETE against the process resource", async () => {
    const fetchMock = mockSequence(new Response(null, { status: 204 }));
    await client().deleteProcess("prc-1");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/processes/prc-1");
    expect(init.method).toBe("DELETE");
  });

  it("surfaces a repeat delete as NotFoundError, which teardown can ignore", async () => {
    mockSequence(errorDoc(404, "NOT_FOUND", "process not found"));
    await expect(client().deleteProcess("prc-1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("TamgaClient.listMachineProcesses", () => {
  it("uses keyset pagination — limit and page[after], not page[number]", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [processFixture] }));
    await client().listMachineProcesses("m-1", { limit: 10, after: "prc-0" });

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/processes");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("page[after]")).toBe("prc-0");
    expect(url.searchParams.has("page[number]")).toBe(false);
  });

  it("sends the server maximum rather than falling into the silent 25", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [] }));
    await client().listMachineProcesses("m-1");

    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.has("page[after]")).toBe(false);
  });

  it("keeps pid a string, as the wire has it", async () => {
    mockSequence(jsonApi({ data: [processFixture] }));
    const [first] = await client().listMachineProcesses("m-1");
    expect(first?.attributes.pid).toBe("4242");
  });
});

describe("TamgaClient.dispose", () => {
  it("stops timers the caller never held a stop function for", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(
      jsonApi({ data: processFixture }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const c = client();
    c.startProcessHeartbeat("prc-1", 1_000);
    c.startHeartbeat("m-1", 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    c.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is idempotent and safe alongside the returned stop functions", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }));
    const c = client();
    const stop = c.startHeartbeat("m-1", 1_000);

    stop();
    stop();
    c.dispose();
    c.dispose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a client usable — dispose ends timers, not the client", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const c = client();
    c.startHeartbeat("m-1", 1_000);
    c.dispose();

    c.startHeartbeat("m-1", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("clears a timer started by startHeartbeatFromPolicy too", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(
      jsonApi({ data: { id: "pol-1", type: "policies", attributes: { heartbeat_duration: 60 } } }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const c = client();
    await c.startHeartbeatFromPolicy("m-1", "lic-1");
    c.dispose();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
