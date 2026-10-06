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

## Drive an existing instance

An agent in a sandbox can drive an instance that someone else created, such as the instance behind a live preview, without your organization API key. Create the instance where the API key lives, then give the sandbox that instance's own URL and token from its `status`:

| Platform | Environment variables |
| --- | --- |
| iOS | `LIM_IOS_INSTANCE_URL` (`status.apiUrl`), `LIM_IOS_INSTANCE_TOKEN` (`status.token`) |
| Android | `LIM_ANDROID_INSTANCE_URL` (`status.apiUrl`), `LIM_ANDROID_INSTANCE_TOKEN` (`status.token`), `LIM_ANDROID_INSTANCE_ADB_URL` (`status.adbWebSocketUrl`) |

These are the same variables the `lim` CLI reads, so one set works for both tools. Set all of a platform's variables or none: with a partial set, `connect` fails, and the daemon disables Limrun and records `provider_runtime_skipped` in `daemon.log`.

```bash
export LIM_IOS_INSTANCE_URL=...
export LIM_IOS_INSTANCE_TOKEN=...

agent-device connect limrun --platform ios
agent-device open com.example.app
agent-device snapshot -i
agent-device disconnect
```

`connect` checks the instance credentials. agent-device never creates or deletes that instance: `disconnect` leaves it running, and its owner deletes it. When the variables for a platform are set, they take precedence over `LIMRUN_API_KEY` for that platform.

On an attached Android instance, agent-device does not replace an existing port reverse mapping. If the owner already maps a device port, such as `tcp:8081` for their Metro server, a reverse to that port fails and the owner's mapping stays in place. The error has `details.reason: 'android_port_reverse_rebind_refused'` when `adb reverse --list` shows the mapping. Otherwise it is a plain ADB failure.

A running daemon keeps the Limrun variables it started with. If your shell holds different account variables, or different instance variables for the platform being leased, the first command that allocates a lease, such as `install` or `open`, refuses before it creates or attaches to an instance; run `agent-device daemon stop` (with the same `--state-dir`) and rerun the command. A shell that sets none of the compared variables uses the daemon's.

`install`, and `apps` before the first `open`, still need `LIMRUN_API_KEY`, because they use Limrun asset storage. After `open`, `apps` lists the apps installed on the instance without the key. Install the app before you hand over the instance. From the Node.js runtime, `getDeviceSession(device).installRemoteApp(url)` installs from a signed asset URL without the API key.

## Keeping idle sessions alive

Limrun ends an instance after its inactivity timeout, which an idle session reaches while a model thinks between steps. Set `LIMRUN_KEEP_ALIVE=1` (or `true`) to ping the instance every 30 seconds while a session is open. It is off by default, so instance lifetime is unchanged unless you ask for it. In the Node.js runtime, pass `keepAlive: true`.

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

Limrun iOS uses the direct Limrun iOS client. It supports app lifecycle commands, snapshots, screenshots, taps, text input, scrolling, and app installation. `open --launch-args` relaunches the app with those arguments through simctl. It cannot reverse a remote device port to a local host port. For iOS Metro or React DevTools, use a publicly reachable HTTPS endpoint or bridge URL instead of a local-only address.

Limrun iOS `settings` supports `appearance`, `permission`, `location`, and `clear-app-state`. They use the same arguments as a local simulator, and `clear-app-state` resets the app's data container through Limrun's soft reset. That reset relaunches the app once before agent-device stops it, so the app may run once after its data is cleared. `reset-keychain`, `wifi`, `airplane`, `faceid`, `touchid`, and `text-size` are unsupported, and no iOS setting can be read back.

iOS text entry is witnessed rather than assumed. `fill` taps the target, waits for that field to take text-entry focus, and only then types, so an app that exposes fields without ever publishing a globally focused element - Flutter forms are the common case - still fills and reports `textEntryReadiness: "focused-element"`. A tap that nothing answers fails with `text_entry_focus_not_observed` instead of typing into an unknown field; `type` stays the deliberate route into whichever field already holds focus.

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

To drive existing instances, pass `instances: { ios: { apiUrl, token } }` (Android also takes `adbUrl`), with or without `apiKey`. A platform listed there never creates or deletes instances.

After allocating a lease, an embedding bridge can call `runtime.getDeviceSession(device)` for the allocated device's reusable semantic capabilities. The facade includes app inventory, foreground state where Limrun exposes it, key input, bounded log reads, recording, remote asset installation, and the existing interactor. Android also exposes agent-device's `AndroidAdbProvider` abstraction for helpers and reversible port forwarding. iOS exposes a typed `simctl` execution handle for bridge-owned runner lifecycle and launch policy. Raw Limrun clients remain private to the provider runtime.

## Artifacts and troubleshooting

Limrun does not currently expose provider artifacts through `agent-device artifacts`. If connect fails, check `LIMRUN_API_KEY` and the optional `LIMRUN_REGION`. For an existing instance, check its URL and token variables, and that the instance is still running.
