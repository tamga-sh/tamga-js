---
"@tamga/sdk": patch
---

Reach the endpoints this SDK named but could not call.

Fourteen new `TamgaClient` methods, no existing signature changed. Each covers a
route that exists on the server and had no client-side path, and several close a
failure mode rather than adding convenience.

**Machine reads and update.** `getMachine`, `listMachines`,
`findMachineByFingerprint`, `updateMachine`. `getMachine` matters beyond
convenience: it is a **read**, so its query joins the policy — which makes it
the first route here whose `heartbeat_status` can genuinely report `DEAD`, and
whose `next_heartbeat_at` reflects the policy instead of the 600s fallback.
`updateMachine` cannot clear a field back to `null` (the server's statement is
`name = COALESCE($3, name)`, so an omitted field and an explicit `null` are the
same no-op) and its `cores`/`memory`/`disk` move the license's running totals,
so the megabytes-not-bytes rule applies there too.

⚠️ **`listMachines` is offset-paginated and every other list here is keyset.**
It takes `page`/`size` and returns `{ items, page: { number, size, total,
totalPages } }`; `listComponents` and `listMachineProcesses` take `limit`/`after`
and return a bare array. Sending the wrong style is silent in both directions —
a cursor at an offset route and a page number at a keyset route are both
ignored. This repo has already shipped that mistake once in the other direction,
modelling a working cursor for a route that ignores `page[after]` entirely.
`listMachines` also has no `filter[fingerprint]`: the only fingerprint lookup on
offer is `filter[q]`, an `ILIKE '%term%'` spanning `name`/`hostname`/
`fingerprint`, so `findMachineByFingerprint` searches and then re-checks the
field exactly. It takes `licenseId` as a required argument because the
`machines` resource does not serialize `license_id` — a machine found without
that filter cannot be shown to belong to the license the caller asked about.

**Idempotent re-activation.** `activateMachine` gains a trailing
`reuseExistingMachine` flag, off by default. The server reports re-registering a
known fingerprint as `409 FINGERPRINT_TAKEN` deliberately — its own comment
reads "already activated, carry on" — but the response does not name the machine
holding the fingerprint, so a restarting client had no way to actually carry on
short of persisting the machine id locally. With the flag set, the conflict
resolves to the existing machine and the call becomes idempotent: run it twice
and you get the same machine, the same verdict, and no second seat. The lookup
is confined to the license being activated and a miss re-throws, because
`machine_uniqueness_strategy` can be `UNIQUE_PER_POLICY` or
`UNIQUE_PER_ACCOUNT`, under which the conflicting machine belongs to a
*different* license and this activation genuinely did not happen.
`ValidationResult` gains an optional `machine` reporting what the activation
resolved to, and `autoDeleteOnOverage` now only ever deletes a machine the call
created — never a reused one.

**License and policy reads.** `getLicense`, `getLicensePolicy`, `getPolicy`,
plus `resolveHeartbeatWindowMs` and `startHeartbeatFromPolicy`, which close the
loop on the policy-driven heartbeat window: one extra request at startup and the
scheduler stops guessing 600s at a policy that asked for 60. Sizing against the
fallback under a shorter policy window leaves the machine outside its window
between pings, which is what makes it cullable under `require_heartbeat`, with
nothing in a ping response to reveal it. `effectiveHeartbeatWindowMs(policy)`
and `heartbeatWindowMsFromMachine(machine)` are exported for callers scheduling
their own timers.

⚠️ **`getPolicy` is unreachable with a license key.** `GET /policies/{id}`
requires the `policy.read` permission, which the license-key role's default set
does not hold, so it answers `403` whatever the policy's
`authentication_strategy` says. `getLicensePolicy` reaches the same resource
through `GET /licenses/{id}/policy`, which needs only `license.read` — that is
the one an embedded client should call.

⚠️ **Neither license-scoped read is confined to the caller's own license.** The
server's `require_license_scope` guard is called by `validate`, `validate-key`
and `check-out`, but not by `GET /licenses/{id}` or `GET /licenses/{id}/policy`.
Since the license-key role holds `license.read` by default, a key can read any
license in the account through `getLicense`, and `attributes.key` comes back in
plaintext. This is a server-side issue reported upstream; the SDK cannot fix it
and this release does not describe those reads as safe.

**Process teardown.** `deleteProcess`, `listMachineProcesses`, and `dispose()`.
Nothing server-side reaps a stale process row — the reaper exists but the job
scheduler never dispatches it, and `max_processes` is only decremented by an
explicit delete — so a client that registers a process per launch and never
deletes one eventually gets `422 TOO_MANY_PROCESSES` on every start with no
client-side recovery. `dispose()` clears every timer the client started;
`startHeartbeat` and `startProcessHeartbeat` now register theirs, and the stop
functions they return deregister. A `setInterval` holds a Node process open, so
this is what a teardown path needs. It stops timers only, and deliberately
deletes nothing.

**Auto-update and health.** `checkForUpgrade` and `health`.

⚠️ **`checkForUpgrade` returning `undefined` does not mean "you are up to
date".** `GET /releases/actions/upgrade` answers `204 No Content` in two
different situations and will not distinguish them: no release newer than the
version you sent exists, *and* a newer release exists that this license is not
entitled to. The collapse is deliberate — a distinct refusal would leak "there
is a newer version and you cannot have it", which is exactly what the expiry
gate withholds. Word it to users as *no update is available to you*, never as
*you are on the latest version*: the second is a claim this endpoint cannot
support, and it is wrong precisely for the customers whose licence lapsed. A
suspended licence is the third outcome and is not collapsed — it throws
`ForbiddenError`. Two more traps: leaving `constraint` unset is not "no
constraint" (the server substitutes a pessimistic `~{major}.{minor}.{patch}`, so
an updater on 1.2.0 is never offered 1.3.0), and `channel` is required by this
SDK even though the server allows omitting it, because omitting it drops the
channel predicate entirely and lets alpha and dev builds answer a production
updater.

`health()` is the only non-account-scoped route here, so the client keeps a
second transport rooted at the bare origin. It is also the only route exempt
from the server's `Host`-header check, which makes it the test that tells a
`TAMGA_ALLOWED_HOSTS` misconfiguration from a bad credential: if every other
call is returning `403 "The Host header does not match any configured host"` and
this one succeeds, the fault is the deployment's configuration, not the caller's
key.

New exported types: `ListMachinesOptions`, `MachineSortField`, `SortOrder`,
`UpdateMachineOptions`, `UpgradeCheckOptions`, `OffsetPage`, `OffsetPageMeta`,
`Release`, `ReleaseAttributes`, `HealthStatus`, and the constant
`MACHINE_HEARTBEAT_INTERVAL_DIVISOR`. Note that `Release`'s attributes are
**camelCase** (`productId`), unlike every other resource in this API — modelled
as the server emits it rather than normalized.

Semver note: `patch` is deliberate and is the whole point. Every change here is
additive — the exported surface was diffed against the previous release's
generated `.d.ts`, with zero removals; the only two altered declarations are
`activateMachine`'s trailing optional parameter and `ValidationResult`'s new
optional property, both of which stay assignable to their previous shapes
(`test/additive-surface.spec.ts` proves it at compile time). Under 0.x
semantics a minor would be 0.4.0, which consumers pinned to `^0.3` would never
receive.
