# ADR 0021: Simlock-Leased Devices Through Ordinary Local Runtimes

## Status

Accepted (2026-09-01). Decision replaced 2026-10-10: the in-process Host allocator integration is
withdrawn. Simlock closed its side ([simlock#70](https://github.com/callstackincubator/simlock/issues/70))
as superseded by a design in which agents lease devices themselves, and agent-device follows it.

## Rules at a glance

- Agents acquire booted devices from Simlock (`simlock lease`, its MCP tool, or its HTTP API) and
  own renewal and release. agent-device does not call Simlock.
- Simlock owns allocation, capacity, provisioning, readiness, expiry, and device deletion.
- agent-device drives a leased device as an ordinary local device: the local platform runtime,
  ordinary sessions, and process-owned device claims. There is no managed runtime owner, allocator
  client, allocation journal, managed binding fence, or Host lease mapping.
- iOS: pass the grant's `SIMLOCK_IOS_DEVICE_SET` as `--ios-simulator-device-set` (or the
  `iosSimulatorDeviceSet` config key). Discovery, `simctl`, and the XCTest runner then resolve the
  leased simulator inside Simlock's set.
- Android: the grant's `ANDROID_ADB_SERVER_PORT` points `adb` at Simlock's server. The daemon's
  `adb` invocations read it from the daemon's own environment, so the daemon must start inside the
  lease environment (for example, a per-agent `--state-dir`).

## 1. Context

Simlock keeps parallel agents from fighting over the same simulator or emulator. Its simulators
live in a device set Xcode does not read, and its emulators register with Simlock's own adb server,
which is what stops another tool from erasing a leased device. A grant reports what reaching the
device needs as an `environment` object (`SIMLOCK_IOS_DEVICE_SET`, `ANDROID_ADB_SERVER_PORT`), and
`simlock lease --export-env` prints it for `eval`.

The first version of this ADR planned a Host inside agent-device that would allocate through
Simlock's typed client, journal allocation requests, fence every command with confirmed lease
authority, and run managed devices through a dedicated runtime owner. agent-device shipped those
foundations without ever activating them. Simlock then settled on agents leasing devices directly,
which needs nothing from agent-device beyond addressing a device in Simlock's roots, and both
already existed: simulator-set scoping and adb's own server-port environment.

## 2. Decision

agent-device has no Simlock-specific code. An agent leases a device, points agent-device at it with
the scope Simlock reports, and releases the lease when done:

```sh
eval "$(simlock lease --platform ios --device 'iPhone 16' --detach --export-env)"
agent-device open MyApp --platform ios --ios-simulator-device-set "$SIMLOCK_IOS_DEVICE_SET"
```

The lease is the exclusion between agents; agent-device's process-owned device claims still guard
against two sessions of one installation driving the same device. Simlock's "advisory, not a
sandbox" model applies: agent-device does not verify that a device is leased.

## 3. Consequences

- The `managed-allocation` package, managed request admission and reachability, the `managed-local`
  runtime owner kind, allocator-held device claims, and the managed device scope in platform
  readiness and deployment are removed. A persisted durable-resource envelope naming a
  `managed-local` owner decodes as unreattachable, and a schema-3 device-claim record as
  inconsistent; no shipped production path ever wrote either.
- `device status` and `device release --stale` no longer report an `owner.kind: "allocator"` shape
  or the `allocator-held` classification. Released v0.21.24 could print them but never produced them.
- Remote access to a leased device uses Simlock's own gateway or HTTP API, or agent-device's
  existing `proxy` and remote daemon; neither depends on the other.
- The CLI and daemon take no per-request Android adb server port: one daemon talks to one adb
  server, so agents holding leases from different Simlock daemons use separate state dirs. The Node
  SDK's `agent-device/android-adb` functions run the caller's own adb executor, so the caller points
  that executor at Simlock's server; the per-call `serverPort` in `AndroidAdbExecutorOptions` takes
  effect only when that executor honors it.

## 4. Withdrawn design

The replaced design required a durable allocation journal reconciled through Simlock after crashes,
fenced lease admission with renewal covering each command deadline plus teardown, a managed runtime
owner delegating to the local family, and allocator-held device claims whose principal was an
installation rather than a process. Recover it from git history (ADR text before 2026-10-10,
#2284, #2308, #2312) if an in-process allocator returns.
