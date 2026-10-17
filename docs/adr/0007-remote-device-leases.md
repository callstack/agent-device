# ADR 0007: Remote Device Leases

## Status

Accepted

## Rules at a glance

- Allocate device leases lazily, when the device, backend, and provider are known.
- Run lease admission, heartbeat, stored session lease refresh, and request execution under the same daemon request lock.
- Do not mutate lease ownership before the lock. Scope resolution may happen before the lock.
- Generated connection profiles must strip daemon and Metro bearer tokens.
- A session cannot outlive its lease. Lease-end teardown clears the session's device claim even when the device no longer answers.
- Report each lease that a request ended once, at response level. A client never sends a release after such a request.
- Admitted work that is still wanted preserves its lease. If the client hung up, the request neither defers expiry nor renews the lease.
- Before admission, protect long client phases with lease heartbeats. Renew under the window that the caller named, or else under the lease's existing window.
- Before a pending human-control activation reports active, it fences new mutations and drains the mutations already admitted.
- Only host administrators allocate `macos-app` leases. Tenant `lease_release` is refused.
- Confine each request admitted under a `macos-app` lease to the leased app.

## Context

Remote daemon users need a clear ownership boundary before commands reach a platform runner or helper.
Shared proxies and hosted providers need ownership to include the selected device and connection provider, not only tenant/run.

Runner and helper processes already have backend-specific mutual exclusion.
That guard protects platform tooling, not remote client ownership.
Thus, direct exposure of those errors makes device contention harder to recover from.

## Decision

A remote device lease is logical ownership of one selected device by one remote client for a connection provider such as `proxy`, cloud, or `limrun`.

`connect` establishes the connection profile and client identity.
Lease allocation is lazy.
It happens when a device, backend, and provider are known.

A runner/process lease is a backend helper guard.
It is not a user/client ownership boundary.
It stays below daemon device leases and should not be weakened or replaced by them.

`open` is the natural point to acquire a device lease because target resolution and session creation meet there.
Commands after `open` must refresh the lease.
After five minutes without activity, the device should become available again.

These operations must run under the same daemon request lock:

- Lease admission.
- Heartbeat.
- Stored session lease refresh.
- Request execution.

Scope resolution may happen before the lock.
Lease ownership mutation must not happen before the lock.

Generated connection profiles are non-secret.
They may persist routing and lease metadata, but must strip daemon and Metro bearer tokens.
Tokens are supplied in memory for the current command or through environment/CLI token paths.

The proxy process is expected to be long-lived and self-serve.
Recovery from a stale or expired device lease should not require a proxy restart.

A caller that owns the lifetime of a lease, and allocates and releases it itself, can allocate with `retainOnClose`.
Session `close` then leaves that lease and its provider device in place.
Only `leases.release`, expiry, or daemon shutdown ends it.
The default is unchanged, so the CLI's proxy sharing still frees devices on `close`.
The allocated lease reports `retainOnClose: true` only if the daemon honored it.
Only the lease's own client can turn it on for a lease that the run already holds.
An unexpired `retainOnClose` lease keeps an idle daemon alive.
Other leases, including human-control holds, do not.
If the caller stops heartbeats for a retained lease, that lease expires after its `ttlMs`.
Idle reap then shuts the daemon down within one more idle window.

A session cannot outlive the lease under which it was opened.
When the lease is released or expires, the daemon tears the session down under its execution locks and clears its device claim.
This applies even when the device no longer answers.
A release is a tenant `lease_release` or a host `DELETE /admin/leases/<lease-id>`.
The daemon sweeps for expired leases every second.
Thus, expiry does not wait for a later request.
In-flight work and human-control holds still keep a lease from expiring.
After daemon shutdown begins, no new lease-end teardown starts.
Shutdown waits for any lease-end teardown that already started before it tears sessions down itself.

When a request closes a session, the daemon ends the lease of that session, unless the lease was allocated with `retainOnClose`.
The reply to that request reports each lease that it ended once, at response level, as `endedLeases: [{ leaseId, outcome: 'released' }]`.
On success, the report is in `data`.
On failure, the report is in `error.details`, including for a close that failed after the release.
This applies to every request that can close a session:

- `close`.
- A `batch` close step.
- The `close` of a `replay` or `test` script.
- The session cleanup that `test` runs after each script.

Nested requests record on the ledger of the outermost request, so a step reply never repeats the report.
If a close finds its lease already inactive, it reports that lease as ended.
A client never sends a release after such a request.
If a client stores the lease id, it forgets that id when the reply names it.
A gateway that relays the reply reads the lease end from it.

Close and lease-end teardown take the same execution locks.
Thus, whichever runs second finds the session gone.
A close after a lease end has no session and ends no lease.
If a client still stores that lease id, its next heartbeat finds the lease inactive.
The client then allocates a new lease under a fresh id.

## Consequences

Device contention can fail before platform execution with an explicit device-lease error.
That error includes the backend, provider, selected device key, and owning lease expiry.

Backend-only leases remain valid for older remote clients.
Provider-aware clients get device-level contention and clearer recovery.

## Admitted request work

A lease renews when a request is admitted, and never again while that request runs.
Thus, an admitted command slower than the inactivity TTL used to expire the lease that paid for its own device.
The daemon then tore the session down while the client still waited for its result.
Admitted work therefore preserves its lease in the same way as a human-control hold does.
While the request is still wanted, it defers expiry.
If the request finishes while it is still wanted, it renews the lease for its existing inactivity TTL from the moment the work ended.
A request whose client hung up preserves nothing.
It neither defers expiry past that cancellation nor renews the lease when the request finally finishes.
Thus, a handler that ignores its cancellation cannot hold a rented device open.

The inactivity TTL that the client asked for determines which leases this preservation reaches.
The daemon default is one minute.
A cloud WebDriver connection profile asks for ten minutes.
Thus, a single command that runs longer than its own lease is ordinary on the default.
On the longer window, such a command is only reachable through a profile.

## Provider allocation

Allocation is admitted work too.
The registry records a lease before a hosted provider creates the session behind it.
Creation of that session can take longer than the inactivity TTL of the lease.
Thus, a lease timed from its record was already expired, or nearly expired, when its client first received it.
The paid session that the lease pointed at was orphaned.
The allocation therefore holds a work pass while the provider allocates.
The lease cannot expire during that allocation.
If a successful allocation is still wanted by its requester, the inactivity TTL starts from the moment allocation completed.
A requester that hung up preserves nothing, and its allocation is released as before.

## Client-side work that precedes admission

The protection of admitted work covers nothing that happens before a request is admitted.
An artifact install uploads the artifact from the caller before the request that will consume it is admitted.
Thus, an upload slower than the inactivity window of the lease expired the lease that paid for the target device of the bytes (#2946).
The caller therefore sends lease heartbeats over the ordinary transport for as long as that phase runs.
Each heartbeat names the lease scope exactly as the command named it, and carries no payload of its own.
An install names no window, so its heartbeats renew for the window that the lease already carries.
A caller that did name a window continues to renew on that window.

A heartbeat used to resolve an absent window to the registry default instead.
That resolution shortened, without notice, every lease allocated above that default.
That was the other half of the reason that the upload could not survive.
Request admission had its own copy of that mistake.
It named a proxy-specific default for every admitted request.
Thus, a lease allocated longer than the default lost its window on the next command.
Admission also renews on the window of the lease.
The window that a lease carries is the one that its client named when it allocated.

The first heartbeat is sent when the phase starts, not one cadence later.
The reason is that a heartbeat proves that the lease on which the upload spends time is still alive.
Otherwise, a lease shorter than any fixed cadence would lapse before anything renewed it.
A lease that is already gone is caught early, but not before the phase begins.
Hashing, the preflight, and the start of the stream can all run while the first heartbeat is still outstanding.
Thus, the first heartbeat makes sure that the loss is learned during the upload instead of after it.
Each heartbeat answers with the window that it just renewed.
The loop arms the next heartbeat when the current heartbeat starts, not when it settles.
Thus, a heartbeat that never answers is abandoned on schedule and does not stop the schedule.
A phase that settles does not wait for a heartbeat still in flight.

Cadence and budget are deliberately two numbers.
A heartbeat is armed every third of the window, but it is allowed the whole window to answer.
If the budget were equal to the cadence, a heartbeat that needs more than a third of a window for its round trip could never answer.
Examples are a tunneled proxy and an uplink that the upload itself saturates.
Every heartbeat would then time out again on exactly the slow links that the heartbeat exists to protect.
The window, not the cadence, is the interval in which liveness still matters.
Thus, the window is also the longest time that an answer to a heartbeat is worth a wait.

That ceiling is the shorter of the window and the heartbeat's own request policy, currently ninety seconds.
Thus, a ten-minute lease gives a heartbeat ninety seconds instead of the full window.
This limit costs nothing that the heartbeat exists to provide.
The daemon renews the lease when it handles the request, before it answers.
Thus, a round trip abandoned at the cap has still extended the lease if the request ever arrived.
If the request never arrived, the transport has stopped carrying traffic.
A socket held open for the rest of a window measured in minutes does not help that transport.
The cap refuses exactly that idle hold.
The cap binds only on windows longer than the policy.
On those windows, the heartbeat already has the longest answer deadline that any lease gets.
Shorter windows are bounded by their own window, as above.

A heartbeat is a fresh request each time, never the protected request rewritten.
The reason is that a timed-out heartbeat is canceled under its request identity, and heartbeats must not inherit each other's cancellation.
In these cases, a heartbeat ends the phase with that error and cancels the upload:

- The heartbeat finds that the lease is gone.
- The heartbeat finds that this request can never renew the lease.
  This is so if the scope is missing or belongs to another lease.
  This is also so if the daemon rejects the scope and window that the heartbeat itself was built with, which no later heartbeat will ask differently.

Thus, the upload does not finish bytes against a device that nobody owns or a lease that will stop renewing.
A heartbeat that fails for any other reason is reported, and the phase continues.
The reason is that a later heartbeat covers one lost request.
This includes a request abandoned at its budget instead of answered.
Thus, that promise holds for a stalled round trip, not only for a round trip that fails fast.

## Human control

Human-control holds coexist with an open remote session.
They belong to `LeaseRegistry`.
They use the same backend/provider/device contention key as device-aware leases.
Hold heartbeat, expiry, lease preservation, and release refresh are one registry-owned lifecycle.
Release or expiry of the last hold gives the lease its existing inactivity TTL again.
Expiry uses the hold's expiry instant.

Tenant hold operations are ordinary daemon RPCs admitted through `request-admission.ts`.
Their device comes only from the admitted lease.
Host administration is a distinct loopback capability authenticated with the daemon token, never a tenant credential.
Tenants cannot modify host holds.

Mutation admission derives from existing recording effects, observation-class inventory, and observability semantics.
Takeover and lease heartbeats are exempt from the mutation fence, not from their ownership checks.
Unknown effects are treated as mutations.
A pending activation fences new mutations and drains the mutations already admitted before it reports active.
Advisory execution locks alone do not establish this guarantee for fresh sessions.

Activation follows the cancellation signal of the calling RPC or host HTTP request.
A disconnect during the drain removes only the pending hold of that request.
Successor and unrelated holds remain intact.
A canceled activation does not cancel the mutations under drain.
Completed holds use their TTL or explicit release lifecycle.

Holds and ordinary proxy leases are in-memory and do not survive daemon restart.
Controllers must reconnect and establish them again.
No persisted hold store is used.
Local takeover is deferred.
A future host-global human-control fence must coexist with the device claim of the local session, not acquire it exclusively.

## macOS app leases

A lease on the macOS host would rent the whole desktop.
Thus, the macOS platform rents one app instead.
The device key of a `macos-app` lease is a bundle id, optionally pinned to one process (`<bundleId>` or `<bundleId>@<pid>`).
If a tenant could name the scope, the scope would be self-chosen.
Thus, only a host administrator allocates a `macos-app` lease, over the loopback `/admin/leases` route that uses the daemon token like host holds.
Tenant `lease_allocate` refuses the backend.
The host picks the lease id.
A repeated PUT renews the lease.
A PUT that names another scope for an existing id is refused, not rewritten.

Heartbeat, expiry, and the loss on daemon restart are those of any lease, with two exceptions:

- A tenant heartbeat or request cannot renew the lease for longer than the window of the host's last PUT.
- A tenant cannot release the lease. `lease_release` is refused with `MACOS_APP_LEASE_HOST_OWNED`.

The lease ends through one of these:

- The host's `DELETE /admin/leases/<lease-id>`.
- Expiry.
- The loss on daemon restart.
- The close of a session that the lease holds, if the host set `retainOnClose` to false.

Request admission confines every request admitted under the lease.
Thus, `batch` steps and `replay` actions are confined when they enter admission again.
The confinement has these parts:

- An allow list of commands: the commands whose command registry descriptor declares `appLease: 'allowed'`.
  A command without that declaration is refused, including a command that is added later.
  Of the commands that lease admission otherwise exempts, only `lease_heartbeat` and `lease_release` declare it.
- `open` and `close` of the leased bundle only.
- The `app` surface only.
- Window-only screenshots.
- No input that names a host path or launches beside the app.
- For every request except `open` and the `batch` envelope, an existing session that is the leased app.

Thus, a request that names no session cannot fall back to the host Mac.
`open` requires the native app backend (ADR 0031), because XCTest posts screen events that can land outside the app's window.
Before each admitted request, a pid-pinned lease is checked against the running process.
A session opened under the lease holds its app, not the Mac.
It takes no host device claim.
Other app-leased sessions on the same Mac do not conflict with it.
Thus, one daemon serves several leased apps beside the host's own sessions.

These rules bind a request that names the lease or runs in its session.
A daemon policy `leases.require` (ADR 0029) refuses requests that name no lease.
The proxy token is one credential for every client.
Thus, a host that serves several clients through one proxy authenticates each client.
The host sets the tenant, session isolation, and lease of that client on every request that it forwards.
