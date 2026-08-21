/**
 * fetch-based HTTP transport layer.
 *
 * Ground-truthed against `tamga-rust`'s `src/transport.rs` + `src/client.rs`
 * (the reference implementation for this SDK family) and the Tamga API
 * protocol specification §1.
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
 *   jitter. Retries are scoped to `GET` plus seven safe `POST` actions
 *   (`validate`, `validate-key`, `check-in`, `check-out`, `ping`,
 *   `ping-heartbeat`, `reset-heartbeat`) — creates are excluded, because
 *   repeating `POST /machines` can burn a second seat.
 * - A per-attempt request deadline ({@link DEFAULT_TIMEOUT_MS}, overridable
 *   via {@link TransportConfig.timeoutMs}) covering the **whole** attempt,
 *   body read included, not just the wait for response headers — see
 *   {@link doFetch}.
 *
 * Auth **is** enforced server-side on the endpoints this SDK calls. A
 * license-key credential is additionally gated on the license's policy:
 * `authentication_strategy` has to be `"LICENSE"` or `"MIXED"`, and it
 * defaults to `"TOKEN"`, under which the key is rejected with
 * `401 LICENSE_NOT_ALLOWED`.
 *
 * Explicitly out of scope:
 * - `Tamga-Environment` request header — planned EE feature, no server code
 *   path reads it yet.
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
   *
   * ⚠️ Two caveats, both structural:
   * - Browsers refuse to let script set `Cookie` or `Origin`, so this
   *   transport only actually authenticates outside a browser (Node/Deno/Bun),
   *   where nothing supplies the session cookie automatically either.
   * - Sending `Origin` suppresses quick-validate's `last_validated_at` write
   *   server-side — see
   *   {@link import("./client.js").TamgaClient.quickValidate}.
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
   * `Authorization`/`Cookie`/query-param credential) — but the Tamga API
   * protocol specification recommends every caller configure
   * `{ kind: "license" }` for forward-compatibility with auth enforcement
   * landing server-side later.
   */
  auth?: AuthCredentials;
  /**
   * Per-attempt request deadline in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}. `0` (or any non-positive value) disables the
   * deadline entirely, restoring the pre-0.3.4 "wait forever" behaviour.
   *
   * Covers the **entire** attempt: connect, response headers, and the body
   * read. `fetch` resolves on headers alone, so a deadline that stopped there
   * would leave a stalled body unbounded — see {@link doFetch}.
   */
  timeoutMs?: number;
}

/**
 * Default `Tamga-Version` sent when {@link TransportConfig.apiVersion}
 * doesn't override it — matches the server's own default.
 */
export const DEFAULT_API_VERSION = "1.8";

/**
 * Default per-attempt request deadline, in milliseconds.
 *
 * Deliberately longer than the API's own 30s `TimeoutLayer`: a request that
 * races the server's deadline usually surfaces as an opaque local abort
 * instead of the server's `504`, and the `504` is the response that carries
 * the `X-Request-Id` support needs to correlate a slow request. Sitting
 * 15s past it means the server wins that race and the caller gets the
 * diagnosable failure.
 *
 * Applied per attempt, not per call: a 429 retry gets its own full budget.
 * Within an attempt it covers the body read too, not just the headers.
 */
export const DEFAULT_TIMEOUT_MS = 45_000;

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
  /**
   * The `x-ratelimit-*` budget, when the server sent it. See
   * {@link RateLimitInfo} — and note that an absent field is not a zero.
   */
  rateLimit?: RateLimitInfo;
}

/**
 * The rate-limit budget the server reports alongside a response.
 *
 * The middleware writes all four headers onto whatever response it is about
 * to return, throttled or not, so a successful call carries them too — which
 * is the point. `remaining` read off a healthy response is what lets a caller
 * slow down *before* it is throttled; by the time a 429 arrives the only
 * useful field left is `reset`.
 *
 * Two things to get right, both of which have bitten SDKs in this fleet:
 *
 * **`reset` is an absolute Unix timestamp, not a delay.** The server derives
 * `Retry-After` from it by subtracting the current time, which is the proof.
 * Sleeping for `reset` itself parks a caller for decades.
 *
 * **An absent field is not zero.** Every field is optional because the
 * middleware writes nothing at all when no limiter is configured, skips
 * `OPTIONS` preflight, and — installed with `route_layer` — never runs on an
 * unmatched path. A client that reads a missing `remaining` as `0` throttles
 * itself against a server that is not limiting it.
 */
export interface RateLimitInfo {
  /** Requests allowed per window. */
  limit?: number;
  /** Requests left in the current window. `0` genuinely means none left. */
  remaining?: number;
  /** When the window refills, as **absolute** Unix seconds. */
  reset?: number;
  /** Window length in seconds. */
  window?: number;
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
  const rateLimit = extractRateLimitInfo(headers);
  if (rateLimit !== undefined) info.rateLimit = rateLimit;
  return info;
}

/**
 * Reads the four `x-ratelimit-*` headers, or `undefined` when the server sent
 * none of them.
 *
 * A header that is present but not a finite number is dropped rather than
 * surfaced as `NaN`: every consumer of these values does arithmetic on them,
 * and `NaN` propagates silently through a comparison instead of failing.
 */
function extractRateLimitInfo(headers: Headers): RateLimitInfo | undefined {
  const read = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : undefined;
  };
  const limit = read("x-ratelimit-limit");
  const remaining = read("x-ratelimit-remaining");
  const reset = read("x-ratelimit-reset");
  const window = read("x-ratelimit-window");
  if (
    limit === undefined &&
    remaining === undefined &&
    reset === undefined &&
    window === undefined
  ) {
    return undefined;
  }
  const info: RateLimitInfo = {};
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (reset !== undefined) info.reset = reset;
  if (window !== undefined) info.window = window;
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
  "/actions/ping-heartbeat",
  "/actions/reset-heartbeat",
];

/**
 * Is this request safe to repeat after a 429?
 *
 * `GET` always is. Among the `POST`s only the licensing *actions* are — they
 * are effectively idempotent (validate, check in/out, ping a heartbeat) and
 * they are precisely the calls a client makes on a timer, so they are the ones
 * that hit the rate limit in the first place.
 *
 * ⚠️ `/actions/ping-heartbeat` and `/actions/reset-heartbeat` do **not** end
 * in `/actions/ping` (that suffix is the *process* ping route) and so need
 * their own entries. Both are bare timestamp writes with no counter attached,
 * so repeating them is unconditionally safe — and dropping a throttled
 * heartbeat is how a live machine flips to `DEAD` (and, under a policy with
 * `require_heartbeat = true`, eventually gets culled).
 *
 * The rate limiter buckets per `(caller, route pattern)`, and with proxy
 * headers untrusted every caller collapses into one bucket per route — so a
 * fleet on the same heartbeat schedule throttles *itself*. That makes the
 * heartbeat routes the likeliest 429 in normal operation, not the rarest.
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
 * Performs the actual `fetch` call **and reads the response body**, wrapping
 * network failures in {@link TamgaNetworkError} and transparently retrying
 * while the server answers 429.
 *
 * ⚠️ The body read belongs here, not in the callers, because `fetch` resolves
 * as soon as the response *headers* arrive — the body may still be streaming.
 * Disarming the deadline at that point would leave the body read unbounded,
 * so a stalling proxy (or a peer holding the connection open) could hang a
 * call forever behind a `timeoutMs` that had already been cleared. Reading
 * here keeps one `AbortController` armed across the whole attempt, which is
 * what {@link TransportConfig.timeoutMs} promises. The `finally` still clears
 * on every exit path, so no timer outlives its attempt.
 *
 * Returning the text alongside the response also makes the single-read rule
 * structural: a `Response` body can only be consumed once, and now exactly
 * one place consumes it.
 *
 * Credential-accepting endpoints run on a tight per-IP budget (5 req/s by
 * default), and the calls a licensing client makes on a timer are exactly the
 * ones inside it. Without backoff, one throttled request becomes a sustained
 * burst that keeps the bucket empty and the client never recovers on its own.
 */
async function doFetch(
  url: URL,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<{ response: Response; text: string }> {
  const retryable = isRetryable(init.method ?? "GET", url.pathname);

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let text: string;
    const deadline = startDeadline(timeoutMs);
    try {
      response = await fetch(url, deadline.signal ? { ...init, signal: deadline.signal } : init);
      // Still inside the deadline: `fetch` above resolved on headers alone.
      text = await response.text();
    } catch (error) {
      throw new TamgaNetworkError(
        deadline.expired
          ? `network request to ${url.toString()} timed out after ${timeoutMs}ms`
          : `network request to ${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      deadline.clear();
    }

    if (response.status !== 429 || !retryable || attempt >= maxRetries) {
      return { response, text };
    }

    const delay = retryDelayMs(attempt, parseRetryAfter(response));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Arms a per-attempt abort deadline.
 *
 * `AbortSignal.timeout` is not universally available across this SDK's four
 * target runtimes, so fall back to an `AbortController` plus a timer. The
 * `expired` flag is what lets {@link doFetch} tell "we gave up" from "the
 * network died": both arrive as the same rejected `fetch`.
 *
 * A non-positive `timeoutMs` returns a no-op deadline — an explicit opt-out.
 */
function startDeadline(timeoutMs: number): {
  signal: AbortSignal | undefined;
  expired: boolean;
  clear: () => void;
} {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: undefined, expired: false, clear: () => undefined };
  }
  const controller = new AbortController();
  const state = { signal: controller.signal, expired: false, clear: () => undefined as void };
  const timer = setTimeout(() => {
    state.expired = true;
    controller.abort();
  }, timeoutMs);
  state.clear = () => clearTimeout(timer);
  return state;
}

/**
 * Parses an already-read response body as JSON, wrapping malformed JSON in
 * {@link TamgaParseError}.
 *
 * Takes text rather than a `Response` so the read itself stays inside
 * {@link doFetch}'s deadline — and so a parse failure surfaces as
 * `TamgaParseError` rather than being swallowed into the network-error
 * wrapper.
 */
function parseJsonText(text: string): unknown {
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
  const { response, text } = await doFetch(
    url,
    buildInit(opts.method, headers, opts.body),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const responseInfo = extractResponseInfo(response.headers);
  const body = parseJsonText(text);
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
  const { response, text } = await doFetch(
    url,
    buildInit(opts.method, headers, opts.body),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const responseInfo = extractResponseInfo(response.headers);
  const body = parseJsonText(text);
  if (!response.ok) {
    throw apiErrorFromResponseBody(response.status, body);
  }
  const envelope = body as { data: T; meta: M };
  return { data: envelope.data, meta: envelope.meta, responseInfo };
}

/**
 * Like {@link sendJsonApi}, but tolerates a `204 No Content` answer and
 * reports it as `undefined` rather than crashing on a missing envelope.
 *
 * Only one route this SDK calls behaves this way: `GET
 * /releases/actions/upgrade`, which returns `204` both when the caller is
 * already current and when a newer release exists that this license may not
 * have. {@link sendJsonApi} would read `.data` off an `undefined` body and
 * throw a `TypeError` from inside the transport, which is not a failure mode
 * any caller can act on.
 *
 * `204` is the only status that produces `undefined` here; a `200` whose body
 * is missing `data` still yields `undefined` for the same structural reason,
 * and every non-2xx is thrown as a typed error exactly as elsewhere.
 *
 * ⚠️ The error path decodes **defensively**, like {@link sendRaw} and unlike
 * {@link sendJsonApi}. The upgrade route reads its query string with a bare
 * Axum `Query` extractor, whose rejection is `400` with a **plain-text** body —
 * not the JSON:API error document every handler-produced error uses. Parsing
 * that strictly would raise a `TamgaParseError` about the body instead of the
 * `400` about the request, hiding which of the four required query parameters
 * was wrong behind a message about JSON.
 */
export async function sendJsonApiOptional<T>(
  config: TransportConfig,
  opts: RequestOptions,
): Promise<TransportResult<T | undefined>> {
  const url = buildUrl(config, opts.path, opts.query);
  const headers = buildHeaders(
    config,
    opts.body !== undefined ? "application/vnd.api+json" : undefined,
  );
  const { response, text } = await doFetch(
    url,
    buildInit(opts.method, headers, opts.body),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const responseInfo = extractResponseInfo(response.headers);
  if (!response.ok) {
    let body: unknown;
    try {
      body = parseJsonText(text);
    } catch {
      body = undefined;
    }
    throw apiErrorFromResponseBody(response.status, body);
  }
  const envelope = parseJsonText(text) as { data?: T } | undefined;
  return { data: envelope?.data, responseInfo };
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
  const { response, text } = await doFetch(
    url,
    { method: opts.method, headers },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const responseInfo = extractResponseInfo(response.headers);
  const body = parseJsonText(text);
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
  const { response, text } = await doFetch(
    url,
    { method: opts.method, headers },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const responseInfo = extractResponseInfo(response.headers);
  if (!response.ok) {
    // A raw route's error body is still JSON:API, but a non-JSON one must not
    // mask the HTTP error — decode it if it parses, ignore it if it doesn't.
    let body: unknown;
    try {
      body = parseJsonText(text);
    } catch {
      body = undefined;
    }
    throw apiErrorFromResponseBody(response.status, body);
  }
  return { data: text, responseInfo };
}
