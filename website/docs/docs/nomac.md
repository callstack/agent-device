---
title: NoMac
description: Drive NoMac Simulator iPhone and iPad Simulators with agent-device.
---

# NoMac

Use [NoMac Simulator](https://nomac.app/docs/simulator) to run agent-device on cloud iOS Simulators, on Macs with Xcode, from any machine. You need a NoMac account and the `@agent-device/nomac` plugin.

## Install the plugin

```bash
agent-device plugins add @agent-device/nomac
```

The plugin is an optional npm package installed under `AGENT_DEVICE_HOME`. After you add or update it, close open sessions and run `agent-device daemon stop` with the state directory you use; the next device command loads the plugin.

## Set credentials and connect

Export your NoMac API key, for example from CI secrets:

```bash
export NOMAC_API_KEY=nmk_...
agent-device connect nomac
```

`connect` checks the key against NoMac without starting a phone. The phone starts on the first device command, such as `install` or `open`, and stops when the session closes.

Pick the phone with `--device`:

| Phone | Flags |
| --- | --- |
| iPhone 17 Pro, iOS 27 (default) | none, or `--device iphone` |
| iPad Pro 11-inch (M5), iOS 27 | `--device ipad` |

Every NoMac phone runs iOS 27, so `--provider-os-version` takes only `27`; any other version is refused. Every other cloud profile field, including `--provider-device-type` and `--provider-app`, is refused with the flag's name.

## Install and run an app

NoMac phones are Simulators, so they take an app built for the Simulator: a `.app` from `xcodebuild -sdk iphonesimulator`, or a `.zip` or `.tar.gz` of one. An `.ipa` built for a physical iPhone is refused.

```bash
agent-device connect nomac
agent-device install com.example.app ./build/Build/Products/Debug-iphonesimulator/MyApp.app
agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
```

`install` uploads the app to NoMac's storage, unpacks it on the phone, and installs it; it answers the bundle id NoMac reports.

## What a NoMac phone supports

- `snapshot` (the phone's accessibility tree), `screenshot`, `click`, `press` and long press, `fill`, `type`, `scroll`, `back`, `home`, `open` (an app or a deep link), `close`, and `install`.
- `fill` taps the field, replaces its text, and reads the field back; a field that shows something else fails the command.
- NoMac answers the phone's permission prompts itself, so the alert commands are unavailable.
- Orientation, the clipboard, settings, app logs, screen recording, gestures beyond scroll, and port reverse are unavailable and say why. NoMac records every session as a replay on its own page, and `simulator-use cloud tunnel <port>` lets the phone's apps reach a local backend.
- Requests carry `agent-device-cli/<version>` as their `User-Agent`.
