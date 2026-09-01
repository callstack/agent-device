# ADR 0007: Remote Device Leases

## Status

Accepted

## Context

Remote daemon users need a clear ownership boundary before commands reach a
platform runner or helper. Shared proxy and hosted providers need ownership to
include the selected device and connection provider, not only tenant/run.

Runner and helper processes already have backend-specific mutual exclusion. That
guard protects platform tooling, not remote client ownership, so surfacing those
errors directly makes device contention harder to recover from.

## Decision

A remote device lease is logical ownership of one selected device by one
remote client for a connection provider such as `proxy`, cloud, or `limrun`.

`connect` establishes connection profile and client identity. Lease allocation
is lazy and happens when a device, backend, and provider are known.

A runner/process lease is a backend helper guard and is not a user/client
ownership boundary. It stays below daemon device leases and should not be
weakened or replaced by them.

`open` is the natural point to acquire a device lease because target resolution
and session creation meet there. Commands after `open` must refresh the lease;
no activity for five minutes should make the device available again.

Lease admission, heartbeat, stored session lease refresh, and request execution
must run under the same daemon request lock. Scope resolution may happen before
the lock, but lease ownership mutation must not.

Generated connection profiles are non-secret. They may persist routing and
lease metadata, but must strip daemon and Metro bearer tokens. Tokens are
supplied in-memory for the current command or through environment/CLI token
paths.

The proxy process is expected to be long-lived and self-serve. Recovery from a
stale or expired device lease should not require restarting the proxy.

## Consequences

Device contention can fail before platform execution with an explicit
device-lease error that includes the backend, provider, selected device key, and
owning lease expiry.

Backend-only leases remain valid for older remote clients, while provider-aware
clients get device-level contention and clearer recovery.

## Human control

Human-control holds coexist with an open remote session. They belong to `LeaseRegistry` and use
the same backend/provider/device contention key as device-aware leases. Hold heartbeat, expiry,
lease preservation, and release refresh are one registry-owned lifecycle. Releasing or expiring the
last hold gives the lease its existing inactivity TTL again; expiry uses the hold's expiry instant.

Tenant hold operations are ordinary daemon RPCs admitted through `request-admission.ts`. Their
device comes only from the admitted lease. Host administration is a distinct loopback capability
authenticated with the daemon token, never a tenant credential; tenants cannot modify host holds.

Mutation admission derives from existing recording effects, observation-class inventory, and
observability semantics. Takeover and lease heartbeats are exempt from the mutation fence, not from
their ownership checks. Unknown effects are treated as mutations. A pending activation fences new
mutations and drains those already admitted before reporting active; advisory execution locks alone
do not establish this guarantee for fresh sessions.

Activation follows the calling RPC or host HTTP request's cancellation signal. A disconnect while
draining removes only that request's pending hold, leaving successor and unrelated holds intact;
canceling activation does not cancel the mutations being drained. Completed holds use their TTL or
explicit release lifecycle.

Holds and ordinary proxy leases are in-memory and do not survive daemon restart. Controllers must
reconnect and re-establish them; no persisted hold store is used. Local takeover is deferred: a
future host-global human-control fence must coexist with the local session's device claim, not
acquire it exclusively.

## Host managed-device durability amendment

ADR 0021 adds a narrow durability exception for Host leases backed by a managed-device allocator.
Before allocator acquisition, the daemon persists a non-authoritative allocation operation record;
Host adds its asserted principal, Host lease id, and run/client attribution. After grant, it records
the allocator outcome and Host-to-managed-device lease mapping before publishing the Host grant.

This record tracks Host publication and cleanup; it never mirrors allocator lifecycle state or
becomes a second source of device truth. It exists to reconcile an uncertain allocator outcome and
prevent duplicate or unattributed local ownership. It does not make the ordinary `LeaseRegistry`,
proxy leases, or human-control holds durable. Rehydration requires the same authorized Host user
and revalidates the allocator lease before device operations resume.
