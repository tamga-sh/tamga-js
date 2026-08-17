/**
 * Error model for @tamga/sdk.
 *
 * Ground-truthed against `tamga-rust`'s `src/error.rs` (the reference
 * implementation for this SDK family) and `docs/sdk.md` §11.
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
 *   may change) — see docs/sdk.md §11.
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
  status: string;
  code: string;
  title: string;
  detail: string;
  source?: JsonApiErrorSource;
}

/** Top-level JSON:API error document: `{ "errors": [ ... ] }`. */
export interface JsonApiErrorDocument {
  errors: JsonApiErrorObject[];
}

/**
 * A single JSON:API error object as returned by the Tamga API, flattened
 * for SDK consumption. `status` is coerced to a `number`; `pointer` (if
 * present) is lifted out of the nested `source` object.
 */
export interface TamgaApiError {
  status: number;
  code: string;
  detail: string;
  pointer?: string;
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
 * `401 UNAUTHORIZED` — missing or invalid credentials. Not currently
 * reachable on the license/machine endpoints this SDK calls (auth isn't
 * enforced there today — see `docs/sdk.md` Known Server-Side Gaps #3), but
 * modeled for forward-compatibility.
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
    default:
      return new ApiError(apiError);
  }
}

/**
 * Parses a JSON:API `{"errors": [...]}` response body into
 * `TamgaApiError[]`. Throws {@link TamgaParseError} if `body` isn't a valid
 * JSON:API error document shape (not JSON:API errors themselves — those are
 * represented in the returned array).
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
  return doc.errors.map((err) => {
    if (
      typeof err.status !== "string" ||
      typeof err.code !== "string" ||
      typeof err.detail !== "string"
    ) {
      throw new TamgaParseError("malformed JSON:API error object");
    }
    const pointer = err.source?.pointer;
    return {
      status: Number.parseInt(err.status, 10),
      code: err.code,
      detail: err.detail,
      ...(pointer !== undefined ? { pointer } : {}),
    };
  });
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
   * an authentic license file that has simply run out.
   *
   * Its own kind on purpose: a caller that cannot tell "expired" from "forged"
   * either warns the user about tampering when their trial merely ended, or
   * treats a forgery as a renewal prompt.
   */
  static expired(exp: number): CheckoutError {
    return new CheckoutError(`license file expired at unix timestamp ${exp}`, "expired");
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

  static cryptoFailure(detail: string): CheckoutError {
    return new CheckoutError(detail, "crypto");
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
