/**
 * @tamga/sdk — public entrypoint.
 *
 * SCAFFOLD STATE: this package currently exports types and stub
 * functions/classes only. No network calls, cryptographic verification, or
 * offline-file parsing is implemented yet — see
 * `docs/plans/tamga-js.plan.md` (Sections B–K) for the remaining work and
 * `/Users/neco/Projects/tamga-api/docs/sdk.md` for the protocol this SDK
 * implements against.
 */

export { TamgaClient } from "./client.js";
export type { TamgaClientConfig } from "./client.js";

export type { AuthCredentials, TransportConfig } from "./transport.js";

export type { ValidationCode, LicenseValidationResult } from "./models/validation.js";
export type { License, LicenseScope, Entitlement } from "./models/license.js";
export type { Machine, Component, Process, HeartbeatStatus } from "./models/machine.js";
export type {
  Policy,
  LicenseScheme,
  OverageStrategy,
  HeartbeatCullStrategy,
  HeartbeatResurrectionStrategy,
} from "./models/policy.js";

export { TamgaError, parseApiErrors } from "./errors.js";
export type { TamgaApiError } from "./errors.js";

export { parseLicenseFile, verifyAndDecryptLicenseFile } from "./checkout/licenseFile.js";
export type { LicenseFileAlgorithm, ParsedLicenseFile } from "./checkout/licenseFile.js";

export { parseMachineFile, verifyAndDecryptMachineFile } from "./checkout/machineFile.js";
export type { ParsedMachineFile } from "./checkout/machineFile.js";

export { parseProofToken, verifyOfflineProof } from "./proof.js";
