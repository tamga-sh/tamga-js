/**
 * fetch-based HTTP transport layer.
 *
 * Ground-truthed against `tamga-rust`'s `src/transport.rs` + `src/client.rs`
 * (the reference implementation for this SDK family) and `docs/sdk.md` §1.
 *
 * Built on native `fetch` (universal across Node 18+/Deno/Bun/browser) — no
 * axios/node-fetch dependency.
 *
 * Responsibilities implemented here:
 * - 5 auth transports, tried in server priority order: Bearer, Basic
 *   (3 sub-forms: `email:password`, `token:`, `license:<key>`), License
 *   (primary transport for embedded/client SDKs), Cookie
 *   (`Tamga-Session=<uuid>`, browser/portal-only, needs matching `Origin`),
 *   query param (`?token=`).
 * - Treat all tokens as opaque strings — no prefix-based type detection
 *   (`tok-`/`prod-`/`env-`/`activ-`/`lic-` are documented but every issued
 *   token is actually `tok-`-prefixed today).
 * - `Tamga-OTP` header on every authenticated request when configured.
 * - `Tamga-Version` header, default `"1.8"`, sanitized (alphanumeric +
 *   `.`/`-`, max 32 chars), pinned per SDK major version.
 * - Response header reading: `Tamga-Version`, `Tamga-Edition` (`EE`/`CE`),
 *   `Tamga-Mode` (`singleplayer`/`multiplayer`), `X-Request-Id`.
 * - `application/vnd.api+json` handling for standard JSON:API responses,
 *   EXCEPT a special-cased parser for `GET .../actions/validate`
 *   (quick-validate): plain `application/json`, flat body, no `data`
 *   envelope.
 * - `429 TOO_MANY_REQUESTS` retry with backoff — see {@link doFetch},
 *   {@link isRetryable}, {@link parseRetryAfter} and {@link retryDelayMs}.
 *   `Retry-After` is parsed and capped; without it, exponential backoff with
 *   jitter. Retries are scoped to `GET` plus five safe `POST` actions
 *   (`validate`, `validate-key`, `check-in`, `check-out`, `ping`) — creates
 *   are excluded, because repeating `POST /machines` can burn a second seat.
 *
 * Explicitly out of scope:
 * - `Tamga-Environment` request header — planned EE feature, no server code
 *   path reads it yet.
 * - `X-RateLimit-*` response headers — not set by any server handler, so
 *   `Retry-After` on a 429 is the only rate-limit signal available to read.
 * - Any `User-Agent` requirement — no server-side check exists. (Also: this
 *   SDK does not set a custom `User-Agent` header at all — `fetch`
 *   implementations in browsers refuse to let script set it, and Node/
 *   Deno/Bun's behavior is inconsistent enough that a single codepath
 *   setting it isn't worth the cross-runtime branching for a header the
 *   server never reads.)
 */

import { apiErrorFromResponseBody, TamgaNetworkError, TamgaParseError } from "./errors.js";

/** The 3 sub-forms of HTTP Basic auth the server accepts. */
export type BasicAuthForm =
  | { form: "email-password"; email: string; password: string }
  | { form: "token"; token: string }
  | { form: "license-key"; key: string };

/** Union of all 5 auth transports this SDK can attach to a request. */
export type AuthCredentials =
  | { kind: "bearer"; token: string }
  | ({ kind: "basic" } & BasicAuthForm)
  | { kind: "license"; key: string }
  /**
   * `Cookie: Tamga-Session=<uuid>` + matching `Origin` header.
   * Browser/portal-only — not the recommended transport for a non-browser
   * SDK consumer, but modeled for completeness since the server accepts it.
   */
  | { kind: "cookie"; sessionId: string; origin: string }
  | { kind: "query"; token: string };

/** Config accepted by the transport layer. */
export interface TransportConfig {
  /** Full base URL, e.g. `https://api.tamga.sh/v1/accounts/acct_123`. */
  baseUrl: string;
  /** `Tamga-Version` header value. Defaults to {@link DEFAULT_API_VERSION}. */
  apiVersion?: string;
  /** `Tamga-OTP` header value (TOTP 2FA code), sent on every request when set. */
  otp?: string;
  /**
   * Auth transport used to authenticate every request. Optional at the
   * transport layer (an unauthenticated request is simply sent with no
   * `Authorization`/`Cookie`/query-param credential) — but `docs/sdk.md`
   * recommends every caller configure `{ kind: "license" }` for
   * forward-compatibility with auth enforcement landing server-side later.
   */
  auth?: AuthCredentials;
}

/**
 * Default `Tamga-Version` sent when {@link TransportConfig.apiVersion}
 * doesn't override it — matches the server's own default.
 */
export const DEFAULT_API_VERSION = "1.8";

/**
 * Sanitizes a `Tamga-Version` header value per the server's accepted
 * character set: alphanumeric plus `.`/`-`, truncated to 32 chars.
 * Disallowed characters are dropped (not replaced), matching the server's
 * own filter-then-truncate behavior.
 */
export function sanitizeVersion(version: string): string {
  return Array.from(version)
    .filter((c) => /[a-zA-Z0-9.-]/.test(c))
    .slice(0, 32)
    .join("");
}

/**
 * Response headers a caller may want to read off any successful response
 * (or thrown error, in a future extension) for support/debugging purposes.
 */
export interface ResponseInfo {
  /** Echoed `Tamga-Version` the server processed the request with. */
  tamgaVersion?: string;
  /** `"EE"` or `"CE"`. */
  tamgaEdition?: string;
  /** `"singleplayer"` or `"multiplayer"`. */
  tamgaMode?: string;
  /** Useful to log for support — correlates a client-side error with server-side logs. */
  requestId?: string;
}

/**
 * Extracts known response headers from a `Headers` object. Missing headers
 * are simply omitted rather than causing an error — this is diagnostic
 * metadata, not required for correctness.
 */
export function extractResponseInfo(headers: Headers): ResponseInfo {
  const info: ResponseInfo = {};
  const version = headers.get("Tamga-Version");
  const edition = headers.get("Tamga-Edition");
  const mode = headers.get("Tamga-Mode");
  const requestId = headers.get("X-Request-Id");
  if (version !== null) info.tamgaVersion = version;
  if (edition !== null) info.tamgaEdition = edition;
  if (mode !== null) info.tamgaMode = mode;
  if (requestId !== null) info.requestId = requestId;
  return info;
}

/**
 * Returns the `Authorization`/`Cookie`+`Origin` header(s) to attach to a
 * request for `auth`, or `{}` if this transport is query-param-based
 * instead (see {@link authQueryParam}). Tokens/keys are treated as opaque
 * strings throughout — no prefix-based type detection.
 */
export function authHeaders(auth: AuthCredentials): Record<string, string> {
  switch (auth.kind) {
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "basic":
      return { Authorization: `Basic ${basicAuthBase64(auth)}` };
    case "license":
      return { Authorization: `License ${auth.key}` };
    case "cookie":
      return { Cookie: `Tamga-Session=${auth.sessionId}`, Origin: auth.origin };
    case "query":
      return {};
  }
}

/** Renders the `base64(user:pass)` value for one of the 3 Basic auth sub-forms. */
function basicAuthBase64(basic: { kind: "basic" } & BasicAuthForm): string {
  const userPass =
    basic.form === "email-password"
      ? `${basic.email}:${basic.password}`
      : basic.form === "token"
        ? `${basic.token}:`
        : `license:${basic.key}`;
  return typeof btoa === "function"
    ? btoa(userPass)
    : Buffer.from(userPass, "utf-8").toString("base64");
}

/**
 * Returns the `(query param name, value)` pair to attach to a request's URL
 * for `auth`, or `undefined` if this transport is header-based instead (see
 * {@link authHeaders}). The server also accepts `auth` as a synonym for the
 * query param name; this SDK sends `token` since it mirrors the
 * `Bearer <token>` semantics of the transport it substitutes for.
 */
export function authQueryParam(auth: AuthCredentials): [string, string] | undefined {
  return auth.kind === "query" ? ["token", auth.token] : undefined;
}

/** Builds the full request URL, applying the query-param auth transport if configured. */
function buildUrl(
  config: TransportConfig,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): URL {
  const url = new URL(`${config.baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const qp = config.auth ? authQueryParam(config.auth) : undefined;
  if (qp) url.searchParams.set(qp[0], qp[1]);
  return url;
}

/** Builds the common request headers shared by every endpoint call. */
function buildHeaders(config: TransportConfig, contentType?: string): Headers {
  const headers = new Headers();
  if (config.auth) {
    for (const [name, value] of Object.entries(authHeaders(config.auth))) {
      headers.set(name, value);
    }
  }
  headers.set("Tamga-Version", sanitizeVersion(config.apiVersion ?? DEFAULT_API_VERSION));
  if (config.otp !== undefined) headers.set("Tamga-OTP", config.otp);
  if (contentType !== undefined) headers.set("Content-Type", contentType);
  return headers;
}

/**
 * Builds a `RequestInit`, only setting `body` when a JSON body is actually
 * present — required under `exactOptionalPropertyTypes`, since `RequestInit`
 * declares `body?: BodyInit | null` and does not accept an explicit
 * `undefined` assignment to that property.
 */
function buildInit(method: string, headers: Headers, jsonBody?: unknown): RequestInit {
  const init: RequestInit = { method, headers };
  if (jsonBody !== undefined) {
    init.body = JSON.stringify(jsonBody);
  }
  return init;
}

/**
 * How many times a rate-limited (429) request is retried before giving up.
 *
 * Three rides out a short burst without turning a sustained 429 into a request
 * that hangs for minutes.
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * How much of a `Retry-After` to honour, in seconds.
 *
 * A misconfigured — or hostile — proxy must not be able to park the caller for
 * an hour on a single header.
 */
const MAX_RETRY_AFTER_SECONDS = 60;

/** POST paths safe to repeat after a 429. */
const RETRYABLE_POST_SUFFIXES = [
  "/actions/validate",
  "/actions/validate-key",
  "/actions/check-in",
  "/actions/check-out",
  "/actions/ping",
];

/**
 * Is this request safe to repeat after a 429?
 *
 * `GET` always is. Among the `POST`s only the licensing *actions* are — they
 * are effectively idempotent (validate, check in/out, ping a heartbeat) and
 * they are precisely the calls a client makes on a timer, so they are the ones
 * that hit the rate limit in the first place.
 *
 * Creates are deliberately excluded: retrying `POST /machines` risks a second
 * activation burning a second seat, and only the caller knows whether that is
 * acceptable.
 */
export function isRetryable(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (upper === "GET") return true;
  if (upper !== "POST") return false;
  return RETRYABLE_POST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Reads `Retry-After` as delta-seconds.
 *
 * The HTTP-date form is ignored deliberately: the server sends seconds, and
 * misreading a date as a duration would be far worse than falling back to the
 * client's own backoff.
 */
export function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return undefined;
  const secs = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
}

/**
 * How long to wait before retry number `attempt` (0-based), in milliseconds.
 *
 * Prefers the server's `Retry-After` — it knows when the bucket refills, and
 * guessing wastes the budget — but caps it. Otherwise exponential backoff with
 * jitter, because a fleet that all retries on the same schedule reconverges
 * into the spike it was backing off from.
 */
export function retryDelayMs(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000;
  }
  return 2 ** Math.min(attempt, 5) * 1000 + Math.floor(Math.random() * 1000);
}

/**
 * Performs the actual `fetch` call, wrapping network failures in
 * {@link TamgaNetworkError}, and transparently retrying while the server
 * answers 429.
 *
 * Credential-accepting endpoints run on a tight per-IP budget (5 req/s by
 * default), and the calls a licensing client makes on a timer are exactly the
 * ones inside it. Without backoff, one throttled request becomes a sustained
 * burst that keeps the bucket empty and the client never recovers on its own.
 */
async function doFetch(url: URL, init: RequestInit, maxRetries = DEFAULT_MAX_RETRIES): Promise<Response> {
  const retryable = isRetryable(init.method ?? "GET", url.pathname);

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new TamgaNetworkError(
        `network request to ${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    if (response.status !== 429 || !retryable || attempt >= maxRetries) {
      return response;
    }

    const delay = retryDelayMs(attempt, parseRetryAfter(response));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Parses a response body as JSON, wrapping malformed JSON in {@link TamgaParseError}. */
async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TamgaParseError(`response body was not valid JSON: ${text.slice(0, 200)}`);
  }
}

/** Options shared by every JSON:API-enveloped request helper below. */
export interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/** A successful response, decoded, plus the response headers a caller may want to inspect. */
export interface TransportResult<T> {
  data: T;
  responseInfo: ResponseInfo;
}

/** Same as {@link TransportResult} but also carries a parsed `meta` field. */
export interface TransportResultWithMeta<T, M> {
  data: T;
  meta: M;
  responseInfo: ResponseInfo;
}

/**
 * Sends a JSON:API request (`Content-Type: application/vnd.api+json`,
 * optional JSON body) and decodes a `{ data: T }` envelope on success, or
 * throws a typed error (see `src/errors.ts`) on a non-2xx status.
 */
export async function sendJsonApi<T>(
  config: TransportConfig,
  opts: RequestOptions,
): Promise<TransportResult<T>> {
  const url = buildUrl(config, opts.path, opts.query);
  const headers = buildHeaders(config, "application/vnd.api+json");
  const response = await doFetch(url, buildInit(opts.method, headers, opts.body));
  const responseInfo = extractResponseInfo(response.headers);
  const body = await parseJson(response);
  if (!response.ok) {
    throw apiErrorFromResponseBody(response.status, body);
  }
  const envelope = body as { data: T };
  return { data: envelope.data, responseInfo };
}

/**
 * Like {@link sendJsonApi} but also decodes the `meta` field alongside
 * `data` — used by the validate endpoints, whose {@link
 * import("./models/validation.js").LicenseValidationResult} lives in
 * `meta`, not `data`.
 */
export async function sendJsonApiWithMeta<T, M>(
  config: TransportConfig,
  opts: RequestOptions,
): Promise<TransportResultWithMeta<T, M>> {
  const url = buildUrl(config, opts.path, opts.query);
  const headers = buildHeaders(config, "application/vnd.api+json");
  const response = await doFetch(url, buildInit(opts.method, headers, opts.body));
  const responseInfo = extractResponseInfo(response.headers);
  const body = await parseJson(response);
  if (!response.ok) {
    throw apiErrorFromResponseBody(response.status, body);
  }
  const envelope = body as { data: T; meta: M };
  return { data: envelope.data, meta: envelope.meta, responseInfo };
}

/**
 * Sends a request expecting a flat (non-enveloped) JSON body — used only by
 * quick-validate today, which returns plain `application/json` with no
 * `data` key.
 */
export async function sendFlat<T>(
  config: TransportConfig,
  opts: RequestOptions,
): Promise<TransportResult<T>> {
  const url = buildUrl(config, opts.path, opts.query);
  const headers = buildHeaders(config);
  const response = await doFetch(url, { method: opts.method, headers });
  const responseInfo = extractResponseInfo(response.headers);
  const body = await parseJson(response);
  if (!response.ok) {
    throw apiErrorFromResponseBody(response.status, body);
  }
  return { data: body as T, responseInfo };
}

/**
 * Sends a request without a JSON:API `Content-Type` and returns the raw
 * response text — used for `.lic`/`.mach` `GET .../actions/check-out`,
 * which return a raw `application/octet-stream` PEM body.
 */
export async function sendRaw(
  config: TransportConfig,
  opts: RequestOptions,
): Promise<TransportResult<string>> {
  const url = buildUrl(config, opts.path, opts.query);
  const headers = buildHeaders(config);
  const response = await doFetch(url, { method: opts.method, headers });
  const responseInfo = extractResponseInfo(response.headers);
  if (!response.ok) {
    const body = await parseJson(response).catch(() => undefined);
    throw apiErrorFromResponseBody(response.status, body);
  }
  return { data: await response.text(), responseInfo };
}
