/**
 * Node example: an auto-updater's "is there a newer build?" poll, and the
 * health probe worth reaching for when everything else is failing.
 *
 * ⚠️ **`undefined` from `checkForUpgrade` does not mean "you are up to date".**
 * `GET /releases/actions/upgrade` answers `204 No Content` in two different
 * situations and will not distinguish them:
 *
 *   1. no release newer than `version` exists; and
 *   2. a newer release *does* exist, but this license is not entitled to it —
 *      an expired license under a policy that stops delivering new builds at
 *      expiry.
 *
 * The collapse is deliberate. A distinct refusal would leak "there is a newer
 * version and you cannot have it", which is exactly what the expiry gate exists
 * to withhold, and `204` is the truthful answer to "what can I upgrade to?" in
 * both cases: nothing. So word it to users as *no update is available to you* —
 * never as *you are on the latest version*, which is a claim this endpoint
 * cannot support and which is wrong precisely for the customers whose licence
 * lapsed. A **suspended** licence is the one case not collapsed: it throws
 * `ForbiddenError`.
 *
 * Two parameters deserve care:
 *
 * - `constraint` unset is **not** "no constraint". The server substitutes a
 *   pessimistic `~{major}.{minor}.{patch}` from the version you sent, so an
 *   updater on 1.2.0 that omits it will never be offered 1.3.0 and will look
 *   exactly like a current client. Pass `"^1.2.0"` for minor upgrades.
 * - `channel` is optional server-side but required by this SDK, because
 *   omitting it drops the channel predicate entirely and lets alpha and dev
 *   builds answer a production updater.
 */
import { TamgaClient, ForbiddenError } from "@tamga/sdk";

const CURRENT_VERSION = "1.2.0";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  // Auth is optional on this route — an `Open` product answers an
  // unauthenticated request so that updaters already in the field keep
  // working. A `Licensed` product needs a credential carrying `release.read`.
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

try {
  const release = await client.checkForUpgrade({
    productId: process.env.TAMGA_PRODUCT_ID ?? "00000000-0000-0000-0000-000000000000",
    platform: process.platform,
    filetype: "dmg",
    version: CURRENT_VERSION,
    channel: "stable",
    // Without this, only patch upgrades within 1.2.x are ever offered.
    constraint: `^${CURRENT_VERSION}`,
  });

  if (release === undefined) {
    console.log("No update is available to you.");
  } else {
    // Note the camelCase: `releases` is the one resource in this API whose
    // attributes are not snake_case.
    console.log(`Update available: ${release.attributes.version} (${release.attributes.channel})`);
    console.log(`Product: ${release.attributes.productId}`);
  }
} catch (error) {
  if (error instanceof ForbiddenError) {
    console.error("This license is suspended and cannot receive updates.");
  } else {
    throw error;
  }
}

// ── The diagnostic ──────────────────────────────────────────────────────────
//
// `/v1/health` is the one route that is neither account-scoped nor subject to
// the server's Host-header check. If every other call is coming back
// `403 "The Host header does not match any configured host"` and this one
// succeeds, the fault is the deployment's TAMGA_ALLOWED_HOSTS configuration —
// not the credential, not the account id, and not anything a different key
// would fix.
const health = await client.health();
console.log(`Server ${health.status}, version ${health.version}, up ${health.uptime_secs}s`);
