/**
 * Node example: create a machine, start a heartbeat scheduler, and handle
 * DEAD/RESURRECTED transitions.
 *
 * The heartbeat window is `policy.heartbeat_duration` seconds when that
 * column is set, and 600s (10 min) only when it is null. This SDK cannot
 * read it back — there is no policy getter — so MACHINE_HEARTBEAT_WINDOW_MS
 * is that 600s fallback and `startHeartbeat` never adapts. The 3-minute
 * interval below (a third of the fallback, a safe margin against network
 * jitter) is therefore correct only while `heartbeat_duration` is unset: if
 * your policy sets it, find that value out of band and divide it instead.
 *
 * ⚠️ DEAD is not a terminal state and does not mean the machine was culled.
 * It means only that the last ping is older than the window. Culling runs
 * exclusively for policies with `require_heartbeat = true`, which is not the
 * default, so a machine can report DEAD forever with its row and its seat
 * intact — and a ping to a DEAD machine succeeds and revives it. The only
 * signal that the row is really gone is a 404 from the ping, which is what
 * this example re-activates on.
 */
import { TamgaClient, NotFoundError, MACHINE_HEARTBEAT_WINDOW_MS } from "@tamga/sdk";

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
// doesn't surface heartbeat_status transitions on its own, and it swallows
// every ping failure including the 404 that matters here.
const statusCheck = setInterval(async () => {
  let current;
  try {
    current = await client.pingHeartbeat(machine.id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      // The row really is gone (deleted, or culled under a
      // require_heartbeat policy with heartbeat_cull_strategy:
      // DEACTIVATE_DEAD). THIS is the re-activation trigger — call
      // createMachine again with the same fingerprint here.
      console.log("Ping returned 404 — the machine row is gone, re-activating.");
      clearInterval(statusCheck);
      stop();
      return;
    }
    // Anything else (network blip, 429 exhaustion, 5xx) is transient: leave
    // both timers running and try again on the next tick.
    console.warn("Heartbeat check failed, retrying next tick:", error);
    return;
  }

  if (current.attributes.heartbeat_status === "DEAD") {
    // The window elapsed before a ping arrived. Nothing has been deleted:
    // the ping that just returned this status already wrote
    // last_heartbeat_at, so the machine is live again. Do NOT stop the
    // scheduler and do NOT re-activate here — under the default policy
    // (require_heartbeat = false) the row is never culled and re-activating
    // would just burn a second seat.
    console.log("Machine read DEAD — the ping above revived it; heartbeat continues.");
  } else if (current.attributes.heartbeat_status === "RESURRECTED") {
    console.log("Machine came back after a recorded death event.");
  }
}, MACHINE_HEARTBEAT_WINDOW_MS);

process.on("SIGINT", () => {
  stop();
  clearInterval(statusCheck);
  process.exit(0);
});
