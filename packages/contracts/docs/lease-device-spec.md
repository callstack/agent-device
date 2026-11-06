# Lease device specifications

A proxy lease can name a device spec beside platform, target, and device: `osVersion`, `imageTag`, `deviceMode`, and `physical` on `agent_device.lease.allocate`.
Only a backend in front of the daemon, such as simlock, can pick a device by these keys.
A daemon cannot pick by them.
If a daemon ignored them, a request would run on a device that it did not ask for.
Thus, a daemon refuses every request that names a non-blank `osVersion`, `imageTag` or `deviceMode`, or `physical: true`, before admission and before a lease is recorded.
The refusal is `UNSUPPORTED_OPERATION` with `details.reason: 'device-spec-unsupported'` and `details.keys`.
This applies to a local daemon and to a daemon behind `agent-device proxy`.
A blank `osVersion`, `imageTag` or `deviceMode` and `physical: false` name nothing, so a daemon accepts them.
`deviceMode` (`slim` or `full`) chooses how much of an iOS simulator the backend keeps running; the backend validates the value.
A named value is used as given, without trimming.
A value of another type is refused with `INVALID_ARGS`, `details.reason: 'device-spec-invalid'`, and `details.keys`.
`readLeaseDeviceSpec` is the one decision on these rules, for CLI flags, the SDK, MCP, and the daemon.
A remote config file first applies the value rules of every config key: a string must be non-empty, and a boolean also accepts a boolean string such as `"true"`.
The backend that honours the spec strips the keys before it forwards the allocation, and echoes the granted device on the lease as `lease.device` (`model`, `osVersion`, `imageTag?`, `deviceMode?`, `physical`).
`deviceKey` stays the identity of the lease; `lease.device` is the proof that the spec was understood.
The CLI proxy applies the returned-device checks in `src/commands/schema/cli-help.ts`.
For a spec request, if a new lease has no `lease.device`, the CLI proxy releases the lease and fails with `UNSUPPORTED_OPERATION` and `details.reason: 'device-spec-unsupported'`.
If the release returns, the error's `details.released` reports its result.
If the release fails, `details.leaseRollback` records the failure.
If the allocation explicitly reports reuse (`created: false`), the CLI proxy returns the same error without a release or `details.released`.
For a `full` request, a reported `slim` grant has the same result as a missing `lease.device`.
For a `slim` request, a `full` grant is accepted.
A lease that reports no mode is accepted, but the mode is not confirmed.
For a later command on a live lease, every spec key the command names must equal the value used to allocate the lease.
If a named key differs, the command fails with `CONNECTION_DEVICE_CONFLICT`.
A key the command omits keeps the lease's value.
