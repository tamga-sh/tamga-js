/**
 * Machine, Component, and Process resource models.
 *
 * Field set ground-truthed against `tamga-rust`'s `src/models/machine.rs`.
 * Notably no `relationships` object on any of these three resources — same
 * pattern as {@link import("./license.js").License}.
 */

/** The `machines` JSON:API resource: `{ id, type, attributes }`. */
export interface Machine {
  /** UUIDv7 machine ID. */
  id: string;
  /** Always `"machines"`. */
  type: "machines";
  attributes: MachineAttributes;
}

/** Attributes of a {@link Machine}. */
export interface MachineAttributes {
  /** Unique per `(account_id, license_id, fingerprint)`. */
  fingerprint: string;
  /** CPU core count, if reported at registration. */
  cores: number | null;
  /**
   * Memory in **megabytes**, if reported — not bytes. See {@link
   * import("../client.js").CreateMachineOptions.memory} for why the unit
   * matters.
   */
  memory: number | null;
  /** Disk in **megabytes**, if reported — not bytes. Same caveat as {@link memory}. */
  disk: number | null;
  /** IP address, if reported. */
  ip: string | null;
  /** Reported hostname, if any. */
  hostname: string | null;
  /** Reported OS/platform string, if any. */
  platform: string | null;
  /** Optional display name. */
  name: string | null;
  /** Machine heartbeat state — see {@link HeartbeatStatus}. */
  heartbeat_status: HeartbeatStatus;
  /** Timestamp of the last `ping-heartbeat` call. */
  last_heartbeat_at: string | null;
  /**
   * Server-computed next-expected-heartbeat deadline, if derivable:
   * `last_heartbeat_at` plus the window this row was judged on.
   *
   * **This is how you recover the effective heartbeat window.** Subtracting
   * `last_heartbeat_at` from it yields `policy.heartbeat_duration` in
   * milliseconds — the value {@link MACHINE_HEARTBEAT_WINDOW_MS} only
   * guesses at:
   *
   * ```ts
   * const { last_heartbeat_at: last, next_heartbeat_at: next } = machine.attributes;
   * const windowMs = last && next ? Date.parse(next) - Date.parse(last) : undefined;
   * ```
   *
   * ⚠️ Only trustworthy on a **read-backed** machine — one from
   * {@link import("../checkout/machineFile.js").verifyAndDecryptMachineFile}
   * or the `machine` half of
   * {@link import("../client.js").TamgaClient.generateOfflineProof}, whose
   * queries join the policy. A `pingHeartbeat` response is **not**: that
   * query carries no policy join, so the server falls back to 600s and this
   * field comes back as `last_heartbeat_at + 600s` no matter what the policy
   * says. Deriving a window from a ping just reproduces the fallback.
   *
   * `null` until the machine has been pinged at least once (it is derived
   * from `last_heartbeat_at`), and the value is a snapshot from the moment
   * the file or proof was issued — re-derive it if the policy may have
   * changed since.
   */
  next_heartbeat_at: string | null;
  /** Timestamp of the last machine-file checkout. */
  last_check_out_at: string | null;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}

/**
 * Machine heartbeat state machine: `NOT_STARTED` (never pinged) → `ALIVE`
 * (pinged within window) → `DEAD` (window elapsed) → `RESURRECTED` (new
 * ping arrived after a death event was already recorded).
 *
 * ⚠️ The window is **policy-driven**. The server uses
 * `policy.heartbeat_duration` seconds when that column is set and falls back
 * to 600s (10 min) only when it is null
 * (`Policy::effective_heartbeat_duration_secs`; the cull job's claim query
 * uses `COALESCE(p.heartbeat_duration, 600)`). {@link MACHINE_HEARTBEAT_WINDOW_MS}
 * is that fallback, not a reading of your policy — but you are not without a
 * source: a read-backed machine carries the effective window in
 * {@link MachineAttributes.next_heartbeat_at} (subtract `last_heartbeat_at`
 * from it), see that field's doc for the exact recipe and its caveats. Learn
 * the window out of band only when no machine file is available.
 *
 * ⚠️ **Which responses can carry `DEAD` depends on what the request did to
 * `last_heartbeat_at`** — not, as this was previously phrased, on whether the
 * request wrote anything at all. A write that *sets* the column cannot report
 * `DEAD`, because the status is then derived from the timestamp that write just
 * put there: `pingHeartbeat` writes `last_heartbeat_at = NOW()` and so answers
 * `ALIVE` or `RESURRECTED`; `resetHeartbeat` nulls it (`NOT_STARTED`);
 * `createMachine` never sets it, and a null column is `NOT_STARTED` by
 * definition. License validate never emits `HEARTBEAT_DEAD` either.
 *
 * A write that leaves the column alone is **not** covered by that rule, and
 * there is one: {@link import("../client.js").TamgaClient.updateMachine}.
 * `PATCH /machines/{id}` touches `name`/`ip`/`hostname`/`platform`/`cores`/
 * `memory`/`disk`/`metadata` and nothing else, so it still derives a status
 * from whatever `last_heartbeat_at` already held — and its
 * `UPDATE … RETURNING` joins no policy, so it judges that against the 600 s
 * fallback instead of the policy's window. Its verdict can therefore differ
 * from a read's in either direction. Do not read heartbeat state off a patch.
 *
 * A response built off a **read** carries a genuine verdict, and this SDK has
 * four: {@link import("../client.js").TamgaClient.getMachine} and
 * {@link import("../client.js").TamgaClient.listMachines}, machine checkout
 * (so the {@link Machine} that
 * {@link import("../checkout/machineFile.js").verifyAndDecryptMachineFile}
 * returns may read `DEAD`), and the `machine` half of
 * {@link import("../client.js").TamgaClient.generateOfflineProof}. All four
 * resolve through a lookup that joins the policy, so their status *and* their
 * `next_heartbeat_at` are judged against the real window. So branch on `DEAD`
 * **there** if you have a use for it; just never on a ping response, where it
 * cannot appear.
 *
 * ⚠️ **And `DEAD` does not mean the machine was culled.** It means one
 * thing only: the last ping is older than the window. The row is still
 * there, the seat is still taken, and nothing has been deleted or
 * deactivated. The cull job that would remove it runs only for policies with
 * `require_heartbeat = true`, and that column **defaults to `false`** — so
 * under a default policy nothing is ever culled and a machine stays `DEAD`
 * indefinitely with its row and its seat intact. `heartbeat_status` is
 * computed from `last_heartbeat_at` versus the window and never consults
 * `require_heartbeat`, so the status alone cannot tell you which policy you
 * are under.
 *
 * **A heartbeat scheduler must not stop on any status.** None of the values
 * a ping can return is a stop condition, and the ping revives the machine
 * anyway — it is a bare `last_heartbeat_at = now` write with no resurrection
 * check. The only terminal signal is a `404 NOT_FOUND` (`NotFoundError`)
 * from the ping itself, meaning the row is gone; hang re-activation off
 * that.
 *
 * The trailing `string & {}` member is the standard open-union escape
 * hatch — see `src/models/validation.ts`'s module doc for the rationale.
 */
export type HeartbeatStatus = "NOT_STARTED" | "ALIVE" | "DEAD" | "RESURRECTED" | (string & {});

/**
 * The server's **fallback** machine heartbeat window, in milliseconds — the
 * value it uses when `policy.heartbeat_duration` is null.
 *
 * ⚠️ Not necessarily *your* window. A policy that sets `heartbeat_duration`
 * gets that value instead, and this constant is a compile-time literal that
 * cannot adapt. Treat it as a default to size
 * {@link import("../client.js").TamgaClient.startHeartbeat} against only while
 * `heartbeat_duration` is unset; otherwise pass an interval derived from the
 * real window, which a checked-out machine file gives you as
 * `next_heartbeat_at - last_heartbeat_at` (see
 * {@link MachineAttributes.next_heartbeat_at}). See {@link HeartbeatStatus}.
 */
export const MACHINE_HEARTBEAT_WINDOW_MS = 600_000;

/** Hardcoded process heartbeat window, in milliseconds — see {@link ProcessAttributes}. */
export const PROCESS_HEARTBEAT_WINDOW_MS = 30_000;

/** The `components` JSON:API resource: `{ id, type, attributes }`. */
export interface Component {
  /** UUIDv7 component ID. */
  id: string;
  /** Always `"components"`. */
  type: "components";
  attributes: ComponentAttributes;
}

/** Attributes of a {@link Component}. */
export interface ComponentAttributes {
  /** Unique per `(account_id, machine_id, fingerprint)`. */
  fingerprint: string;
  /** Display name. */
  name: string;
  /** The owning machine's ID. */
  machine_id: string;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}

/** The `processes` JSON:API resource: `{ id, type, attributes }`. */
export interface Process {
  /** UUIDv7 process ID. */
  id: string;
  /** Always `"processes"`. */
  type: "processes";
  attributes: ProcessAttributes;
}

/**
 * Attributes of a {@link Process}. Unlike a {@link Machine}, there is no
 * `heartbeat_status` field — a process's aliveness is entirely a function
 * of `last_heartbeat_at` versus the hardcoded 30s window; a dead process
 * row is deleted immediately, not tracked in a `DEAD`/`RESURRECTED` state
 * like machines.
 */
export interface ProcessAttributes {
  /**
   * The process ID, as a wire **string** — ⚠️ never coerce to `number` in
   * types or request builders; see {@link toPidString}.
   */
  pid: string;
  /** The owning machine's ID. */
  machine_id: string;
  /**
   * A process starts `ALIVE` immediately at creation (unlike a machine,
   * which starts `NOT_STARTED`) — this timestamp is set on creation, not
   * left `null` until a first ping.
   */
  last_heartbeat_at: string;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp. */
  created: string;
  /** Last-updated timestamp. */
  updated: string;
}

/**
 * Normalizes a caller-supplied PID (native `number` or `string`) to the
 * wire string form `POST /processes` expects. ⚠️ The wire format is a JSON
 * **string**, not a number — this exists so callers holding a native
 * numeric PID don't have to hand-format it, while guaranteeing the request
 * body never silently sends a JSON number.
 */
export function toPidString(pid: string | number): string {
  return typeof pid === "number" ? String(pid) : pid;
}

/**
 * The divisor this SDK's schedulers apply to a heartbeat window to pick a ping
 * interval: ping three times per window, so two consecutive pings can be lost
 * without the machine falling outside it.
 *
 * Used by
 * {@link import("../client.js").TamgaClient.startHeartbeatFromPolicy}; exported
 * so a caller sizing its own timer off
 * {@link heartbeatWindowMsFromMachine} reaches the same number.
 *
 * ⚠️ Dividing by this is where the recommended composition goes wrong.
 * `heartbeatWindowMsFromMachine` returns `number | undefined`, so
 * `heartbeatWindowMsFromMachine(m)! / MACHINE_HEARTBEAT_INTERVAL_DIVISOR` —
 * with the non-null assertion the type forces — is `NaN` whenever the machine
 * has not been pinged yet. Handle the `undefined` explicitly instead.
 */
export const MACHINE_HEARTBEAT_INTERVAL_DIVISOR = 3;

/**
 * Recovers the **effective** heartbeat window, in milliseconds, from a machine
 * that came back on a read path — `next_heartbeat_at - last_heartbeat_at`.
 *
 * This is the recipe {@link MachineAttributes.next_heartbeat_at} documents,
 * written once so callers do not each re-derive it. Returns `undefined` when
 * either timestamp is absent or unparseable, or when the difference is not
 * positive.
 *
 * ⚠️ **Only meaningful on a read-backed machine.** The server computes
 * `next_heartbeat_at` from whatever window the answering query had in hand, and
 * only the read queries join the policy in. Pass one of:
 *
 * - {@link import("../client.js").TamgaClient.getMachine}
 * - a machine from {@link import("../client.js").TamgaClient.listMachines}
 * - {@link import("../checkout/machineFile.js").verifyAndDecryptMachineFile}
 * - the `machine` half of
 *   {@link import("../client.js").TamgaClient.generateOfflineProof}
 *
 * Pass a `pingHeartbeat`, `resetHeartbeat` or `createMachine` response and the
 * answer is always the 600 000 ms fallback, whatever the policy says — those
 * write paths carry no policy join. There is no field on the response that
 * distinguishes the two, which is why this takes the machine and not a flag.
 *
 * When no machine file or read is available, ask the policy instead:
 * {@link import("../client.js").TamgaClient.resolveHeartbeatWindowMs}.
 *
 * ⚠️ **`undefined` is a real, common return — do not assert it away.** It is
 * what you get on any machine that has not been pinged yet, which includes
 * every freshly activated one. The obvious next step,
 * `heartbeatWindowMsFromMachine(m)! / MACHINE_HEARTBEAT_INTERVAL_DIVISOR`,
 * is therefore `NaN` exactly when a scheduler is most likely to be starting
 * up — and `NaN` is a delay `setInterval` turns into a 1 ms tick rather than
 * refusing.
 * {@link import("../client.js").TamgaClient.startHeartbeat} floors its
 * interval so that can no longer flood the server, but the interval is still
 * wrong. Branch on `undefined` and fall back to
 * {@link import("../client.js").TamgaClient.startHeartbeatFromPolicy} or to a
 * window learned out of band.
 */
export function heartbeatWindowMsFromMachine(machine: Machine): number | undefined {
  const { last_heartbeat_at: last, next_heartbeat_at: next } = machine.attributes;
  if (last === null || next === null) return undefined;
  const windowMs = Date.parse(next) - Date.parse(last);
  return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined;
}
