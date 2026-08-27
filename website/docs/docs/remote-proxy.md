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

`connect proxy` stores the proxy profile and client identity. Device leases are automatic on `open` and expire after five minutes without commands. `close` releases the active session and device lease; `disconnect` clears local connection state.

Multiple agents can share one proxy when each uses the normal `connect proxy`, `open`, commands, `close`, and `disconnect` flow. A busy device error means another agent owns the device until it closes or its inactivity lease expires.

Do not put proxy endpoint, token, tenant, or provider fields in `./agent-device.json`: repository
configuration is intentionally limited to project-safe automation defaults. Use `connect proxy`, user
config, an explicit `--config` file, or protected CI environment variables for the endpoint and token.

## Human Takeover on the Host

If a person needs the simulator or device, run this on the host—not on the remote agent client:

```bash
agent-device takeover --platform ios
```

The local daemon pauses state-changing agent commands for the selected device until Ctrl+C. Read-only
diagnostics remain available, and an existing remote lease is preserved during the hold.

VM-side automation can use the same feature without a foreground CLI process. Read the local
daemon's `httpPort` and `token` from `daemon.json` in the effective state directory, then call the
loopback-only API with either `Authorization: Bearer <daemon-token>` or
`X-Agent-Device-Token: <daemon-token>`:

The API is available when the daemon runs with an HTTP listener, including remote-mode daemons. A
default socket-only local daemon should use the `takeover` CLI command instead.

```text
PUT    /admin/human-control/holds/<hold-id>
GET    /admin/human-control/holds
DELETE /admin/human-control/holds/<hold-id>
```

A PUT body has the shape below. Omitting `ttlMs` creates a persistent hold that must be deleted;
including it creates an expiring hold.

```json
{
  "scope": {
    "deviceKey": "<simulator-udid>",
    "deviceName": "iPhone 17 Pro",
    "platform": "ios",
    "kind": "simulator"
  },
  "reason": "Human is using the VM console.",
  "ttlMs": 15000
}
```

## What Is Exposed

The proxy allows only the daemon HTTP contract: `/health`, `/rpc`, `/upload` plus resumable `/upload/*` routes, and `/artifacts/*`, with the same routes also available under `/agent-device/*`. Health checks are unauthenticated; command, upload, and artifact routes require the bearer token.

The proxy validates the client token and rewrites authorized upstream requests to the local daemon token. The local daemon still validates its own token, so the daemon token is not exposed to remote clients.

The proxy deliberately does not forward `/admin/*`, including human-control holds. A caller inside
the device-host VM must use the daemon's loopback port and local daemon token.

## Compatibility

Remote clients read `/health` before issuing commands and compare the daemon RPC protocol version. Keep the client and proxy versions reasonably close; patch-level differences should normally work, but incompatible RPC protocol versions fail before commands run.

## Cleanup

Run `agent-device disconnect` when the remote session is done. Stop the tunnel and the `agent-device proxy` process only when the host should stop accepting remote clients. Restarting the proxy generates a fresh token unless you supplied `--daemon-auth-token` explicitly.
