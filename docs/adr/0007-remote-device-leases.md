# ADR 0007: Remote Device Leases

## Status

Accepted

## Context

Remote daemon users need a clear ownership boundary before a command reaches a
platform runner or helper. The existing lease model can bind a tenant/run to a
backend, but direct proxy and hosted providers also need to identify the selected
device and the connection provider that owns it.

Runner and helper processes already have backend-specific mutual exclusion. That
guard protects platform tooling, not remote client ownership, so surfacing those
errors directly makes device contention harder to recover from.

## Decision

A remote device lease is logical ownership of one selected device by one remote
agent/client for a connection provider such as `proxy`, a cloud bridge, or
`limrun`.

`connect` establishes a connection profile and client identity. Lease allocation
remains lazy and happens only when a device, backend, and provider are known.

A runner/process lease is a backend helper guard and is not a user/client
ownership boundary. It stays below daemon device leases and should not be
weakened or replaced by them.

`open` is the natural point to acquire a device lease because target resolution
and session creation meet there. Commands after `open` must refresh the lease;
no activity for five minutes should make the device available again.

The proxy process is expected to be long-lived and self-serve. Recovery from a
stale or expired device lease should not require restarting the proxy.

## Consequences

Device contention can fail before platform execution with an explicit
device-lease error that includes the backend, provider, selected device key, and
owning lease expiry.

Backend-only leases remain valid for older remote clients. Device and provider
fields are optional until provider-aware `open` acquisition and admission
refreshes are implemented.

