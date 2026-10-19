# ADR 0021: Simlock-Leased Devices Through Ordinary Local Runtimes

## Status

Accepted (2026-09-01). The decision was replaced on 2026-10-10. The in-process Host allocator integration is withdrawn.
Simlock closed [simlock#70](https://github.com/callstackincubator/simlock/issues/70) in favor of direct device leases by agents.
agent-device follows that design.

## Rules at a glance

- Agents acquire booted devices from Simlock through `simlock lease`, the Simlock MCP tool, or the Simlock HTTP API.
  Agents own renewal and release. agent-device does not call Simlock.
- Simlock owns allocation, capacity, provisioning, readiness, expiry, and device deletion.
- agent-device uses the ordinary local runtime, sessions, and process-owned device claims for a leased device.
  It has no managed runtime owner, allocator client, allocation journal, managed binding fence, or Host lease mapping.
- For iOS, pass the grant's `SIMLOCK_IOS_DEVICE_SET` as `--ios-simulator-device-set` or the `iosSimulatorDeviceSet` config key.
  Discovery, `simctl`, and the XCTest runner resolve the leased simulator inside Simlock's set.
- For Android, the grant's `ANDROID_ADB_SERVER_PORT` selects Simlock's adb server.
  Daemon `adb` calls read the daemon's environment.
  The daemon must start inside the lease environment, for example with a per-agent `--state-dir`.

## 1. Context

Simlock prevents parallel agents from competing for one simulator or emulator.
Its simulators reside in a device set that Xcode does not read, and its emulators register with Simlock's own adb server, which is what stops another tool from erasing a leased device.
A grant reports device access requirements in an `environment` object with `SIMLOCK_IOS_DEVICE_SET` and `ANDROID_ADB_SERVER_PORT`.
`simlock lease --export-env` prints this object for `eval`.

The first design proposed a Host inside agent-device with these responsibilities:

- Allocate through Simlock's typed client.
- Journal allocation requests.
- Fence each command with confirmed lease authority.
- Use a dedicated runtime owner for managed devices.

agent-device shipped these foundations but never activated them.
Simlock then selected direct device leases by agents.
This design needs nothing from agent-device beyond the ability to address a device in Simlock's roots.
agent-device already supported simulator-set scope and adb's server-port environment.

## 2. Decision

agent-device has no Simlock-specific code.
An agent leases a device and configures agent-device with Simlock's reported scope.
After use, the agent releases the lease.

```sh
eval "$(simlock lease --platform ios --device 'iPhone 16' --detach --export-env)"
agent-device open MyApp --platform ios --ios-simulator-device-set "$SIMLOCK_IOS_DEVICE_SET"
```

The lease provides exclusion between agents.
Process-owned device claims still guard against two sessions of one installation that drive the same device.
Simlock's "advisory, not a sandbox" model applies.
agent-device does not verify that a device is leased.

## 3. Consequences

- These components are removed:
  - The `managed-allocation` package.
  - Managed request admission and reachability.
  - The `managed-local` runtime owner kind.
  - Allocator-held device claims.
  - Managed device scope in platform readiness and deployment.
  A persisted durable-resource envelope with a `managed-local` owner decodes as unreattachable.
  A schema-3 device-claim record decodes as inconsistent.
  No shipped production path wrote either representation.
- `device status` and `device release --stale` no longer report `owner.kind: "allocator"` or `allocator-held`.
  Released v0.21.24 could print these values but never produced them.
- Remote access to a leased device uses Simlock's own gateway or HTTP API, or the existing agent-device `proxy` and remote daemon.
  Neither system depends on the other.
- The CLI and daemon accept no per-request Android adb server port.
  One daemon uses one adb server.
  Therefore, agents with leases from different Simlock daemons use separate state directories.
  Node SDK `agent-device/android-adb` functions run the caller's own adb executor.
  Therefore, the caller points that executor at Simlock's server.
  Per-call `AndroidAdbExecutorOptions.serverPort` takes effect only if the executor honors it.

## 4. Withdrawn design

The replaced design required these components:

- A durable allocation journal reconciled through Simlock after crashes.
- Fenced lease admission with renewal across each command deadline and teardown.
- A managed runtime owner that delegates to the local family.
- Allocator-held device claims with an installation principal instead of a process principal.

If an in-process allocator returns, recover that design from git history: the ADR text before 2026-10-10, #2284, #2308, and #2312.
