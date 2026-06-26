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
