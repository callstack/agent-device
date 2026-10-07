---
title: Configuration
---

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

When a command fails against a remote daemon, its `Diagnostics Log:` path is on your machine; see
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

Project config can also set `snapshotDepth`, `snapshotScope`, `screenshotScale`, `activity`, `relaunch`, `shutdown`, `fps`, and `quality`. Local paths and executable modules, such as `stepsFile` and `reporter`, are allowed only in user or explicit config.

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

## Supported environment variables

Only the variables below, and those documented on command pages, are supported. Other `AGENT_DEVICE_*` names you may see in logs or source are internal.

| Category | Env vars | Decision |
| --- | --- | --- |
| CLI defaults and config | `AGENT_DEVICE_HOME`, `AGENT_DEVICE_CONFIG`, `AGENT_DEVICE_SESSION`, `AGENT_DEVICE_PLATFORM`, `AGENT_DEVICE_SCREENSHOT_SCALE`, `AGENT_DEVICE_SESSION_LOCK`, `AGENT_DEVICE_DAEMON_BASE_URL`, `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, `AGENT_DEVICE_CLOUD_BASE_URL` | Public |
| Device scoping | `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST` | Public |
| Android test IME | `AGENT_DEVICE_TEST_IME` | Public. Same setting as `--test-ime` / `--no-test-ime` on `open`, `test`, and `replay`; see known limitations. |
| Local daemon storage | `AGENT_DEVICE_STATE_DIR` | Public |
| Metro and install helpers | `AGENT_DEVICE_METRO_BEARER_TOKEN`, `AGENT_DEVICE_BUNDLETOOL_JAR` | Public |
| App hooks and logs | `AGENT_DEVICE_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_APP_LOG_MAX_BYTES`, `AGENT_DEVICE_APP_LOG_MAX_FILES`, `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS`, `AGENT_DEVICE_EVENT_LOG_MAX_BYTES` | Public. Byte caps take whole integers (`5242880`), not `5MB`. |
| Apple runner setup | `AGENT_DEVICE_IOS_TEAM_ID`, `AGENT_DEVICE_IOS_SIGNING_IDENTITY`, `AGENT_DEVICE_IOS_PROVISIONING_PROFILE`, `AGENT_DEVICE_IOS_BUNDLE_ID`, `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH`, `AGENT_DEVICE_IOS_CLEAN_DERIVED`, `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP` | Public operator controls. Cleanup of an `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` override is only automatic for paths under project `.tmp/`; keys in the managed runner cache are swept after a build. `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP` is the number of most-recent runner cache keys per platform folder (for example `ios-simulator` and `ios-device` are counted separately) guaranteed to survive a new build, the new key included (default 3, `0` keeps all). Keys used in the last day, held by a build, or named by a live runner lease also survive, so it is not a hard disk-usage cap. |
| Install/update and platform helpers | `AGENT_DEVICE_NO_UPDATE_NOTIFIER`, `AGENT_DEVICE_MACOS_HELPER_BIN`, `AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION` | Public operator controls |
| macOS app backend | `AGENT_DEVICE_MACOS_APP_BACKEND`, `AGENT_DEVICE_MACOS_GHOST_CURSOR` | Public operator controls, read by the daemon. `native` drives macOS app sessions through the macOS helper instead of XCTest; see [Commands](/docs/commands). Unset or `xctest` uses the runner. The drawn agent pointer adds about 0.3 s to each native click, fill, type, and scroll; `AGENT_DEVICE_MACOS_GHOST_CURSOR=0` turns it off. Restart the daemon after changing either value. |

## Command-specific defaults

A command-specific key applies only to commands that support it, so one config file works across all commands. For example:

- A default `snapshotDepth` applies to `snapshot`, `diff snapshot`, `click`, `fill`, `get`, `wait`, `find`, and `is`.
- The same `snapshotDepth` value is ignored for commands like `open`, `close`, or `devices`.
- A default `screenshotScale` (or `AGENT_DEVICE_SCREENSHOT_SCALE`) applies to `screenshot`; an explicit `--scale` wins.

## When config fails to load

- If `--config` or `AGENT_DEVICE_CONFIG` points to a missing file, the command fails before it contacts the daemon.
- Invalid JSON, unknown keys, invalid values, or an operator-controlled key in project config also fail before the daemon is contacted, with `INVALID_ARGS`. The error names the key and never prints its value.
