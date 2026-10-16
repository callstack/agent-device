---
title: Commands
---

# Commands

Find the command for a task, the flags it takes, and how it behaves on each platform.

For persistent defaults and project-scoped CLI settings, see [Configuration](/docs/configuration).

CLI help matches your installed version. `agent-device help` lists the workflow and platform guides, and `help <command>` gives a command's exact flags:

```bash
agent-device help
agent-device help commands
agent-device help workflow
agent-device help open
```

If your agent runtime supports skills, install them to route agents automatically; they are optional. The CLI help topics are the reference for your installed version.

For MCP-aware clients that support direct tools, run:

```bash
agent-device mcp
```

For MCP client setup and what MCP does not expose, see [AI Agent Setup](/docs/agent-setup#mcp-server).

## Output and warnings

In text mode, every command prints each response warning as a `Warning:` line after its own output.
`get`, `find`, `clipboard`, and `record` print those lines on **stderr** instead, so
`value=$(agent-device get text …)` captures only the value. With `--json`, warnings stay in
`data.warnings` and no `Warning:` line is printed.

## Navigation

```bash
agent-device boot
agent-device boot --platform ios
agent-device boot --platform android
agent-device boot --platform android --device Pixel_9_Pro_XL --headless
agent-device shutdown --platform ios
agent-device shutdown --platform android --device Pixel_9_Pro_XL
agent-device open [app|url] [url]
agent-device open --platform macos --surface frontmost-app
agent-device open --platform macos --surface desktop
agent-device close [app]
agent-device back
agent-device back --in-app
agent-device back --system
agent-device home
agent-device orientation portrait
agent-device orientation landscape-left
agent-device app-switcher
agent-device action-button
agent-device fold closed
agent-device fold half-open
agent-device fold open
agent-device device status --platform android --serial emulator-5554
agent-device device release --stale
agent-device daemon stop --clean
```

Boot and shut down:

- `boot` gets the selected target ready without launching an app. It needs an active session or a device selector. You mainly need it when `open` fails because no simulator or emulator is booted.
- Android: `boot --platform android --device <avd-name>` launches that emulator with a window; add `--headless` to launch it without one. On macOS the window opens behind the focused app, which keeps focus (also when `open` boots a stopped AVD). This is best-effort: the emulator can still take focus if the focused app cannot be read, or if its window appears after the startup budget runs out.
- `shutdown` turns off the selected Apple simulator or Android emulator. It refuses the active session's device; use `close --shutdown` to end the session and turn the device off.
- `--timeout <ms>` on `boot`, `open <app>`, and `prepare ios-runner` is the startup budget for booting an iOS Simulator or Android emulator (for `prepare ios-runner`, shared with runner preparation). A never-booted iOS Simulator can take several minutes. When the budget runs out, the command fails with `error.details.reason: boot_timeout` and the device keeps booting, so a retry finds it further along. See [Sessions](/docs/sessions#wait-for-a-slow-or-busy-device).

Select a device:

- `--platform apple` is an alias for the Apple backend (`ios`, `tvOS`, `macOS`). Add `--target mobile|tv|desktop` to `--platform` to choose phone/tablet, TV, or desktop targets.
- A command that needs one device fails with `AMBIGUOUS_MATCH` and lists the candidates when you pass no `--device`, `--udid`, or `--serial` and several are equally preferred, such as two booted emulators. Virtual devices are preferred over physical ones and booted over offline ones first, and commands inside a session use the session's device. `devices` still lists everything.
- Commands without `--session` use an implicit session scoped to your worktree and the selected platform. For named sessions, `AGENT_DEVICE_SESSION`, and `--session-lock reject|strip`, see [Sessions](/docs/sessions).

Device claims and the daemon:

- `device status` lists host-local device claims without starting or contacting a daemon; `--stale` shows the stale claims it hides by default (owner exited, PID reused, state directory deleted, or daemon replaced), some of whose owners may still be running. Scope it with `--platform` plus `--udid` (Apple) or `--serial` (Android). A claim held by another live or uncertain owner blocks `open`, unless the device rebooted after the claim was taken: then `open` settles that owner's durable resources, takes the claim, and reports the release in `warnings`.
- `device release --stale` settles the durable resources of an owner that provably can't release its claim (its process exited or a newer daemon replaced it), then clears the claim. Live, uncertain, PID-reused, corrupt, and deleted-state-directory claims are refused with the reason. See [Sessions](/docs/sessions#release-a-device-another-workspace-holds).
- `daemon stop --state-dir <path>` stops a local daemon after verifying its identity. `--clean` also removes the Apple runner processes and leases that daemon retained.

Open apps and links:

- `open [app|url] [url]` boots and activates the selected target when needed. `open <url>` opens deep links on Android and iOS, and `open <app> <url>` opens a deep link in that app on iOS.
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom-scheme URLs need an active app in the session.
- `open <app> --wait <ms>` waits up to that budget for a device another session holds, then fails with `DEVICE_IN_USE`. The wait extends the command's timeout, so you don't need a longer `--timeout`. A claim held by another workspace's daemon is not waited for; `open` returns its recovery command at once. See [Sessions](/docs/sessions#wait-for-a-slow-or-busy-device).
- `open <app> --launch-console <path>` captures launch-time stdout/stderr for iOS simulator app launches. It is not valid for URL opens or other targets.
- `open --platform macos --surface app|frontmost-app|desktop|menubar` selects the macOS session surface; `app` is the default when you name an app. See [Desktop targets](#desktop-targets). `--save-script` records the surface so `replay` reopens it; with no surface given, replay opens an app session.
- Android React Native: `open --relaunch` needs an installed package name. Install or reinstall the APK first; `open <apk|aab> --relaunch` is rejected. For Metro-backed JS changes, run `metro reload` before reaching for `open <app> --relaunch`.
- Android (adb): an intent target such as `open settings` records the package that opened as `appBundleId`. `open settings --relaunch` stops and restarts that app. If the intent matches more than one activity, `--relaunch` fails.
- Android (ADB): `close` force-stops the app, then checks for 2 seconds that it has left the foreground and for 2 more that its process has exited. If either check window ends first, `close` fails with `details.reason: android-app-close-timeout` and `details.phase` set to `foreground` or `process`; apps Android restarts at once, such as the launcher, fail this way.

iOS Simulator launch behavior:

- An `open` that launches an app reports `timing.postOpenObservation`. When it is present and not `"observable"`, the next command that reads the screen waits briefly until two reads agree, so a `click` lands where the element comes to rest. If the screen is still moving after that wait, the command proceeds and warns that the surface was still changing.
- If CoreSimulator never answers a URL hand-off, `open` fails within 20 seconds with `details.reason: ios-simulator-openurl-timeout`. The Simulator may still have received the URL; retry the open or answer the prompt with `alert accept`.
- When `open <app> --launch-url <url>` raises an `Open in "<App>"?` prompt and the URL's scheme belongs to the session app, `open` taps **Open** and returns `launchConfirmation: "accepted"`. If the app still never starts, `open` hands over the URL once more.
- `details.reason: launch_confirmation_unanswered` means the app never started after the prompt was accepted, or the prompt stayed visible after a failed tap. Answer it with `alert accept` or `alert dismiss` before continuing.
- `details.reason: launch_confirmation_foreign_app` means another installed app owns the scheme (`details.foreignAppBundleId`). Close the prompt with `alert dismiss` and pass a URL your app handles.
- `open` leaves the prompt on screen and returns as if none appeared when the Simulator isn't set to English (run with `--debug` to see the title), when the prompt appears after `open` has seen your app, or when no single installed app owns the scheme (none does, a debug and a release build both do, or the app list can't be read). Answer it with `alert accept` or `alert dismiss`.

Back, orientation, and hardware buttons:

- `back` uses app-owned back navigation: visible in-app back UI on Apple targets, and the back keyevent on Android. `--in-app` names this default explicitly.
- `back --system` sends system back input: the Android back keyevent, the iOS back gesture, or the tvOS Siri Remote Menu button. macOS has no system back, so it reports unavailable.
- `orientation portrait|portrait-upside-down|landscape-left|landscape-right` works on iOS and Android mobile targets only.
- `action-button` presses the iPhone or iPad Action Button once. It takes no arguments, no hold duration, and no `--settle`, and it doesn't activate the session app or drive Camera Control. Other platforms refuse it, and a model without the button (an iPhone SE, most iPad simulators) fails with `UNSUPPORTED_OPERATION`.
- `action-button` reports that the press was dispatched, not what it triggered. Simulators run no Shortcuts or App Intents, so verify the outcome on a physical iPhone. Expect a press to take about five seconds on a Simulator.

Fold a foldable device:

- `fold closed|half-open|open` sets the pose of a foldable iPhone simulator (iPhone Duo) or a foldable Android emulator (`pixel_9_pro_fold`, `pixel_10_pro_fold`, `7.6in Foldable`) and reports the pose only after confirming it on the device. Re-snapshot after every fold, even an interrupted one; refs and coordinates from before it are stale. On iOS, expect about 10 seconds for `closed` or `open` and 16 for `half-open`.
- The iOS response names the lit panel and its size, marked `coordinateSpace: "native-panel"`. That size is not the next snapshot's viewport and cannot place a tap.
- iOS only: `--keyframes` plays a timed trajectory instead of a preset, for example `fold --keyframes '[{"atMs":0,"angle":0},{"atMs":1667,"angle":160},{"atMs":3333,"angle":100},{"atMs":5000,"angle":180}]'`. Use 2–64 keyframes starting at 0ms, strictly increasing integer timestamps up to 60,000ms, and angles from 0 to 180°.
- iOS needs an Xcode with the iOS simulator SDK and foldable HID support (verified on Xcode 27.1); Device Hub and Accessibility permission aren't required. The first fold builds a helper cached under `~/.agent-device/fold-helper`; failures report `fold-helper-build-failed` or `fold-hid-dispatch-failed`.
- `COMMAND_FAILED` with `reason: fold-pose-unverified` means the hinge reports another pose; `fold-pose-unsettled` means it reached `half-open` but never came to rest; `fold-pose-dispatched-unverified` means the pose was sent but the first hinge-angle read returned no sample, so check the lit panel with a screenshot; `hingeReadFailure` holds the read's own failure.
- `UNSUPPORTED_OPERATION` covers single-panel devices (`single-panel-device` on Android) and simulators in a non-default `--ios-simulator-device-set` (`unsupported-device-scope`; use the default set). Physical devices are refused.
- On Android, `fold` confirms the pose from the device state the emulator commits and reports `hingeAngleDegrees` as the hinge sensor reads it: the angle the AVD profile defines for the posture, such as 0°, 90°, and 180° on the Pixel folds or 15°, 90°, and 165° on the generic 7.6in Foldable. It also dismisses the lock screen that folding to the cover display can raise. For panels, poses, and timings, see `agent-device help foldable`.

Remote daemons and tenants:

- `--tenant`, `--session-isolation tenant`, `--run-id`, and `--lease-id` enforce lease admission on tenant-scoped daemons.
- `--daemon-base-url http(s)://host:port[/base-path]` calls a remote HTTP daemon directly instead of starting a local one. Add `--daemon-auth-token <token>` (or `AGENT_DEVICE_DAEMON_AUTH_TOKEN`) for non-loopback daemon URLs.
- Screenshots and recordings from a remote daemon are downloaded to the path you pass, so `screenshot page.png` and `record start session.mp4` work as they do locally. `record start` without a path downloads to `recording-<timestamp>.mp4` (`.webm` on web) in your working directory.
- To drive a Mac's simulators and devices from another machine, see [Remote Proxy](/docs/remote-proxy). For hosted devices in CI, see [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), or [TestMu AI](/docs/testmu). For `connect --remote-config`, see [Remote Metro workflow](#remote-metro-workflow).

```bash
agent-device open "https://example.com" --platform ios           # open link in web browser
agent-device open MyApp "myapp://screen/to" --platform ios       # open deep link to MyApp
agent-device back --platform ios                                 # tap visible app back UI only
agent-device back --system --platform ios                        # use edge-swipe or remote back action
agent-device reinstall MyApp /path/to/app-debug.apk --platform android --serial emulator-5554
agent-device open com.example.myapp --platform android --serial emulator-5554 --session my-session --relaunch
agent-device metro reload
```

## Human Takeover

Use `takeover` with an active remote connection when a person needs to use its leased device
without racing the agent:

```bash
agent-device takeover --session remote-session
agent-device takeover status --session remote-session
agent-device takeover release <hold-id> --session remote-session
```

`takeover` holds the device until you press Ctrl+C. While it holds, state-changing commands fail with
`DEVICE_IN_USE` and `details.reason: "human_control_active"`; read-only diagnostics still work. It
needs a device-scoped remote lease, so local sessions aren't supported. Holds don't survive a daemon
restart; reconnect and take the hold again. See [Remote Proxy](/docs/remote-proxy#human-takeover).

## Web Automation

`--platform web` drives a browser through [agent-browser](https://github.com/vercel-labs/agent-browser) and requires Node 24+. Use it when a browser step belongs inside an `agent-device` session, replay, batch, MCP, or Node.js client flow. For standalone browser automation, use `agent-browser` directly.

Set up and verify the managed web backend before you open a web session:

```bash
agent-device web setup
agent-device web doctor
agent-device open "https://example.com" --platform web
agent-device snapshot -i --platform web
agent-device get text @e2 --platform web
agent-device is visible 'label="Welcome"' --platform web
agent-device find text "Welcome" exists --platform web
agent-device click @e12 --platform web
agent-device hover @e14 --settle --platform web
agent-device fill @e13 "test@example.com" --platform web
agent-device wait text "Welcome" --platform web
agent-device network dump 25 --include headers --platform web
agent-device audio probe start 10 1000 --platform web
agent-device audio probe status --platform web
agent-device audio probe stop --platform web
agent-device screenshot ./artifacts/web-home.png --platform web
agent-device screenshot ./artifacts/web-full.png --platform web --fullscreen
agent-device viewport 1280 900 --platform web
agent-device close --platform web
```

- `web setup` installs a pinned `agent-browser` backend into the agent-device state directory (`--state-dir`, `AGENT_DEVICE_STATE_DIR`) and reuses it when present. Run it before first use and in CI bootstrap: web commands never install the backend themselves and use only that managed install. `web doctor` verifies it.
- Supported: URL open, snapshot refs, `get text/attrs`, `is visible/hidden/exists/absent/focused/text`, `find text/selector`, click/press, hover, fill/type, wait, `network dump`, `audio probe`, screenshot, close, and replay scripts made from those commands.
- `hover <@ref|selector|x y>` moves the pointer without pressing so hover-gated UI (row toolbars, menus) appears. Add `--settle` to read what it revealed; on web, `--settle` needs a selector or coordinate target because web refs carry no geometry.
- `audio probe start [durationSeconds] [bucketMs]` samples HTML media elements into RMS/peak dBFS buckets; see [Debugging & Profiling](/docs/debugging-profiling#audio-probes).
- Not supported: tab/window/devtools control, network routing/interception/HAR, cookies/storage, downloads/uploads, arbitrary page scripting, multi-page orchestration, and raw browser diagnostics. Use `agent-browser` directly for those.

## Device isolation scopes

```bash
agent-device devices --platform ios --ios-simulator-device-set /tmp/tenant-a/simulators
agent-device devices --platform android --android-device-allowlist emulator-5554,device-1234
```

- `--ios-simulator-device-set <path>` limits simulator discovery and commands to that simulator set. iOS physical devices are not listed while it is set.
- If the selected Xcode can't resolve a scoped simulator for the Apple runner, the runner start fails with `details.reason: "simulator_set_destination_not_found"`, naming the set and, when known, the Xcode version.
- `--android-device-allowlist <serials>` limits Android discovery and selection to comma- or space-separated serials.
- Set the same scopes with the `iosSimulatorDeviceSet` and `androidDeviceAllowlist` config keys, or `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`. CLI flags override environment values, except under a `strip` session lock, which ignores conflicting per-call selectors.
- Start the daemon with `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET=<path>` to scope every iOS simulator request to one simulator set. A request without `--ios-simulator-device-set` uses that set, so iOS physical devices are not listed on that daemon. A request naming a different path string, including the same path with a trailing slash, fails with `INVALID_ARGS` and `details.reason: "ios_simulator_device_set_outside_daemon_set"`. macOS and other non-iOS requests ignore the set, and the host Mac stays listed. A daemon that the CLI starts inherits the CLI's environment, so later CLI calls with a different value still use the first value until the daemon restarts.
- Scope applies before `--device`, `--udid`, and `--serial`, so an out-of-scope selector fails with `DEVICE_NOT_FOUND`.
- On macOS, daemon startup removes any symlink at `~/Library/Developer/XCTestDevices`, including one you made yourself (for example to move it to another volume), and restores `XCTestDevices.agent-device-backup` when it exists. A symlinked `XCTestDevices` is not supported. Only the link is removed, never the directory it points to; `daemon.log` records each step and any failed restore, which doesn't stop the daemon.

## Device discovery

```bash
agent-device devices
agent-device devices --platform ios
agent-device devices --platform android
agent-device devices --platform harmonyos
agent-device devices --platform vega --target tv
agent-device devices --platform ios --ios-simulator-device-set /tmp/tenant-a/simulators
agent-device devices --platform android --android-device-allowlist emulator-5554,device-1234
agent-device capabilities --platform android
agent-device capabilities --session checkout --json
```

- `devices` lists available targets after applying `--platform` and [isolation scopes](#device-isolation-scopes).
- Each device carries `model` (such as `iPhone 17 Pro` or `Pixel 9`) and `osVersion` (such as `26.1` or `16`) when platform tooling reports them: `simctl` for iOS simulators, `devicectl` or `xctrace` for physical iOS devices, and `ro.product.model` and `ro.build.version.release` for running Android devices. Android emulators report the system image model, such as `sdk_gphone64_arm64`. Stopped AVDs and other platforms omit both fields. They describe a device and are not selectors.
- `capabilities` lists the commands the session device, or an explicit `--platform`/`--device`/`--udid`/`--serial` target, supports. JSON output is `{ device, availableCommands }`; use `availableCommands` instead of keeping your own platform support table.

### HarmonyOS command boundary

HarmonyOS support uses HDC and ArkUI `uitest`. On API 24 devices it supports lifecycle and HAP deployment, ArkUI snapshot/screenshot and selector reads, one-pointer touch and text actions, keyboard `enter`/`dismiss`, app logs, foreground app state, process RSS samples, and `settings clear-app-state`. Run `agent-device capabilities --platform harmonyos` for the command list of a selected device.

- `gesture pan|fling|swipe` and `swipe` use single-pointer input. Multi-touch gestures and target-authored `gesture drag` return `UNSUPPORTED_OPERATION`.
- Physical devices support whole-screen recording with `record start <path> --scope device` or `--scope system`, without `--fps`, `--quality`, or `--hide-touches`. Emulator recording is rejected.
- Not available: orientation, clipboard, alerts, network/audio capture, push and app-event delivery, React Native helpers, and trace capture. `settings` supports only `clear-app-state`. `perf memory sample` reports process RSS; frame health and memory snapshots are unavailable.

## Diagnostics

```bash
agent-device doctor
agent-device doctor --platform ios
agent-device doctor --platform android --app com.example.myapp
agent-device doctor --remote --json
```

- `doctor` diagnoses device, app, Metro, and React Native setup for the selected target. It is read-only: it never boots, installs, or changes the device.
- `--platform ios|android|vega|macos|linux|web|apple` limits checks to one backend; without it, `doctor` checks every discoverable target.
- `--app <id-or-name>` adds app checks (install state, Metro and React Native wiring) for one bundle id or app name.
- `--remote` runs only the checks that don't need a booted device; use it in CI bootstrap.

## Prepare Apple runner

```bash
agent-device prepare ios-runner --platform ios --timeout 240000
```

- In Apple CI setup, run `prepare ios-runner` after the device is booted and the app is installed, before the first `snapshot`, `replay`, or `test`. It builds or reuses the Apple runner, starts it, and checks that it answers.
- `--timeout <ms>` is one budget shared by the Simulator boot and runner preparation; see [Navigation](#navigation).
- In JSON output, `buildMs`, `connectMs`, and `healthCheckMs` may overlap (`connectMs` includes `buildMs` when the runner is built). Use `timing.additiveParts` for additive phase totals.
- A cached runner that fails its health check is rebuilt once, and a runner stuck at launch is relaunched once.
- CI may cache `~/.agent-device/apple-runner/derived` when the cache key includes the exact agent-device package contents and Xcode version. A cached runner whose files no longer match their recorded digests is rebuilt.
- Each runner source or Xcode change creates a new key under `~/.agent-device/apple-runner/derived/<platform-folder>/`. After a build, agent-device deletes, on a best-effort basis, keys that are neither among the 3 last used nor used in the last day, and never one a build is holding or a live runner lease names; change the count with `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP` (see [Configuration](/docs/configuration#supported-environment-variables)). A key that can't be deleted is reported as a `runner_xctestrun_cache_eviction_failed` warning. A custom `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` is never swept or trimmed.
- `runner_cache_uncertifiable` means the build products couldn't be verified, for example a product outside the derived-data root, an unreadable entry, a file over 128 MB, or a socket. Point `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` at a plain directory you own, or replace the tree as the error hint describes.
- `~/.agent-device/ios-runner` belongs to older agent-device versions and is never touched. Delete it with `rm -rf ~/.agent-device/ios-runner` once no such version runs.
- Runner build and start output goes to the session's `runner.log`; `daemon.log` covers daemon startup.

## TV targets

```bash
agent-device open YouTube --platform android --target tv
agent-device apps --platform android --target tv
agent-device snapshot -i --platform android --target tv
agent-device tv-remote press down --platform android --target tv
agent-device tv-remote press select --platform android --target tv
agent-device tv-remote longpress select --platform android --target tv
agent-device tv-remote press select --duration-ms 900 --platform android --target tv
agent-device screenshot tv-focus.png --overlay-refs --platform android --target tv
agent-device open Settings --platform ios --target tv
agent-device screenshot apple-tv.png --platform ios --target tv
vega virtual-device start
agent-device devices --platform vega --target tv
agent-device open com.example.app.main --platform vega --target tv --session vega-tv
agent-device tv-remote press down --platform vega --target tv --session vega-tv
agent-device tv-remote press select --duration-ms 900 --platform vega --target tv --session vega-tv
agent-device close com.example.app.main --session vega-tv
vega virtual-device stop
```

- TV targets include Apple TV and Android TV simulators, emulators, and connected devices. Vega OS support is limited to the Vega Virtual Device (VVD).
- TV targets are focus-first: move focus with `tv-remote` before selecting a control. Don't use raw `adb shell input keyevent` in command plans.
- Android TV: app launch and app listing use `LEANBACK_LAUNCHER` activities. `tv-remote` sends ADB keyevents; `longpress <button>` is a 500ms hold, and any positive `--duration-ms` uses Android's longpress keyevent, which has no exact hold time.
- tvOS supports the same runner-driven commands as iOS (`snapshot`, `wait`, `press`, `fill`, `get`, `scroll`, `back`, `home`, `app-switcher`, `record`, and selector flows). `back` is the Siri Remote Menu button, `home` is Home, and the app switcher is a double Home press; `--duration-ms` is an exact hold. Helpers that are simulator-only on iOS, such as `gesture pinch`, `settings`, and `push`, are simulator-only on tvOS too.
- Vega OS: use `--platform vega --target tv` with Vega component IDs such as `com.example.app.main`, and `--serial VirtualDevice` to select the VVD explicitly. Commands go through the SDK-matched Vega CLI and VDA. The VVD supports app open/close, `back`, `home`, and every shared `tv-remote` button, with exact holds.
- Vega OS doesn't support physical Fire TV, app inventory, snapshot, screenshot, selectors, install, touch/text/gesture, logs, or performance; those report unsupported. Use the VVD display as visual truth.
- On Android TV and tvOS, use `screenshot --overlay-refs` for visual focus evidence, especially when focus metadata is missing or transient.

## Desktop targets

```bash
agent-device devices --platform macos
agent-device open TextEdit --platform macos
agent-device open --platform macos --surface desktop
agent-device snapshot -i --platform apple --target desktop
```

- `--platform macos`, or `--platform apple --target desktop`, selects the host Mac as a `desktop` target.
- Use an `app` session for normal app control: `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `back`, `screenshot`, `record`. In app sessions, `screenshot` captures the app window, not the whole desktop.
- Use the other surfaces to inspect desktop-wide UI before choosing an app, mainly with `snapshot`, `get`, `is`, and `wait`: `frontmost-app` is the focused app, `desktop` is the visible windows across the desktop, and `menubar` is the active app's menu bar and system menu extras. To click or fill inside one app afterwards, open it in an `app` session.
- `open <app> --platform macos --surface menubar` targets one app's menu bar extras. Prefer it for status-item apps, which often expose little through the `app` surface.
- Prefer selectors and `@ref`s; window positions shift between runs, so raw x/y is less stable. Use `click --button secondary` for context menus, then run `snapshot -i` again.
- On `frontmost-app` and `menubar`, `press` and `click` post synthetic mouse events (`desktop` is inspect-only). `--hold-ms` keeps the button down (at least 40 ms, default 60 ms), `--count` sends independent clicks, and `--double-tap` sends double-click pairs. Apps like Finder read two clicks at the default interval as one double-click; pass an `--interval-ms` longer than the system double-click time to keep them apart. Long schedules get the time they need, and a cancelled or interrupted click releases the button. `--jitter-px` is ignored on these surfaces.
- macOS also supports `clipboard read|write`, `trigger-app-event`, `logs`, `network dump`, `audio probe`, `alert`, and part of `settings` (see [Settings helpers](#settings-helpers)). `audio probe` samples host system audio and needs Screen Recording permission; see [Debugging & Profiling](/docs/debugging-profiling#audio-probes).
- Mobile-only commands are unsupported on macOS: `boot`, `shutdown`, `home`, `orientation`, `app-switcher`, `action-button`, `fold`, `install`, `reinstall`, `install-from-source`, and `push`.

Set `AGENT_DEVICE_MACOS_APP_BACKEND=native` to run macOS app sessions without XCTest. There is no Automation Mode overlay, the app can stay behind other windows, and your pointer stays yours while a drawn pointer shows each action.

- `click`, `press`, and `fill` use accessibility actions on the element at the target point, which must be inside one of the app's on-screen windows, not its menu bar. `type` inserts at the focused control or falls back to key events. `scroll` moves the scroll bar under the front window's center. Chromium-based apps expose their full tree. `screenshot` captures only the app's front window, even when it is covered.
- `record`, `prepare`, `back`, `longpress`, `--hold-ms`, `--double-tap`, `--button secondary`, gestures, and clicks on an element with no accessibility action fail with `UNSUPPORTED_OPERATION` (`reason: unsupported-device-backend`). Use the default XCTest backend for those.

```bash
# One app, full interaction
agent-device open TextEdit --platform macos
agent-device snapshot -i
agent-device fill @e3 "hello"
agent-device screenshot textedit.png
agent-device close

# Desktop-global inspection first
agent-device open --platform macos --surface desktop
agent-device snapshot -i
agent-device is visible 'role="window" label="Notes"'
agent-device screenshot desktop.png
agent-device close

# Menubar / menu-extra inspection
agent-device open --platform macos --surface menubar
agent-device snapshot -i
agent-device wait 'label~="Wi-Fi|Control Center|Battery"'
agent-device close

# Targeted menu bar app inspection
agent-device open MenuBarApp --platform macos --surface menubar
agent-device snapshot -i
agent-device close
```

## Snapshot and inspect

```bash
agent-device snapshot [--diff] [-i] [--depth, -d <depth>] [--scope, -s <scope>] [--raw] [--actions] [--observe-only] [--force-full] [--timeout <ms>]
agent-device diff snapshot [-i] [-d <depth>] [-s <scope>] [--raw]
agent-device get text @e1
agent-device get attrs @e1
```

- `--raw` returns the full provider tree, including offscreen nodes and structural wrappers. See [iOS capture behavior](/docs/snapshots#ios-capture-behavior) and [Android capture behavior](/docs/snapshots#android-capture-behavior).
- Android snapshots install the bundled snapshot helper on first use; a source checkout must run `pnpm build:android` before Android verification.
- `truncated: true` means the capture hit a backend node limit and the last elements in document order are missing; see [Truncated captures](/docs/snapshots#truncated-captures).
- `viewport: { width, height }` names the box node rects are measured in; see [Coordinates and viewport](/docs/snapshots#coordinates-and-viewport).
- `--scope <text|@ref>` re-roots the snapshot at the first matching node; see [Scope a snapshot](/docs/snapshots#scope-a-snapshot).
- `--actions` lists custom accessibility actions an element merged away (iOS simulator only, rejected with `--raw`); see [Snapshots](/docs/snapshots).
- `diff snapshot` (alias `snapshot --diff`) compares with the previous session baseline, then updates it.

## Wait and alerts

```bash
agent-device wait 1500
agent-device wait text "Welcome back"
agent-device wait @e12
agent-device wait 'role="button" label="Continue"' 5000
agent-device wait absent 'label="Loading..."' 5000
agent-device alert
agent-device alert get
agent-device alert wait 3000
agent-device alert accept
agent-device alert dismiss
```

- `wait` accepts a millisecond duration, `text <value>`, a snapshot ref (`@eN`), a selector, or strict `absent <selector>`. Every form except a plain duration takes an optional `[timeoutMs]`. Selector waits, including those inside `replay`, poll snapshot captures with the same backend and recovery as `is`. `wait` resolves selectors the same way as `click`, `fill`, `get`, and `is`.
- `wait absent <selector>` is strict absence, not a visibility check: it passes only when a complete, readable capture has zero matches, so hidden or off-screen matches keep it pending. It rejects `--scope` and `--depth`. Sparse, truncated, incomplete, and Android unreadable-content captures never satisfy it.
- `wait @ref` needs a snapshot from a prior `snapshot` command. It resolves the ref to its label or text, then waits for that text, so a duplicate label can match a different element than the original ref.
- Wait failures carry `error.details.reason` in `--json` output:
  - `wait_target_absent`: a positive wait never found a match.
  - `wait_target_present`: strict `wait absent` reached its deadline with valid captures that still contained matches.
  - `predicate_failed` means strict `wait absent` could not prove absence because no valid capture arrived, with the final observation/diagnostic preserved.
  - `wait_capture_stalled`: no readable capture arrived. Retriable.
  - `wait_deadline_exceeded`: a later capture used up the budget after an earlier readable capture.
  - `wait_readiness_exhausted`: the deadline ended while the iOS runner was still starting (`readinessPhase: runner-start`) or the Simulator app was still being found (`target-discovery`). Retry with a timeout that covers that work. The runner start keeps going on its own budget (10 minutes by default when no startup timeout is set), so the retry joins it; a start that spends that budget fails with `runner_start_budget_exhausted`, and the next command starts over.
  - `wait_landmark_identity_mismatch`: a replay destination guard refused the match.
  - `wait_stable_timeout`: the UI did not settle.
- Branch on `readableCaptures`, `waitedMs`, `matches`, and `firstMatch` instead of parsing error text. `firstMatch` carries identity and text only; absence failures make no visibility or rect claim.
- Polling wait timeouts, and a replayed wait refused with `wait_landmark_identity_mismatch`, also carry `captures`, `readableCaptures`, and `polls` so you can see where the budget went. Each poll has `startedMs`, `durationMs`, and an `outcome`: `readable`, `unreadable`, `retriable`, `deadline`, `runner-restart`, or `readiness`. Long waits keep the first 5 and last 25 polls. A wait that never saw a readable capture reports the error its polls hit, with that error's code and retry details, instead of a generic timeout; `wait stable` and a never-readable strict absence keep their own diagnostics. `logPath` links the full request log.
- `alert` (same as `alert get`) inspects or handles system alerts on iOS simulator, macOS desktop, and Android permission dialogs. On iOS it also covers app-owned modal popups with native blocking markers.
- Use `alert get` for a quick check, and `alert wait <short-ms>` only when a prompt may appear after async work. Don't use `settings permission` to answer a dialog already on screen; it is for setup before a flow.
- `accept` and `dismiss` are sent once on every platform and never replayed, even if the response is lost. On iOS the runner activates the button once, then only observes until the alert disappears, changes, or the deadline expires. A changed alert does not prove a permission was granted; verify the app outcome.
- An unreadable or ambiguous capture after the action fails with `error.details.runnerErrorCode: ALERT_CONFIRMATION_UNAVAILABLE`; an expired runner deadline fails with `ALERT_DEADLINE_EXCEEDED`. Neither proves the alert is gone or that nothing happened. Run `alert get` before acting again.
- iOS runner refusals carry `error.details.reason`: `runner_busy` means the runner ran nothing (`dispatched: no`); `runner_main_thread_timeout` means the action may still land (`dispatched: unknown`).
- If a sheet or permission prompt is visible but `alert` reports none, treat it as app UI: run `snapshot -i -s "<visible label>"`, then `press @ref`. Android alert support is snapshot-derived, and not every iOS simulator permission surface is a native alert.

## Interactions

```bash
agent-device click @e1
agent-device click @e1 --button secondary   # macOS secondary click / context menu
agent-device focus @e2
agent-device fill @e2 "text"          # Clear then type
agent-device fill @e2 "search" --delay-ms 80
printf %s "$PASSWORD" | agent-device fill @e2 --text-stdin   # Text from stdin, kept out of argv
agent-device type "text"              # Type into focused field without clearing
agent-device type "query" --delay-ms 80
agent-device press 300 500
agent-device press 300 500 --count 12 --interval-ms 45
agent-device press 300 500 --count 6 --hold-ms 120 --interval-ms 30 --jitter-px 2
agent-device swipe 540 1500 540 500
agent-device swipe 540 1500 540 500 --count 8 --pause-ms 30 --pattern ping-pong
agent-device gesture pan 200 420 0 -80 500
agent-device gesture pan 200 420 80 -40 700 --pointer-count 2
agent-device gesture fling right 200 420 180
agent-device gesture drag 'id="drag-source"' 'id="drop-target"'
agent-device gesture drag @e4~s12 'label="Archive"' 700 600 200
agent-device longpress 300 500 800
agent-device hover @e12 --settle       # Web only: move the pointer without pressing
agent-device scroll down 0.5
agent-device scroll down --pixels 320
agent-device scroll down --until 'label="Sign in"'
agent-device gesture pinch 2.0          # zoom in 2x
agent-device gesture pinch 0.5 200 400 # zoom out at coordinates
agent-device gesture rotate 35 200 420 # rotate app content
agent-device gesture transform 200 420 80 -40 2 35 700 # combined pan, zoom, and rotate
```

A successful `click` or `press` means the action was sent to where the command found the target. It does not confirm that the element received it or that the screen changed. When the next step depends on it, add `--verify` (reports `changedFromBefore`), add `--settle` (returns the diff once the UI goes quiet), or follow with `wait <selector>`. Before retrying a failed interaction, see [Retry after a failed command](#retry-after-a-failed-command).

A `click` or `press` whose target the daemon resolves to a point (`@ref` or selector) re-checks that target's position before dispatching when the session's previous action animated the screen, and dispatches where it came to rest. When that check cannot confirm a stable position — the target was still moving, or a re-check could not measure it — the command refuses with `target_still_moving` and `dispatched: no`: nothing was dispatched, the point the command resolved is in `error.details.rect`, and where the target was last seen is in `error.details.movedToRect` when that last look measured one. Run `wait <selector>` on the target and retry the same command, or add `--settle` so the action waits for the UI to go quiet. A refused `@ref` press needs a fresh `snapshot -i` and a selector, because the wait retires the ref. Two dispatch paths hand off before the check: a press at raw coordinates has no resolved target to re-check, and a dispatch the backend performs on the element itself — `click @ref` on a backend with element dispatch, or a Maestro non-hittable coordinate fallback — goes to that backend rather than through a resolved point.

### Text entry

- `fill` clears then types. `type` appends to the focused field and accepts text only: use `fill @ref "text"` to target a field, or `press @ref` then `type "text"`.
- Use plain `fill` or `type` first. Add `--delay-ms` only when a debounced or search-as-you-type field misses characters, or the app must receive each incremental update; delayed typing enters characters one at a time instead of using a clipboard-style fallback.
- `fill --text-stdin` reads the text from stdin so a secret never appears in process arguments. Pipe it with `printf %s`. It reads at most 64 KiB, removes one trailing newline, and refuses a terminal, empty input, invalid UTF-8, or an extra text argument. Output shows the value as `${VAR}` with `--record-as <VAR>` and as `[REDACTED]` otherwise, including in error messages and details. While script recording is armed, pass `--record-as <VAR>` or `--no-record`; passing neither is an error. Batch steps don't accept it.
- The privacy controls for typed input (`--text-stdin` and `--record-as`) keep the literal out of agent-device's own responses, diagnostics, and recorded scripts. They do not rewrite what the platform records: on iOS, XCTest writes its own diagnostic logs and its `.xcresult` bundle, and typed text can appear in both, on a simulator or a physical device. Treat those as sensitive, and use test-only credentials when they may be kept or shared. See [Security & Trust](/docs/security-trust).
- Android text entry is owned by `agent-device`. Don't fall back to raw `adb`, clipboard, or paste; if non-ASCII is unsupported on the current backend, report the gap. Android `fill` verifies the text and fails instead of retrying when the IME captures input.

Text-entry errors and what to do:

- `TEXT_INPUT_NOT_FOCUSED` (`type`): focus a visible text input and retry. If accessibility does not expose the input, focus it by coordinates.
- `TEXT_INPUT_SYNTHESIS_UNAVAILABLE` (iOS `type "\n"` with the software keyboard hidden): show the software keyboard, then retry.
- `TEXT_INPUT_COMMIT_NOT_OBSERVED` (iOS `fill`): the runner could not confirm the text landed before its deadline, or the text equals the field's placeholder. The field may hold none, part, or all of it. Run `snapshot -i`; if it doesn't match, retry with the full text quoted and `fill --delay-ms 80`.
- `TEXT_INPUT_CLEAR_NOT_OBSERVED` (iOS `fill`): the old text was not seen cleared, so nothing was typed. Inspect with `snapshot -i`, then retry `fill`.
- `TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED` (iOS `fill`): the text is too long to type in one runner command, and nothing was typed. Fill up to the character limit the hint names for your `--delay-ms`, then append the rest with `type`. `--delay-ms` lowers the limit; a longer timeout does not help.
- `TEXT_ENTRY_MISMATCH` (iOS `fill`): the settled value contains only characters, in order, from the field's value after clearing plus your text. That covers dropped characters and an unchanged value. This can also reject legitimate filtering, trimming, or masks (`5` into `$0.00` may show `$0.05`). Retry `fill --delay-ms 80` only if inspection shows the field needs correction.

Except for `TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED`, where you append the rest with `type` after the shorter `fill`, recover from these with `fill`, never `type`, which appends to whatever the field already holds. iOS `fill` types the replacement once and does not clear and retype a mismatch on its own.

On iOS, a single-line `fill` ending in a submit key, or a field that became unreadable or disappeared after typing, succeeds without verification; assert the resulting screen.

`fill` returns `verification: "unconfirmed"` when the field's settled value differs from the request but no failure is proven, such as app formatting (`00 062 91 77` for `000629177`, `$10.00` for `1000`) or an OTP field announcing `6 of 6 digits`. Missing, reordered, duplicated, or stale text can also produce it. Inspect `requested`, `before`, and `after`, then assert the value or the resulting screen:

```bash
agent-device wait 'id="field-phone" value="00 062 91 77"'
```

### Pointer and gestures

- `click --button secondary` opens a macOS context menu; `--button middle` is unsupported on macOS.
- `longpress` is supported on iOS and Android. `hover` is web only: it moves the pointer over a target without pressing so hover-gated UI appears, and `--settle` returns what it revealed. Touch platforms reject it; use `longpress` for the hold gesture.
- `swipe` is a quick, fixed-duration throw. `gesture pan x y dx dy [durationMs]` is a deliberate timed drag with one pointer, or two with `--pointer-count 2`. Repeated swipes allow at most 200 repetitions, 10000ms pauses, and 60000ms in total.
- `gesture fling up|down|left|right x y [distance]` is a fast directional throw. Neither `swipe` nor `gesture fling` takes a duration, and `gesture rotate` takes no velocity; see [Rewrite Old Gesture Commands](/docs/migrating-gestures) to update old scripts.
- `gesture drag source destination [sourceHoldMs] [moveMs] [destinationHoldMs]` holds one pointer down from source to destination. Endpoints are selectors or refs, resolved before dispatch and recorded as selector chains. Defaults are 800, 500, and 0ms, capped at 10000ms in total. It works on Android touch devices and iOS/iPadOS; other backends refuse it before touching the screen.
- `gesture pinch <scale> [x] [y]`, `gesture rotate <degrees> [x] [y]` (the sign sets direction), `gesture transform x y dx dy scale degrees [durationMs]`, and two-finger `gesture pan` work in Android and iOS simulator app sessions. One-finger `gesture pan` works wherever coordinate drags do. A path that does not fit the viewport fails before injection instead of being clamped. Use `orientation` to rotate the device.
- App recognizers may not report exactly the requested pan, scale, and rotation. Verify app-level state such as `pan changed yes`, and prefer separate `gesture pan`, `gesture pinch`, or `gesture rotate` commands when exact values matter. See `agent-device help gestures`.

### Scroll

- `scroll <direction> [amount]` takes the finger path as a fraction of the viewport (`0.5` is half), or `--pixels <n>` for a fixed distance. Large distances are clamped. The app's scroll physics decide the final offset, so a scroll does not land on an exact position.
- `scroll <direction> --until <selector>` repeats passes until the selector is on screen and fails if the content runs out first. Add an amount (`scroll down 0.8 --until <selector>`) to widen each pass. Use it in `.ad` scripts too, instead of fixed amounts that depend on screen size; see [Replay & E2E](/docs/replay-e2e).
- Default snapshot text summarizes off-screen interactive content instead of listing refs. `scroll <direction> --settle` (and `back --settle`) waits for the UI to go quiet and returns the diff with fresh refs, so you don't need another `snapshot -i`. Settle is best-effort and never fails the action.
- On Android, settle ignores an allowlist of system-bar containers and shade/keyguard status headers; other SystemUI overlays remain content. Appium settle also applies package rules for keyboard and system chrome.
- With a keyboard up on iOS or Android, the swipe stays above the keyboard (reported as `keyboardAvoided` and `keyboardMinY`) and the keyboard stays open. If too little room is left, the command refuses with `scroll_keyboard_occludes_surface`; run `keyboard dismiss` first.
- A directional scroll reports what it observed as `movement`: `moved`, `at-edge` (no change and no more content that way), `unchanged` (no change, no edge signal), or `unobserved` (no reliable comparison). If nothing changed, the swipe ran inside a container, and that container still has hidden content in that direction, it refuses with `scroll_no_progress`; the hint names the usual causes: a focused keyboard, a nested scroller, or a list that needs a raw `swipe`. See `agent-device help scroll`.

## Retry after a failed command

When a command fails, read `error.details.dispatched` before you retry:

- `no`: the action never reached the device. Retry it as it is.
- `unknown`: the action may have landed. Take a snapshot before you retry; a blind retry can tap, type, or navigate twice.
- Missing: no guarantee. Treat it as `unknown`.

Read-only commands such as `get`, `snapshot`, and `wait` report `no`, and so do `record`, `trace`, and `perf`, whose controls the device refuses to repeat. On Android, dismissing a blocking system dialog or ANR prompt first does not count as a dispatched step. Once any step of a request reached the device, the failure is `unknown` and `error.details.dispatchedSteps` counts those steps; a `batch` or replay reports `no` only when none of its executed steps changed the app.

These refusals carry `dispatched: no` and a typed `error.details.reason`, so branch on the reason, not the message:

- `session_or_device_selector_required`: the request had neither an active session nor a device selector. Open a session or pass `--platform`.
- `session_app_required`: a per-app setting was requested but the session binds no app and none was named. Run `open <app>`, or name the app on the request for a setting that takes one (`settings clear-app-state com.example.app`).
- `app_not_installed`: the named app resolves to no installed app on the target. Run `apps --all` for the exact bundle id or package, or install the app, then retry.
- `webdriver_route_unsupported`: on a WebDriver-backed device cloud, the driver does not implement the route; the limit is the cloud's driver, not the device. A command with a second route (`orientation` has two) tries it before failing. After an ambiguous failure on that transport, only read-only requests are resent.

## Find (semantic)

```bash
agent-device find "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find role button click
agent-device find "Follow" list
```

`find` locates an element by text, label, or role and runs an action on it (`click` by default). See [Selectors](/docs/selectors) for the action list, ambiguous matches, and `--first`/`--last`.

## Assertions

```bash
agent-device is visible 'role="button" label="Continue"'
agent-device is exists 'id="primary-cta"'
agent-device is absent 'label="Loading..."'
agent-device is hidden 'text="Loading..."'
agent-device is editable 'id="email"'
agent-device is selected 'label="Wi-Fi"'
agent-device is text 'id="greeting"' "Welcome back"
```

- `is` evaluates UI predicates against a selector expression and exits non-zero on failure. It takes selectors, not refs like `@e3`, and the same snapshot flags as `click`, `fill`, `get`, and `wait`.
- Supported predicates are `visible`, `hidden`, `exists`, `absent`, `editable`, `selected`, `focused`, and `text`.
- `is visible` passes when the element is in the visible viewport, or has no rect of its own but sits inside a visible ancestor. `is exists` only checks that the selector matches.
- `is text <selector> <value>` compares the element's text with the value. `wait text` checks that text is present, not that it can be tapped.
- `is absent` passes only when the selector has zero matches in one readable, complete, settled, unscoped, full-depth capture. It does not mean hidden: `--scope` and `--depth` are rejected, and sparse, unreadable, truncated, or unsettled captures fail.
- Predicates that name one element (all except `exists` and `absent`) and `get attrs` fail with `AMBIGUOUS_MATCH` when the selector matches more than one node; that is not a missing element. `error.details.matches` has the count, and up to five candidate `@ref`s are listed, pinned to `error.details.refsGeneration`, so you can act on one directly. Without a stored tree (a sparse capture), only the count is reported. See [Selectors](/docs/selectors#find-an-element).
- On iOS, React Native text appears as two nodes with the same label. Selectors that must resolve one element (`is`, `get attrs`, `screenshot --crop-on`, replay) treat the pair as one; `find ... list` and `snapshot --json` show both.
- On the web, on-screen text the browser cannot hand an action to (static text, a `status` announcement) is in the tree and readable by `wait text`, `find text`, `get text`, and `text=`, but carries no `@ref` and has no rect: `find ... list` prints it as `(no ref)`, and it is never a tap target. Such text is published on `value`, so `value="X"` can match page text as well as a field holding that text, and a predicate that needs one element then reports `AMBIGUOUS_MATCH`; use `text=` for page text, or add `editable=true` to name the field.
- The first read after `scroll`, `swipe`, or `gesture swipe` waits for two captures to agree. When that proves something about the gesture, `is`, `get`, `find`, `wait`, interactions that captured it, and `snapshot` add a warning, and all but `snapshot` report `postGestureOutcome` (`{ "kind", "gesture": { "action", "positionals" } }`) in `data` or `error.details`:
  - `kind: "unsettled"`: the screen was still changing. A miss is not proof of absence; read again. `is absent` refuses with `observation: "unsettled"`, and `wait absent` keeps polling.
  - `kind: "no-effect"`: nothing changed. The list may be at its edge or ignore synthesized scrolls; a raw `swipe x1 y1 x2 y2` inside it moves such lists.

## Replay

```bash
agent-device open Settings --platform ios --session e2e --save-script [path]
agent-device replay ./session.ad      # Run deterministic replay from .ad script
agent-device test ./suite             # Run every .ad file in a folder or glob serially
agent-device test ./suite --timeout 60000 --retries 1
agent-device replay ./session.ad --from 4 --plan-digest <sha256>   # Execute step 4; if already completed, use the next safe index with this digest
agent-device replay ./session.ad --keep-session   # Suppress its terminal close and continue interactively
```

- `--save-script [path]` on `open` records a replay script when the session closes.
- `replay` runs deterministic `.ad` scripts. Script paths are read on the calling machine, so the same command works with a local or remote daemon. `--keep-session` skips only an authored final `close`.
- `test` runs `.ad` files, directories, or globs as a serial suite and streams `pass`/`fail`/`skip` on stderr (`--verbose` prints every result). `--platform` filters by each script's `context platform=...` header, `--timeout` and `--retries` (max `3`) apply per attempt, and `--artifacts-dir` overrides `.agent-device/test-artifacts`.
- A failing step returns a `REPLAY_DIVERGENCE` report; `replay --from <n> --plan-digest <sha256>` resumes at plan step `n` (`test` rejects `--from`). See [Resume a failed replay](/docs/replay-e2e#resume-a-failed-replay).
- `replay -u`/`--update` is accepted and does nothing; it does not rewrite the script.

See [Replay & E2E](/docs/replay-e2e) for recording and CI workflow details, and [Run Maestro flows](/docs/run-maestro-flows) for Maestro YAML.

## Batch

```bash
agent-device batch --steps-file /tmp/batch-steps.json --json
agent-device batch --steps '[{"command":"open","input":{"app":"settings"}}]'
```

- `batch` runs a JSON array of `{ command, input, runtime? }` steps in a single daemon request and stops at the first failing step.
- `--max-steps <n>` sets the per-request step limit.
- In non-JSON mode, successful batches print a short per-step summary.

See [Batching](/docs/batching) for payload format, response shape, and usage guidelines.

## App install (in-place)

```bash
agent-device install com.example.app ./build/app.apk --platform android
agent-device install com.example.app ./build/MyApp.app --platform ios
```

- `install <app> <path>` installs from a binary path without uninstalling first, keeping existing app data where the platform allows. Use it for upgrade flows.
- Supports Android devices/emulators, iOS simulators, and CoreDevice-backed iOS physical devices. On xctrace-only devices, install the app with Xcode before opening it by bundle ID.
- Formats: Android `.apk`/`.aab`, iOS `.app`/`.ipa`, HarmonyOS `.hap`. For an `.ipa` with several app bundles, `<app>` picks one by bundle id or name.
- `.aab` requires `bundletool` in `PATH`, or `AGENT_DEVICE_BUNDLETOOL_JAR=<absolute-path-to-bundletool-all.jar>` with `java` in `PATH`; it installs a universal APK.
- Remote daemons upload local app files automatically; prefix the path with `remote:` to use a path on the daemon host as is.

## App reinstall (fresh state)

```bash
agent-device reinstall com.example.app ./build/app.apk --platform android
agent-device reinstall com.example.app ./build/MyApp.app --platform ios
```

- `reinstall <app> <path>` uninstalls and installs in one command, for login/logout resets and deterministic test setup. Device coverage, formats, and remote upload match `install`.

## App install from source URL

```bash
agent-device install-from-source https://example.com/builds/app.apk --platform android
agent-device install-from-source https://example.com/builds/app.aab --platform android
agent-device install-from-source --github-actions-artifact thymikee/RNCLI83:6635342232 --platform android
```

- `install-from-source <url>` installs an artifact the daemon can reach at a URL; use `install` or `reinstall` for local files. Device coverage matches `install`.
- A URL may point to an Android `.apk` or `.aab`, or, from any public host, to an archive containing one `.apk`, `.aab`, `.ipa`, or iOS `.app`.
- `--github-actions-artifact <owner/repo:artifact>` lets a compatible remote daemon fetch a GitHub Actions artifact with its own credentials. A numeric artifact is treated as an id, anything else as a name.
- Repeat `--header <name:value>` for authenticated or signed downloads. Sensitive headers are not forwarded to other origins.
- `--retain-paths` keeps the downloaded and extracted files after install; `--retention-ms <ms>` sets how long.
- Limits: at most five redirects, no HTTPS-to-HTTP downgrade, 2 GiB download, 4 GiB extracted, 100,000 entries, and three nested archive layers. Links and special archive entries are rejected. `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are honored. These match the Node.js client's `installFromSource()` checks.

## Push notification simulation

```bash
agent-device push com.example.app ./payload.apns --platform ios
agent-device push com.example.app '{"aps":{"alert":"Welcome","badge":1}}' --platform ios
agent-device push com.example.app '{"action":"com.example.app.PUSH","extras":{"title":"Welcome","unread":3,"promo":true}}' --platform android
```

- `push <bundle|package> <payload.json|inline-json>` simulates push notification delivery to the session device or the one named by `--platform`, `--device`, `--udid`, or `--serial`.
- iOS: simulator only, with an APNs-style JSON object payload.
- Android: sends a broadcast with the payload `{"action":"<intent-action>","receiver":"<optional component>","extras":{...}}`. Extras may be strings, booleans, or numbers.

## App event triggers (app hook)

```bash
agent-device trigger-app-event screenshot_taken '{"source":"qa"}'
```

- `trigger-app-event <event> [payloadJson]` opens your app's deep-link hook with an app-defined event; it does not post OS-level notifications. `payloadJson` must be a JSON object.
- Needs an active session or a device selector (`--platform`, `--device`, `--udid`, `--serial`). On iOS physical devices, open the app in the session first.
- Set the URL template with `AGENT_DEVICE_APP_EVENT_URL_TEMPLATE`, or per platform with `AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE`, or `AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`. Placeholders are `{event}`, `{payload}`, and `{platform}`, for example `myapp://agent-device/event?name={event}&payload={payload}`.

## Settings helpers

```bash
agent-device settings wifi on
agent-device settings wifi off
agent-device settings airplane on
agent-device settings airplane off
agent-device settings mobile-data off
agent-device settings mobile-data on
agent-device settings location on
agent-device settings location off
agent-device settings location set 37.3349 -122.009
agent-device settings animations off
agent-device settings animations on
agent-device settings text-size
agent-device settings text-size large
agent-device settings text-size accessibility-extra-large
agent-device settings appearance light
agent-device settings appearance dark
agent-device settings appearance toggle
agent-device settings faceid match
agent-device settings faceid nonmatch
agent-device settings faceid enroll
agent-device settings faceid unenroll
agent-device settings touchid match
agent-device settings touchid nonmatch
agent-device settings touchid enroll
agent-device settings touchid unenroll
agent-device settings fingerprint match
agent-device settings fingerprint nonmatch
agent-device settings clear-app-state
agent-device settings clear-app-state com.example.app
agent-device settings reset-keychain clear
agent-device settings permission grant camera
agent-device settings permission deny microphone
agent-device settings permission grant photos limited
agent-device settings permission reset notifications
agent-device settings permission grant camera --app com.example.app
agent-device settings location on --app com.example.app
agent-device settings permission grant accessibility --platform macos
agent-device settings permission reset screen-recording --platform macos
```

Platform support:

- iOS `settings` works on simulators only.
- macOS supports only `settings appearance <light|dark|toggle>` and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>`.
- `settings appearance` sets macOS appearance, iOS simulator appearance, or Android night mode.
- `settings location set <lat> <lon>` sets coordinates on iOS simulators and Android emulators.
- A target that does not serve a setting refuses it with `UNSUPPORTED_OPERATION` and `error.details.reason` (for example `unsupported-platform-leaf`) before anything changes. A request that names an app the change cannot take is refused first, with `INVALID_ARGS` and `setting_app_not_consumed`. `settings --help` describes where each setting runs.

Device settings:

- `settings animations off|on` (Android) sets the window, transition, and animator scales. Turn animations off to stabilize runs with heavy animation, and back on afterward.
- `settings airplane on|off` (Android) needs the connectivity service's `cmd connectivity airplane-mode` command, available from Android 11. It reports the resulting `airplaneMode`; a build without that command fails with `UNSUPPORTED_OPERATION` without changing anything. Connectivity takes a moment to settle, so poll the app rather than asserting offline behavior immediately.
- `settings mobile-data on|off` (Android over adb) switches mobile data with `svc data enable|disable` and reports the resulting `mobileData` from the global `mobile_data` row. If that row does not settle to the request within 2 seconds, it fails with `COMMAND_FAILED`: `error.details.reason` is `mobile-data-unreadable` if the final read is neither `0` nor `1`, or `mobile-data-not-applied` if it is the opposite state. Pair it with `settings wifi off` to move a session such as a video stream from Wi-Fi to cellular, and back with `settings wifi on`. Poll the app while the network hands over.
- The read-back covers single-SIM targets only. A multi-SIM device stores the switch per subscription and can leave `mobile_data` unchanged, so the command may fail there even when the switch took effect. A target without an active SIM can also accept `svc data` without changing the row, and with Wi-Fi off it is offline rather than on cellular.
- Mobile data is device-wide, so `--app` is refused with `setting_app_not_consumed`. Every target without adb refuses `mobile-data` with `UNSUPPORTED_OPERATION` before anything runs.
- `settings text-size` reads the current size; `settings text-size <category>` sets one: `extra-small`, `small`, `medium`, `large`, `extra-large`, `extra-extra-large`, `extra-extra-extra-large`, `accessibility-medium`, `accessibility-large`, `accessibility-extra-large`, `accessibility-extra-extra-large`, or `accessibility-extra-extra-extra-large`. It works on iPhone and iPad simulators and on Android; every other target refuses both read and write. The read reports `category` and the target's own `platformValue` (iOS may capitalize it, for example `extra-Small`).
- Android has only a font-scale multiplier, mapped so `large` is `1.0` and `accessibility-extra-extra-extra-large` is `3.2`. A value between rungs reads as the nearest category, with the exact multiplier in `platformValue`; an unset scale reads as `large`.
- A running app adopts a new text size only at its next configuration change. Relaunch it (`open <app> --relaunch`) before asserting rendered sizes.

Biometrics:

- `faceid` and `touchid` work on iPhone and iPad simulators with any Xcode; Apple TV and Vision Pro simulators refuse them. `enroll`/`unenroll` change enrollment.
- `fingerprint` works on Android targets where `cmd fingerprint` or `adb emu finger` is available; physical devices use `cmd fingerprint` only.
- `match` and `nonmatch` simulate a valid or invalid Face ID, Touch ID, or fingerprint.

App state:

- `settings clear-app-state [app-id]` clears the data of the session app or the named app (positional or `--app`, not two different ones). On Android this removes preferences, databases, files, and cache; on iOS simulators it empties the app's data container. It is unsupported on iOS physical devices and macOS.
- It does not touch the keychain, so keychain-backed credentials such as Firebase auth survive. `settings reset-keychain clear` resets the iOS simulator keychain for **every** app on that simulator, not only yours; pair it with `clear-app-state` for a fresh-install reset. It is unsupported on iOS physical devices, Android, and macOS.
- An app with no data container, such as a simulator's built-in `com.apple.Preferences`, refuses with `UNSUPPORTED_OPERATION` and `error.details.reason: app-no-data-container`. Built-in apps cannot be uninstalled either; erase or recreate the simulator to reset one.

Permissions:

- On iOS and Android, `permission` and iOS simulator `location on|off` apply to the session app. Pass `--app <bundle-id, package, or name>` to target an installed app without opening it, for example to grant a permission before first launch. The app need not be running. Unlike `open`, which passes an unknown id through, settings resolve only installed apps, the same way `clear-app-state` does. On an iOS simulator, a dotted name is first matched against installed bundle ids, and any name against installed display names (`--app Maps` is `com.apple.Maps`). On Android, a package must be installed, and any other name is matched against installed package names. A Limrun iOS session resolves only the `settings` alias.
- `--app` counts only when passed on the command line; `AGENT_DEVICE_TARGET_APP` and `targetApp` in `~/.agent-device/config.json` never retarget a settings change.
- Refusals for `permission`, `location`, and `clear-app-state`, all with `dispatched: no` and nothing changed:
  - `app_not_installed` (`APP_NOT_INSTALLED`): the app resolves to nothing installed.
  - `session_app_required`: no session app and none named. Run `open <app>`, or name the app.
  - `setting_app_not_package` (`INVALID_ARGS`, Android): the name is an intent alias such as `settings`, not a package.
  - `setting_app_not_consumed`: the change is device-wide and cannot take an app: `location set`, the Android `location on|off` toggle, macOS permissions, and `mobile-data`.
- iOS targets: `all`, `camera`, `microphone`, `photos` (`full` or `limited`), `contacts`, `contacts-limited`, `notifications`, `calendar`, `location`, `location-always`, `media-library`, `motion`, `reminders`, `siri`. The simulator decides which it can change; one it refuses fails with `UNSUPPORTED_OPERATION` naming it. On current runtimes that is `notifications`, which `all` also leaves untouched.
- Android targets: `all`, `calendar`, `camera`, `contacts`, `location`, `media-library`, `microphone`, `notifications`, `photos`. Targets covering several permissions apply only the ones the app declares and fail if it declares none; `all` applies every declared permission. The response reports `permission` (what you asked for) and `permissions` (what was changed).
- macOS targets: `accessibility`, `screen-recording`, `input-monitoring`. `grant` checks or requests access and opens System Settings when needed; it never grants silently. `deny` is unsupported.
- `full|limited` applies only to iOS `photos`.
- Android `reset` revokes. Changes apply to the device's foreground user; if it cannot be determined, the command fails with `COMMAND_FAILED` and changes nothing.
- Android kills a running app when one of its granted permissions is revoked. `deny` and `reset` report `priorGrantState` (`granted`, `not_granted`, or `unknown`) and warn you to run `open <app> --relaunch` unless it was `not_granted`.

## App state and app lists

```bash
agent-device appstate
agent-device apps --platform ios
agent-device apps --platform ios --all
agent-device apps --platform android
agent-device apps --platform android --all
```

- Android and HarmonyOS `appstate` report the live foreground package and activity.
- iOS and macOS `appstate` need a session and report that session's app: `appName`, `appBundleId`, and a `source`. On iOS, when a live runner answers the read, the answer carries its `state` (`runningForeground`, `runningBackground`, `runningBackgroundSuspended`, `notRunning`, or `unknown`) with `source: runner`. They never start a runner; when no live runner answers — none is running, or it cannot reply right now — they report `source: session` and no `state`, and on macOS the answer is always session-scoped. On iOS, after `home` the app reports a background state; which app took the screen is not reported. A command that had to bring the app back reports a [`targetActivation` disclosure](#foreground-repairs-on-ios).
- `apps` shows user-installed apps. Add `--all` to include system and OEM apps.

## Foreground repairs on iOS

An iOS session is bound to one app, but a deep link, a system sheet, or `simctl openurl` can hand the
screen to another app. The next command brings the session app back so it can answer, and reports
that repair:

```bash
agent-device open com.example.app --platform ios
agent-device screenshot --platform ios            # Safari screen
agent-device snapshot -i --platform ios           # answers with the app's tree
```

The `snapshot` response carries `targetActivation` and a warning:

```json
{
  "targetActivation": {
    "reason": "bundle_changed",
    "priorState": "runningBackground",
    "otherActiveApplicationPid": 4562
  }
}
```

- Anything captured earlier in the session described the other app. Capture again, or drive the
  other app in its own session.
- `reason` names the check that caught it: `bundle_changed` (the runner's cached target differs from
  the requested bundle), `stale_target` (the cached target no longer answers as foreground),
  `missing_after_wait` (a wait never saw the app), or `interaction_foreground_guard` (an
  interaction's guard tripped before dispatch).
- `priorState` is the app's state before the repair; it is never `runningForeground`.
- `otherActiveApplicationPid` appears only when exactly one other app held an accessibility session.
  It does not prove that app owned the screen, and its absence is not a failure.
- `snapshot`, `find`, `get`, `is`, `wait`, and interactions that captured a tree report it at every
  `--level`, including `digest`; on failure it is in `error.details` and the hint. In text mode it
  prints as a `Warning:` line after any earlier warnings; see [Output and warnings](#output-and-warnings).
  Reads answered from a cached tree did no repair and report none.
- **Silence is not proof.** A coordinate `press`, a `press @ref` answered from a live ref frame, or
  a `wait <text>` satisfied on its first poll may re-activate the app without saying so. When it
  matters, run `snapshot -i` and read its disclosure
  ([#2694](https://github.com/callstack/agent-device/issues/2694)).
- **No read launches a stopped app.** `snapshot`, `wait`, `is`, `get`, a reading `find`, and the
  leading read of `gesture` or a selector `click`/`fill` bring a backgrounded app forward but never
  start one that is not running, because a launch could drop a URL waiting behind an "Open in …?"
  prompt. They fail with `COMMAND_FAILED`, `details.runnerErrorCode: "APP_NOT_RUNNING"`, and
  `retriable: true`; `wait` keeps polling. Answer the prompt with `alert accept`, or relaunch with
  `open`. Commands that act without reading first (`press`, coordinate `fill`, `swipe`, `scroll`,
  hardware keys) still start a stopped app.

## Clipboard

```bash
agent-device clipboard read
agent-device clipboard write "https://example.com"
agent-device clipboard write ""   # clear clipboard
```

- `clipboard read` returns the target's clipboard text; `clipboard write <text>` replaces it. Treat read output as sensitive: it can contain copied secrets.
- Works with the session device or a device selector (`--platform`, `--device`, `--udid`, `--serial`).
- Supported on macOS, iOS simulators, and Android builds whose clipboard service answers `cmd clipboard`. iOS physical devices return `UNSUPPORTED_OPERATION`.
- On Android 16 (API 36), both actions return `UNSUPPORTED_OPERATION` and `capabilities` omits `clipboard`; see [Known Limitations](/docs/known-limitations#android-no-clipboard-access-over-adb-on-android-16).

## Keyboard

```bash
agent-device keyboard status
agent-device keyboard get
agent-device keyboard dismiss
```

- `keyboard status` (or `keyboard get`) reports keyboard visibility and a best-effort input type on Android emulators and devices.
- `keyboard dismiss` taps a safe control such as `Done` when available and checks that the keyboard closed. It works on Android and, best-effort, on iOS simulators and devices. If it returns `UNSUPPORTED_OPERATION`, press a visible app control such as `Done` only when that is the intended fallback.
- Works with the session device or a device selector (`--platform`, `--device`, `--udid`, `--serial`).

## Performance diagnostics

```bash
agent-device perf frames --json
agent-device perf memory sample --json
agent-device perf memory snapshot --kind android-hprof --out app.hprof
agent-device perf memory snapshot --kind memgraph --out app.memgraph
agent-device cdp target list --url http://127.0.0.1:8081
agent-device cdp memory usage sample --label baseline --gc
agent-device cdp memory snapshot capture --name baseline --gc
agent-device perf cpu profile start --kind xctrace --template "Time Profiler" --out app.trace
agent-device perf cpu profile stop --kind xctrace --out app.trace
agent-device perf cpu profile report --kind xctrace --out app-profile.json
agent-device perf trace start --kind xctrace --template "Animation Hitches" --out hitches.trace
agent-device perf trace stop --kind xctrace --out hitches.trace
agent-device perf cpu profile start --kind simpleperf --out cpu.perf.data
agent-device perf cpu profile stop --kind simpleperf --out cpu.perf.data
agent-device perf cpu profile report --kind simpleperf --out cpu-report.json
agent-device perf trace start --kind perfetto --out app.perfetto-trace
agent-device perf trace stop --kind perfetto --out app.perfetto-trace
```

- Name one area: `frames`, `memory`, `cpu`, or `trace`. Bare `perf`, `perf sample`, `perf metrics`, and the `metrics` alias fail with guidance to the focused replacements.
- `perf frames` returns frame/jank health (`droppedFramePercent`, `worstWindows`). `perf memory sample` returns a compact process memory sample in kilobytes. `perf memory snapshot` writes a heap or memgraph artifact and returns its path.
- `perf cpu profile` and `perf trace` record Apple (`--kind xctrace`) or Android (`--kind simpleperf`, `--kind perfetto`) profiles and traces, and return artifact paths plus compact metadata; raw contents stay on disk.
- `cdp` samples and snapshots the React Native JavaScript heap through Metro CDP; see [Debugging & Profiling](/docs/debugging-profiling#react-native-js-memory-through-cdp).
- App startup duration is returned in `open`'s `startup` result.
- Perf commands need an app session with a package or bundle ID; run `open <app>` first.
- Platform support:
  - `perf frames`: Android emulators and devices, and connected iOS devices. iOS simulators and macOS report it unavailable because Apple tooling exposes no trustworthy hitch data there.
  - `perf memory sample`: Android, HarmonyOS devices, iOS simulators and devices, and macOS.
  - `perf memory snapshot --kind android-hprof`: Android, for a running debuggable or profileable process that permits heap dumps. `--kind memgraph`: iOS simulators and macOS; physical iOS devices report it unavailable with a recovery hint. Native heap tracing (`perf memory trace --kind heapprofd`) is not available.
  - `--kind xctrace`: iOS simulators, connected iOS devices where xctrace can attach to the app process, and macOS when the app process resolves from the bundle ID (for `perf trace`, when the template supports the target). It does not profile Android.
  - `--kind simpleperf` and `--kind perfetto`: Android app sessions with a running package process only.
  - HarmonyOS is memory-only: CPU profiling, frame sampling, and memory snapshots are unavailable.

For the measurement workflow, data sources, and output examples, see [Performance snapshots](/docs/debugging-profiling#performance-snapshots).

## React Native components

```bash
agent-device react-devtools tree [@ref|Name] [--depth 8] [--limit 60]
agent-device react-devtools find <Name> [--exact] [--limit 20]
agent-device react-devtools inspect <@ref|Name>
agent-device react-devtools errors [--limit 10]
```

- `tree` prints the mounted component tree with `@c` refs. A chain of single-child wrappers, such as providers, prints on one line. Three or more consecutive siblings whose subtrees match exactly, in names, types, and logged errors and warnings, print as one counted line; other siblings, including same-name screens with different contents, keep their own lines. Pass a ref or a unique name to print one branch.
- `find` lists components whose name contains the text, ignoring case, or equals it with `--exact`, each with the components that rendered it.
- `inspect` prints a component's owners, props, state, hooks, and the errors and warnings it logged while rendering. It takes a ref, or a name only one mounted component has.
- `errors` lists the components that logged console errors or warnings while rendering, with the messages. When the app's React DevTools backend does not attribute every log to a component, as on React Native 0.74 and 0.76, it says the list can be incomplete.
- These commands connect the same way as profiling, below. A connected React DevTools window owns the component tree, so `tree`, `find`, and `errors` fail with `tree-unavailable` until it is closed and the app reloads.

## React Native performance profiling

```bash
agent-device react-devtools profile start
agent-device react-devtools profile stop
agent-device react-devtools profile stop --limit 10
agent-device react-devtools profile report
agent-device react-devtools profile report <Component>
agent-device react-devtools profile commit
agent-device react-devtools profile commit <N>
```

- `profile start` begins recording React renders in the app; `profile stop` ends it and prints the commit count, render time, commits over the 16 ms frame budget, and up to five findings (`--limit` changes that). It also saves the recording for the session, so `report` and `commit` read it without the app.
- `profile report` lists components by self time with why they rendered; `profile report <Component>` shows every component of that name, such as `Row` and memoized `Row`, each with its causes, changed props, owners, costliest commits, and findings. `profile commit` lists commits in order, or the slowest ones in order when there are more than `--limit` (default 20); `profile commit <N>` shows what rendered in one commit. `--limit` caps the rows of the list views.
- Profiling connects through the app's Metro dev server and needs no app or Metro setup. It works with development builds of React Native 0.74 and later on Android emulators, iOS simulators, `agent-device proxy` connections, and remote bridge sessions. On a remote bridge it uses the Metro server next to the agent: the session's binding from `metro prepare`, or `--metro-host`/`--metro-port`. Metro accepts the debugger connection only from its own machine, so the bridge or `metroPublicBaseUrl` cannot carry it.
- `--app <bundle-id>` picks the app when several share the dev server, and `--metro-device <name>` picks the device when one app runs on several. `--metro-port` and `--metro-host`, or `--bundle-url` for a dev server behind a URL path, pick the dev server when it is neither the session's Metro server nor `localhost:8081`.
- With `--json`, `profile stop` returns the findings and the path of the saved profile.
- See [Debugging & Profiling](/docs/debugging-profiling#react-native-performance-profiling) for the findings and the workflow.

## React Native overlays

```bash
agent-device react-native dismiss-overlay
agent-device react-native dismiss-overlay --platform android
```

- `react-native dismiss-overlay` clears a development overlay (redbox/LogBox error or collapsed warning banner) that blocks interaction, and is a no-op when none is present. It works on iOS simulators/devices and Android emulators/devices, and is the only `react-native` subcommand.

## Multiple React Native worktrees

You can reuse one installed iOS simulator debug build across local worktrees when its native binary is compatible with both JavaScript trees. Run one Metro server per worktree on its own port, then open the app on different simulators with explicit Metro hints:

```bash
# Worktree A terminal
yarn expo start --dev-client --port 8081 --host localhost

# Worktree B terminal
yarn expo start --dev-client --port 8082 --host localhost

agent-device open "React Navigation Example" --platform ios --device "iPhone 17" --session rn-a --metro-host 127.0.0.1 --metro-port 8081 --relaunch
agent-device open "React Navigation Example" --platform ios --device "iPhone 17 Pro" --session rn-b --metro-host 127.0.0.1 --metro-port 8082 --relaunch
```

- Use a different simulator and session per worktree; one simulator cannot run two copies of the same bundle id.
- On iOS simulators, `open` writes React Native's per-simulator debug server settings before launch. Expo dev clients ignore those settings, so when the app registers a single `exp+<slug>` URL scheme, `open` launches `exp+<slug>://expo-development-client/?url=<server>` instead; if the scheme check is inconclusive, the app opens normally. `--launch-url` overrides this. A dev build that boots straight into its embedded bundle still needs a native rebuild.
- Each session remembers its dev server for a flagless `metro reload --session <name>`; see [Metro reload](#metro-reload).
- This covers JavaScript and Metro-resolved changes. Rebuild and reinstall when native code, native dependencies, bundle identifiers, entitlements, or generated native project files change.
- Close every session when done:

```bash
agent-device close --platform ios --session rn-a
agent-device close --platform ios --session rn-b
```

## Metro reload

```bash
agent-device metro reload
agent-device metro reload --metro-host localhost --metro-port 8081
agent-device metro reload --bundle-url "http://localhost:8081/index.bundle?platform=ios"
```

- `metro reload` asks connected React Native dev builds to reload JavaScript without restarting the native process, like pressing `r` in the Metro terminal.
- The target server comes from per-call flags first, then the dev server the session last bound through `metro prepare` or `open`'s `--metro-host`/`--metro-port`/`--bundle-url`, then `http://localhost:8081/reload`. A host or port flag overrides only that field. A reused session name never reloads a previous project's server: `close` clears the binding, and so does a fresh `open` without Metro hints. After `metro prepare`, reload uses the local server address even when the device loads through a public or proxy URL.
- A bundle URL keeps its mount prefix: `http://host/tenant-42/.expo/.virtual-metro-entry.bundle` reloads `http://host/tenant-42/reload`.
- When the server has no HTTP `/reload` route (Expo), the reload is broadcast over the server's `/message` websocket. The result's `transport` field says which channel delivered it.
- Use `open <app> --relaunch` instead when the app is not connected to Metro, reload fails, or the native process must restart. See `agent-device help metro` for the full binding rules.

## Media and logs

```bash
agent-device screenshot                 # Auto filename
agent-device screenshot page.png        # Explicit screenshot path
agent-device screenshot page.png --scale 0.3  # Resize both dimensions to 30% for agent context
agent-device screenshot page.png --overlay-refs  # Draw current @eN refs and target rectangles onto the PNG
agent-device screenshot page.png --crop-on 'label="Save"'  # Crop the capture to the frame the selector resolves on the same screen
agent-device screenshot baseline.png --normalize-status-bar  # Normalize iOS simulator chrome for reusable diff baselines
agent-device screenshot page.png --platform web --fullscreen  # On web, --fullscreen/--full/-f captures the entire document
agent-device viewport 1280 900 --platform web                # Resize the active web viewport for fixed-layout or 100vh apps
agent-device screenshot textedit.png    # App-session window capture on macOS
agent-device screenshot --fullscreen    # Force full-screen capture on macOS app sessions
agent-device open --platform macos --surface desktop && agent-device screenshot desktop.png
agent-device diff screenshot --baseline baseline.png --out diff.png
agent-device diff screenshot --baseline baseline.png current.png --out diff.png
agent-device diff screenshot --baseline baseline.jpg --out diff.png   # JPEG inputs are accepted too
agent-device diff screenshot --baseline baseline.png --out diff.png --overlay-refs
agent-device record start               # Start app-scoped recording after open <app>
agent-device record start session.mp4   # Start app-scoped recording to explicit path
agent-device record start session.mp4 --scope device  # Intentionally record the full simulator/device screen
agent-device record start session.mp4 --fps 15  # Runner capture rate and touch-overlay frame cap
agent-device record start session.mp4 --quality high # Higher-quality export (slower)
agent-device record stop                # Stop active recording
```

**Screenshots**

- `--scale <factor>` resizes both dimensions, from `0.01` to `1` (full resolution). Set `AGENT_DEVICE_SCREENSHOT_SCALE=0.3` or `screenshotScale` in config as a token-conscious default; an explicit `--scale` overrides it. Leave it unset or pass `--scale 1` for pixel-diff baselines. `--max-size` is refused everywhere (CLI, `.ad` scripts, Node options, config, `AGENT_DEVICE_SCREENSHOT_MAX_SIZE`) with guidance to use `--scale`.
- `--overlay-refs` takes a fresh snapshot and burns visible `@eN` refs and their rectangles into the PNG. With `--scale`, refs are drawn at the final size, so avoid scales where labels become unreadable. In `--json` mode each ref also has a screenshot-space `center` for `press <x> <y>` fallback.
- `--crop-on <selector>` crops the capture to the frame the selector resolves on the same screen. It works only on iOS simulators and Android emulators, needs exactly one framed node, cannot be combined with `--overlay-refs` or `--fullscreen`, and warns when the frame is clipped. The crop is re-encoded, so do not byte-compare it with an older crop.
- `--fullscreen` on macOS applies only to app sessions. Other surfaces (`desktop`, `menubar`, `frontmost-app`) always capture the main display and refuse `--fullscreen` with `INVALID_ARGS`.
- `--normalize-status-bar` temporarily normalizes iOS simulator status-bar chrome for reusable baselines.
- On single-display iOS simulators and Android devices, the result may report `displayRotation` (`portrait`, `portrait-upside-down`, `landscape-left`, or `landscape-right`). It is absent when the device returns no reading in time, on other targets, and on multi-display devices such as foldables. The saved image is always upright.

**Screenshot diffs**

- `diff screenshot` compares a live capture, or a saved `current.png` (no session needed), against `--baseline`. Inputs may be PNG or JPEG regardless of extension; HarmonyOS captures are JPEG. Output ranks changed regions with rectangles, changed-pixel counts, and share of the diff; `--out` writes a diff PNG with changed pixels tinted red. `ocr` and `nonTextDeltas` are never populated, so read the images yourself for qualitative review.
- `--threshold <0-1>` sets the per-pixel RGB tolerance (default `0.1`). Image dimensions must match. Keep it above `0` when either input is JPEG.
- `--overlay-refs` also writes a separate current-screen ref overlay and lists refs under changed regions. It needs a live capture, so it is unavailable with a saved `current.png`.
- Live iOS simulator diffs normalize status-bar chrome by default.

**Recordings**

- `record start` defaults to app scope and needs a session from `open <app>`. Use `--scope device` or `--scope system` for whole-screen capture (multiple apps, settings, home screen) where the backend supports it.
- iOS recording works on simulators and CoreDevice-backed physical devices. Physical devices capture runner screenshots, not a native video stream: no audio, dropped frames are expected, and the default is 15 FPS. `--fps <n>` (1-120) caps the rate; a busy app or long command yields fewer frames.
- `--quality medium|high` (default `medium`) sets export quality on Android and Limrun; Apple export always keeps the captured resolution. Numeric `5`-`7` map to `medium` and `8`-`10` to `high`.
- With touch visualization on, recordings also produce a gesture telemetry sidecar. Burned-in touch overlays export only on macOS hosts; elsewhere `record stop` returns the raw video and telemetry with `overlayWarning`. The overlay renders at most 30 FPS (or `--fps` if lower) within a fixed budget, which also covers the video checks that run before and after it; an export past the budget returns the raw video with `overlayWarning`. On a host that has not run a recording before, part of that budget goes to one-time tool setup, so the first `record stop` of a long recording is more likely to return the raw video.
- Android uses `adb shell screenrecord` (180s limit per clip). Longer recordings are split into MP4 chunks while the daemon stays alive; after a daemon restart, `record stop` recovers only chunks listed in the device manifest. A clip can end before `record stop` when the screen stopped changing; `durationMs` is wall-clock time, and `capturedDurationMs` plus a warning report how much the video covers.
- Limrun sessions always record the whole screen and refuse `--fps` and `--hide-touches` with `INVALID_ARGS`. A failed download is retried by the next `record stop`; nothing survives a daemon restart.
- A busy iOS simulator recording slot returns non-retriable `DEVICE_IN_USE` with `details.reason: apple_simulator_recording_busy`. Run `record stop` in the session that owns the recording; if no recording is active, ask the host operator to restart the CoreSimulator stream service.
- `record stop` is safe to repeat. If the request window ends during export, a second `record stop` in the same session returns the finished recording. A recording whose video file is gone reports `no active recording`.
- `record stop` may also report `recorder` (`confirmed` or `lost`) and `nativePathDisposition` (`retirable` or `retired`). See `agent-device help record` and [ADR 0024](https://github.com/callstack/agent-device/blob/main/docs/adr/0024-screen-recording-provable-signal.md).
- `record contact-sheet <video.mp4> [--out <sheet.png>]` turns an exported MP4 into one PNG grid of the frames where the screen visibly changed, each labeled with its elapsed time. It needs no session or device. The default output is `<recording>.contact-sheet.png`, and `--out` cannot point at the recording itself. `--json` adds per-cell times and change shares plus `sampledFrameCount`, `decodedFrameCount`, and `skippedSampleCount`.
- A contact sheet samples at most 48 times across the clip (every 250ms for short clips) and prints at most 24 cells, so a transient between samples can be missing; `warning` says when cells were thinned or samples skipped. It runs only on macOS hosts (`details.reason: contact_sheet_unsupported_host` elsewhere) and refuses WebM with `contact_sheet_container_unsupported`.

**Session app logs:** See [Debugging & Profiling](/docs/debugging-profiling#logs) for the clean-repro and grep workflow.

```bash
agent-device logs path                  # Print session log file path (e.g. ~/.agent-device/sessions/default/app.log)
agent-device logs start                 # Start streaming app stdout/stderr to that file (requires open first)
agent-device logs stop                  # Stop streaming
agent-device logs clear                 # Truncate app.log + remove rotated app.log.N files (requires stopped stream)
agent-device logs clear --restart       # Stop stream, clear log files, and start streaming again
agent-device logs doctor                # Show logs backend/tool checks and readiness hints
agent-device logs mark "before submit"  # Insert timeline marker into app.log
agent-device events                     # Print recent session request/action events
agent-device events 50 100              # Page 50 events starting at cursor 100
agent-device network dump 25            # Parse recent HTTP(s) requests (method/url/status)
agent-device network dump 25 --include all # Include parsed headers/body when available (truncated)
agent-device network dump 25 --include headers --platform web # Browser requests via managed agent-browser
```

- `logs` works on iOS simulators, iOS physical devices, Android, and macOS (app-scoped Unified Logging). On iOS, capture relies on Unified Logging (`os_log`); plain stdout/stderr may be limited.
- `logs start` appends to `app.log` and rotates at 5 MB. Override with `AGENT_DEVICE_APP_LOG_MAX_BYTES` and `AGENT_DEVICE_APP_LOG_MAX_FILES`; set `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` to a comma-separated regex list for write-time redaction.
- `open` prints `Session state: <path>`; see [Sessions](/docs/sessions#find-a-sessions-logs-and-artifacts) for the files it contains.
- `events` reads the session timeline, which leaves out user-entered content; `--no-record` suppresses `action.recorded` entries. `events.ndjson` rotates at 5 MB (`AGENT_DEVICE_EVENT_LOG_MAX_BYTES`) and keeps one generation. Cursors stay valid across rotation; a cursor older than the retained window fails with `details.reason: "EVENT_LOG_CURSOR_EXPIRED"` and `details.earliestCursor`. If the retained files were edited or deleted, `events` fails with `details.reason: "EVENT_LOG_WINDOW_UNVERIFIED"`.
- `network dump [limit] [summary|headers|body|all]` parses recent HTTP(s) entries from `app.log`, or from managed `agent-browser` request history on web; `network log` is an alias. Prefer `--include` over the positional detail level. It scans up to 4000 log lines, returns up to 200 entries, and truncates fields at 2048 characters. Web does not expose bodies.
- On iOS, `network dump` can miss requests the app does not log and cannot name every request on a reused connection, so treat a missing endpoint as unproven. See [Network inspection](/docs/debugging-profiling#network-inspection) for per-platform behavior.

**Crash symbols:** `debug symbols` symbolicates an Apple crash artifact against local dSYMs, writes the symbolicated artifact to `--out`, and prints a compact crash report. See [Crash symbolication](/docs/debugging-profiling#crash-symbolication).

```bash
agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
```

## Tracing

```bash
agent-device trace start
agent-device trace start session.trace
agent-device trace stop
agent-device trace stop session.trace
```

- `trace start [path]` begins trace-log capture for the active session; `trace stop [path]` stops it and writes or finalizes the artifact at that path.
- Use `trace` for lower-level session diagnostics than `record` or `logs` provide.

## Remote Metro workflow

When the cloud control plane owns the connection profile, `connect` discovers it:

```bash
agent-device connect
agent-device open com.example.myapp --relaunch
agent-device snapshot -i
agent-device disconnect
```

For local profile files, create an `agent-device.remote.json`:

```json
{
  "daemonBaseUrl": "https://bridge.example.com/agent-device",
  "daemonTransport": "http",
  "tenant": "acme",
  "runId": "run-123",
  "session": "adc-ios",
  "sessionIsolation": "tenant",
  "platform": "ios",
  "leaseBackend": "ios-instance",
  "metroProjectRoot": ".",
  "metroProxyBaseUrl": "https://bridge.example.com"
}
```

```bash
agent-device connect --remote-config ./agent-device.remote.json
agent-device open com.example.myapp --relaunch
agent-device snapshot -i
agent-device disconnect
```

For self-contained scripts, pass the same profile to each step:

```bash
agent-device install-from-source https://example.com/builds/Demo.app.zip --remote-config ./agent-device.remote.json --platform ios
agent-device open com.example.myapp --remote-config ./agent-device.remote.json --relaunch
agent-device snapshot --remote-config ./agent-device.remote.json -i
agent-device disconnect --remote-config ./agent-device.remote.json
```

- `connect` fetches the cloud connection profile; `connect --remote-config <path>` uses a local profile with the host, tenant/run, and optional session, platform, lease backend, and Metro settings. Both save connection state and defer the device lease and Metro preparation until a command needs them (including a `batch` step that opens an app). Direct-provider profiles need their provider credentials when `connect` runs. Cloud profiles must be a JSON object at `connection.remoteConfigProfile`; the older `connection.remoteConfig` string is rejected.
- Cloud auth: `connect` refreshes a stored CLI session into a short-lived `adc_agent_...` token. Without a session, interactive shells start login; CI and non-interactive shells fail with API-token setup instructions. `--no-login` disables implicit login. Use `adc_live_...` service tokens for CI. Manage the CLI session with `agent-device auth status`, `auth login`, and `auth logout`; login never stores an `adc_live_...` token.
- `AGENT_DEVICE_CLOUD_BASE_URL` is the bridge/control-plane API origin, not necessarily the dashboard; its `/api-keys` route may redirect to the dashboard.
- `connect` without `--session` always creates a fresh remote session and prints the generated `--session`. Concurrent processes must pass that value on every command; the active-connection fallback is only for one sequential workflow. To replace a connection, pass `--session <name> --force`; `--force` without a session adds a connection without releasing the previous one.
- After `connect`, normal commands (`install-from-source`, `open`, `snapshot`, `press`, `screenshot`, and others) reuse the connection state. `connection status` shows `leaseId=pending` until the first platform-bound command allocates the lease. Explicit flags override connected defaults; `open` with explicit remote flags but no saved runtime hints warns that React Native apps may launch without Metro hints.
- End with `disconnect` (or `disconnect --remote-config <path>`) to release the lease and stop the Metro companion owned by the connection. It does not stop your Metro server.
- `metroProxyBaseUrl` is the bridge origin; do not add `/api/metro/...` paths. The bridge supplies iOS wildcard HTTPS hints and Android runtime routes. `metroPublicBaseUrl` is only needed for direct, non-bridge bundle hints. `metro prepare --remote-config ...` is an inspection/debug path that can write `--runtime-file <path>`.

## Session inspection

```bash
agent-device session list
agent-device session list --json
```

- `session list` shows active daemon sessions for your workspace, or for the named session scope when `--session` or `AGENT_DEVICE_SESSION` is set. Add `--json` for raw session metadata.

## Cloud provider artifacts

```bash
agent-device artifacts --provider browserstack --provider-session <webdriver-session-id> --json
agent-device artifacts --provider aws-device-farm --provider-session <remote-access-session-arn> --json
```

- `artifacts` lists the provider-hosted artifacts your provider returns, such as videos, logs, and dashboard links, as `cloudArtifacts` (what each provider returns: [Device Clouds](/docs/device-clouds#compare-providers)), separate from the local `artifacts` that screenshot, record, install, and replay return. Plain text prints ready URLs.
- Looking up a past session needs `--provider-session <id>` and `--provider <name>`. For credentials, see [Device Clouds](/docs/device-clouds#compare-providers). AWS Device Farm infers the region from the session ARN when possible. When an embedding host registers the cloud runtime in-process, `artifacts` infers the active provider session before disconnect.
- `disconnect --json` and `close --json` include provider release data when the runtime returns final artifacts. Providers may finalize URLs only after the session stops, so retry `artifacts` if the first response is `pending`.

## iOS physical-device prerequisites

For CLI-discoverable setup guidance, run `agent-device help physical-device`.

- Older devices discovered only through `xctrace` use the XCTest backend automatically; its runner commands travel through macOS `usbmuxd`, so keep the device connected by cable.
- XCTest-backed devices support open/close, interactions, snapshots, and screenshots. App inventory, install/reinstall, logs, performance sampling, recording, deep links, and launch arguments require CoreDevice.
- For Xcode, pairing, Developer Mode, and Apple runner signing, see [Installation](/docs/installation#ios-physical-device-prerequisites).

## iOS SpringBoard, widgets, and system-UI surfaces

For CLI-discoverable workflow guidance, run `agent-device help ios-system-ui`.

- `agent-device open com.apple.springboard --platform ios` binds the session to SpringBoard. This is verified on iOS simulators only; physical iPhones are unverified (see [#1296](https://github.com/callstack/agent-device/issues/1296)).
- The full widget add/edit/remove flow is selector-driven from a fresh `snapshot -i`, except two coordinate-based steps: the empty-space long-press that enters edit mode, and the widget-gallery search-result rows, which return unlabeled accessibility nodes.
- SpringBoard labels vary by iOS version and locale; discover them from the current snapshot rather than hard-coding strings like `Edit` or `Add Widget`.
- Reopen the app bundle under test to return to normal app automation after a SpringBoard step.
