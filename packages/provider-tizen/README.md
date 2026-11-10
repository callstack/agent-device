# @agent-device/tizen

Drive web apps on Samsung Tizen TVs with [agent-device](https://agent-device.dev). The plugin
debug-launches the app over `sdb`, forwards its DevTools port, and drives the page over the Chrome
DevTools Protocol: remote keys, pointer, text, snapshots, screenshots and console logs.

Status: experimental. Verified on a Samsung Smart Monitor M7 (Tizen 9.0, packaged build of a React
Native Web app): `connect`, `open`, `open --relaunch`, `snapshot -i`, `tv-remote` (directions,
select, back), `back`, `is focused`, `press`, `find ... click`, `hover`, `longpress`, `fill`,
`type`, `wait`, `scroll`, `screenshot`, `logs`, `apps`, `appstate`, `close`, `disconnect`.

## How it plugs in

agent-device leases only iOS, Android and HarmonyOS devices, so a Tizen TV enters as an
**Android TV device that this plugin owns** (`platform: android`, `target: tv`, id
`tizen:<sdb serial>`). Every command on that device goes to this plugin's runtime, never to adb.

## Requirements

- `sdb` from the Tizen SDK of the VS Code Tizen extension, set up with its Set Up step. The plugin
  finds it in the SDK that `$TIZEN_SDK` or `~/.tizen.path.config` names, or at the `sdbPath`
  option; it is not on `PATH`
- The TV in Developer Mode with this host's IP set as the developer IP; see Samsung's
  [Connecting the TV and SDK](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)
- The app installed on the TV from a debug-enabled package
- The TV and this host on the same network

## Install

```sh
agent-device plugins add @agent-device/tizen
agent-device daemon stop     # the next command starts a daemon with the plugin loaded
```

Plugin options: `sdbPath` (the `sdb` binary, when the SDK is not found) and `device` (default TV
IP or sdb serial).

To try a local build, pack the package and install the tarball into a plugin store installation:

```sh
pnpm --filter @agent-device/tizen pack --out /tmp/agent-device-tizen.tgz
installation=$(uuidgen)
npm install --prefix ~/.agent-device/plugins/$installation /tmp/agent-device-tizen.tgz
```

Then register `{"plugins": {"@agent-device/tizen": {"installation": "<installation>"}}}` in
`~/.agent-device/config.json` and run `agent-device daemon stop`.

## Use

```sh
agent-device daemon stop                              # the lease TTL is read when the daemon starts
export AGENT_DEVICE_LEASE_TTL_MS=1800000 AGENT_DEVICE_LEASE_MAX_TTL_MS=1800000  # see Known limitations
export AGENT_DEVICE_SESSION=checkout-tv                # one session name per agent
agent-device connect tizen --device 192.0.2.10        # TV IP or sdb serial
agent-device open <appId>                             # kill, debug launch, forward, attach over CDP
agent-device wait text <text on the first screen>
agent-device tv-remote press down
agent-device snapshot -i
agent-device screenshot ./tv.png
agent-device logs start                               # then logs path
agent-device close <appId>
agent-device disconnect
```

`--device` takes the TV IP (`sdb connect <ip>:26101` runs when it is not connected yet) or an sdb
serial. Without it, the plugin uses the `device` option, then the only TV connected to `sdb`.
`connect` does not contact the TV; `open` connects it.

The TV is a leased device, so every command from `connect` to `disconnect` names its session with
`AGENT_DEVICE_SESSION`, `--session <name>` or a config session. Without one, the command fails with
`REMOTE_SESSION_REQUIRED`.

## Supported

| Command | How |
| --- | --- |
| `open` / `close` | `sdb shell 0 was_kill`, `sdb shell 0 debug` (prints the DevTools port), `sdb forward`, then CDP / `sdb shell 0 was_kill` |
| `tv-remote press up/down/left/right/select/back`, `back` | `Input.dispatchKeyEvent` with the Samsung remote codes (Back = `XF86Back`, 10009) |
| `appstate` | the attached app while its page is visible |
| `apps` | `sdb shell 0 vd_applist`: user-installed apps with their titles |
| `logs` | console calls, exceptions and browser log entries of the attached page, one line each |
| `snapshot`, `find`, `is`, `get`, `wait` | DOM walk over `Runtime.evaluate`: visible interactive, labelled or text nodes, focus from `document.activeElement`; `-s`, `-d` and `-i` apply to the walk |
| `screenshot` | `Page.captureScreenshot` |
| `click`, `press <x> <y>`, `longpress`, `hover` | `Input.dispatchMouseEvent` |
| `fill` | pointer press on the field, select its contents, then `Input.insertText`, or Backspace for an empty value |
| `type` | `Input.insertText` into the focused element |
| `scroll` | `mouseWheel` at the centre of the scroll container or viewport, by the requested distance |

Not yet: system buttons (`home`, menu, volume, channel and media keys), `network dump`, `perf`,
`install` and `uninstall`, recording, URLs and deep links in `open`, `power`.

## Known limitations

- **`open` is always a cold start.** `sdb shell 0 debug` launches the app and cannot attach to a
  running one, so `open` kills the app first. `open` returns once the document has loaded, which
  can be before the app leaves its splash screen; wait for app content (`wait text ...`) before
  the first snapshot.
- **Idle leases expire after 60 s by default, and expiry ends the session.** agent-device gives a
  direct-device provider lease its default TTL and beats it only while a command runs. When the
  lease ends, by `disconnect` or by expiry, the plugin closes the page connection and removes the
  `sdb` forward. After a longer pause, the next command fails with `Lease is not active` or
  `No active session` and needs a new `connect` and `open`. To avoid it, run
  `agent-device daemon stop`, then start the daemon with `AGENT_DEVICE_LEASE_TTL_MS` and
  `AGENT_DEVICE_LEASE_MAX_TTL_MS` set (for example 30 min).
- **`screenshot` captures the app page, not the TV screen.** The restricted `sdb shell 0` has no
  screen-capture command. When the app is in the background, the page is hidden and renders no
  frames, so `screenshot` fails at once; `open <appId>` brings the app back. While the on-screen
  keyboard is open, the page viewport and so the screenshot are shorter.
- **`appstate` knows only the attached app.** The TV's REST API (`:8001/api/v2/applications/<id>`)
  reports `visible: false` for an app in front of the user, and `sdb shell 0` has no
  foreground-app command.
- **Console messages from before the attach are replayed without object previews**, so objects
  in them show as `Object`. Messages logged after the attach show their properties.
- **A second DevTools client on the same page can hang the session.** Close Chrome DevTools and
  other inspector clients attached to the app before a session.
- **Snapshots are DOM-derived.** Labels come from `aria-label`, `alt`, `title` or own text;
  rects are CSS px, which match screenshot pixels only at `devicePixelRatio` 1 (1080p apps).
  The walk does not enter iframes or shadow roots. `is text` on an input compares its label, not
  its value; the value is in `snapshot --raw`.
- **System overlays are outside the page.** The Samsung menu, on-screen keyboard and other system
  layers never appear in `screenshot` or `snapshot`.
