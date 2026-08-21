/**
 * `@tamga/sdk` — public entrypoint.
 *
 * Official JavaScript/TypeScript SDK for Tamga: license activation, offline
 * verification, and machine management. Documentation: https://tamga.sh
 *
 * Everything re-exported below is the supported surface. Three groups:
 *
 * - {@link TamgaClient} and its models — every networked operation.
 * - `verifyAndDecryptLicenseFile` / `verifyAndDecryptMachineFile` /
 *   `verifyOfflineProof` — offline verification, no network access needed once
 *   the relevant public key is embedded in the calling application.
 * - The `TamgaError` hierarchy — match on the stable `.code`/`.kind`, never on
 *   `.message`.
 *
 * ⚠️ **Auth is enforced server-side, and a license key is not automatically a
 * valid credential.** `Authorization: License <key>` is accepted only when the
 * license's policy sets `authentication_strategy` to `"LICENSE"` or `"MIXED"`;
 * the column defaults to `"TOKEN"`, under which every call returns
 * `401 LICENSE_NOT_ALLOWED` — a configuration precondition, not something a
 * retry or a different key can fix.
 */

export { TamgaClient, MAX_PAGE_SIZE } from "./client.js";
export type {
  TamgaClientConfig,
  CreateMachineOptions,
  ListOptions,
  ListMachinesOptions,
  MachineSortField,
  SortOrder,
  UpdateMachineOptions,
  UpgradeCheckOptions,
} from "./client.js";

export type { AuthCredentials, BasicAuthForm, TransportConfig, ResponseInfo } from "./transport.js";
export { sanitizeVersion, DEFAULT_API_VERSION, DEFAULT_TIMEOUT_MS } from "./transport.js";

export type {
  ValidationCode,
  LicenseValidationResult,
  ValidationResult,
} from "./models/validation.js";
export type { License, LicenseAttributes, LicenseScope, Entitlement, EntitlementAttributes } from "./models/license.js";
export type {
  Machine,
  MachineAttributes,
  Component,
  ComponentAttributes,
  Process,
  ProcessAttributes,
  HeartbeatStatus,
} from "./models/machine.js";
export {
  toPidString,
  heartbeatWindowMsFromMachine,
  MACHINE_HEARTBEAT_WINDOW_MS,
  MACHINE_HEARTBEAT_INTERVAL_DIVISOR,
  PROCESS_HEARTBEAT_WINDOW_MS,
} from "./models/machine.js";
export type { OffsetPage, OffsetPageMeta } from "./models/page.js";
export type { Release, ReleaseAttributes } from "./models/release.js";
export type { HealthStatus } from "./models/health.js";
export type {
  Policy,
  PolicyAttributes,
  LicenseScheme,
  OverageStrategy,
  HeartbeatCullStrategy,
  HeartbeatResurrectionStrategy,
  CheckInInterval,
} from "./models/policy.js";
export {
  overageStrategyAllows,
  resolveOverageStrategy,
  resolveHeartbeatResurrectionStrategy,
  effectiveHeartbeatWindowMs,
  ExpirationStrategy,
  RenewalBasis,
  AuthenticationStrategy,
} from "./models/policy.js";

export {
  TamgaError,
  TamgaNetworkError,
  TamgaParseError,
  TamgaApiErrorException,
  ApiError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  InternalServerErrorException,
  KeyTakenError,
  FingerprintTakenError,
  PidTakenError,
  CheckInNotRequiredError,
  TtlInvalidError,
  LicenseNotEncryptedError,
  LicenseKeyMissingError,
  SchemeNotSupportedError,
  DatasetInvalidError,
  MachineLimitExceededError,
  CoreLimitExceededError,
  MemoryLimitExceededError,
  DiskLimitExceededError,
  TooManyProcessesError,
  LicenseSuspendedError,
  LicenseExpiredError,
  LicenseNotAllowedError,
  CheckoutError,
  ProofError,
  parseApiErrors,
  errorFromApiError,
  apiErrorFromResponseBody,
} from "./errors.js";
export type { TamgaApiError, JsonApiErrorObject, JsonApiErrorSource } from "./errors.js";

export {
  parseLicenseFile,
  verifyAndDecryptLicenseFile,
  verifyLicenseFileWithClaims,
} from "./checkout/licenseFile.js";
export type {
  LicenseFileAlgorithm,
  ParsedLicenseFile,
  LicenseFile,
  LicenseFileResource,
  LicenseFileClaims,
  VerifiedLicenseFile,
} from "./checkout/licenseFile.js";

export {
  parseMachineFile,
  verifyAndDecryptMachineFile,
  verifyMachineFileWithClaims,
  checkTtl,
  MAX_TTL_SECS,
} from "./checkout/machineFile.js";
export type {
  ParsedMachineFile,
  MachineFile,
  MachineFileResource,
  MachineFileClaims,
  VerifiedMachineFile,
} from "./checkout/machineFile.js";

export { parseProofToken, verifyOfflineProof } from "./proof.js";

export { verifyEd25519 } from "./crypto/ed25519.js";
export { verifyEcdsaP256 } from "./crypto/ecdsa.js";
export { verifyRsaPkcs1, verifyRsaPss } from "./crypto/rsa.js";
export { deriveHkdfKey } from "./crypto/hkdf.js";
export { deriveLicenseFileKey } from "./crypto/hkdf.js";
export { decryptAesGcm, encryptAesGcm } from "./crypto/aesGcm.js";
