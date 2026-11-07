# Client lease heartbeats

## Client-side work that precedes admission

The [protection of admitted work](../../daemon/docs/remote-device-lease-contracts.md#admitted-request-work) covers nothing that happens before a request is admitted.
An artifact install uploads the artifact from the caller before the request that will consume it is admitted.
Thus, an upload slower than the inactivity window of the lease expired the lease that paid for the target device of the bytes (#2946).
The caller therefore sends lease heartbeats over the ordinary transport for as long as that phase runs.
Each heartbeat names the lease scope exactly as the command named it, and carries no payload of its own.
An install names no window, so its heartbeats renew for the window that the lease already carries.
A caller that did name a window continues to renew on that window.

The first heartbeat is sent when the phase starts, not one cadence later.
The reason is that a heartbeat proves that the lease on which the upload spends time is still alive.
Otherwise, a lease shorter than any fixed cadence would lapse before anything renewed it.
A lease that is already gone is caught early, but not before the phase begins.
Hashing, the preflight, and the start of the stream can all run while the first heartbeat is still outstanding.
Thus, the first heartbeat makes sure that the loss is learned during the upload instead of after it.
Each heartbeat answers with the window that it just renewed.
The loop arms the next heartbeat when the current heartbeat starts, not when it settles.
Thus, a heartbeat that never answers is abandoned on schedule and does not stop the schedule.
A phase that settles does not wait for a heartbeat still in flight.

Cadence and budget are deliberately two numbers.
A heartbeat is armed every third of the window, but it is allowed the whole window to answer.
If the budget were equal to the cadence, a heartbeat that needs more than a third of a window for its round trip could never answer.
Examples are a tunneled proxy and an uplink that the upload itself saturates.
Every heartbeat would then time out again on exactly the slow links that the heartbeat exists to protect.
The window, not the cadence, is the interval in which liveness still matters.
Thus, the window is also the longest time that an answer to a heartbeat is worth a wait.

That ceiling is the shorter of the window and the heartbeat's own request policy, currently ninety seconds.
Thus, a ten-minute lease gives a heartbeat ninety seconds instead of the full window.
This limit costs nothing that the heartbeat exists to provide.
The daemon renews the lease when it handles the request, before it answers.
Thus, a round trip abandoned at the cap has still extended the lease if the request ever arrived.
If the request never arrived, the transport has stopped carrying traffic.
A socket held open for the rest of a window measured in minutes does not help that transport.
The cap refuses exactly that idle hold.
The cap binds only on windows longer than the policy.
On those windows, the heartbeat already has the longest answer deadline that any lease gets.
Shorter windows are bounded by their own window, as above.

A heartbeat is a fresh request each time, never the protected request rewritten.
The reason is that a timed-out heartbeat is canceled under its request identity, and heartbeats must not inherit each other's cancellation.
In these cases, a heartbeat ends the phase with that error and cancels the upload:

- The heartbeat returns `UNAUTHORIZED` with `LEASE_NOT_FOUND`, `LEASE_EXPIRED`, or `LEASE_REVOKED`.
- The heartbeat returns `COMMAND_FAILED` with `provider-instance-ended`.
- The heartbeat returns an `AppError` with `LEASE_SCOPE_REQUIRED` or `LEASE_SCOPE_MISMATCH`.
- The heartbeat returns an `AppError` with code `INVALID_ARGS`.

When the provider reports `provider-instance-ended`, the daemon ends the lease and its sessions.
A failed session teardown does not replace that typed reason.

Thus, the upload does not finish bytes against a device that nobody owns or a lease that will stop renewing.
A heartbeat that fails for any other reason is reported, and the phase continues.
The reason is that a later heartbeat covers one lost request.
This includes a request abandoned at its budget instead of answered.
Thus, that promise holds for a stalled round trip, not only for a round trip that fails fast.
