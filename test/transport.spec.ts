import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  authQueryParam,
  sanitizeVersion,
  extractResponseInfo,
  sendJsonApi,
  sendJsonApiWithMeta,
  sendFlat,
  sendRaw,
  DEFAULT_API_VERSION,
  type AuthCredentials,
} from "../src/transport.js";
import { NotFoundError, TamgaNetworkError, TamgaParseError } from "../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth transports", () => {
  it("bearer produces an Authorization header", () => {
    expect(authHeaders({ kind: "bearer", token: "tok-abc123" })).toEqual({
      Authorization: "Bearer tok-abc123",
    });
  });

  it("license produces an Authorization header", () => {
    expect(authHeaders({ kind: "license", key: "lic-xyz789" })).toEqual({
      Authorization: "License lic-xyz789",
    });
  });

  it("basic email:password sub-form base64-encodes user:pass", () => {
    const auth: AuthCredentials = {
      kind: "basic",
      form: "email-password",
      email: "user@example.com",
      password: "hunter2",
    };
    expect(authHeaders(auth)).toEqual({
      Authorization: "Basic dXNlckBleGFtcGxlLmNvbTpodW50ZXIy",
    });
  });

  it("basic token sub-form uses an empty password", () => {
    const auth: AuthCredentials = { kind: "basic", form: "token", token: "tok-abc123" };
    expect(authHeaders(auth)).toEqual({ Authorization: "Basic dG9rLWFiYzEyMzo=" });
  });

  it("basic license-key sub-form prefixes with the license literal", () => {
    const auth: AuthCredentials = { kind: "basic", form: "license-key", key: "lic-xyz789" };
    expect(authHeaders(auth)).toEqual({ Authorization: "Basic bGljZW5zZTpsaWMteHl6Nzg5" });
  });

  it("cookie produces Cookie + Origin headers", () => {
    const auth: AuthCredentials = { kind: "cookie", sessionId: "sess-1", origin: "https://app.tamga.sh" };
    expect(authHeaders(auth)).toEqual({
      Cookie: "Tamga-Session=sess-1",
      Origin: "https://app.tamga.sh",
    });
  });

  it("query produces no headers, only a query param", () => {
    const auth: AuthCredentials = { kind: "query", token: "tok-abc123" };
    expect(authHeaders(auth)).toEqual({});
    expect(authQueryParam(auth)).toEqual(["token", "tok-abc123"]);
  });

  it("non-query transports produce no query param", () => {
    expect(authQueryParam({ kind: "bearer", token: "t" })).toBeUndefined();
    expect(authQueryParam({ kind: "license", key: "k" })).toBeUndefined();
  });
});

describe("sanitizeVersion", () => {
  it("keeps allowed characters", () => {
    expect(sanitizeVersion("1.8")).toBe("1.8");
    expect(sanitizeVersion("v1.0-beta")).toBe("v1.0-beta");
  });

  it("strips disallowed characters", () => {
    expect(sanitizeVersion("1.8; DROP TABLE")).toBe("1.8DROPTABLE");
    expect(sanitizeVersion("a/b c")).toBe("abc");
  });

  it("truncates to 32 characters", () => {
    const long = "a".repeat(50);
    const sanitized = sanitizeVersion(long);
    expect(sanitized.length).toBe(32);
    expect(sanitized).toBe("a".repeat(32));
  });

  it("has a default of 1.8", () => {
    expect(DEFAULT_API_VERSION).toBe("1.8");
  });
});

describe("extractResponseInfo", () => {
  it("extracts known headers", () => {
    const headers = new Headers({
      "Tamga-Version": "1.8",
      "Tamga-Edition": "CE",
      "Tamga-Mode": "multiplayer",
      "X-Request-Id": "req-123",
    });
    expect(extractResponseInfo(headers)).toEqual({
      tamgaVersion: "1.8",
      tamgaEdition: "CE",
      tamgaMode: "multiplayer",
      requestId: "req-123",
    });
  });

  it("omits missing headers rather than erroring", () => {
    expect(extractResponseInfo(new Headers())).toEqual({});
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/vnd.api+json" },
    ...init,
  });
}

describe("sendJsonApi", () => {
  it("decodes a { data } envelope on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: "1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendJsonApi<{ id: string }>(
      { baseUrl: "https://api.tamga.sh/v1/accounts/acct" },
      { method: "GET", path: "/licenses/1" },
    );
    expect(result.data).toEqual({ id: "1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends the configured auth header and Tamga-Version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await sendJsonApi(
      {
        baseUrl: "https://api.tamga.sh/v1/accounts/acct",
        auth: { kind: "license", key: "lic-abc" },
        apiVersion: "2.0",
      },
      { method: "POST", path: "/licenses/actions/validate-key", body: { key: "lic-abc" } },
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("License lic-abc");
    expect(headers.get("Tamga-Version")).toBe("2.0");
    expect(headers.get("Content-Type")).toBe("application/vnd.api+json");
    expect(init.body).toBe(JSON.stringify({ key: "lic-abc" }));
  });

  it("sends Tamga-OTP when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await sendJsonApi(
      { baseUrl: "https://api.tamga.sh/v1/accounts/acct", otp: "123456" },
      { method: "GET", path: "/x" },
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Headers).get("Tamga-OTP")).toBe("123456");
  });

  it("throws a typed error for a non-2xx JSON:API error response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          errors: [
            {
              id: "e1",
              status: "404",
              code: "NOT_FOUND",
              title: "Not Found",
              detail: "license not found",
            },
          ],
        },
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendJsonApi({ baseUrl: "https://api.tamga.sh/v1/accounts/acct" }, { method: "GET", path: "/x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("wraps a fetch rejection in TamgaNetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      sendJsonApi({ baseUrl: "https://api.tamga.sh/v1/accounts/acct" }, { method: "GET", path: "/x" }),
    ).rejects.toBeInstanceOf(TamgaNetworkError);
  });

  it("wraps malformed JSON in TamgaParseError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    await expect(
      sendJsonApi({ baseUrl: "https://api.tamga.sh/v1/accounts/acct" }, { method: "GET", path: "/x" }),
    ).rejects.toBeInstanceOf(TamgaParseError);
  });

  it("applies query params, dropping undefined values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await sendJsonApi(
      { baseUrl: "https://api.tamga.sh/v1/accounts/acct" },
      { method: "GET", path: "/x", query: { limit: 10, after: undefined } },
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("after")).toBe(false);
  });
});

describe("sendJsonApiWithMeta", () => {
  it("decodes both data and meta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { id: "1" }, meta: { valid: true } })),
    );
    const result = await sendJsonApiWithMeta<{ id: string }, { valid: boolean }>(
      { baseUrl: "https://api.tamga.sh/v1/accounts/acct" },
      { method: "POST", path: "/x" },
    );
    expect(result.data).toEqual({ id: "1" });
    expect(result.meta).toEqual({ valid: true });
  });
});

describe("sendFlat", () => {
  it("decodes a flat (non-enveloped) body — quick-validate shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ts: "2026-01-01T00:00:00Z", valid: true, detail: "ok", code: "VALID" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const result = await sendFlat<{ valid: boolean; code: string }>(
      { baseUrl: "https://api.tamga.sh/v1/accounts/acct" },
      { method: "GET", path: "/licenses/1/actions/validate" },
    );
    expect(result.data.valid).toBe(true);
    expect(result.data.code).toBe("VALID");
  });
});

describe("sendRaw", () => {
  it("returns the raw response text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("-----BEGIN LICENSE FILE-----\nabc\n-----END LICENSE FILE-----", {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );
    const result = await sendRaw(
      { baseUrl: "https://api.tamga.sh/v1/accounts/acct" },
      { method: "GET", path: "/licenses/1/actions/check-out" },
    );
    expect(result.data).toContain("BEGIN LICENSE FILE");
  });

  it("throws a typed error for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { errors: [{ id: "e", status: "404", code: "NOT_FOUND", title: "x", detail: "gone" }] },
          { status: 404 },
        ),
      ),
    );
    await expect(
      sendRaw({ baseUrl: "https://api.tamga.sh/v1/accounts/acct" }, { method: "GET", path: "/x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
