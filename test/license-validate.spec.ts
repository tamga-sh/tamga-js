import { afterEach, describe, expect, it, vi } from "vitest";
import { TamgaClient } from "../src/client.js";
import { mockJsonApiResponse, mockFlatResponse, lastCall, sentJsonBody } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({
    accountId: "acct_1",
    baseUrl: "https://api.tamga.sh",
    auth: { kind: "license", key: "lic-abc" },
  });
}

const licenseFixture = {
  id: "01926b3e-0000-7000-8000-000000000000",
  type: "licenses",
  attributes: { key: "lic-abc", status: "ACTIVE" },
};

describe("TamgaClient.validateByKey", () => {
  it("sends { key } and returns { license, meta }", async () => {
    const fetchMock = mockJsonApiResponse(licenseFixture, {
      meta: { ts: "2026-01-01T00:00:00Z", valid: true, detail: "ok", code: "VALID" },
    });

    const result = await client().validateByKey("lic-abc");
    expect(result.license.attributes.key).toBe("lic-abc");
    expect(result.meta.code).toBe("VALID");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/actions/validate-key");
    expect(sentJsonBody(init)).toEqual({ key: "lic-abc" });
  });
});

describe("TamgaClient.validateById", () => {
  it("sends the full 8-field scope object and skip_touch: false by default", async () => {
    const fetchMock = mockJsonApiResponse(licenseFixture, {
      meta: { ts: "t", valid: true, detail: "ok", code: "VALID" },
    });

    await client().validateById("lic-1", {
      scope: {
        product: "p1",
        policy: "pol1",
        user: "u1",
        environment: "e1",
        entitlements: ["ent1"],
        fingerprint: "fp1",
        version: "1.0",
        checksum: "chk1",
      },
    });

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/actions/validate");
    expect(sentJsonBody(init)).toEqual({
      meta: {
        skip_touch: false,
        scope: {
          product: "p1",
          policy: "pol1",
          user: "u1",
          environment: "e1",
          entitlements: ["ent1"],
          fingerprint: "fp1",
          version: "1.0",
          checksum: "chk1",
        },
      },
    });
  });

  it("omits scope entirely when not supplied, and sends skip_touch: true when requested", async () => {
    const fetchMock = mockJsonApiResponse(licenseFixture, {
      meta: { ts: "t", valid: true, detail: "ok", code: "VALID" },
    });

    await client().validateById("lic-1", { skipTouch: true });

    const [, init] = lastCall(fetchMock);
    expect(sentJsonBody(init)).toEqual({ meta: { skip_touch: true } });
  });
});

describe("TamgaClient.quickValidate", () => {
  it("parses the flat (no data envelope) response", async () => {
    mockFlatResponse({ ts: "2026-01-01T00:00:00Z", valid: false, detail: "expired", code: "EXPIRED" });

    const result = await client().quickValidate("lic-1");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("EXPIRED");
  });

  it("hits the GET quick-validate endpoint", async () => {
    const fetchMock = mockFlatResponse({ ts: "t", valid: true, detail: "ok", code: "VALID" });
    await client().quickValidate("lic-1");
    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/licenses/lic-1/actions/validate");
    expect(init.method).toBe("GET");
  });
});
