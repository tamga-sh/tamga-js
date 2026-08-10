import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { FingerprintTakenError } from "../src/errors.js";
import { mockJsonApiResponse, mockApiError, lastCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

const machineFixture = { id: "m-1", type: "machines", attributes: { fingerprint: "fp-1" } };

describe("TamgaClient.createMachine", () => {
  it("creates a machine with only the required fingerprint", async () => {
    const fetchMock = mockJsonApiResponse(machineFixture);
    await client().createMachine("lic-1", "fp-1");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines");
    const body = sentJsonBody(init) as {
      data: { attributes: Record<string, unknown>; relationships: unknown };
    };
    expect(body.data.attributes.fingerprint).toBe("fp-1");
    expect(body.data.attributes.metadata).toEqual({});
    expect(body.data.relationships).toEqual({ license: { data: { type: "licenses", id: "lic-1" } } });
  });

  it("creates a machine with all optional fields set", async () => {
    const fetchMock = mockJsonApiResponse(machineFixture);
    await client().createMachine("lic-1", "fp-1", {
      name: "Bob's laptop",
      ip: "10.0.0.1",
      hostname: "bobs-laptop",
      platform: "darwin",
      cores: 8,
      memory: 17179869184,
      disk: 512000000000,
      metadata: { plan: "pro" },
    });

    const [, init] = lastCall(fetchMock);
    const body = sentJsonBody(init) as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes).toEqual({
      fingerprint: "fp-1",
      name: "Bob's laptop",
      ip: "10.0.0.1",
      hostname: "bobs-laptop",
      platform: "darwin",
      cores: 8,
      memory: 17179869184,
      disk: 512000000000,
      metadata: { plan: "pro" },
    });
  });

  it("surfaces FINGERPRINT_TAKEN as a typed error", async () => {
    mockApiError(409, "FINGERPRINT_TAKEN");
    await expect(client().createMachine("lic-1", "fp-1")).rejects.toBeInstanceOf(
      FingerprintTakenError,
    );
  });
});

describe("TamgaClient.activateMachine", () => {
  it("creates then validates, returning the validation result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: machineFixture }), {
          status: 200,
          headers: { "Content-Type": "application/vnd.api+json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: machineFixture,
            meta: { ts: "t", valid: true, detail: "ok", code: "VALID" },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().activateMachine("lic-1", "fp-1");
    expect(result.meta.code).toBe("VALID");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("auto-deletes the machine on an overage validation code when opted in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: machineFixture }), {
          status: 200,
          headers: { "Content-Type": "application/vnd.api+json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: machineFixture,
            meta: { ts: "t", valid: false, detail: "too many", code: "TOO_MANY_MACHINES" },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().activateMachine("lic-1", "fp-1", {}, undefined, true);
    expect(result.meta.code).toBe("TOO_MANY_MACHINES");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const deleteCall = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(deleteCall[1].method).toBe("DELETE");
  });

  it("does not auto-delete when autoDeleteOnOverage is false (default)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: machineFixture }), {
          status: 200,
          headers: { "Content-Type": "application/vnd.api+json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: machineFixture,
            meta: { ts: "t", valid: false, detail: "too many", code: "TOO_MANY_MACHINES" },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await client().activateMachine("lic-1", "fp-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
