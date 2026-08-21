/**
 * Node example: create a machine, start a heartbeat scheduler, and
 * re-activate when the machine row disappears.
 *
 * The heartbeat window is `policy.heartbeat_duration` seconds when that
 * column is set, and 600s (10 min) only when it is null. This SDK cannot
 * read it back — there is no policy getter — so MACHINE_HEARTBEAT_WINDOW_MS
 * is that 600s fallback and `startHeartbeat` never adapts. The 3-minute
 * interval below (a third of the fallback, a safe margin against network
 * jitter) is therefore correct only while `heartbeat_duration` is unset: if
 * your policy sets it, find that value out of band and divide it instead.
 *
 * ⚠️ There is deliberately no `case "DEAD"` below, because a *ping* cannot
 * return that status: it writes `last_heartbeat_at = NOW()` and then derives
 * the status from that same timestamp, so it answers ALIVE or RESURRECTED.
 * A branch on DEAD *here* would be dead code. DEAD is reachable elsewhere in
 * this SDK — a checked-out machine file (see
 * `docs/examples/offline-machine-file.ts`) is resolved through a read that
 * joins the policy, so the Machine it yields carries a real staleness
 * verdict — it just never arrives on this route. And even there it would not
 * be a stop condition: it does not mean the machine was culled (culling runs
 * only under `require_heartbeat = true`, which is not the default) and the
 * ping revives the machine anyway. The one terminal signal is a 404 from the
 * ping, meaning the row is gone, which is what this example re-activates on.
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

  // RESURRECTED is the only interesting status a ping can hand back: the
  // machine had fallen outside its window and this ping revived it. Whatever
  // comes back, neither timer stops — see this file's header for why a DEAD
  // branch would be dead code on this route specifically.
  if (current.attributes.heartbeat_status === "RESURRECTED") {
    console.log("Machine had lapsed and this ping revived it; heartbeat continues.");
  }
}, MACHINE_HEARTBEAT_WINDOW_MS);

process.on("SIGINT", () => {
  stop();
  clearInterval(statusCheck);
  process.exit(0);
});
