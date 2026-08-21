/**
 * Node example: a complete machine + process lifecycle that survives restarts
 * and cleans up after itself.
 *
 * Two things here are not obvious from the endpoint list.
 *
 * **Re-activation.** The server reports re-registering a fingerprint it already
 * knows as `409 FINGERPRINT_TAKEN`, deliberately — its own comment reads
 * "already activated, carry on". But the `409` does not name the machine
 * holding the fingerprint, so on its own it gives a restarting client no way to
 * carry on. `activateMachine`'s trailing `reuseExistingMachine` flag resolves
 * the conflict instead of throwing: the existing machine comes back on
 * `result.machine`, so the second run of this file behaves exactly like the
 * first and burns no second seat.
 *
 * The flag is opt-in because "reuse" is a decision about seat accounting. And
 * the lookup is confined to this license: `machine_uniqueness_strategy` can be
 * `UNIQUE_PER_POLICY` or `UNIQUE_PER_ACCOUNT`, under which the machine holding
 * the fingerprint sits on a *different* license and this activation genuinely
 * did not happen — that case still throws.
 *
 * **Process cleanup is yours.** Nothing on the server reaps a stale process
 * row. The reaper exists but the job scheduler never dispatches it, and
 * `policy.max_processes` is only decremented by an explicit delete — so a
 * client that registers a process per launch and never deletes one eventually
 * gets `422 TOO_MANY_PROCESSES` on every start. `deleteProcess` on shutdown is
 * not housekeeping, it is the only thing keeping the seat count honest.
 */
import { TamgaClient, NotFoundError } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: process.env.TAMGA_ACCOUNT_ID ?? "your-account-id",
  baseUrl: process.env.TAMGA_BASE_URL ?? "https://api.tamga.sh",
  auth: { kind: "license", key: process.env.TAMGA_LICENSE_KEY ?? "YOUR-LICENSE-KEY" },
});

const licenseId = process.env.TAMGA_LICENSE_ID ?? "00000000-0000-0000-0000-000000000000";
const fingerprint = process.env.TAMGA_MACHINE_FINGERPRINT ?? "fp-abc123";

// Idempotent: run this twice and you get the same machine both times.
// Arguments in order: licenseId, fingerprint, create attributes, validate
// scope, autoDeleteOnOverage, reuseExistingMachine.
const result = await client.activateMachine(
  licenseId,
  fingerprint,
  { hostname: process.env.HOSTNAME, platform: process.platform },
  undefined,
  false,
  true,
);

if (!result.meta.valid) {
  // Branch on meta.code, never on meta.detail — the code is stable, the detail
  // is human text that gets reworded between server versions.
  console.error(`Activation refused: ${result.meta.code}`);
  process.exit(1);
}

const machine = result.machine;
if (machine === undefined) {
  // Only reachable when a create-time limit refused the create outright, or
  // when autoDeleteOnOverage rolled the new machine back. Neither can happen
  // on the branch above, but the type is honest about it.
  throw new Error("activation reported valid but produced no machine");
}

console.log(`Machine ${machine.id} ready (heartbeat_status: ${machine.attributes.heartbeat_status})`);

// Before registering another process, sweep any this machine leaked on a
// previous run — a hard kill leaves its row behind forever.
for (const stale of await client.listMachineProcesses(machine.id)) {
  await client.deleteProcess(stale.id).catch((error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
  });
}

const proc = await client.createProcess(machine.id, process.pid);
console.log(`Process ${proc.id} registered for pid ${proc.attributes.pid}`);

// Both schedulers register with the client, so `dispose()` below reaches them
// whether or not their stop functions are still in scope.
await client.startHeartbeatFromPolicy(machine.id, licenseId);
client.startProcessHeartbeat(proc.id);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Order matters: stop the timers first, so nothing re-pings a row that is
  // about to disappear and logs a spurious failure.
  client.dispose();

  await client.deleteProcess(proc.id).catch((error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
  });

  // The machine is deliberately NOT deleted: it is the activation, and the
  // next run reuses it through the path at the top of this file. Delete it
  // only on an explicit deactivation.
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
