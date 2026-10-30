---
title: LG webOS
description: Drive web apps on LG webOS TVs with agent-device through the webOS CLI and the Chrome DevTools Protocol.
---

Use the `@agent-device/webos` plugin to drive web apps on LG webOS TVs. The plugin launches the
app with the webOS CLI, opens the `ares-inspect` tunnel, and drives the page over the Chrome
DevTools Protocol (CDP): remote keys, pointer, text, snapshots, screenshots, and console logs.

The plugin is experimental. The commands it admits are listed in
[How commands map to the TV](#how-commands-map-to-the-tv).

## Requirements

- The webOS CLI (`ares-*`) on `PATH`, or the directory that holds it passed as the `aresBin`
  plugin option. To install it, follow LG's
  [webOS CLI installation](https://webostv.developer.lge.com/develop/tools/cli-installation).
- The TV in Developer Mode and registered with `ares-setup-device`. To set this up, follow LG's
  [App Testing with Developer Mode App](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).
  The name you give the TV there is the `--device` value for `connect`.
- The app installed on the TV.
- The TV and this host on the same network.

## Install the plugin

```bash
agent-device plugins add @agent-device/webos
```

The plugin is an optional npm package installed under `AGENT_DEVICE_HOME`.
After you add or update it, close open sessions and run `agent-device daemon stop`
with the state directory you use; the next device command loads the plugin.

Plugin options, set under `plugins["@agent-device/webos"].options` in `config.json`:

| Option | Meaning |
| --- | --- |
| `aresBin` | Directory with the `ares-*` CLIs, when they are not on `PATH` (for example a project's `node_modules/.bin`). |
| `device` | `ares-setup-device` entry to drive when `connect` names none. Defaults to the ares default device. |

## Connect and run a session

```bash
agent-device connect webos --device living-room
agent-device open com.example.app
agent-device tv-remote press down
agent-device snapshot -i
agent-device screenshot ./tv.png
agent-device logs start
agent-device close com.example.app
agent-device disconnect
```

`--device` names an `ares-setup-device` entry. Without it, the plugin uses the `device` option,
then the ares default device. `connect` does not contact the TV; the plugin reads the TV from
`ares-setup-device` when `open` starts the session.

agent-device leases only iOS, Android, and HarmonyOS devices, so a webOS TV enters as an Android
TV device that the plugin owns (`platform: android`, `target: tv`, id `webos:<ares device>`).
Every command on that device goes to the plugin, never to adb.

## How commands map to the TV

| Command | How |
| --- | --- |
| `open` / `close` | `ares-launch` / `ares-launch --close`, then the `ares-inspect` tunnel |
| `tv-remote press up/down/left/right/select/back`, `back` | `Input.dispatchKeyEvent` with the LG remote codes |
| `appstate` | The attached app while its page is visible |
| `apps` | `ares-install --listfull` |
| `logs` | Console calls, exceptions, and browser log entries of the attached page, one line each |
| `snapshot`, `find`, `is`, `get`, `wait` | A DOM walk over `Runtime.evaluate`: visible interactive, labelled, or text nodes, with focus from `document.activeElement`. `-s`, `-d`, and `-i` apply to the walk. |
| `screenshot` | `Page.captureScreenshot` |
| `click`, `press <x> <y>`, `longpress`, `hover` | `Input.dispatchMouseEvent`, the Magic Remote pointer |
| `fill` | Pointer press on the field, select its contents, then `Input.insertText` |
| `type` | `Input.insertText` into the focused element |
| `scroll` | `mouseWheel` at the centre of the scroll container or the viewport, by the requested distance |

Not supported yet: system buttons (`home`, menu, volume, channel, and media keys), `network dump`,
`perf`, `install` and `uninstall`, recording, URLs and deep links in `open`, and `power`.

## Known limitations

- Idle leases expire after 60 seconds by default, and expiry ends the session. When the lease
  ends, by `disconnect` or by expiry, the plugin closes the page connection and the `ares-inspect`
  tunnel. The next command then fails with `Lease is not active` or `No active session` and needs
  a new `connect` and `open`. To keep longer pauses alive, run `agent-device daemon stop`, then start the daemon with
  `AGENT_DEVICE_LEASE_TTL_MS` and `AGENT_DEVICE_LEASE_MAX_TTL_MS` set, for example `1800000`.
- `screenshot` captures the app page, not the TV screen. When the app is in the background, for
  example after Home on the remote, the page is hidden and renders no frames, so `screenshot`
  fails; `open <appId>` brings the app back. System layers such as the LG menu and the on-screen keyboard never appear in
  `screenshot` or `snapshot`.
- Console messages logged before the attach are replayed without object previews.
- `open` on a running app can reload it. `open` waits for a loaded document; `open --relaunch`
  closes the app first for a cold start.
- A second DevTools client on the same page can hang the session. Close Chrome DevTools and other
  inspector clients attached to the app first.
- Snapshots are read from the DOM. Labels come from `aria-label`, `alt`, `title`, or own text.
  Rects are CSS pixels, which match screenshot pixels only at `devicePixelRatio` 1. The walk does
  not enter iframes or shadow roots.
