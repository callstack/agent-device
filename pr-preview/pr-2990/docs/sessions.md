# Sessions

Sessions keep device state and snapshots consistent across commands.

```bash
agent-device open Settings --platform ios
agent-device session list
agent-device open Contacts          # change app in this workspace's session
agent-device close
```

The implicit session is scoped to the caller's git worktree or current working directory, and to the
platform its command selected: `--platform ios` runs in `ios` and `--platform android` in `android`.
A session opened without `--platform` keeps the platform-less `default` leaf, and commands that name a
platform still join it while they agree with the device it is bound to. Independent agents in
different worktrees do not attach to each other's session.
When a session is established, human output includes a `Session state: <path>` line and JSON output includes `sessionStateDir`; this is the per-session artifact directory that can be inspected or removed after the run. JSON output also includes `runnerLogPath` and `requestLogPath` when available.

Session artifact directories contain per-run evidence for concurrent agents:

- `requests/<request-id>.ndjson` - daemon request diagnostics for this session.
- `events.ndjson` - session event timeline for requests and recorded actions; rotates to `events.ndjson.1` past 5 MB (`AGENT_DEVICE_EVENT_LOG_MAX_BYTES`, whole bytes), with `events.ndjson.window.json` recording each retained generation's first absolute line index, line count, and first-line digest so `events` cursors stay absolute and are verified against the files on disk.
- `runner.log` - Apple runner and `xcodebuild` build/start output for this session.
- `app.log` - app/device logs when `logs start` or `logs clear --restart` is active.

`events.ndjson` is privacy-shaped for automation timelines. It preserves command names, status,
durations, bounded device/app inventory previews, lifecycle outcomes, artifact basenames, and
structural action details such as scroll distance/direction, safe refs, and coordinates.
User-entered text, clipboard contents, push/event payloads, selector values, free-form
flags/messages/paths, and raw unknown command arguments are omitted or replaced with content-free
placeholders. `--no-record` suppresses recorded action entries; request start/finish entries still
record command, status, and timing.

The top-level daemon log is for daemon lifecycle/startup issues. Use the session artifact directory first when debugging a specific run.

Open an explicitly named session only when you intentionally want a shared/reusable handle:

```bash
agent-device open Contacts --platform ios --session my-session
agent-device snapshot -i
agent-device close --session my-session
```

Drive two platforms from one checkout without naming a session: `--platform` selects that platform's
implicit session, so each platform keeps its own device, app, and artifact directory.

```bash
agent-device open Demo --platform ios
agent-device open Demo --platform android   # its own session, not a conflict with the iOS one
agent-device snapshot --platform android
agent-device close --platform ios
```

Once a workspace holds more than one implicit session, a command that names neither `--platform` nor
`--session` refuses with `AMBIGUOUS_MATCH` rather than guessing which device to drive — including
`close`, so add `--platform` (or `--session <address>`) to each teardown line too. `session list`,
`devices`, `doctor`, `capabilities`, and `apps` never claim a session and stay runnable; `session list`
prints the `address` that `--session` accepts.

Shut down the simulator/emulator on close (Apple simulators and Android emulators, prevents resource leakage in CI/multi-tenant workloads):

```bash
agent-device close --shutdown
```

A never-booted iOS Simulator can take several minutes to finish its first boot. Give `open` (or `prepare ios-runner`) a startup budget that covers it; the session's device claim is held from the first `open` onward, so a competing workspace sees `DEVICE_IN_USE` throughout:

```bash
agent-device open Settings --platform ios --udid <udid> --timeout 600000
```

When the device is held by a session that will let go soon — a parallel agent finishing its run — `open --wait <ms>` blocks for the device instead of refusing at once, and reports who holds it while it waits:

```bash
agent-device open Demo --platform android --wait 60000
```

If the budget runs out with the device still busy, the open fails with `DEVICE_IN_USE` naming the owning session address, which `close --session <address>` releases. Every open waiting on a device gets its whole budget: when the holder lets go, the waiting open that did not get the device waits again for what is left of its own budget rather than refusing early, so several agents can queue on one device.

Notes:

- `open <app>` within an existing session switches the active app and updates the session bundle id.
- `open <url>` in iOS sessions opens deep links.
- `open <app> <url>` in iOS sessions opens deep links.
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom scheme URLs require an active app in the session.
- On iOS, `appstate` answers about the session app: its name from the session record and, when a
  runner is live, its `XCUIApplication` state (`state`, `source: runner`). No Apple target answers a
  sessionless foreground probe, so which app is in front is not read; whether the session app held
  the foreground during a command is the [`targetActivation` disclosure](/agent-device/pr-preview/pr-2990/docs/commands.md#foreground-repairs-on-ios).
- For remote `connect --remote-config` sessions, see [Commands](/agent-device/pr-preview/pr-2990/docs/commands.md#remote-metro-workflow).
- Use `--session <name>` for intentional named-session sharing. Do not parallelize mutating commands against the same session; serialize stateful actions such as open, press, fill, type, scroll, back, alert, replay, batch, and close.

For replay scripts and deterministic E2E guidance, see [Replay & E2E](/agent-device/pr-preview/pr-2990/docs/replay-e2e.md).
