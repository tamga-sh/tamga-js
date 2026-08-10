/**
 * Machine, Component, and Process resource models.
 *
 * STUB — placeholder shapes only. See `docs/plans/tamga-js.plan.md`
 * Sections G, I for the full field lists and TSDoc gotchas to add:
 *
 * - `Machine`: fingerprint/name/ip/hostname/platform/cores/memory/disk/
 *   metadata attributes, `heartbeat_status`, relationship to `license`.
 * - `HeartbeatStatus`: `NOT_STARTED | ALIVE | DEAD | RESURRECTED` state
 *   machine, hardcoded 600s window (NOT `policy.heartbeat_duration`).
 * - `Component`: fingerprint/name/metadata, relationship to `machine`.
 * - `Process`: ⚠️ `pid` is a **string** on the wire, not a number — never
 *   coerce to `number` in types or request builders (docs/sdk.md §8).
 *   Processes start `ALIVE` immediately, unlike machines (`NOT_STARTED`),
 *   and their heartbeat window is a hardcoded 30s with no resurrection
 *   grace period.
 */

/** TODO: full Machine resource — see module doc above. */
export interface Machine {
  id: string;
  type: "machines";
  fingerprint: string;
}

/** `NOT_STARTED` (never pinged) → `ALIVE` → `DEAD` → `RESURRECTED`. */
export type HeartbeatStatus = "NOT_STARTED" | "ALIVE" | "DEAD" | "RESURRECTED";

/** TODO: full Component resource — see module doc above. */
export interface Component {
  id: string;
  type: "components";
  fingerprint: string;
}

/** TODO: full Process resource — `pid` MUST stay `string`, not `number`. */
export interface Process {
  id: string;
  type: "processes";
  pid: string;
}
