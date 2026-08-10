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
  /** Memory in bytes, if reported. */
  memory: number | null;
  /** Disk in bytes, if reported. */
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
  /** Server-computed next-expected-heartbeat deadline, if derivable. */
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
 * ⚠️ The window is a **hardcoded 600s (10 min)**, NOT driven by
 * `policy.heartbeat_duration` despite that field existing on the policy
 * resource. Treat `DEAD` as "machine likely deleted server-side —
 * re-activate rather than retry ping."
 *
 * The trailing `string & {}` member is the standard open-union escape
 * hatch — see `src/models/validation.ts`'s module doc for the rationale.
 */
export type HeartbeatStatus = "NOT_STARTED" | "ALIVE" | "DEAD" | "RESURRECTED" | (string & {});

/** Hardcoded machine heartbeat window, in milliseconds — see {@link HeartbeatStatus}. */
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
