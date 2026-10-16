# ADR 0007: Remote Device Leases

## Status

Accepted

## Rules at a glance

- Allocate device leases lazily after device, backend, and provider resolution.
- Keep lease mutation and request execution under the same daemon request lock.
- Generated connection profiles must strip daemon and Metro bearer tokens.
- A session cannot outlive its lease. Teardown clears its device claim even if the device does not answer.
- Report request-ended leases once on the outermost response. Clients must not release them again.
- Wanted admitted work preserves its lease. Canceled work neither defers expiry nor renews it.
- Before admission, protect long client phases with lease heartbeats under the lease's existing window.
- Human-control holds fence mutations through registry-owned admission and drain behavior.
- Only host administrators allocate and release `macos-app` leases. Confine each admitted request to the leased app.

## Context

Remote daemon users need a clear ownership boundary before commands reach a platform runner or helper.
Shared proxies and hosted providers need ownership to include the selected device and connection provider, in addition to tenant/run.

Runner and helper processes already have backend-specific mutual exclusion.
This guard protects platform tools, not remote client ownership.
Direct exposure of those errors makes device contention harder to resolve.

## Decision

A remote device lease is logical ownership of one selected device by one remote client for a connection provider.
Examples include `proxy`, cloud, and `limrun`.

`connect` establishes the connection profile and client identity.
Lease allocation is lazy.
It occurs after device, backend, and provider resolution.

A runner/process lease guards a backend helper.
It does not define user/client ownership.
It remains below daemon device leases and should not be weakened or replaced by them.

`open` is the natural place to acquire a device lease because target resolution and session creation meet there.
After `open`, commands must refresh the lease.
After five minutes without activity, the device should become available again.

These operations must use the same daemon request lock:

- Lease admission.
- Heartbeat.
- Stored session lease refresh.
- Request execution.

Scope resolution may occur before the lock.
Lease ownership mutation must not.

Generated connection profiles are non-secret.
They may persist route and lease metadata, but must strip daemon and Metro bearer tokens.
Tokens are supplied in memory for the current command or through environment/CLI token paths.

The proxy process is expected to remain active for self-service use.
Recovery from stale or expired device leases should not require a proxy restart.

A caller that allocates and releases a lease itself can allocate with `retainOnClose`.
Session `close` then retains that lease and its provider device.
Only `leases.release`, expiry, or daemon shutdown ends it.
The default remains unchanged, so CLI proxy sharing still frees devices on `close`.
The allocated lease reports `retainOnClose: true` only if the daemon honored it.
Only the lease's own client can enable it for a lease already held by the run.
An unexpired `retainOnClose` lease keeps an idle daemon alive.
Other leases, including human-control holds, do not.
If the caller stops heartbeats, a retained lease expires after its `ttlMs`.
Idle reap then stops the daemon within one more idle window.

A session cannot outlive the lease under which it opened.
On release or expiry, the daemon tears the session down under its execution locks and clears its device claim.
This applies even when the device no longer answers.
Release can use tenant `lease_release` or host `DELETE /admin/leases/<lease-id>`.
The daemon examines expired leases every second.
Thus, expiry does not require a later request.
In-flight work and human-control holds still prevent lease expiry.
After daemon shutdown starts, no new lease-end teardown starts.
Shutdown waits for already-started teardown before it tears sessions down itself.

When a request closes a session, the daemon ends its lease unless it was allocated with `retainOnClose`.
The response reports each lease ended by that request once, at response level:
`endedLeases: [{ leaseId, outcome: 'released' }]`.
Success reports it in `data`.
Failure reports it in `error.details`, including when close fails after release.
This applies to every request that can close a session:

- `close`.
- A `batch` close step.
- `close` in a `replay` or `test` script.
- Session cleanup after each `test` script.

Nested requests record on the outermost request's ledger.
Step replies never repeat that record.
If close finds its lease already inactive, it reports the lease as ended.
A client never sends a release after such a request.
If a client stores the lease id, it forgets that id when the reply names it.
A gateway that relays the reply reads the lease end from it.

Close and lease-end teardown use the same execution locks.
Whichever runs second finds the session gone.
Thus, close after lease end has no session and ends no lease.
If a client still stores the id, its next heartbeat finds an inactive lease.
It allocates a new lease with a fresh id.

## Consequences

Device contention can fail before platform execution with an explicit device-lease error.
The error includes backend, provider, selected device key, and owning lease expiry.

Backend-only leases remain valid for older remote clients.
Provider-aware clients receive device-level contention and clearer recovery.

## Admitted request work

Admission renews a lease once.
The request does not renew it again during execution.
Without preservation, a command longer than its inactivity TTL could expire its own device lease and lose its session before response.
Admitted work therefore preserves its lease like a human-control hold.
While the request remains wanted, it defers expiry.
If work finishes while still wanted, it renews the existing inactivity TTL from completion time.
After client disconnect, the request preserves nothing.
It neither defers expiry beyond cancellation nor renews the lease when work eventually finishes.
Thus, a handler that ignores cancellation cannot retain a rented device.

The client's requested inactivity TTL determines which commands need preservation.
The daemon default is one minute.
A cloud WebDriver connection profile requests ten minutes.
A single command longer than its lease is therefore ordinary with the default.
The longer window requires a profile.

## Provider allocation

Allocation is also admitted work.
The registry records a lease before a hosted provider creates its session.
Session creation can exceed the lease's inactivity TTL.
Without preservation, the client could receive an expired or nearly expired lease and leave a paid session orphaned.
Allocation therefore holds a work pass while the provider allocates.
The lease cannot expire during that work.
If successful allocation remains wanted, the inactivity TTL starts at completion.
A disconnected requester preserves nothing, and its allocation is released as before.

## Client-side work that precedes admission

Admitted-work preservation does not cover earlier client work.
Artifact install uploads bytes before admission of the request that consumes them.
Without client protection, an upload longer than the inactivity window could expire the device lease (#2946).
The caller therefore sends lease heartbeats over the ordinary transport throughout that phase.
It names exactly the command's lease scope and supplies no payload of its own.
An install specifies no window, so its heartbeats renew the lease's existing window.
If a caller specifies a window, it continues to renew that window.

Resolving an absent window to the registry default would shorten every lease allocated above that default.
Admission previously had the same defect through a proxy-specific default on each request.
Admission therefore also renews the existing lease window.
The lease retains the window named by its client at allocation.

The first heartbeat starts with the phase, without a cadence delay.
It proves that the lease used by the upload remains alive.
Otherwise, a lease shorter than a fixed cadence could expire before renewal.
An already-lost lease is detected early, but not before phase start.
Hashing, preflight, and initial stream work can run while the first heartbeat remains outstanding.
Thus, loss becomes known during upload instead of afterward.
Each heartbeat reports the window it renewed.
The loop schedules its successor when the heartbeat starts, not when it completes.
A heartbeat without an answer is therefore abandoned on schedule without stopping the schedule.
A completed phase does not wait for an in-flight heartbeat.

Cadence and budget intentionally differ.
A heartbeat starts every third of the window but may use the whole window for its answer.
A cadence-sized budget would always reject round trips longer than one third of the window.
This includes tunneled proxies and uplinks saturated by the upload.
Those slow links are exactly where heartbeat protection is needed.
The window defines how long continued liveness matters.
It therefore also defines the maximum useful wait for an answer.

The actual ceiling is the shorter of the window and the heartbeat's request policy, currently ninety seconds.
Thus, a ten-minute lease permits a ninety-second answer budget.
The daemon renews the lease when it handles the request, before its answer.
A round trip abandoned at the cap has still extended the lease if the request reached the daemon.
If it never arrived, retaining a socket for the rest of a multi-minute window does not restore transport.
The cap refuses that idle wait.
It applies only to windows longer than the policy.
Those heartbeats already receive the longest answer deadline available to a lease.
Shorter windows use their own window as the bound.

Each heartbeat is a fresh request, never a rewritten protected request.
Request identity controls cancellation of a timed-out heartbeat.
Heartbeats must not inherit each other's cancellation.
A heartbeat ends the phase with its error and cancels upload if it finds:

- A lost lease.
- A missing scope.
- A scope owned by another lease.
- A daemon refusal of the heartbeat's own scope and window that an identical successor cannot correct.

This prevents completed uploads for unowned devices or leases that cannot renew.
Any other heartbeat failure is reported without stopping the phase.
A later heartbeat can recover from one lost request.
This includes a request abandoned at its budget, so recovery applies to stalled round trips as well as immediate failures.

## Human control

Human-control holds coexist with an open remote session.
`LeaseRegistry` owns them.
They use the same backend/provider/device contention key as device-aware leases.
The registry owns one lifecycle for hold heartbeat, expiry, lease preservation, and release refresh.
Release or expiry of the last hold restores the lease's existing inactivity TTL.
For expiry, renewal uses the hold's expiry instant.

Tenant hold operations are ordinary daemon RPCs admitted through `request-admission.ts`.
Only the admitted lease supplies their device.
Host administration is a distinct loopback capability authenticated with the daemon token, never a tenant credential.
Tenants cannot modify host holds.

Mutation admission derives from existing recording effects, observation-class inventory, and observability semantics.
Takeover and lease heartbeats are exempt from the mutation fence, but retain ownership checks.
Unknown effects are mutations.
A pending activation fences new mutations.
Before it reports active, it drains mutations already admitted.
Advisory execution locks alone do not establish this guarantee for fresh sessions.

Activation follows the calling RPC or host HTTP request's cancellation signal.
If disconnect occurs during drain, only that request's pending hold is removed.
Successor and unrelated holds remain intact.
Canceled activation does not cancel mutations under drain.
Completed holds use their TTL or explicit release lifecycle.

Holds and ordinary proxy leases remain in memory and do not survive daemon restart.
Controllers must reconnect and establish them again.
No persisted hold store exists.
Local takeover is deferred.
A future host-global human-control fence must coexist with the local session's device claim instead of acquiring it exclusively.

## macOS app leases

A lease on the macOS host would rent the whole desktop.
The macOS platform therefore rents one app instead.
A `macos-app` lease uses a bundle id as its device key, optionally pinned to one process: `<bundleId>` or `<bundleId>@<pid>`.
If tenants could name this scope, they would choose their own confinement.
Thus, only a host administrator allocates these leases through loopback `/admin/leases` with the daemon token, as for host holds.
Tenant `lease_allocate` refuses this backend.
The host selects the lease id.
A repeated PUT renews it.
If a PUT names another scope for an existing id, it is refused instead of changing scope.

Heartbeat, expiry, and restart loss follow ordinary lease behavior, with two exceptions:

- A tenant heartbeat or request cannot renew beyond the window of the host's last PUT.
- A tenant cannot release the lease. `lease_release` returns `MACOS_APP_LEASE_HOST_OWNED`.

The lease ends through:

- Host `DELETE /admin/leases/<lease-id>`.
- Expiry.
- Daemon restart.
- Close of a session it holds, if the host set `retainOnClose` to false.

Request admission confines every admitted request under the lease.
This includes `batch` steps and `replay` actions when they enter admission again.
Confinement requires:

- Commands whose registry descriptor declares `appLease: 'allowed'`.
  Later commands are refused.
  Among commands otherwise exempt from lease admission, only `lease_heartbeat` and `lease_release` declare it.
- `open` and `close` limited to the leased bundle.
- Only the `app` surface.
- Only window screenshots.
- No input that names a host path or launches beside the app.
- An existing session for the leased app on every request except `open` and the `batch` envelope.

Thus, a request without a session cannot fall back to the host Mac.
`open` requires the native app backend from ADR 0031.
XCTest posts screen events that can reach outside the app window.
Before each admitted request, a pid-pinned lease is verified against the running process.
A session under the lease holds its app, not the Mac.
It takes no host device claim.
Other app-leased sessions on the same Mac do not conflict with it.
Thus, one daemon serves several leased apps beside the host's own sessions.

These rules bind a request that names the lease or runs in its session.
Daemon policy `leases.require` in ADR 0029 refuses requests without a lease.
The proxy token is one credential shared by every client.
A host that serves several clients through one proxy therefore authenticates each client.
It sets tenant, session isolation, and lease on every forwarded request.
