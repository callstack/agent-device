---
title: Limrun
description: Drive Limrun iOS simulators and Android emulators with agent-device.
---

# Limrun

Use Limrun to run agent-device on remote iOS simulators and Android emulators. You need a Limrun API key, or the URL and token of an instance someone else created. Limrun does not use local or physical-device selectors such as `--udid`, `--serial`, or `--device`.

## Set credentials and connect

Export your Limrun API key, for example from CI secrets. Set `LIMRUN_REGION` to pick a region.

```bash
export LIMRUN_API_KEY=...
agent-device connect limrun --platform android
```

`--platform android` or `--platform ios` selects the instance type. `connect` checks the credentials for that platform without creating an instance.

## Drive an existing instance

An agent in a sandbox can drive an instance that someone else created, such as the instance behind a live preview, without your organization's API key. Create the instance where the API key lives, then give the sandbox that instance's URL and token from its `status`:

| Platform | Environment variables |
| --- | --- |
| iOS | `LIM_IOS_INSTANCE_URL` (`status.apiUrl`), `LIM_IOS_INSTANCE_TOKEN` (`status.token`) |
| Android | `LIM_ANDROID_INSTANCE_URL` (`status.apiUrl`), `LIM_ANDROID_INSTANCE_TOKEN` (`status.token`), `LIM_ANDROID_INSTANCE_ADB_URL` (`status.adbWebSocketUrl`) |

The `lim` CLI reads the same variables, so one set works for both tools. Set all of a platform's variables or none. With a partial set, `connect` fails, and the daemon disables Limrun and records `provider_runtime_skipped` in `daemon.log`.

```bash
export LIM_IOS_INSTANCE_URL=...
export LIM_IOS_INSTANCE_TOKEN=...

agent-device connect limrun --platform ios
agent-device open com.example.app
agent-device snapshot -i
agent-device disconnect
```

`connect` checks the instance credentials. agent-device never creates or deletes that instance: `disconnect` leaves it running, and its owner deletes it. When a platform's instance variables are set, they take precedence over `LIMRUN_API_KEY` for that platform.

On an attached Android instance, agent-device does not replace an existing port reverse mapping. If the owner already maps a device port, such as `tcp:8081` for their Metro server, a reverse to that port fails and the owner's mapping stays in place. The error has `details.reason: 'android_port_reverse_rebind_refused'` when `adb reverse --list` shows the mapping; otherwise it is a plain ADB failure.

A running daemon keeps the Limrun variables it started with. If your shell holds different account variables, or different instance variables for the platform you lease, the first command that allocates a lease, such as `install` or `open`, refuses before it creates or attaches to an instance. Run `agent-device daemon stop` (with the same `--state-dir`) and rerun the command. A shell that sets none of these variables uses the daemon's values.

`install`, and `apps` before the first `open`, need `LIMRUN_API_KEY` because they use Limrun asset storage. After `open`, `apps` lists the apps installed on the instance without the key. Install your app before you hand over the instance. From the Node.js runtime, `getDeviceSession(device).installRemoteApp(url)` installs from a signed asset URL without the API key.

## Keep idle sessions alive

Limrun ends an instance after its inactivity timeout, which an idle session can reach while a model thinks between steps. Set `LIMRUN_KEEP_ALIVE=1` (or `true`) to ping the instance every 30 seconds while a session is open. Keep-alive is off by default. In the Node.js runtime, pass `keepAlive: true`.

## Run a session from the CLI

A new Limrun instance does not contain your app. Run `install <package-or-bundle-id> <app-path-or-url>` before `open`. `install` allocates the instance when needed, so you do not need to run `devices` first.

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

On Android, agent-device connects to Limrun over an ADB tunnel. Snapshots use the Android snapshot helper, installs upload the app through Limrun asset storage, and port reverse runs over ADB, including the usual reverse setup for a local Metro server.

On iOS, agent-device supports app lifecycle commands, snapshots, screenshots, taps, text input, scrolling, the home button, clipboard read and write, and app installation. `open --launch-args` relaunches the app with those arguments through simctl. iOS cannot reverse a remote device port to a local host port, so for Metro or React DevTools use a publicly reachable HTTPS endpoint or bridge URL instead of a local-only address.

On iOS, `settings` supports `appearance`, `permission`, `location`, and `clear-app-state`, with the same arguments as a local simulator. `clear-app-state` resets the app's data container through Limrun's soft reset. That reset relaunches the app once before agent-device stops it, so the app may run once after its data is cleared. `reset-keychain`, `wifi`, `airplane`, `faceid`, `touchid`, and `text-size` are unsupported, and you cannot read back any iOS setting.

On iOS, `fill` taps the target, waits for that field to take text-entry focus, and only then types. Apps that never report a globally focused element, such as Flutter forms, still fill and report `textEntryReadiness: "focused-element"`. If the tap does not focus a field, `fill` fails with `text_entry_focus_not_observed` instead of typing into an unknown field. Use `type` to send text to whichever field already has focus.

To use Limrun only through MCP, run `connect` in the same effective state directory before you start `agent-device mcp`. MCP exposes device commands such as `open`, `snapshot`, and `close`, but not provider `connect` commands.

## Embed the Node.js runtime

A Node.js bridge, such as agent-device-cloud, can embed agent-device's Limrun runtime:

```ts
import { LimrunRuntime } from 'agent-device/limrun';

const apiKey = process.env.LIMRUN_API_KEY;
if (!apiKey) throw new Error('LIMRUN_API_KEY is required');

const runtime = new LimrunRuntime({
  apiKey,
  region: process.env.LIMRUN_REGION,
});
```

To drive existing instances, pass `instances: { ios: { apiUrl, token } }` (Android also takes `adbUrl`), with or without `apiKey`. The runtime never creates or deletes instances for a platform listed there.

After allocating a lease, call `runtime.getDeviceSession(device)` to get the allocated device's capabilities: app inventory, foreground state where Limrun exposes it, key input, bounded log reads, recording, remote asset installation, and the interactor. On Android it also exposes agent-device's `AndroidAdbProvider` for helpers and reversible port forwarding. On iOS it exposes a typed `simctl` execution handle so your bridge can own runner lifecycle and launch policy. The runtime does not expose raw Limrun clients.

## Get artifacts and troubleshoot

`agent-device artifacts` does not return provider artifacts for Limrun. If `connect` fails, check `LIMRUN_API_KEY` and the optional `LIMRUN_REGION`. For an existing instance, check its URL and token variables, and that the instance is still running.
