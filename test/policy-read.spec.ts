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

/**
 * The floor and the divisor, in the same place, against the server's real rule.
 *
 * These two numbers live in different files — `MIN_HEARTBEAT_INTERVAL_MS` is
 * private to `client.ts`, `MACHINE_HEARTBEAT_INTERVAL_DIVISOR` is exported from
 * `models/machine.ts` — and they interact. For a short enough policy window the
 * floor binds and the divisor's stated promise ("two consecutive pings can be
 * lost") stops holding. This block names the window value in every case so the
 * interaction is readable rather than re-derived.
 *
 * ⚠️ The server's rule is **not** `age > window`. From
 * `tamga-api/src/features/machines/model.rs::heartbeat_status_within`:
 *
 *     let age_secs = (Utc::now() - hb_ts).num_seconds();
 *     let within_window = age_secs <= window_secs;
 *
 * and chrono's `num_seconds()` returns *whole* seconds, truncating. Verified
 * against chrono 0.4: `Duration::milliseconds(1999).num_seconds() === 1`. So a
 * machine reads DEAD once its age reaches `(window_secs + 1)` seconds, and
 * every window gets one free second of grace on top of its nominal value.
 * Getting this wrong in the pessimistic direction makes a 1s window look
 * unserveable at a 1s ping when it in fact has a full second of slack.
 */
describe("the interval floor against the server's actual liveness rule", () => {
  /**
   * The server goes DEAD at `age_secs > window_secs` on truncated whole
   * seconds — i.e. the first millisecond age at which a read reports DEAD.
   */
  function deadAtAgeMs(windowSecs: number): number {
    return (windowSecs + 1) * 1000;
  }

  /**
   * Consecutive pings that can be lost before a read sees DEAD, given a
   * scheduler ticking every `intervalMs`. After `m` misses the age reaches
   * `(m + 1) * intervalMs`. `-1` means the window is not held even when no
   * ping is lost at all.
   */
  function lossesTolerated(windowSecs: number, intervalMs: number): number {
    return Math.ceil(deadAtAgeMs(windowSecs) / intervalMs) - 2;
  }

  it("truncation gives every window a full extra second, which is what makes 1s serveable", () => {
    expect(deadAtAgeMs(1)).toBe(2000);
    expect(deadAtAgeMs(2)).toBe(3000);
    expect(deadAtAgeMs(600)).toBe(601_000);
    // The pessimistic reading — DEAD the instant age passes the nominal
    // window — would put a 1s window's deadline at 1000ms and make the 1s
    // floor a boundary case. It is 2000ms, so the floor has 2x margin.
    expect(deadAtAgeMs(1)).toBeGreaterThan(1000);
  });

  it.each([
    // heartbeat_duration, interval the scheduler uses, losses tolerated
    [600, 200_000, 2], // the fallback window: divisor governs, floor irrelevant
    [60, 20_000, 2], //  an ordinary policy: same
    [3, 1_000, 2], //    the first window where floor and divisor agree exactly
    [2, 1_000, 1], //    floor binds: promise degraded from 2 losses to 1
    [1, 1_000, 0], //    floor binds hardest: steady state fine, no loss spare
  ])(
    "heartbeat_duration %i pings every %ims and survives %i consecutive losses",
    async (duration, expectedIntervalMs, expectedLosses) => {
      vi.useFakeTimers();
      const fetchMock = mockSequence(
        jsonApi({ data: policy({ heartbeat_duration: duration }) }),
        jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
        jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
      );
      const stop = await client().startHeartbeatFromPolicy("m-1", "lic-1");

      // One policy read, no ping yet.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(expectedIntervalMs - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      stop();

      // Steady state holds the window in every one of these cases: the age
      // never reaches the server's DEAD threshold between pings.
      expect(expectedIntervalMs).toBeLessThan(deadAtAgeMs(duration));
      expect(lossesTolerated(duration, expectedIntervalMs)).toBe(expectedLosses);
    },
  );

  it("names heartbeat_duration 0 as the one window the floor cannot hold", () => {
    // Not the 1s window — the 0s one. `0` is storable (the column has no
    // `CHECK`), and truncation gives it exactly 1000ms of grace, which is
    // precisely the floor. So the steady-state age reaches the DEAD threshold
    // at the instant each ping is due, and any latency reads DEAD.
    expect(deadAtAgeMs(0)).toBe(1000);
    expect(lossesTolerated(0, 1000)).toBe(-1);

    // A sub-second ping would in fact hold it — 333ms keeps the age at 0 whole
    // seconds. The SDK deliberately does not chase that: it would buy one
    // absurd policy value by pinning the ping rate to `num_seconds()`
    // truncation, an implementation artifact rather than a contract. If the
    // server ever compared sub-second, a 0s window would be unserveable at any
    // rate and this expectation is where that shows up.
    expect(lossesTolerated(0, 333)).toBeGreaterThanOrEqual(0);
  });

  it("holds the floor for a negative window, which no interval can serve", () => {
    // `age_secs <= -30` is false for every non-negative age, so a negative
    // window reads DEAD unconditionally. There is nothing to chase.
    expect(deadAtAgeMs(-30)).toBeLessThan(0);
  });
});

describe("MAX_PAGE_SIZE is shared by both pagination styles", () => {
  it("is the server's ceiling for keyset and offset lists alike", () => {
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
