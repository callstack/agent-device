# Remote device lease contracts

These contracts supplement [ADR 0007](../../../docs/adr/0007-remote-device-leases.md).

## Lease lifecycle

A caller that owns the lifetime of a lease, and allocates and releases it itself, can allocate with `retainOnClose`.
Session `close` then leaves that lease and its provider device in place.
Only `leases.release`, expiry, a provider-reported instance end, or daemon shutdown ends it.
The default is unchanged, so the CLI's proxy sharing still frees devices on `close`.
The allocated lease reports `retainOnClose: true` only if the daemon honored it.
Only a refresh that sends the lease id turns it on for a lease that is already live.
An unexpired `retainOnClose` lease keeps an idle daemon alive.
Other leases, including human-control holds, do not.
If the caller stops heartbeats for a retained lease, that lease expires after its `ttlMs`.
Idle reap then shuts the daemon down within one more idle window.

A session cannot outlive the lease it binds at creation.
When the lease is released, expires, or its provider reports that the instance ended, the daemon tears the session down.
The daemon keeps the device claim until teardown confirms that the runtime is safe to reuse.
Any teardown of a leased session, including `close`, finishes an active recording. A daemon-owned export stays downloadable under its producing owner, as with `record stop` (ADR 0024 2.5).
This applies even when the device no longer answers.
A release is a tenant `lease_release` or a host `DELETE /admin/leases/<lease-id>`.
The daemon sweeps for expired leases every second.
A request can also trigger expiry.
Both paths share one teardown for each expired session.
The daemon keeps the lease reservation until session cleanup and any provider release are confirmed.
If the daemon cannot confirm release, an overlapping allocation returns `DEVICE_LEASE_BUSY` with
`releaseStatus: "unknown"` and a typed `releaseReason`.
If the daemon cannot clear the exact device claim, it keeps the scope reserved and stops automatic session cleanup retries.
If expiry wins, the old owner's request returns `LEASE_NOT_FOUND`.
An owner `close` can report the confirmed lease end in `endedLeases` on that error.
Only `open` with a separate valid lease can replace an expired session.
It waits within the request deadline and the `--wait` budget, if set.
The successor lease must still be valid when the wait ends.
If cleanup remains pending, `open` can return `DEVICE_IN_USE` with reason `DEVICE_LEASE_BUSY`.
Canceling a waiting request leaves teardown running.
In-flight work and human-control holds still keep a lease from expiring.
After daemon shutdown begins, no new lease-end teardown starts.
Shutdown waits for any lease-end teardown that already started before it tears sessions down itself.

A provider rental can keep billing after the daemon exits.
Before provider allocation, the daemon writes the contention scope to `provider-rentals.json` in the daemon state directory.
The journal keeps a lease fingerprint, any provider reconciliation key, and the exact instance ID when the provider supplies it.
The daemon reads the rental journal and the legacy live and pending journals after it holds daemon registration.
Allocation, session commands, and host lease PUT wait for startup recovery to restore the reservations.
A provider can settle an inherited rental by confirming release or proving absence.
Revyl uses a fresh session ID for each journaled create, even if a later lease reuses the public lease ID.
Revyl keeps the lease fenced if a stop reports absence before the provider confirms the instance.
If journal retirement fails after confirmed release, the daemon keeps the reservation and retries retirement.
An empty lookup can race a create and leave the reservation as `releaseStatus: unknown`.
Use the journal and daemon diagnostics to identify a rental for provider-side reconciliation.
The live session store starts empty. The controller must connect again.
A failed or canceled first allocation keeps its reservation while the provider can still be creating or releasing the device.
If creation succeeds after cancellation, the adapter releases the exact instance.

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
If expiry wins, an owner close can report the confirmed lease end once in its refusal.
A client never sends a release after such a request.
If a client stores the lease id, it forgets that id when the reply names it.
The CLI keeps the id of an ended proxy lease apart, and sends it only on `artifacts` while the connection holds no lease.
A gateway that relays the reply reads the lease end from it.

Close and lease-end teardown take the same execution locks.
Thus, whichever runs second finds the session gone.
A close after a lease end has no session and ends no lease.
If a client still stores that lease id, its next heartbeat finds the lease inactive.
The client then allocates a new lease under a fresh id.
The proxy is expected to be long-lived and self-serve.
Recovery from a stale or expired device lease should not require a proxy restart.

## Lease ownership

The proxy token is one credential for every client.
Thus, a host that serves several clients through one proxy authenticates each client.
The host sets the tenant, session isolation, and lease of that client on every request that it forwards.
The lease id proves which client owns a leased session.
A request on that session, including `close`, `artifacts`, and other admission-exempt commands, must send the lease id.
Lease heartbeat and release name the lease id too.
If a request omits the lease id, the daemon refuses it with `UNAUTHORIZED`, reason `LEASE_SESSION_MISMATCH`, and `field: 'leaseId'`.
The daemon never fills a missing lease id from the session.
When a command creates a session, it binds the admitted lease or creates an unleased session.
This also applies to recording-only and snapshot-only sessions.
To use a different lease, close the session with its current credentials and then open it under the new lease.
If you try to change the lease of a live session with `open`, the daemon returns `LEASE_SESSION_MISMATCH` before launch.
The daemon checks the lease id before the request reads, changes, or ends the session.
The request writes events only to the journal of the session lifetime it acts through.
If a request is refused before admission, its diagnostics go to a separate request record.
An expired `batch` refused with `LEASE_NOT_FOUND` also gets a separate request record.
To read a refused request's record remotely, use the locator in the error and send the lease ID that the request presented, if it presented one.
If a lock-exempt command can take the session lock immediately, it can refresh the recording for the session lifetime it was admitted to use.
A `test` suite reads, records, and closes an attempt session only with the lease id that the suite sent.
The sweep and an authorized request share the daemon's expiry job.
A request that needs settlement waits outside execution locks.
A bounded step that needs settlement returns a step failure and unwinds.
An expired owner request receives `LEASE_NOT_FOUND`.
Only `open` with a separate valid lease can replace the expired session after settlement.
The daemon checks that lease again before it starts work.
Tenant, run id, lease backend, client id, device key, and lease provider are labels.
The daemon refuses a label that differs from the session lease. A missing label is not a refusal and grants nothing.
The daemon compares each value that a request sends for a label: the value in `meta`, the value in `flags`, and each alias of a param.
The daemon compares the canonical form of a value. A value that is not a string differs from the lease.
A request that the daemon builds for a batch or replay step carries each value that the outer request sent.
When an auth hook attests the tenant, the attested tenant routes the request. The daemon also compares the tenant that the caller declared with the lease.
An allocate that repeats the labels of a live lease without that lease's id is refused as contention, with `DEVICE_IN_USE` and reason `DEVICE_LEASE_BUSY`. It returns no lease id. If the live lease has no device key, a label that contradicts it stays a scope mismatch, with `UNAUTHORIZED` and reason `LEASE_SCOPE_MISMATCH`. A repeat of a live lease with a device key is `DEVICE_LEASE_BUSY` whatever its client id says. Only an allocate that sends the id of its live lease gets that lease back.
A caller-chosen lease id on allocate must have at least 32 hex digits (128 bits). A shorter id fails with reason `LEASE_ID_TOO_SHORT`.
Commands that ignore the session lease, such as `devices`, `session_list`, and the lease RPCs, keep their own scope.
On a leased session, these commands do not bind the session, refresh its recording, deliver its script, renew its lease, end it, or write request events to it.

Output of a request that acted under a lease belongs to that lease.
This applies to a downloadable artifact and to a request diagnostics record.
The daemon gives such output only to a request that sends the lease id.
The `artifacts` RPC reads the lease id from the request. `GET /artifacts`, `GET /artifacts/<id>`, and the diagnostics route read the `x-agent-device-lease-id` header, which the proxy forwards.
This rule applies for as long as the daemon keeps the output, also after the lease ends. The lifetime of the output does not change.
An inventory omits an artifact of another lease.
A download or a diagnostics read without the lease id fails with `UNAUTHORIZED`, reason `LEASE_OUTPUT_MISMATCH`, and `field: 'leaseId'`.
A downloadable screenshot or xctrace result has its own daemon-owned path. A write to the caller's destination does not change an earlier download.
The daemon names each request diagnostics record. The name carries the owner of the record: the lease id that the request sent, or that it sent none.
The request id of the caller names no record. A nested request uses the parent's record only when both requests send the same lease id or both send no lease id.
A caller that sent a lease id reads only its own records, also the record of a request that a leased session refused.
The daemon stores routed records in the session's `request-records` directory.
Before session routing, the daemon uses the tenant's request diagnostics directory.
The diagnostics route serves legacy records only from the host-verified directory.
A recording manifest keeps the lease that started the recording, or that no lease started it.
`record stop` returns a completed export to a request that sends that lease id, also after the lease ended. Such a request needs no active lease.
A recording that still runs needs a request that is admitted under that lease.
`record stop` does not return a completed remote export whose manifest names neither.
The daemon keeps an owner as the SHA-256 of the lease id, never as the id.
A request diagnostics record names a lease by the first 8 hex digits of that SHA-256, never by the lease id.
An event that the daemon writes outside a request goes to the daemon log, which only the host operator reads. It names the lease id, because the operator needs it to end a rented device.
Output of a request that acted under no lease keeps the tenant rule.

Before you restore access to a legacy diagnostics record, verify its full contents came from unleased requests and contain no lease credentials. Move the file from the session's `requests` directory to its `requests-unleased` directory. Keep its filename.
Before you restore access to a legacy recording in the daemon session directory, verify that the producing request was unleased. The daemon refuses replay from legacy remote temp paths. Set `metadata.remoteCaptureLease` to `"unleased"` in its recording manifest.

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
If a successful allocation is still wanted by its requester, the inactivity TTL starts from the moment allocation completed.
Cancellation ends the allocation work pass. The lease reservation still protects the device until release is confirmed.

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
The daemon keeps the diagnostics record on the host. The reply omits its path and locator.
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

## Web sessions under tenant isolation

Under tenant isolation the session store prefixes every session name with `<tenant>:`, but the public name stays tenant-relative.
A web session's backend key is derived from that public name and the tenant id (`t_<hash12>_<name>`, ADR 0037), never from the store name.
Thus two tenants that use one web session name hold two devices and two browsers, and one tenant using one name twice conflicts like any session on one device.
A web open is admitted under a lease of any backend other than `macos-app`, because admission never compares the request's platform with the lease backend.
That predates this boundary and is an open question.
