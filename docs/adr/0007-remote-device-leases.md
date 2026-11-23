# ADR 0007: Remote device leases

## Status

Accepted.

## Context

Remote clients need ownership of the selected device before a command reaches a platform runner.
A runner or helper lock protects platform tooling but does not establish remote client ownership.
Hosted devices can continue to incur charges after their daemon stops.

## Decision

A remote device lease gives one client logical ownership of a selected device for a connection provider.
The daemon is authoritative for admission, ownership, and session lifetime.
`connect` establishes client identity and a connection profile. Allocation is lazy, when the device, backend, and provider are known.
`open` is the natural acquisition point.
Runner and process locks remain separate backend guards.

The proxy token authenticates the host, not the client: every client of one proxy can hold the same token.
The lease id is the credential that proves ownership of a leased session.
A request on a session that holds a lease must send that lease's id. The daemon refuses a request that omits it with `LEASE_SESSION_MISMATCH` and never fills it from the session.
Output that a leased request produced keeps that lease as its owner: a downloadable artifact, and a request diagnostics record. A request reads such output only when it sends the lease id, for as long as the daemon keeps the output, also after the lease ends. The daemon refuses another reader with `LEASE_OUTPUT_MISMATCH`. Ownership stays with the output, not with the session, because the output can outlive its session and its lease. Stored output keeps a SHA-256 of the lease id, and diagnostics name a lease by a fingerprint of it, because a served or archived record must not hold a credential.
Tenant, run id, lease backend, client id, device key, and lease provider are scope labels. The daemon checks a label when the request sends it. A label never grants access.
A lease id that a client chooses on allocate needs at least 128 random bits. The daemon returns a lease id only to the caller that allocated the lease.
A daemon that enforces this rule reports the `session-lease-id` capability.

A session binds its admitted lease when it is created. Recording and snapshot can also create a session.
A session that starts without a lease stays unleased for its lifetime.
If an `open` would change a live session's lease, the daemon refuses it with `LEASE_SESSION_MISMATCH` before launch.
Only an `open` with its own active lease can replace an expired session.
After settlement, the daemon resolves the address and device again and checks the successor lease under the new locks.

Lease admission and request execution share the daemon request lock.
Scope resolution may precede the lock. Ownership mutation must not.
Lease expiry revokes admission before teardown.
The sweep and requests use the same daemon job for each expired session lifetime.
A request confirms expiry under the session lock and waits outside execution locks.
A lease end record covers all sessions, any retained execution host, and provider release.
The session job checks the lifetime and claim token under the session and device locks.
It clears the claim after cleanup confirms that the runtime is safe to reuse.
The registry reserves the lease's device scope until session cleanup and provider release are confirmed.
Canceling a request stops its wait while the daemon continues settlement.
An expired owner request returns `LEASE_NOT_FOUND`.
An owner `close` can report a confirmed end once in the outermost response.
When a provider reports an instance ended, the daemon ends the lease and its sessions regardless of provider cleanup outcome.
A cloud provider runtime refuses to allocate a lease that it is ending. It forgets a rented device only after the provider confirmed its stop.
The daemon keeps the lease end reservation when provider creation fails or the caller cancels.
If creation succeeds after cancellation, the provider adapter releases the exact instance.
The daemon owns the reservation. The provider adapter owns instance creation, lookup, and release.

At startup, restore the ending reservations from the rental journal and from the legacy live and pending provider journals. [ADR 0040](0040-daemon-ownership-state-machines.md) defines the rental journal.
Wait for this recovery before you admit an allocation or a session command.
Examine durable device claims under the host-global lock.
Recover only rentals that the provider can attribute to the recorded lease.
If the daemon cannot confirm provider release or clear the exact claim, keep the scope reserved and report `releaseStatus: unknown` with a typed `releaseReason`.
If claim clear fails or the claim has no attributable owner, stop automatic session cleanup retries.
The live session store starts empty.

The registry checks the lease issuance, effective deadline, wanted work, and pending or active holds in the same expiry decision.
Wanted admitted work and human-control holds defer expiry.
Wanted work renews the existing inactivity window when it finishes. Canceled work neither defers expiry past cancellation nor renews it.
Before admission, a client phase such as an artifact upload sends lease heartbeats for as long as it runs.
A heartbeat or request uses the caller's named window, or the lease's existing window when none is named.
The daemon default is one minute. Eligible proxy and cloud provider connections request a shared five-minute window.

Generated connection profiles strip daemon and Metro bearer tokens.
A lease owner may request `retainOnClose` to manage its lifetime across sessions.
Otherwise closing a session ends its lease, and the outermost response reports each ended lease once; clients do not release it again.

Human-control activation fences new mutations and drains admitted mutations before reporting active.
Only host administrators allocate `macos-app` leases; tenants cannot release them.
Requests under such a lease are confined to the leased app, and its session takes that app device's claim ([ADR 0035](0035-macos-app-devices.md)).
Under tenant isolation, a web session's browser key derives from the tenant and tenant-relative public session name, not the prefixed store name ([ADR 0037](0037-web-session-devices.md)).

- A daemon refuses unsupported device-spec keys. The backend echoes the granted device on the lease as `lease.device`. A live proxy lease refuses a later command whose named spec keys differ, with `CONNECTION_DEVICE_CONFLICT`.

The `events` command reads the journal of the admitted session lifetime.
When a request is refused before admission, its diagnostics stay in a separate request record.
A remote reader of a leased request record must present the lease ID that the request presented.
The daemon refuses remote reads of legacy records with no proof of owner.

The detailed contracts are in the [daemon](../../packages/daemon/docs/remote-device-lease-contracts.md), [daemon client](../../packages/daemon-client/docs/remote-device-leases.md), [provider lease table](../../packages/provision-kit/docs/remote-device-leases.md), and [device specification](../../packages/contracts/docs/lease-device-spec.md) documentation.

### Session name visibility

Use the same session visibility rule for `session list`, `doctor`, wait progress, and contention errors.
If a public-network request has no tenant isolation, show only sessions that match its scope and lease proof.
If a request has tenant isolation, show only sessions in its tenant.
If a session has a lease, require that lease's id and check the supplied scope labels before showing the name.
If a local request needs device recovery, it can see an unleased local holder in a different workspace.
If a claim has no live session that holds its exact token, require a stored unleased local designation to name the holder during local device recovery.
If the rule hides a holder, give the caller the public contention reason.
If a claim diagnostic has no session visibility decision, include only public device and contention details.
Before session-derived admission for `doctor`, apply the visibility rule to the session reference.
If `doctor` has no visible session, use detached checks.

## Rationale

- Device-aware ownership makes contention recoverable before platform execution and keeps provider and device identity in scope.
- A single request lock keeps ownership and execution consistent.
- Preserving wanted work prevents an active command or provider allocation from losing its device to inactivity expiry.
- Recovery ends paid rentals while live session admission starts empty.
- One expiry job prevents an owner request and the sweep from performing the same teardown.
- Host-owned app leases keep tenants from choosing their own authority over the desktop.
- A shared proxy token cannot tell one client from another. A session name and tenant can be listed or guessed, so only a random lease id can prove ownership.

## Rejected alternatives

- Use runner locks as client leases: they protect tooling, not remote ownership.
- Restore live leases after daemon death: their sessions and device claims no longer exist.
- Keep a separate provider lease table per provider: repeated lifecycle bookkeeping drifts.
- Tear down expiry inline with a request: the sweep and successor can race the same effects.
- Put the table in contracts: it owns lifecycle mechanics, not wire vocabulary.
- Put the table in capture-kit: renting a device prepares it for execution, which provision-kit owns.
- Silently accept unsupported device specifications: the client could receive a different device than requested.
- Add a separate device-class flag: `--target` already selects the class.
- Fill a missing lease id from the session: any holder of the proxy token could then read, drive, and close a session by its name.
- Give each client its own proxy token: a host in front of the proxy already authenticates each client, and the lease id protects the session without a second credential store.

## Consequences

- Device contention can fail before execution with a device-lease error and ownership expiry.
- Backend-only leases remain valid for older clients; provider-aware clients get device-level contention.
- Holds and ordinary proxy leases are in memory, so controllers reconnect after daemon restart.
- Local human-control takeover remains deferred. A future host-global fence must coexist with local session claims.
- Limrun has not moved its lease ownership onto the shared provider lease table ([#4102](https://github.com/callstack/agent-device/issues/4102)).
- An older client or a direct RPC caller that sent no lease id on a leased session is refused. It must send the lease id that its allocation returned.
- `session_list` still shows session names to every holder of the proxy token ([#4908](https://github.com/callstack/agent-device/issues/4908)).
- A web open can be admitted under a non-`macos-app` lease for another backend; admission does not compare the request platform with the lease backend.
