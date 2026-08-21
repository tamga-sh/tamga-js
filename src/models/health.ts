/**
 * The `GET /v1/health` response.
 *
 * ⚠️ **Not a JSON:API document.** Every other endpoint this SDK calls answers
 * with `{ data: … }` under `application/vnd.api+json`; this one answers with a
 * flat `application/json` object built by a bare handler
 * (`tamga-api/src/features/health/handler.rs`). Running it through the
 * envelope decoder yields `undefined`, so it has its own path.
 *
 * It is also the only route in this SDK that is **not** account-scoped: it sits
 * at `/v1/health`, outside `/v1/accounts/{account_id}`.
 */
export interface HealthStatus {
  /** Literal `"ok"` today — the handler has no other branch. */
  status: string;
  /** The server's own package version (`CARGO_PKG_VERSION`), not the API version. */
  version: string;
  /**
   * Seconds since the server process started. Snake_case, matching the wire
   * field — the handler does not rename it.
   *
   * A value that keeps resetting between polls is a restart loop, which is
   * worth knowing when a deployment answers healthily but behaves as if it has
   * no warm state.
   */
  uptime_secs: number;
}
