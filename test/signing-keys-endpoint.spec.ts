/**
 * `GET /signing-keys` — `listSigningKeys` and `getSigningKeySet`.
 *
 * The response shape is transcribed from the server's `accounts/serializer.rs`:
 * resource `id` is the `kid` (not a UUID), and `publicKey` is the one camelCase
 * attribute in an otherwise snake_case resource.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient } from "../src/client.js";
import { SigningKeySet } from "../src/checkout/keySet.js";
import { ForbiddenError } from "../src/errors.js";
import { lastCall, mockApiError, mockJsonApiResponse } from "./helpers/mockFetch.js";

const ZERO_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ZERO_KEY_KID = "51643eac9777b63a";

function client(): TamgaClient {
  return new TamgaClient({
    accountId: "acct_1",
    baseUrl: "https://api.tamga.sh",
    auth: { kind: "bearer", token: "tok_1" },
  });
}

/** The two-key response an account that has rotated once returns. */
function rotatedAccountKeys(): unknown[] {
  return [
    {
      type: "signing-keys",
      id: "aaaaaaaaaaaaaaaa",
      attributes: {
        algorithm: "ed25519",
        publicKey: ZERO_KEY_B64,
        status: "active",
        created: "2026-06-01T00:00:00Z",
      },
    },
    {
      type: "signing-keys",
      id: ZERO_KEY_KID,
      attributes: {
        algorithm: "ed25519",
        publicKey: ZERO_KEY_B64,
        status: "retired",
        created: "2026-01-01T00:00:00Z",
        retired: "2026-06-01T00:00:00Z",
      },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listSigningKeys", () => {
  it("GETs the account-scoped /signing-keys route", async () => {
    const fetchMock = mockJsonApiResponse(rotatedAccountKeys());

    await client().listSigningKeys();

    const [url, init] = lastCall(fetchMock);
    expect(url.pathname).toBe("/v1/accounts/acct_1/signing-keys");
    expect(init.method).toBe("GET");
  });

  it("returns the retired key as well as the active one", async () => {
    // The whole point of the route. A response filtered to active keys cannot
    // verify anything issued before the last rotation.
    mockJsonApiResponse(rotatedAccountKeys());

    const keys = await client().listSigningKeys();

    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.attributes.status)).toEqual(["active", "retired"]);
  });

  it("reads the id as the kid, not a UUID", async () => {
    mockJsonApiResponse(rotatedAccountKeys());

    const keys = await client().listSigningKeys();

    expect(keys[0]?.id).toBe("aaaaaaaaaaaaaaaa");
    expect(keys[0]?.id).not.toMatch(/-/);
  });

  it("reads publicKey from the camelCase wire name", async () => {
    mockJsonApiResponse(rotatedAccountKeys());

    const keys = await client().listSigningKeys();

    expect(keys[0]?.attributes.publicKey).toBe(ZERO_KEY_B64);
  });

  it("leaves retired absent on an active key rather than nulling it", async () => {
    mockJsonApiResponse(rotatedAccountKeys());

    const keys = await client().listSigningKeys();

    expect(keys[0]?.attributes.retired).toBeUndefined();
    expect(keys[1]?.attributes.retired).toBe("2026-06-01T00:00:00Z");
  });

  it("surfaces the license-key role's 403 as ForbiddenError", async () => {
    // Gated on `account.read`, which the license-key role does not hold. No
    // amount of account configuration changes this, so it must not look like a
    // retryable auth failure.
    mockApiError(403, "FORBIDDEN");

    await expect(client().listSigningKeys()).rejects.toThrow(ForbiddenError);
  });
});

describe("getSigningKeySet", () => {
  it("returns a set indexed by the served ids", async () => {
    mockJsonApiResponse(rotatedAccountKeys());

    const keySet = await client().getSigningKeySet();

    expect(keySet).toBeInstanceOf(SigningKeySet);
    expect(keySet.size).toBe(2);
    expect(keySet.keyIds).toEqual(["aaaaaaaaaaaaaaaa", ZERO_KEY_KID]);
  });

  it("flags the served id that disagrees with the key it was served with", async () => {
    // Both rows carry the same public key, so only one of the two served ids
    // can be the id of that key. The mismatch is reported rather than thrown.
    mockJsonApiResponse(rotatedAccountKeys());

    const keySet = await client().getSigningKeySet();

    expect(keySet.mismatches).toHaveLength(1);
    expect(keySet.mismatches[0]?.servedKeyId).toBe("aaaaaaaaaaaaaaaa");
    expect(keySet.mismatches[0]?.computedKeyId).toBe(ZERO_KEY_KID);
  });

  it("skips an unusable published key without failing the whole set", async () => {
    mockJsonApiResponse([
      {
        type: "signing-keys",
        id: "bbbbbbbbbbbbbbbb",
        attributes: {
          algorithm: "ml-dsa-44",
          publicKey: ZERO_KEY_B64,
          status: "active",
          created: "2026-06-01T00:00:00Z",
        },
      },
      ...rotatedAccountKeys(),
    ]);

    const keySet = await client().getSigningKeySet();

    expect(keySet.size).toBe(2);
    expect(keySet.has("bbbbbbbbbbbbbbbb")).toBe(false);
  });

  it("returns an empty set for an account with no published keys", async () => {
    mockJsonApiResponse([]);

    const keySet = await client().getSigningKeySet();

    expect(keySet.size).toBe(0);
  });
});
