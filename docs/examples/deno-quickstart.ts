/**
 * Deno quickstart — no `node_modules`, imports `@tamga/sdk` via an
 * `npm:` specifier (Deno's native way to consume npm packages without a
 * separate install step or import map).
 *
 * Run with: `deno run --allow-net --allow-env deno-quickstart.ts`
 */
import { TamgaClient } from "npm:@tamga/sdk";

const client = new TamgaClient({
  accountId: Deno.env.get("TAMGA_ACCOUNT_ID") ?? "your-account-id",
  baseUrl: Deno.env.get("TAMGA_BASE_URL") ?? "https://api.tamga.sh",
  auth: { kind: "license", key: Deno.env.get("TAMGA_LICENSE_KEY") ?? "YOUR-LICENSE-KEY" },
});

const { meta } = await client.validateByKey(Deno.env.get("TAMGA_LICENSE_KEY") ?? "YOUR-LICENSE-KEY");
console.log(`Validation outcome: ${meta.code} (valid: ${meta.valid})`);
