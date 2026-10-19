# ADR 0029: Daemon Policy — Operator Rules Every Admitted Request Obeys

## Status

Accepted (2026-09-29).

## Rules at a glance

1. A **daemon policy** is one declarative JSON file selected by `AGENT_DEVICE_DAEMON_POLICY`.
   The daemon loads it once at startup and never reloads it.
   If the file cannot be read or validated, the daemon cannot start.
2. Policy applies to **every admitted daemon request**, regardless of transport.
   It belongs to the daemon instance, not request origin.
3. Policy is enforced at three points, each below the one before:
   - **Request gate:** `createRequestExecutionScope` refuses denied commands and `batch` requests with denied steps.
     It refuses `close --shutdown` when policy denies `device-shutdown`.
     It refuses explicit `--udid`/`--serial` values outside device scope.
     `batch` steps and `replay` actions re-enter this function and receive the same checks.
   - **Device scope:** before gateway binding, request runtime bindings refuse resolved devices outside scope.
     Inventory lists only allowed devices, including for `devices` and device selection.
   - **Capability gate:** the device-shutdown host capability refuses shutdown from every command.
     The only exception permits Apple readiness to roll back a Simulator boot started and then canceled by the same request.
     That Simulator was not previously running.
4. Denials use `UNAUTHORIZED`, `details.reason: 'DAEMON_POLICY_DENIED'`, `retriable: false`, a hint, and the policy digest.
   They include `rule`: `command`, `device`, `capability`, or `lease`.
   They never expose the policy's host path.
5. The daemon publishes its policy digest in `daemon.json`.
   A client that names a policy refuses to reuse a daemon that enforces a different policy or no policy.
   A client that names no policy reuses the daemon, whatever policy the daemon enforces.

## Policy shape

```json
{
  "version": 1,
  "devices": { "allow": [{ "udid": "8F1C…" }, { "serial": "emulator-5554" }] },
  "commands": { "deny": ["boot", "shutdown"] },
  "capabilities": { "deny": ["device-shutdown"] },
  "leases": { "require": "macos-app" }
}
```

- `devices.allow` identifies devices that the daemon may bind.
  If absent, every device is allowed.
- `commands` contains exactly one of `allow` or `deny`.
  The command registry determines applicable daemon commands and names, without a manual list:
  - Public commands use their own names.
  - Internal commands with platform execution use their `catalog.servesPublicCommand` name when present.
    For example, `install_source` uses `install-from-source`.
    Otherwise, they use their own names, such as Maestro flows' `runtime`.
  - Rules do not decide internal commands without platform execution.
    These commands (leases, `human_control`, and session bookkeeping) are protocol plumbing.
  - Rules decide every other name, so an allow list fails closed for it.
  Load-time validation checks names against this vocabulary.
  It refuses local-cli names such as `react-devtools` because they execute in the client.
  With `allow`, commands added by later upgrades are denied by default.
- `capabilities.deny` denies operations regardless of the command that reaches them.
  Currently, `device-shutdown` is the only capability.
- `leases.require` accepts only `macos-app`.
  Each request must have `macos-app` lease admission and pass its command allow list under ADR 0007.
  This includes commands otherwise exempt from lease admission.
  Of those exempt commands, only `lease_heartbeat` and `lease_release` pass.
  A request without a lease is refused with `rule: 'lease'` instead of unleased admission.
  Hosts that confine clients to `macos-app` leases set this requirement.
  A client therefore cannot discard its lease to reach the desktop.

Unknown keys are errors.
A misspelled rule cannot silently remove a restriction.

## Context

`agent-device proxy` and hook-authenticated HTTP daemons expose host devices to remote agents.
Operators need to confine a remote agent to one simulator and prevent the agent from shutting down that simulator.
The HTTP auth hook, `AGENT_DEVICE_HTTP_AUTH_HOOK`, sees every top-level RPC and could refuse commands.
It cannot correctly own operation policy for these reasons:

- Internal `batch` steps and `replay` actions never pass the HTTP edge again.
  `shutdown` supports batch execution.
- The daemon resolves names such as `--device "iPhone 16"`.
  The HTTP edge sees only the name.
- `close --shutdown` and lifecycle close reach the same shutdown capability as `shutdown`.

## Decision

The daemon owns operation authorization beside the constrained request admission, device binding, and host capability.
The HTTP auth hook retains authentication and tenant attestation.

### Why the policy ignores request origin

Remote requests carry `internal.publicNetworkOnly`.
`replay` and `test` manually copy it to child requests.
An origin-based policy inherits this propagation risk.
A child that loses the marker would escape policy.
A daemon-wide policy requires no propagation.

An operator needing unrestricted access runs `simctl`/`adb` directly.
Alternatively, the operator starts a daemon with another `--state-dir` and no `AGENT_DEVICE_DAEMON_POLICY`.
A separate state directory alone still loads the policy selected by the environment.

### Why three enforcement points

The request gate produces an early, specific error before locks or device resolution.
It cannot see the device behind a name or anticipate every future shutdown command.
Device scope sees the resolved device on every binding.
The capability gate sees every shutdown.
Each later point is the backstop for the earlier point.
A new command or flag therefore cannot evade policy through another route to the operation.

### Why fail closed and never reload

Startup without the operator's policy or a policy replacement mid-session would make every earlier admission decision stale.
The daemon loads the policy once and refuses to start on an invalid file.
Thus a running daemon has exactly one policy.
Its digest identifies that policy.

## Consequences

- A five-line file can restrict a remote daemon to one simulator and deny shutdown.
- Sessions, leases, and claims retain their semantics.
  Policy only removes options.
- RPC cannot yet inspect policy.
  Agents receive policy information through denials with the rule and a do-not-retry hint.
- Lease allocation outside device scope is not refused during allocation.
  Device scope refuses the first request that binds that device.
- Startup/shutdown recovery of daemon-owned durable resources is not request work and has no device scope.
  These resources include app-log processes, device claims, and session teardown.
  Refusal would retain the processes and claims that recovery must release.
  Recovery acts only on records in the daemon's own state directory.
  The capability gate still applies, so recovery cannot shut down devices.
- `AGENT_DEVICE_DAEMON_POLICY` configures daemons started on this host.
  Clients using `AGENT_DEVICE_DAEMON_BASE_URL` or `connect proxy` neither send nor verify it.
  The remote host operator owns remote daemon policy.
  Publication of the digest through `/health` for remote verification requires a later daemon wire change.
- Invalid-policy startup errors name the policy path on daemon stderr.
  Only the initiating host process receives this output.
  The operator needs the path to repair the file.
  Request denials never name it.
- A local caller that triggers takeover starts the replacement daemon with its own environment.
  For example, it may request transport absent from the running daemon.
  If that caller names no policy, its replacement has no policy.
  Remote clients use only HTTP and cannot trigger takeover.
  Local callers are the operator's own processes.

## Rejected alternatives

- **Policy in the HTTP auth hook or proxy.**
  Both see only top-level RPCs; see Context.
- **Per-request or per-tenant policy.**
  This first requires authenticated identity.
  An authenticating front end can add per-user rules on top of this per-daemon policy.
  This per-daemon policy is the floor.
- **A programmatic policy module: deferred.**
  If added, it must decide at the same three points, not at the HTTP edge.
