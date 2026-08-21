/** Test-only fetch mocking helpers for `TamgaClient` endpoint tests. */
import { vi, type Mock } from "vitest";

/** Stubs `globalThis.fetch` to return a JSON:API-enveloped `{ data }` (and optional `meta`) response. */
export function mockJsonApiResponse(
  data: unknown,
  opts: { meta?: unknown; status?: number } = {},
): Mock {
  const body = opts.meta !== undefined ? { data, meta: opts.meta } : { data };
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/vnd.api+json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stubs `globalThis.fetch` to return a flat (non-enveloped) JSON body — quick-validate shape. */
export function mockFlatResponse(body: unknown, status = 200): Mock {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stubs `globalThis.fetch` to return a JSON:API error document with a single error. */
export function mockApiError(status: number, code: string, detail = "error"): Mock {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ errors: [{ id: "e1", status: String(status), code, title: code, detail }] }),
      { status, headers: { "Content-Type": "application/vnd.api+json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Returns the `(url, init)` pair fetch was last called with. */
export function lastCall(fetchMock: Mock): [URL, RequestInit] {
  const calls = fetchMock.mock.calls as [URL, RequestInit][];
  return calls[calls.length - 1] as [URL, RequestInit];
}

/** Parses the JSON body sent in a fetch call's `RequestInit`. */
export function sentJsonBody(init: RequestInit): unknown {
  return JSON.parse(init.body as string);
}

/**
 * Stubs `globalThis.fetch` to return `responses` in order, one per call.
 *
 * Needed by every multi-request flow — `activateMachine`'s create → find →
 * validate path, `findMachineByFingerprint` walking pages,
 * `startHeartbeatFromPolicy` reading the policy before starting its timer.
 * A call past the end of the list rejects rather than replaying the last
 * response, so an unexpected extra request fails loudly instead of passing.
 */
export function mockSequence(...responses: Response[]): Mock {
  let index = 0;
  const fetchMock = vi.fn().mockImplementation(() => {
    const response = responses[index++];
    if (response === undefined) {
      return Promise.reject(new Error(`unexpected fetch call #${index}`));
    }
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A JSON:API response body, built the way the server builds it. */
export function jsonApi(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

/** A JSON:API error document — `status` is a **string** on the wire. */
export function errorDoc(status: number, code: string, detail = "error"): Response {
  return jsonApi({ errors: [{ id: "e1", status: String(status), code, title: code, detail }] }, status);
}

/** `204 No Content` — an empty body, as the upgrade route sends. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * A plain-text response. Axum's bare `Query` extractor rejects with one of
 * these, so the upgrade route's `400` is not a JSON:API document.
 */
export function plainText(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** Returns the `(url, init)` pair of fetch call `index` (0-based). */
export function nthCall(fetchMock: Mock, index: number): [URL, RequestInit] {
  return (fetchMock.mock.calls as [URL, RequestInit][])[index] as [URL, RequestInit];
}
