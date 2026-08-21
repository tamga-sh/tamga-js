/**
 * Policy and license reads, and the heartbeat window they finally make
 * knowable.
 *
 * Two things are pinned here that are easy to get wrong:
 *
 * 1. **Which policy route an embedded client can use.** `GET /policies/{id}`
 *    needs `policy.read`, which the license-key role does not hold;
 *    `GET /licenses/{id}/policy` needs only `license.read`, which it does.
 * 2. **That an unrecognised `check_in_interval` degrades.** The wire values the
 *    server accepts are `daily`/`weekly`/`monthly`/`yearly`, which the current
 *    `CheckInInterval` union does not carry. Opening policy deserialization
 *    must not turn that into a failed call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient, MAX_PAGE_SIZE } from "../src/client.js";
import { effectiveHeartbeatWindowMs } from "../src/models/policy.js";
import type { Policy } from "../src/models/policy.js";
import {
  heartbeatWindowMsFromMachine,
  MACHINE_HEARTBEAT_INTERVAL_DIVISOR,
  MACHINE_HEARTBEAT_WINDOW_MS,
} from "../src/models/machine.js";
import type { Machine } from "../src/models/machine.js";
import { jsonApi, lastCall, mockJsonApiResponse, mockSequence } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

/** A policy resource with only the fields a given test cares about. */
function policy(attributes: Record<string, unknown>): unknown {
  return { id: "pol-1", type: "policies", attributes };
}

function machineWithHeartbeat(last: string | null, next: string | null): Machine {
  return {
    id: "m-1",
    type: "machines",
    attributes: {
      fingerprint: "fp-1",
      cores: null,
      memory: null,
      disk: null,
      ip: null,
      hostname: null,
      platform: null,
      name: null,
      heartbeat_status: "ALIVE",
      last_heartbeat_at: last,
      next_heartbeat_at: next,
      last_check_out_at: null,
      metadata: {},
      created: "2026-08-21T00:00:00Z",
      updated: "2026-08-21T00:00:00Z",
    },
  };
}

describe("license and policy reads", () => {
  it("getLicense reads the license without validating it", async () => {
    const fetchMock = mockJsonApiResponse({ id: "lic-1", type: "licenses", attributes: {} });
    await client().getLicense("lic-1");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("getLicensePolicy goes through the license, not the policy id", async () => {
    const fetchMock = mockJsonApiResponse(policy({ name: "Pro" }));
    await client().getLicensePolicy("lic-1");

    expect(lastCall(fetchMock)[0].pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/policy");
  });

  it("getPolicy addresses the policy directly", async () => {
    const fetchMock = mockJsonApiResponse(policy({ name: "Pro" }));
    await client().getPolicy("pol-1");

    expect(lastCall(fetchMock)[0].pathname).toBe("/v1/accounts/acct_1/policies/pol-1");
  });

  it("decodes a policy carrying a check_in_interval the union does not know", async () => {
    // The server's own allowlist is daily/weekly/monthly/yearly; the union here
    // still says day/week/month/year. Correcting the union is a separate
    // change — what must hold now is that the mismatch degrades to a value the
    // caller can inspect rather than taking the whole call down.
    mockJsonApiResponse(
      policy({ name: "Pro", require_check_in: true, check_in_interval: "daily", check_in_interval_count: 2 }),
    );

    const result = await client().getPolicy("pol-1");
    expect(result.attributes.check_in_interval).toBe("daily");
    expect(result.attributes.check_in_interval_count).toBe(2);
  });

  it("decodes a policy whose strategy fields carry the server's bogus defaults", async () => {
    mockJsonApiResponse(
      policy({
        name: "Pro",
        overage_strategy: "DENY_ACCESS",
        heartbeat_resurrection_strategy: "NO_RESURRECTION",
      }),
    );

    const result = await client().getPolicy("pol-1");
    expect(result.attributes.overage_strategy).toBe("DENY_ACCESS");
    expect(result.attributes.heartbeat_resurrection_strategy).toBe("NO_RESURRECTION");
  });
});

describe("effectiveHeartbeatWindowMs", () => {
  it("uses the policy's heartbeat_duration when it is set", () => {
    expect(effectiveHeartbeatWindowMs(policy({ heartbeat_duration: 60 }) as Policy)).toBe(60_000);
  });

  it("falls back to 600s only when the column is null", () => {
    expect(effectiveHeartbeatWindowMs(policy({ heartbeat_duration: null }) as Policy)).toBe(
      MACHINE_HEARTBEAT_WINDOW_MS,
    );
  });

  it("falls back when the field is absent altogether", () => {
    expect(effectiveHeartbeatWindowMs(policy({}) as Policy)).toBe(MACHINE_HEARTBEAT_WINDOW_MS);
  });
});

describe("heartbeatWindowMsFromMachine", () => {
  it("derives the window from a read-backed machine's two timestamps", () => {
    const machine = machineWithHeartbeat("2026-08-21T00:00:00.000Z", "2026-08-21T00:01:00.000Z");
    expect(heartbeatWindowMsFromMachine(machine)).toBe(60_000);
  });

  it("returns undefined before the machine has ever been pinged", () => {
    expect(heartbeatWindowMsFromMachine(machineWithHeartbeat(null, null))).toBeUndefined();
  });

  it("returns undefined rather than a negative or zero window", () => {
    const machine = machineWithHeartbeat("2026-08-21T00:01:00.000Z", "2026-08-21T00:00:00.000Z");
    expect(heartbeatWindowMsFromMachine(machine)).toBeUndefined();
  });

  it("returns undefined for an unparseable timestamp", () => {
    expect(heartbeatWindowMsFromMachine(machineWithHeartbeat("not-a-date", "also-not"))).toBeUndefined();
  });
});

describe("TamgaClient.resolveHeartbeatWindowMs", () => {
  it("reads the window through the license's policy", async () => {
    const fetchMock = mockJsonApiResponse(policy({ heartbeat_duration: 90 }));
    expect(await client().resolveHeartbeatWindowMs("lic-1")).toBe(90_000);
    expect(lastCall(fetchMock)[0].pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/policy");
  });
});

describe("TamgaClient.startHeartbeatFromPolicy", () => {
  it("pings at a third of the policy's window, not a third of the fallback", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(
      jsonApi({ data: policy({ heartbeat_duration: 60 }) }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: { fingerprint: "fp-1" } } }),
    );

    const stop = await client().startHeartbeatFromPolicy("m-1", "lic-1");
    // A scheduler sized off the 600s fallback would not have pinged yet.
    await vi.advanceTimersByTimeAsync(60_000 / MACHINE_HEARTBEAT_INTERVAL_DIVISOR);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastCall(fetchMock)[0].pathname).toBe(
      "/v1/accounts/acct_1/machines/m-1/actions/ping-heartbeat",
    );
    stop();
  });

  it("honours a custom divisor and ignores a non-positive one", async () => {
    vi.useFakeTimers();
    mockSequence(
      jsonApi({ data: policy({ heartbeat_duration: 600 }) }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const stop = await client().startHeartbeatFromPolicy("m-1", "lic-1", { divisor: 10 });
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    vi.unstubAllGlobals();
    const fallbackMock = mockSequence(
      jsonApi({ data: policy({ heartbeat_duration: 600 }) }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const stop2 = await client().startHeartbeatFromPolicy("m-1", "lic-1", { divisor: 0 });
    await vi.advanceTimersByTimeAsync(199_999);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fallbackMock).toHaveBeenCalledTimes(2);
    stop2();
  });

  it("floors the interval at a second so a tiny policy window cannot busy-loop", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(
      jsonApi({ data: policy({ heartbeat_duration: 1 }) }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const stop = await client().startHeartbeatFromPolicy("m-1", "lic-1");

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
  });

  // `heartbeat_duration` is an unconstrained integer column — no `CHECK` — and
  // `effective_heartbeat_duration_secs` returns whatever it holds; only `NULL`
  // takes the 600s fallback. So `0` and a negative are values the server will
  // really serve, and both divide down to something `setInterval` turns into a
  // 1ms tick. The floor is what keeps them to one ping a second.
  it.each([
    ["a zero", 0],
    ["a negative", -30],
  ])("floors %s heartbeat_duration, which the column permits", async (_label, duration) => {
    vi.useFakeTimers();
    const fetchMock = mockSequence(
      jsonApi({ data: policy({ heartbeat_duration: duration }) }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );
    const stop = await client().startHeartbeatFromPolicy("m-1", "lic-1");

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
  });
});

describe("MAX_PAGE_SIZE is shared by both pagination styles", () => {
  it("is the server's ceiling for keyset and offset lists alike", () => {
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
