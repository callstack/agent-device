---
title: Commands
---

# Commands

Find the command for a task, the flags it takes, and how it behaves on each platform.

For persistent defaults and project-scoped CLI settings, see [Configuration](/docs/configuration).

For agent workflow guidance that matches your installed CLI version, run:

```bash
agent-device help
agent-device help commands
agent-device help workflow
agent-device help manual-qa
agent-device help dogfood
agent-device help validate
agent-device help debugging
agent-device help scripting
agent-device help gestures
agent-device help react-native
agent-device help react-devtools
agent-device help cdp
agent-device help tv
agent-device help web
agent-device help macos
agent-device help remote
agent-device help physical-device
agent-device help ios-system-ui
agent-device help maestro
agent-device help foldable
```

If your agent runtime supports skills, install them to route agents automatically; they are optional. The CLI help topics are the reference for your installed version.

For MCP-aware clients that support direct tools, run:

```bash
agent-device mcp
```

For MCP client setup and what MCP does not expose, see [AI Agent Setup](/docs/agent-setup#mcp-server).

## Output and warnings

In text mode the CLI prints every response warning as a `Warning:` line after the command's own
output, for every command. Four commands declare their stdout to be the value a caller pipes (`get`,
`find`, `clipboard`, `record`) and print those lines on **stderr** instead, so
`value=$(agent-device get text …)` still captures exactly the value. `--json` keeps them in
`data.warnings` and writes neither line.

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
```

- `boot` ensures the selected target is ready without launching an app.
- `boot` requires either an active session or an explicit device selector.
- `shutdown` turns off the selected Apple simulator or Android emulator.
- `shutdown` must not target an active session device; use `close --shutdown` to end the session and turn it off.
- `daemon stop --state-dir <path>` verifies the daemon PID/start-time identity, requests graceful shutdown, and reports whether provider-release state is known. Use `daemon stop --clean` to also remove retained Apple runner processes and leases owned by that daemon.
- `device status` reads host-local device claims without starting or contacting a daemon. Normal output shows live and attention-needed claims, then summarizes proven-stale records in one line; use `device status --stale` to inspect the hidden records. Scope either view with `--platform` plus `--udid` (Apple) or `--serial` (Android). A foreign live or uncertain claim blocks `open`, and a proven-dead owner is replaced only after its session's exact-owner durable resources reconcile successfully.
- `device release --stale` settles a provably dead owner's durable resources through the same exact-owner reconciliation `open` uses and clears its claim last, all without a daemon. Live, uncertain, PID-reused, and corrupt claims always fail closed and are reported with the reason; a live owner is released by closing its session from its own workspace or with `daemon stop --state-dir <owner state dir>`. One claim condition is settled on the device instead: a device that rebooted after its claim was taken destroyed the app, runner, and accessibility session that claim described, so `open` reconciles that owner's resources, takes the claim, and reports the release in `warnings`. `device release --stale` never probes a device for its boot, so it keeps refusing such a claim.
- `--platform apple` is an alias for the Apple automation backend (`ios`, `tvOS`, `macOS` selection).
- Use `--target mobile|tv|desktop` with `--platform` (required) to select phone/tablet vs TV-class vs desktop-class targets.
- You need `boot` mainly when you start a new session and `open` fails because no simulator or emulator is booted.
- `--timeout <ms>` on `boot`, `open <app>`, and `prepare ios-runner` is a startup budget for the iOS Simulator or Android emulator boot (for `prepare ios-runner`, one budget shared with runner preparation). A never-booted iOS Simulator runs Apple's first-boot migration, which can take several minutes; without the flag the command's 90-second request envelope ends the boot first, before the wait's own 120-second cap ever applies. When the budget runs out the command fails with `error.details.reason: boot_timeout` and the Simulator or emulator keeps booting, so a retry finds it further along. See [Sessions](/docs/sessions#wait-for-a-slow-or-busy-device).
- Android: `boot --platform android --device <avd-name>` launches that emulator in GUI mode when needed.
- Android: add `--headless` to launch without opening a GUI window.
- Android: `shutdown --platform android --device <avd-name>` stops a running emulator.
- `open [app|url] [url]` boots and activates the selected target when needed.
- `open <app> --wait <ms>` waits up to that budget for a device another session is holding instead of failing at once, then fails with `DEVICE_IN_USE` if the budget runs out. Only session contention is waited for: a device claim held by another workspace's daemon is never retriable and returns its recovery command immediately. The wait extends the command's timeout envelope, so a long budget does not need a longer `--timeout`. See [Sessions](/docs/sessions#wait-for-a-slow-or-busy-device) for queuing behavior.
- `open <url>` deep links are supported on Android and iOS.
- On an iOS Simulator, handing the URL to the device is one bounded `simctl openurl`: when CoreSimulator never answers it, the open fails within 20 seconds with `details.reason: ios-simulator-openurl-timeout` and kills the child, instead of the request being cancelled around a still-running `openurl`. The Simulator may still have received the URL, so retry the open or answer the prompt with `alert accept`.
- `open <app> <url>` opens a deep link on iOS.
- On an iOS Simulator, iOS can ask `Open in "<App>"?` before your app receives the URL from `open <app> --launch-url <url>`. If the URL's scheme belongs to your session app, `open` taps **Open** for you and its JSON data includes `launchConfirmation: "accepted"`. If no prompt appears, the response has no `launchConfirmation` field.
- `open` recognizes the prompt by its English title and the **Cancel** and **Open** buttons. On a Simulator set to another language, it leaves the prompt on screen and returns as if no prompt appeared; answer it with `alert accept` or `alert dismiss`. Run with `--debug` to see the title `open` did not recognize.
- `open` reads the prompt whenever it cannot see your app after the launch, including on a slow host where the app's target discovery fails on its own deadline. A prompt that appears after `open` has already seen your app stays on screen; answer it with `alert accept` or `alert dismiss`.
- When `open` taps **Open** and your app still provably never starts, it hands the same URL to the Simulator once more and reads the prompt again. If the app is still not running after that, `open` fails with `details.reason: launch_confirmation_unanswered` instead of reporting success for a launch that never happened; later commands that require a running app would have failed with `app is not running`.
- If the recognized prompt remains visible after an attempt to tap **Open** fails, `open` also fails with `details.reason: launch_confirmation_unanswered`, even if the app is running behind the prompt. Answer it with `alert accept` or `alert dismiss` before continuing.
- If the URL's scheme belongs to a different installed app, `open` does not answer the prompt. The command fails with `details.reason: launch_confirmation_foreign_app`; `details.foreignAppBundleId` names that app. The prompt stays on screen: close it with `alert dismiss`, then pass a launch URL whose scheme your app handles.
- If `open` cannot identify a single installed app that owns the scheme, it does not know which app would receive the URL, so it leaves the prompt on screen and returns as if no prompt appeared; answer it with `alert accept` or `alert dismiss`. This happens when no installed app declares the scheme, when more than one does (for example a debug and a release build), and when the app list or an app's `Info.plist` could not be read.
- `open <app> --launch-console <path>` captures launch-time stdout/stderr for direct iOS simulator app launches. It is not valid for URL opens or
  non-simulator targets.
- `open --platform macos --surface app|frontmost-app|desktop|menubar` selects the macOS session surface explicitly. `app` is the default when an app argument is provided.
- A surface given to `open`, as a flag or from a config file, is saved in `--save-script` scripts, so `replay` reopens the same surface. When no surface is given, the script has no `--surface`, and replay opens an app session.
- `back` defaults to app-owned back navigation. On Apple targets that means visible in-app back UI only. On Android it sends the back keyevent, because Android routes in-app back through that platform event.
- `back --in-app` names the default app-owned behavior explicitly.
- `back --system` asks for system back input explicitly. On Android this is the normal back keyevent. On iOS and tvOS it uses the platform back gesture or Siri Remote menu action. On macOS, where there is no generic system back input, `back --system` reports unavailable instead of falling back to app-owned navigation.
- `orientation <orientation>` forces a mobile device into `portrait`, `portrait-upside-down`, `landscape-left`, or `landscape-right`.
- `orientation` is supported on iOS and Android mobile targets. macOS and tvOS do not expose it.
- `action-button` presses the iPhone Action Button once through the Apple runner. It takes no arguments and no `--duration-ms`: XCUITest exposes the press without a hold duration, so a long press is not expressible. The slide surface on the same edge belongs to Camera Control, which `action-button` does not drive.
- `action-button` is an iPhone and iPad command. Android, web, Linux, HarmonyOS, and Vega refuse it, and so do tvOS, macOS, and visionOS leaves.
- `action-button` asks the device whether it has the button before pressing it. A target whose model has none — an iPhone SE beside an iPhone 15, or most iPad simulators — fails with `UNSUPPORTED_OPERATION` rather than reporting a press that never happened.
- `action-button` does not activate or relaunch the session's app, and it takes no `--settle`: pressing a hardware button is not a navigation, so the app stays where it was.
- `action-button` reports that the press was dispatched, not what the system did with it. Simulators run no Shortcuts and no App Intents, so you can verify what a press triggers only on a physical iPhone; on a Simulator the command proves the press was accepted and that the session app was not brought forward.
- `action-button` is slow to loop. On an iPhone 17 Pro Simulator the press itself spent about five seconds inside XCUITest, while `home` and `app-switcher` on the same session took under two seconds each.
- `fold <closed|half-open|open>` puts a foldable iPhone simulator (iPhone Duo) into a hinge pose. The command sends a hinge event inside the selected simulator, then reads the hinge angle back with `devicectl device motion hinge-angle` and reports the pose only when that reading agrees: `closed` is 0°, `open` is 180°, and `half-open` is any angle between them (requested at 130°). An angle inside that interval only proves the category, so `half-open` is reported once two consecutive readings both fall inside it and agree within 0.5°. The response names the panel the device now lights and its native panel point size, marked `coordinateSpace: "native-panel"`; that size is the panel's own geometry, not the next snapshot's viewport (a 669x951 inner panel can host a 951x669 app window), so it cannot place a tap. Re-snapshot afterwards, and never carry refs or coordinates across a `fold`. After that snapshot, taps, long presses, and scrolling follow the app window on the active panel in closed, half-open, and open poses.
- For timed motion, use `fold --keyframes '[{"atMs":0,"angle":0},{"atMs":1667,"angle":160},{"atMs":3333,"angle":100},{"atMs":5000,"angle":180}]'`. This runs the opening/reversal/reopening sequence over five seconds. Supply either a preset or keyframes, never both. Use 2–64 keyframes starting at 0ms with strictly increasing integer timestamps up to 60,000ms and finite angles in 0–180°. Linear interpolation runs at roughly 60Hz; equal consecutive angles hold the hinge. Motion duration excludes preparation and final-angle verification. Cancellation stops at the current angle; re-snapshot even after an interrupted trajectory.
- `fold` is simulator-only and requires an Xcode toolchain with the iOS simulator SDK and foldable HID support (verified on Xcode 27.1). It runs a helper against the session UDID; the helper is built once per `Fold.m` source hash and Xcode toolchain, cached under `~/.agent-device/fold-helper`, and rebuilt only when the source or the toolchain changes. Device Hub and host Accessibility permission are not required. Build failures report `fold-helper-build-failed`; dispatch failures report `fold-hid-dispatch-failed`. There is no UI fallback. Single-panel simulators and physical devices are refused.
- A simulator scoped to a non-default set with `--ios-simulator-device-set` is refused before any hinge is touched with `UNSUPPORTED_OPERATION` and `details.reason: "unsupported-device-scope"`, because `devicectl` cannot read the hinge pose of a simulator outside the default set. Run `fold` against a simulator in the default set.
- `fold` costs one bounded hinge stream per read, and devicectl's smallest stream is five seconds: `closed` and `open` take about ten seconds, `half-open` about sixteen, because the hinge animates and the command waits for it to stop. A hinge whose last reading is some other pose fails with `COMMAND_FAILED` and `reason: fold-pose-unverified`, naming the angle CoreDevice still reports. A hinge seen `half-open` but never at rest fails with `reason: fold-pose-unsettled`, naming the observed and previous angles: the requested category was observed, and what is missing is a pose the hinge holds.
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom scheme URLs require an active app in the session.
- Commands that need one concrete device refuse to guess: if no `--device`/`--udid`/`--serial` is given and several candidates are equally preferred (for example two booted emulators), the command fails with `AMBIGUOUS_MATCH` and lists them, rather than picking one and returning a successful answer about a device you did not select. Preferences still apply first — virtual over physical, booted over offline — so one booted emulator beside offline ones resolves normally, as does any command running inside an existing session. `devices` still lists every device.
- Commands that omit `--session` use an implicit session scoped to the caller's git worktree or working directory and to the selected platform (`ios`, `android`; the platform-less `default` session only without `--platform`), so independent local agents do not attach to each other's sessions. Use `--session <name>` or `AGENT_DEVICE_SESSION` to share a named session, and `--session-lock reject|strip` (or `AGENT_DEVICE_SESSION_LOCK`) to set its lock mode. See [Sessions](/docs/sessions#lock-a-named-session-to-a-device).
- Tenant-scoped daemon runs can pass `--tenant`, `--session-isolation tenant`, `--run-id`, and `--lease-id` to enforce lease admission.
- Remote daemon clients can pass `--daemon-base-url http(s)://host:port[/base-path]` to skip local daemon discovery/startup and call a remote HTTP daemon directly.
- Use `--daemon-auth-token <token>` (or `AGENT_DEVICE_DAEMON_AUTH_TOKEN`) for explicit service/API-token automation against non-loopback remote daemon URLs; the client sends it in both the JSON-RPC request token and HTTP auth headers.
- Use [Remote Proxy](/docs/remote-proxy) when you need to run `agent-device proxy` on a Mac with simulator/device access and drive it from another machine through cloudflared, ngrok, or another HTTP tunnel.
- Use [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), or [TestMu AI](/docs/testmu) when a CI agent needs a hosted device session without interactive login.
- For human cloud access with `connect` or `connect --remote-config`, see [Remote Metro workflow](#remote-metro-workflow).
- Android React Native relaunch flows require an installed package name for `open --relaunch`; install/reinstall the APK first, then relaunch by package. `open <apk|aab> --relaunch` is rejected because runtime hints are written through the installed app sandbox.
- For Metro-backed React Native JS changes, use `metro reload` before `open <app> --relaunch`; it mirrors pressing `r` in the Metro terminal and keeps the native process alive.
- Remote daemon screenshots and recordings are downloaded back to the caller path, so `screenshot page.png` and `record start session.mp4` remain usable when the daemon runs on another host.

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

Use `takeover` with an active remote connection when a person needs to interact with its leased
device without racing the agent:

```bash
agent-device takeover --session remote-session
agent-device takeover status --session remote-session
agent-device takeover release <hold-id> --session remote-session
```

`takeover` holds the leased device in the foreground until you press Ctrl+C. While held,
state-changing commands fail with `DEVICE_IN_USE` and `details.reason: "human_control_active"`;
read-only diagnostics remain available. Takeover requires a device-scoped remote lease; local
sessions without one are not supported. Holds do not survive a daemon restart; reconnect and
re-establish them before continuing human interaction. See
[Remote Proxy](./remote-proxy.md#human-takeover) for hold lifetime, lease behavior, and the host API.

## Web Automation

`--platform web` drives a browser through [agent-browser](https://github.com/vercel-labs/agent-browser). Web automation requires Node 24+. `agent-device` owns command/session/replay integration, refs/selectors, and artifact routing; `agent-browser` owns browser launch, page control, screenshots, and browser-specific mechanics.

Use `--platform web` when a browser step belongs inside an `agent-device` session, replay, batch, MCP, or Node.js client flow. Use `agent-browser` directly for standalone web automation.

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

- `agent-device` installs and manages its own pinned `agent-browser` backend.
- Run `web setup` before first use and in CI bootstrap steps. Normal `--platform web` commands do not install the backend implicitly.
- Runtime web commands resolve the backend only from the managed install in the effective agent-device state dir.
- `web setup` is idempotent and reuses the pinned backend when it is already installed.
- `web doctor` verifies the managed backend after setup.
- The managed install respects `--state-dir` and `AGENT_DEVICE_STATE_DIR`.
- Supported through `agent-device`: URL open, snapshot refs, `get text/attrs`, `is visible/hidden/exists/absent/focused/text`, `find text/selector`, click/press, hover, fill/type, wait, `network dump`, `audio probe`, screenshot, close, and replay scripts composed from those commands.
- `hover <@ref|selector|x y>` moves the pointer without pressing so hover-gated UI (row toolbars, menus) appears. Add `--settle` to read what it revealed instead of taking another snapshot. `hover @ref` hovers the browser's own element handle; like `click @ref --settle`, the `--settle` diff needs a selector or coordinate target on web because web refs carry no geometry.
- `audio probe start [durationSeconds] [bucketMs]` samples HTML media elements into compact RMS/peak dBFS buckets; see [Debugging & Profiling](/docs/debugging-profiling#audio-probes).
- Out of scope for `agent-device` web support: tab/window/devtools control, network routing/interception/HAR, cookies/storage, downloads/uploads, arbitrary page scripting, multi-page orchestration, and raw browser diagnostics. Use `agent-browser` directly for those browser-specific workflows.

## Device isolation scopes

```bash
agent-device devices --platform ios --ios-simulator-device-set /tmp/tenant-a/simulators
agent-device devices --platform android --android-device-allowlist emulator-5554,device-1234
```

- `--ios-simulator-device-set <path>` constrains simulator discovery and simulator command execution via `xcrun simctl --set <path> ...`.
- The Apple runner's `xcodebuild` phases resolve a scoped simulator in the same set through `-DVTSimulatorSetLocation=<path>`; `~/Library/Developer/XCTestDevices` is never redirected. If the selected Xcode no longer resolves the simulator that way, the runner start fails with `details.reason: "simulator_set_destination_not_found"`, and the error names the set, and the selected Xcode version when this daemon has already read it.
- On macOS, daemon startup puts back a `~/Library/Developer/XCTestDevices` that an older agent-device left redirected into a scoped set, before the daemon accepts requests: it removes any symlink at that path, restores `XCTestDevices.agent-device-backup` when it exists, and records each step in `daemon.log`. A symlinked `XCTestDevices` is not supported: daemon startup removes a symlink you made yourself too, for example one that moves `XCTestDevices` to another volume. Only the link is removed, never the directory it points to, and the `daemon.log` entry names that directory. A failed restore is recorded there too and does not stop the daemon or a runner start.
- `--android-device-allowlist <serials>` constrains Android discovery/selection to comma or space separated serials.
- Scope is applied before selectors (`--device`, `--udid`, `--serial`), so out-of-scope selectors fail with `DEVICE_NOT_FOUND`.
- With iOS simulator-set scope enabled, iOS physical devices are not enumerated.
- Device scoping can also be configured with `iosSimulatorDeviceSet` and `androidDeviceAllowlist` config keys. Android allowlists can use `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`.
- CLI scope flags override environment values unless bound-session lock mode is active with `strip`, in which case conflicting per-call selectors are ignored.

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

- `devices` lists available targets after applying any platform selector or isolation scope flags.
- Use `--platform` to narrow discovery to Apple-family (`ios`, `tvOS`, `macOS`), Android, HarmonyOS, or Vega OS targets.
- Use `--ios-simulator-device-set` and `--android-device-allowlist` when you need tenant- or lab-scoped discovery.
- Each listed device carries `model` (hardware model, for example `iPhone 17 Pro` or `Pixel 9`) and `osVersion` (for example `26.1` or `16`) when the platform tooling reports them. iOS simulators read them from `simctl` device types and runtimes, physical iOS devices from `devicectl` (or the OS version printed by `xctrace`), and running Android devices from `ro.product.model` and `ro.build.version.release`; Android emulators report the system image model, such as `sdk_gphone64_arm64`. Stopped AVDs and other platforms omit both fields. They describe a device only and are not selectors.
- `capabilities` reports the command names supported by the selected session device or an explicit `--platform`/`--device`/`--udid`/`--serial` target.
- In JSON output, `capabilities` returns `{ device, availableCommands }`. Use `availableCommands` for dynamic integrations instead of maintaining a separate platform support table.

### HarmonyOS command boundary

HarmonyOS support uses HDC and ArkUI `uitest`. On API 24 devices it supports lifecycle and HAP deployment, ArkUI snapshot/screenshot and selector reads, one-pointer touch and text actions, keyboard `enter`/`dismiss`, app logs, foreground app state, process RSS samples, and `settings clear-app-state`. Run `agent-device capabilities --platform harmonyos` for the authoritative command list for a selected device.

- `gesture pan|fling|swipe` and `swipe` use HDC's single-pointer input primitives. Multi-touch gestures and target-authored `gesture drag` return `UNSUPPORTED_OPERATION` rather than approximating the interaction.
- Physical HarmonyOS devices support whole-screen recording through `record start <path> --scope device` or `--scope system`. This uses the device ScreenRecorder service, not HDC `screenrecord`; emulator recording is rejected. HarmonyOS recording does not support `--fps`, `--quality`, or `--hide-touches`.
- Orientation control, clipboard, alert automation, network/audio capture, push and app-event delivery, React Native helpers, and trace capture are not advertised for HarmonyOS. The public API 24 HDC surface has no usable `pasteboard`, notification, or `aa send` command on the supported emulator and physical device.
- `settings` intentionally supports only `clear-app-state`; other system settings are not changed through undocumented parameter writes. `perf memory sample` provides process RSS; frame health and memory-snapshot artifacts remain unavailable.

## Diagnostics

```bash
agent-device doctor
agent-device doctor --platform ios
agent-device doctor --platform android --app com.example.myapp
agent-device doctor --remote --json
```

- `doctor` diagnoses device, app, Metro, and React Native setup/readiness issues for the selected target.
- Use `--platform ios|android|vega|macos|linux|web|apple` to scope the checks to one backend; without it, `doctor` reports across the discoverable targets.
- `--app <id-or-name>` focuses app-specific checks (install state, Metro/React Native wiring) on a single bundle id or app name.
- `--remote` runs only the environment checks that do not need a booted device; use it in CI bootstrap.
- `doctor` is read-only: it never boots, installs, or mutates the session device.

## Prepare Apple runner

```bash
agent-device prepare ios-runner --platform ios --timeout 240000
```

- Use `prepare ios-runner` in Apple-platform CI setup before `snapshot`, `replay`, or `test`.
- Run it after the simulator/device is booted and the app is installed, but before the first snapshot, replay, or test command.
- `--timeout <ms>` is one budget shared by the Simulator boot and runner preparation; see [Navigation](#navigation).
- It builds or reuses the local Apple runner, starts a runner session, and verifies that the runner can answer a lightweight health command.
- In JSON output, top-level `buildMs`, `connectMs`, and `healthCheckMs` are diagnostic fields and may overlap; use `timing.additiveParts` for additive wall-clock phase totals. `connectMs` contains `buildMs` when a runner artifact is built or rebuilt.
- If health checking exposes a bad restored runner artifact, agent-device marks that artifact bad and rebuilds once.
- If a fresh runner launch gets stuck before accepting connections, agent-device invalidates that runner session and launches it once more without forcing a rebuild.
- CI may cache `~/.agent-device/apple-runner/derived` when the cache key includes the exact agent-device package contents and selected Xcode version.
- After a successful build, agent-device removes the build scratch from the new cache key (intermediates, precompiled and module caches, logs) and keeps `Build/Products` and the metadata file, which is all reuse and launch read; one iOS simulator key measured 165.7 MB before the trim and 5.9 MB after. A key that fails certification is rebuilt from scratch either way, and a runner source or Xcode change mints a new key, so the scratch is never used again. Only the key this build gets with no path override is trimmed, compared by resolved real path; a `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` pointing anywhere else, including inside the managed runner cache, is never trimmed, because a fixed path rebuilds into the same tree incrementally.
- agent-device versions from before the Apple runner rename kept their cache in `~/.agent-device/ios-runner`. Current versions never read it, and it is not removed automatically because an older version installed on the same machine may still use it. Delete it with `rm -rf ~/.agent-device/ios-runner` once no old version runs.
- Runner reuse is authorized only by the cache metadata's content manifest: a restored tree whose files no longer match the recorded digests, modes, or symlink targets is discarded and rebuilt. A cache key must stay exact — the runtime never falls back to a broader cache.
- Every runner source or Xcode change creates a new cache key under `~/.agent-device/apple-runner/derived/<folder>/`, where the folder names the platform and device kind (`ios-simulator`, `ios-device`, `tvos-simulator`, `tvos-device`, `macos`, `visionos-simulator`, `visionos-device`). After a build, agent-device deletes, on a best-effort basis and without delaying the start, keys beside the new one in the same folder that are neither among the 3 most recently used (the new key included) nor used in the last day, and never one a runner lease not proven dead points at or a build is holding. A key that cannot be deleted is left in place and reported as a `runner_xctestrun_cache_eviction_failed` warning diagnostic. `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP=<n>` changes that count and `0` keeps every key. A set `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` is never swept.
- Certification is fail-closed: when a product tree cannot be certified at all — a product escaping the derived-data root, an unreadable subtree, a file over 128 MB, or a non-regular entry such as a socket — the build fails with `runner_cache_uncertifiable` naming the path instead of launching uncertified bytes. Point `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` at a plain directory the current user owns; replacing the tree (the error's hint says how) clears a refusal.
- Runner build/start output is written to the session's `runner.log`. The top-level `daemon.log` is reserved for daemon lifecycle/startup issues.

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

- AndroidTV app launch and app listing resolve TV launchable activities via `LEANBACK_LAUNCHER`.
- TV target selection supports Apple TV and Android TV simulators/emulators and connected devices. Vega OS support is limited to the Vega Virtual Device (VVD).
- TV targets are focus-first. Use `tv-remote` to move D-pad/remote focus before selecting a control; avoid raw `adb shell input keyevent` in command plans.
- On Android TV, `tv-remote` maps to ADB keyevents. `tv-remote longpress <button>` is CLI sugar for a 500ms hold; `--duration-ms` overrides the preset and uses Android's longpress keyevent form for any positive duration because the platform command does not expose exact hold timing.
- tvOS supports the same runner-driven interaction/snapshot flow as iOS (`snapshot`, `wait`, `press`, `fill`, `get`, `scroll`, `back`, `home`, `app-switcher`, `record`, and related selector flows).
- On tvOS, `tv-remote`, runner `back`/`home`/`app-switcher` map to Siri Remote actions (`back` is Menu, `home` is Home, app switcher is double-home). `--duration-ms` is an exact remote-button hold duration.
- Vega OS discovery and remote input use the SDK-matched Vega CLI and VDA. Use `--platform vega --target tv`, and use Vega component IDs such as `com.example.app.main`.
- Use `--serial VirtualDevice` for explicit VVD selection.
- The Vega VVD supports app open/close, `back`, `home`, and all shared `tv-remote` buttons. Exact holds are sent through `inputd-cli`.
- On Vega OS, physical Fire TV, app inventory, snapshot, screenshot, selector, install, touch/text/gesture, logs, and performance are not supported and report unsupported.
- On Android TV and tvOS, use `screenshot --overlay-refs` when visual focus evidence is useful or when focus metadata is unavailable/transient. On Vega OS, use the VVD display as visual truth.
- tvOS follows iOS simulator-only command semantics for helpers like `gesture pinch`, `settings`, and `push`.

## Desktop targets

```bash
agent-device devices --platform macos
agent-device open TextEdit --platform macos
agent-device open --platform macos --surface desktop
agent-device snapshot -i --platform apple --target desktop
```

- `--platform macos` selects the host Mac as a `desktop` target.
- `--platform apple --target desktop` selects the same macOS backend through the Apple-family alias.
- Use `app` sessions for normal app control: `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `back`, `screenshot`, `record`.
- Use `frontmost-app`, `desktop`, and `menubar` when you need to inspect desktop-global UI before choosing one app, mainly with `snapshot`, `get`, `is`, and `wait`.
- `open --platform macos --surface frontmost-app` inspects the focused app without naming it first.
- `open --platform macos --surface desktop` inspects visible windows across the desktop.
- `open --platform macos --surface menubar` inspects the active app menu bar and system menu extras.
- `open <app> --platform macos --surface menubar` targets one menu bar app's extras bar, which is useful for status-item apps.
- Status-item apps often expose little or no useful UI through the default macOS `app` surface. Prefer `--surface menubar` for discovery when the app lives in the top menu bar.
- If you inspect with `desktop` or `menubar` and then need to click or fill inside one app, open that app in a normal `app` session.
- macOS also supports `clipboard read|write`, `trigger-app-event`, `logs`, `network dump`, `audio probe`, `alert`, and a subset of `settings` (see [Settings helpers](#settings-helpers)).
- `audio probe start 10 1000 --platform macos` samples host system audio and needs Screen Recording permission; see [Debugging & Profiling](/docs/debugging-profiling#audio-probes).
- In macOS app sessions, `screenshot` captures the target app window bounds rather than the full desktop.
- Prefer selector or `@ref`-driven interactions on macOS. Window position can shift between runs, so raw x/y point commands are less stable than snapshot-derived targets.
- Use `click --button secondary` for context menus on macOS, then run `snapshot -i` again.
- On `frontmost-app` and `menubar` surfaces, `press` and `click` post synthetic mouse events through the macOS helper (the `desktop` surface inspects only): `--hold-ms` is how long the button stays down (at least 40 ms, 60 ms by default, because AppKit drops a release posted in the same tick as its press), `--count` is that many independent clicks (apps that detect a double-click by timing, such as Finder, still read two clicks at the default interval as one; pass an `--interval-ms` longer than the system double-click time to keep them apart), and `--double-tap` posts each click as a double-click pair. A long schedule such as `--hold-ms 10000 --count 4` is given the time it needs, and a helper stopped mid-hold — by a cancelled request, a dropped client, or its deadline — releases the button before it exits. `--jitter-px` is not applied on these surfaces.
- With `AGENT_DEVICE_MACOS_APP_BACKEND=native`, macOS app sessions run without XCTest: no Automation Mode overlay, the app can stay behind other windows, and the real pointer stays with you while a drawn pointer shows each action. `click`, `press`, and `fill` use accessibility actions on the element at their target point, which must lie inside one of the app's own on-screen windows and not on its menu bar; `type` inserts at the focused control and falls back to key events sent to the app; `scroll` moves the accessibility scroll bar under the front window's center. Chromium-based apps expose their full tree. The daemon then never starts the Apple runner on macOS: `record`, `prepare`, `back`, `longpress` and `--hold-ms`, `--double-tap`, `--button secondary`, and gestures are refused with `UNSUPPORTED_OPERATION` (`reason: unsupported-device-backend`), as is a click on an element with no accessibility action. Use the default XCTest backend for those. `screenshot` captures only the app's front window, even when other windows cover it.
- Mobile-only helpers are unsupported on macOS: `boot`, `shutdown`, `home`, `orientation`, `app-switcher`, `action-button`, `fold`, `install`, `reinstall`, `install-from-source`, and `push`.

Recommended loops:

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
agent-device snapshot [--diff] [-i] [--depth, -d <depth>] [--scope, -s <scope>] [--raw] [--actions] [--force-full] [--timeout <ms>]
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

- `wait` accepts a millisecond duration, `text <value>`, a snapshot ref (`@eN`), a selector, or strict `absent <selector>`.
- `wait <selector> [timeoutMs]` polls until the selector resolves or the timeout expires. Selector waits use snapshot capture, including steps inside `replay`, so they share the capture backend and recovery used by `is`.
- `wait absent <selector> [timeoutMs]` polls until a complete, readable capture has zero matches. It is strict absence, not a visibility check: hidden or off-screen matches still keep the wait pending.
- Strict absence rejects `--scope` and `--depth`. Sparse, truncated, incomplete, and Android unreadable-content captures do not count as readable captures and cannot satisfy the wait; they are ridden out until the deadline, and a run with no valid capture preserves its typed unreadable diagnostic.
- `wait @ref [timeoutMs]` requires an existing session snapshot from a prior `snapshot` command.
- `wait @ref` resolves the ref to its label/text from that stored snapshot, then polls for that text; it does not track the original node identity.
- Because `wait @ref` is text-based after resolution, duplicate labels can match a different element than the original ref target.
- `wait` shares the selector/snapshot resolution flow used by `click`, `fill`, `get`, and `is`.
- Wait failures carry a structured `error.details.reason` in `--json` output: `wait_target_absent` proves a positive wait never found a match; `wait_target_present` means strict `wait absent` reached its deadline with valid captures that still contained matches; `predicate_failed` means strict `wait absent` could not prove absence because no valid capture arrived, with the final observation/diagnostic preserved; `wait_capture_stalled` means no readable capture arrived and is retriable; `wait_deadline_exceeded` means a later capture consumed the remaining budget after an earlier readable capture; `wait_readiness_exhausted` means the deadline ended a poll that was still getting the iOS runner to answer its first command or finding the Simulator app, named by `readinessPhase` (`runner-start` or `target-discovery`), so a retry needs a timeout that covers that work (an iOS runner start keeps going after the deadline on its own finite budget, 10 minutes by default when no startup timeout is set, covering the cold xctestrun build through launch, so the retry joins it instead of paying it again; a start that spends that budget fails with `runner_start_budget_exhausted` and the next command starts over); `wait_landmark_identity_mismatch` is a replay destination-guard refusal; and `wait_stable_timeout` means the UI did not settle. Use `readableCaptures`, `waitedMs`, `matches`, and `firstMatch` instead of parsing error text. `firstMatch` carries identity/text evidence only; absence failures do not claim visibility or rect evidence.
- Polling wait timeouts (`wait <selector>`, `wait text`, `wait @ref`, and `wait absent` once a readable capture has been seen) also carry `captures` (every poll attempted), `readableCaptures`, and `polls`, one entry per poll with `startedMs` on the wait's own clock, `durationMs`, and `outcome` (`readable`, `unreadable`, `retriable` for a poll the producer refused with a failure it marked retriable, `deadline`, `runner-restart`, or `readiness`), so a timeout says where its budget went; long waits keep the first five and last twenty-five polls. A replayed selector wait refused for a recorded landmark mismatch (`wait_landmark_identity_mismatch`) carries the same poll evidence next to its mismatch details. A wait that never saw a readable capture reports the cause its polls hit instead of a generic timeout: a content verdict is preserved as its producer wrote it, while a refusal the producer marked retriable keeps its code, message and retry details **and** carries the poll evidence above, so an exhausted budget stays distinguishable from a single immediate refusal. `wait --stable` timeouts and a never-readable strict absence keep their own diagnostics. `logPath` links the full request log.
- `alert` inspects or handles system alerts on iOS simulator, macOS desktop, and Android native/runtime permission dialogs.
- `alert` without an action is equivalent to `alert get`.
- On iOS, `alert` also covers app-owned modal popups with native blocking markers and blocking system dialogs.
- `accept` and `dismiss` are sent once on every platform. A lost or unconfirmed response is reported as an error and never replayed; run `alert get` before acting again.
- Use `alert get` for an immediate cheap check. Use `alert wait <short-ms>` only when a prompt may appear after async work.
- Do not use `settings permission` to answer a dialog already on screen; reserve it for setup or resetting permission state before a flow.
- Within an iOS XCTest execution, `accept` and `dismiss` activate the selected button once, then only observe until the alert disappears, its presentation changes, or the deadline expires. A shared button label never triggers a second coordinate tap. A changed presentation can be an updated original alert or a replacement; it does not prove a permission was granted. Verify the application outcome separately.
- An unreadable or ambiguous post-action capture fails with `error.details.runnerErrorCode: ALERT_CONFIRMATION_UNAVAILABLE`; an expired runner deadline uses `ALERT_DEADLINE_EXCEEDED` (the outer command watchdog can also report a timeout). Neither proves absence or that no action occurred. Identical-looking alerts remain unconfirmed. Inspect the current alert before deciding whether to act again.
- iOS runner refusals carry `error.details.reason`: `runner_busy` means the runner was still finishing an earlier command and ran nothing (`dispatched: no`); `runner_main_thread_timeout` means the runner gave up waiting on the app, and the action may still land (`dispatched: unknown`).
- Android support is snapshot-derived. If `alert` reports no alert but a sheet is visible, treat it as app-owned UI and use `snapshot -i` plus `press` by visible label/ref.
- If an iOS permission sheet is visible in `snapshot` or `screenshot` but `alert accept` reports no alert, fall back to a scoped `snapshot -i -s "<visible label>"` plus `press @ref`; not every simulator permission surface is exposed as a native XCTest alert.

## Interactions

```bash
agent-device click @e1
agent-device click @e1 --button secondary   # macOS secondary click / context menu
agent-device focus @e2
agent-device fill @e2 "text"          # Clear then type
agent-device fill @e2 "search" --delay-ms 80
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
agent-device gesture pinch 2.0          # zoom in 2x
agent-device gesture pinch 0.5 200 400 # zoom out at coordinates
agent-device gesture rotate 35 200 420 # rotate app content
agent-device gesture transform 200 420 80 -40 2 35 700 # combined pan, zoom, and rotate
```

`fill` clears then types. `type` does not clear.
When an interaction fails, see [Retry after a failed command](#retry-after-a-failed-command) before you retry.
`type` accepts text only. Do not pass `@ref` to `type`; use `fill @ref "text"` to target a field directly, or `press @ref` then `type "text"` to append in the focused field.
If `type` reports `TEXT_INPUT_NOT_FOCUSED`, focus a visible text input and retry; when accessibility does not expose the input, use a coordinate focus command before typing.
On iOS, if `type "\n"` reports `TEXT_INPUT_SYNTHESIS_UNAVAILABLE` after tapping a field while the software keyboard is hidden, show the software keyboard, then retry. The runner reports this error instead of risking input through an unreliable text-entry path.
On iOS, if `fill` reports `TEXT_INPUT_COMMIT_NOT_OBSERVED`, the runner could not confirm the typed text reached the field — either it did not land before the runner's deadline, or the expected final text is identical to the field's placeholder. In the latter case, accessibility cannot distinguish committed text from an empty field rendering that placeholder, even if the field held content before dispatch. The field may hold none, part, or all of the text: run `snapshot -i` and inspect it. If it already matches, continue; otherwise retry with the full text quoted and `fill --delay-ms 80`, which replaces the whole value. Do not use `type`, which appends to whatever committed. This covers the coordinate-driven `fill` route taken when the accessibility channel is under load, which observes the field after synthesizing; it is not a guarantee that every text-entry route verifies its result.
On iOS, if `fill` reports `TEXT_INPUT_CLEAR_NOT_OBSERVED`, the same coordinate-driven route could not see the field's old text removed before typing, so it typed nothing. The field may still hold some or all of its old text: run `snapshot -i` to inspect it, then retry `fill`. Do not use `type`, which appends to whatever the field holds.
On iOS, if `fill` reports `TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED`, the text is longer than that coordinate-driven route can type inside one runner command at its bounded pace, and nothing was typed. Fill at most the character limit the hint names for your `--delay-ms`, and append the rest with separate `type` commands: the hint gives one limit without `--delay-ms` and a lower one for the delay it recommends. `--delay-ms` lowers the budget because each character then gets its own synthesize call and each gap between characters pays that delay; a longer timeout does not help.
Use plain `fill` or `type` first for ordinary login and form fields. Use `--delay-ms` on `type` or `fill` only when a debounced search field or search-as-you-type input actually misses characters, or when the app must receive incremental updates.
Delayed typing intentionally prefers paced character entry over clipboard-style fallbacks so the target field receives each incremental update.
On Android, `fill` also verifies text and treats IME-owned capture as a terminal failure instead of retrying against the wrong field.
When the filled field changed but its value cannot confirm the text, `fill` succeeds with `verification: "unconfirmed"` plus target-bound `requested`/`before`/`after` evidence instead of failing. On Android that is app-owned formatting. On iOS's accessibility-driven `fill` route it is a field whose value moved off its post-clear baseline to one that does not echo the typed text, such as an OTP input announcing `6 of 6 digits`; dropped characters and stale prefixes still fail, and the coordinate-driven route still requires an exact match. Verify the result through the screen, for example the OTP slots or the next screen, instead of retrying the same fill.
Android text entry is owned by `agent-device`: provider-native injection when available, then chunk-safe ASCII shell input. Do not switch to raw `adb`, clipboard, or paste as an agent fallback. If non-ASCII is unsupported in the current backend, report the tool/device gap.
`click --button secondary` is the desktop context-menu flow on macOS.
`click --button middle` returns an unsupported-operation error on macOS.
`swipe` is a quick, fixed-duration directional throw. Use `gesture pan` for deliberate timed movement.
Neither `swipe` nor `gesture fling` takes a duration, and `gesture rotate` takes no velocity — see
[Migrating Gestures](/docs/migrating-gestures) if you have scripts or recordings that still pass one.
Repeated coordinate swipes accept at most 200 repetitions and 10000ms pauses, and their combined
gesture/pause schedule must fit within 60000ms.
`gesture pan` accepts `x y dx dy [durationMs]` for deliberate drags. It uses one pointer by default. Add `--pointer-count 2` for a parallel two-finger pan with constant contact span and angle. Android preserves the requested travel duration.
`gesture drag` accepts `source destination [sourceHoldMs] [moveMs] [destinationHoldMs]`, where each endpoint is a selector or a snapshot ref. It resolves both endpoints before dispatch and keeps one pointer down continuously through activation, movement, and the optional destination hold. Defaults are 800ms, 500ms, and 0ms; the combined gesture is capped at 10000ms. Recordings convert refs to selector chains so saved `.ad` scripts remain portable.
Target-authored drag is supported on Android touch devices and iOS/iPadOS. Backends that cannot preserve all three authored phases reject it before injection.
`gesture fling` accepts `up|down|left|right x y [distance]` for fast directional throws.
`gesture rotate` accepts `degrees [x] [y]`; the degree sign controls direction. Pacing is derived from the requested rotation.
`gesture transform` accepts `x y dx dy scale degrees [durationMs]` for one combined two-finger pan/zoom/rotate gesture on Android and iOS simulators. Pinch, rotate, two-finger pan, and transform use the same viewport-aware pointer planning; impossible paths fail before injection instead of clamping or distorting the requested motion.
On iOS simulators, recognizer output may not match the requested pan, scale, and rotation exactly, so verify app-level metrics.
On Android, `gesture transform` injects a geometric two-finger path. App recognizers may report non-exact pan, scale, and rotation values, so verify qualitative state such as `pan changed yes`, `pinch changed yes`, and `rotate changed yes` unless the app explicitly promises exact centroid metrics. If exact app-state values matter, prefer isolated `gesture pan`, `gesture pinch`, or `gesture rotate` commands.
`scroll` accepts either a relative amount (`0.5` means a finger path spanning half of the viewport on that axis) or `--pixels <n>` for a fixed-distance gesture. Directional scrolls decelerate through the drag on Android to reduce release momentum within the requested duration; `scroll top` and `scroll bottom` retain inertial release for edge traversal. Reduced momentum does not guarantee an exact content offset, especially for very short gestures: apps apply pan-recognition thresholds, collapsing headers, bounds, and their own scroll physics. Large distances are clamped to the usable drag band so the gesture stays reliable across Android, iOS, and macOS.
`--until` is kept in recorded scripts; see [Replay & E2E](/docs/replay-e2e).
A directional scroll places its swipe across the middle of the viewport, so a focused field and its keyboard would put the swipe under the keys: the gesture would land on the keyboard, the surface would not move, and the scroll would read as stuck. On iOS and Android the scroll instead keeps the whole swipe in the band above the keyboard, reporting `keyboardAvoided` and `keyboardMinY` alongside a `referenceHeight` and `pixels` measured against that shorter band. It never dismisses the keyboard, because dismissing drops focus and breaks a `fill`/`scroll`/`fill` loop; run `keyboard dismiss` yourself when you want that. When the keyboard leaves too little room to swipe, the command refuses with the `scroll_keyboard_occludes_surface` reason rather than swiping into the keys, so a scroll that cannot work says so instead of appearing stuck.
A directional scroll also reports what it *saw*, as `movement`, because the reported distance describes the swipe that was dispatched rather than content that moved. `moved` means the content inside the scroller the swipe ran in differs from the tree the session held immediately before the gesture. `at-edge` means it did not change and the resolved container reported no hidden content left in that direction, and `unchanged` is the same measurement in a direction that has no end-of-content signal to read. `unobserved` means the pair could not back a claim in either direction — no stored tree, a stored tree the session no longer stands behind or that was captured differently, a surface that never came to rest, or a difference sitting entirely outside the scroller that was swiped, which a changing Android status bar does — so the distance rests on the gesture plan alone. When the surface is provably unchanged while the container the gesture ran inside still reports hidden content in that direction, the command refuses with the `scroll_no_progress` reason instead of repeating the requested distance: the gesture never reached that list, and the hint names the three ways it usually goes missing (a focused keyboard, a nested scroller, a list that ignores synthesized scrolls and needs a raw `swipe`). A scroll on a runtime that cannot read a screen carries no `movement` field at all, and a Maestro replay or a `--settle` caller is not charged a second observation of a fact its own flags already own.
`scroll <direction> --until <selector>` is how you reach an off-screen target without guessing a distance: it repeats the gesture and re-reads the tree between passes, stopping the moment the selector is on screen rather than sailing past it, and it fails when the content runs out first. The amount is optional beside it (`scroll down 0.8 --until <selector>`) to widen each pass. The same form works inside a `.ad` script, so a flow brings a target on screen in a viewport-independent way instead of a fixed amount that passes on one screen size and fails on another.
Default snapshot text output is visible-first, so off-screen interactive content is summarized instead of shown as tappable refs.
When a target only appears in an off-screen summary, use `scroll <direction> --settle`: the response waits for the UI to go quiet and returns the diff against the tree you last observed, with fresh refs on the added lines, so no follow-up `snapshot -i` is needed. `back --settle` does the same for navigation. Both are best-effort and never fail the action. For repeated checks without settle, a small shell loop is enough:

```bash
previous=''
for _ in 1 2 3 4 5 6; do
  current="$(agent-device snapshot -i)"
  printf '%s\n' "$current"
  printf '%s\n' "$current" | grep -q 'Sign in' && break
  [ "$current" = "$previous" ] && break
  previous="$current"
  agent-device scroll down 0.5 >/dev/null
done
```

`longpress` is supported on iOS and Android.
`hover` is supported on web only. It moves the pointer over a target (`@ref`, selector, or coordinates) without pressing, so hover-gated UI such as row toolbars and menus appears; touch platforms have no hover state and reject it. Use `--settle` to get the diff of what the hover revealed and act on the fresh refs; use `longpress` for the mobile hold-gesture equivalent.
`gesture pinch` is supported on Android and iOS simulator app sessions.
`gesture rotate` is supported on Android and iOS simulator app sessions. Use `orientation` for device orientation.
Two-finger `gesture pan` and `gesture transform` are supported on Android and iOS simulator app sessions. One-finger `gesture pan` keeps the broader platform support of ordinary coordinate drags.

## Retry after a failed command

When a command fails, read `error.details.dispatched` before you retry:

- `no`: the action never reached the device. Retry it as it is.
- `unknown`: the action may have landed. Take a snapshot before you retry; a blind retry can tap, type, or navigate twice.

A read-only command such as `get`, `snapshot`, or `wait` reports `no`: a retry repeats no action the app can see. This includes `record`, `trace`, and `perf`, whose recorder and profiler controls the device refuses to repeat.
On Android, a command that first dismissed a blocking system dialog or an ANR prompt still reports as if that dismissal had not happened: a read stays `no`, and a mutation keeps its own verdict. The dismissal is not counted as a dispatched step.
Once any step of a request reached the device, its failure is `unknown`, and `error.details.dispatchedSteps` counts those steps. A `batch` or a replay reports `no` only when none of its executed steps changed the app.
A failure without `dispatched` gives no such guarantee. Treat it as `unknown`.
These refusals carry a typed reason alongside `dispatched: no`, so a driver can branch instead of matching the message: `error.details.reason: session_or_device_selector_required` means the daemon refused before routing anywhere because the request had neither an active session nor a device selector to resolve, so opening a session or passing `--platform` is the fix; `session_app_required` means a per-app setting was asked for while the request carried no app — the session binds none and none was named for the request — so `open <app>` is the fix, or for a setting that takes an app id (like `settings clear-app-state com.example.app`), name it on the request without opening anything.
On a WebDriver-backed device cloud, a request whose driver does not implement its route fails with `error.details.reason: webdriver_route_unsupported` and `dispatched: no`; the driver answered before it ran anything, so the failure is about the cloud's driver, not the device. A command with a sibling route (`orientation` tries two) consumes that refusal and tries the other; only when every route is refused does the command fail. After an ambiguous failure on that transport, only a request that reads and changes nothing is resent; a request that can change the app is sent once.

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

- `is` evaluates UI predicates against a selector expression and exits non-zero on failure.
- Supported predicates are `visible`, `hidden`, `exists`, `absent`, `editable`, `selected`, `focused`, and `text`.
- `is visible` checks whether the resolved element is present in the current visible snapshot viewport. A node without its own rect still passes when a visible ancestor within the viewport provides the on-screen geometry.
- `is exists` checks only whether the selector matches in the current snapshot.
- `is absent` passes only when the selector has zero matches in one readable, complete, settled, unscoped, full-depth accessibility capture. It does not mean hidden; `--scope` and `--depth` are rejected, and sparse, unreadable, truncated, or unsettled captures fail closed.
- A read that answers from the first capture after a `scroll`, `swipe`, or `gesture swipe` waits for two consecutive captures to agree. That capture, and a re-capture taken at once to recover or widen it, carry `postGestureOutcome` (`{ "kind", "gesture": { "action", "positionals" } }`) when stabilization proved something about the gesture. `is`, `get`, `find`, `wait`, and an interaction that captured it (such as `click`, `press`, or `fill`) report it in `error.details` or `data` and append a warning, and `snapshot` appends the warning.
  - `kind: "unsettled"`: the surface was still changing when the budget ran out. A miss on that capture is not proof of absence: read again. `is absent` refuses it with `observation: "unsettled"`, and `wait absent` keeps polling.
  - `kind: "no-effect"`: the settled tree still matches the tree from before the gesture. The container may be at its edge or may ignore synthesized scrolls; a raw `swipe x1 y1 x2 y2` inside the list moves such lists.
- `wait text` is a text-presence wait, not a hittability assertion.
- `is text <selector> <value>` compares the resolved element text against the expected value.
- `is` does not accept snapshot refs like `@e3`; use a selector expression instead.
- `is` accepts the same selector-oriented snapshot flags as `click`, `fill`, `get`, and `wait`.

## Replay

```bash
agent-device open Settings --platform ios --session e2e --save-script [path]
agent-device replay ./session.ad      # Run deterministic replay from .ad script
agent-device test ./suite             # Run every .ad file in a folder or glob serially
agent-device test ./suite --timeout 60000 --retries 1
agent-device replay ./session.ad --from 4 --plan-digest <sha256>   # Execute step 4; if already completed, use the next safe index with this digest
agent-device replay ./session.ad --keep-session   # Suppress its terminal close and continue interactively
```

- `replay` runs deterministic `.ad` scripts. Script paths are read on the calling machine, so the same command works against a local or remote daemon.
- `replay --keep-session` skips only an authored terminal `close`, so you can keep working in the session.
- `test` runs `.ad` scripts from files, directories, or globs as a serial suite, streaming `pass`/`fail`/`skip` progress on stderr; add `--verbose` to print every final result.
- `test --platform <platform>` filters suite files by their `context platform=...` header instead of overriding the script target.
- `test --timeout <ms>` and `test --retries <n>` apply per script attempt (retries are capped at `3`).
- `test --artifacts-dir <path>` overrides the default suite artifact root at `.agent-device/test-artifacts`.
- A failing step returns a `REPLAY_DIVERGENCE` report; `replay --from <n> --plan-digest <sha256>` resumes at plan step `n` (`test` rejects `--from`). See [Resume a failed replay](/docs/replay-e2e#resume-a-failed-replay).
- `replay -u`/`--update` is retired and accepted as a no-op; it does not rewrite the script.
- `--save-script [path]` on `open` records a replay script when the session closes.

See [Replay & E2E](/docs/replay-e2e) for recording, Maestro compatibility, and CI workflow details.

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

- `install <app> <path>` installs from binary path without uninstalling first.
- Supports Android devices/emulators, iOS simulators, and CoreDevice-backed iOS physical devices. On xctrace-only devices, install the app with Xcode before opening it by bundle ID.
- Use it for upgrade flows: existing app data is kept where the platform supports it.
- Remote daemons automatically upload local app artifacts for `install`; prefix the path with `remote:` to use a daemon-side path verbatim.
- Supported binary formats: Android `.apk`/`.aab`, iOS `.app`/`.ipa`, HarmonyOS `.hap`.
- `.aab` requires `bundletool` in `PATH`, or `AGENT_DEVICE_BUNDLETOOL_JAR=<absolute-path-to-bundletool-all.jar>` with `java` in `PATH`.
- `.aab` installs use bundletool `build-apks --mode universal`.
- `.ipa` installs by extracting `Payload/*.app`; if multiple app bundles exist, `<app>` is used as a bundle id/name hint to select one.

## App reinstall (fresh state)

```bash
agent-device reinstall com.example.app ./build/app.apk --platform android
agent-device reinstall com.example.app ./build/MyApp.app --platform ios
```

- `reinstall <app> <path>` uninstalls and installs in one command.
- Use it for login/logout reset flows and deterministic test setup.
- Same device coverage, binary formats, and remote upload as `install`.

## App install from source URL

```bash
agent-device install-from-source https://example.com/builds/app.apk --platform android
agent-device install-from-source https://example.com/builds/app.aab --platform android
agent-device install-from-source --github-actions-artifact thymikee/RNCLI83:6635342232 --platform android
```

- `install-from-source <url>` installs from a URL source through the normal daemon artifact flow.
- `install-from-source --github-actions-artifact <owner/repo:artifact>` passes a typed GitHub Actions artifact source through to a compatible remote daemon. Numeric artifacts are sent as `artifactId`; non-numeric artifacts are sent as `artifactName`.
- Repeat `--header <name:value>` for authenticated or signed artifact requests.
- Supports the same device coverage as `install`: Android devices/emulators, iOS simulators, and CoreDevice-backed iOS physical devices.
- Use `install` or `reinstall` for local `.apk`, `.aab`, `.app`, and `.ipa` paths; use `install-from-source` when the artifact already exists at a URL reachable by the daemon.
- Direct Android URL sources may be `.apk` or `.aab`.
- URLs from any public host may resolve to archives containing one installable `.apk`, `.aab`, `.ipa`, or iOS `.app`. Prefer `--github-actions-artifact` for GitHub Actions artifacts that a compatible remote daemon can resolve with its own credentials.
- Downloads resolve and approve every redirect destination, pin each connection to the approved address, reject HTTPS downgrades, and follow at most five redirects. Sensitive caller headers are not forwarded across origins.
- Downloaded artifacts are limited to 2 GiB compressed. Archive materialization is limited to 4 GiB expanded data, 100,000 entries, and three nested archive layers; links and special archive entries are rejected.
- Standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` configuration is honored without delegating destination DNS resolution to the proxy.
- `--retain-paths` keeps retained materialized artifact paths after install, and `--retention-ms <ms>` sets their TTL.
- URL downloads follow the same `installFromSource()` safety checks and host restrictions as the Node.js client.

## Push notification simulation

```bash
agent-device push com.example.app ./payload.apns --platform ios
agent-device push com.example.app '{"aps":{"alert":"Welcome","badge":1}}' --platform ios
agent-device push com.example.app '{"action":"com.example.app.PUSH","extras":{"title":"Welcome","unread":3,"promo":true}}' --platform android
```

- `push <bundle|package> <payload.json|inline-json>` simulates push notification delivery.
- iOS push simulation is simulator-only (`xcrun simctl push`) and requires an APNs-style JSON object payload.
- Android uses `adb shell am broadcast` and accepts payload shape:
  `{"action":"<intent-action>","receiver":"<optional component>","extras":{"key":"value","flag":true,"count":3}}`.
- Android extras support `string`, `boolean`, and `number` values.
- `push` works with the active session device, or with explicit selectors (`--platform`, `--device`, `--udid`, `--serial`).

## App event triggers (app hook)

```bash
agent-device trigger-app-event screenshot_taken '{"source":"qa"}'
```

- `trigger-app-event <event> [payloadJson]` dispatches app-defined events via deep link.
- `trigger-app-event` requires either an active session or explicit device selectors (`--platform`, `--device`, `--udid`, `--serial`).
- On macOS, use `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE` to override the desktop deep-link template.
- On iOS physical devices, custom-scheme deep links require active app context (open app first in the session).
- Configure one of:
  - `AGENT_DEVICE_APP_EVENT_URL_TEMPLATE`
  - `AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE`
  - `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE`
  - `AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`
- Template placeholders: `{event}`, `{payload}`, `{platform}`.
- Example template: `myapp://agent-device/event?name={event}&payload={payload}`.
- `payloadJson` must be a JSON object.
- It calls your app's deep-link hook; it does not post OS-level notifications.

## Settings helpers

```bash
agent-device settings wifi on
agent-device settings wifi off
agent-device settings airplane on
agent-device settings airplane off
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

- iOS `settings` support is simulator-only.
- macOS supports only `settings appearance <light|dark|toggle>` and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>`.
- Android `settings animations off|on` toggles the global `window_animation_scale`, `transition_animation_scale`, and `animator_duration_scale` values. Use it as an opt-in stabilizer for automation runs with heavy system or app animations, then restore with `settings animations on` when needed.
- `settings appearance` maps to macOS appearance, iOS simulator appearance, and Android night mode.
- `settings text-size` reads the preferred text size the target holds; `settings text-size <category>` applies one. Categories: `extra-small|small|medium|large|extra-large|extra-extra-large|extra-extra-extra-large|accessibility-medium|accessibility-large|accessibility-extra-large|accessibility-extra-extra-large|accessibility-extra-extra-extra-large`. The read response reports the normalized `category` plus the `platformValue` the target answered with: the exact `font_scale` multiplier on Android, and the content-size name `simctl` echoes on iOS (which it sometimes capitalizes, e.g. `extra-Small`).
- `settings text-size` is supported on iPhone and iPad simulators (`xcrun simctl ui <device> content_size`) and on Android targets (system `font_scale`). tvOS and visionOS simulators, iOS physical devices, macOS, HarmonyOS, Vega, Linux, and web refuse both the read and the write: the content-size surface was verified only on the iPhone/iPad simulator leaf, and a size nobody observed a leaf holding would otherwise be reported as applied.
- Android has no category ladder, only a `font_scale` multiplier, so the two are mapped: `large` is `1.0` up through `accessibility-extra-extra-extra-large` at `3.2`. A device holding a multiplier off that ladder reads back as the nearest rung with the exact multiplier as `platformValue`, and an unset `font_scale` reads as `large`/`1.0`.
- A text size change is a configuration change: an app already running adopts it on its next configuration change, so relaunch the app under test (`open <app> --relaunch`) when asserting rendered sizes.
- `settings location set <lat> <lon>` sets precise coordinates on iOS simulators and Android emulators.
- `settings clear-app-state [app-id]` clears the active session app data, or the provided app id. The app id can also be named with `--app` (`settings clear-app-state --app com.example.app`); naming two different apps, one positionally and one with `--app`, is refused with `INVALID_ARGS`. Android uses `pm clear`, which removes SharedPreferences, databases, files, and cache. iOS simulator removes the app data container contents and leaves the fresh-install directory layout (empty `Documents`, `Library/Caches`, `Library/Preferences`, `SystemData`, and `tmp`, as on iOS 26.5; other runtimes may differ). With no app bound to the session and no app id named, it refuses with `error.details.reason: session_app_required` and `dispatched: no`. iOS physical devices and macOS are unsupported. It does not touch the keychain, so keychain-backed credentials (e.g. Firebase auth) survive it.
- `settings reset-keychain clear` resets the iOS simulator's keychain (`xcrun simctl keychain <device> reset`), removing keychain-backed credentials such as Firebase auth tokens that `clear-app-state` leaves behind. simctl has no per-app keychain reset, so this clears the keychain for every app installed on that simulator, not only the app under test — treat it as a whole-simulator, opt-in operation and pair it with `clear-app-state` for a full fresh-install reset. iOS physical devices, Android, and macOS are unsupported.
- Face ID and Touch ID controls are iPhone and iPad simulator-only; Apple TV and Vision Pro simulators refuse them. They post the same Darwin notifications the Simulator.app Features menu posts (`xcrun simctl spawn <device> notifyutil`): `com.apple.BiometricKit_Sim.<pearl|fingerTouch>.<match|nomatch>` for match/nonmatch, and `com.apple.BiometricKit.enrollmentChanged` (set to `1`/`0`, then posted, then read back) for enroll/unenroll. No `simctl biometric` subcommand exists, so this route works on any Xcode.
- Android `settings airplane on|off` is applied by the connectivity service (`cmd connectivity airplane-mode`, Android 11+), which drives the radios rather than only writing the `airplane_mode_on` setting. The response reports the `airplaneMode` that service holds after the change, and Android builds without that command fail without changing device state. Connectivity takes a moment to settle after the switch, so poll the app under test rather than asserting offline behavior immediately.
- Fingerprint simulation is supported on Android targets where `cmd fingerprint` or `adb emu finger` is available.
  On physical Android devices, only `cmd fingerprint` is attempted.
- On iOS and Android, permission actions default to the active session app. Pass `--app <bundle-id-or-package>` (or the client `app` option) to aim a `permission` change — grant, deny, or reset — or an iOS simulator `location on|off` privacy change, at an installed app without opening it or binding a session — for example, grant a permission before the app's first launch. The app must be installed on the target; no app has to be running. The CLI reads `--app` for `settings` only when you pass it on the command line: an `AGENT_DEVICE_TARGET_APP` environment variable or a `targetApp` in `~/.agent-device/config.json` (both useful for `doctor`) never retargets a settings mutation, which falls back to the session app. With no app bound to the session and none named, `settings permission` refuses with `INVALID_ARGS` and `error.details.reason: session_app_required` and `dispatched: no`: `open <app>` and retry, or name the app with `--app`. On iOS, an on/off `settings location` behaves the same. A change that is device-wide refuses a named app instead of dropping it, with `error.details.reason: setting_app_not_consumed`: `location set` moves the device's own coordinates on every target, the Android `location on|off` toggle writes the device's `location_mode`, and a macOS permission is a host-level TCC grant that needs no session app.
- iOS permission targets: `all`, `camera`, `microphone`, `photos` (`full` or `limited`), `contacts`, `contacts-limited`, `notifications`, `calendar`, `location`, `location-always`, `media-library`, `motion`, `reminders`, `siri`. `all` travels as one `simctl privacy … all` call.
- On iOS, which of those services a runtime actually changes is `simctl privacy`'s own verdict, not its help text: Xcode 26 omits `camera` from the list while granting it. A service the runtime refuses fails with `UNSUPPORTED_OPERATION` naming the service; on current runtimes that is `notifications`, which a targeted change cannot reach and `all` leaves untouched.
- Android permission targets: `all`, `calendar`, `camera`, `contacts`, `location`, `media-library`, `microphone`, `notifications`, `photos`. `contacts` fans out to `READ_CONTACTS`+`WRITE_CONTACTS`, `location` to `FINE`+`COARSE`, `calendar` to `READ`+`WRITE`; named multi-id targets intersect the package's declared permissions so a coarse-only or read-only app still succeeds, while a target declaring none of its ids fails loudly. `all` resolves against the package's declared permissions instead. Every response reports `permission` as the requested target and `permissions: string[]` as the ids actually mutated, in the order applied (`all` folds its applied ids into `permissions` the same way).
- macOS permission targets: `accessibility`, `screen-recording`, `input-monitoring`.
- On macOS, `settings permission grant ...` checks or requests access and opens System Settings guidance when needed; it does not grant TCC permissions silently.
- On macOS, `settings permission deny ...` is unsupported.
- Android uses `pm grant|revoke` for runtime permissions (`reset` maps to revoke) and `appops` for notifications. Every permission mutation names the foreground user explicitly (`--user <id>`, resolved with `am get-current-user`): `pm` defaults these operations to user 0, so on a device whose foreground user is nonzero an unscoped revoke would edit user 0 and leave the running app's permission untouched. Resolving that user is a prerequisite — if `am get-current-user` does not answer, `settings permission` fails with `COMMAND_FAILED` and changes nothing rather than applying the mutation to user 0.
- Android kills a running app whenever a runtime permission it currently holds is revoked, so `settings permission deny|reset` after a grant leaves the session app no longer running. The response reports the prior state of the revoked permission for the acting user as `priorGrantState: granted | not_granted | unknown`, and carries a warning naming `open <app> --relaunch` for both `granted` and `unknown` — `unknown` means the device did not report a readable state, not that the app was left alone. Revoking a permission the app does not hold (`not_granted`) is harmless and warns nothing.
- `full|limited` mode is supported only for iOS `photos`; other targets reject mode.
- Use `match`/`nonmatch` to simulate valid/invalid Face ID, Touch ID, and Android fingerprint outcomes.

## App state and app lists

```bash
agent-device appstate
agent-device apps --platform ios
agent-device apps --platform ios --all
agent-device apps --platform android
agent-device apps --platform android --all
```

- Android `appstate` reports live foreground package/activity.
- iOS `appstate` needs a session and answers about that session's app: `appName` and `appBundleId` from the session record, and `state` from a live runner, which reads the app's `XCUIApplication` state (`runningForeground`, `runningBackground`, `runningBackgroundSuspended`, `notRunning`, `unknown`) with `source: runner`. After `home` the app reports a background state (`runningBackground` or `runningBackgroundSuspended`); which app took the screen is not read, since no Apple target answers a sessionless foreground probe. The read never starts a runner: when none is live, or the runner cannot answer, the record alone does, with `source: session` and no `state`. A command that had to bring the app back reports that as the [`targetActivation` disclosure](#foreground-repairs-on-ios).
- `apps` shows user-installed apps by default. Use `--all` when you need the full inventory, including system/OEM apps.

## Foreground repairs on iOS

An iOS session is bound to one app, but the app can leave the foreground without the session knowing:
a deep link, a system sheet, or a `simctl openurl` hands the screen to another app. When the next
command arrives, the runner brings the session app back so the command can be answered at all, and
that repair is disclosed on the command that paid for it rather than applied silently:

```bash
agent-device open com.example.app --platform ios
agent-device screenshot --platform ios            # Safari screen
agent-device snapshot -i --platform ios           # answers with the app's tree
```

The `snapshot` response carries `targetActivation` plus an appended `warnings` entry naming the
state the session app was found in and why the runner activated it:

```json
{
  "targetActivation": {
    "reason": "bundle_changed",
    "priorState": "runningBackground",
    "otherActiveApplicationPid": 4562
  }
}
```

- Read it as: anything captured earlier in this session described the other app, not the session app.
  Re-capture now, or drive the other app in its own session.
- `otherActiveApplicationPid` is present only when exactly one application other than the session app
  held an active accessibility session at that moment. It is a liveness claim, not a foreground owner:
  the runner's probe reports no ordering, so nothing here proves which app owned the screen. Absent
  means the runner could not isolate one candidate, which is not a failure.
- `priorState` is the session app's state read before the runner activated it, so it names what was
  repaired rather than what the repair produced. It is never `runningForeground`.
- `reason` names the check that found the app out of foreground: `bundle_changed` when the runner's
  cached session target differs from the bundle the command asked for, `stale_target` when the cached
  target matches but no longer answers as foreground, `missing_after_wait` when a wait for the app
  never observed it, and `interaction_foreground_guard` when an interaction's own foreground guard
  tripped before dispatching.
- The disclosure rides capture-consuming commands — `snapshot`, `find`, `get`, `is`, `wait`, and an
  interaction whose target tree was captured for it — at every response level, including
  `--level digest`. On a failure the typed fact is in `error.details` and the sentence in its hint. It is disclosed only for the command that paid for the repair: a read answered
  from a cached or stored tree did no device work and reports no repair of its own.
- In text mode the warning prints as a `Warning:` line; see [Output and warnings](#output-and-warnings).
- **Silence is not proof.** A command that consumes no capture — a coordinate `press`, a `press @ref`
  answered from a live ref frame, or a `wait <text>` that its text observation answered on the first
  poll — may still have had the runner re-activate the session app to serve it, and reports nothing.
  A `wait <text>` that timed out and re-activated while describing the surface does disclose. Do not
  infer that the foreground held from a command that said nothing (see
  [#2694](https://github.com/callstack/agent-device/issues/2694)). When the distinction matters, run
  `snapshot -i` and read its disclosure.
- The warning is appended; staleness, snapshot-quality, and occluding-system-surface warnings that
  came before it are never replaced.
- **No read launches a stopped app.** A command that only observes the app (`snapshot`, `wait`,
  `is`, `get`, a reading `find`) repairs a backgrounded session app, but never launches one that is
  not running — and neither does an interaction's leading read: the viewport read a `gesture` starts
  with, or the capture that resolves a selector `click`/`fill`. A bare launch would start the app
  without the URL of a launch that SpringBoard is still holding behind an "Open in …?" confirmation.
  A refused command answers `COMMAND_FAILED`, `details.runnerErrorCode: "APP_NOT_RUNNING"` and
  `retriable: true`, and `wait` keeps polling through it. Answer the prompt with `alert accept`, or
  relaunch with `open`. Only an interaction that mutates without a leading read — `press`, a
  coordinate `fill`, `swipe`, `scroll`, a hardware key — still brings a stopped app up.

## Clipboard

```bash
agent-device clipboard read
agent-device clipboard write "https://example.com"
agent-device clipboard write ""   # clear clipboard
```

- `clipboard read` returns clipboard text for the selected target.
- Treat `clipboard read` output as sensitive data; it can include secrets copied by the user or app.
- `clipboard write <text>` updates clipboard text on the selected target.
- Works with an active session device or explicit selectors (`--platform`, `--device`, `--udid`, `--serial`).
- Supported on macOS, iOS simulator, and Android builds whose clipboard service answers the `cmd clipboard` shell command.
- iOS physical devices return `UNSUPPORTED_OPERATION` for clipboard commands.
- On Android 16 (API 36), both actions return `UNSUPPORTED_OPERATION` and `capabilities` omits `clipboard`; see [Known Limitations](/docs/known-limitations#android-no-clipboard-access-over-adb-on-android-16).

## Keyboard

```bash
agent-device keyboard status
agent-device keyboard get
agent-device keyboard dismiss
```

- `keyboard status` (or `keyboard get`) returns keyboard visibility and best-effort input type classification on Android.
- To hide the keyboard, use `keyboard dismiss`. It taps safe controls like `Done` when available and verifies the keyboard closed.
- If it reports `UNSUPPORTED_OPERATION`, press a visible app control such as `Done` only when that is the intended fallback.
- Works with active sessions and explicit selectors (`--platform`, `--device`, `--udid`, `--serial`).
- `keyboard status|get` is supported on Android emulator/device.
- `keyboard dismiss` is supported on Android emulator/device and best-effort on iOS simulator/device.

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

- Use an explicit `frames`, `memory`, `cpu`, or `trace` area so each request answers one profiling question. In 0.21, bare `perf`, `perf sample`, `perf metrics`, and the `metrics` alias fail with guidance to the focused replacements.
- `perf frames` returns bounded frame/jank health; `perf memory sample` returns a compact native/process memory sample; `perf memory snapshot` writes a heap/memgraph artifact and returns its path.
- `cdp` samples and snapshots the React Native JavaScript heap through Metro CDP; see [Debugging & Profiling](/docs/debugging-profiling#react-native-js-memory-through-cdp).
- `perf cpu profile ... --kind xctrace` and `perf trace ... --kind xctrace` record an Apple `.trace`; `perf cpu profile ... --kind simpleperf` and `perf trace ... --kind perfetto` capture Android native profiles and traces for the active session package. These commands return artifact paths and compact metadata; raw profile and trace contents stay on disk. See [Performance snapshots](/docs/debugging-profiling#performance-snapshots).
- The `simpleperf` report artifact keeps up to 50 parsed rows, while the response returns at most ten top functions and the CLI prints at most five.
- Without `--json`, each explicit perf area prints a compact focused summary.
- App startup duration is returned in `open`'s `startup` result.
- Android app sessions with an active package support:
  - `fps` frame health from `adb shell dumpsys gfxinfo <package> framestats`, with `droppedFramePercent` as the primary value and `worstWindows` for dropped-frame clusters
  - `memory` from `adb shell dumpsys meminfo <package>` with values reported in kilobytes (`kB`)
- Apple app sessions with an active bundle ID support:
  - `fps` frame health from `xcrun xctrace` Animation Hitches on connected iOS devices, with `droppedFramePercent` as the primary value and `worstWindows` for hitch clusters
  - `memory` from process RSS snapshots reported in kilobytes (`kB`)
- Platform support:
  - `memory`: Android emulator/device, HarmonyOS device, macOS app sessions, iOS simulators with an active app session (`open <app>` first), and iOS physical devices with an active app session
  - `fps`: Android emulator/device app sessions and connected iOS device app sessions. iOS simulator and macOS frame health is reported unavailable because Apple tooling does not expose trustworthy app hitch data there.
  - `perf memory snapshot --kind android-hprof`: Android emulator/device app sessions with a running debuggable/profileable process and permitted heap dumping
  - `perf memory snapshot --kind memgraph`: iOS simulator and macOS app sessions with a running app process. Physical iOS devices report memgraph unavailable with a recovery hint.
  - `perf memory trace --kind heapprofd`: not available.
  - `perf cpu profile --kind xctrace`: iOS simulator app sessions, connected iOS device app sessions where xctrace can attach to the active process, and macOS app sessions when the app process can be resolved from the bundle ID.
  - `perf trace --kind xctrace`: iOS simulator app sessions, connected iOS device app sessions where xctrace can attach to the active process, and macOS app sessions when the selected xctrace template supports the target.
  - `--kind xctrace` does not profile Android; use `--kind simpleperf` or `--kind perfetto` there.
- HarmonyOS performance evidence is memory-only on the public HDC surface: CPU profiling, frame sampling, and memory-snapshot artifacts are unavailable.
- Android URL/deep-link opens infer the foreground package after launch when possible, including Expo Go/dev-client shells. If the session still has no app package/bundle ID, package-bound metrics remain unavailable until you `open <app>`.
- Android frame health is reset after each successful `perf frames` read and after `open <app>`, so run `perf frames`, perform the interaction, then run `perf frames` again for a focused window.
- Android Simpleperf and Perfetto collectors require an active Android app session with a running package process. iOS native Simpleperf/Perfetto support is not provided by these commands.
- On CoreDevice-backed physical iOS devices, `perf frames` records a short `xcrun xctrace` sample. Keep the device unlocked, connected, and the app active in the foreground while sampling.

## React Native component internals

```bash
agent-device react-devtools status
agent-device react-devtools wait --connected
agent-device react-devtools get tree --depth 3
agent-device react-devtools get component @c5
agent-device react-devtools find Button
agent-device react-devtools profile start
agent-device react-devtools profile stop
agent-device react-devtools profile slow --limit 5
agent-device react-devtools profile rerenders --limit 5
agent-device react-devtools profile timeline --limit 20
agent-device react-devtools profile report @c5
```

- `react-devtools` runs the pinned `agent-react-devtools@0.5.0` package through npm and passes arguments through unchanged.
- The first run may download the pinned package from npm; later runs can reuse the npm cache.
- `agent-device` global flags work before or after `react-devtools`. Use `--` before downstream flags only when they intentionally share an `agent-device` global flag name.
- Use it when a React Native workflow needs component hierarchy, props, state, hooks, render causes, slow components, or re-render counts.
- For the bounded profiling workflow, see [Debugging & Profiling](/docs/debugging-profiling#react-native-component-internals).
- React Native development builds can connect to the DevTools daemon on port 8097. For Android emulators or physical devices, run `adb reverse tcp:8097 tcp:8097` if the app cannot reach the host.
- Direct Android `open` URL targets for local Metro hosts with a port auto-configure host reachability. For app/package launches or unsupported flows, run `adb reverse tcp:8081 tcp:8081` if the app cannot reach local Metro.
- For Android and iOS sessions connected through a remote bridge profile, `react-devtools` registers a lease-scoped companion tunnel to the sandbox-local DevTools daemon at `127.0.0.1:8097`. Android bridge profiles use the bridge-owned remote `adb reverse` mapping; iOS bridge profiles use the bridge-owned wildcard Metro host tunnel. The CLI keeps the companion alive until `agent-device react-devtools stop` or `agent-device disconnect`.
- For remote iOS bridge sessions, open the app once to create the bridge session, run `agent-device react-devtools start`, then relaunch the same bundle id with `agent-device open <bundle-id> --platform ios --relaunch` before `wait --connected`. React Native attempts the legacy DevTools websocket during JavaScript startup, so starting DevTools after the first launch can miss that connection attempt.
- Remote bridge React DevTools assumes the React Native-bundled DevTools behavior in React Native 0.83+. Older browser/Chromium DevTools workflows are not assumed to exist inside remote sandboxes. Verify Expo projects against the SDK's bundled React Native version before relying on this path; no Expo SDK version has been verified separately.
- For cross-platform validation with explicit target selectors, use separate sessions/devices and restart `react-devtools` between iOS and Android runs.

```bash
agent-device react-native dismiss-overlay
agent-device react-native dismiss-overlay --platform android
```

- `react-native dismiss-overlay` clears a React Native development overlay (a redbox/LogBox error or a collapsed warning banner) that is blocking interaction, then returns without changing app state otherwise.
- Use it when a snapshot or interaction is blocked by a dev-only overlay; it is a no-op when no overlay is present.
- It is supported on iOS simulators/devices and Android emulators/devices. `dismiss-overlay` is the only `react-native` subcommand.

## Multiple React Native worktrees

You can reuse one installed iOS simulator debug build across multiple local worktrees when the native binary is compatible with both JavaScript trees. Run one Metro server per worktree on a unique port, then open the same app on different simulators with explicit Metro runtime hints:

```bash
# Worktree A terminal
yarn expo start --dev-client --port 8081 --host localhost

# Worktree B terminal
yarn expo start --dev-client --port 8082 --host localhost

agent-device open "React Navigation Example" --platform ios --device "iPhone 17" --session rn-a --metro-host 127.0.0.1 --metro-port 8081 --relaunch
agent-device open "React Navigation Example" --platform ios --device "iPhone 17 Pro" --session rn-b --metro-host 127.0.0.1 --metro-port 8082 --relaunch
```

- Use different simulators and sessions for each worktree. One simulator cannot run two copies of the same bundle id at the same time.
- On iOS simulators, `open` writes React Native's per-simulator debug server settings before launching, so `rn-a` can use port `8081` while `rn-b` uses port `8082`. Each session also remembers its dev server for a flagless `metro reload --session <name>`; see [Metro reload](#metro-reload).
- This covers JavaScript and Metro-resolved workspace changes. Rebuild/reinstall the app when native code, native dependencies, bundle identifiers, entitlements, or generated native project files change.
- Close every manually opened session when done:

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

- `metro reload` triggers a dev-server reload, the same mechanism used by pressing `r` in the Metro terminal.
- Use it for React Native dev builds that are already connected to Metro when JS changes should be loaded without restarting the native app process.
- A flagless `metro reload --session <s>` resolves against the dev server that session last bound — via `metro prepare` or `open`'s `--metro-host`/`--metro-port`/`--bundle-url` hint flags — so it never silently reloads a different project's server on the default port. Resolution priority is per-call flags, then that session's saved binding, then `http://localhost:8081/reload`; a host or port flag overrides only that field, while `--bundle-url` supplies the target bundle origin and route.
- Session bindings are updated by each hinted `open` or `metro prepare`, cleared by `close`, and also cleared when a fresh same-name `open` has no Metro hint flags. This prevents a reused session name from reloading a previous project's dev server.
- The reload URL keeps the bound bundle URL's mount prefix instead of collapsing to the host root. This applies to both `index.bundle` and Expo's virtual entry: `http://host/tenant-42/.expo/.virtual-metro-entry.bundle` maps to `http://host/tenant-42/reload`.
- When the dev server has no HTTP `/reload` route and answers with the app page instead (Expo does this), `metro reload` broadcasts `{"version":2,"method":"reload"}` over the server's `/message` websocket — the channel the dev-server CLIs use for the `r` key — instead of reporting the app-page response as a successful reload. The result's `transport` field says which channel delivered the reload.
- Fall back to `open <app> --relaunch` when the app is not connected to Metro, reload fails, or the native process itself must restart.

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

- Recordings always produce a video artifact. `record start` defaults to app scope and requires an active session from `open <app>`; use `--scope device` or `--scope system` to explicitly request whole-screen capture where the selected backend supports it, such as recordings that intentionally span the full screen, multiple apps, settings, home screen, or app transitions. When touch visualization is enabled, recordings also produce a gesture telemetry sidecar that can be used for post-processing or inspection.
- iOS `record` works on simulators and CoreDevice-backed physical devices.
- iOS simulator recording uses native `simctl io ... recordVideo`.
- Physical iOS device capture is runner-based and built from repeated `XCUIScreen.main.screenshot()` frames (no native video stream/audio capture).
- Physical iOS device capture is best-effort: dropped frames are expected and true 60 FPS is not guaranteed even with `--fps 60`.
- Physical-device capture defaults to 15 FPS.
- `--fps <n>` (1-120) applies to physical iOS device recording as an explicit FPS cap.
- `--quality <medium|high>` controls recording output quality. Android maps it to `adb shell screenrecord --bit-rate`; Limrun sessions map it to the provider recorder's quality (`medium` to 5, `high` to 8). Apple export always preserves the captured resolution, so `--quality` has no effect on Apple output size. `medium` is the default; pass `high` for evidence, release notes, or debugging visual artifacts. Legacy numeric values are still accepted for compatibility: `5`-`7` map to `medium`, and `8`-`10` map to `high`.
- `screenshot --scale <factor>` proportionally resizes both dimensions. The accepted range is `0.01` through `1`; use `1` for full resolution. The former `--max-size <px>` flag was removed and is refused with migration guidance wherever it appears (CLI, `.ad` scripts, Node options, config, and the retired `AGENT_DEVICE_SCREENSHOT_MAX_SIZE` env var).
- Set `AGENT_DEVICE_SCREENSHOT_SCALE=0.3` (or `screenshotScale` in config) as a token-conscious screenshot default for agent workflows. An explicit `--scale` overrides it.
- Keep the scale default unset, or use `--scale 1`, when full-resolution screenshots are required for reusable pixel-diff baselines.
- On single-display iOS simulators and Android devices, the screenshot result reports `displayRotation` (`portrait`, `portrait-upside-down`, `landscape-left`, or `landscape-right`): the rotation the display rendered the capture in. The field is best-effort. It is absent when the device returns no reading in time, on other targets, and on devices with more than one display, such as foldables, where no single rotation is known to pair with the image. The saved image is always upright, so a landscape value pairs with a landscape image. The daemon `/artifacts` inventory reports the same value on the screenshot entry, including the fallback screenshot a sparse `snapshot` takes.
- `screenshot --overlay-refs` captures a fresh full snapshot and burns visible `@eN` refs plus their target rectangles into the saved PNG.
- `screenshot --crop-on <selector>` captures a fresh full snapshot of the same screen and crops the saved PNG to the frame the selector resolves to. The crop is re-encoded, so byte-comparing it against an older crop of the same frame is unreliable; a crop whose pixels are all opaque is written as truecolor RGB, while one containing transparency keeps RGBA. The selector must resolve to exactly one framed node; the result carries a `warnings` entry when the frame is clipped to the image. Supported only on iOS simulators and Android emulators — every other target is refused before any device work, and the flag cannot be combined with `--overlay-refs` or `--fullscreen` because both move the captured frame away from the snapshot viewport the crop is measured against.
- `screenshot --fullscreen` on macOS applies only to app sessions. Every other `--surface` (`desktop`, `menubar`, `frontmost-app`) captures through the macOS helper, which always captures the main display, so an explicit `--fullscreen` on any of them names a frame the capture cannot vary; it is refused with `INVALID_ARGS` before any capture runs, rather than accepted and ignored.
- `screenshot --normalize-status-bar` temporarily normalizes iOS simulator status-bar chrome for deterministic screenshot baselines; ordinary screenshots leave the simulator's current chrome visible.
- `screenshot --scale <factor> --overlay-refs` writes a smaller image and draws refs for that final image size; avoid very small scales when text, icons, or labels need to remain readable.
- `diff screenshot` compares the current live screenshot to `--baseline`, or compares `--baseline` to an optional saved `current.png` path without requiring an active session. Each input is decoded from its own bytes, so `--baseline` and a saved current image may be PNG or JPEG whatever their extension says. Most `agent-device screenshot` artifacts are PNG; a HarmonyOS capture is the JPEG its device serves, stored under the requested name. Its text output reports ranked changed regions with screen-space rectangles, changed-pixel counts, and each region's share of the diff; JSON also includes normalized rectangles. The `ocr` and `nonTextDeltas` result fields are retired and never populated; for qualitative interpretation, read the baseline, current, and diff images with vision. It writes a diff PNG with a light grayscale current-screen context, red-tinted changed pixels, and outlined changed regions when `--out` is provided. Live iOS simulator diffs normalize status-bar chrome by default; use `screenshot --normalize-status-bar` when capturing reusable baselines.
- `diff screenshot --overlay-refs` additionally writes a separate current-screen overlay guide for live captures without using that annotated image for the pixel comparison. If current-screen refs intersect changed regions, the output lists the best ref matches under those regions. Saved-image comparisons do not have live accessibility refs, so `--overlay-refs` is unavailable when a `current.png` path is provided.
- `diff screenshot --threshold <0-1>` sets the per-pixel RGB tolerance (default `0.1`): `0` requires exact colors and `1` ignores all color differences. Image dimensions must still match at every threshold. JPEG is lossy and shifts pixels around hard edges, so keep the threshold above `0` when comparing a JPEG against anything it was not encoded from.
- In `--json` mode, each overlay ref also includes a screenshot-space `center` point for coordinate fallback like `press <x> <y>`.
- Burned-in touch overlays are exported only on macOS hosts.
- On Linux or other non-macOS hosts, `record stop` still succeeds and returns the raw video plus telemetry sidecar, and includes `overlayWarning` when burn-in overlays were skipped.
- The touch overlay renders at most 30 frames a second, or at `--fps` when it is lower, so a lower `--fps` makes a long recording's `record stop` faster. The overlay has a fixed budget inside the `record stop` request; an export that runs past it returns the raw video and telemetry with an `overlayWarning` naming the budget.
- On iOS simulators, a busy CoreSimulator host recording slot makes `record start` return non-retriable `DEVICE_IN_USE` with `details.reason: apple_simulator_recording_busy`. Use `record stop` in the session that owns the active recording. If a previous recorder died and no recording is active, ask the host operator to restart the CoreSimulator stream service before retrying.
- When the Apple runner records (`--fps` sets its frame rate), it captures a frame only while no command is using the runner's main thread; a frame that falls during that work is skipped instead of queued behind it. A capture slower than the frame interval lowers the frame rate, and a capture still running after one second is dropped. A busy app or a long command can therefore yield fewer frames than `--fps` requests.
- Android uses `adb shell screenrecord`, which has a 180s platform limit. `record start` publishes a durable device manifest. Longer recordings are split into MP4 chunks while the daemon stays alive; after daemon restart, `record stop` recovers only manifest-owned chunks and warns when gesture overlay telemetry was lost.
- Android `screenrecord` encodes a frame only when the screen changes, so a clip ends at the last frame the recorder encoded instead of at `record stop`: a window that ends on an unchanged screen yields a shorter video, while every on-screen change inside the window stays at its real offset in it. `record stop` reports `durationMs` as host wall clock from `record start` until the export finished, and when the video can be measured it also reports `capturedDurationMs` and warns with how much of the window that video covers.
- Limrun iOS and Android direct sessions record the whole simulator or emulator screen through the provider's server-side recorder, so every `--scope` captures the same frame and `--fps` and `--hide-touches` are refused with `INVALID_ARGS` before any device work. `record stop` asks the instance to stop once and then downloads the served MP4 to the output path; that download is bounded to end inside the request window, so a slow or dropped transfer ends typed, leaves no file behind, and is retried by the next `record stop` from the same URL while the instance lives. Nothing survives a daemon restart: the recording is `unreattachable` and the instance disposes the file when the lease is released.
- `record stop` is safe to repeat. When its request window ends while the daemon is still exporting, on a local or remote daemon, the export keeps running there, and a second `record stop` in the same session returns that completed recording, including the caller-side output path, without starting another recording. A finished recording whose video file is already gone reports `no active recording`.
- A recording answers two independent questions, and `record stop` reports both: whether a playable export exists, and whether the recorder stopped. `recorder` is `confirmed` when the recorder exited or acknowledged a stop meant for this recording, and `lost` when the session holding it died — an Apple recording invalidated by a runner restart. `nativePathDisposition` says what became of the artifact path the recorder itself writes to: `retirable` while that file still sits there owed a removal, and `retired` once its removal was verified. Both are optional disclosures — the export is served either way, a replay of a recording stopped before they existed omits them, and so does a backend whose recorder writes the served file itself. The schema also declares values that no stop reports: `recorder: unconfirmed` (a probe that could not be read, or no exit inside the stop budget), the identity-mismatch reasons under `lost`, and `nativePathDisposition: pending` (see [ADR 0024](https://github.com/callstack/agent-device/blob/main/docs/adr/0024-screen-recording-provable-signal.md)).

- `record contact-sheet <video.mp4> [--out <sheet.png>]` turns a recording you already exported into one PNG: the frames where the screen visibly changed, laid out in a grid and each labeled with its elapsed time (`HH:MM:SS.mmm`) on the clip timeline. It is how an agent reads a recording it cannot play. It reads the file you pass — no session, no device, no daemon — so it can rebuild an old take and the sheet can only describe screens that export contains. Any backend that exports MP4 works (Apple, Android, HarmonyOS, Limrun); a WebM recording from the web backend is refused with `details.reason: contact_sheet_container_unsupported`. The default output is `<recording>.contact-sheet.png`, and `--out` is refused when it points back at the recording itself, because a sheet is derived from a take and never replaces it. `--json` reports each cell's time and changed-pixel share alongside `sampledFrameCount`, `decodedFrameCount`, and `skippedSampleCount`.
- A contact sheet is coverage, not a review. The sample grid is bounded and spread across the whole clip (every 250ms until 48 samples, then those 48 spread over the length) and at most 24 cells are printed, so a two-hour take costs no more than a five-second one. A transient that opens and closes entirely between two sample times is not in the returned frames and no threshold recovers it; when the sheet had to thin kept cells or the decoder declined sample times, `warning` says so. Frame decoding is Apple AVFoundation tooling, so the command is macOS-host only and refuses elsewhere with `details.reason: contact_sheet_unsupported_host`.

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

- Supported on iOS simulator, iOS physical device, and Android.
- `logs start` appends to `app.log` and rotates to `app.log.1` when the file exceeds 5 MB.
- `open` prints `Session state: <path>`; see [Sessions](/docs/sessions#find-a-sessions-logs-and-artifacts) for the files it contains.
- `events.ndjson` rotates to `events.ndjson.1` when it exceeds 5 MB (`AGENT_DEVICE_EVENT_LOG_MAX_BYTES` overrides, in whole bytes); one rotated generation is kept. `events` cursors stay absolute across rotation, so `nextCursor` still resumes; a cursor older than the retained window fails with `COMMAND_FAILED` and `details.reason: "EVENT_LOG_CURSOR_EXPIRED"`, with `details.earliestCursor` naming the oldest cursor that still resolves. If the retained files and their window record disagree — a hand-deleted generation, an edited file, a corrupt `events.ndjson.window.json` — `events` fails with `details.reason: "EVENT_LOG_WINDOW_UNVERIFIED"` rather than answering from a guessed offset; appends continue regardless.
- The event timeline leaves out user-entered content; see [Sessions](/docs/sessions#find-a-sessions-logs-and-artifacts). `--no-record` suppresses `action.recorded` entries.
- `network dump [limit] [summary|headers|body|all]` parses recent HTTP(s) entries from `app.log` for app/device sessions and from managed `agent-browser` request history for web sessions; `network log ...` is an alias.
- Prefer `--include headers|body|all` when you want explicit detail level without relying on positional ordering.
- On macOS, `logs` and `network dump` are app-scoped and parse Unified Logging output associated with the active session app.
- Network dump limits: scans up to 4000 recent log lines, returns up to 200 entries, and truncates payload/header fields at 2048 characters.
- On web, `network dump` uses `agent-browser network requests`; request/response bodies are not exposed by that backend path, so use direct `agent-browser` HAR workflows for browser-specific body capture.
- Android `network dump` also surfaces logcat timestamps and can backfill status and duration from adjacent GIBSDK packet lines when the URL is logged separately.
- Android log streaming automatically rebinds to the app PID after process restarts.
- iOS simulator log capture streams from inside the simulator with `simctl spawn <udid> log ...`, and `network dump` can recover recent simulator log history with `simctl log show` when the live app-log window is sparse.
- iOS log capture still relies on Unified Logging signals (for example `os_log`); plain stdout/stderr output may be limited depending on app/runtime.
- On iOS, `network dump` can return zero HTTP entries for real app activity when the app does not emit request metadata into Unified Logging. The response notes distinguish an empty repro window from a non-network app log window.
- On iOS, CFNetwork logs a request URL only on the line that opens a connection, so a request that reused a keep-alive connection has no URL anywhere in the log. Those requests are reported against the origin their connection was opened for, with `pathUnavailable: true`, their status, and their timing; ones whose connection was opened before the scanned window are counted in `unnamedRequests` instead, since they cannot be named at all. Treat a missing endpoint in an iOS dump as unproven rather than as evidence it was not called.
- Retention knobs: set `AGENT_DEVICE_APP_LOG_MAX_BYTES` and `AGENT_DEVICE_APP_LOG_MAX_FILES` to override rotation limits.
- Optional write-time redaction patterns: set `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` to a comma-separated regex list.

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

- `trace start [path]` begins trace-log capture for the active session.
- `trace stop [path]` stops capture and optionally writes or finalizes the trace artifact at the provided path.
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

- `connect` without `--remote-config` authenticates to cloud when needed, fetches the connection profile, writes a generated local profile, stores the remote scope locally, and defers tenant lease allocation plus Metro preparation until a later command needs them.
- Both `connect` forms refresh a stored CLI session into a short-lived `adc_agent_...` token when needed. If no CLI session exists, interactive shells start login automatically; CI and non-interactive shells fail with API-token setup instructions. Use `--no-login` to disable implicit login.
- `connect` rejects a cloud connection profile returned in the older `connection.remoteConfig` JSON string shape; the profile must be a JSON object at `connection.remoteConfigProfile`.
- `--remote-config <path>` points to a local remote workflow profile that captures stable host, tenant/run, and any optional session, platform, lease backend, or Metro overrides for `connect`.
- `connect --remote-config ...` follows the same verification, state, and deferred-preparation flow using the local profile instead of cloud discovery. Direct-provider profiles therefore require their provider credentials when `connect` runs; no device lease is created until a later device command.
- Inspect or recover cloud auth with `agent-device auth status`, `agent-device auth login`, and `agent-device auth logout`. Human login stores a revocable CLI session locally; it does not create or persist an `adc_live_...` service token.
- Cloud auth uses three credential classes: `adc_agent_...` short-lived command tokens, revocable CLI session refresh credentials, and explicit `adc_live_...` service/API tokens for CI.
- `AGENT_DEVICE_CLOUD_BASE_URL` should point at the bridge/control-plane API origin, not necessarily the dashboard origin; its `/api-keys` route may redirect to the dashboard for token creation.
- Deferred Metro preparation also applies to `batch` when any step opens an app and the batch does not provide its own per-step runtime.
- `connect` without `--session` always creates a fresh remote session. Its human and JSON next steps include the generated `--session`; concurrent processes must preserve that value on every command so they cannot adopt another process's ambient connection. The active connection fallback remains a convenience for one sequential workflow only. To replace a connection, pass its returned session explicitly with `--session <name> --force`; `--force` without a session creates another connection without overwriting or releasing the previous one.
- After `connect`, `install-from-source`, `open`, `snapshot`, `devices`, `press`, `fill`, `screenshot`, and other normal commands can reuse active connection state in a single sequential workflow so agents do not repeat remote host/session/lease selectors inline. If `connection status` shows `leaseId=pending`, the first platform-bound command allocates or refreshes the lease. Passing the same `--remote-config` to a normal command is also supported for self-contained scripts; the CLI reuses matching saved state or creates it before dispatch.
- Self-contained remote scripts should end with `disconnect --remote-config <path>` or `disconnect` to release the lease and stop the owned Metro companion.
- Explicit command-line flags override connected defaults. When `open` uses explicit remote daemon or tenant flags without saved runtime hints, the CLI warns because React Native apps may launch without Metro bundle/runtime hints.
- `metroProxyBaseUrl` is the bridge origin. Do not prebuild `/api/metro/...` paths in the client profile; the CLI calls the bridge endpoints itself.
- For cloud stock React Native iOS, the bridge descriptor supplies direct wildcard HTTPS Metro hints such as `<runtime>.metro.agent-device.dev:443`. The Apple runner is still used for runner-backed device commands, not for Metro reachability.
- Android keeps using bridge-provided runtime routes such as `/api/metro/runtimes/<runtimeId>/...`.
- `metroPublicBaseUrl` is only needed for direct/non-bridge bundle hints. Bridged profiles can omit it and rely on `metroProxyBaseUrl`.
- `metro prepare --remote-config ...` is an advanced inspection/debug path and can still write a `--runtime-file <path>` artifact when needed.
- The local Metro companion runs on the same machine as the React Native project and Metro. `disconnect` stops the companion owned by the connection, but it does not stop the user’s Metro server.

## Session inspection

```bash
agent-device session list
agent-device session list --json
```

- `session list` shows active daemon sessions for the caller's implicit workspace scope, or the explicitly named session scope when `--session` / `AGENT_DEVICE_SESSION` is configured.
- Use `--json` when you want to inspect or script against the raw session metadata.

## Cloud provider artifacts

```bash
agent-device artifacts --provider browserstack --provider-session <webdriver-session-id> --json
agent-device artifacts --provider aws-device-farm --provider-session <remote-access-session-arn> --json
```

- `artifacts` lists provider-hosted cloud artifacts such as videos, Appium logs, device logs, automation logs, and provider dashboard links.
- The response uses `cloudArtifacts` so it stays separate from daemon-managed local `artifacts` returned by screenshot, recording, install, replay, and remote materialization flows.
- Plain text output prints ready provider URLs. Use `--json` when scripts need the structured `cloudArtifacts` array.
- Historical lookup requires `--provider-session <id>` and `--provider <name>`. BrowserStack uses `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY`. TestMu AI uses `LT_USERNAME` and `LT_ACCESS_KEY`. AWS Device Farm uses the AWS CLI credential chain and infers the region from the session ARN when possible. See [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), and [TestMu AI](/docs/testmu) for CI credential setup.
- When a cloud runtime is registered in-process by an embedding host, `artifacts` can infer the active provider session from the current lease before disconnect.
- `disconnect --json` and `close --json` include provider release data when the runtime returns final cloud artifacts after session teardown. Some providers only finalize video/log URLs after the remote session is stopped, so retry `agent-device artifacts <provider-session-id> --provider <name> --json` if the first response is `pending`.

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
