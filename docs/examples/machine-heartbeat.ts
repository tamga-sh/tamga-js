/**
 * Node example: create a machine, start a heartbeat scheduler, and
 * re-activate when the machine row disappears.
 *
 * The heartbeat window is `policy.heartbeat_duration` seconds when that
 * column is set, and 600s (10 min) only when it is null.
 * MACHINE_HEARTBEAT_WINDOW_MS is that fallback, and plain `startHeartbeat`
 * does not adapt on its own — so this example uses
 * `startHeartbeatFromPolicy`, which reads `GET /licenses/{id}/policy` once at
 * startup and pings at a third of whatever window that policy actually
 * imposes. One extra request, and the scheduler stops guessing 600s at a
 * policy that asked for 60. Sizing against the fallback under a shorter policy
 * window leaves the machine outside its window between pings, which is what
 * makes it cullable under `require_heartbeat`.
 *
 * Two other ways to reach the same number, when a policy read is not wanted:
 * `heartbeatWindowMsFromMachine(machine)` on any read-backed machine — one
 * from `getMachine`, `listMachines`, a checked-out machine file, or
 * `generateOfflineProof`'s `machine` half — or out of band from whoever
 * configures the policy. A *ping* response is not one of them: that query
 * carries no policy join, so its `next_heartbeat_at` is always
 * `last_heartbeat_at + 600s`.
 *
 * ⚠️ If you take the `heartbeatWindowMsFromMachine` route, branch on its
 * `undefined` rather than asserting it away. It returns `number | undefined`
 * and `undefined` is the *normal* answer for a machine that has not been
 * pinged yet — i.e. the one you just activated. `heartbeatWindowMsFromMachine(m)!
 * / MACHINE_HEARTBEAT_INTERVAL_DIVISOR` is `NaN` in exactly that case, and
 * `setInterval` turns `NaN` into a 1 ms tick rather than refusing it.
 * `startHeartbeat` floors its interval at 1s so this can no longer flood the
 * server, but a floored interval is still not the interval you wanted. This
 * example sidesteps the whole question by using `startHeartbeatFromPolicy`.
 *
 * ⚠️ There is deliberately no `case "DEAD"` below, because a *ping* cannot
 * return that status: it writes `last_heartbeat_at = NOW()` and then derives
 * the status from that same timestamp, so it answers ALIVE or RESURRECTED.
 * A branch on DEAD *here* would be dead code. DEAD is reachable elsewhere in
 * this SDK — `getMachine` and `listMachines`, and a checked-out machine file
 * (see `docs/examples/offline-machine-file.ts`), all resolve through a read
 * that joins the policy, so the Machine they yield carries a real staleness
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

// Sized off the policy, not off the fallback constant. Falls back to
// MACHINE_HEARTBEAT_WINDOW_MS / 3 internally when `heartbeat_duration` is
// null, which is exactly what a hand-written `startHeartbeat` call would do.
const stop = await client.startHeartbeatFromPolicy(machine.id, licenseId);

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
  clearInterval(statusCheck);
  // `stop()` alone would do here, but `dispose()` is the call that scales:
  // it clears every timer this client started, so a teardown path does not
  // have to have kept a handle on each one. A setInterval left running holds
  // the Node process open.
  stop();
  client.dispose();
  process.exit(0);
});
