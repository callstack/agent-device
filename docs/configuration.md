# Configuration

Set CLI defaults in a config file instead of repeating flags on every command. A repository's
`./agent-device.json` can only set safe command defaults; connection, credential, and provider
settings belong in your user config, an explicit `--config` file, or environment variables.

## Config file locations

agent-device reads these sources in order; later sources override earlier ones:

| Priority | Location | Scope |
| --- | --- | --- |
| 1 (lowest) | `~/.agent-device/config.json` | User-level defaults, including connection/provider settings |
| 2 | `./agent-device.json` | Repository-controlled project-safe automation defaults |
| 3 | `AGENT_DEVICE_*` env vars | Override config values |
| 4 (highest) | CLI flags | Override everything |

Project values override user values for the keys a project may set. Environment variables override
both, and CLI flags always win. `--config <path>` or `AGENT_DEVICE_CONFIG` loads one explicit,
operator-controlled file instead of the default locations.

Set `AGENT_DEVICE_HOME` to an absolute path (or `~/...`) to relocate the user config and
[managed provider plugins](./plugins.md). It does not move daemon state.

`./agent-device.json` cannot contain endpoint, credential, daemon transport/server, tenant/run/lease,
provider/cloud, Metro connection, or other operator-controlled fields. The CLI rejects those keys before
it contacts any daemon, so a repository can't pair an endpoint it chose with a token from your
environment or user config.

## Config format

Config files are JSON objects with camelCase keys that match CLI flag names.

Supported environment variables use `AGENT_DEVICE_` plus the key in uppercase snake case. Not every key has one. For example:
- `session` -> `AGENT_DEVICE_SESSION`
- `daemonBaseUrl` -> `AGENT_DEVICE_DAEMON_BASE_URL`
- `androidDeviceAllowlist` -> `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`
- `screenshotScale` -> `AGENT_DEVICE_SCREENSHOT_SCALE`

Config files and environment variables take option values, not flag names. For example:
- config: `"appsFilter": "user-installed"`
- CLI equivalent: omit `--all`

Example:

```json
{
  "platform": "ios",
  "device": "iPhone 16",
  "session": "qa-ios",
  "snapshotDepth": 3
}
```

Set up remote connections through your user config, an explicit config, CLI flags, environment
variables, or `connect`/`--remote-config`. For example, your user config can contain:

```json
{
  "daemonBaseUrl": "https://bridge.example.com/agent-device",
  "daemonAuthToken": "<operator-managed-token>",
  "daemonTransport": "http",
  "tenant": "ci"
}
```

For CI, provide both `AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN` from
protected, operator-controlled configuration. Do not put either value in `./agent-device.json`.
Remote daemon URLs that aren't loopback always require authentication. Saved `connect` profiles and
explicit `--remote-config` files also work; generated profiles do not store tokens.

When a command fails against a remote daemon, its `Log:` path is on your machine; see
[Capture a clean repro window](/docs/debugging-profiling#capture-a-clean-repro-window).

Project-safe keys include command defaults such as `platform`, `target`, `device`, `session`,
`snapshotDepth`, recording/capture options, and action timing. These keys are allowed only in user or
explicit config:

- `stateDir`
- `daemonBaseUrl`
- `daemonAuthToken`
- `daemonTransport`
- `daemonServerMode`
- `tenant`
- `sessionIsolation`
- `runId`
- `leaseId`
- `leaseBackend`
- provider/cloud fields (`provider*`, `aws*`)
- Metro endpoint/token fields (`metro*`, `bundleUrl`)
- request headers and structured install sources
- local code and write destinations (`reporter`, `reportJunit`, `saveScript`, `launchConsole`)
- `postGestureStabilization: false`, which skips the directional scroll `movement` check and the wait that keeps the first read after a scroll or swipe from a tree still in motion, and the first-screen wait after `open` on a local iOS simulator; see [Scroll](/docs/commands#scroll)

Project config can also set `snapshotDepth`, `snapshotScope`, `screenshotScale`, `activity`, `relaunch`, `shutdown`, `fps`, and `quality`. Local paths and executable modules, such as `stepsFile` and `reporter`, are allowed only in user or explicit config.
The `record` config key and `AGENT_DEVICE_RECORD` were removed. `--record` is per-invocation only: pass it on the command, or set `record: true` in an SDK/MCP call, to keep a corrective read in a healed script.

`install-from-source` can read a GitHub Actions artifact source from user or explicit config when the remote daemon supports resolving CI artifacts. Repository config rejects this key:

```json
{
  "platform": "android",
  "installSource": {
    "type": "github-actions-artifact",
    "repo": "thymikee/RNCLI83",
    "artifact": "rn-android-emulator-debug-pr-19"
  }
}
```

Use a numeric `artifact` value for an artifact ID. Use a string `artifact` value for an artifact name.

Project config can set a default lock mode for named sessions with `sessionLock`
(`AGENT_DEVICE_SESSION_LOCK`). See [Lock a named session to a device](/docs/sessions#lock-a-named-session-to-a-device).

## Pin a project to one device

Set `devicePin` in `agent-device.json` to keep commands on the device you choose:

```json
{
  "devicePin": {
    "platform": "ios",
    "device": "iPad Pro"
  }
}
```

Commands without selectors use the pin. A conflicting CLI selector or MCP input fails
with `INVALID_ARGS` and `details.reason: "device_pin_conflict"`. The error names the
config file and pinned selector. Edit or remove `devicePin` in that file to change the pin.

A pin accepts `platform`, `device`, `udid`, and `serial`. Set at least one key. Use a UDID
or serial to pin one device when several devices share the same name. You can add selectors
to narrow a pin, such as `--udid` with a pinned device name, but the selected device must
match every pinned value. Device names use the same matching rules as `--device`.

The pin takes precedence over ordinary config and environment defaults. Explicit selectors,
remote connection defaults, and batch steps must agree with it. The CLI and MCP read the
pin from configuration; tool input cannot replace or disable it. The daemon also checks the
selected device before giving a command access to it, including commands in batch and replay.

You can also set a pin in your user config or a file selected with `--config` or
`AGENT_DEVICE_CONFIG`. A project pin replaces the entire user pin; their selector fields
are not merged. An explicit config file replaces both user and project files. Other
`AGENT_DEVICE_*` defaults do not change the pin. There is no `--device-pin` flag or pin
environment variable.

Without `devicePin`, top-level `platform`, `device`, `udid`, and `serial` values remain
overridable defaults. A [session lock](/docs/sessions#lock-a-named-session-to-a-device)
protects a named session after it is bound; a pin also applies before a session exists.

## Supported environment variables

Only the variables below, and those documented on command pages, are supported. Other `AGENT_DEVICE_*` names you may see in logs or source are internal.

| Category | Env vars | Decision |
| --- | --- | --- |
| CLI defaults and config | `AGENT_DEVICE_HOME`, `AGENT_DEVICE_CONFIG`, `AGENT_DEVICE_SESSION`, `AGENT_DEVICE_PLATFORM`, `AGENT_DEVICE_SCREENSHOT_SCALE`, `AGENT_DEVICE_SESSION_LOCK`, `AGENT_DEVICE_DAEMON_BASE_URL`, `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, `AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS`, `AGENT_DEVICE_CLOUD_BASE_URL` | Public. `AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS` is the ceiling (a positive integer number of milliseconds, default `120000`; any other value fails with `INVALID_ARGS` before a daemon spawns, and only when the client must start a daemon — a client that attaches to or reuses a running daemon never reads it) a client waits for a local daemon it starts to register; CLI, MCP, and Node clients share it. A live daemon is waited for while it records startup progress, so an overloaded host slows startup instead of failing it. A failed startup names the outcome in `details.reason`: `startup-exited` (the process ended before registering), `startup-stalled` (alive, no startup progress for a fixed 60 s window this variable does not change), or `startup-ceiling` (a startup was still live when the ceiling passed — this client's daemon or another client's; the client stops its own launch and never signals another client's live daemon. Only a progressing own launch outlasts the fixed stall window). Branch on `details.reason`, never on the message. |
| Device scoping | `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`, `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET` | Public. `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET` is read by the daemon: every iOS simulator request that names no `--ios-simulator-device-set` uses that set, so iOS physical devices are not listed, and a request naming a different path string fails with `INVALID_ARGS` (`details.reason: "ios_simulator_device_set_outside_daemon_set"`). macOS and non-iOS requests ignore it. A daemon started by the CLI inherits the CLI's value; restart the daemon after changing it. |
| Android test IME | `AGENT_DEVICE_TEST_IME` | Public. Same setting as `--test-ime` / `--no-test-ime` on `open`, `test`, and `replay`; see known limitations. |
| Local daemon storage | `AGENT_DEVICE_STATE_DIR` | Public. The daemon and the CLI store the daemon's record, lock, log, and recordings there, so the directory must belong to you alone: a real directory, not a symbolic link, that you own with mode `0700`, with every directory above it owned by you or root and not writable by group or other users (a shared directory that is sticky, like `/tmp`, is allowed). Every route that starts, attaches to, stops or reports on the daemon checks that first, before it reads or writes anything there. A missing directory is created at `0700` when a command starts a daemon, and is left missing when a command only reports. A directory you own that is open to the group or other users is closed to `0700` by that check, so a directory created by another program under a permissive umask, or left open by an older version, never stops the daemon. Anything else fails the check, with `details.reason: "daemon_state_root_unsafe"`, naming the directory and the step that ends it: `details.fix` runs `chmod 700` on that directory, or points `AGENT_DEVICE_STATE_DIR` at a real private directory you own, such as `$HOME/.agent-device`, when even that change is refused. For anything besides the mode bits it names that move, because a mode change cannot make a symbolic link, another owner's directory, or a directory other accounts can write private. The check reads owner and mode bits and symbolic links, so it applies on macOS and Linux. On Windows agent-device only rejects a path shape it cannot support — a network path such as `\\server\share`, a device path such as `\\.\pipe\`, or a drive-relative path such as `C:state` — because there protection between accounts is not a question of mode bits, and a missing directory is still created when a command starts a daemon. |
| Recording helper cache | `AGENT_DEVICE_SWIFT_CACHE_DIR` | Public operator control, read on macOS hosts. Recording compiles small Swift helpers and caches them here. The default is `~/Library/Caches/agent-device/swift-cache`. You or root must own the directory and every directory above it, and the group and other users must not have write access to any of them, even with the sticky bit set. A normal home directory at mode `0755` or `0750` is acceptable, and so are root-owned system directories such as `/Users`. A directory such as `/tmp` is refused. When the rule fails, recording refuses with `details.reason: "swift_cache_untrusted"`. The fix depends on which directory the refusal reports. For the cache root or a directory above it: if the group or other users can write to it, remove that access with `chmod g-w,o-w`; if another user owns it, or if it is a symbolic link, set this variable to a directory that only you can write. For `v3` or a directory inside it (`bin`, `home` and `module-cache`): agent-device creates these at mode `0700` and never deletes them, so if one of them is open to the group or other users, is a symbolic link, or is owned by another user, set this variable to a new directory that only you can write, or remove the reported directory yourself. Do not use `chmod` on it: that clears the refusal but keeps anything written while the directory was open. When recording compiles a Swift helper, it also checks the Xcode that `DEVELOPER_DIR` selects. A helper that is already compiled and cached is reused without checking that selection, so the same value can pass while the cache is warm and be refused when a helper next needs to compile. If that directory, or a directory above it, is owned by another user or open to the group or other users, recording refuses with `details.exposure: "untrusted_developer_dir"`. `/Applications` is the one exception, as stock macOS sets it up. A daemon keeps the `DEVELOPER_DIR` it started with, so unsetting it in your shell is not enough. To fix this, restart the daemon with `DEVELOPER_DIR` unset, or pass `DEVELOPER_DIR=''` to one local command to select the system default, or point it at an Xcode `Contents/Developer` directory, given as an absolute path, that you or root own along with every directory above it. agent-device checks only owner and mode bits, not ACLs. This applies to the default location and to an override. You must make sure that no ACL gives write access to another user. |
| Metro and install helpers | `AGENT_DEVICE_METRO_BEARER_TOKEN`, `AGENT_DEVICE_BUNDLETOOL_JAR` | Public |
| App hooks and logs | `AGENT_DEVICE_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_APP_LOG_MAX_BYTES`, `AGENT_DEVICE_APP_LOG_MAX_FILES`, `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS`, `AGENT_DEVICE_EVENT_LOG_MAX_BYTES` | Public. Byte caps take whole integers (`5242880`), not `5MB`. |
| Apple runner setup | `AGENT_DEVICE_IOS_TEAM_ID`, `AGENT_DEVICE_IOS_SIGNING_IDENTITY`, `AGENT_DEVICE_IOS_PROVISIONING_PROFILE`, `AGENT_DEVICE_IOS_BUNDLE_ID`, `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH`, `AGENT_DEVICE_IOS_CLEAN_DERIVED`, `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP` | Public operator controls. Cleanup of an `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` override is only automatic for paths under project `.tmp/`; keys in the managed runner cache are swept after a build. `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP` is the number of most-recent runner cache keys per platform folder (for example `ios-simulator` and `ios-device` are counted separately) guaranteed to survive a new build, the new key included (default 3, `0` keeps all). Keys used in the last day, held by a build, or named by a live runner lease also survive, so it is not a hard disk-usage cap. |
| Install/update and platform helpers | `AGENT_DEVICE_NO_UPDATE_NOTIFIER`, `AGENT_DEVICE_MACOS_HELPER_BIN`, `AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION` | Public operator controls |
| macOS app backend | `AGENT_DEVICE_MACOS_APP_BACKEND`, `AGENT_DEVICE_MACOS_GHOST_CURSOR` | Public operator controls, read by the daemon. `native` drives macOS app sessions through the macOS helper instead of XCTest; see [Desktop targets](/docs/commands#desktop-targets). Unset or `xctest` uses the runner. The drawn agent pointer adds about 0.3 s to each native click, fill, type, and scroll; `AGENT_DEVICE_MACOS_GHOST_CURSOR=0` turns it off. Restart the daemon after changing either value. |

## Command-specific defaults

A command-specific key applies only to commands that support it, so one config file works across all commands. For example:

- A default `snapshotDepth` applies to `snapshot`, `diff snapshot`, `click`, `fill`, `get`, `wait`, `find`, and `is`.
- The same `snapshotDepth` value is ignored for commands like `open`, `close`, or `devices`.
- A default `screenshotScale` (or `AGENT_DEVICE_SCREENSHOT_SCALE`) applies to `screenshot`; an explicit `--scale` wins.

## When config fails to load

- If `--config` or `AGENT_DEVICE_CONFIG` points to a missing file, the command fails before it contacts the daemon.
- Invalid JSON, unknown keys, invalid values, or an operator-controlled key in project config also fail before the daemon is contacted, with `INVALID_ARGS`. The error names the key and never prints its value.
