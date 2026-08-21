/**
 * Artifact read and download — the three routes a licence key can now reach.
 *
 * `artifact.read`/`artifact.download` were absent from every role's default
 * permission set until `tamga-api@e6d317b` put both on `Role::LicenseToken`
 * (`shared/authz/mod.rs:264-265`) and routed a real handler. These specs pin the
 * three things that are easy to get wrong once the routes are reachable:
 *
 * 1. **The download must not be followed.** The route answers `303 See Other`
 *    at a presigned storage URL by default. `fetch` follows redirects unless
 *    told otherwise, and the Fetch standard only strips `Authorization` across
 *    an *origin* boundary — so a same-origin object store receives the licence
 *    key verbatim. The last describe block proves this against a real HTTP
 *    server rather than a mock, because a mock cannot follow a redirect and so
 *    cannot demonstrate the absence of one.
 * 2. **`created`/`updated`, not `createdAt`/`updatedAt`.** `ArtifactAttributes`
 *    is `rename_all = "camelCase"` *and* carries explicit
 *    `#[serde(rename = "created")]`/`#[serde(rename = "updated")]`
 *    (`artifacts/serializer.rs:20,34-37`), so applying the camelCase rule
 *    uniformly yields two permanently undefined timestamps.
 * 3. **`redirectUrl` is absent on list and show**, present only on the download
 *    action — it is the one attribute carrying
 *    `skip_serializing_if = "Option::is_none"`.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient, ARTIFACT_TTL_MAX_SECONDS, ARTIFACT_TTL_MIN_SECONDS } from "../src/client.js";
import {
  ApiError,
  ForbiddenError,
  TamgaApiErrorException,
  TamgaError,
  TamgaParseError,
  TtlInvalidError,
} from "../src/errors.js";
import { errorDoc, jsonApi, lastCall, mockSequence } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(baseUrl = "https://api.tamga.sh"): TamgaClient {
  return new TamgaClient({
    accountId: "acct_1",
    baseUrl,
    auth: { kind: "license", key: "LIC-KEY" },
  });
}

/** An artifact as list/show serialize it — no `redirectUrl`. */
const artifactFixture = {
  id: "art-1",
  type: "artifacts",
  attributes: {
    filename: "myapp-1.4.2-darwin-arm64.dmg",
    filetype: "dmg",
    filesize: 48_234_112,
    checksum: "sha256:abc",
    platform: "darwin",
    arch: "arm64",
    signature: null,
    status: "UPLOADED",
    metadata: { channel: "stable" },
    created: "2026-08-21T00:00:00Z",
    updated: "2026-08-21T00:00:00Z",
  },
};

/** The same artifact as the download action serializes it — `redirectUrl` present. */
const downloadFixture = {
  ...artifactFixture,
  attributes: {
    ...artifactFixture.attributes,
    redirectUrl: "https://storage.example.com/bucket/art-1?X-Amz-Signature=deadbeef",
  },
};

describe("listReleaseArtifacts", () => {
  it("requests the release-nested collection with the maximum page size", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [artifactFixture] }));

    const artifacts = await client().listReleaseArtifacts("rel-1");

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/releases/rel-1/artifacts");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("page[after]")).toBeNull();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.attributes.filename).toBe("myapp-1.4.2-darwin-arm64.dmg");
  });

  it("passes an explicit limit and keyset cursor through", async () => {
    const fetchMock = mockSequence(jsonApi({ data: [] }));

    await client().listReleaseArtifacts("rel-1", { limit: 5, after: "art-0" });

    const [url] = lastCall(fetchMock);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("page[after]")).toBe("art-0");
  });

  it("does not populate redirectUrl — the list route never presigns", async () => {
    mockSequence(jsonApi({ data: [artifactFixture] }));

    const artifacts = await client().listReleaseArtifacts("rel-1");

    expect(artifacts[0]?.attributes.redirectUrl).toBeUndefined();
  });
});

describe("getArtifact", () => {
  it("addresses the artifact directly under the account, not under its release", async () => {
    const fetchMock = mockSequence(jsonApi({ data: artifactFixture }));

    await client().getArtifact("art-1");

    const [url] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/artifacts/art-1");
  });

  it("reads the timestamps off `created`/`updated`, not `createdAt`/`updatedAt`", async () => {
    mockSequence(jsonApi({ data: artifactFixture }));

    const artifact = await client().getArtifact("art-1");

    // The trap: `rename_all = "camelCase"` plus two explicit renames back.
    expect(artifact.attributes.created).toBe("2026-08-21T00:00:00Z");
    expect(artifact.attributes.updated).toBe("2026-08-21T00:00:00Z");
    expect(Object.keys(artifact.attributes)).not.toContain("createdAt");
    expect(Object.keys(artifact.attributes)).not.toContain("updatedAt");
  });

  it("carries the checksum and signature an updater verifies the bytes with", async () => {
    mockSequence(jsonApi({ data: artifactFixture }));

    const artifact = await client().getArtifact("art-1");

    expect(artifact.attributes.checksum).toBe("sha256:abc");
    expect(artifact.attributes.signature).toBeNull();
  });
});

describe("getArtifactDownloadUrl", () => {
  it("always asks the server not to redirect, and pins fetch to manual", async () => {
    const fetchMock = mockSequence(jsonApi({ data: downloadFixture }));

    await client().getArtifactDownloadUrl("art-1");

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/artifacts/art-1/actions/download");
    expect(url.searchParams.get("redirect")).toBe("false");
    // Belt and braces: even if the server ignored the query parameter.
    expect(init.redirect).toBe("manual");
  });

  it("omits ttl entirely when the caller gives none, leaving the server default", async () => {
    const fetchMock = mockSequence(jsonApi({ data: downloadFixture }));

    await client().getArtifactDownloadUrl("art-1");

    expect(lastCall(fetchMock)[0].searchParams.get("ttl")).toBeNull();
  });

  it("sends ttl in seconds when asked", async () => {
    const fetchMock = mockSequence(jsonApi({ data: downloadFixture }));

    await client().getArtifactDownloadUrl("art-1", { ttlSeconds: 900 });

    expect(lastCall(fetchMock)[0].searchParams.get("ttl")).toBe("900");
  });

  it("lifts redirectUrl out as a non-optional url beside the artifact", async () => {
    mockSequence(jsonApi({ data: downloadFixture }));

    const { artifact, url } = await client().getArtifactDownloadUrl("art-1");

    expect(url).toBe("https://storage.example.com/bucket/art-1?X-Amz-Signature=deadbeef");
    expect(artifact.id).toBe("art-1");
    expect(artifact.attributes.redirectUrl).toBe(url);
  });

  it("raises a parse error rather than returning an artifact with no url", async () => {
    mockSequence(jsonApi({ data: artifactFixture }));

    await expect(client().getArtifactDownloadUrl("art-1")).rejects.toBeInstanceOf(TamgaParseError);
  });

  it("surfaces a bad ttl under the download route's OWN code, not checkout's", async () => {
    mockSequence(
      errorDoc(422, "PRESIGN_TTL_INVALID", "Presigned URL TTL must be between 1 minute and 1 week"),
    );

    // The API spells a bad `ttl` two different ways: `PRESIGN_TTL_INVALID` here
    // (`artifacts/service.rs:33`) and `TTL_INVALID` on the checkout routes
    // (`check_out_license.rs:48`). Only the second has a typed subclass, so this
    // one is deliberately the generic `ApiError` — asserting `TtlInvalidError`
    // here would be asserting a mapping the server does not produce.
    const error = await client()
      .getArtifactDownloadUrl("art-1", { ttlSeconds: ARTIFACT_TTL_MIN_SECONDS - 1 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(TtlInvalidError);
    expect((error as ApiError).code).toBe("PRESIGN_TTL_INVALID");
  });

  it("exports the bounds the server validates against", () => {
    expect(ARTIFACT_TTL_MIN_SECONDS).toBe(60);
    expect(ARTIFACT_TTL_MAX_SECONDS).toBe(604_800);
  });

  it("surfaces the owning release's gate as a 403, which is not an auth misconfiguration", async () => {
    mockSequence(
      errorDoc(403, "FORBIDDEN", "The release is not available under its distribution strategy"),
    );

    // A CLOSED release refuses its binary even to a caller holding
    // `artifact.download` — `enforce_release_access` runs after the permission
    // check (`download_artifact.rs:46-59`).
    await expect(client().getArtifactDownloadUrl("art-1")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("the download action's 303 is never followed", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /**
   * Starts a server that 303s the download action at a **same-origin** path and
   * records every request it sees, with the `Authorization` header attached.
   *
   * Same-origin is the case that matters. The Fetch standard deletes
   * `Authorization` when a redirect crosses an origin, so a hop to a different
   * host is safe on its own; a deployment serving path-style object storage from
   * the API's own origin is not, and `s3_endpoint` + `s3_force_path_style`
   * exist to allow exactly that.
   */
  async function startRedirectingServer(): Promise<{
    origin: string;
    seen: { url: string; authorization: string }[];
  }> {
    const seen: { url: string; authorization: string }[] = [];
    const created = createServer((req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization ?? "(none)" });
      if ((req.url ?? "").includes("/actions/download")) {
        res.writeHead(303, { Location: "/object-store/art-1?X-Amz-Signature=deadbeef" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("ARTIFACT-BYTES");
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    const address = created.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { origin: `http://127.0.0.1:${port}`, seen };
  }

  it("throws instead of chasing the redirect, and the storage path is never requested", async () => {
    const { origin, seen } = await startRedirectingServer();

    const error = await client(origin)
      .getArtifactDownloadUrl("art-1")
      .catch((e: unknown) => e);

    // Specifically the transport's redirect guard, not the generic not-ok path.
    // Both would throw, but only one says what actually happened: without the
    // guard a suppressed 303 decodes as an `ApiError` with code `"UNKNOWN"`,
    // which tells a caller nothing about the redirect they just dodged.
    expect(error).toBeInstanceOf(TamgaError);
    expect(error).not.toBeInstanceOf(TamgaApiErrorException);
    expect((error as Error).message).toMatch(/deliberately did not follow/);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/actions/download");
    expect(seen.some((r) => r.url.startsWith("/object-store/"))).toBe(false);
  });

  it("never presents the licence key to the redirect target", async () => {
    const { origin, seen } = await startRedirectingServer();

    await expect(client(origin).getArtifactDownloadUrl("art-1")).rejects.toBeTruthy();

    // The API call itself is authenticated, as every call is...
    expect(seen[0]?.authorization).toBe("License LIC-KEY");
    // ...and nothing after it exists to carry the key anywhere else.
    expect(seen.filter((r) => r.authorization !== "(none)")).toHaveLength(1);
  });

  it("proves the hazard is real: the same redirect IS followed with credentials by default", async () => {
    const { origin, seen } = await startRedirectingServer();

    // No `redirect: "manual"`, no `?redirect=false` — i.e. what a naive
    // implementation, and this repo's own `doFetch` default, would do.
    const response = await fetch(`${origin}/v1/accounts/acct_1/artifacts/art-1/actions/download`, {
      headers: { Authorization: "License LIC-KEY" },
    });

    expect(await response.text()).toBe("ARTIFACT-BYTES");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toContain("/object-store/");
    // This is the leak the SDK's two mitigations exist to prevent.
    expect(seen[1]?.authorization).toBe("License LIC-KEY");
  });
});
