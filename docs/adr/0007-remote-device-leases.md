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

## Admitted request work

A lease renews when a request is admitted and never again while that request runs, so an admitted
command slower than the inactivity TTL used to expire the lease that was paying for its own device
and tear the session down underneath the client still waiting for its result. Admitted work
therefore preserves its lease the way a human-control hold does: while the request is still wanted
it defers expiry, and finishing while still wanted renews the lease for its existing inactivity TTL
from the moment the work ended. A request whose client hung up preserves nothing — it neither defers
expiry past that cancellation nor renews the lease when it finally lands — so a handler that ignores
its cancellation cannot hold a rented device open.

Which leases this reaches depends on the inactivity TTL the client asked for: the daemon default is
one minute, while a cloud WebDriver connection profile asks for ten. A single command that runs
longer than its own lease is therefore ordinary on the default and only reachable through a profile
on the longer one.

## Client-side work that precedes admission

Protecting admitted work covers nothing that happens before a request is admitted. Installing an
artifact uploads it from the caller while the request that will consume it has not been admitted yet,
so an upload slower than the lease's inactivity window expired the lease paying for the device the
bytes were going to (#2946). The caller therefore beats the lease over the ordinary transport for as
long as that phase runs, naming the lease scope exactly as the command named it and no payload of its
own. An install names no window, so its beats renew for the window the lease already carries; a
caller that did name one keeps renewing on it. Resolving an absent window to the registry default
instead — which is what a heartbeat used to do — quietly shortened every lease allocated above that
default, which is the other half of why the upload could not survive. Request admission had its own
copy of that mistake: it named a proxy-specific default for every admitted request, so a lease
allocated longer than the default lost its window on the next command. Admission renews on the lease's
window too; the window a lease carries is the one its client named when it allocated.

The first beat is fired when the phase starts, not one cadence in, because a beat is what proves the
lease the upload is spending time on is still alive — a lease shorter than any fixed cadence would
otherwise lapse before anything renewed it, and a lease already gone is worth learning that before any
bytes move. Each beat answers with the window it just renewed, and the next one is armed a third of
that window after the beat lands: beats never overlap, and one slower than the cadence delays its
successor instead of replacing the schedule or suppressing every beat behind it.

A beat is a fresh request each time, never the protected request rewritten: a request identity is
what a timed-out beat is canceled under, and beats must not inherit each other's cancellation. A beat
that finds the lease gone, or finds that this request can never renew it because its scope is missing
or belongs to another lease, ends the phase with that error and cancels the upload rather than
finishing bytes against a device nobody owns or a lease that will stop renewing. A beat that fails for
any other reason is reported and survived, because a later beat covers one lost request.

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
