---
title: Samsung Tizen
description: Drive web apps on Samsung Tizen TVs with agent-device through sdb and the Chrome DevTools Protocol.
---

Use the `@agent-device/tizen` plugin to drive web apps on Samsung Tizen TVs. The plugin
debug-launches the app over `sdb`, forwards its DevTools port, and drives the page over the Chrome
DevTools Protocol (CDP): remote keys, pointer, text, snapshots, screenshots, and console logs.

The plugin is experimental. The commands it admits are listed in
[How commands map to the TV](#how-commands-map-to-the-tv).

## Requirements

- `sdb` from the Tizen SDK of the VS Code Tizen extension, set up with its Set Up step. The plugin
  finds it in the SDK that `$TIZEN_SDK` or `~/.tizen.path.config` names. `sdb` is not on `PATH`;
  to point at it directly, set the `sdbPath` plugin option.
- The TV in Developer Mode with this host's IP set as the developer IP. To set this up, follow
  Samsung's
  [Connecting the TV and SDK](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).
- The app installed on the TV from a debug-enabled package.
- The TV and this host on the same network.

## Install the plugin

```bash
agent-device plugins add @agent-device/tizen
```

The plugin is an optional npm package installed under `AGENT_DEVICE_HOME`.
After you add or update it, close open sessions and run `agent-device daemon stop`
with the state directory you use; the next device command loads the plugin.

Plugin options, set under `plugins["@agent-device/tizen"].options` in `config.json`:

| Option | Meaning |
| --- | --- |
| `sdbPath` | Path to `sdb`, when the Tizen SDK is not found. |
| `device` | TV IP or sdb serial to drive when `connect` names none. Defaults to the only TV connected to `sdb`. |

## Connect and run a session

```bash
export AGENT_DEVICE_SESSION=checkout-tv
agent-device connect tizen --device 192.0.2.10
agent-device open com.example.app
agent-device wait text "Home"
agent-device tv-remote press down
agent-device snapshot -i
agent-device screenshot ./tv.png
agent-device logs start
agent-device close com.example.app
agent-device disconnect
```

The TV is a leased device, so every command from `connect` to `disconnect` names its session with
`AGENT_DEVICE_SESSION`, `--session <name>`, or a config session. Without one, the command fails with
`REMOTE_SESSION_REQUIRED`.

`--device` takes the TV IP or an sdb serial. When the TV is not connected to `sdb` yet, the
plugin runs `sdb connect <ip>:26101`. Without `--device`, the plugin uses the `device` option,
then the only TV connected to `sdb`. `connect` does not contact the TV; `open` connects it.

agent-device leases only iOS, Android, and HarmonyOS devices, so a Tizen TV enters as an Android
TV device that the plugin owns (`platform: android`, `target: tv`, id `tizen:<sdb serial>`).
Every command on that device goes to the plugin, never to adb.

## How commands map to the TV

| Command | How |
| --- | --- |
| `open` / `close` | `sdb shell 0 was_kill`, `sdb shell 0 debug`, and `sdb forward`, then CDP / `sdb shell 0 was_kill` |
| `tv-remote press up/down/left/right/select/back`, `back` | `Input.dispatchKeyEvent` with the Samsung remote codes |
| `appstate` | The attached app while its page is visible |
| `apps` | `sdb shell 0 vd_applist` |
| `logs` | Console calls, exceptions, and browser log entries of the attached page, one line each |
| `snapshot`, `find`, `is`, `get`, `wait` | A DOM walk over `Runtime.evaluate`: visible interactive, labelled, or text nodes, with focus from `document.activeElement`. `-s`, `-d`, and `-i` apply to the walk. |
| `screenshot` | `Page.captureScreenshot` |
| `click`, `press <x> <y>`, `longpress`, `hover` | `Input.dispatchMouseEvent` |
| `fill` | Pointer press on the field, select its contents, then `Input.insertText`, or Backspace for an empty value |
| `type` | `Input.insertText` into the focused element |
| `scroll` | `mouseWheel` at the centre of the scroll container or the viewport, by the requested distance |

Not supported yet: system buttons (`home`, menu, volume, channel, and media keys), `network dump`,
`perf`, `install` and `uninstall`, recording, URLs and deep links in `open`, and `power`.

## Known limitations

- `open` is always a cold start: `sdb shell 0 debug` cannot attach to a running app, so `open`
  kills it first. `open` can return before the app leaves its splash screen; wait for app content
  before the first snapshot.
- Idle leases expire after 60 seconds by default, and expiry ends the session. When the lease
  ends, by `disconnect` or by expiry, the plugin closes the page connection and removes the `sdb`
  forward. The next command then fails with `Lease is not active` or `No active session` and
  needs a new `connect` and `open`. To keep longer pauses alive, run `agent-device daemon stop`,
  then start the daemon with `AGENT_DEVICE_LEASE_TTL_MS` and `AGENT_DEVICE_LEASE_MAX_TTL_MS` set,
  for example `1800000`.
- `screenshot` captures the app page, not the TV screen. When the app is in the background, the
  page renders no frames, so `screenshot` fails; `open <appId>` brings the app back. While the
  on-screen keyboard is open, the page viewport and the screenshot are shorter. System layers such
  as the Samsung menu never appear in `screenshot` or `snapshot`.
- `appstate` knows only the attached app. The TV reports no foreground app that the plugin can
  read.
- Console messages logged before the attach are replayed without object previews.
- A second DevTools client on the same page can hang the session. Close Chrome DevTools and other
  inspector clients attached to the app first.
- Snapshots are read from the DOM. Labels come from `aria-label`, `alt`, `title`, or own text.
  Rects are CSS pixels, which match screenshot pixels only at `devicePixelRatio` 1. The walk does
  not enter iframes or shadow roots.
