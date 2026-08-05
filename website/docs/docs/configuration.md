---
title: Configuration
---

# Configuration

Use configuration for persistent CLI defaults instead of repeating flags on every command. Repository
configuration and operator-controlled configuration have different trust scopes.

## Config file locations

agent-device checks these sources in priority order:

| Priority | Location | Scope |
| --- | --- | --- |
| 1 (lowest) | `~/.agent-device/config.json` | User-level defaults, including connection/provider settings |
| 2 | `./agent-device.json` | Repository-controlled project-safe automation defaults |
| 3 | `AGENT_DEVICE_*` env vars | Override config values |
| 4 (highest) | CLI flags | Override everything |

Project-level values override user-level values where they are permitted. Environment variables override
both. CLI flags always win. `--config <path>` or `AGENT_DEVICE_CONFIG` loads one explicit,
operator-controlled file instead of the default locations.

`./agent-device.json` cannot contain endpoint, credential, daemon transport/server, tenant/run/lease,
provider/cloud, Metro connection, or other operator-controlled fields. The CLI rejects those keys during
parse, before it creates a daemon transport or sends a health request. This prevents a repository from
pairing its chosen endpoint with a token from the user environment or user config.

## Config format

Config files use JSON objects with camelCase keys matching existing CLI flag names.

Environment variables follow the same fields using `AGENT_DEVICE_*` uppercase snake case names, for example:
- `session` -> `AGENT_DEVICE_SESSION`
- `daemonBaseUrl` -> `AGENT_DEVICE_DAEMON_BASE_URL`
- `androidDeviceAllowlist` -> `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`
- `screenshotScale` -> `AGENT_DEVICE_SCREENSHOT_SCALE`

Config and environment sources use canonical option values rather than CLI flag names. Example:
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

Use user config, an explicit config, CLI flags, environment variables, or `connect`/`--remote-config`
for remote connections. For example, a user-owned config may contain:

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
For non-loopback remote daemon URLs, the client still requires authentication. Saved `connect` profiles
and explicit `--remote-config` workflows remain supported; generated profiles do not persist tokens.

Project-safe keys include command defaults such as `platform`, `target`, `device`, `session`,
`snapshotDepth`, recording/capture options, and action timing. Connection and provider keys below are
user- or explicit-config only:

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

Project config can use project-safe command defaults such as `snapshotDepth`, `snapshotScope`, `screenshotScale`, `activity`, `relaunch`, `shutdown`, `fps`, and `quality`. Local path and executable-module selectors such as `stepsFile` and `reporter` are user- or explicit-config only.

`install-from-source` can read a structured GitHub Actions artifact source from user or explicit config when a compatible remote daemon resolves CI artifacts server-side. Repository config rejects this operator-controlled source:

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

Explicit named-session lock defaults use project-safe config and the same env mapping:
- `sessionLock` -> `AGENT_DEVICE_SESSION_LOCK`

Most local automation can omit this because implicit `default` sessions are workspace-scoped; use `sessionLock`, `--session-lock`, or `AGENT_DEVICE_SESSION_LOCK` when intentionally running an explicitly named session.

## Supported environment variables

These env vars are the supported user-facing configuration surface. Other `AGENT_DEVICE_*` names may appear in source, tests, CI, runner logs, or child-process contracts, but they are internal unless documented here or in command-specific docs.

| Category | Env vars | Decision |
| --- | --- | --- |
| CLI defaults and config | `AGENT_DEVICE_CONFIG`, `AGENT_DEVICE_SESSION`, `AGENT_DEVICE_PLATFORM`, `AGENT_DEVICE_SCREENSHOT_SCALE`, `AGENT_DEVICE_SESSION_LOCK`, `AGENT_DEVICE_DAEMON_BASE_URL`, `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, `AGENT_DEVICE_CLOUD_BASE_URL` | Public |
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
- A default `screenshotScale` (or `AGENT_DEVICE_SCREENSHOT_SCALE`) applies to `screenshot`; an explicit `--scale` wins.

This keeps one shared config file usable across different command families.

## Failure behavior

- If `--config` or `AGENT_DEVICE_CONFIG` points to a missing file, agent-device fails during CLI parse before contacting the daemon.
- Invalid JSON, unknown keys, invalid values, or an operator-controlled key in project config also fail during CLI parse with `INVALID_ARGS`. Rejections name the key and never echo its value.
