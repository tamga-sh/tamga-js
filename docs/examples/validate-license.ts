/**
 * Node example: validate a license by its raw key, end to end.
 *
 * Run with: `npx tsx docs/examples/validate-license.ts` (or `node
 * --experimental-strip-types` on Node 22.6+), after setting
 * TAMGA_ACCOUNT_ID / TAMGA_BASE_URL / TAMGA_LICENSE_KEY in your shell.
 *
 * `validateByKey` calls `POST /licenses/actions/validate-key` — the
 * simplest of the 3 validation endpoints, with no scope support. Use
 * `validateById` (see `scoped-validate.ts`) when you need to constrain
 * the check to a specific product/policy/user/environment.
 */
import { TamgaClient } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const { license, meta } = await client.validateByKey(
  process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY",
);

if (meta.valid) {
  console.log(`License ${license.id} is valid (code: ${meta.code}).`);
} else {
  // meta.code is the stable, machine-matchable outcome — e.g. "EXPIRED",
  // "SUSPENDED", "TOO_MANY_MACHINES". Match on this, never on meta.detail
  // (human-readable text that may change wording across server versions).
  console.log(`License ${license.id} is NOT valid: ${meta.code} — ${meta.detail}`);
}
