---
title: Configuration
---

# Configuration

Create an `agent-device.json` file to set persistent CLI defaults instead of repeating flags on every command.

## Config file locations

agent-device checks these sources in priority order:

| Priority | Location | Scope |
| --- | --- | --- |
| 1 (lowest) | `~/.agent-device/config.json` | User-level defaults |
| 2 | `./agent-device.json` | Project-level overrides |
| 3 | `AGENT_DEVICE_*` env vars | Override config values |
| 4 (highest) | CLI flags | Override everything |

Project-level values override user-level values. Environment variables override both. CLI flags always win.

Use `--config <path>` or `AGENT_DEVICE_CONFIG` to load one specific config file instead of the default locations.

## Config format

Config files use JSON objects with camelCase keys matching existing CLI flag names.

Environment variables follow the same fields using `AGENT_DEVICE_*` uppercase snake case names, for example:
- `session` -> `AGENT_DEVICE_SESSION`
- `daemonBaseUrl` -> `AGENT_DEVICE_DAEMON_BASE_URL`
- `androidDeviceAllowlist` -> `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`

Config and environment sources use canonical option values rather than CLI flag names. Example:
- config: `"appsFilter": "user-installed"`
- CLI equivalent: omit `--all`

Example:

```json
{
  "platform": "ios",
  "device": "iPhone 16",
  "session": "qa-ios",
  "snapshotDepth": 3,
  "daemonBaseUrl": "http://127.0.0.1:4310/agent-device"
}
```

For non-loopback remote daemon URLs, also set `daemonAuthToken` or `AGENT_DEVICE_DAEMON_AUTH_TOKEN`. The client rejects non-loopback remote daemon URLs without auth.

Common keys include:
- `stateDir`
- `daemonBaseUrl`
- `daemonAuthToken`
- `tenant`
- `sessionIsolation`
- `runId`
- `leaseId`
- `leaseBackend`
- `sessionLock`
- `platform`
- `target`
- `device`
- `udid`
- `serial`
- `iosSimulatorDeviceSet`
- `androidDeviceAllowlist`
- `session`
- `verbose`
- `json`

Command-specific defaults are supported too, for example `snapshotDepth`, `snapshotScope`, `activity`, `relaunch`, `shutdown`, `fps`, `quality`, `stepsFile`, or `saveScript`.

`install-from-source` can also read a structured GitHub Actions artifact source from config when a compatible remote daemon resolves CI artifacts server-side:

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

Explicit named-session lock defaults use the same config and env mapping too:
- `sessionLock` -> `AGENT_DEVICE_SESSION_LOCK`

Most local automation can omit this because implicit `default` sessions are workspace-scoped; use `sessionLock`, `--session-lock`, or `AGENT_DEVICE_SESSION_LOCK` when intentionally running an explicitly named session.

## Supported environment variables

These env vars are the supported user-facing configuration surface. Other `AGENT_DEVICE_*` names may appear in source, tests, CI, runner logs, or child-process contracts, but they are internal unless documented here or in command-specific docs.

| Category | Env vars | Decision |
| --- | --- | --- |
| CLI defaults and config | `AGENT_DEVICE_CONFIG`, `AGENT_DEVICE_SESSION`, `AGENT_DEVICE_PLATFORM`, `AGENT_DEVICE_SESSION_LOCK`, `AGENT_DEVICE_DAEMON_BASE_URL`, `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, `AGENT_DEVICE_CLOUD_BASE_URL` | Public |
| Device scoping | `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST` | Public |
| Local daemon storage | `AGENT_DEVICE_STATE_DIR` | Public |
| Metro and install helpers | `AGENT_DEVICE_METRO_BEARER_TOKEN`, `AGENT_DEVICE_BUNDLETOOL_JAR` | Public |
| App hooks and logs | `AGENT_DEVICE_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_APP_LOG_MAX_BYTES`, `AGENT_DEVICE_APP_LOG_MAX_FILES`, `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` | Public |
| Apple runner setup | `AGENT_DEVICE_IOS_TEAM_ID`, `AGENT_DEVICE_IOS_SIGNING_IDENTITY`, `AGENT_DEVICE_IOS_PROVISIONING_PROFILE`, `AGENT_DEVICE_IOS_BUNDLE_ID`, `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH`, `AGENT_DEVICE_IOS_CLEAN_DERIVED` | Public operator controls. Cleanup is only automatic for override paths under project `.tmp/`. |
| Install/update and platform helpers | `AGENT_DEVICE_NO_UPDATE_NOTIFIER`, `AGENT_DEVICE_MACOS_HELPER_BIN`, `AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION` | Public operator controls |

## Command-specific defaults

Command-specific keys are applied only when the current command supports them.

Examples:
- A default `snapshotDepth` applies to `snapshot`, `diff snapshot`, `click`, `fill`, `get`, `wait`, `find`, and `is`.
- The same `snapshotDepth` value is ignored for commands like `open`, `close`, or `devices`.

This keeps one shared config file usable across different command families.

## Failure behavior

- If `--config` or `AGENT_DEVICE_CONFIG` points to a missing file, agent-device fails during CLI parse before contacting the daemon.
- Invalid JSON, unknown keys, or invalid values in config files also fail during CLI parse with `INVALID_ARGS`.
