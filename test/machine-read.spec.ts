/**
 * `GET`/`PATCH` on the machine domain — the read/update half the SDK never had.
 *
 * The point of interest is `listMachines`: it is the one list in this SDK that
 * is **offset**-paginated. Every other list here is a hand-written keyset query
 * (`limit` + `page[after]`), and this repo has already shipped the mirror-image
 * mistake once — a working cursor modeled for an endpoint that ignores
 * `page[after]` entirely. These tests pin the wire params so the two styles
 * cannot be quietly swapped.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient } from "../src/client.js";
import type { UpdateMachineOptions } from "../src/client.js";
import { heartbeatWindowMsFromMachine } from "../src/models/machine.js";
import { jsonApi, lastCall, mockJsonApiResponse, mockSequence, nthCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

function machine(id: string, fingerprint: string): unknown {
  return { id, type: "machines", attributes: { fingerprint } };
}

function page(number: number, size: number, total: number, totalPages: number): unknown {
  return { page: { number, size, total, totalPages } };
}

describe("TamgaClient.getMachine", () => {
  it("reads one machine by id", async () => {
    const fetchMock = mockJsonApiResponse(machine("m-1", "fp-1"));
    const result = await client().getMachine("m-1");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1");
    expect(init.method).toBe("GET");
    expect(result.attributes.fingerprint).toBe("fp-1");
  });

  it("surfaces DEAD, which only a read-backed response can report", async () => {
    // A ping derives the status from the timestamp it just wrote, so it can
    // never answer DEAD. This route joins the policy and reads, so it can.
    mockJsonApiResponse({
      id: "m-1",
      type: "machines",
      attributes: {
        fingerprint: "fp-1",
        heartbeat_status: "DEAD",
        last_heartbeat_at: "2026-08-21T00:00:00.000Z",
        next_heartbeat_at: "2026-08-21T00:01:00.000Z",
      },
    });
    const result = await client().getMachine("m-1");
    expect(result.attributes.heartbeat_status).toBe("DEAD");
  });
});

describe("TamgaClient.listMachines", () => {
  it("sends offset pagination — page[number]/page[size], never a cursor", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [], meta: page(2, 50, 0, 0) }));
    await client().listMachines({ page: 2, size: 50 });

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines");
    expect(url.searchParams.get("page[number]")).toBe("2");
    expect(url.searchParams.get("page[size]")).toBe("50");
    // The keyset cursor is meaningless here and must not be sent.
    expect(url.searchParams.has("page[after]")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("defaults to page 1 at the server maximum, not the silent 25", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [], meta: page(1, 100, 0, 0) }));
    await client().listMachines();

    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("page[number]")).toBe("1");
    expect(url.searchParams.get("page[size]")).toBe("100");
  });

  it("decodes meta.page, including the camelCase totalPages", async () => {
    mockSequence(jsonApi({ data: [machine("m-1", "fp-1")], meta: page(1, 100, 142, 2) }));
    const result = await client().listMachines();

    expect(result.items).toHaveLength(1);
    expect(result.page).toEqual({ number: 1, size: 100, total: 142, totalPages: 2 });
  });

  it("degrades to a describable page when meta is missing entirely", async () => {
    // A list must not fail because the envelope's bookkeeping changed shape,
    // and totalPages must stay finite so a caller's page walk terminates.
    mockSequence(jsonApi({ data: [machine("m-1", "fp-1")] }));
    const result = await client().listMachines({ page: 3, size: 10 });

    expect(result.page).toEqual({ number: 3, size: 10, total: 1, totalPages: 1 });
  });

  it("degrades field-by-field when meta.page is partial or wrongly typed", async () => {
    mockSequence(jsonApi({ data: [], meta: { page: { number: 4, size: "wrong", totalPages: null } } }));
    const result = await client().listMachines({ page: 4, size: 25 });

    expect(result.page).toEqual({ number: 4, size: 25, total: 0, totalPages: 1 });
  });

  it("tolerates a null data array", async () => {
    mockSequence(jsonApi({ data: null, meta: page(1, 100, 0, 0) }));
    const result = await client().listMachines();
    expect(result.items).toEqual([]);
  });

  it("sends every filter, joining multi-valued ones with commas", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [], meta: page(1, 100, 0, 0) }));
    await client().listMachines({
      licenseId: ["lic-1", "lic-2"],
      ownerId: "usr-1",
      groupId: "grp-1",
      platform: ["darwin", "linux"],
      search: "bobs-laptop",
      sort: "last_heartbeat_at",
      order: "asc",
    });

    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("filter[license]")).toBe("lic-1,lic-2");
    expect(url.searchParams.get("filter[owner]")).toBe("usr-1");
    expect(url.searchParams.get("filter[group]")).toBe("grp-1");
    expect(url.searchParams.get("filter[platform]")).toBe("darwin,linux");
    expect(url.searchParams.get("filter[q]")).toBe("bobs-laptop");
    expect(url.searchParams.get("sort")).toBe("last_heartbeat_at");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  it("omits filters the caller did not set, including empty arrays", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [], meta: page(1, 100, 0, 0) }));
    await client().listMachines({ licenseId: [] });

    const [url] = lastCall(fetchMock);
    expect(url.searchParams.has("filter[license]")).toBe(false);
    expect(url.searchParams.has("filter[owner]")).toBe(false);
    expect(url.searchParams.has("sort")).toBe(false);
  });
});

describe("TamgaClient.findMachineByFingerprint", () => {
  it("searches with filter[q] and confines the search to the license", async () => {
    const fetchMock = mockSequence(
      jsonApi({ data: [machine("m-1", "fp-1")], meta: page(1, 100, 1, 1) }),
    );
    const found = await client().findMachineByFingerprint("lic-1", "fp-1");

    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("filter[q]")).toBe("fp-1");
    expect(url.searchParams.get("filter[license]")).toBe("lic-1");
    expect(found?.id).toBe("m-1");
  });

  it("rejects a substring hit — filter[q] is ILIKE '%term%', not equality", async () => {
    // "fp-1" is a substring of "fp-12", so the server returns both. Taking the
    // first row would hand back the wrong machine.
    mockSequence(
      jsonApi({
        data: [machine("m-2", "fp-12"), machine("m-1", "fp-1")],
        meta: page(1, 100, 2, 1),
      }),
    );
    const found = await client().findMachineByFingerprint("lic-1", "fp-1");
    expect(found?.id).toBe("m-1");
  });

  it("returns undefined when only substring matches came back", async () => {
    mockSequence(jsonApi({ data: [machine("m-2", "fp-12")], meta: page(1, 100, 1, 1) }));
    expect(await client().findMachineByFingerprint("lic-1", "fp-1")).toBeUndefined();
  });

  it("walks to the next page when the match is not on the first", async () => {
    const fetchMock = mockSequence(
      jsonApi({ data: [machine("m-9", "fp-1x")], meta: page(1, 100, 2, 2) }),
      jsonApi({ data: [machine("m-1", "fp-1")], meta: page(2, 100, 2, 2) }),
    );
    const found = await client().findMachineByFingerprint("lic-1", "fp-1");

    expect(found?.id).toBe("m-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(nthCall(fetchMock, 1)[0].searchParams.get("page[number]")).toBe("2");
  });

  it("stops at the last page the server reports rather than paging forever", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [], meta: page(1, 100, 0, 0) }));
    expect(await client().findMachineByFingerprint("lic-1", "fp-1")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at maxPages even when the server claims more", async () => {
    const fetchMock = mockSequence(
      jsonApi({ data: [machine("m-9", "fp-1x")], meta: page(1, 100, 999, 10) }),
      jsonApi({ data: [machine("m-9", "fp-1x")], meta: page(2, 100, 999, 10) }),
    );
    expect(await client().findMachineByFingerprint("lic-1", "fp-1", { maxPages: 2 })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-positive maxPages as the default rather than doing nothing", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [], meta: page(1, 100, 0, 0) }));
    await client().findMachineByFingerprint("lic-1", "fp-1", { maxPages: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("TamgaClient.updateMachine", () => {
  it("PATCHes a JSON:API envelope carrying only the fields given", async () => {
    const fetchMock = mockJsonApiResponse(machine("m-1", "fp-1"));
    await client().updateMachine("m-1", { name: "renamed", cores: 4 });

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1");
    expect(init.method).toBe("PATCH");
    expect(sentJsonBody(init)).toEqual({
      data: { type: "machines", attributes: { name: "renamed", cores: 4 } },
    });
  });

  it("never sends a null — the server reads it as 'leave unchanged' anyway", async () => {
    // `name = COALESCE($3, name)`: an explicit null is a no-op, so emitting one
    // would imply a clear-to-null this endpoint cannot perform.
    const fetchMock = mockJsonApiResponse(machine("m-1", "fp-1"));
    // `exactOptionalPropertyTypes` stops a TypeScript caller writing this, but
    // a JavaScript consumer — or an object assembled from a partial record —
    // can still carry an explicit `undefined`, and it must not reach the wire.
    const patch = { name: "renamed", ip: undefined } as unknown as UpdateMachineOptions;
    await client().updateMachine("m-1", patch);

    const [, init] = lastCall(fetchMock);
    const body = sentJsonBody(init) as { data: { attributes: Record<string, unknown> } };
    expect(Object.keys(body.data.attributes)).toEqual(["name"]);
  });

  it("can report DEAD — the one write on this resource that can", async () => {
    // The write-vs-read rule is about `last_heartbeat_at`, not about writes in
    // general. `ping-heartbeat` sets it and so can only answer ALIVE or
    // RESURRECTED; `reset-heartbeat` nulls it; `POST /machines` never sets it.
    // PATCH touches none of them, so it still derives a status from whatever
    // was already there — and `queries::update`'s RETURNING joins no policy, so
    // it judges against the 600s fallback rather than the policy window. Its
    // verdict can therefore disagree with `getMachine` in either direction.
    mockJsonApiResponse({
      id: "m-1",
      type: "machines",
      attributes: {
        fingerprint: "fp-1",
        heartbeat_status: "DEAD",
        last_heartbeat_at: "2026-08-21T00:00:00.000Z",
        next_heartbeat_at: "2026-08-21T00:10:00.000Z",
      },
    });
    const result = await client().updateMachine("m-1", { name: "renamed" });

    expect(result.attributes.heartbeat_status).toBe("DEAD");
    // 600s exactly — the fallback, not a policy window. A caller deriving the
    // heartbeat window from a patch response gets the fallback every time.
    expect(heartbeatWindowMsFromMachine(result)).toBe(600_000);
  });

  it("sends an empty attributes object for an empty patch", async () => {
    const fetchMock = mockJsonApiResponse(machine("m-1", "fp-1"));
    await client().updateMachine("m-1", {});

    const [, init] = lastCall(fetchMock);
    expect(sentJsonBody(init)).toEqual({ data: { type: "machines", attributes: {} } });
  });
});
