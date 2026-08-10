import { describe, expect, it } from "vitest";
import type { ValidationCode, LicenseValidationResult } from "../src/models/validation.js";

const ALL_24_KNOWN_CODES: ValidationCode[] = [
  "VALID",
  "SUSPENDED",
  "EXPIRED",
  "OVERDUE",
  "PRODUCT_SCOPE_MISMATCH",
  "POLICY_SCOPE_MISMATCH",
  "USER_SCOPE_MISMATCH",
  "ENVIRONMENT_SCOPE_MISMATCH",
  "TOO_MANY_MACHINES",
  "TOO_MANY_CORES",
  "TOO_MUCH_MEMORY",
  "TOO_MUCH_DISK",
  "TOO_MANY_PROCESSES",
  "TOO_MANY_USES",
  "NOT_FOUND",
  "BANNED",
  "ENTITLEMENTS_MISSING",
  "TOO_MANY_USERS",
  "HEARTBEAT_DEAD",
  "HEARTBEAT_NOT_STARTED",
  "FINGERPRINT_SCOPE_MISMATCH",
  "COMPONENTS_SCOPE_MISMATCH",
  "CHECKSUM_SCOPE_MISMATCH",
  "VERSION_SCOPE_MISMATCH",
];

describe("ValidationCode", () => {
  it("models all 24 documented wire values", () => {
    expect(ALL_24_KNOWN_CODES).toHaveLength(24);
  });

  it("accepts an arbitrary unknown string via the open-union escape hatch", () => {
    const code: ValidationCode = "SOME_FUTURE_CODE_NOT_YET_DOCUMENTED";
    expect(typeof code).toBe("string");
  });

  it("a LicenseValidationResult with an unknown code round-trips through JSON without loss", () => {
    const result: LicenseValidationResult = {
      ts: "2026-01-01T00:00:00Z",
      valid: false,
      detail: "future code",
      code: "SOME_FUTURE_CODE",
    };
    const roundTripped = JSON.parse(JSON.stringify(result)) as LicenseValidationResult;
    expect(roundTripped.code).toBe("SOME_FUTURE_CODE");
  });
});
