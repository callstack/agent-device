---
title: Security & Trust
description: Security and trust guidance for agent-device local app automation, device permissions, screenshots, recordings, logs, network dumps, traces, and reports.
---

# Security & Trust

`agent-device` runs locally by default and controls the devices, simulators, emulators, and desktop apps available to the current user. Treat it like any other developer tool that can interact with apps, capture screens, and read diagnostic output.

## Local control

- Device automation runs through the installed CLI and platform tooling such as Xcode, ADB, macOS accessibility APIs, and Linux AT-SPI.
- The MCP server exposes direct structured tools for `agent-device` commands. Tools use command contracts through `AgentDeviceClient`; local-only workflows stay CLI-only rather than subprocess fallbacks. It does not expose generic shell execution over MCP.
- Mutating commands should run serially against one session. Use separate sessions/devices for parallel work.

## Daemon trust model

CLI commands run through a per-user background daemon:

- The daemon binds to `127.0.0.1` only, on ephemeral ports, for both its socket and HTTP transports. It is never reachable from the network unless you deliberately front it with your own proxy.
- Command (RPC), upload, and artifact-download requests must present a token generated fresh on each daemon boot (24 random bytes). The only unauthenticated endpoint is `GET /health`, which intentionally returns a bare liveness response and nothing else; like the rest of the server it is reachable only via loopback. The token is stored in `daemon.json` inside the daemon state directory (`~/.agent-device` for packaged installs; source checkouts use a worktree-scoped directory under `~/.agent-device/dev/`) with `0600` permissions; whoever can read that file already has your user account.
- A client only reuses a running daemon when the daemon's version and binary code signature match its own; otherwise the daemon is restarted. This prevents a stale or tampered daemon from silently serving new clients.
- Artifact uploads are size-capped, filenames are sanitized, and archive extraction rejects path-traversal entries. Artifact downloads resolve through server-side IDs, never client-supplied paths.

For remote or cloud deployments, the daemon supports a custom auth hook: `AGENT_DEVICE_HTTP_AUTH_HOOK` names a module path that is dynamically imported and invoked for each HTTP request (with `AGENT_DEVICE_HTTP_AUTH_EXPORT` selecting the export). The hook runs with the daemon's full privileges, so treat it as part of your trusted computing base: point it only at a read-only path you control, never at a location writable by less-trusted users or processes. Whoever controls the daemon's environment controls the hook.

## Sensitive artifacts

Screenshots, recordings, traces, logs, network dumps, replay files, provider-hosted cloud videos/logs, and reports can contain private UI state, credentials, tokens, request data, or customer information. Store them in a controlled directory, review before sharing, and avoid committing artifacts unless they are intentionally sanitized fixtures.

Cloud provider artifact URLs returned by `artifacts`, `close --json`, or `disconnect --json` may be provider dashboard URLs, public share links, or pre-signed download URLs. Treat the URLs themselves as sensitive credentials until you know the provider's sharing and expiry policy.

## Permissions

Some targets require local permissions or developer setup:

- iOS/tvOS/macOS automation uses Xcode tooling and may require signing or Developer Mode for physical devices.
- Android automation uses ADB and connected emulator/device trust.
- macOS desktop automation requires Accessibility permission, and screen capture workflows may require Screen Recording permission.

## Network and updates

Interactive CLI runs may check npm for newer `agent-device` releases and print an upgrade suggestion. Set `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1` to disable the notice.

Network inspection commands only collect traffic available to the active app/session tooling. Review network artifacts before sharing because headers and payloads can contain secrets.

## Responsible disclosure

Report security issues by contacting Callstack privately at hello@callstack.com. Do not open a public issue for a vulnerability that exposes user data, credentials, device access, or remote execution risk.
