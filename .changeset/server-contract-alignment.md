---
"@tamga/sdk": patch
---

Align the SDK with the current tamga-api server contract.

Behaviour fixes: `activateMachine` now handles the create-time `422` limit
refusal (`NO_OVERAGE` policies) and normalizes its code onto the validate-time
`ValidationCode`, while keeping the existing create→validate→rollback path for
overage-permitting policies; `validateById` strips `scope.version` /
`scope.checksum`, which the server rejects with `422 SCOPE_NOT_SUPPORTED`,
failing the whole call; `listEntitlements` no longer sends the `page[after]`
cursor the server ignores on that route, and both list methods now send an
explicit `limit=100` instead of falling into the server's silent 25-row
default; `/actions/ping-heartbeat` and `/actions/reset-heartbeat` are now
retried after a `429` like the other idempotent actions; requests have a 45s
per-attempt deadline (`TamgaClientConfig.timeoutMs`, `0` disables it) where
they previously had none.

Additions: typed subclasses for `MACHINE_LIMIT_EXCEEDED`,
`CORE_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `DISK_LIMIT_EXCEEDED`,
`TOO_MANY_PROCESSES`, `LICENSE_SUSPENDED`, `LICENSE_EXPIRED` and
`LICENSE_NOT_ALLOWED`; an optional `inherited` flag on `EntitlementAttributes`;
`ExpirationStrategy.REVOKE_ACCESS` and `AuthenticationStrategy.NONE`;
`MAX_PAGE_SIZE` and `DEFAULT_TIMEOUT_MS`.

Documentation corrections: auth **is** enforced server-side and license-key
auth requires the policy's `authentication_strategy` to be `LICENSE` or
`MIXED` (it defaults to `TOKEN`); machine `memory` / `disk` are megabytes, not
bytes; `scope.entitlements` and `scope.fingerprint` are genuinely enforced;
`quickValidate` does not record the validation when the request carries an
`Origin` header, which a browser always adds; `resetHeartbeat` and
`generateOfflineProof` are role-gated and always `403` under license-key auth;
the release/auto-update endpoint works and the earlier "it crashes" note was
wrong.

Also corrected: a machine's `heartbeat_status` of `"DEAD"` was documented
throughout as "the row was culled — re-activate instead of pinging". Both
halves of that are wrong. `DEAD` is not observable from any route this SDK
calls — `pingHeartbeat` writes `last_heartbeat_at = NOW()` and then derives the
status from that same timestamp, so it answers `ALIVE` or `RESURRECTED`;
`resetHeartbeat` nulls the column (`NOT_STARTED`); `createMachine` never sets it
(`NOT_STARTED`); and validate never emits `HEARTBEAT_DEAD`. It is a real server
state, but only a machine read (`GET /machines/{id}`) surfaces it and this SDK
exposes none, so the literal stays in `HeartbeatStatus` as forward-compat and a
`case "DEAD"` in your code is dead code today. Nor would `DEAD` mean the row was
culled: the cull job runs exclusively for policies with
`require_heartbeat = true`, which defaults to `false`, so under a default policy
no row is ever culled and a machine stays `DEAD` indefinitely with its row and
its seat intact — and a ping revives it regardless (bare
`last_heartbeat_at = now`, no resurrection check). What remains is the positive
rule: a heartbeat scheduler must not stop on **any** status, and `startHeartbeat`
does not — it discards the response entirely. The only terminal signal is a
`404 NOT_FOUND` (`NotFoundError`) from the ping, meaning the row is gone, which
is where re-activation belongs. Docs, JSDoc and
`docs/examples/machine-heartbeat.ts` (whose dead `DEAD` branch is gone) are
updated accordingly, and the scheduler has a regression test proving the timer
survives three consecutive unexpected statuses.

`ValidationCode`'s own doc is brought in line with the enforced scope fields:
`ENTITLEMENTS_MISSING` and `FINGERPRINT_SCOPE_MISMATCH` move out of the
"modeled but not reachable" group, so the reachable count goes from 14 to 16
(and the unreachable one from ten to eight) in `src/models/validation.ts`,
`README.md` and `CLAUDE.md`. The union itself is unchanged — all 24 literals
plus the `string & {}` escape hatch are still there.

Finally, the machine heartbeat window was documented throughout as a hardcoded
600s that `policy.heartbeat_duration` does not drive. It is the opposite: the
server uses `heartbeat_duration` seconds when that column is set and falls back
to 600s only when it is null (`Policy::effective_heartbeat_duration_secs`, and
`COALESCE(p.heartbeat_duration, 600)` in the cull job's claim query). Since this
SDK has no policy or machine getter, it cannot read the effective window, so
`MACHINE_HEARTBEAT_WINDOW_MS` is now documented as the 600s **fallback** and
`startHeartbeat` as a scheduler you size yourself: dividing the constant is safe
only while `heartbeat_duration` is unset, and under a policy that sets it lower
you must learn your window out of band and pass a shorter `intervalMs`. The 30s
process window really is hardcoded and is unchanged.
