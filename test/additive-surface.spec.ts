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
import { verifyAndDecryptLicenseFile, verifyLicenseFileWithClaims } from "../src/checkout/licenseFile.js";
import type { VerifiedLicenseFile } from "../src/checkout/licenseFile.js";
import { verifyAndDecryptMachineFile, verifyMachineFileWithClaims } from "../src/checkout/machineFile.js";
import type { VerifiedMachineFile } from "../src/checkout/machineFile.js";
import type { License } from "../src/models/license.js";
import type { Machine } from "../src/models/machine.js";
import type { LicenseScheme } from "../src/models/policy.js";
import type { RequestOptions } from "../src/transport.js";

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

/**
 * The signing-key-rotation change (`fix/signing-key-rotation`) is additive: it
 * adds key-set-aware entry points beside the single-key ones rather than
 * changing them. The four pre-existing verification signatures are re-declared
 * here exactly as they shipped, so a change to any of them fails `tsc`.
 *
 * The generated `dist/index.d.ts` was also diffed against the base branch's:
 * zero exported names removed, and the only textual difference in the whole
 * file is the final `export { ... }` manifest gaining the new names. That diff
 * is the check that catches a *removal*; this file catches a *reshaping*.
 */
type PreviousVerifyAndDecryptLicenseFile = (
  pem: string,
  ed25519PublicKey: Uint8Array,
  licenseKey?: string,
  now?: number,
) => Promise<License>;

type PreviousVerifyLicenseFileWithClaims = (
  pem: string,
  ed25519PublicKey: Uint8Array,
  licenseKey?: string,
  now?: number,
) => Promise<VerifiedLicenseFile>;

type PreviousVerifyAndDecryptMachineFile = (
  pem: string,
  scheme: LicenseScheme,
  publicKey: Uint8Array,
  keyMaterial?: { licenseKey: string; fingerprint: string },
  now?: number,
) => Promise<Machine>;

type PreviousVerifyMachineFileWithClaims = (
  pem: string,
  scheme: LicenseScheme,
  publicKey: Uint8Array,
  keyMaterial?: { licenseKey: string; fingerprint: string },
  now?: number,
) => Promise<VerifiedMachineFile>;

describe("the offline verification surface only grew", () => {
  it("every single-key entry point still satisfies its previous signature", () => {
    const a: PreviousVerifyAndDecryptLicenseFile = verifyAndDecryptLicenseFile;
    const b: PreviousVerifyLicenseFileWithClaims = verifyLicenseFileWithClaims;
    const c: PreviousVerifyAndDecryptMachineFile = verifyAndDecryptMachineFile;
    const d: PreviousVerifyMachineFileWithClaims = verifyMachineFileWithClaims;

    for (const fn of [a, b, c, d]) expect(typeof fn).toBe("function");
  });

  it("the new client methods sit beside the previous ones, not in place of them", () => {
    const client = new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });

    expect(typeof client.listSigningKeys).toBe("function");
    expect(typeof client.getSigningKeySet).toBe("function");
    // ...and the checkout methods a caller already had are untouched.
    expect(typeof client.checkOutLicense).toBe("function");
    expect(typeof client.checkOutMachine).toBe("function");
  });
});

/**
 * The artifact read/download change (M25) is additive in the same way: three
 * new client methods, one new model module, and one new **optional** property
 * on the transport's `RequestOptions`. The optionality is the load-bearing part
 * — every existing call site constructs a `RequestOptions` without `redirect`,
 * so a required field there would break all of them at once.
 */
type PreviousRequestOptions = {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

describe("the artifact surface only grew", () => {
  it("a RequestOptions built the previous way is still a RequestOptions", () => {
    const previous: PreviousRequestOptions = { method: "GET", path: "/licenses/lic-1" };
    // Assignable only because `redirect` is optional.
    const current: RequestOptions = previous;
    expect(current.redirect).toBeUndefined();
  });

  it("the new artifact methods sit beside the release ones, not in place of them", () => {
    const client = new TamgaClient({ accountId: "acct_1", baseUrl: "https://api.tamga.sh" });

    expect(typeof client.listReleaseArtifacts).toBe("function");
    expect(typeof client.getArtifact).toBe("function");
    expect(typeof client.getArtifactDownloadUrl).toBe("function");
    // ...and the auto-update check a caller already had is untouched.
    expect(typeof client.checkForUpgrade).toBe("function");
  });
});
