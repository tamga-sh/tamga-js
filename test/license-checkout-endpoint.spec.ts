import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { LicenseNotEncryptedError } from "../src/errors.js";
import { mockApiError, lastCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

describe("TamgaClient.checkOutLicense", () => {
  it("returns the raw PEM body and sends encrypt/ttl as query params", async () => {
    const pem = "-----BEGIN LICENSE FILE-----\nabc\n-----END LICENSE FILE-----";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(pem, { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().checkOutLicense("lic-1", { encrypt: true, ttl: 3600 });
    expect(result).toBe(pem);

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/actions/check-out");
    expect(url.searchParams.get("encrypt")).toBe("true");
    expect(url.searchParams.get("ttl")).toBe("3600");
    expect(init.method).toBe("GET");
  });

  it("defaults encrypt to false and omits ttl when not supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("pem", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await client().checkOutLicense("lic-1");
    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("encrypt")).toBe("false");
    expect(url.searchParams.has("ttl")).toBe(false);
  });
});

describe("TamgaClient.checkOutLicenseJson", () => {
  it("returns the full license-files JSON:API resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "cert-1",
            type: "license-files",
            attributes: {
              certificate: "pem",
              algorithm: "base64+ed25519+v2",
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

    const resource = await client().checkOutLicenseJson("lic-1");
    expect(resource.attributes.includes).toEqual([]);
    const [, init] = lastCall(fetchMock);
    expect(init.method).toBe("POST");
  });

  it("surfaces LICENSE_NOT_ENCRYPTED as a typed error", async () => {
    mockApiError(422, "LICENSE_NOT_ENCRYPTED");
    await expect(
      client().checkOutLicenseJson("lic-1", { encrypt: true }),
    ).rejects.toBeInstanceOf(LicenseNotEncryptedError);
  });
});
