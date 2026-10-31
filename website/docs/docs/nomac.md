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

`connect` checks the key against NoMac without starting a phone. The phone starts on the first device command, such as `install` or `open`, and stops when the session closes or its lease ends. Phones are billed per minute by NoMac; see [nomac.app](https://nomac.app) for pricing.

`NOMAC_API_URL` points the plugin at another NoMac address than `https://nomac.app`, for example a staging host. The daemon reads both variables when it starts, so after you change one, run `agent-device daemon stop`.

Pick the phone with `--device`:

| Phone | Flags |
| --- | --- |
| iPhone 17 Pro, iOS 27 (default) | none, or `--device iphone` |
| iPad Pro 11-inch (M5), iOS 27 | `--device ipad` |
| iPhone 17 Pro Max, iOS 27 | `--device iphone-pro-max` |

`--device` also takes the model's name. Every NoMac phone runs iOS 27, so `--provider-os-version` takes `27` or a `27.x` version; any other major version is refused. Every other cloud profile field, including `--provider-device-type` and `--provider-app`, is refused with the flag's name.

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

- `snapshot` (the phone's accessibility tree), `screenshot` (1x, one pixel per point; `--normalize-status-bar` works), `click`, `press` and long press (up to 10 seconds), `fill`, `type`, `scroll`, `back`, `home`, `open` (an app with `--launch-args`, or a deep link), `trigger-app-event`, `close`, and `install`.
- `fill` taps the field, replaces its text, and reads the field back; a field that shows something else fails the command. `fill --delay-ms` is refused; `type --delay-ms` types one character per call.
- `scroll` moves about 0.8 of the screen per pass and takes no amount, `--pixels` or `--duration-ms`. `press --double` is refused: each tap waits for the screen to settle, so two taps never make a double tap.
- NoMac answers the phone's permission prompts itself, so the alert commands are unavailable.
- Orientation, the clipboard, settings, app logs, screen recording, gestures beyond scroll, and port reverse are unavailable and say why. NoMac records every session as a replay on its own page, and `simulator-use cloud tunnel <port>` lets the phone's apps reach a local backend.
- Requests carry `agent-device-cli/<version>` as their `User-Agent`.
