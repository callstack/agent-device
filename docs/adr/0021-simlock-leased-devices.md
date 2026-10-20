# ADR 0021: Simlock-Leased Devices Through Ordinary Local Runtimes

## Status

Accepted (2026-10-10).

Decision history: on 2026-10-10 this replaced an earlier in-process allocator design. Simlock closed [simlock#70](https://github.com/callstackincubator/simlock/issues/70) in favor of direct device leases by agents, and agent-device follows that design. To recover the earlier design, read the git history before that date: #2284, #2308 and #2312.

## Rules at a glance

- Agents acquire booted devices from Simlock through `simlock lease`, the Simlock MCP tool, or the Simlock HTTP API.
  Agents own renewal and release. agent-device does not call Simlock.
- Simlock owns allocation, capacity, provisioning, readiness, expiry, and device deletion.
- agent-device uses the ordinary local runtime, sessions, and process-owned device claims for a leased device.
  It has no managed runtime owner, allocator client, allocation journal, or managed binding fence.
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

Direct leases need nothing from agent-device beyond the ability to address a device in Simlock's roots.
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

## 4. Rejected alternative

- **An allocator inside agent-device** would allocate devices through Simlock's typed client, keep a journal of allocation requests, and fence each command with confirmed lease authority. We rejected it because Simlock owns allocation and agents lease devices directly, so an internal allocator would duplicate Simlock's state.
