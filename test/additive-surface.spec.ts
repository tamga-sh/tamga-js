/**
 * Compile-time proof that this release is additive.
 *
 * The surface was also diffed against the base branch's generated
 * `dist/index.d.ts`, which is the check that catches a *removal*. This file
 * covers the other half: that the two declarations which did change — the
 * trailing parameter on `activateMachine` and the new optional property on
 * `ValidationResult` — stay assignable to their previous shapes, so existing
 * consumer code keeps type-checking.
 *
 * Everything here is enforced by `tsc`; the runtime assertions exist only so
 * the file is a valid spec.
 */

import { describe, expect, it } from "vitest";

import { TamgaClient } from "../src/client.js";
import type { CreateMachineOptions } from "../src/client.js";
import type { LicenseScope } from "../src/models/license.js";
import type { ValidationResult } from "../src/models/validation.js";

/** `activateMachine` exactly as it was declared before this change. */
type PreviousActivateMachine = (
  licenseId: string,
  fingerprint: string,
  opts?: CreateMachineOptions,
  scope?: LicenseScope,
  autoDeleteOnOverage?: boolean,
) => Promise<ValidationResult>;

describe("the changed declarations remain backward compatible", () => {
  it("activateMachine still satisfies its previous signature", () => {
    const client = new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
    // Assignable only because the new parameter is trailing and optional.
    const asPrevious: PreviousActivateMachine = client.activateMachine.bind(client);
    expect(typeof asPrevious).toBe("function");
  });

  it("a ValidationResult is still constructible without a machine", () => {
    const result: ValidationResult = {
      license: {
        id: "lic-1",
        type: "licenses",
        attributes: {
          name: null,
          key: null,
          status: "ACTIVE",
          expiry: null,
          suspended: false,
          protected: false,
          uses: 0,
          scheme: null,
          encrypted: false,
          strict: false,
          floating: false,
          max_machines: null,
          max_uses: null,
          max_users: null,
          last_validated_at: null,
          last_check_in_at: null,
          last_check_out_at: null,
          machines_count: 0,
          metadata: {},
          created: "2026-08-21T00:00:00Z",
          updated: "2026-08-21T00:00:00Z",
        },
      },
      meta: { ts: "2026-08-21T00:00:00Z", valid: true, detail: "valid", code: "VALID" },
    };

    expect(result.machine).toBeUndefined();
  });

  it("every method the previous release exposed is still callable", () => {
    const client = new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });
    const previous = [
      "validateByKey",
      "validateById",
      "quickValidate",
      "checkIn",
      "checkOutLicense",
      "checkOutLicenseJson",
      "checkOutMachine",
      "checkOutMachineJson",
      "createMachine",
      "activateMachine",
      "pingHeartbeat",
      "resetHeartbeat",
      "deleteMachine",
      "startHeartbeat",
      "generateOfflineProof",
      "createComponent",
      "listComponents",
      "createProcess",
      "pingProcess",
      "startProcessHeartbeat",
      "listEntitlements",
      "getEntitlement",
      "hasEntitlement",
    ] as const;

    for (const name of previous) {
      expect(typeof client[name]).toBe("function");
    }
  });
});
