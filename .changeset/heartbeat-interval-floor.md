---
"@tamga/sdk": patch
---

Stop a hand-composed heartbeat from busy-looping the licensing server.

`startHeartbeatFromPolicy` already floored its computed interval at one second.
The primitives it is built from did not: `resolveHeartbeatWindowMs` returns the
policy's window verbatim, and `startHeartbeat(machineId, intervalMs)` handed
`intervalMs` straight to `setInterval`. Wiring the two together by hand — a
reasonable reading of two public methods that look designed to compose — could
therefore start a timer on a zero interval.

`heartbeat_duration` really can be zero or negative. The column carries no
`CHECK` constraint and `effective_heartbeat_duration_secs` returns whatever it
holds; only `NULL` takes the 600s fallback. And `setInterval` does not honour a
degenerate delay, it shortens it: `0`, a negative number, `NaN`, `Infinity` and
anything past the signed-32-bit ceiling all tick every 1 ms. The result is not
a crash but a silent spin — roughly a thousand `ping-heartbeat` requests a
second, from every machine running that code, each one individually valid and
correctly authenticated, so nothing looks wrong from either end.

`startHeartbeat` now confines `intervalMs` to `[1s, 2147483647ms]`, with a
non-finite value falling back to the floor. `startProcessHeartbeat` takes the
same guard — it wraps the same `setInterval` and spins the same way on an
explicit `0`, even though its 10s default is safe. `startHeartbeatFromPolicy`
now inherits the floor from the primitive rather than applying its own, so
there is one definition of it.

The clamp is a flat floor rather than a guard on only the values `setInterval`
refuses to honour, and that distinction was decided on measurement rather than
taste. The runtime rewrite is not what does the damage — the resulting rate is,
and `setInterval` honours `1` *exactly*: `0` ticks at 1.4 ms and `1` at 1.35 ms,
about 740 pings a second either way (`2` → 2.55 ms, `3` → 3.75 ms, all
honoured). A rule clamping `0` while passing `1` through would give two inputs
with identical observable behaviour opposite treatment, describing where a
number came from rather than what it does.

The cost is one behaviour change: an interval in `1..999` is retimed rather
than honoured, so a caller passing `500` now pings once a second instead of
twice. That cannot break a working consumer's licensing. `heartbeat_duration`
is an integer-**seconds** column, so the shortest window the server can express
is 1 s and a once-a-second ping is inside every policy that exists — the
retiming is invisible in the only dimension this SDK promises anything about.

Nothing legitimate is clamped: the server's heartbeat window is an
integer-seconds column, so a sub-second ping interval is never a real request.
`resolveHeartbeatWindowMs` and `effectiveHeartbeatWindowMs` are deliberately
*not* floored — their job is to report what the server will judge the machine
on, and rounding a misconfigured policy up to something friendlier here would
hide it. Guarding at the scheduler keeps both properties.

Separately documented, because the SDK was recommending a route to the same
bug: `heartbeatWindowMsFromMachine` returns `number | undefined`, and
`undefined` is the *normal* answer for a machine that has not been pinged yet
— every freshly activated one. The composition the docs suggested,
`heartbeatWindowMsFromMachine(m)! / 3`, is therefore `NaN` exactly when a
scheduler is starting up. Every site that recommends it now says to branch on
the `undefined` instead of asserting it away.

No exported declaration changed; the generated `.d.ts` differs only in JSDoc.
