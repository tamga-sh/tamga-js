/**
 * fetch-based HTTP transport layer.
 *
 * STUB — no implementation yet. See `docs/plans/tamga-js.plan.md`
 * Section B.
 *
 * Built on native `fetch` (universal across Node 18+/Deno/Bun/browser) —
 * no axios/node-fetch dependency.
 *
 * Responsibilities to implement here (docs/sdk.md §1):
 * - 5 auth transports, tried in server priority order: Bearer, Basic
 *   (3 sub-forms: `email:password`, `token:`, `license:<key>`), License
 *   (primary transport for embedded/client SDKs), Cookie
 *   (`Tamga-Session=<uuid>`, browser/portal-only, needs matching `Origin`),
 *   query param (`?token=`/`?auth=`).
 * - Treat all tokens as opaque strings — do NOT build prefix-based type
 *   detection (`tok-`/`prod-`/`env-`/`activ-`/`lic-` are documented but
 *   every issued token is actually `tok-`-prefixed today).
 * - `Tamga-OTP` header on every authenticated request when configured.
 * - `Tamga-Version` header, default `"1.8"`, sanitized (alphanumeric +
 *   `.`/`-`, max 32 chars), pinned per SDK major version.
 * - Response header reading: `Tamga-Version`, `Tamga-Edition` (`EE`/`CE`),
 *   `Tamga-Mode` (`singleplayer`/`multiplayer`), `X-Request-Id`.
 * - `application/vnd.api+json` handling for standard JSON:API responses,
 *   EXCEPT a special-cased parser for `GET .../actions/validate`
 *   (quick-validate): plain `application/json`, flat body, no `data`
 *   envelope.
 *
 * Explicitly out of scope (see docs/sdk.md → Known Server-Side Gaps):
 * - `Tamga-Environment` request header — planned EE feature, no server code
 *   path reads it yet.
 * - `X-RateLimit-*` response header handling or 429 retry/backoff — declared
 *   in the CORS allowlist only, never set by any handler.
 * - Any `User-Agent` requirement — no server-side check exists.
 */

/** Union of all 5 auth transports this SDK can attach to a request. TODO. */
export type AuthCredentials =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "license"; key: string }
  | { kind: "cookie"; sessionId: string; origin: string }
  | { kind: "query"; token: string };

/** Config accepted by the transport layer. TODO: flesh out fully. */
export interface TransportConfig {
  baseUrl: string;
  apiVersion?: string;
  otp?: string;
  auth?: AuthCredentials;
}

/** TODO: perform an authenticated request against the Tamga API. */
export async function request<T>(_config: TransportConfig, _path: string): Promise<T> {
  throw new Error("request: not implemented — see docs/plans/tamga-js.plan.md Section B");
}
