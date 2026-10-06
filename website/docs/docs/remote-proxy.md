---
title: Remote Proxy
description: Run agent-device on a Mac with simulator or device access and control it from another machine through an HTTP tunnel.
---

# Remote Proxy

Use `agent-device proxy` when the machine running your agent cannot access the iOS simulator, Android emulator, or physical device directly, but another Mac can. The proxy runs on the device host, fronts the local daemon over HTTP, and lets a remote `agent-device` client call it through cloudflared, ngrok, or another tunnel.

This is a direct bearer-token flow. It does not use `agent-device auth`.

## Host Machine

On the Mac with simulator or device access:

```bash
agent-device proxy --port 4310
```

The command prints the local proxy URL and a `daemon auth token`. Keep the token secret; anyone with it can control the proxied daemon.

Expose the proxy with your tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:4310
# or
ngrok http 4310
```

By default the proxy binds `127.0.0.1`. Use `--host 0.0.0.0` only when you intentionally want the proxy reachable on the host network.

## Remote Client

On the machine running the agent, connect to the public tunnel origin with the `/agent-device` base path and the printed token. The generated connection profile never stores the token (only routing metadata), so export it once and every command in the session picks it up:

```bash
export AGENT_DEVICE_DAEMON_AUTH_TOKEN=<token>
agent-device connect proxy --daemon-base-url https://example.trycloudflare.com/agent-device
agent-device devices --platform ios
agent-device open MyApp --platform ios
agent-device snapshot --platform ios
agent-device close
agent-device disconnect
```

Passing `--daemon-auth-token <token>` instead of exporting the environment variable also works, but only authenticates the single command it is passed to; subsequent commands need the token again through the env var, a `daemonAuthToken` entry in your remote config profile, or a repeated `--daemon-auth-token` flag.

`connect proxy` stores the proxy profile and client identity. Device leases are automatic on `open` and expire after five minutes without commands. That five minutes is the window `open` asks for; a lease allocated directly over the RPC without `ttlMs` keeps the daemon's one-minute inactivity default instead. Either window starts when allocation completes, not when it was requested. `close` releases the active session and device lease, except a lease allocated with `retainOnClose`, which only `leases.release`, expiry, or daemon shutdown ends; `disconnect` clears local connection state.

Multiple agents can share one proxy when each uses the normal `connect proxy`, `open`, commands, `close`, and `disconnect` flow. A busy device error means another agent owns the device until it closes or its inactivity lease expires.

Do not put proxy endpoint, token, tenant, or provider fields in `./agent-device.json`: repository
configuration is intentionally limited to project-safe automation defaults. Use `connect proxy`, user
config, an explicit `--config` file, or protected CI environment variables for the endpoint and token.

## Human Takeover

With a remote device already leased by `open`, pause mutations through the same connection:

```bash
agent-device takeover --session remote-session
```

The foreground command renews its hold until Ctrl+C. Read-only diagnostics remain available, the
agent session stays open, and its lease is protected from inactivity expiry. Activation waits for
already-admitted mutations to finish. Status and recovery use `takeover status` and
`takeover release <hold-id>` with the same session.

If the requesting connection disconnects while activation is waiting for mutations to finish, its
pending hold is removed and cannot activate later. This applies to both tenant RPCs and host PUTs.
Once active, holds follow their configured TTL or explicit release lifecycle.

Lease-owner operations use ordinary `agent_device.command` RPCs at `POST /rpc`, with command
`human_control` and positionals `["list"]`, `["put", "<hold-id>", "{\"ttlMs\":15000}"]`, or
`["remove", "<hold-id>"]`. Supply the same tenant, run, client, lease, backend, provider, and device
metadata as other requests. The PUT payload contains only `reason` and `ttlMs`; the server derives
the target from the admitted lease. It rejects caller-supplied `scope`.

### Host administration

VM-side automation can manage holds independently of a tenant. Read the daemon's `httpPort` and
`token` from `daemon.json` in its effective state directory, then use the loopback listener with
`Authorization: Bearer <daemon-token>` or `X-Agent-Device-Token: <daemon-token>`. An HTTP listener
is required. A tenant credential does not grant this capability.

```text
PUT    /admin/human-control/holds/<hold-id>
GET    /admin/human-control/holds
DELETE /admin/human-control/holds/<hold-id>
```

The host PUT body names the exact lease contention identity, including its backend and provider.
Use the lease's `deviceKey`, not a bare device ID or a display name:

```json
{
  "scope": {
    "backend": "ios-instance",
    "leaseProvider": "proxy",
    "deviceKey": "ios:mobile:<simulator-udid>"
  },
  "reason": "Human is using the VM console.",
  "ttlMs": 15000
}
```

Repeated PUT renews the hold. Omitting `ttlMs` keeps it until explicit release or daemon shutdown.
Tenant RPCs cannot modify host holds. Multiple holds can coexist; mutations resume only when all
holds on the device end.

Holds do not survive daemon restart, matching lease state. Reconnect and re-establish the hold
before continuing human interaction. Local takeover without a device-scoped remote lease is
deferred; this does not provide a host-global fence across local daemons.

### Leasing one macOS app

A host can hand a client one macOS app instead of a device. A `macos-app` lease names that app by
bundle id, optionally pinned to one process (`<bundleId>@<pid>`). Only the host allocates it, on the
same loopback listener and daemon token as host holds; a tenant `lease_allocate` for `macos-app` is
refused:

```text
PUT    /admin/leases/<lease-id>
GET    /admin/leases
DELETE /admin/leases/<lease-id>
```

```json
{
  "tenantId": "host-tenant",
  "runId": "run-1",
  "clientId": "client-1",
  "leaseBackend": "macos-app",
  "leaseProvider": "proxy",
  "deviceKey": "com.example.app@12345",
  "ttlMs": 300000
}
```

The lease id is 16 to 128 hex characters the host chooses. Repeating the PUT renews the lease; a PUT
that names another scope for an existing id is refused. The lease stays allocated across the
client's `close` unless the body sets `retainOnClose: false`, and DELETE revokes it at once. It
expires after `ttlMs` without a renewal or a client request, like any lease. A client heartbeat can
shorten that window but never extend it past the `ttlMs` of the last PUT. A client cannot release
it: `disconnect` drops only its local connection state, and a tenant `lease_release` is refused
with `MACOS_APP_LEASE_HOST_OWNED`.

The client connects with a remote config that names the lease, and runs `open <bundleId>`:

```json
{
  "daemonBaseUrl": "https://<tunnel-url>",
  "daemonAuthToken": "<client-token>",
  "tenant": "host-tenant",
  "runId": "run-1",
  "clientId": "client-1",
  "leaseId": "<lease-id>",
  "leaseBackend": "macos-app",
  "leaseProvider": "proxy",
  "deviceKey": "com.example.app@12345",
  "platform": "macos"
}
```

Requests under a `macos-app` lease are limited to `open`, `close`, `snapshot`, `wait`,
`find`, `get`, `is`, `click`, `fill`, `press`, `type`, `focus`, `scroll`, `screenshot`, and `batch`,
plus the lease's own heartbeat and release; `doctor`, `devices`, `session list` and the other
inventory commands are refused too.
`open` and `close` accept only the leased bundle id, only the `app` surface is allowed, screenshots
capture only the app window, inputs that name a host path or a launch (`--save-script`,
`--launch-url`, `--launch-console`, a screenshot path other than the client's own temp file) are
refused, device selectors (`--udid`, `--serial`, `--device`, `--target`) are refused, `open` and
`batch` must carry `--platform macos`, every other command must run in the session `open` created for
the leased app, and a pid-pinned lease stops working when that process exits. `open`
requires the daemon to run the native macOS app backend (`AGENT_DEVICE_MACOS_APP_BACKEND=native`).
A refusal fails with `UNAUTHORIZED` and `details.reason: "MACOS_APP_LEASE_DENIED"`.

Responses under the lease name nothing else about the host. `open` omits the session state and log
paths and the device (`device`, `id`, `kind`), a failure omits `logPath` and `diagnosticsRecord` and
replaces host paths and the host name in its text with `<host-path>` and `<host>`, and a snapshot's
fallback screenshot path stays on the host; the screenshot arrives through the artifact route. The
request diagnostics route is not served to a tenant that held the lease, and a daemon started with
`leases.require` does not serve it at all.

These rules apply to requests made under the lease. To refuse requests that name no lease at all,
start the daemon with a policy that requires one (`leases.require`, below). The proxy token is shared
by every client of the proxy, so a host serving several clients through one proxy authenticates each
client itself and sets each request's tenant, session isolation, and lease before forwarding it.

## Restricting What Clients Can Do

Start the proxy with a daemon policy to confine every client to named devices and commands. The
daemon enforces it for every request, including `batch` steps and `replay` actions:

```json
{
  "version": 1,
  "devices": { "allow": [{ "udid": "<simulator-udid>" }] },
  "commands": { "deny": ["boot", "shutdown"] },
  "capabilities": { "deny": ["device-shutdown"] }
}
```

```bash
AGENT_DEVICE_DAEMON_POLICY=./policy.json agent-device proxy
```

- `devices.allow` lists the only devices clients can see (`devices`) or use. Use `udid` for Apple
  devices and `serial` for Android.
- `commands` takes either `allow` or `deny`, not both. With `allow`, commands a later release adds
  stay denied. Client-side tools reach the daemon through internal commands: allow `runtime` for
  `react-devtools` and Maestro flows, and `install-from-source` for remote installs.
- `capabilities.deny: ["device-shutdown"]` blocks `shutdown`, `close --shutdown`, and any other path
  that would shut the device down.
- `leases.require: "macos-app"` (the only accepted value) refuses every request that is not made
  under a `macos-app` lease or that its allow list does not cover, including requests that name no
  lease and inventory commands such as `doctor` and `session list`.

The daemon reads the file once at start and refuses to start if it is invalid. If a daemon is
already running for the state directory with a different policy, the proxy refuses to reuse it;
stop that daemon first. A denied request fails with `UNAUTHORIZED` and
`details.reason: "DAEMON_POLICY_DENIED"`.

## What Is Exposed

The proxy allows only the daemon HTTP contract: `/health`, `/rpc`, `/upload` plus resumable `/upload/*` routes, and `/artifacts/*`, with the same routes also available under `/agent-device/*`. Health checks are unauthenticated; command, upload, and artifact routes require the bearer token.

The proxy validates the client token and rewrites authorized upstream requests to the local daemon token. The local daemon still validates its own token, so the daemon token is not exposed to remote clients.

The proxy deliberately does not forward `/admin/*`, including human-control holds. A caller inside
the device-host VM must use the daemon's loopback port and local daemon token.

## Embedding the Proxy in Your Own Gateway

`agent-device proxy` is also available as a library, `@agent-device/proxy`, for gateways that front
daemons on many hosts. It serves the same routes with the same token handling, but you choose the
transport on both sides: it answers standard Fetch API `Request` objects, so you can host it on
any HTTP server or carry requests over WebSocket, and it can reach the daemon through your own
tunnel instead of HTTP. See the
[package README](https://github.com/callstack/agent-device/tree/main/packages/proxy#readme)
for the API.

## Compatibility

Remote clients read `/health` before issuing commands and compare the daemon RPC protocol version. Keep the client and proxy versions reasonably close; patch-level differences should normally work, but incompatible RPC protocol versions fail before commands run.

`/health` also reports `hostArch`, the native CPU architecture of the machine serving it: the one its simulators run by default, even when Node itself runs under Rosetta. Macs report `arm64` or `x86_64`; other hosts report `x86_64` for x64 and Node's `process.arch` name otherwise (for example `arm64`). The top-level value describes the proxy's own machine, so a client behind a proxy reads `upstream.hostArch` for the host that runs the simulators, for example to build only that slice of a simulator app. Older daemons omit the field. `leaseBackends` lists the lease backends the daemon admits (`macos-app` only on a macOS host); a host
checks `upstream.leaseBackends` for `macos-app` before handing out a macOS app lease, and older
daemons omit it.

```json
{"ok":true,"service":"agent-device-proxy","version":"0.21.17","rpcProtocolVersion":2,"instanceId":"5f0c2d7e-8a41-4b7e-9c3a-2e6d1f4b8a90","hostArch":"arm64","upstream":{"ok":true,"service":"agent-device-daemon","version":"0.21.17","rpcProtocolVersion":2,"instanceId":"b3e9a6c1-4d2f-4f8e-a0b7-7c5d9e1f2a34","hostArch":"arm64"}}
```

## Cleanup

Run `agent-device disconnect` when the remote session is done. Stop the tunnel and the `agent-device proxy` process only when the host should stop accepting remote clients. Restarting the proxy generates a fresh token unless you supplied `--daemon-auth-token` explicitly.
