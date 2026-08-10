import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { CheckoutError, SchemeNotSupportedError } from "../src/errors.js";
import { mockApiError, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.checkOutMachine", () => {
  it("returns the raw PEM body", async () => {
    const pem = "-----BEGIN MACHINE FILE-----\nabc\n-----END MACHINE FILE-----";
    const fetchMock = vi.fn().mockResolvedValue(new Response(pem, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().checkOutMachine("m-1", { encrypt: false });
    expect(result).toBe(pem);
    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/machines/m-1/actions/check-out");
  });

  it("pre-checks ttl client-side before the round trip", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().checkOutMachine("m-1", { ttl: 0 })).rejects.toBeInstanceOf(CheckoutError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TamgaClient.checkOutMachineJson", () => {
  it("returns the full machine-files JSON:API resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "cert-1",
            type: "machine-files",
            attributes: {
              certificate: "pem",
              algorithm: "base64+ed25519",
              includes: [],
              ttl: null,
              expiry: null,
              issued: "2026-01-01T00:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resource = await client().checkOutMachineJson("m-1");
    expect(resource.type).toBe("machine-files");
  });

  it("surfaces SCHEME_NOT_SUPPORTED as a typed error", async () => {
    mockApiError(422, "SCHEME_NOT_SUPPORTED");
    await expect(client().checkOutMachineJson("m-1", { encrypt: true })).rejects.toBeInstanceOf(
      SchemeNotSupportedError,
    );
  });
});
