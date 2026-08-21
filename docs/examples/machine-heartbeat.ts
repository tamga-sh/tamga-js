/**
 * Node example: create a machine, start a heartbeat scheduler, and handle
 * DEAD/RESURRECTED transitions.
 *
 * The heartbeat window is a hardcoded 600s (10 min) server-side — NOT
 * driven by `policy.heartbeat_duration` despite that field existing.
 * `startHeartbeat` here pings every 3 minutes (a third of the window), a
 * safe margin against network jitter.
 */
import { TamgaClient, MACHINE_HEARTBEAT_WINDOW_MS } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const licenseId = process.env.TAMGA_LICENSE_ID ?? "00000000-0000-0000-0000-000000000000";
const fingerprint = process.env.TAMGA_MACHINE_FINGERPRINT ?? "fp-abc123";

// Creation DOES run the machine/core/memory/disk limit checks, routed
// through the policy's overage_strategy: under NO_OVERAGE an over-limit
// create throws (422 MACHINE_LIMIT_EXCEEDED and friends), while an
// overage-permitting strategy lets it through and surfaces the limit at
// validate instead. activateMachine (create + validate composed, with
// optional auto-delete-on-overage) normalizes both onto one ValidationCode
// — prefer it if you need "reject over-limit activation" UX.
const machine = await client.createMachine(licenseId, fingerprint, {
  hostname: process.env.HOSTNAME,
  platform: process.platform,
  // memory/disk, if you report them, are MEGABYTES — 16 GB is 16384, not
  // 17179869184. Reporting bytes inflates the license's tally by ~1e6 and
  // gets the next activation refused with MEMORY_LIMIT_EXCEEDED.
});

console.log(`Machine ${machine.id} created, heartbeat_status: ${machine.attributes.heartbeat_status}`);

const stop = client.startHeartbeat(machine.id, MACHINE_HEARTBEAT_WINDOW_MS / 3);

// Periodically check status yourself — startHeartbeat only pings, it
// doesn't surface heartbeat_status transitions on its own.
const statusCheck = setInterval(async () => {
  const current = await client.pingHeartbeat(machine.id);
  if (current.attributes.heartbeat_status === "DEAD") {
    // The window elapsed before a ping arrived — the server may cull this
    // row (heartbeat_cull_strategy: DEACTIVATE_DEAD) or keep it
    // (KEEP_DEAD). Treat DEAD as "machine likely deleted server-side —
    // re-activate rather than keep retrying ping."
    console.log("Machine went DEAD — re-activating.");
    clearInterval(statusCheck);
    stop();
  } else if (current.attributes.heartbeat_status === "RESURRECTED") {
    console.log("Machine came back within the resurrection grace period.");
  }
}, MACHINE_HEARTBEAT_WINDOW_MS);

process.on("SIGINT", () => {
  stop();
  clearInterval(statusCheck);
  process.exit(0);
});
