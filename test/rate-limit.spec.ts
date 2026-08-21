/**
 * The server rate-limits; the SDK has to cope.
 *
 * Credential-accepting endpoints run on a tight per-IP budget (5 requests/second
 * by default), and the calls a licensing client makes on a timer — validate,
 * heartbeat ping, check-in — are exactly the ones inside it. Without backoff, a
 * retry loop turns one throttled request into a sustained burst that keeps the
 * bucket empty and the client never recovers on its own.
 */

import { describe, expect, it } from "vitest";

import { isRetryable, parseRetryAfter, retryDelayMs } from "../src/transport.js";

describe("retry eligibility", () => {
  it("never auto-retries a create", () => {
    // Repeating a create is not safe: the first attempt may well have
    // succeeded server-side, and a second activation burns a second seat.
    expect(isRetryable("POST", "/v1/accounts/acc/machines")).toBe(false);
    expect(isRetryable("POST", "/v1/accounts/acc/licenses")).toBe(false);
  });

  it("retries the calls a client makes on a timer", () => {
    expect(isRetryable("GET", "/v1/accounts/acc/licenses")).toBe(true);
    expect(isRetryable("POST", "/v1/accounts/acc/licenses/actions/validate")).toBe(true);
    expect(isRetryable("POST", "/v1/accounts/acc/machines/x/actions/ping")).toBe(true);
  });

  it("retries the machine heartbeat routes, which do not end in /actions/ping", () => {
    // `/actions/ping` is the *process* route. `ping-heartbeat` and
    // `reset-heartbeat` don't match that suffix, so they need their own
    // entries — and a dropped heartbeat is what gets a live machine culled.
    // Both are bare timestamp writes with no counter attached, so repeating
    // them cannot burn a seat the way repeating `POST /machines` can.
    expect(isRetryable("POST", "/v1/accounts/acc/machines/m-1/actions/ping-heartbeat")).toBe(true);
    expect(isRetryable("POST", "/v1/accounts/acc/machines/m-1/actions/reset-heartbeat")).toBe(true);
  });

  it("ignores methods it has no basis to judge", () => {
    expect(isRetryable("DELETE", "/v1/accounts/acc/machines/x")).toBe(false);
    expect(isRetryable("PATCH", "/v1/accounts/acc/licenses/x")).toBe(false);
  });
});

describe("Retry-After parsing", () => {
  const withHeader = (value: string | null): Response =>
    new Response(null, {
      status: 429,
      headers: value === null ? {} : { "Retry-After": value },
    });

  it("reads delta-seconds", () => {
    expect(parseRetryAfter(withHeader("42"))).toBe(42);
  });

  it("falls back when the header is absent", () => {
    expect(parseRetryAfter(withHeader(null))).toBeUndefined();
  });

  it("falls back on the HTTP-date form rather than misreading it", () => {
    // Parsing a date as a duration would be far worse than backing off.
    expect(parseRetryAfter(withHeader("Wed, 21 Oct 2026 07:28:00 GMT"))).toBeUndefined();
  });
});

describe("backoff policy", () => {
  it("honours a sane Retry-After", () => {
    expect(retryDelayMs(0, 5)).toBe(5000);
  });

  it("caps an absurd Retry-After", () => {
    // A misconfigured — or hostile — proxy must not be able to park the caller
    // for a day on a single header.
    expect(retryDelayMs(0, 86_400)).toBeLessThanOrEqual(60_000);
  });

  it("grows when the server says nothing", () => {
    // Guessing the same short delay every time is just the original burst.
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(0));
  });
});
