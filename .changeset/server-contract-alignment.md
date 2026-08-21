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
throughout as "the row was culled — re-activate instead of pinging". That is
wrong. `DEAD` means only that the last ping is older than the hardcoded 600s
window: the server's cull job runs exclusively for policies with
`require_heartbeat = true`, which defaults to `false`, so under a default
policy no row is ever culled and a machine reports `DEAD` indefinitely with
its row and its seat intact. A ping to a `DEAD` machine is a bare
`last_heartbeat_at = now` write with no resurrection check — it succeeds and
revives the machine — so a scheduler must keep pinging through `DEAD`, and
`startHeartbeat` does. The only dependable "the row is gone" signal is a
`404 NOT_FOUND` (`NotFoundError`) from the ping itself, which is where
re-activation belongs. Docs, JSDoc and the `docs/examples/machine-heartbeat.ts`
example are updated accordingly, and the scheduler now has a regression test
proving it keeps pinging across three consecutive `DEAD` responses.
