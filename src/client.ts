/**
 * `TamgaClient` — the SDK's primary entrypoint.
 *
 * STUB — no endpoint methods are implemented yet. See
 * `docs/plans/tamga-js.plan.md` Sections B–J for the full method surface:
 * license validate (by key / by id / quick-validate), check-in, checkout
 * (license + machine), machine/component/process management + heartbeats,
 * entitlements, and the composed helpers (`startHeartbeat`,
 * `startProcessHeartbeat`, `hasEntitlement`).
 *
 * Base path: `https://<host>/v1/accounts/{account_id}/...` — `accountId` is
 * required in both singleplayer and multiplayer server modes (docs/sdk.md
 * §1); there is no mode where it can be omitted.
 *
 * TSDoc note carried into the eventual real implementation: no auth is
 * currently enforced server-side on the license validate/check-in
 * endpoints, but this client should always send `Authorization: License
 * <key>` anyway for forward-compatibility (docs/sdk.md §2).
 */

/** Configuration accepted by `TamgaClient`. TODO: finalize field set. */
export interface TamgaClientConfig {
  /** Required in both singleplayer and multiplayer server modes. */
  accountId: string;
  /** API host, e.g. `https://api.tamga.sh`. */
  baseUrl: string;
  /** `Tamga-Version` header value. Server default is `"1.8"` if omitted. */
  apiVersion?: string;
}

/**
 * TODO: implement the full client surface described in the module doc
 * above. The constructor currently performs no validation and no method
 * makes a network call — see `docs/plans/tamga-js.plan.md` Section B.
 */
export class TamgaClient {
  readonly config: TamgaClientConfig;

  constructor(config: TamgaClientConfig) {
    // TODO (Section B): validate `accountId`/`baseUrl` presence and build
    // the `/v1/accounts/{account_id}/...` base path.
    this.config = config;
  }
}
