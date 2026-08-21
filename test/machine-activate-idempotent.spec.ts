/**
 * `activateMachine`'s idempotent exit from `409 FINGERPRINT_TAKEN`.
 *
 * The server reports re-registering a known fingerprint as a conflict on
 * purpose — its own comment reads "already activated, carry on" — but the `409`
 * does not name the machine that holds the fingerprint, so a client had no way
 * to actually carry on. These tests pin both halves: the recovery, and the
 * cases where recovering would be wrong.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TamgaClient } from "../src/client.js";
import { FingerprintTakenError } from "../src/errors.js";
import { errorDoc, jsonApi, mockSequence, nthCall } from "./helpers/mockFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): TamgaClient {
  return new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
}

const licenseFixture = { id: "lic-1", type: "licenses", attributes: { key: "LIC-KEY" } };
const existingMachine = { id: "m-existing", type: "machines", attributes: { fingerprint: "fp-1" } };
const newMachine = { id: "m-new", type: "machines", attributes: { fingerprint: "fp-1" } };

function validation(code: string, valid = true): Response {
  return jsonApi({
    data: licenseFixture,
    meta: { ts: "2026-08-21T00:00:00Z", valid, detail: code, code },
  });
}

function machinePage(...machines: unknown[]): Response {
  return jsonApi({
    data: machines,
    meta: { page: { number: 1, size: 100, total: machines.length, totalPages: 1 } },
  });
}

describe("activateMachine without reuseExistingMachine", () => {
  it("still throws FINGERPRINT_TAKEN — reuse is opt-in", async () => {
    const fetchMock = mockSequence(errorDoc(409, "FINGERPRINT_TAKEN", "already activated"));

    await expect(client().activateMachine("lic-1", "fp-1")).rejects.toBeInstanceOf(
      FingerprintTakenError,
    );
    // No lookup, no validate: exactly the pre-existing one-call behaviour.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("activateMachine with reuseExistingMachine", () => {
  it("recovers the existing machine and returns it alongside the verdict", async () => {
    const fetchMock = mockSequence(
      errorDoc(409, "FINGERPRINT_TAKEN", "already activated"),
      machinePage(existingMachine),
      validation("VALID"),
    );

    const result = await client().activateMachine("lic-1", "fp-1", {}, undefined, false, true);

    expect(result.machine?.id).toBe("m-existing");
    expect(result.meta.code).toBe("VALID");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The lookup is confined to the license being activated.
    expect(nthCall(fetchMock, 1)[0].searchParams.get("filter[license]")).toBe("lic-1");
  });

  it("is idempotent — a second run yields the same machine and verdict", async () => {
    const c = client();
    mockSequence(jsonApi({ data: newMachine }), validation("VALID"));
    const first = await c.activateMachine("lic-1", "fp-1", {}, undefined, false, true);

    vi.unstubAllGlobals();
    mockSequence(
      errorDoc(409, "FINGERPRINT_TAKEN", "already activated"),
      machinePage(newMachine),
      validation("VALID"),
    );
    const second = await c.activateMachine("lic-1", "fp-1", {}, undefined, false, true);

    expect(second.machine?.id).toBe(first.machine?.id);
    expect(second.meta.code).toBe(first.meta.code);
  });

  it("re-throws when the fingerprint is not on this license", async () => {
    // `machine_uniqueness_strategy` can be UNIQUE_PER_POLICY or
    // UNIQUE_PER_ACCOUNT, under which the conflicting machine sits on some
    // *other* license — this activation genuinely did not happen, and the
    // `machines` resource carries no `license_id` to prove otherwise.
    const fetchMock = mockSequence(
      errorDoc(409, "FINGERPRINT_TAKEN", "already activated within the policy's uniqueness scope"),
      machinePage(),
    );

    await expect(
      client().activateMachine("lic-1", "fp-1", {}, undefined, false, true),
    ).rejects.toBeInstanceOf(FingerprintTakenError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse on a conflict that is not FINGERPRINT_TAKEN", async () => {
    const fetchMock = mockSequence(errorDoc(409, "KEY_TAKEN", "key taken"));

    await expect(
      client().activateMachine("lic-1", "fp-1", {}, undefined, false, true),
    ).rejects.toMatchObject({ code: "KEY_TAKEN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never rolls back a machine it did not create", async () => {
    // autoDeleteOnOverage + a reused machine: deleting here would destroy an
    // already-activated seat this call had nothing to do with.
    const fetchMock = mockSequence(
      errorDoc(409, "FINGERPRINT_TAKEN", "already activated"),
      machinePage(existingMachine),
      validation("TOO_MANY_MACHINES", false),
    );

    const result = await client().activateMachine("lic-1", "fp-1", {}, undefined, true, true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit).method === "DELETE")).toBe(
      false,
    );
    expect(result.machine?.id).toBe("m-existing");
  });
});

describe("activateMachine's reported machine", () => {
  it("reports the machine it just created", async () => {
    mockSequence(jsonApi({ data: newMachine }), validation("VALID"));
    const result = await client().activateMachine("lic-1", "fp-1");
    expect(result.machine?.id).toBe("m-new");
  });

  it("reports no machine when a create-time limit refused the create", async () => {
    mockSequence(errorDoc(422, "MACHINE_LIMIT_EXCEEDED", "limit reached"), validation("VALID"));
    const result = await client().activateMachine("lic-1", "fp-1");

    expect(result.machine).toBeUndefined();
    expect(result.meta.code).toBe("TOO_MANY_MACHINES");
  });

  it("reports no machine once autoDeleteOnOverage has rolled it back", async () => {
    const fetchMock = mockSequence(
      jsonApi({ data: newMachine }),
      validation("TOO_MANY_MACHINES", false),
      new Response(null, { status: 204 }),
    );
    const result = await client().activateMachine("lic-1", "fp-1", {}, undefined, true);

    expect(result.machine).toBeUndefined();
    expect(nthCall(fetchMock, 2)[1].method).toBe("DELETE");
  });
});
