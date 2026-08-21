/**
 * The auto-update check and the health probe — the two routes that do not look
 * like the rest of this API.
 *
 * `GET /releases/actions/upgrade` answers `204 No Content` in **two** different
 * situations and refuses to distinguish them: no newer release exists, and a
 * newer release exists that this license is not entitled to. The collapse is
 * deliberate — a distinct refusal would leak the second fact — so `undefined`
 * here means "no update is available to you", never "you are up to date".
 *
 * `GET /v1/health` is the only route this SDK calls that is neither
 * account-scoped nor JSON:API-enveloped.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient } from "../src/client.js";
import { ApiError, ForbiddenError, UnauthorizedError } from "../src/errors.js";
import { errorDoc, jsonApi, lastCall, mockFlatResponse, mockSequence, noContent, plainText } from "./helpers/mockFetch.js";

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

const query = {
  productId: "prod-1",
  platform: "darwin",
  filetype: "dmg",
  version: "1.2.0",
  channel: "stable",
};

const releaseFixture = {
  id: "rel-1",
  type: "releases",
  attributes: {
    productId: "prod-1",
    name: "1.3.0",
    version: "1.3.0",
    channel: "stable",
    status: "PUBLISHED",
    metadata: {},
    created: "2026-08-21T00:00:00Z",
    updated: "2026-08-21T00:00:00Z",
  },
};

describe("TamgaClient.checkForUpgrade", () => {
  it("sends the server's own parameter names", async () => {
    const fetchMock = mockSequence(noContent());
    await client().checkForUpgrade({ ...query, constraint: "^1.2.0" });

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/releases/actions/upgrade");
    expect(init.method).toBe("GET");
    // `product`, not `productId` — the wire name differs from the option name.
    expect(url.searchParams.get("product")).toBe("prod-1");
    expect(url.searchParams.get("platform")).toBe("darwin");
    expect(url.searchParams.get("filetype")).toBe("dmg");
    expect(url.searchParams.get("version")).toBe("1.2.0");
    expect(url.searchParams.get("channel")).toBe("stable");
    expect(url.searchParams.get("constraint")).toBe("^1.2.0");
  });

  it("omits constraint when unset, leaving the server's patch-only default", async () => {
    const fetchMock = mockSequence(noContent());
    await client().checkForUpgrade(query);
    expect(lastCall(fetchMock)[0].searchParams.has("constraint")).toBe(false);
  });

  it("still sends the credential, since auth is optional here and not absent", async () => {
    const fetchMock = mockSequence(noContent());
    await client().checkForUpgrade(query);

    const headers = lastCall(fetchMock)[1].headers as Headers;
    expect(headers.get("Authorization")).toBe("License LIC-KEY");
  });

  it("returns the release when one is offered", async () => {
    mockSequence(jsonApi({ data: releaseFixture }));
    const release = await client().checkForUpgrade(query);

    expect(release?.attributes.version).toBe("1.3.0");
    // camelCase on this resource, unlike every other one in the SDK.
    expect(release?.attributes.productId).toBe("prod-1");
  });

  it("returns undefined for a 204 — which means two things, not one", async () => {
    // Case 1: nothing newer exists. Case 2: something newer exists that this
    // license may not have. The server answers identically on purpose.
    mockSequence(noContent());
    expect(await client().checkForUpgrade(query)).toBeUndefined();
  });

  it("returns undefined for a 200 with no data member", async () => {
    mockSequence(jsonApi({}));
    expect(await client().checkForUpgrade(query)).toBeUndefined();
  });

  it("throws, not returns undefined, for a suspended license", async () => {
    // The third outcome, and the one the 204 does NOT absorb.
    mockSequence(
      errorDoc(403, "FORBIDDEN", "The license is suspended and does not have access to this release"),
    );
    await expect(client().checkForUpgrade(query)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws on a Licensed product reached without a credential", async () => {
    mockSequence(errorDoc(401, "UNAUTHORIZED", "A valid license is required to access this release"));
    await expect(client().checkForUpgrade(query)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("reports a plain-text 400 as an API error, not a parse failure", async () => {
    // The handler reads its query string with a bare Axum `Query` extractor,
    // whose rejection body is text. A strict decode would raise a
    // TamgaParseError about JSON and bury the actual complaint.
    mockSequence(plainText("Failed to deserialize query string: missing field `platform`", 400));

    const error = await client()
      .checkForUpgrade(query)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe("UNKNOWN");
  });

  it("maps a bad semver version to its typed error", async () => {
    mockSequence(errorDoc(422, "INVALID_VERSION", "version must be a valid semver string"));
    await expect(client().checkForUpgrade({ ...query, version: "v1" })).rejects.toMatchObject({
      code: "INVALID_VERSION",
      status: 422,
    });
  });
});

describe("TamgaClient.health", () => {
  it("addresses /v1/health at the origin, outside the account path", async () => {
    const fetchMock = mockFlatResponse({ status: "ok", version: "1.8.0", uptime_secs: 42 });
    await client().health();

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/health");
    expect(url.origin).toBe("https://api.tamga.sh");
  });

  it("decodes the flat body — there is no data envelope to unwrap", async () => {
    mockFlatResponse({ status: "ok", version: "1.8.0", uptime_secs: 42 });
    const health = await client().health();

    expect(health).toEqual({ status: "ok", version: "1.8.0", uptime_secs: 42 });
  });

  it("preserves an explicit http:// origin for a local mock server", async () => {
    const fetchMock = mockFlatResponse({ status: "ok", version: "0.0.0", uptime_secs: 1 });
    const local = new TamgaClient({ accountId: "acct_1", baseUrl: "http://localhost:8080/" });
    await local.health();

    expect(lastCall(fetchMock)[0].toString()).toBe("http://localhost:8080/v1/health");
  });

  it("assumes https for a bare host, matching the account-scoped builder", async () => {
    const fetchMock = mockFlatResponse({ status: "ok", version: "0.0.0", uptime_secs: 1 });
    await new TamgaClient({ accountId: "acct_1", baseUrl: "api.tamga.sh" }).health();

    expect(lastCall(fetchMock)[0].toString()).toBe("https://api.tamga.sh/v1/health");
  });

  it("sends the configured credential, which this route simply ignores", async () => {
    const fetchMock = mockFlatResponse({ status: "ok", version: "1.8.0", uptime_secs: 1 });
    await client().health();

    const headers = lastCall(fetchMock)[1].headers as Headers;
    expect(headers.get("Authorization")).toBe("License LIC-KEY");
    expect(headers.get("Tamga-Version")).toBe("1.8");
  });

  it("still raises the host-check 403 it exists to rule out", async () => {
    mockSequence(errorDoc(403, "FORBIDDEN", "The Host header does not match any configured host"));
    await expect(client().health()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
