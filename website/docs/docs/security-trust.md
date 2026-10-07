---
title: Security & Trust
description: Security and trust guidance for agent-device local app automation, device permissions, screenshots, recordings, logs, network dumps, audio probes, traces, and reports.
---

# Security & Trust

`agent-device` runs locally by default and can control every device, simulator, emulator, and desktop app your user account can reach. Treat it like any developer tool that interacts with apps, captures screens, and reads diagnostic output.

## Local control

- Device automation runs through the installed CLI and platform tooling such as Xcode, ADB, Amazon Vega CLI/VDA, macOS accessibility APIs, and Linux AT-SPI.
- The MCP server exposes structured tools for `agent-device` commands. Local-only workflows stay CLI-only. The MCP server never exposes generic shell execution.
- Run mutating commands serially against one session. For parallel work, use separate sessions and devices.

## Daemon trust model

CLI commands run through a per-user background daemon:

- The daemon binds to `127.0.0.1` only, on ephemeral ports, for both its socket and HTTP transports. It is not reachable from the network unless you put your own proxy in front of it.
- Command (RPC), upload, artifact-download, and `/admin/human-control/*` requests must present a token that the daemon generates fresh on each start (24 random bytes). The only unauthenticated endpoint is `GET /health`, which returns only liveness, package and protocol version, instance ID, and host CPU architecture; like the rest of the server, it is reachable only over loopback. The token is stored in `daemon.json` inside the daemon state directory (`~/.agent-device` for packaged installs; source checkouts use a worktree-scoped directory under `~/.agent-device/dev/`) with `0600` permissions. Anyone who can read that file already has your user account.
- A client reuses a running daemon only when the daemon runs the same version and the same code. Two installs of the same published version share one daemon. An older client refuses to replace a reachable daemon on a newer version, so it does not disrupt that daemon's sessions; upgrade the client instead. Any other mismatch, such as a source checkout against an install, restarts the daemon instead of running code the client cannot identify. The code check compares file sizes and timestamps, not contents, so it does not detect an install whose files were hand-replaced under the same version.
- Artifact uploads are size-capped, filenames are sanitized, and archive extraction rejects path-traversal entries. Artifact downloads resolve through server-side IDs, never client-supplied paths.
- `install-from-source` protects the daemon host while it downloads and extracts the artifact; it does not vouch for the app inside. An app installed and launched on an iOS simulator runs as a process on the host Mac, so treat permission to send install requests as permission to run code on that Mac.

For remote or cloud deployments, you can add a custom auth hook for remotely consumable HTTP routes: set `AGENT_DEVICE_HTTP_AUTH_HOOK` to a module path that the daemon imports, and `AGENT_DEVICE_HTTP_AUTH_EXPORT` to select the export. The host-local `/admin/human-control/*` route uses the daemon token instead. The hook runs with the daemon's full privileges, so treat it as trusted code: point it only at a read-only path you control, never at a location that less-trusted users or processes can write to. Whoever controls the daemon's environment controls the hook.

Lease-owner human-control RPCs pass normal authentication and tenant/lease admission. They can
target only the admitted lease's device and cannot alter a host administrator's hold. Host
administration is a separate capability: the daemon accepts `/admin/human-control/*` only on its
loopback listener with the local daemon token, and `agent-device proxy` does not forward `/admin/*`.
Holds and leases live in memory; neither survives a daemon restart.

When a hook is configured, it must attest a `tenantId` on every request it wants admitted. If the hook's result has no `tenantId`, the daemon rejects the request with 401. It never falls back to a tenant the client declares (RPC body `meta.tenantId` or `flags.tenant`, or the `x-agent-device-tenant` header on the upload, artifact-download, and diagnostics routes), and it never admits the request unscoped. This keeps a caller with a shared token from claiming another tenant's identity, or from reading a tenant-owned session or artifact by declaring no tenant. Deployments without a hook are unaffected.

## Sensitive artifacts

Screenshots, recordings, traces, logs, network dumps, audio probes, replay files, provider-hosted cloud videos and logs, and reports can contain private UI state, credentials, tokens, request data, timing signals, or customer information. Store them in a controlled directory, review them before sharing, and don't commit them unless they are deliberately sanitized fixtures.

Cloud provider artifact URLs returned by `artifacts`, `close --json`, or `disconnect --json` may be provider dashboard URLs, public share links, or pre-signed download URLs. Treat the URLs themselves as credentials until you know the provider's sharing and expiry policy.

## Permissions

Some targets require local permissions or developer setup:

- iOS, tvOS, and macOS automation uses Xcode tooling; physical devices may require signing or Developer Mode.
- Android automation uses ADB and requires a trusted emulator or device connection.
- Vega OS automation uses Vega CLI/VDA with the local Vega Virtual Device only; `agent-device` does not control physical Fire TV devices.
- macOS desktop automation requires Accessibility permission, and screen capture workflows may require Screen Recording permission.

## Network and updates

Interactive CLI runs may check npm for newer `agent-device` releases and print an upgrade suggestion. Set `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1` to turn off the notice.

Network inspection commands collect only the traffic that the active app or session tooling can see. Review network artifacts before sharing, because headers and payloads can contain secrets.

## Report a vulnerability

Report security issues privately to Callstack at hello@callstack.com. Do not open a public issue for a vulnerability that exposes user data, credentials, device access, or remote execution risk.
