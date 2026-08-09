---
title: Limrun
description: Drive Limrun iOS simulators and Android emulators with agent-device.
---

# Limrun

Use Limrun for direct remote iOS simulators and Android emulators. Limrun does not use local or physical-device selectors such as `--udid`, `--serial`, or `--device`.

## Credentials and connection

Set a Limrun API key in a non-interactive environment. `LIMRUN_REGION` optionally selects a region.

```bash
export LIMRUN_API_KEY=...
agent-device connect limrun --platform android
```

Pass `android` or `ios` to select the instance type. `connect` verifies the selected service without creating an instance.

## CLI workflow

A new Limrun instance does not contain your app. Run `install <package-or-bundle-id> <app-path-or-url>` before `open`. The install command allocates the instance when needed, so you do not need to run `devices` first.

```bash
export LIMRUN_API_KEY=...

agent-device connect limrun --platform android
agent-device install com.example.app ./app.apk
agent-device open com.example.app --relaunch
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device disconnect
```

Limrun Android uses the direct ADB tunnel. Normal Android helper-backed snapshots, installs, and port reverse flow are available, including the usual Android reverse setup for a local Metro server.

Limrun iOS uses the direct Limrun iOS client. It supports app lifecycle commands, snapshots, screenshots, taps, text input, scrolling, and app installation. It cannot reverse a remote device port to a local host port. For iOS Metro or React DevTools, use a publicly reachable HTTPS endpoint or bridge URL instead of a local-only address.

For MCP-only use, run `connect` in the same effective state directory before starting `agent-device mcp`. MCP exposes operational tools but not provider `connect` commands.

## Node.js runtime

The first-party agent-device-cloud bridge can use agent-device's Limrun runtime:

```ts
import { LimrunRuntime } from 'agent-device/limrun';

const apiKey = process.env.LIMRUN_API_KEY;
if (!apiKey) throw new Error('LIMRUN_API_KEY is required');

const runtime = new LimrunRuntime({
  apiKey,
  region: process.env.LIMRUN_REGION,
});
```

After allocating a lease, an embedding bridge can call `runtime.getDeviceSession(device)` for the allocated device's reusable semantic capabilities. The facade includes app inventory, foreground state where Limrun exposes it, key input, bounded log reads, recording, remote asset installation, and the existing interactor. Android also exposes agent-device's `AndroidAdbProvider` abstraction for helpers and reversible port forwarding. iOS exposes a typed `simctl` execution handle for bridge-owned runner lifecycle and launch policy. Raw Limrun clients remain private to the provider runtime.

## Artifacts and troubleshooting

Limrun does not currently expose provider artifacts through `agent-device artifacts`. If connect fails, check `LIMRUN_API_KEY` and the optional `LIMRUN_REGION`.
