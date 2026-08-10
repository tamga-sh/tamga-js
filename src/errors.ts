/**
 * Error model for @tamga/sdk.
 *
 * STUB — scaffolding only. No parsing/matching logic is implemented yet.
 * See `docs/plans/tamga-js.plan.md` Section K for the full task list:
 *
 * - `TamgaApiError` shape: `{ status, code, detail, pointer? }`, mirroring
 *   the server's JSON:API error object (`id`, `status`, `code`, `title`,
 *   `detail`, `source.pointer`).
 * - A parser from the `{"errors": [...]}` envelope
 *   (`Content-Type: application/vnd.api+json`) into `TamgaApiError[]`.
 * - Matcher helpers that key on `code` (stable), never on `detail` (human
 *   text, may change) — see docs/sdk.md §11.
 * - Typed subclasses/discriminants for the fixed-status codes (`NOT_FOUND`,
 *   `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_SERVER_ERROR`) and the
 *   per-endpoint codes (`KEY_TAKEN`, `FINGERPRINT_TAKEN`, `PID_TAKEN`,
 *   `CHECK_IN_NOT_REQUIRED`, `TTL_INVALID`, `LICENSE_NOT_ENCRYPTED`,
 *   `LICENSE_KEY_MISSING`, `SCHEME_NOT_SUPPORTED`, `DATASET_INVALID`).
 *
 * ⚠️ Do NOT build client-side `429 TOO_MANY_REQUESTS` retry/backoff handling.
 * The code is declared in the server's error enum but has no constructor and
 * is never returned by any code path today (docs/sdk.md §11, Known
 * Server-Side Gaps #5). Building backoff logic around it would be dead code
 * that gives a false sense of resilience.
 */

/** A single JSON:API error object as returned by the Tamga API. */
export interface TamgaApiError {
  status: number;
  code: string;
  detail: string;
  pointer?: string;
}

/**
 * Base error class for all errors raised by this SDK. Concrete subclasses
 * (one per fixed-status/per-endpoint code above) are TODO.
 */
export class TamgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TamgaError";
  }
}

/**
 * TODO: parse a JSON:API `{"errors": [...]}` response body into
 * `TamgaApiError[]`. Currently unimplemented.
 */
export function parseApiErrors(_body: unknown): TamgaApiError[] {
  throw new Error("parseApiErrors: not implemented — see docs/plans/tamga-js.plan.md Section K");
}
