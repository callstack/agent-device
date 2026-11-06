# Remote device lease contracts

These contracts supplement [ADR 0007](../../../docs/adr/0007-remote-device-leases.md).

## Lease lifecycle

A caller that owns the lifetime of a lease, and allocates and releases it itself, can allocate with `retainOnClose`.
Session `close` then leaves that lease and its provider device in place.
Only `leases.release`, expiry, a provider-reported instance end, or daemon shutdown ends it.
The default is unchanged, so the CLI's proxy sharing still frees devices on `close`.
The allocated lease reports `retainOnClose: true` only if the daemon honored it.
Only the lease's own client can turn it on for a lease that the run already holds.
An unexpired `retainOnClose` lease keeps an idle daemon alive.
Other leases, including human-control holds, do not.
If the caller stops heartbeats for a retained lease, that lease expires after its `ttlMs`.
Idle reap then shuts the daemon down within one more idle window.

A session cannot outlive the lease under which it was opened.
When the lease is released, expires, or its provider reports the instance ended, the daemon tears the session down under its execution locks and clears its device claim.
Any teardown of a leased session, including `close`, finishes an active recording. A finished export at a remote temp path then belongs to the lease's tenant as a downloadable artifact, like the artifact of any `record stop` (ADR 0024 2.5).
This applies even when the device no longer answers.
A release is a tenant `lease_release` or a host `DELETE /admin/leases/<lease-id>`.
The daemon sweeps for expired leases every second.
Thus, expiry does not wait for a later request.
In-flight work and human-control holds still keep a lease from expiring.
After daemon shutdown begins, no new lease-end teardown starts.
Shutdown waits for any lease-end teardown that already started before it tears sessions down itself.

A daemon that dies while it holds a provider lease leaves the rented device running on the provider side, and that device stays billed.
Thus, the daemon journals the live leases of each provider that can recover an expired lease, in `live-provider-leases.json` in its state directory.
A daemon that starts and finds this journal hands each lease in it to the expired-lease recovery of its provider, which ends the rented device.
It reads both lease records only after it holds the daemon registration for the state directory, because until then they can belong to a daemon that is still running.
The lease itself is not restored, and its controller connects again.
A lease that leaves the registry for expiry stays in the journal until its expired-lease record is durable, and a journal write that fails is retried until this daemon shuts down.
If a journal retry is pending, daemon shutdown makes one final journal write. It does not schedule another journal retry.
A daemon that has shut down writes lease records only synchronously. It arms no timer for them, because a timer could fire after that daemon released its registration, when the records belong to the next daemon.
After the daemon shuts its lease releaser down, that releaser refuses every further provider-backed release. It still writes the expired-lease record of a recoverable lease, so the next daemon inherits it. If no record names the lease, the daemon logs the refusal with its lease provider, because no daemon will end that device.
Two routes still let the registry forget a provider lease while its device may be rented. The journal and expiry recovery both follow the registry, so neither covers it, and only the provider runtime still holding the device can end it:

- A failed first allocation releases the registry entry without a provider release, while its provider start may still run.
- An allocation that finishes after its requester left releases the registry entry even when the provider release throws.

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
The proxy is expected to be long-lived and self-serve.
Recovery from a stale or expired device lease should not require a proxy restart.

## Admitted request work

A lease renews when a request is admitted, and never again while that request runs.
Admitted work preserves its lease in the same way as a human-control hold does.
While the request is still wanted, it defers expiry.
If the request finishes while it is still wanted, it renews the lease for its existing inactivity TTL from the moment the work ended.
A request whose client hung up preserves nothing.
It neither defers expiry past that cancellation nor renews the lease when the request finally finishes.
Thus, a handler that ignores its cancellation cannot hold a rented device open.

The inactivity TTL that the client asked for determines which leases this preservation reaches.
The daemon default is one minute.
For lease-using commands, proxy connections and providers that declare `holdsCloudDevice` or `usesCloudWebDriverLease` request the shared five-minute window.
Other providers and host-allocated `macos-app` leases use no profile TTL.
Admission and heartbeats renew the existing window when no window is named.

## Provider allocation

Allocation is admitted work too.
The registry records a lease before a hosted provider creates the session behind it.
Creation of that session can take longer than the inactivity TTL of the lease.
The allocation holds a work pass while the provider allocates, so its lease does not expire before delivery.
The lease cannot expire during that allocation.
If a successful allocation is still wanted by its requester, the inactivity TTL starts from the moment allocation completed.
A requester that hung up preserves nothing, and its allocation is released as before.

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
A session opened under the lease binds the app device of the leased bundle, not the Mac (ADR 0035).
It takes that app device's claim, like any other session.
Sessions on other apps of the Mac do not conflict with it, in this daemon or another.
A session on the same app, or on the whole Mac, conflicts with it.
A tenant sees that conflict as a generic `DEVICE_IN_USE` with its typed reason, never the other owner's session, workspace, state directory, or recovery command.
Thus, one daemon serves several leased apps beside the host's own app sessions.

These rules bind a request that names the lease or runs in its session.
A daemon policy `leases.require` (ADR 0029) refuses requests that name no lease.
The proxy token is one credential for every client.
Thus, a host that serves several clients through one proxy authenticates each client.
The host sets the tenant, session isolation, and lease of that client on every request that it forwards.

## Web sessions under tenant isolation

Under tenant isolation the session store prefixes every session name with `<tenant>:`, but the public name stays tenant-relative.
A web session's backend key is derived from that public name and the tenant id (`t_<hash12>_<name>`, ADR 0037), never from the store name.
Thus two tenants that use one web session name hold two devices and two browsers, and one tenant using one name twice conflicts like any session on one device.
A web open is admitted under a lease of any backend other than `macos-app`, because admission never compares the request's platform with the lease backend.
That predates this boundary and is an open question.
