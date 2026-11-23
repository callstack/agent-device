---
title: Sessions
---

A session ties your commands to one device and app, so state and snapshots carry over from one command
to the next.

```bash
agent-device open Settings --platform ios
agent-device session list
agent-device open Contacts          # change app in this workspace's session
agent-device close
```

You don't need to name a session. The implicit session is scoped to your git worktree (or current
working directory) and to the platform the command selects: `--platform ios` runs in the `ios`
session and `--platform android` in the `android` session.
A session opened without `--platform` uses the platform-less `default` session, and commands that name a
platform still join it as long as they match its device. Agents in different worktrees do not attach
to each other's implicit session; a named session (`--session <name>`) is shared across worktrees.
Implicit web sessions in different worktrees also use separate browsers, so they can run at the same time.

## Find a session's logs and artifacts

When a session starts, human output prints a `Session state: <path>` line and JSON output includes
`sessionStateDir`. That directory holds the session's artifacts; inspect or delete it after the run.
JSON output also includes `runnerLogPath`, `requestLogPath`, and `eventLogPath` when available.

Each session artifact directory contains:

- `request-records/<record-id>.ndjson` - daemon request diagnostics for this session, one file per request. The daemon names the file, a failed command prints its path, and each line carries the request id.
- `runner.log` - Apple runner and `xcodebuild` build/start output for this session.
- `app.log` - app/device logs when `logs start` or `logs clear --restart` is active.

Use `agent-device events` to read requests and recorded actions for an active session.
The file at `eventLogPath` rotates at 5 MiB by default. Set `AGENT_DEVICE_EVENT_LOG_MAX_BYTES`
on the daemon to change the cap in bytes. Cursors in the retained window survive rotation.
Closing the session removes its event journal. Start with a fresh cursor when you reopen it.

`events.ndjson` leaves out user-entered content. It keeps command names, status,
durations, bounded device/app inventory previews, lifecycle outcomes, artifact basenames, and
structural action details such as scroll distance/direction, safe refs, and coordinates.
User-entered text, clipboard contents, push/event payloads, selector values, free-form
flags/messages/paths, and raw unknown command arguments are omitted or replaced with content-free
placeholders. `--no-record` suppresses recorded action entries; request start/finish entries still
record command, status, and timing.

The timeline is best effort. An event line larger than the configured file cap or 16 MiB is dropped.
The per-session limit is 128 events and 16 MiB of event data, including the write in progress.
Further events are dropped until capacity is available. These drops do not fail the command, and
failed entries are not replayed. To capture write or rotation failure diagnostics while reproducing
missing entries, run the command with `--debug`, then look for `session_event_log_write_failed` in
`request-records/<record-id>.ndjson` inside the session artifact directory. An active `trace` also records
these diagnostics in its trace file.

To debug a specific run, start with the session artifact directory. The top-level daemon log only
covers daemon startup and lifecycle issues.

## Share a session by name

Name a session only when you want a shared, reusable handle. Pass `--session <name>` or set
`AGENT_DEVICE_SESSION`:

```bash
agent-device open Contacts --platform ios --session my-session
agent-device snapshot -i
agent-device close --session my-session
```

Don't run commands that change state in parallel on the same session. Run actions such as `open`,
`press`, `fill`, `type`, `scroll`, `back`, `alert`, `replay`, `batch`, and `close` one at a time.

## Lock a named session to a device

A lock keeps a named session's commands on its device: per-call selectors that conflict with the
session are rejected or dropped. Most local automation doesn't need one, because implicit sessions are
already scoped to the workspace.

Setting `AGENT_DEVICE_SESSION` turns on the lock in `reject` mode by default. Choose how conflicts are handled with
`--session-lock reject|strip`, `AGENT_DEVICE_SESSION_LOCK=reject|strip`, or the `sessionLock` config key:

```bash
AGENT_DEVICE_SESSION=qa-ios AGENT_DEVICE_SESSION_LOCK=strip agent-device snapshot --platform android
```

The MCP server and the AI SDK tools apply the same lock. They read `AGENT_DEVICE_SESSION`,
`AGENT_DEVICE_SESSION_LOCK`, `AGENT_DEVICE_PLATFORM`, and the `sessionLock` config key from the process
that serves the tools. A session or platform named in a tool call does not turn on the lock.

- `reject` fails a command whose selectors conflict with the lock.
- `strip` drops conflicting platform and scope selectors (`--platform`, `--target`,
  `--ios-simulator-device-set`, `--android-device-allowlist`) and runs the command on the locked
  device. Only those selectors are dropped.
- In either mode, a selector that names a different device than the lock (`--udid`, `--serial`,
  `--device`) is never dropped. The command fails with `INVALID_ARGS` and names both the requested and
  the locked device, because continuing would run it on a device you did not select. If you want the
  requested device, close the locked session; if you want the locked one, remove the selector.
- CLI scope flags normally override environment values. With `strip` active, conflicting per-call
  selectors are ignored instead.
- The daemon enforces the lock, so CLI, Node.js client, and direct RPC requests get the same conflict
  handling. Direct RPC callers pass `meta.lockPolicy` and optional `meta.lockPlatform` on
  `agent_device.command` requests.
- `batch` steps keep the batch's `--platform` under a lock; see [Batching](/docs/batching).

## Drive two platforms from one checkout

You don't need to name sessions: `--platform` selects that platform's implicit session, so each
platform keeps its own device, app, and artifact directory.

```bash
agent-device open Demo --platform ios
agent-device open Demo --platform android   # its own session, not a conflict with the iOS one
agent-device snapshot --platform android
agent-device close --platform ios
```

Once a workspace holds more than one implicit session, a command that names neither `--platform` nor
`--session` fails with `AMBIGUOUS_MATCH` instead of guessing which device to drive. That includes
`close`, so add `--platform` (or `--session <address>`) to each teardown line too. `session list`,
`devices`, `doctor`, `capabilities`, and `apps` don't claim a session, so they still work; `session list`
prints the `address` that `--session` accepts.

## Shut down the device on close

`close` stops the local simulator or emulator that this session's `open` booted, so the device ends
as the session found it. A device that was already running when you opened it keeps running:

```bash
agent-device open --platform ios --device iPhone_17_Pro
agent-device close            # the simulator this open booted ends shut down
```

For an Apple simulator, the proof that `open` booted it is that `open`'s own boot step performed the
boot. If something else booted the simulator first, such as a concurrent `xcrun simctl boot`, plain
`close` leaves it running and reports `boot-owner-unverified` in `warnings`.

For an Android emulator, that stop is owed to the emulator process this session's `open`
launched, so `close` checks that process before it asks for the stop. When it is gone, or when the
host cannot answer for it, plain `close` leaves the emulator running and reports why in `warnings`.
Use `close --shutdown` to stop the emulator anyway.

Add `--shutdown` to explicitly stop a local simulator or emulator regardless of boot ownership.
For an Android emulator, `--shutdown` skips that process check and stops the emulator anyway, then
waits for, and if needed stops, the process this session's `open` launched; when it cannot confirm
the exit, `close` reports that in `warnings`. A session on an emulator that was already running recorded no such
process, so `--shutdown` has no process to wait for and returns once the device was asked to stop.
Physical devices are not stopped. Provider sessions follow the provider's shutdown action.
With [Limrun](./limrun.md), `--shutdown` ends the instance or attachment and can delete an instance
that agent-device created:

```bash
agent-device close --shutdown
```

When a shutdown result exists, `close` reports it in `data.shutdown`. Check `shutdown.success` to
see whether the stop succeeded. The field is omitted when no shutdown result is returned, including
a plain close of a prebooted device or a policy-skipped implicit stop. If the daemon policy denies `device-shutdown`, `close --shutdown` fails with
`UNAUTHORIZED` and `error.details.reason: DAEMON_POLICY_DENIED`. Plain `close` skips its implicit stop,
succeeds, and reports the local simulator or emulator it left running in `warnings`.

When the session keeps its device running, `close` can keep a ready, idle iOS simulator runner warm
for the next `open` when its listener connection is still live and the session has no screen
recording or device lease. A close that stops the device stops its runner instead. Unfinished runner
startup is always stopped. If you shut that simulator down yourself while the runner is retained,
losing its listener connection stops the retained runner. Idle retained runners also stop when their
daemon shuts down gracefully.

## Wait for a slow or busy device

A never-booted iOS Simulator can take several minutes to finish its first boot. Give `open` (or
`prepare ios-runner`) a `--timeout` long enough to cover it. The session claims the device from the
first `open` onward, so another workspace gets `DEVICE_IN_USE` the whole time:

```bash
agent-device open Settings --platform ios --udid <udid> --timeout 600000
```

Without `--timeout`, the command gives up after about 90 seconds, often before a first boot finishes.
When the budget runs out, the command fails with `error.details.reason: boot_timeout`, but the
Simulator or emulator keeps booting, so a retry finds it further along.

When another session holds the device but will release it soon — a parallel agent finishing its run —
`open --wait <ms>` waits for the device instead of failing at once, and reports who holds it while it
waits:

```bash
agent-device open Demo --platform android --wait 60000
```

If the wait runs out while the device is still busy, `open` fails with `DEVICE_IN_USE`.
If the reply names the holder, its owner can run `close --session <address>` to release the device.
Each waiting `open` has its own budget. If another waiter gets the device first, the rest keep
waiting for the time left in their budgets.

If the session at the address has an expired lease, `open` with your own valid lease waits for
cleanup within the request deadline. Use `--wait` to cap that wait. Your lease must still be valid
when cleanup ends.

Behind a shared proxy token, all clients share a tenant. A proxy client can see the holder's address
in a refusal or in wait progress if it can list the holder and the holder has a lease or a tenant
scope. To see the address of a leased holder, the caller must send that holder's lease id.
Open contention and claim conflicts can show the address of an unleased session in another
workspace to a local caller. The owner can use that address to close the session from its workspace.

If another workspace's daemon holds the claim, `open` fails at once.
Device-mutating commands like `install` and `reinstall` don't wait either: while a
session other than yours holds the device, they fail at once with `DEVICE_IN_USE`.
Copying the owner's `--session` address doesn't change that — the claim must also
record your workspace, so a command run from another checkout is refused even under
the owner's name. The error shows the owner and its state directory only if you can see the owner.
If the error omits the owner, follow its recovery hint.

## Release a device another session or workspace holds

Each daemon claims the devices its sessions use. A claim whose owner is live, or can't be proven
gone, blocks `open` from another workspace, and blocks device-mutating commands like `install`
from any other owner — another session, or the same session name from another workspace.
List the claims on this host without starting a daemon:

```bash
agent-device device status
agent-device device status --platform ios --udid <udid>
agent-device device status --stale
```

Normal output shows live claims and claims that need attention, then counts the stale claims it hides
in one line; `--stale` lists those. A stale claim's owner process exited, its PID now belongs to
another process, its state directory was deleted, or a newer daemon replaced it. In the last two
cases the owner process can still be running, so inspect each one before you act. Scope either view
with `--platform` plus `--udid` (Apple) or `--serial` (Android).

`--json` reports each claimed device once as `acquirable`, an inspection of whether a new session can
take it now. It cannot see a reboot and runs no recovery, so `open` may decide differently.
`blockedBy` names why not, and `owner` identifies the claim's owner when its record decodes: the
holder that blocks the device or, on an acquirable device, the reclaimable dead owner `open` would
settle. A daemon's own abandoned claim is reported as blocked by that live owner, but `open` through
that same daemon may still take it. A stale claim whose owner is provably gone and retains no resource
does not block by itself. `hiddenStaleClaims` counts the claim records this view hides and is not an
availability signal, so read `acquirable`: a hidden owner whose PID was reused or whose state
directory is gone, and pending resource cleanup, each still block the device.

To free a device:

- If the owner is still running, close its session from its own workspace, or stop its daemon with
  `agent-device daemon stop --state-dir <owner state dir>`.
- If the owner provably can't release the claim, because its process exited or a newer daemon
  replaced it, run `agent-device device release --stale`. It settles the durable resources that
  owner left behind, then clears the claim; if those resources don't settle, the claim stays. Live,
  uncertain, PID-reused, corrupt, and deleted-state-directory claims are refused with the reason;
  `device release` never forces them.
- `open` replaces such a claim itself once that owner's durable resources are settled.
- If the device rebooted after a live owner's claim was taken, the reboot already ended that owner's
  app, runner, and accessibility session. `open` settles the owner's durable resources, takes the
  claim, and reports the release in `warnings`. `device release --stale` never checks for a
  reboot, so it keeps refusing a claim whose owner is live.

## Hold a device while an external command runs

Tools like `xcrun simctl install` or `expo run:ios` install without going through a session, so they
ignore claims. To keep other sessions off the device while one runs, claim it first with an app-less
`open` on a uniquely named session, and run the command only if the claim succeeds:

```bash
udid=<udid>
claim="build-$$"
agent-device open --platform ios --udid "$udid" --session "$claim" --timeout 600000 || exit
trap 'agent-device close --session "$claim"' EXIT
xcrun simctl install "$udid" ./App.app
```

- `|| exit` stops the script when another session holds the device (`DEVICE_IN_USE`), so the command
  never runs unfenced. Add `--wait <ms>` to `open` to queue for the device instead.
- The script exits with the command's status, as long as the command is the last line. To run
  more after it, save `status=$?` and finish with `exit "$status"`.
- The `trap` closes the session whether the command succeeds or fails. That `close` also shuts down a
  simulator or emulator the `open` booted; add `--shutdown` to shut down one that was already running.
- `open` without an app boots the device if needed and claims it, so the first call on a cold
  simulator can take minutes.
- This is a session claim, not a claim owned by your process. If the shell dies without running its
  `trap` (for example `kill -9`), the session keeps the device until you run
  `agent-device close --session <name>`. Find the name with `agent-device session list`.
  The tool itself is not stopped from touching the device; only other agent-device sessions are
  fenced off.

## Notes

- `open <app>` in an existing session switches the active app and updates the session's bundle id.
  On iOS, to see whether the session app held the foreground during a command, read the
  [`targetActivation` disclosure](/docs/commands#foreground-repairs-on-ios).
- For remote `connect --remote-config` sessions, see [Commands](/docs/commands#remote-metro-workflow).

For replay scripts and deterministic E2E guidance, see [Replay and E2E testing](/docs/replay-e2e).
