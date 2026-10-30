# @agent-device/webos

Drive web apps on LG webOS TVs with [agent-device](https://agent-device.dev). The plugin launches
the app with the webOS CLI, opens the `ares-inspect` tunnel, and drives the page over the Chrome
DevTools Protocol: remote keys, pointer, text, snapshots, screenshots and console logs.

Status: experimental. Verified on an LG 32LQ63006LA (webOS TV 22, dev build of a React Native Web
app): `connect`, `open`, `snapshot -i`, `snapshot -s`, `tv-remote` (directions, select, back),
`is focused`, `press @ref --settle`, `wait text`, `find`, `screenshot`, `logs`, `apps`,
`appstate`, `close`, `disconnect`.

## How it plugs in

agent-device leases only iOS, Android and HarmonyOS devices, so a webOS TV enters as an
**Android TV device that this plugin owns** (`platform: android`, `target: tv`, id
`webos:<ares device>`). Every command on that device goes to this plugin's runtime, never to adb.

## Requirements

- webOS CLI (`ares-*`) on `PATH`, or the directory that holds it passed as `aresBin`; see LG's
  [webOS CLI installation](https://webostv.developer.lge.com/develop/tools/cli-installation)
- The TV in Developer Mode and registered with `ares-setup-device`; see LG's
  [App Testing with Developer Mode App](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
- The app installed on the TV
- The TV and this host on the same network

## Install

```sh
agent-device plugins add @agent-device/webos
agent-device daemon stop     # the next command starts a daemon with the plugin loaded
```

Plugin options: `aresBin` (directory with the `ares-*` CLIs) and `device` (default ares device
name).

To try a local build, pack the package and install the tarball into a plugin store installation:

```sh
pnpm --filter @agent-device/webos pack --out /tmp/agent-device-webos.tgz
installation=$(uuidgen)
npm install --prefix ~/.agent-device/plugins/$installation /tmp/agent-device-webos.tgz
```

Then register `{"plugins": {"@agent-device/webos": {"installation": "<installation>"}}}` in
`~/.agent-device/config.json` and run `agent-device daemon stop`.

## Use

```sh
agent-device daemon stop                              # the lease TTL is read when the daemon starts
export AGENT_DEVICE_LEASE_TTL_MS=1800000 AGENT_DEVICE_LEASE_MAX_TTL_MS=1800000  # see Known limitations
agent-device connect webos [--device <ares device>]   # defaults to the ares default device
agent-device open <appId>                             # ares-launch, then attach over CDP
agent-device tv-remote press down
agent-device snapshot -i
agent-device screenshot ./tv.png
agent-device logs start                               # then logs path
agent-device close <appId>
agent-device disconnect
```

Later commands use the session `connect` created; `connect` prints its name for `--session`.

## Supported

| Command | How |
| --- | --- |
| `open` / `close` | `ares-launch` / `ares-launch --close`, then the `ares-inspect` tunnel |
| `tv-remote press up/down/left/right/select/back`, `back` | `Input.dispatchKeyEvent` with the LG remote codes (Back = 461) |
| `appstate` | the attached app while its page is visible |
| `apps` | `ares-install --listfull` |
| `logs` | console calls, exceptions and browser log entries of the attached page, one line each |
| `snapshot`, `find`, `is`, `get`, `wait` | DOM walk over `Runtime.evaluate`: visible interactive, labelled or text nodes, focus from `document.activeElement`; `-s`, `-d` and `-i` apply to the walk |
| `screenshot` | `Page.captureScreenshot` |
| `click`, `press <x> <y>`, `longpress`, `hover` | `Input.dispatchMouseEvent` (Magic Remote pointer), ending each move with a small wiggle that wakes the cursor |
| `fill` | pointer press on the field, select its contents, then `Input.insertText` |
| `type` | `Input.insertText` into the focused element |
| `scroll` | `mouseWheel` at the centre of the scroll container or viewport, by the requested distance |

Not yet: system buttons (`home`, menu, volume, channel and media keys), `network dump`, `perf`,
`install` and `uninstall`, recording, URLs and deep links in `open`, `power`.

## Known limitations

- **Idle leases expire after 60 s by default, and expiry ends the session.** agent-device gives a
  direct-device provider lease its default TTL and beats it only while a command runs. When the
  lease ends, by `disconnect` or by expiry, the plugin closes the page connection and the
  `ares-inspect` tunnel. After a longer pause, the next command fails with `Lease is not active`
  or `No active session` and needs a new `connect` and `open`. To avoid it, run
  `agent-device daemon stop`, then start the daemon with `AGENT_DEVICE_LEASE_TTL_MS` and
  `AGENT_DEVICE_LEASE_MAX_TTL_MS` set (for example 30 min).
- **`screenshot` captures the app page, not the TV screen.** When the app is in the background,
  for example after Home on the remote, the page is hidden and renders no frames, so `screenshot`
  fails at once; `open <appId>` brings the app back. A whole-screen capture is not reachable on a retail TV: SSAP
  `tv/executeOneShot` answers `401 insufficient permissions` to unsigned clients, LG rejects the
  public signed manifest (`blacklisted certificate`), and the dev-mode shell (`prisoner`) gets no
  answer from `luna-send-pub`.
- **Console messages from before the attach are replayed without object previews**, so objects
  in them show as `Object`. Messages logged after the attach show their properties.
- **`open` on a running app can reload it** (webOS relaunch), so the first read may hit a document
  without a body. `open` waits for a loaded document, and a snapshot of an unloaded page is empty
  rather than an error. `open --relaunch` closes the app first, for a cold start.
- **A second DevTools client on the same page hung in testing.** Close Chrome DevTools and other
  inspector clients attached to the app before a session.
- **Snapshots are DOM-derived.** Labels come from `aria-label`, `alt`, `title` or own text;
  rects are CSS px, which match screenshot pixels only at `devicePixelRatio` 1 (1080p apps).
  The walk does not enter iframes or shadow roots, so overlays rendered there (for example a
  dev-server error overlay) appear in screenshots but not in snapshots.
- **System overlays are outside the page.** The LG menu, on-screen keyboard and other system
  layers never appear in `screenshot` or `snapshot`.
