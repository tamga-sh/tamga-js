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
