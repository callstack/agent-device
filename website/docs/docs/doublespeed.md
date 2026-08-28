---
title: Doublespeed
description: Drive Doublespeed iOS simulators with agent-device.
---

# Doublespeed

Use [Doublespeed](https://mac.doublespeed.ai) for direct remote iOS simulators hosted on a Mac mini fleet. Doublespeed does not use local or physical-device selectors such as `--udid`, `--serial`, or `--device`.

## Credentials and connection

Set a Doublespeed API key in a non-interactive environment. `DOUBLESPEED_DEVICE` optionally selects the simulator model (default `iPhone 16`); `DOUBLESPEED_API_URL` optionally overrides the service endpoint.

```bash
export DOUBLESPEED_API_KEY=...
agent-device connect doublespeed --platform ios
```

`connect` verifies the service without creating a simulator. Doublespeed supports iOS only; `--platform ios` is the default and the only accepted value.

## CLI workflow

A new Doublespeed simulator does not contain your app. Run `install <bundle-id> <app-path-or-url>` before `open`. The install command allocates the simulator when needed, so you do not need to run `devices` first.

```bash
export DOUBLESPEED_API_KEY=...

agent-device connect doublespeed --platform ios
agent-device install com.example.app ./build/Example.app
agent-device open com.example.app --relaunch
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device disconnect
```

`install` accepts a simulator `.app` directory, a zipped `.app`, or a URL to either. The bundle is uploaded once per organization: repeated installs of the same build reuse the stored asset.

Doublespeed sessions support app lifecycle commands, snapshots, screenshots, taps, long presses, text input, scrolling, home, orientation, app state, app logs, and app installation. They cannot reverse a remote device port to a local host port. For Metro or React DevTools, use a publicly reachable HTTPS endpoint or bridge URL instead of a local-only address.

For MCP-only use, run `connect` in the same effective state directory before starting `agent-device mcp`. MCP exposes operational tools but not provider `connect` commands.

## Billing and lifetime

A simulator session is billed per second while it is allocated. `close` and `disconnect` release it; an idle session with no commands for 15 minutes ends on its own, and every session ends after its maximum duration. Orphaned sessions are found through their agent-device labels and released on the next lease recovery.

## Artifacts and troubleshooting

Doublespeed does not currently expose provider artifacts through `agent-device artifacts`. If connect fails, check `DOUBLESPEED_API_KEY`. A `402` response means the organization is out of credits; add credits in the [Doublespeed dashboard](https://mac.doublespeed.ai/dashboard/billing).
