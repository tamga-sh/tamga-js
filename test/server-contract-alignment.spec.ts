/**
 * Regression tests for the server-contract alignment pass.
 *
 * Every fixture here uses the server's real wire shapes: a JSON:API error
 * object's `status` is the **string** `"422"`, never the number, and the
 * `code` values are the ones the Rust handlers actually emit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient } from "../src/client.js";
import {
  errorFromApiError,
  parseApiErrors,
  ApiError,
  CoreLimitExceededError,
  DiskLimitExceededError,
  LicenseExpiredError,
  LicenseNotAllowedError,
  LicenseSuspendedError,
  MachineLimitExceededError,
  MemoryLimitExceededError,
  TamgaApiErrorException,
  TamgaNetworkError,
  TamgaParseError,
  TooManyProcessesError,
} from "../src/errors.js";
import { mockApiError, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({
    accountId: "acct_1",
    baseUrl: "https://api.tamga.sh",
    auth: { kind: "license", key: "LIC-KEY" },
  });
}

/** A JSON:API response, built the way the server builds it. */
function jsonApi(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

/** A JSON:API error document — note `status` is a string on the wire. */
function errorDocument(status: number, code: string, detail: string): Response {
  return jsonApi(
    {
      errors: [
        {
          id: "01926b3e-0000-7000-8000-000000000000",
          status: String(status),
          code,
          title: code,
          detail,
        },
      ],
    },
    status,
  );
}

const machineFixture = { id: "m-1", type: "machines", attributes: { fingerprint: "fp-1" } };
const licenseFixture = { id: "lic-1", type: "licenses", attributes: { key: "LIC-KEY" } };

describe("create-time limit errors map to typed subclasses", () => {
  it("maps a 422 MACHINE_LIMIT_EXCEEDED body — string status and all", () => {
    const [apiError] = parseApiErrors({
      errors: [
        {
          id: "01926b3e-0000-7000-8000-000000000000",
          status: "422",
          code: "MACHINE_LIMIT_EXCEEDED",
          title: "Unprocessable Entity",
          detail: "machine limit of 2 reached for this license",
        },
      ],
    });

    expect(apiError).toEqual({
      status: 422,
      code: "MACHINE_LIMIT_EXCEEDED",
      detail: "machine limit of 2 reached for this license",
    });

    const error = errorFromApiError(apiError!);
    expect(error).toBeInstanceOf(MachineLimitExceededError);
    expect(error.code).toBe("MACHINE_LIMIT_EXCEEDED");
    expect(error.status).toBe(422);
    // Not the generic fallback any more.
    expect(error.constructor).not.toBe(ApiError);
  });

  it("dispatches every newly-mapped code to its own subclass", () => {
    // A code string that doesn't match its `CODE` constant falls silently
    // through to the generic `ApiError`, which is exactly the regression this
    // guards.
    const cases: [number, string, new (...args: never[]) => TamgaApiErrorException][] = [
      [422, "MACHINE_LIMIT_EXCEEDED", MachineLimitExceededError],
      [422, "CORE_LIMIT_EXCEEDED", CoreLimitExceededError],
      [422, "MEMORY_LIMIT_EXCEEDED", MemoryLimitExceededError],
      [422, "DISK_LIMIT_EXCEEDED", DiskLimitExceededError],
      [422, "TOO_MANY_PROCESSES", TooManyProcessesError],
      [401, "LICENSE_SUSPENDED", LicenseSuspendedError],
      [401, "LICENSE_EXPIRED", LicenseExpiredError],
      [401, "LICENSE_NOT_ALLOWED", LicenseNotAllowedError],
    ];

    for (const [status, code, ctor] of cases) {
      const error = errorFromApiError({ status, code, detail: "detail text" });
      expect(error, code).toBeInstanceOf(ctor);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).toContain("detail text");
    }
  });

  it("still routes the pre-existing codes, including the four generic ones", () => {
    // These were once reported as dead. They are not — the server bakes them
    // into its error mapper, so removing them would regress real traffic.
    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [500, "INTERNAL_SERVER_ERROR"],
    ] as [number, string][]) {
      const error = errorFromApiError({ status, code, detail: "d" });
      expect(error.constructor, code).not.toBe(ApiError);
      expect(error.code).toBe(code);
    }
  });

  it("surfaces MEMORY_LIMIT_EXCEEDED from createMachine as its typed subclass", async () => {
    mockApiError(422, "MEMORY_LIMIT_EXCEEDED", "memory limit of 32768 MB reached");
    await expect(client().createMachine("lic-1", "fp-1", { memory: 16384 })).rejects.toBeInstanceOf(
      MemoryLimitExceededError,
    );
  });
});

describe("license-key auth is gated on the policy", () => {
  it("maps a 401 LICENSE_NOT_ALLOWED to its own error rather than a bare UNAUTHORIZED", async () => {
    // The policy's `authentication_strategy` defaults to "TOKEN", under which
    // an `Authorization: License <key>` credential is rejected outright. This
    // is a configuration precondition, not a retryable auth failure.
    mockApiError(401, "LICENSE_NOT_ALLOWED", "license authentication is not allowed for this policy");

    const error = await client()
      .validateByKey("LIC-KEY")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LicenseNotAllowedError);
    expect(error).toBeInstanceOf(TamgaApiErrorException);
    expect((error as LicenseNotAllowedError).code).toBe("LICENSE_NOT_ALLOWED");
    expect((error as LicenseNotAllowedError).status).toBe(401);
  });
});

describe("TamgaClient.activateMachine limit handling", () => {
  it("normalizes a create-time 422 onto the validate-time code and never issues a delete", async () => {
    // NO_OVERAGE policy: the server refuses the create outright, so no machine
    // row exists and there is nothing to roll back.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorDocument(422, "MACHINE_LIMIT_EXCEEDED", "machine limit of 2 reached for this license"),
      )
      .mockResolvedValueOnce(
        jsonApi({
          data: licenseFixture,
          meta: { ts: "2026-08-21T00:00:00Z", valid: true, detail: "valid", code: "VALID" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().activateMachine("lic-1", "fp-1", {}, undefined, true);

    expect(result.meta.code).toBe("TOO_MANY_MACHINES");
    expect(result.meta.valid).toBe(false);
    expect(result.meta.detail).toBe("machine limit of 2 reached for this license");
    expect(result.license.id).toBe("lic-1");

    // Create + validate only. Crucially no DELETE: deleting on this path would
    // target a machine that was never created.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as [URL, RequestInit][]) {
      expect(call[1].method).not.toBe("DELETE");
    }
  });

  it("normalizes each create-time limit code onto its validate-time equivalent", async () => {
    const cases: [string, string][] = [
      ["MACHINE_LIMIT_EXCEEDED", "TOO_MANY_MACHINES"],
      ["CORE_LIMIT_EXCEEDED", "TOO_MANY_CORES"],
      ["MEMORY_LIMIT_EXCEEDED", "TOO_MUCH_MEMORY"],
      ["DISK_LIMIT_EXCEEDED", "TOO_MUCH_DISK"],
    ];

    for (const [createCode, validationCode] of cases) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorDocument(422, createCode, "over the limit"))
        .mockResolvedValueOnce(
          jsonApi({
            data: licenseFixture,
            meta: { ts: "2026-08-21T00:00:00Z", valid: true, detail: "valid", code: "VALID" },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const result = await client().activateMachine("lic-1", "fp-1");
      expect(result.meta.code).toBe(validationCode);
    }
  });

  it("keeps the create -> validate -> rollback path under an overage strategy", async () => {
    // ALLOW_1_25X_OVERAGE: the create-time check is routed through the overage
    // strategy, so creation succeeds and the limit only shows up at validate.
    // The machine really exists here, so the rollback has to run.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonApi({ data: machineFixture }))
      .mockResolvedValueOnce(
        jsonApi({
          data: licenseFixture,
          meta: {
            ts: "2026-08-21T00:00:00Z",
            valid: false,
            detail: "too many machines",
            code: "TOO_MANY_MACHINES",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().activateMachine("lic-1", "fp-1", {}, undefined, true);

    expect(result.meta.code).toBe("TOO_MANY_MACHINES");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [deleteUrl, deleteInit] = lastCall(fetchMock);
    expect(deleteInit.method).toBe("DELETE");
    expect(deleteUrl.pathname).toBe("/v1/accounts/acct_1/machines/m-1");
  });

  it("rethrows a non-limit create failure untouched", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorDocument(409, "FINGERPRINT_TAKEN", "fingerprint already registered"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().activateMachine("lic-1", "fp-1")).rejects.toMatchObject({
      code: "FINGERPRINT_TAKEN",
    });
    // Nothing followed the failed create.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("request deadline", () => {
  it("aborts a hung request and reports it as a timeout, not a generic network failure", async () => {
    // The API's own TimeoutLayer answers 504 at 30s; without a client-side
    // deadline a request that never gets that far hangs forever.
    const fetchMock = vi.fn().mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hung = new TamgaClient({
      accountId: "acct_1",
      baseUrl: "https://api.tamga.sh",
      timeoutMs: 20,
    });

    await expect(hung.quickValidate("lic-1")).rejects.toThrow(/timed out after 20ms/);
  });

  it("waits indefinitely when the deadline is explicitly disabled", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      // No signal is attached at all, so there is nothing to abort.
      expect(init.signal).toBeUndefined();
      return Promise.resolve(jsonApi({ ts: "t", valid: true, detail: "ok", code: "VALID" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const unbounded = new TamgaClient({
      accountId: "acct_1",
      baseUrl: "https://api.tamga.sh",
      timeoutMs: 0,
    });

    await expect(unbounded.quickValidate("lic-1")).resolves.toMatchObject({ code: "VALID" });
  });

  it("disarms the deadline once the request resolves", async () => {
    // `doFetch`'s `finally { deadline.clear() }` is what stops a 45s abort
    // timer being left armed behind every fast response — under Node a
    // stack of them keeps the event loop alive and delays process exit.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(jsonApi({ ts: "t", valid: true, detail: "ok", code: "VALID" })),
          ),
      );

      await expect(client().quickValidate("lic-1")).resolves.toMatchObject({ code: "VALID" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a response whose headers arrive promptly but whose body stalls", async () => {
    // The case a header-only deadline misses. `fetch` resolves as soon as the
    // response headers land, so disarming the abort there bounds nothing but
    // the header wait: a stalling proxy — or a peer holding the connection
    // open — can then trickle (or never finish) the body and hang the call
    // forever. Headers here arrive immediately and a first chunk even lands;
    // the stream simply never closes, so only an abort still armed across the
    // body read can end it.
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ts":"2026-01-01T00:00:00Z",'));
          init.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          });
          // Deliberately no controller.close() — the body never completes.
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const stalling = new TamgaClient({
      accountId: "acct_1",
      baseUrl: "https://api.tamga.sh",
      timeoutMs: 20,
    });

    const failure = await stalling.quickValidate("lic-1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TamgaNetworkError);
    expect((failure as Error).message).toMatch(/timed out after 20ms/);
    // The request itself was fine — headers arrived and were never retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disarms the deadline when the body arrives but fails to parse", async () => {
    // The other exit path out of a completed read. Parsing happens outside the
    // deadline's scope now, so a `TamgaParseError` cannot leak the timer —
    // and it must still surface as a parse error, not as a network failure.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              new Response("<html>not json</html>", {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ),
          ),
      );

      await expect(client().quickValidate("lic-1")).rejects.toBeInstanceOf(TamgaParseError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches a fresh signal by default", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
      return Promise.resolve(jsonApi({ ts: "t", valid: true, detail: "ok", code: "VALID" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().quickValidate("lic-1")).resolves.toMatchObject({ code: "VALID" });
  });
});
