/**
 * Error model for @tamga/sdk.
 *
 * Ground-truthed against `tamga-rust`'s `src/error.rs` (the reference
 * implementation for this SDK family) and the Tamga API protocol
 * specification §11.
 *
 * - `TamgaApiError`: `{ status, code, detail, pointer? }`, a flattened form
 *   of the server's JSON:API error object (`id`, `status`, `code`, `title`,
 *   `detail`, `source.pointer`) — `status` is coerced to a `number` (the
 *   wire value is a JSON:API-convention string, e.g. `"404"`).
 * - `parseApiErrors` parses the `{"errors": [...]}` envelope
 *   (`Content-Type: application/vnd.api+json`) into `TamgaApiError[]`.
 * - Typed subclasses of `TamgaError`, one per fixed-status/per-endpoint
 *   code, each carrying a static `.code` for matching. `errorFromApiError`
 *   dispatches a parsed `TamgaApiError` to its most specific subclass,
 *   falling back to the generic `TamgaApiErrorException` for any code
 *   without a dedicated variant (mirrors `TamgaError::from_json_api_error`).
 * - Matcher helpers key on `code` (stable), never on `detail` (human text,
 *   may change) — see the Tamga API protocol specification §11.
 *
 * ## Auth errors are reachable
 *
 * `401 UNAUTHORIZED` / `403 FORBIDDEN` are **not** placeholders on this SDK's
 * endpoints. License-key auth (`{ kind: "license", key }`) is only accepted
 * when the license's policy sets `authentication_strategy` to `"LICENSE"` or
 * `"MIXED"` — and that column defaults to `"TOKEN"`, under which a license key
 * is rejected with `401 LICENSE_NOT_ALLOWED`. See {@link LicenseNotAllowedError}.
 *
 * `429 TOO_MANY_REQUESTS` is live and is handled one layer down, in
 * `src/transport.ts` — a retryable request is retried transparently there
 * (parsed and capped `Retry-After`, otherwise jittered exponential backoff) and
 * only surfaces as an error here once the retry budget is spent. It has no
 * dedicated subclass below on purpose: by the time a 429 reaches the caller,
 * backing off further is a policy decision only the caller can make, so it maps
 * to the generic {@link ApiError} with `code === "TOO_MANY_REQUESTS"`.
 */

/** `source.pointer` on a JSON:API error object (RFC 6901 JSON Pointer). */
export interface JsonApiErrorSource {
  pointer?: string;
}

/** A single JSON:API error object, as sent by the server. */
export interface JsonApiErrorObject {
  id: string;
  /**
   * JSON:API convention is a string (`"409"`). The API patch's new `422`s may
   * put a JSON number here; {@link parseApiErrors} accepts both.
   */
  status: string;
  code: string;
  title: string;
  detail: string;
  source?: JsonApiErrorSource;
  /**
   * Per-error metadata. Today the only member: on `409 FINGERPRINT_TAKEN`,
   * `{ "machineId": "<uuid>" }` — the machine already holding the
   * fingerprint, present ONLY when it is on the license being activated.
   */
  meta?: Record<string, unknown>;
}

/** Top-level JSON:API error document: `{ "errors": [ ... ] }`. */
export interface JsonApiErrorDocument {
  errors: JsonApiErrorObject[];
}

/**
 * A single JSON:API error object as returned by the Tamga API, flattened
 * for SDK consumption. `status` is coerced to a `number`; `pointer` (if
 * present) is lifted out of the nested `source` object; `meta` is copied
 * verbatim when the server sent a plain object.
 */
export interface TamgaApiError {
  status: number;
  code: string;
  detail: string;
  pointer?: string;
  meta?: Record<string, unknown>;
}

/**
 * Base error class for all errors raised by this SDK. Concrete subclasses
 * below carry a stable static `.code` (for `TamgaApiErrorException`
 * subclasses) — always match on `code`, never on `message`/`detail`.
 */
export class TamgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TamgaError";
  }
}

/** The underlying `fetch` call itself failed (network, TLS, timeout). */
export class TamgaNetworkError extends TamgaError {
  constructor(
    message: string,
    readonly cause2?: unknown,
  ) {
    super(message);
    this.name = "TamgaNetworkError";
  }
}

/** A response body could not be parsed as the expected JSON shape. */
export class TamgaParseError extends TamgaError {
  constructor(message: string) {
    super(message);
    this.name = "TamgaParseError";
  }
}

/**
 * Base class for every error backed by a server-returned
 * {@link TamgaApiError}. `code` is always the stable, machine-matchable
 * JSON:API error code — match on it, never on `detail`/`message`.
 */
export class TamgaApiErrorException extends TamgaError {
  readonly apiError: TamgaApiError;

  constructor(apiError: TamgaApiError, message?: string) {
    super(message ?? `API error ${apiError.code}: ${apiError.detail}`);
    this.name = "TamgaApiErrorException";
    this.apiError = apiError;
  }

  get code(): string {
    return this.apiError.code;
  }

  get status(): number {
    return this.apiError.status;
  }
}

/** `404 NOT_FOUND` — the requested resource doesn't exist. */
export class NotFoundError extends TamgaApiErrorException {
  static readonly CODE = "NOT_FOUND";
  constructor(apiError: TamgaApiError) {
    super(apiError, `not found: ${apiError.detail}`);
    this.name = "NotFoundError";
  }
}

/**
 * `401 UNAUTHORIZED` — missing or invalid credentials. Fully reachable on
 * the license and machine endpoints this SDK calls: authentication is
 * enforced server-side. A license key additionally has to be *permitted* by
 * the license's policy — see {@link LicenseNotAllowedError}, which is the
 * more specific 401 a misconfigured policy produces.
 */
export class UnauthorizedError extends TamgaApiErrorException {
  static readonly CODE = "UNAUTHORIZED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `unauthorized: ${apiError.detail}`);
    this.name = "UnauthorizedError";
  }
}

/** `403 FORBIDDEN` — credentials valid, but not permitted for this operation. */
export class ForbiddenError extends TamgaApiErrorException {
  static readonly CODE = "FORBIDDEN";
  constructor(apiError: TamgaApiError) {
    super(apiError, `forbidden: ${apiError.detail}`);
    this.name = "ForbiddenError";
  }
}

/**
 * `500 INTERNAL_SERVER_ERROR` — generic server-side failure. The server
 * never leaks DB/internal detail into `detail` for this code.
 */
export class InternalServerErrorException extends TamgaApiErrorException {
  static readonly CODE = "INTERNAL_SERVER_ERROR";
  constructor(apiError: TamgaApiError) {
    super(apiError, `internal server error: ${apiError.detail}`);
    this.name = "InternalServerErrorException";
  }
}

/** `409 KEY_TAKEN` — a license with this key already exists on this account. */
export class KeyTakenError extends TamgaApiErrorException {
  static readonly CODE = "KEY_TAKEN";
  constructor(apiError: TamgaApiError) {
    super(apiError, `key taken: ${apiError.detail}`);
    this.name = "KeyTakenError";
  }
}

/**
 * `409 FINGERPRINT_TAKEN` — a machine (or component) with this fingerprint
 * already exists in its unique scope.
 */
export class FingerprintTakenError extends TamgaApiErrorException {
  static readonly CODE = "FINGERPRINT_TAKEN";
  constructor(apiError: TamgaApiError) {
    super(apiError, `fingerprint taken: ${apiError.detail}`);
    this.name = "FingerprintTakenError";
  }

  /**
   * The id of the machine already holding the fingerprint, when the server
   * named it (`meta.machineId`).
   *
   * The server names it ONLY when that machine is on the license being
   * activated. A conflict raised by a wider `machine_uniqueness_strategy`
   * against another license's machine carries no `meta`, and a pre-patch
   * server never sends it — both read as `undefined`, and
   * {@link import("./client.js").TamgaClient.activateMachine} then falls
   * back to its license-scoped search.
   */
  get existingMachineId(): string | undefined {
    const machineId = this.apiError.meta?.machineId;
    return typeof machineId === "string" ? machineId : undefined;
  }
}

/** `409 PID_TAKEN` — a process with this PID already exists on this machine. */
export class PidTakenError extends TamgaApiErrorException {
  static readonly CODE = "PID_TAKEN";
  constructor(apiError: TamgaApiError) {
    super(apiError, `pid taken: ${apiError.detail}`);
    this.name = "PidTakenError";
  }
}

/**
 * `422 CHECK_IN_NOT_REQUIRED` — a **caller error**, not something to retry.
 * Callers should check `require_check_in` on the license's policy before
 * scheduling periodic check-ins, rather than reacting to this error with
 * retry logic.
 */
export class CheckInNotRequiredError extends TamgaApiErrorException {
  static readonly CODE = "CHECK_IN_NOT_REQUIRED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `check-in not required: ${apiError.detail}`);
    this.name = "CheckInNotRequiredError";
  }
}

/**
 * `422 TTL_INVALID` — the server rejected a `ttl` outside `(0, 31536000]`.
 * The SDK also pre-checks this client-side (see
 * `src/checkout/machineFile.ts`'s `checkTtl`), so this is normally only
 * reachable if that client-side check was bypassed.
 */
export class TtlInvalidError extends TamgaApiErrorException {
  static readonly CODE = "TTL_INVALID";
  constructor(apiError: TamgaApiError) {
    super(apiError, `ttl invalid: ${apiError.detail}`);
    this.name = "TtlInvalidError";
  }
}

/**
 * `422 LICENSE_NOT_ENCRYPTED` — the server rejected an `encrypt: true`
 * license checkout because the license has no `key` set.
 */
export class LicenseNotEncryptedError extends TamgaApiErrorException {
  static readonly CODE = "LICENSE_NOT_ENCRYPTED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `license not encrypted: ${apiError.detail}`);
    this.name = "LicenseNotEncryptedError";
  }
}

/**
 * `422 LICENSE_KEY_MISSING` — the server rejected an `encrypt: true`
 * machine checkout because the machine's license has no `key` set.
 * Distinct API error code from `LICENSE_NOT_ENCRYPTED` despite the similar
 * meaning.
 */
export class LicenseKeyMissingError extends TamgaApiErrorException {
  static readonly CODE = "LICENSE_KEY_MISSING";
  constructor(apiError: TamgaApiError) {
    super(apiError, `license key missing: ${apiError.detail}`);
    this.name = "LicenseKeyMissingError";
  }
}

/**
 * `422 SCHEME_NOT_SUPPORTED` — the server rejected a machine checkout
 * because the license's scheme is `RSA_2048_JWT_RS256`.
 */
export class SchemeNotSupportedError extends TamgaApiErrorException {
  static readonly CODE = "SCHEME_NOT_SUPPORTED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `scheme not supported: ${apiError.detail}`);
    this.name = "SchemeNotSupportedError";
  }
}

/**
 * `422 DATASET_INVALID` — `meta.dataset` sent to `generate-offline-proof`
 * wasn't a JSON object (arrays/scalars are rejected).
 */
export class DatasetInvalidError extends TamgaApiErrorException {
  static readonly CODE = "DATASET_INVALID";
  constructor(apiError: TamgaApiError) {
    super(apiError, `dataset invalid: ${apiError.detail}`);
    this.name = "DatasetInvalidError";
  }
}

/**
 * `422 MACHINE_LIMIT_EXCEEDED` — `POST /machines` was refused because the
 * license is already at (or would exceed) its machine limit.
 *
 * ⚠️ Creation **does** run the limit check — it is not deferred to validate.
 * Whether it fires depends on the policy's `overage_strategy`: under
 * `NO_OVERAGE` the create is refused with this code, while `ALLOW_ACCESS` /
 * `ALLOW_1_25X_OVERAGE` / … let the create through and surface the overage
 * later as a `TOO_MANY_MACHINES` validation code. {@link
 * import("./client.js").TamgaClient.activateMachine} handles both paths.
 */
export class MachineLimitExceededError extends TamgaApiErrorException {
  static readonly CODE = "MACHINE_LIMIT_EXCEEDED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `machine limit exceeded: ${apiError.detail}`);
    this.name = "MachineLimitExceededError";
  }
}

/**
 * `422 CORE_LIMIT_EXCEEDED` — `POST /machines` was refused because the
 * reported `cores` would push the license over `policy.max_cores`. Same
 * create-time-vs-validate-time split as {@link MachineLimitExceededError}.
 */
export class CoreLimitExceededError extends TamgaApiErrorException {
  static readonly CODE = "CORE_LIMIT_EXCEEDED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `core limit exceeded: ${apiError.detail}`);
    this.name = "CoreLimitExceededError";
  }
}

/**
 * `422 MEMORY_LIMIT_EXCEEDED` — `POST /machines` was refused because the
 * reported `memory` would push the license over `policy.max_memory`.
 *
 * ⚠️ `memory` is in **megabytes** (see {@link
 * import("./client.js").CreateMachineOptions}). Reporting bytes inflates the
 * account's tally by ~1e6 and makes this the error every subsequent
 * activation on the license hits.
 */
export class MemoryLimitExceededError extends TamgaApiErrorException {
  static readonly CODE = "MEMORY_LIMIT_EXCEEDED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `memory limit exceeded: ${apiError.detail}`);
    this.name = "MemoryLimitExceededError";
  }
}

/**
 * `422 DISK_LIMIT_EXCEEDED` — `POST /machines` was refused because the
 * reported `disk` would push the license over `policy.max_disk`. `disk` is
 * in **megabytes**; see {@link MemoryLimitExceededError}.
 */
export class DiskLimitExceededError extends TamgaApiErrorException {
  static readonly CODE = "DISK_LIMIT_EXCEEDED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `disk limit exceeded: ${apiError.detail}`);
    this.name = "DiskLimitExceededError";
  }
}

/**
 * `422 TOO_MANY_PROCESSES` — `POST /processes` was refused because the
 * license is already at `policy.max_processes`. Spawn-time enforcement;
 * retrying the same spawn keeps returning this code.
 *
 * Shares its wire string with the `TOO_MANY_PROCESSES` {@link
 * import("./models/validation.js").ValidationCode}, which reports the same
 * condition on a *successful* 200 validate response — this class is only
 * ever the `422` form.
 */
export class TooManyProcessesError extends TamgaApiErrorException {
  static readonly CODE = "TOO_MANY_PROCESSES";
  constructor(apiError: TamgaApiError) {
    super(apiError, `too many processes: ${apiError.detail}`);
    this.name = "TooManyProcessesError";
  }
}

/**
 * `401 LICENSE_SUSPENDED` — the license authenticated, but is suspended, so
 * the credential itself is rejected at the auth gate. Distinct from a
 * `SUSPENDED` {@link import("./models/validation.js").ValidationCode}, which
 * comes back on a *successful* 200 validate call.
 */
export class LicenseSuspendedError extends TamgaApiErrorException {
  static readonly CODE = "LICENSE_SUSPENDED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `license suspended: ${apiError.detail}`);
    this.name = "LicenseSuspendedError";
  }
}

/**
 * `401 LICENSE_EXPIRED` — the license authenticated, but has expired and its
 * policy's `expiration_strategy` is `"REVOKE_ACCESS"`. Under
 * `"MAINTAIN_ACCESS"` / `"ALLOW_ACCESS"` / `"RESTRICT_ACCESS"` an expired
 * license still authenticates and the expiry surfaces as an `EXPIRED`
 * validation code instead — see
 * {@link import("./models/policy.js").ExpirationStrategy}.
 */
export class LicenseExpiredError extends TamgaApiErrorException {
  static readonly CODE = "LICENSE_EXPIRED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `license expired: ${apiError.detail}`);
    this.name = "LicenseExpiredError";
  }
}

/**
 * `401 LICENSE_NOT_ALLOWED` — license-key auth is **switched off** for this
 * license's policy.
 *
 * The server only accepts an `Authorization: License <key>` credential when
 * the policy's `authentication_strategy` is `"LICENSE"` or `"MIXED"`; the
 * column defaults to `"TOKEN"`, and `"NONE"` rejects it too. See {@link
 * import("./models/policy.js").AuthenticationStrategy}.
 *
 * ⚠️ **Not** a retryable auth failure — it is a configuration precondition.
 * Retrying, rotating the key, or re-prompting the user cannot fix it; the
 * policy has to be changed. Do not put this code in a retry loop.
 */
export class LicenseNotAllowedError extends TamgaApiErrorException {
  static readonly CODE = "LICENSE_NOT_ALLOWED";
  constructor(apiError: TamgaApiError) {
    super(apiError, `license not allowed: ${apiError.detail}`);
    this.name = "LicenseNotAllowedError";
  }
}

/**
 * `422 SIGNING_KEY_MISSING` — the account has no Ed25519 signing key, so the
 * server cannot sign what was asked of it. Reachable from `checkOutLicense`,
 * `checkOutMachine` and `generateOfflineProof` (it was a `500` before the API
 * patch). Not retryable: the key has to be provisioned. A post-patch server
 * creates one with every account and backfills existing accounts at startup,
 * so seeing this is a repair signal, not a routine outcome.
 */
export class SigningKeyMissingError extends TamgaApiErrorException {
  static readonly CODE = "SIGNING_KEY_MISSING";
  constructor(apiError: TamgaApiError) {
    super(apiError, `signing key missing: ${apiError.detail}`);
    this.name = "SigningKeyMissingError";
  }
}

/**
 * `422 SECRET_KEY_MISSING` — the account has no secret key, so the server
 * cannot mint a token. Reachable from token minting only. Not retryable.
 */
export class SecretKeyMissingError extends TamgaApiErrorException {
  static readonly CODE = "SECRET_KEY_MISSING";
  constructor(apiError: TamgaApiError) {
    super(apiError, `secret key missing: ${apiError.detail}`);
    this.name = "SecretKeyMissingError";
  }
}

/**
 * Fallback for any server-returned error `code` without a dedicated typed
 * subclass above — still carries the full {@link TamgaApiError}, so callers
 * can match on `.code` manually.
 */
export class ApiError extends TamgaApiErrorException {
  constructor(apiError: TamgaApiError) {
    super(apiError);
    this.name = "ApiError";
  }
}

/**
 * Maps a parsed {@link TamgaApiError} to its most specific {@link TamgaError}
 * subclass, falling back to the generic {@link ApiError} for any `code`
 * without a dedicated variant. Single dispatch point, mirroring
 * `TamgaError::from_json_api_error` in `tamga-rust`.
 */
export function errorFromApiError(apiError: TamgaApiError): TamgaApiErrorException {
  switch (apiError.code) {
    case NotFoundError.CODE:
      return new NotFoundError(apiError);
    case UnauthorizedError.CODE:
      return new UnauthorizedError(apiError);
    case ForbiddenError.CODE:
      return new ForbiddenError(apiError);
    case InternalServerErrorException.CODE:
      return new InternalServerErrorException(apiError);
    case KeyTakenError.CODE:
      return new KeyTakenError(apiError);
    case FingerprintTakenError.CODE:
      return new FingerprintTakenError(apiError);
    case PidTakenError.CODE:
      return new PidTakenError(apiError);
    case CheckInNotRequiredError.CODE:
      return new CheckInNotRequiredError(apiError);
    case TtlInvalidError.CODE:
      return new TtlInvalidError(apiError);
    case LicenseNotEncryptedError.CODE:
      return new LicenseNotEncryptedError(apiError);
    case LicenseKeyMissingError.CODE:
      return new LicenseKeyMissingError(apiError);
    case SchemeNotSupportedError.CODE:
      return new SchemeNotSupportedError(apiError);
    case DatasetInvalidError.CODE:
      return new DatasetInvalidError(apiError);
    case MachineLimitExceededError.CODE:
      return new MachineLimitExceededError(apiError);
    case CoreLimitExceededError.CODE:
      return new CoreLimitExceededError(apiError);
    case MemoryLimitExceededError.CODE:
      return new MemoryLimitExceededError(apiError);
    case DiskLimitExceededError.CODE:
      return new DiskLimitExceededError(apiError);
    case TooManyProcessesError.CODE:
      return new TooManyProcessesError(apiError);
    case LicenseSuspendedError.CODE:
      return new LicenseSuspendedError(apiError);
    case LicenseExpiredError.CODE:
      return new LicenseExpiredError(apiError);
    case LicenseNotAllowedError.CODE:
      return new LicenseNotAllowedError(apiError);
    case SigningKeyMissingError.CODE:
      return new SigningKeyMissingError(apiError);
    case SecretKeyMissingError.CODE:
      return new SecretKeyMissingError(apiError);
    default:
      return new ApiError(apiError);
  }
}

/**
 * Parses a JSON:API `{"errors": [...]}` response body into
 * `TamgaApiError[]`. Throws {@link TamgaParseError} if `body` isn't a valid
 * JSON:API error document shape.
 *
 * `status` is accepted as the JSON:API string (`"422"`) or as a JSON number
 * (`422`, the shape the API patch's new `422`s use). Refusing the number
 * failed the whole document and turned a perfectly good `code` into
 * `UNKNOWN` (D18). `meta` is copied when it is a plain object.
 */
export function parseApiErrors(body: unknown): TamgaApiError[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("errors" in body) ||
    !Array.isArray((body as { errors: unknown }).errors)
  ) {
    throw new TamgaParseError("expected a JSON:API error document with an `errors` array");
  }

  const doc = body as JsonApiErrorDocument;
  return doc.errors.map((raw) => {
    const err = raw as {
      status?: unknown;
      code?: unknown;
      detail?: unknown;
      source?: JsonApiErrorSource;
      meta?: unknown;
    };
    let status: number;
    if (typeof err.status === "string") {
      status = Number.parseInt(err.status, 10);
    } else if (typeof err.status === "number") {
      status = err.status;
    } else {
      throw new TamgaParseError("malformed JSON:API error object");
    }
    if (typeof err.code !== "string" || typeof err.detail !== "string") {
      throw new TamgaParseError("malformed JSON:API error object");
    }
    const pointer = err.source?.pointer;
    const meta = isPlainObject(err.meta) ? err.meta : undefined;
    return {
      status,
      code: err.code,
      detail: err.detail,
      ...(pointer !== undefined ? { pointer } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  });
}

/** `typeof null === "object"` and so is an array; neither is a `meta`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `.lic`/`.mach` offline checkout file failed to parse or verify. See
 * `src/checkout/licenseFile.ts`/`src/checkout/machineFile.ts`'s module doc
 * comments for the full verification flow each stage maps onto.
 *
 * Ground-truthed against `tamga-rust`'s `CheckoutError` enum.
 */
export class CheckoutError extends TamgaError {
  constructor(
    message: string,
    readonly kind:
      | "malformed-pem"
      | "invalid-base64"
      | "invalid-json"
      | "unsupported-algorithm"
      | "license-key-missing"
      | "fingerprint-missing"
      | "scheme-not-supported"
      | "ttl-out-of-range"
      | "expired"
      | "crypto",
    /**
     * For `kind === "crypto"` only — which check failed. Added in 0.4.4 as an
     * optional property so the `kind` union stays closed for exhaustive
     * `switch` consumers.
     *
     * - `"signature"`: no trusted key verified the signature over `enc`. A
     *   forgery or an altered file, or (single-key entry points only) the
     *   wrong public key.
     * - `"decryption"`: the signature verified and AES-GCM then refused the
     *   ciphertext. `enc` is inside the signature that just passed, so this
     *   can only mean the wrong license key (or, for a machine file, the wrong
     *   fingerprint) — not tampering.
     *
     * `undefined` on every other kind, and on the structural `"crypto"`
     * failures that are neither (a malformed encrypted-payload framing, a
     * public key of the wrong length, a payload too short to hold a tag).
     */
    readonly reason?: "signature" | "decryption",
  ) {
    super(message);
    this.name = "CheckoutError";
  }

  static malformedPem(): CheckoutError {
    return new CheckoutError("malformed PEM envelope: missing BEGIN/END markers", "malformed-pem");
  }

  static invalidBase64(): CheckoutError {
    return new CheckoutError("invalid base64 in certificate payload", "invalid-base64");
  }

  static invalidJson(detail: string): CheckoutError {
    return new CheckoutError(`invalid JSON in certificate payload: ${detail}`, "invalid-json");
  }

  static unsupportedAlgorithm(alg: string): CheckoutError {
    return new CheckoutError(`unsupported algorithm: ${alg}`, "unsupported-algorithm");
  }

  /**
   * The file's signature verified, but its signed `exp` claim is in the past —
   * an authentic `.lic`/`.mach` file that has simply run out. Both formats
   * carry the same signed `meta.exp` and both raise this.
   *
   * Its own kind on purpose: a caller that cannot tell "expired" from "forged"
   * either warns the user about tampering when their trial merely ended, or
   * treats a forgery as a renewal prompt.
   */
  static expired(exp: number): CheckoutError {
    return new CheckoutError(`checkout file expired at unix timestamp ${exp}`, "expired");
  }

  static licenseKeyMissing(): CheckoutError {
    return new CheckoutError(
      "license key is required to decrypt an encrypted checkout file",
      "license-key-missing",
    );
  }

  static fingerprintMissing(): CheckoutError {
    return new CheckoutError(
      "machine fingerprint is required to decrypt an encrypted machine file",
      "fingerprint-missing",
    );
  }

  static schemeNotSupported(): CheckoutError {
    return new CheckoutError(
      "scheme not supported for machine file checkout: RSA_2048_JWT_RS256",
      "scheme-not-supported",
    );
  }

  static ttlOutOfRange(detail: string): CheckoutError {
    return new CheckoutError(`ttl out of range: ${detail}`, "ttl-out-of-range");
  }

  static cryptoFailure(detail: string, reason?: "signature" | "decryption"): CheckoutError {
    return new CheckoutError(detail, "crypto", reason);
  }
}

/**
 * Failures selecting a signing key by an offline file's `kid` claim, or
 * building the {@link import("./checkout/keySet.js").SigningKeySet} to select
 * from — see `src/checkout/keySet.ts`'s module doc comment.
 *
 * **Its own class on purpose, and the distinction is the whole point of
 * verifying through a key set.** A file whose `kid` names no key the caller
 * trusts has not been shown to be forged — the far likelier explanation is that
 * the account rotated its signing key after the file was issued and this key set
 * predates the rotation. Reporting that as a {@link CheckoutError} of kind
 * `"crypto"`, which is what verification against a single embedded key does,
 * sends a paying customer with an authentic file down the tampering path and
 * sends support to the wrong place. These are different incidents:
 *
 * - `"unknown-key-id"` → refresh the key set (or ship an application update
 *   carrying the new key) and retry. Do **not** accuse the file.
 * - `"no-published-signing-key"` → the account published no Ed25519 key at all,
 *   so the server signed with the empty string. No client-side action fixes
 *   this; it is an account-configuration problem. See
 *   {@link import("./crypto/keyId.js").UNBACKFILLED_ACCOUNT_KEY_ID}. A
 *   pre-patch server stamped this on every file of an account whose key was
 *   never backfilled; the API patch creates a key with every account and
 *   repairs the public half at startup, so only files issued before it carry
 *   this `kid`.
 * - `"invalid-key"` → a key handed to
 *   {@link import("./checkout/keySet.js").SigningKeySet.fromPublicKeys} is not
 *   standard base64 of exactly 32 bytes. Raised eagerly, at construction, so a
 *   typo in a key pinned in an application binary fails loudly at startup
 *   rather than reporting every genuine file as signed by an unknown key, at
 *   runtime, in the field.
 *
 * A file whose `kid` **is** in the set and whose signature then fails still
 * raises `CheckoutError` of kind `"crypto"`, unchanged. That one is a forgery.
 */
export class SigningKeyError extends TamgaError {
  constructor(
    message: string,
    readonly kind: "unknown-key-id" | "no-published-signing-key" | "invalid-key",
    /**
     * The `kid` involved, when there is one — verbatim, as the file claimed it.
     * Log it next to
     * {@link import("./checkout/keySet.js").SigningKeySet.keyIds} to see what
     * the set did hold.
     */
    readonly keyId?: string,
  ) {
    super(message);
    this.name = "SigningKeyError";
  }

  /**
   * The file names a `kid` the supplied key set does not hold — a stale key
   * set, not a forgery.
   */
  static unknownKeyId(keyId: string): SigningKeyError {
    return new SigningKeyError(
      `no signing key for kid "${keyId}" in the supplied key set — the account may have rotated its signing key since this file was issued; fetch the key set again`,
      "unknown-key-id",
      keyId,
    );
  }

  /**
   * The file's `kid` is `SHA-256("")`, so whatever signed it did so on an
   * account with no published Ed25519 public key.
   */
  static noPublishedSigningKey(keyId: string): SigningKeyError {
    return new SigningKeyError(
      `this file names kid "${keyId}", the id of an empty signing key: the issuing account has no published Ed25519 public key, so no key set can ever verify it`,
      "no-published-signing-key",
      keyId,
    );
  }

  /** A caller-supplied public key is not standard base64 of exactly 32 bytes. */
  static invalidKey(detail: string): SigningKeyError {
    return new SigningKeyError(`invalid Ed25519 public key: ${detail}`, "invalid-key");
  }
}

/**
 * Failures while parsing or verifying a machine offline proof string
 * (`"v1x0.<base64 signature>"`) — see `src/proof.ts`'s module doc comment.
 */
export class ProofError extends TamgaError {
  constructor(
    message: string,
    readonly kind: "malformed-proof" | "invalid-base64" | "verification-failed",
  ) {
    super(message);
    this.name = "ProofError";
  }

  static malformedProof(): ProofError {
    return new ProofError("malformed proof: missing v1x0. prefix", "malformed-proof");
  }

  static invalidBase64(): ProofError {
    return new ProofError("invalid base64 in proof signature", "invalid-base64");
  }

  static verificationFailed(): ProofError {
    return new ProofError("signature verification failed", "verification-failed");
  }
}

/**
 * A set of fingerprint components could not be canonicalised — see
 * `src/fingerprint.ts`.
 *
 * Every one of these is a rejection, never a repair. Canonicalisation exists to
 * make two spellings of one machine agree on one seat; quietly stripping a
 * control character or de-duplicating a repeated label would do the opposite,
 * mapping two genuinely different inputs onto the same seat. So the rule is
 * that anything the algorithm cannot represent exactly is refused, and the
 * caller decides what its own identifiers should have been.
 *
 * A distinct class rather than a reused one because these are caller-input
 * bugs found before any network call — nothing about them is retryable, and
 * nothing about them came from the server.
 */
export class FingerprintError extends TamgaError {
  constructor(
    message: string,
    readonly kind:
      | "no-components"
      | "empty-label"
      | "invalid-label"
      | "duplicate-label"
      | "invalid-value",
    /** The offending label, when there is one — verbatim, as the caller passed it. */
    readonly label?: string,
  ) {
    super(message);
    this.name = "FingerprintError";
  }

  /** No components at all: there is nothing to identify a machine by. */
  static noComponents(): FingerprintError {
    return new FingerprintError(
      "a fingerprint needs at least one component",
      "no-components",
    );
  }

  static emptyLabel(): FingerprintError {
    return new FingerprintError(
      "a fingerprint component label must not be empty",
      "empty-label",
      "",
    );
  }

  /**
   * The label is not ASCII printable, or contains `=`.
   *
   * Both halves matter. `=` would make the `label=value` split ambiguous, and
   * it is legal *inside* a value — so the split has to be at the first `=`, and
   * that is only unambiguous if labels can never contain one. Restricting
   * labels to ASCII is what keeps them out of the Unicode-normalisation problem
   * entirely: a label cannot itself need normalising.
   */
  static invalidLabel(label: string, detail: string): FingerprintError {
    return new FingerprintError(
      `fingerprint component label ${JSON.stringify(label)} is invalid: ${detail}`,
      "invalid-label",
      label,
    );
  }

  /**
   * Two components share a label. Not de-duplicated: two values for one label
   * is a caller bug, and picking one of them hides it behind a fingerprint that
   * silently depends on argument order.
   */
  static duplicateLabel(label: string): FingerprintError {
    return new FingerprintError(
      `fingerprint component label ${JSON.stringify(label)} appears more than once`,
      "duplicate-label",
      label,
    );
  }

  /** The value still holds an ASCII control character after trimming. */
  static invalidValue(label: string, detail: string): FingerprintError {
    return new FingerprintError(
      `fingerprint component ${JSON.stringify(label)} has an invalid value: ${detail}`,
      "invalid-value",
      label,
    );
  }
}

/**
 * Parses a non-2xx response body as a JSON:API error document and maps its
 * first error to the most specific {@link TamgaError} subclass. Falls back
 * to a synthetic {@link ApiError} (status only, no server-provided detail)
 * if the body isn't valid JSON:API error JSON — a non-JSON error page (e.g.
 * from a proxy in front of the API) must not throw an unrelated parse error
 * or silently swallow the failure.
 */
export function apiErrorFromResponseBody(status: number, body: unknown): TamgaApiErrorException {
  try {
    const errors = parseApiErrors(body);
    const first = errors[0];
    if (first) {
      return errorFromApiError(first);
    }
    return new ApiError({
      status,
      code: "UNKNOWN",
      detail: "server returned an empty errors array",
    });
  } catch {
    return new ApiError({
      status,
      code: "UNKNOWN",
      detail: `server returned ${status} with a non-JSON:API body`,
    });
  }
}
