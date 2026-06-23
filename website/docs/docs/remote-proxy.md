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

The command prints a `daemon base URL` and `daemon auth token`. Keep the token secret; anyone with it can control the proxied daemon.

Expose the proxy with your tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:4310
# or
ngrok http 4310
```

By default the proxy binds `127.0.0.1`. Use `--host 0.0.0.0` only when you intentionally want the proxy reachable on the host network.

## Remote Client

On the machine running the agent, use the public tunnel origin with the `/agent-device` base path:

```bash
export AGENT_DEVICE_DAEMON_BASE_URL="https://example.trycloudflare.com/agent-device"
export AGENT_DEVICE_DAEMON_AUTH_TOKEN="<token>"

agent-device devices --platform ios
agent-device open MyApp --platform ios
agent-device snapshot --platform ios
```

You can also pass the values per command:

```bash
agent-device devices \
  --daemon-base-url https://example.trycloudflare.com/agent-device \
  --daemon-auth-token <token>
```

For repeated use, put the remote client settings in normal CLI config:

```json
{
  "daemonBaseUrl": "https://example.trycloudflare.com/agent-device",
  "daemonAuthToken": "<token>"
}
```

With `agent-device.json` in the working directory, normal commands pick up those defaults:

```bash
agent-device devices
agent-device open MyApp
agent-device snapshot
```

Do not commit a config file that contains a live `daemonAuthToken`.

## What Is Exposed

The proxy allows only the daemon HTTP contract: `/health`, `/rpc`, `/upload`, and `/artifacts/*`, with the same routes also available under `/agent-device/*`. Health checks are unauthenticated; command, upload, and artifact routes require the bearer token.

The proxy validates the client token and rewrites authorized upstream requests to the local daemon token. The local daemon still validates its own token, so the daemon token is not exposed to remote clients.

## Compatibility

Remote clients read `/health` before issuing commands and compare the daemon RPC protocol version. Keep the client and proxy versions reasonably close; patch-level differences should normally work, but incompatible RPC protocol versions fail before commands run.

## Cleanup

Stop the tunnel and the `agent-device proxy` process when the remote session is done. Restarting the proxy generates a fresh token unless you supplied `--daemon-auth-token` explicitly.
