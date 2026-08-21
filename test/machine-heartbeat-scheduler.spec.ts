import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TamgaClient } from "../src/client.js";
import { MACHINE_HEARTBEAT_INTERVAL_DIVISOR } from "../src/models/machine.js";
import { jsonApi, mockJsonApiResponse, mockSequence } from "./helpers/mockFetch.js";

/**
 * Serves one `machines` resource per call, walking `statuses` and repeating
 * the last entry once exhausted. Records what it actually served so a test
 * can assert which statuses the scheduler was fed — a shared `Response`
 * instance cannot be read twice, so each call gets a fresh one.
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

  it("keeps pinging across three consecutive unexpected DEAD responses", async () => {
    // Regression guard for the defensive property: no status value stops the
    // timer. The fixture is deliberately synthetic for this route — a ping
    // cannot return `DEAD` (it writes `last_heartbeat_at = NOW()` and reports
    // `ALIVE`/`RESURRECTED`); `DEAD` reaches this SDK only through a
    // read-backed response such as a checked-out machine file. It is used
    // here precisely because it is the status a scheduler is most tempted to
    // treat as terminal: the callback discards the response, so not even an
    // unexpected one can abandon a machine that is still alive. The fourth
    // response comes back `ALIVE` only because the timer never stopped.
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

/**
 * The interval guard.
 *
 * `setInterval` does not honour a degenerate delay, it shortens it: `0`, a
 * negative number, `NaN`, `Infinity` and anything past the signed-32-bit
 * ceiling all tick every 1 ms. Unguarded, that is not a crash — it is roughly
 * a thousand `ping-heartbeat` requests a second, indefinitely, every one of
 * them individually valid and correctly authenticated. Nothing about it looks
 * like a failure from either end, which is what makes it worse than a crash.
 *
 * `startHeartbeatFromPolicy` already floored its own arithmetic. These pin the
 * floor one level down, in the primitive, where it holds however a caller
 * reaches the timer.
 */
describe("TamgaClient.startHeartbeat cannot be turned into a busy loop", () => {
  const degenerate: ReadonlyArray<readonly [string, number]> = [
    ["zero", 0],
    ["a negative interval", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];

  it.each(degenerate)("pings once a second when handed %s, not once a millisecond", async (
    _label,
    intervalMs,
  ) => {
    const fetchMock = mockJsonApiResponse({
      id: "m-1",
      type: "machines",
      attributes: { heartbeat_status: "ALIVE" },
    });

    const stop = client().startHeartbeat("m-1", intervalMs);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The sharp form of the claim: five seconds is five pings, not five
    // thousand.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("clamps past the 32-bit ceiling down to it, which is also a 1ms tick unguarded", async () => {
    // The ceiling is the same defect as the floor: `setInterval` does not
    // round an over-large delay down, it resets it to 1 ms (Node warns with
    // `TimeoutOverflowWarning`; browsers wrap the 32-bit value).
    const fetchMock = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });

    const stop = client().startHeartbeat("m-1", 2_147_483_648);

    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  /**
   * The case that decides the *shape* of the guard, not just its presence.
   *
   * A narrower rule — clamp only what `setInterval` refuses to honour, i.e.
   * non-positive, non-finite, past the ceiling — is tempting, because it
   * changes behaviour for no value the runtime honours. It is wrong, and `1`
   * is the counterexample: the runtime honours it exactly, and it is the same
   * flood as `0`. Measured on Node: `0` ticks at 1.4 ms, `1` at 1.35 ms —
   * ~740 pings a second either way. A rule that clamped `0` and passed `1`
   * through would give two inputs with identical observable behaviour
   * opposite treatment.
   *
   * If someone later narrows the guard to "degenerate values only", this test
   * is what fails.
   */
  it.each([
    ["1ms, which the runtime honours exactly and is the same flood as 0", 1],
    ["2ms", 2],
    ["3ms", 3],
  ])("floors %s, because the rate is the defect and not the runtime rewrite", async (
    _label,
    intervalMs,
  ) => {
    const fetchMock = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });

    const stop = client().startHeartbeat("m-1", intervalMs);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
  });

  /**
   * The only value the floor retimes that was not already a flood, pinned
   * explicitly so the cost of the guard is visible in the suite rather than
   * only in prose. 500ms is honoured by the runtime (measured: 501ms/tick,
   * 2 req/sec) and is a legitimate-if-wasteful choice; it still becomes
   * 1000ms, because `heartbeat_duration` is an integer-seconds column and no
   * policy the server can express needs a sub-second ping.
   */
  it("retimes a 500ms interval to 1s — the one honoured value the floor moves", async () => {
    const fetchMock = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });

    const stop = client().startHeartbeat("m-1", 500);

    // Would have been two pings before this change.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it("passes 999ms through the floor but 1000ms untouched — the exact boundary", async () => {
    const fetchMock = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });
    const stop = client().startHeartbeat("m-1", 999);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();

    vi.unstubAllGlobals();
    const atFloor = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });
    const stop2 = client().startHeartbeat("m-1", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(atFloor).toHaveBeenCalledTimes(1);
    stop2();
  });

  it("truncates a fractional interval rather than letting it reach setInterval", async () => {
    // `setInterval` truncates a non-integer delay itself, so 1500.9 is not a
    // hazard — this pins the documented contract ("truncated to an integer"),
    // not a defect.
    const fetchMock = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });
    const stop = client().startHeartbeat("m-1", 1500.9);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("leaves an interval that is already sane exactly as given", async () => {
    const fetchMock = mockJsonApiResponse({ id: "m-1", type: "machines", attributes: {} });

    const stop = client().startHeartbeat("m-1", 20_000);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it("survives the hand-rolled composition of the two public primitives", async () => {
    // The reachable form of the defect: `heartbeat_duration` has no `CHECK`
    // constraint, `effective_heartbeat_duration_secs` returns it verbatim, and
    // `resolveHeartbeatWindowMs` deliberately reports it unchanged rather than
    // hiding a misconfigured policy. Wiring the two public methods together by
    // hand — a reasonable reading of methods that look designed to compose —
    // therefore hands `startHeartbeat` a `0`.
    const fetchMock = mockSequence(
      jsonApi({ data: { id: "pol-1", type: "policies", attributes: { heartbeat_duration: 0 } } }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
      jsonApi({ data: { id: "m-1", type: "machines", attributes: {} } }),
    );

    const c = client();
    const windowMs = await c.resolveHeartbeatWindowMs("lic-1");
    // Still verbatim — the accessor's contract is unchanged by this fix.
    expect(windowMs).toBe(0);

    // ⚠️ Contrast with `startHeartbeatFromPolicy`, which substitutes the 600s
    // platform default for a non-positive window and lands on 200s. It can:
    // it knows the number came from a policy. `startHeartbeat` gets a bare
    // number with no provenance and cannot tell a misconfigured window from a
    // caller who meant `0`, so it applies the conservative 1s floor instead.
    // Both are safe; they differ because they know different things.

    const stop = c.startHeartbeat("m-1", windowMs / MACHINE_HEARTBEAT_INTERVAL_DIVISOR);
    await vi.advanceTimersByTimeAsync(3000);

    // One policy read plus three pings. `mockSequence` rejects a fourth ping,
    // and the scheduler swallows the rejection, so a spin would show up here
    // as a call count in the thousands rather than as an error.
    expect(fetchMock).toHaveBeenCalledTimes(4);

    stop();
  });
});
