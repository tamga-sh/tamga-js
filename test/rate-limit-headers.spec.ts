import { describe, expect, it } from "vitest";
import { extractResponseInfo } from "../src/transport.js";

/**
 * The `x-ratelimit-*` headers, which this SDK's transport documentation used
 * to say were "not set by any server handler".
 *
 * They are. `shared/rate_limit/middleware.rs` writes all four onto whatever
 * response it is about to return — the `headers_mut()` call sits after the
 * allow/throttle branch, so a 200 carries them exactly as a 429 does. The old
 * claim confused "in the CORS expose list" with "only in the CORS expose
 * list", and the same sentence was carried by several SDKs in this fleet.
 */
describe("rate-limit headers", () => {
  const withHeaders = (h: Record<string, string>) => extractResponseInfo(new Headers(h));

  it("reads all four off a successful response", () => {
    expect(
      withHeaders({
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "97",
        "x-ratelimit-reset": "1755792000",
        "x-ratelimit-window": "60",
      }).rateLimit,
    ).toEqual({ limit: 100, remaining: 97, reset: 1755792000, window: 60 });
  });

  it("leaves rateLimit undefined when the server sent none of them", () => {
    // Not `{}`, and emphatically not a zero-filled object. The middleware
    // writes nothing when no limiter is configured, on OPTIONS preflight, and
    // — installed with route_layer — on an unmatched path. A caller reading a
    // missing `remaining` as 0 would throttle itself against a server that is
    // not limiting it.
    expect(withHeaders({ "Tamga-Version": "1" }).rateLimit).toBeUndefined();
  });

  it("keeps a real zero distinguishable from an absent field", () => {
    const info = withHeaders({ "x-ratelimit-remaining": "0" }).rateLimit;
    expect(info).toEqual({ remaining: 0 });
    expect(info?.remaining).toBe(0);
    expect(info?.limit).toBeUndefined();
  });

  it("surfaces a partial set rather than discarding it", () => {
    expect(withHeaders({ "x-ratelimit-reset": "1755792000" }).rateLimit).toEqual({
      reset: 1755792000,
    });
  });

  it("drops a non-numeric header instead of surfacing NaN", () => {
    // Every consumer of these does arithmetic on them, and NaN propagates
    // silently through a comparison rather than failing.
    const info = withHeaders({
      "x-ratelimit-limit": "not-a-number",
      "x-ratelimit-remaining": "5",
    }).rateLimit;
    expect(info).toEqual({ remaining: 5 });
    expect(Number.isNaN(info?.limit as number)).toBe(false);
  });

  it("reports reset as the absolute timestamp the server sent, not a delay", () => {
    // The trap this pins. `middleware.rs` derives Retry-After BY SUBTRACTING
    // the current time from reset_at, which is the proof that reset_at is
    // absolute. An SDK that "helpfully" converted it to a delay, or a caller
    // that slept for it, would park for decades.
    const absolute = 1755792000;
    expect(withHeaders({ "x-ratelimit-reset": String(absolute) }).rateLimit?.reset).toBe(
      absolute,
    );
    expect(withHeaders({ "x-ratelimit-reset": String(absolute) }).rateLimit?.reset).toBeGreaterThan(
      1_600_000_000,
    );
  });

  it("still reports the diagnostic headers alongside", () => {
    const info = withHeaders({
      "Tamga-Version": "1",
      "X-Request-Id": "req-1",
      "x-ratelimit-remaining": "3",
    });
    expect(info.tamgaVersion).toBe("1");
    expect(info.requestId).toBe("req-1");
    expect(info.rateLimit).toEqual({ remaining: 3 });
  });
});
