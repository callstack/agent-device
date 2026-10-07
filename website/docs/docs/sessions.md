---
title: Sessions
---

# Sessions

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
platform still join it as long as they match its device. Agents in different worktrees never attach
to each other's session.

## Find a session's logs and artifacts

When a session starts, human output prints a `Session state: <path>` line and JSON output includes
`sessionStateDir`. That directory holds the session's artifacts; inspect or delete it after the run.
JSON output also includes `runnerLogPath` and `requestLogPath` when available.

Each session artifact directory contains:

- `requests/<request-id>.ndjson` - daemon request diagnostics for this session.
- `events.ndjson` - session event timeline for requests and recorded actions; rotates to `events.ndjson.1` past 5 MB (`AGENT_DEVICE_EVENT_LOG_MAX_BYTES`, whole bytes), with `events.ndjson.window.json` tracking the retained files so `events` cursors stay valid across rotation.
- `runner.log` - Apple runner and `xcodebuild` build/start output for this session.
- `app.log` - app/device logs when `logs start` or `logs clear --restart` is active.

`events.ndjson` leaves out private content. It keeps command names, status,
durations, bounded device/app inventory previews, lifecycle outcomes, artifact basenames, and
structural action details such as scroll distance/direction, safe refs, and coordinates.
User-entered text, clipboard contents, push/event payloads, selector values, free-form
flags/messages/paths, and raw unknown command arguments are omitted or replaced with content-free
placeholders. `--no-record` suppresses recorded action entries; request start/finish entries still
record command, status, and timing.

To debug a specific run, start with the session artifact directory. The top-level daemon log only
covers daemon startup and lifecycle issues.

## Share a session by name

Name a session only when you want a shared, reusable handle:

```bash
agent-device open Contacts --platform ios --session my-session
agent-device snapshot -i
agent-device close --session my-session
```

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

Add `--shutdown` to shut down an Apple simulator or Android emulator when you close the session. Use it
in CI and on shared hosts so devices don't keep running after the run:

```bash
agent-device close --shutdown
```

## Wait for a slow or busy device

A never-booted iOS Simulator can take several minutes to finish its first boot. Give `open` (or
`prepare ios-runner`) a `--timeout` long enough to cover it. The session claims the device from the
first `open` onward, so another workspace gets `DEVICE_IN_USE` the whole time:

```bash
agent-device open Settings --platform ios --udid <udid> --timeout 600000
```

When another session holds the device but will release it soon — a parallel agent finishing its run —
`open --wait <ms>` waits for the device instead of failing at once, and reports who holds it while it
waits:

```bash
agent-device open Demo --platform android --wait 60000
```

If the wait runs out while the device is still busy, `open` fails with `DEVICE_IN_USE` and names the
session address that holds it; `close --session <address>` releases it. Each waiting `open` gets its
full wait: if another waiter gets the device first, the rest keep waiting for what is left of their own
budget, so several agents can queue on one device.

## Notes

- `open <app>` in an existing session switches the active app and updates the session's bundle id.
- `open <url>` in iOS sessions opens deep links.
- `open <app> <url>` in iOS sessions opens deep links.
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom scheme URLs require an active app in the session.
- On iOS, `appstate` reports on the session app: its name from the session record and, when a
  runner is live, its `XCUIApplication` state (`state`, `source: runner`). It can't tell you which
  app is in the foreground, because no Apple target reports that outside a session. To see whether the
  session app held the foreground during a command, read the [`targetActivation` disclosure](/docs/commands#foreground-repairs-on-ios).
- For remote `connect --remote-config` sessions, see [Commands](/docs/commands#remote-metro-workflow).
- Use `--session <name>` to share a named session on purpose. Don't run commands that change state in parallel on the same session; run actions such as open, press, fill, type, scroll, back, alert, replay, batch, and close one at a time.

For replay scripts and deterministic E2E guidance, see [Replay & E2E](/docs/replay-e2e).
