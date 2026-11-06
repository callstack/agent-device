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

Lease admission, heartbeats, stored session lease refresh, and request execution share the daemon request lock.
Scope resolution may precede the lock. Ownership mutation must not.
A session cannot outlive its lease: lease end tears down its sessions and clears their device claims, even when the device no longer answers.
When a provider reports an instance ended, the daemon ends the lease and its sessions regardless of provider cleanup outcome.
A cloud provider runtime refuses to allocate a lease that it is ending. It forgets a rented device only after the provider confirmed its stop.
Recoverable provider leases are journaled so a later daemon can end rentals left by a dead daemon. Sessions and claims are not restored.

Wanted admitted work and human-control holds defer expiry.
Wanted work renews the existing inactivity window when it finishes. Canceled work neither defers expiry past cancellation nor renews it.
Before admission, a client phase such as an artifact upload sends lease heartbeats for as long as it runs.
A heartbeat or request uses the caller's named window, or the lease's existing window when none is named.
The daemon default is one minute. Remote connection profiles use a shared five-minute window.

Generated connection profiles strip daemon and Metro bearer tokens.
A lease owner may request `retainOnClose` to manage its lifetime across sessions.
Otherwise closing a session ends its lease, and the outermost response reports each ended lease once; clients do not release it again.

Human-control activation fences new mutations and drains admitted mutations before reporting active.
Only host administrators allocate `macos-app` leases; tenants cannot release them.
Requests under such a lease are confined to the leased app, and its session takes that app device's claim ([ADR 0035](0035-macos-app-devices.md)).
Under tenant isolation, a web session's browser key derives from the tenant and tenant-relative public session name, not the prefixed store name ([ADR 0037](0037-web-session-devices.md)).

The detailed contracts are in the [daemon](../../packages/daemon/docs/remote-device-lease-contracts.md), [daemon client](../../packages/daemon-client/docs/remote-device-leases.md), [provider lease table](../../packages/provision-kit/docs/remote-device-leases.md), and [device specification](../../packages/contracts/docs/lease-device-spec.md) documentation.

## Rationale

- Device-aware ownership makes contention recoverable before platform execution and keeps provider and device identity in scope.
- A single request lock keeps ownership and execution consistent.
- Preserving wanted work prevents an active command or provider allocation from losing its device to inactivity expiry.
- Recovery ends paid rentals without reviving claims and sessions that died with the daemon.
- Host-owned app leases keep tenants from choosing their own authority over the desktop.

## Rejected alternatives

- Use runner locks as client leases: they protect tooling, not remote ownership.
- Restore live leases after daemon death: their sessions and device claims no longer exist.
- Keep a separate provider lease table per provider: repeated lifecycle bookkeeping drifts.
- Put the table in contracts: it owns lifecycle mechanics, not wire vocabulary.
- Put the table in capture-kit: renting a device prepares it for execution, which provision-kit owns.
- Silently accept unsupported device specifications: the client could receive a different device than requested.
- Add a separate device-class flag: `--target` already selects the class.

## Consequences

- Device contention can fail before execution with a device-lease error and ownership expiry.
- Backend-only leases remain valid for older clients; provider-aware clients get device-level contention.
- Holds and ordinary proxy leases are in memory, so controllers reconnect after daemon restart.
- Local human-control takeover remains deferred. A future host-global fence must coexist with local session claims.
- Limrun has not moved its lease ownership onto the shared provider lease table ([#4102](https://github.com/callstack/agent-device/issues/4102)).
- Provider allocation can still leave a rental outside registry recovery when a first allocation fails or a late allocation's release fails. Only the provider runtime that still holds the device can end that rental.
- A web open can be admitted under a non-`macos-app` lease for another backend; admission does not compare the request platform with the lease backend.
