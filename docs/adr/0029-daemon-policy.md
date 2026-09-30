# ADR 0029: Daemon Policy — Operator Rules Every Admitted Request Obeys

## Status

Accepted (2026-09-29).

## Rules at a glance

1. A **daemon policy** is one declarative JSON file named by `AGENT_DEVICE_DAEMON_POLICY`. The
   daemon loads it once at start and never reloads it. A policy that cannot be read or validated
   stops the daemon from starting.
2. The policy applies to **every request the daemon admits**, whatever transport it came from. It is
   a property of the daemon instance, not of a request's origin.
3. It is enforced at three points, each below the one before:
   - **Request gate** — `createRequestExecutionScope` refuses denied commands, a `batch` that names
     a denied step, `close --shutdown` when `device-shutdown` is denied, and an explicit
     `--udid`/`--serial` outside the device scope. `batch` steps and `replay` actions re-enter this
     function, so they are gated too.
   - **Device scope** — request runtime bindings refuse a resolved device outside the scope before
     the gateway binds it, and device inventory (therefore `devices` and device selection) lists
     only allowed devices.
   - **Capability gate** — the device-shutdown host capability refuses every shutdown, whichever
     command asks for it. The one exception is Apple readiness rolling back a Simulator boot that
     the same request started and then canceled: the Simulator was not running before.
4. A denial is `UNAUTHORIZED` with `details.reason: 'DAEMON_POLICY_DENIED'`, the `rule`
   (`command`, `device`, or `capability`), the policy digest, `retriable: false`, and a hint. It
   never names the policy's host path.
5. The daemon publishes the policy digest in `daemon.json`. A client that names a policy refuses to
   reuse a daemon that enforces a different one, or none. A client that names no policy reuses
   whatever the daemon enforces.

## Policy shape

```json
{
  "version": 1,
  "devices": { "allow": [{ "udid": "8F1C…" }, { "serial": "emulator-5554" }] },
  "commands": { "deny": ["boot", "shutdown"] },
  "capabilities": { "deny": ["device-shutdown"] }
}
```

- `devices.allow` — device ids the daemon may bind. Absent: every device.
- `commands` — exactly one of `allow` or `deny`. Which daemon commands a rule decides, and by what
  name, is derived from the command registry, never from a hand list:
  - public commands, by their own name;
  - internal commands with platform execution, by the public command their
    `catalog.servesPublicCommand` names (`install_source` as `install-from-source`), or else by
    their own name (`runtime`, which `react-devtools` and Maestro flows send);
  - internal commands with no platform execution (leases, `human_control`, session bookkeeping) are
    protocol plumbing that no rule decides;
  - any other name is decided by the rules, so an allow list fails closed for it.

  Names are checked against that vocabulary at load; a local-cli name such as `react-devtools` is
  refused with a pointer to the daemon command it sends. With `allow`, commands added by a later
  upgrade are denied by default.
- `capabilities.deny` — operations denied whichever command reaches them. `device-shutdown` is the
  only capability today.

Unknown keys are errors, so a misspelled rule cannot silently become no rule.

## Context

`agent-device proxy` and hook-authenticated HTTP daemons expose one host's devices to remote
agents. Operators need to confine a remote agent to one simulator and stop it from shutting that
simulator down. The HTTP auth hook (`AGENT_DEVICE_HTTP_AUTH_HOOK`) sees every top-level RPC, so it
could refuse commands, but it is the wrong owner for this:

- `batch` steps and `replay` actions run inside the daemon and never pass the HTTP edge again, and
  `shutdown` is batchable.
- A device name (`--device "iPhone 16"`) is resolved inside the daemon; the edge only sees the name.
- `close --shutdown` and lifecycle close reach the same shutdown capability as `shutdown`.

## Decision

Authorization of operations lives in the daemon, next to the request admission, device binding, and
host capability it constrains. The HTTP auth hook keeps authentication and tenant attestation.

### Why the policy ignores request origin

Remote-origin requests carry `internal.publicNetworkOnly`, but `replay` and `test` copy it to child
requests by hand. A rule keyed on origin inherits that propagation risk: a child request that loses
the marker would escape the policy. A daemon-wide rule has nothing to propagate. A host operator who
needs unrestricted access runs `simctl`/`adb` directly, or starts a daemon with another `--state-dir`
and without `AGENT_DEVICE_DAEMON_POLICY` set; a separate state dir alone still loads the policy the
environment names.

### Why three enforcement points

The request gate gives an early, specific error before any lock or device resolution. It cannot see
the device a name resolves to, and it cannot anticipate every future command that shuts a device
down. The device scope sees the resolved device on every binding; the capability gate sees every
shutdown. Each later point is the backstop for the earlier one, so a new command or flag cannot
bypass the policy by reaching the operation another way.

### Why fail closed and never reload

A daemon that started without its operator's policy, or that swapped policies mid-session, would
make every earlier admission decision stale. Loading once and refusing to start on an invalid file
means a running daemon has exactly one policy, and its digest identifies it.

## Consequences

- An operator can pin a remote daemon to one simulator and deny shutdown with a five-line file.
- Sessions, leases, and claims keep their existing semantics; the policy only removes options.
- The policy cannot yet be inspected over RPC. Agents learn it from denial errors, which carry the
  rule and a do-not-retry hint.
- Lease allocation for a device outside the scope is not refused at allocation time; the device
  scope refuses the first request that binds it.
- Startup and shutdown recovery of the daemon's own durable resources (app-log processes, device
  claims, session teardown) is not request work and is not device-scoped: refusing it would leak
  the processes and claims it exists to release. It acts only on records in the daemon's own state
  dir. The capability gate still applies, so recovery cannot shut a device down.
- `AGENT_DEVICE_DAEMON_POLICY` configures a daemon started on this host. A client connected to a
  remote daemon (`AGENT_DEVICE_DAEMON_BASE_URL`, `connect proxy`) neither sends nor verifies it;
  the remote host's operator owns that daemon's policy. Publishing the digest over `/health` so a
  remote client can check it is a follow-up that needs a daemon wire change.
- An invalid policy's startup error names the policy path on the daemon's stderr. That output
  reaches only the host process that started the daemon, and the operator needs the path to fix
  the file; request-time denials never name it.
- A local caller on the host that triggers daemon takeover (for example by asking for a transport
  the running daemon does not serve) starts the replacement with its own environment. A caller that
  names no policy therefore gets a daemon without one. Remote clients reach the daemon only over
  HTTP and cannot trigger takeover; local callers are the operator's own processes.

## Rejected alternatives

- **Policy in the HTTP auth hook or the proxy.** Both see only top-level RPCs; see Context.
- **Per-request or per-tenant policy.** Needs authenticated identity first; ADR 0021 Host can layer
  per-user rules on top of this per-daemon floor.
- **A programmatic policy module.** Deferred. If added, it must decide at the same three points, not
  at the HTTP edge.
