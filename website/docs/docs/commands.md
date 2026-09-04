---
title: Commands
---

# Commands

This page summarizes the primary command groups.

For persistent defaults and project-scoped CLI settings, see [Configuration](/docs/configuration).

For agent workflow guidance that is matched to the installed CLI, run:

```bash
agent-device help
agent-device help workflow
agent-device help debugging
agent-device help react-native
agent-device help react-devtools
agent-device help remote
agent-device help web
agent-device help macos
agent-device help dogfood
agent-device help ios-system-ui
```

Skills are recommended for auto-routing when your agent runtime supports them, but they are not required. The CLI help topics are the version-matched operating contract.

For MCP-aware clients that support direct tools, run:

```bash
agent-device mcp
```

The MCP server exposes direct structured tools for installed commands. Tools use structured input contracts through `AgentDeviceClient`; local-only workflows stay CLI-only rather than subprocess fallbacks. It does not expose generic shell execution over MCP. MCP tools can target `platform: "web"` after `agent-device web setup`, but setup and doctor stay CLI-only.

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
```

- `boot` ensures the selected target is ready without launching an app.
- `boot` requires either an active session or an explicit device selector.
- `shutdown` turns off the selected Apple simulator or Android emulator.
- `shutdown` must not target an active session device; use `close --shutdown` to end the session and turn it off.
- `daemon stop --state-dir <path>` verifies the daemon PID/start-time identity, requests graceful shutdown, and reports whether provider-release state is known. Use `daemon stop --clean` to also remove retained Apple runner processes and leases owned by that daemon.
- `device status` reads host-local device claims without starting or contacting a daemon. Normal output shows live and attention-needed claims, then summarizes proven-stale records in one line; use `device status --stale` to inspect the hidden records. Scope either view with `--platform` plus `--udid` (Apple) or `--serial` (Android). A foreign live or uncertain claim blocks `open`; a proven-dead owner is replaced only after its session's exact-owner durable resources reconcile successfully.
- `device release --stale` settles a provably dead owner's durable resources through the same exact-owner reconciliation `open` uses and clears its claim last, all without a daemon. Live, uncertain, PID-reused, and corrupt claims always fail closed and are reported with the reason; a live owner is released by closing its session from its own workspace or with `daemon stop --state-dir <owner state dir>`.
- `--platform apple` is an alias for the Apple automation backend (`ios`, `tvOS`, `macOS` selection).
- Use `--target mobile|tv|desktop` with `--platform` (required) to select phone/tablet vs TV-class vs desktop-class targets.
- `boot` is mainly needed when starting a new session and `open` fails because no booted simulator/emulator is available.
- Android: `boot --platform android --device <avd-name>` launches that emulator in GUI mode when needed.
- Android: add `--headless` to launch without opening a GUI window.
- Android: `shutdown --platform android --device <avd-name>` stops a running emulator.
- `open [app|url] [url]` already boots/activates the selected target when needed.
- `open <url>` deep links are supported on Android and iOS.
- `open <app> <url>` opens a deep link on iOS.
- `open <app> --launch-console <path>` captures launch-time stdout/stderr for direct iOS simulator app launches. It is not valid for URL opens or
  non-simulator targets.
- `open --device-hub` uses Xcode Device Hub when surfacing Apple simulators.
- `open --platform macos --surface app|frontmost-app|desktop|menubar` selects the macOS session surface explicitly. `app` is the default when an app argument is provided.
- `back` now defaults to app-owned back navigation. On Apple targets that means visible in-app back UI only. On Android this currently maps to the same back keyevent because Android routes in-app back through that platform event.
- `back --in-app` is an explicit alias for the default app-owned behavior.
- `back --system` asks for system back input explicitly. On Android this is the normal back keyevent. On iOS and tvOS it uses the platform back gesture or Siri Remote menu action. On macOS, where there is no generic system back input, `back --system` reports unavailable instead of falling back to app-owned navigation.
- `orientation <orientation>` forces a mobile device into `portrait`, `portrait-upside-down`, `landscape-left`, or `landscape-right`.
- `orientation` is supported on iOS and Android mobile targets. macOS and tvOS do not expose it.
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom scheme URLs require an active app in the session.
- Commands that need one concrete device refuse to guess: if no `--device`/`--udid`/`--serial` is given and several candidates are equally preferred (for example two booted emulators), the command fails with `AMBIGUOUS_MATCH` and lists them, rather than picking one and returning a successful answer about a device you did not select. Preferences still apply first — virtual over physical, booted over offline — so one booted emulator beside offline ones resolves normally, as does any command running inside an existing session. `devices` lists everything as before.
- Commands that omit `--session` use an implicit `default` session scoped to the caller's current git worktree or working directory. This keeps independent local agents from accidentally attaching to each other's default session.
- `--session <name>` or `AGENT_DEVICE_SESSION` opt into an explicitly named session when a script intentionally wants to share or reuse that session name.
- A configured `AGENT_DEVICE_SESSION` implies bound-session lock mode by default. The CLI forwards that policy to the daemon, which enforces the same conflict handling for CLI, typed client, and direct RPC requests.
- `--session-lock reject|strip` and `AGENT_DEVICE_SESSION_LOCK=reject|strip` remain available for explicit named-session automation. `strip` resolves conflicts by dropping platform and scope selectors (`--platform`, `--target`, `--ios-simulator-device-set`, `--android-device-allowlist`) only. A selector that names a *different device* than the lock — `--udid`, `--serial`, `--device` — is never dropped: the request fails with `INVALID_ARGS` naming both the requested and the bound device, because continuing would run the command against a device the caller did not select. Recover by closing the bound session if the requested device is the one you want, or by removing the selector if the bound device is.
- Direct RPC callers can pass `meta.lockPolicy` and optional `meta.lockPlatform` on `agent_device.command` requests for the same daemon-enforced behavior.
- In `batch`, steps that omit `platform` still inherit the parent batch `--platform`; lock-mode defaults do not override that parent setting.
- Tenant-scoped daemon runs can pass `--tenant`, `--session-isolation tenant`, `--run-id`, and `--lease-id` to enforce lease admission.
- Remote daemon clients can pass `--daemon-base-url http(s)://host:port[/base-path]` to skip local daemon discovery/startup and call a remote HTTP daemon directly.
- Use `--daemon-auth-token <token>` (or `AGENT_DEVICE_DAEMON_AUTH_TOKEN`) for explicit service/API-token automation against non-loopback remote daemon URLs; the client sends it in both the JSON-RPC request token and HTTP auth headers.
- Use [Remote Proxy](/docs/remote-proxy) when you need to run `agent-device proxy` on a Mac with simulator/device access and drive it from another machine through cloudflared, ngrok, or another HTTP tunnel.
- Use [BrowserStack](/docs/browserstack) or [AWS Device Farm](/docs/aws-device-farm) when a CI agent needs a hosted device session without interactive login.
- For human cloud access, `connect` can discover a cloud connection profile, while `connect --remote-config ...` uses a local profile. Both refresh a stored CLI session into a short-lived `adc_agent_...` token when needed. If no CLI session exists, interactive shells start login automatically; CI and non-interactive shells fail with API-token setup instructions. Use `--no-login` to disable implicit login. `AGENT_DEVICE_CLOUD_BASE_URL` is the bridge/control-plane API origin; its `/api-keys` route may redirect to the dashboard for token creation.
- For remote `connect` and `connect --remote-config` flows, see [Remote Metro workflow](#remote-metro-workflow).
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

The command uses the device from the admitted remote lease, installs a short-lived hold, keeps it
alive in the foreground, and releases it on Ctrl+C. Activation waits for admitted mutations to finish
before reporting active. While held, state-changing commands fail with
`DEVICE_IN_USE` and `details.reason: "human_control_active"`, explaining that agent interactions are
temporarily disabled. Snapshots, screenshots, selector reads, logs, and other read-only diagnostics
remain available. The hold also
protects an existing remote device lease from inactivity expiry so the human does not accidentally
hand the simulator to a different agent.

A foreground hold expires automatically if its process disappears. Releasing or expiring the final
hold refreshes the existing lease's inactivity window. Tenant commands can modify only holds owned
by their admitted lease, not provider-host administrative holds.

Holds do not survive daemon restart; reconnect and re-establish them before continuing human
interaction. Local takeover without a device-scoped remote lease is not supported in this version.
See [remote takeover and host administration](./remote-proxy.md#human-takeover) for the VM-side API.

## Web Automation

Minimal `--platform web` support reuses [agent-browser](https://github.com/vercel-labs/agent-browser). `agent-device` owns command/session/replay integration, refs/selectors, and artifact routing; `agent-browser` owns browser launch, page control, screenshots, and browser-specific mechanics.

Use `--platform web` when a browser step belongs inside an `agent-device` session, replay, batch, MCP, or typed-client flow. Use `agent-browser` directly for standalone web automation.

Set up and verify the managed web backend before relying on web sessions:

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

- Web automation uses a managed, pinned `agent-browser` backend as an implementation detail.
- Run `web setup` before first use and in CI bootstrap steps. Normal `--platform web` commands do not install the backend implicitly.
- Runtime web commands resolve the backend only from the managed install in the effective agent-device state dir.
- `web setup` is idempotent and reuses the pinned backend when it is already installed.
- `web doctor` verifies the managed backend after setup.
- The managed install respects `--state-dir` and `AGENT_DEVICE_STATE_DIR`.
- Web automation requires Node 24+.
- Supported through `agent-device`: URL open, snapshot refs, `get text/attrs`, `is visible/hidden/exists/absent/focused/text`, `find text/selector`, click/press, hover, fill/type, wait, `network dump`, `audio probe`, screenshot, close, and replay scripts composed from those commands.
- `hover <@ref|selector|x y>` moves the pointer without pressing so hover-gated UI (row toolbars, menus) appears. Add `--settle` to read what it revealed instead of taking another snapshot. `hover @ref` hovers the browser's own element handle; like `click @ref --settle`, the `--settle` diff needs a selector or coordinate target on web because web refs carry no geometry.
- `audio probe start [durationSeconds] [bucketMs]` samples HTML media elements into compact RMS/peak dBFS buckets while the page keeps running. The first timing positional is seconds; the second is milliseconds.
- URL-backed web media may be routed through the probe `AudioContext` while observed. Use `audio probe status` to poll partial buckets and `audio probe stop` to end the probe early.
- Out of scope for `agent-device` web support: tab/window/devtools control, network routing/interception/HAR, cookies/storage, downloads/uploads, arbitrary page scripting, multi-page orchestration, and raw browser diagnostics. Use `agent-browser` directly for those browser-specific workflows.

## Device isolation scopes

```bash
agent-device devices --platform ios --ios-simulator-device-set /tmp/tenant-a/simulators
agent-device devices --platform android --android-device-allowlist emulator-5554,device-1234
```

- `--ios-simulator-device-set <path>` constrains simulator discovery and simulator command execution via `xcrun simctl --set <path> ...`.
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
- `capabilities` reports the command names supported by the selected session device or an explicit `--platform`/`--device`/`--udid`/`--serial` target.
- In JSON output, `capabilities` returns `{ device, availableCommands }`. Use `availableCommands` for dynamic integrations instead of maintaining a separate platform support table.

### HarmonyOS command boundary

HarmonyOS support uses HDC and ArkUI `uitest`. On current API 24 devices it supports lifecycle and HAP deployment, ArkUI snapshot/screenshot and selector reads, one-pointer touch and text actions, keyboard `enter`/`dismiss`, app logs, foreground app state, process RSS samples, and `settings clear-app-state`. Run `agent-device capabilities --platform harmonyos` for the authoritative command list for a selected device.

- `gesture pan|fling|swipe` and `swipe` use HDC's single-pointer input primitives. Multi-touch gestures and target-authored `gesture drag` return `UNSUPPORTED_OPERATION` rather than approximating the interaction.
- Physical HarmonyOS devices support whole-screen recording through `record start <path> --scope device` or `--scope system`. This uses the device ScreenRecorder service, not HDC `screenrecord`; emulator recording is explicitly rejected. HarmonyOS recording does not support `--fps`, `--quality`, or `--hide-touches`.
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
- `--remote` runs the environment-only checks that do not require a booted device, which is what CI bootstrap and the packaged-CLI smoke use.
- `doctor` is read-only: it never boots, installs, or mutates the session device.

## Prepare Apple runner

```bash
agent-device prepare ios-runner --platform ios --timeout 240000
```

- `prepare ios-runner` is intended for Apple-platform CI setup before `snapshot`, `replay`, or `test`.
- Run it after the simulator/device is booted and the app is installed, but before the first snapshot, replay, or test command.
- It builds or reuses the local XCTest runner, starts a runner session, and verifies that the runner can answer a lightweight health command.
- In JSON output, top-level `buildMs`, `connectMs`, and `healthCheckMs` are diagnostic fields and may overlap; use `timing.additiveParts` for additive wall-clock phase totals. `connectMs` contains `buildMs` when a runner artifact is built or rebuilt.
- If health checking exposes a bad restored runner artifact, Agent Device marks that artifact bad and rebuilds once.
- If a fresh runner launch gets stuck before accepting connections, Agent Device invalidates that runner session and launches it once more without forcing a rebuild.
- CI may cache `~/.agent-device/apple-runner/derived` when the cache key includes the exact Agent Device package contents and selected Xcode version.
- Avoid broad `restore-keys` fallbacks for runner caches. Reusing runner artifacts across Agent Device or Xcode versions can restore stale `.xctestrun` products; `prepare ios-runner` already handles bad exact-cache artifacts and one retryable non-connecting runner launch.
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
- TV target selection supports Apple TV and Android TV simulators/emulators and connected devices. Initial Vega OS support is limited to the Vega Virtual Device.
- TV targets are focus-first. Use `tv-remote` to move D-pad/remote focus before selecting a control; avoid raw `adb shell input keyevent` in command plans.
- On Android TV, `tv-remote` maps to ADB keyevents. `tv-remote longpress <button>` is CLI sugar for a 500ms hold; `--duration-ms` overrides the preset and uses Android's longpress keyevent form for any positive duration because the platform command does not expose exact hold timing.
- tvOS supports the same runner-driven interaction/snapshot flow as iOS (`snapshot`, `wait`, `press`, `fill`, `get`, `scroll`, `back`, `home`, `app-switcher`, `record`, and related selector flows).
- On tvOS, `tv-remote`, runner `back`/`home`/`app-switcher` map to Siri Remote actions (`back` is Menu, `home` is Home, app switcher is double-home). `--duration-ms` is an exact remote-button hold duration.
- Vega OS discovery and remote input use the SDK-matched Vega CLI and VDA. Initial support is VVD-only; use `--platform vega --target tv`, and use Vega component IDs such as `com.example.app.main`.
- Use `--serial VirtualDevice` for explicit VVD selection.
- The Vega VVD supports app open/close, `back`, `home`, and all shared `tv-remote` buttons. Exact holds are sent through `inputd-cli`.
- Physical Fire TV, app inventory, snapshot, screenshot, selector, install, touch/text/gesture, logs, and performance backends are not part of the initial support and report unsupported.
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
- Use `frontmost-app`, `desktop`, and `menubar` when you need to inspect desktop-global UI before choosing one app.
- `open --platform macos --surface frontmost-app` inspects the currently focused app without naming it first.
- `open --platform macos --surface desktop` inspects visible windows across the desktop.
- `open --platform macos --surface menubar` inspects the active app menu bar and system menu extras.
- `open <app> --platform macos --surface menubar` targets one menu bar app's extras bar, which is useful for status-item apps.
- Status-item apps often expose little or no useful UI through the default macOS `app` surface. Prefer `--surface menubar` for discovery when the app lives in the top menu bar.
- Use `frontmost-app`, `desktop`, and `menubar` mainly for `snapshot`, `get`, `is`, and `wait`.
- If you inspect with `desktop` or `menubar` and then need to click or fill inside one app, open that app in a normal `app` session.
- macOS also supports `clipboard read|write`, `trigger-app-event`, `logs`, `network dump`, `audio probe`, `alert`, `settings appearance`, and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>`.
- `audio probe start 10 1000 --platform macos` samples host system audio through ScreenCaptureKit. The same host-system audio backend is used for iOS simulators and Android emulators on macOS hosts; grant Screen Recording permission before relying on it in a run.
- In macOS app sessions, `screenshot` captures the target app window bounds rather than the full desktop.
- Prefer selector or `@ref`-driven interactions on macOS. Window position can shift between runs, so raw x/y point commands are less stable than snapshot-derived targets.
- Use `click --button secondary` for context menus on macOS, then run `snapshot -i` again.
- Mobile-only helpers remain unsupported on macOS: `boot`, `shutdown`, `home`, `orientation`, `app-switcher`, `install`, `reinstall`, `install-from-source`, and `push`.

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
agent-device screenshot desktop.png --fullscreen
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
agent-device snapshot [--diff] [-i] [-d <depth>] [-s <scope>] [--raw] [--actions] [--force-full] [--timeout <ms>]
agent-device diff snapshot [-i] [-d <depth>] [-s <scope>] [--raw]
agent-device get text @e1
agent-device get attrs @e1
```

- iOS snapshots use XCTest on simulators and physical devices. iOS `--raw` is the acquired tree on
  whichever backend serves the capture: it keeps offscreen nodes, decorations, and structural
  wrappers the default and `-i` views fold away, so a recovered raw capture shows the same hierarchy
  a healthy one does. `--depth` still applies to raw (it counts traversal depth there), while `-i`
  narrows the default projection only — `--raw -i` returns the acquired tree.
- Android snapshots require the bundled Android snapshot helper. The first snapshot verifies and
  installs the helper APK if it is missing or outdated. Local ADB-backed sessions keep the helper
  process warm over an `adb forward` socket and report `androidSnapshot.helperTransport` as
  `persistent-session`; if that transport is unavailable, capture retries through one-shot
  instrumentation in the same helper. Set `AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION=0` to
  disable the persistent fast path. Missing or failed helper artifacts are reported directly; a
  source checkout must run `pnpm build:android` before Android verification. The helper serializes
  Android interactive window roots when available, so keyboard and system-overlay nodes can appear
  alongside the app root; `androidSnapshot.captureMode` and `androidSnapshot.windowCount` describe
  the capture. Default and `-i` snapshots keep same-window covered surfaces visible for diagnosis
  and mark exactly ordered covered controls `interactionBlocked: "covered"`, so selectors cannot
  act on stale React Native screens. API 23 cannot report sibling `drawing-order`, so this scan fails
  conservative and `androidSnapshot.occlusionScanUnavailable: true` discloses the difference.
  Android `--raw` is the acquired tree: it also keeps nodes Android marks invisible and stale
  application windows. The helper does not report `checked`/`selected` state, and it caps
  captures at 5000 nodes before any `--scope` applies (`truncated: true`).
- `--scope <text|@ref>` returns the subtree of the first node in document order whose label, value,
  or identifier contains the scope text (case-insensitive) and whose subtree still has content in
  the requested projection, re-rooted at depth 0; no match returns an empty snapshot rather than the
  full tree. Under `-i` that means scoping to a layout container returns the actionable elements
  inside it, even when the container itself is filtered out. `--depth` then counts from the scope
  root. `@ref` scopes by that element's label from the last snapshot. Android resolves scope inside
  its TypeScript presentation; iOS keeps acquisition broad and resolves scope once inside the
  runner's Swift presentation. The daemon does not reapply scope after either platform returns.
- `--actions` names the custom accessibility affordances an element merged away (iOS
  `UIAccessibilityCustomAction`, React Native `accessibilityActions`), so a card whose reply/options
  controls are not separate elements still lists them. It is iOS-simulator-only and exists for
  planning, not invocation: there is no API to trigger a named action, so reach the affordance
  through the element's detail screen, the same control exposed as a labeled element elsewhere, or
  coordinates from its rect. It is mutually exclusive with `--raw`, which takes a capture path that
  cannot carry custom actions: the pair is rejected as `INVALID_ARGS` before any device work. See
  [Snapshots](/docs/snapshots) for the full constraints.
- `diff snapshot` compares the current snapshot with the previous session baseline and then updates baseline.
- `snapshot --diff` is an alias for `diff snapshot`.
- Default snapshot text is an agent-facing, token-efficient view for planning and targeting actions. It may collapse helper/accessibility noise; use `--raw` or `--json` when you need the full provider tree.

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
- `wait <selector> [timeoutMs]` polls until the selector resolves or the timeout expires.
- `wait absent <selector> [timeoutMs]` polls until a complete, readable capture has zero matches. It is strict absence, not a visibility check: hidden or off-screen matches still keep the wait pending.
- Strict absence rejects `--scope` and `--depth`. Sparse, truncated, incomplete, and Android unreadable-content captures do not count as readable captures and cannot satisfy the wait; they are ridden out until the deadline, and a run with no valid capture preserves its typed unreadable diagnostic.
- `wait @ref [timeoutMs]` requires an existing session snapshot from a prior `snapshot` command.
- `wait @ref` resolves the ref to its label/text from that stored snapshot, then polls for that text; it does not track the original node identity.
- Because `wait @ref` is text-based after resolution, duplicate labels can match a different element than the original ref target.
- `wait` shares the selector/snapshot resolution flow used by `click`, `fill`, `get`, and `is`.
- Wait failures carry a structured `error.details.reason` in `--json` output: `wait_target_absent` proves a positive wait never found a match; `wait_target_present` means strict `wait absent` reached its deadline with valid captures that still contained matches; `predicate_failed` means strict `wait absent` could not prove absence because no valid capture arrived, with the final observation/diagnostic preserved; `wait_capture_stalled` means no readable capture arrived and is retriable; `wait_deadline_exceeded` means a later capture consumed the remaining budget after an earlier readable capture; `wait_landmark_identity_mismatch` is a replay destination-guard refusal; and `wait_stable_timeout` means the UI did not settle. Use `readableCaptures`, `waitedMs`, `matches`, and `firstMatch` instead of parsing error text. `firstMatch` carries identity/text evidence only; absence failures do not claim visibility or rect evidence.
- `alert` inspects or handles system alerts on iOS simulator, macOS desktop, and Android native/runtime permission dialogs.
- `alert` without an action is equivalent to `alert get`.
- Use `alert get` for an immediate cheap check. Use `alert wait <short-ms>` only when a prompt may appear after async work.
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
`type` accepts text only. Do not pass `@ref` to `type`; use `fill @ref "text"` to target a field directly, or `press @ref` then `type "text"` to append in the focused field.
If `type` reports `TEXT_INPUT_NOT_FOCUSED`, focus a visible text input and retry; when accessibility does not expose the input, use a coordinate focus command before typing.
On iOS, if `type` reports `TEXT_INPUT_SYNTHESIS_UNAVAILABLE` while the software keyboard is hidden, show the software keyboard, then retry `type` or `fill`. The runner reports this error instead of risking partial input through an unreliable text-entry path.
On iOS, if `type` or `fill` reports `TEXT_INPUT_COMMIT_NOT_OBSERVED`, the runner could not confirm the typed text reached the field — either it did not land before the runner's deadline, or the expected final text is identical to the field's placeholder. In the latter case, accessibility cannot distinguish committed text from an empty field rendering that placeholder, even if the field held content before dispatch. The field may hold none, part, or all of the text: run `snapshot -i` and inspect it. If it already matches, continue; otherwise retry with the full text quoted and `fill --delay-ms 80`, which replaces the whole value. Do not use `type`, which appends to whatever committed. This covers the bare-type route and the coordinate-driven `fill` route taken when the accessibility channel is under load, both of which observe the field after synthesizing; it is not a guarantee that every text-entry route verifies its result.
Use plain `fill` or `type` first for ordinary login and form fields. Use `--delay-ms` on `type` or `fill` only when a debounced search field or search-as-you-type input actually misses characters, or when the app must receive incremental updates.
Delayed typing intentionally prefers paced character entry over clipboard-style fallbacks so the target field receives each incremental update.
On Android, `fill` also verifies text and treats IME-owned capture as a terminal failure instead of retrying against the wrong field.
Android text entry is owned by `agent-device`: provider-native injection when available, then chunk-safe ASCII shell input. Do not switch to raw `adb`, clipboard, or paste as an agent fallback. If non-ASCII is unsupported in the current backend, report the tool/device gap.
`click --button secondary` is the desktop context-menu flow on macOS.
`click --button middle` is reserved for future runner support and currently returns an explicit unsupported-operation error on macOS.
`swipe` is a quick, fixed-duration directional throw. Use `gesture pan` for deliberate timed movement.
Neither `swipe` nor `gesture fling` takes a duration, and `gesture rotate` takes no velocity — see
[Migrating Gestures](/docs/migrating-gestures) if you have scripts or recordings that still pass one.
Repeated coordinate swipes accept at most 200 repetitions and 10000ms pauses, and their combined
gesture/pause schedule must fit within 60000ms.
`gesture pan` accepts `x y dx dy [durationMs]` for deliberate drags. It uses one pointer by default. Add `--pointer-count 2` for a parallel two-finger pan with constant contact span and angle; this shares the bounded two-contact synthesizer used by transform while retaining pan intent. Android preserves the requested travel duration; iOS uses XCTest drag primitives for one-pointer pan and private XCTest synthesis for two-pointer pan.
`gesture drag` accepts `source destination [sourceHoldMs] [moveMs] [destinationHoldMs]`, where each endpoint is a selector or a snapshot ref. It resolves both endpoints before dispatch and keeps one pointer down continuously through activation, movement, and the optional destination hold. Defaults are 800ms, 500ms, and 0ms; the combined gesture is capped at 10000ms. Recordings convert refs to selector chains so saved `.ad` scripts remain portable.
Target-authored drag is supported on Android touch devices and iOS/iPadOS. Backends that cannot preserve all three authored phases reject it before injection.
`gesture fling` accepts `up|down|left|right x y [distance]` for fast directional throws.
`gesture rotate` accepts `degrees [x] [y]`; the degree sign controls direction. Pacing is derived from the requested rotation.
`gesture transform` accepts `x y dx dy scale degrees [durationMs]` for one combined two-finger pan/zoom/rotate gesture on Android and iOS simulators. Pinch, rotate, two-finger pan, and transform use the same viewport-aware pointer planning; impossible paths fail before injection instead of clamping or distorting the requested motion.
On iOS simulators it uses private XCTest synthesis for a continuous two-finger pan/scale/rotation path, so verify app-level metrics instead of assuming the requested values map exactly to recognizer output.
On Android, `gesture transform` injects a geometric two-finger path. App recognizers may report non-exact pan, scale, and rotation values, so verify qualitative state such as `pan changed yes`, `pinch changed yes`, and `rotate changed yes` unless the app explicitly promises exact centroid metrics. If exact app-state values matter, prefer isolated `gesture pan`, `gesture pinch`, or `gesture rotate` commands.
`scroll` accepts either a relative amount (`0.5` means a finger path spanning half of the viewport on that axis) or `--pixels <n>` for a fixed-distance gesture. The final content offset can differ because apps apply pan-recognition thresholds, collapsing headers, bounds, and their own scroll physics. Large distances are clamped to the usable drag band so the gesture stays reliable across Android, iOS, and macOS.
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

## Find (semantic)

```bash
agent-device find "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find role button click
agent-device find "Follow" list
```

Actions: `click` (default; `press`/`tap` are aliases), `list`, `focus`, `fill`, `type`, `exists`, `wait`, `get text`, `get attrs`. `list` is read-only — it returns every match with its `@ref` and never taps, so use it to inspect before acting. Ambiguous matches are rejected with a candidates listing for text and selector queries alike; `--first`/`--last` opt into positional narrowing explicitly.

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
- `is exists` only checks whether the selector matches in the current snapshot.
- `is absent` passes only when the selector has zero matches in one readable, complete, unscoped, full-depth accessibility capture. It does not mean hidden; `--scope` and `--depth` are rejected, and sparse, unreadable, or truncated captures fail closed.
- `wait text` is a text-presence wait, not a hittability assertion.
- Strict `wait absent` is not exported to Maestro's lenient `notVisible` condition; Maestro export reports it as unsupported unless an exact zero-candidate primitive becomes available.
- `is text <selector> <value>` compares the resolved element text against the expected value.
- `is` does not accept snapshot refs like `@e3`; use a selector expression instead.
- `is` accepts the same selector-oriented snapshot flags as `click`, `fill`, `get`, and `wait`; `is absent` rejects `--scope` and `--depth` because its proof must cover the complete unscoped tree.

## Replay

```bash
agent-device open Settings --platform ios --session e2e --save-script [path]
agent-device replay ./session.ad      # Run deterministic replay from .ad script
agent-device test ./suite             # Run every .ad file in a folder or glob serially
agent-device test ./suite --timeout 60000 --retries 1
agent-device replay ./session.ad --from 4 --plan-digest <sha256>   # Execute step 4; if already completed, use the next safe index with this digest
agent-device replay ./session.ad --keep-session   # Suppress its terminal close and continue interactively
```

- `replay` runs deterministic `.ad` scripts.
- Script paths belong to the caller: `replay <path>` and `test <path-or-glob>` are resolved and read by the client, which sends the script content (and any Maestro `runFlow` includes) with the request. The same command therefore works against a local daemon and against a remote one (`AGENT_DEVICE_DAEMON_BASE_URL`) with no copy step, and a script missing on the calling machine fails immediately, naming the path you typed.
- `replay --keep-session` suppresses exactly an authored terminal `close` in native `.ad`; interior closes still run, and a close-less script is unchanged. The option is rejected by `test` and Maestro YAML.
- `test` runs one or more `.ad` scripts as a serial suite from files, directories, or glob inputs.
- `test --platform <platform>` filters suite files by `context platform=...` metadata instead of overriding the script target.
- `test --timeout <ms>` and `test --retries <n>` apply per script attempt; `context timeout=...` and `context retries=...` can be declared inside the `.ad` header. Retries are capped at `3`, duplicate metadata keys are rejected, and timeouts are cooperative.
- `test --artifacts-dir <path>` overrides the default suite artifact root at `.agent-device/test-artifacts`.
- `test` prints a short `Running replay suite...` line before dispatch, then streams one-line `pass`, `fail`, or `skip` progress on stderr as each suite entry finishes or retries. Each line includes current/total suite position and elapsed seconds such as `pass 3/6 ... duration=12.34s`. The final summary still prints failures and flaky passed-on-retry tests by default; add `--verbose` to print every final result.
- A failing step returns a `REPLAY_DIVERGENCE` report (screen digest, ranked selector suggestions, and a `resume` field); `replay --from <n> --plan-digest <sha256>` resumes at and executes plan step `n` without re-running `1..n-1`. If the failed action was completed manually, resume from the next safe plan index using the matching digest. `replay`-only; `test` rejects `--from`.
- `replay -u`/`--update` no longer rewrites the script (retired — see [Replay & E2E](/docs/replay-e2e)); it is a no-op kept for compatibility, since every divergence already carries the same ranked suggestions.
- `--save-script` records a replay script on `close`; optional path is a file path and parent directories are created. It writes on the daemon host, so it is rejected against a remote daemon.

See [Replay & E2E](/docs/replay-e2e) for recording, Maestro compatibility, and CI workflow details.

## Batch

```bash
agent-device batch --steps-file /tmp/batch-steps.json --json
agent-device batch --steps '[{"command":"open","input":{"app":"settings"}}]'
```

- `batch` runs a JSON array of steps in a single daemon request.
- Each step has `command`, `input`, and optional `runtime`.
- `input` uses the same fields as the matching MCP/Node command.
- Legacy CLI step payloads with `positionals`/`flags` were removed in 0.21. Use structured input such as `{"command":"open","input":{"app":"settings","platform":"ios"}}`.
- Unknown top-level step fields are rejected.
- Stop-on-first-error is the supported behavior (`--on-error stop`).
- Use `--max-steps <n>` to tighten per-request safety limits.
- Batch requests inherit the same daemon lock policy and session binding metadata as the parent command.
- In non-JSON mode, successful batches print a short per-step summary.

See [Batching](/docs/batching) for payload format, response shape, and usage guidelines.

## App install (in-place)

```bash
agent-device install com.example.app ./build/app.apk --platform android
agent-device install com.example.app ./build/MyApp.app --platform ios
```

- `install <app> <path>` installs from binary path without uninstalling first.
- Supports Android devices/emulators, iOS simulators, and CoreDevice-backed iOS physical devices. On xctrace-only devices, install the app with Xcode before opening it by bundle ID.
- Useful for upgrade flows where you want to keep existing app data when supported by the platform.
- Remote daemons automatically upload local app artifacts for `install`; prefix the path with `remote:` to use a daemon-side path verbatim.
- Supported binary formats: Android `.apk`/`.aab`, iOS `.app`/`.ipa`.
- `.aab` requires `bundletool` in `PATH`, or `AGENT_DEVICE_BUNDLETOOL_JAR=<absolute-path-to-bundletool-all.jar>` with `java` in `PATH`.
- `.aab` installs use bundletool `build-apks --mode universal`.
- `.ipa` installs by extracting `Payload/*.app`; if multiple app bundles exist, `<app>` is used as a bundle id/name hint to select one.

## App reinstall (fresh state)

```bash
agent-device reinstall com.example.app ./build/app.apk --platform android
agent-device reinstall com.example.app ./build/MyApp.app --platform ios
```

- `reinstall <app> <path>` uninstalls and installs in one command.
- Supports Android devices/emulators, iOS simulators, and CoreDevice-backed iOS physical devices. XCTest-backed xctrace-only devices do not expose install or app inventory operations.
- Useful for login/logout reset flows and deterministic test setup.
- Remote daemons automatically upload local app artifacts for `reinstall`; prefix the path with `remote:` to use a daemon-side path verbatim.
- Supported binary formats: Android `.apk`/`.aab`, iOS `.app`/`.ipa`.
- `.aab` accepts the same bundletool requirements as `install`.
- `.ipa` uses `<app>` as the selection hint when multiple `Payload/*.app` bundles are present.

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
- Trusted artifact service URLs may resolve to archives containing one installable `.apk`, `.aab`, `.ipa`, or iOS `.app` tar archive. Prefer `--github-actions-artifact` for GitHub Actions artifacts that a compatible remote daemon can resolve with its own credentials.
- Downloads resolve and approve every redirect destination, pin each connection to the approved address, reject HTTPS downgrades, and follow at most five redirects. Sensitive caller headers are not forwarded across origins.
- Downloaded artifacts are limited to 2 GiB compressed. Archive materialization is limited to 4 GiB expanded data, 100,000 entries, and three nested archive layers; links and special archive entries are rejected.
- Standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` configuration is honored without delegating destination DNS resolution to the proxy.
- `--retain-paths` keeps retained materialized artifact paths after install, and `--retention-ms <ms>` sets their TTL.
- URL downloads follow the same `installFromSource()` safety checks and host restrictions as the JS client API.

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
- This is app-hook-based simulation and does not inject OS-global notifications.

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
agent-device settings permission grant camera
agent-device settings permission deny microphone
agent-device settings permission grant photos limited
agent-device settings permission reset notifications
agent-device settings permission grant accessibility --platform macos
agent-device settings permission reset screen-recording --platform macos
```

- iOS `settings` support is simulator-only except for `settings appearance` and the macOS permission subset on macOS.
- macOS supports only `settings appearance <light|dark|toggle>` and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>`.
- `settings wifi|airplane|location|animations` remain intentionally unsupported on macOS.
- Android `settings animations off|on` toggles the global `window_animation_scale`, `transition_animation_scale`, and `animator_duration_scale` values. Use it as an opt-in stabilizer for automation runs with heavy system or app animations, then restore with `settings animations on` when needed.
- `settings appearance` maps to macOS appearance, iOS simulator appearance, and Android night mode.
- `settings location set <lat> <lon>` sets precise coordinates on iOS simulators and Android emulators.
- `settings clear-app-state [app-id]` clears the active session app data, or the provided app id. Android uses `pm clear`, which removes SharedPreferences, databases, files, and cache. iOS simulator removes the app data container contents. iOS physical devices and macOS are unsupported.
- Face ID and Touch ID controls are iOS simulator-only.
- Android `settings airplane on|off` is applied by the connectivity service (`cmd connectivity airplane-mode`, Android 11+), which drives the radios rather than only writing the `airplane_mode_on` setting. The response reports the `airplaneMode` that service holds after the change, and Android builds without that command fail without changing device state. Connectivity takes a moment to settle after the switch, so poll the app under test rather than asserting offline behavior immediately.
- Fingerprint simulation is supported on Android targets where `cmd fingerprint` or `adb emu finger` is available.
  On physical Android devices, only `cmd fingerprint` is attempted.
- Permission actions are scoped to the active session app.
- iOS permission targets: `camera`, `microphone`, `photos` (`full` or `limited`), `contacts`, `notifications`.
- Android permission targets: `camera`, `microphone`, `photos`, `contacts`, `notifications`.
- macOS permission targets: `accessibility`, `screen-recording`, `input-monitoring`.
- On macOS, `settings permission grant ...` checks/request access and opens System Settings guidance when needed; it does not silently grant TCC permissions.
- On macOS, `settings permission deny ...` is intentionally unsupported.
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
- iOS `appstate` is session-scoped and reports the app tracked by the active session on the target device.
- `apps` shows user-installed apps by default. Use `--all` when you need the full inventory, including system/OEM apps.

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
- Supported on macOS, Android emulator/device, and iOS simulator.
- iOS physical devices currently return `UNSUPPORTED_OPERATION` for clipboard commands.

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
- `perf frames` returns a focused, bounded frame/jank-health JSON blob.
- `perf memory sample` returns a compact memory-only JSON blob for agents investigating growth/leaks without collecting a large artifact. It is better than raw memory command output for first-pass diagnosis because arrays and top offenders are bounded.
- Example sample shape: `{"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}`.
- `perf memory snapshot` writes a heap/memgraph artifact to disk and returns path, size, kind, method, and support metadata. Large artifacts are never dumped into CLI/MCP/default JSON output.
- Example default snapshot output: `Memory artifact (android-hprof): /tmp/app.hprof (42MB)`.
- `cdp` targets React Native JavaScript heap evidence through Metro CDP. Use it for JS heap usage samples and heap snapshots; use `perf memory sample` and `perf memory snapshot` for native/process memory. See [Debugging & Profiling](/docs/debugging-profiling) for the bounded leak workflow.
- `perf cpu profile ... --kind xctrace` records an Apple `.trace` with the requested xctrace template. `report` aggregates every run, writes compact JSON with at most ten weighted top self-time functions, and prints at most five while the raw trace stays on disk.
- `perf trace ... --kind xctrace` records an Apple `.trace` such as Animation Hitches for native diagnosis.
- xctrace perf commands return artifact paths and compact metadata only; inspect `.trace` files in Instruments/Xcode instead of dumping trace contents into agent context.
- `perf cpu profile ... --kind simpleperf` starts/stops Android native CPU profiling for the active session package. Its report artifact keeps up to 50 parsed rows, while the response returns at most ten top functions and the CLI prints at most five.
- `perf trace ... --kind perfetto` starts/stops Android Perfetto trace capture for the active session package.
- Native profile/trace outputs are compact agent evidence: state, artifact path, size, and method. Raw `.perf.data` and `.perfetto-trace` contents stay on disk.
- Without `--json`, each explicit perf area prints a compact focused summary.
- App startup duration is measured by `open` and returned in `open`'s `startup` result. Use that result directly instead of the removed aggregate perf form.
- Use native perf stop/report results as compact agent evidence, not raw profiler output. A successful Perfetto stop can return `state: "stopped"`, `outPath: "/tmp/app.perfetto-trace"`, `sizeBytes: 5392410`, and `method: "adb-shell-perfetto"` while the 5.3 MB raw trace stays on disk as the artifact.
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
  - `perf memory trace --kind heapprofd`: deferred until Android Perfetto/heapprofd plumbing is available.
  - `perf cpu profile --kind xctrace`: iOS simulator app sessions, connected iOS device app sessions where xctrace can attach to the active process, and macOS app sessions when the app process can be resolved from the bundle ID.
  - `perf trace --kind xctrace`: iOS simulator app sessions, connected iOS device app sessions where xctrace can attach to the active process, and macOS app sessions when the selected xctrace template supports the target.
  - Android native profiling is not implemented under Apple xctrace perf; Android profiling is tracked separately.
- HarmonyOS performance evidence is memory-only on the current public HDC surface: CPU profiling, frame sampling, and memory-snapshot artifacts are unavailable.
- Android URL/deep-link opens infer the foreground package after launch when possible, including Expo Go/dev-client shells. If the session still has no app package/bundle ID, package-bound metrics remain unavailable until you `open <app>`.
- Android frame health is reset after each successful `perf frames` read and after `open <app>`, so run `perf frames`, perform the interaction, then run `perf frames` again for a focused window.
- Android Simpleperf and Perfetto collectors require an active Android app session with a running package process. They return artifact paths, sizes, and compact state summaries; they do not print profile or trace contents into the agent context. iOS native Simpleperf/Perfetto support is not provided by these commands.
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

- `react-devtools` dynamically runs pinned `agent-react-devtools@0.4.0` through npm and passes arguments through 1:1.
- The first run may download the pinned package from npm; later runs can reuse the npm cache.
- `agent-device` global flags work before or after `react-devtools`. Use `--` before downstream flags only when they intentionally share an `agent-device` global flag name.
- Use it when a React Native workflow needs component hierarchy, props, state, hooks, render causes, slow components, or re-render counts.
- For profiling, keep the window narrow and make one bounded first-pass survey: use the `profile stop` summary, run `profile slow --limit 5` and `profile rerenders --limit 5` once, add `profile timeline --limit 20` only when commit timing matters, then drill into a specific `@c` ref with `profile report`.
- Do not repeatedly raise broad `profile slow` limits such as `--limit 50`, `--limit 200`, or `--limit 500` unless you have a specific target that needs more rows.
- Keep using `snapshot`, `press`, `fill`, `logs`, `network`, `audio probe`, `perf frames`, and `perf memory` for device/app runtime evidence. Use `react-devtools` for React internals.
- For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, start with `agent-device help react-native`.
- On Android, use `alert get`, `alert wait <short-ms>`, `alert accept`, and `alert dismiss` for runtime permission prompts and native alerts. On iOS, use the same alert commands for XCTest alerts, app-owned modal popups with native blocking markers, and blocking system dialogs. Do not use `settings permission` to answer a dialog already on screen; reserve it for setup or resetting permission state before a flow.
- React Native development builds can connect to the DevTools daemon on port 8097. For Android emulators or physical devices, run `adb reverse tcp:8097 tcp:8097` if the app cannot reach the host.
- Direct Android `open` URL targets for local Metro hosts with a port auto-configure host reachability. For app/package launches or unsupported flows, run `adb reverse tcp:8081 tcp:8081` if the app cannot reach local Metro.
- For Android and iOS sessions connected through a remote bridge profile, `react-devtools` registers a lease-scoped companion tunnel to the sandbox-local DevTools daemon at `127.0.0.1:8097`. Android bridge profiles use the bridge-owned remote `adb reverse` mapping; iOS bridge profiles use the bridge-owned wildcard Metro host tunnel. The CLI keeps the companion alive until `agent-device react-devtools stop` or `agent-device disconnect`.
- For remote iOS bridge sessions, open the app once to create the bridge session, run `agent-device react-devtools start`, then relaunch the same bundle id with `agent-device open <bundle-id> --platform ios --relaunch` before `wait --connected`. React Native attempts the legacy DevTools websocket during JavaScript startup, so starting DevTools after the first launch can miss that connection attempt.
- Remote bridge React DevTools assumes the React Native-bundled DevTools behavior in React Native 0.83+. Older browser/Chromium DevTools workflows are not assumed to exist inside remote sandboxes. Expo projects should be verified against the SDK's bundled React Native version before relying on this path; this release does not claim a separately verified Expo SDK version.
- For cross-platform validation with explicit target selectors, use separate sessions/devices and restart `react-devtools` between iOS and Android runs.

```bash
agent-device react-native dismiss-overlay
agent-device react-native dismiss-overlay --platform android
```

- `react-native dismiss-overlay` clears a React Native development overlay (a redbox/LogBox error or a collapsed warning banner) that is blocking interaction, then returns without changing app state otherwise.
- Use it when a snapshot or interaction is blocked by a dev-only overlay; it is a no-op when no overlay is present.
- It is supported on iOS simulators/devices and Android emulators/devices; `react-native` currently exposes only the `dismiss-overlay` helper.

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
- On iOS simulators, `open` writes React Native's per-simulator debug server settings before launching, so `rn-a` can use port `8081` while `rn-b` uses port `8082`. `open`'s `--metro-host`/`--metro-port` also bind each session's dev server, so a later flagless `metro reload --session rn-a` reloads the port `8081` server and `--session rn-b` reloads `8082` — no need to repeat the flags.
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
- Pass `--metro-host`, `--metro-port`, or `--bundle-url` when you need to target a specific Metro instance for one call; explicit flags override the session binding.
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
agent-device diff screenshot --baseline baseline.png --out diff.png --overlay-refs
agent-device record start               # Start app-scoped recording after open <app>
agent-device record start session.mp4   # Start app-scoped recording to explicit path
agent-device record start session.mp4 --scope device  # Intentionally record the full simulator/device screen
agent-device record start session.mp4 --fps 30  # Override iOS device runner FPS
agent-device record start session.mp4 --quality high # Higher-quality export (slower)
agent-device record stop                # Stop active recording
```

- Recordings always produce a video artifact. `record start` defaults to app scope and requires an active session from `open <app>`; use `--scope device` or `--scope system` to explicitly request whole-screen capture where the selected backend supports it, such as recordings that intentionally span the full screen, multiple apps, settings, home screen, or app transitions. When touch visualization is enabled, recordings also produce a gesture telemetry sidecar that can be used for post-processing or inspection.
- `screenshot --scale <factor>` proportionally resizes both dimensions. The accepted range is `0.01` through `1`; use `1` for full resolution. The former `--max-size <px>` flag was removed and is refused with migration guidance wherever it appears (CLI, `.ad` scripts, Node options, config, and the retired `AGENT_DEVICE_SCREENSHOT_MAX_SIZE` env var).
- Set `AGENT_DEVICE_SCREENSHOT_SCALE=0.3` (or `screenshotScale` in config) as a token-conscious screenshot default for agent workflows. An explicit `--scale` overrides it.
- Keep the scale default unset, or use `--scale 1`, when full-resolution screenshots are required for reusable pixel-diff baselines.
- `screenshot --overlay-refs` captures a fresh full snapshot and burns visible `@eN` refs plus their target rectangles into the saved PNG.
- `screenshot --crop-on <selector>` captures a fresh full snapshot of the same screen and crops the saved PNG to the frame the selector resolves to. The selector must resolve to exactly one framed node; the result carries a `warnings` entry when the frame is clipped to the image. Currently accepted on iOS simulators and Android emulators — every other target is refused before any device work, and the flag cannot be combined with `--overlay-refs` or `--fullscreen` because both move the captured frame away from the snapshot viewport the crop is measured against.
- `screenshot --normalize-status-bar` temporarily normalizes iOS simulator status-bar chrome for deterministic screenshot baselines; ordinary screenshots leave the simulator's current chrome visible.
- `screenshot --scale <factor> --overlay-refs` writes a smaller image and draws refs for that final image size; avoid very small scales when text, icons, or labels need to remain readable.
- `diff screenshot` compares the current live screenshot to `--baseline`, or compares `--baseline` to an optional saved `current.png` path without requiring an active session. Its text output reports ranked changed regions with screen-space rectangles, changed-pixel counts, and each region's share of the diff; JSON also includes normalized rectangles. The earlier best-effort `ocr` and `nonTextDeltas` analyzers are retired; their optional result fields remain for source compatibility but are no longer emitted, so use the baseline/current images and diff artifact with vision for qualitative interpretation. It writes a diff PNG with a light grayscale current-screen context, red-tinted changed pixels, and outlined changed regions when `--out` is provided. Live iOS simulator diffs normalize status-bar chrome by default; use `screenshot --normalize-status-bar` when capturing reusable baselines.
- `diff screenshot --overlay-refs` additionally writes a separate current-screen overlay guide for live captures without using that annotated image for the pixel comparison. If current-screen refs intersect changed regions, the output lists the best ref matches under those regions. Saved-image comparisons do not have live accessibility refs, so `--overlay-refs` is unavailable when a `current.png` path is provided.
- In `--json` mode, each overlay ref also includes a screenshot-space `center` point for coordinate fallback like `press <x> <y>`.
- Burned-in touch overlays are exported only on macOS hosts, because the overlay pipeline depends on Swift + AVFoundation helpers.
- On Linux or other non-macOS hosts, `record stop` still succeeds and returns the raw video plus telemetry sidecar, and includes `overlayWarning` when burn-in overlays were skipped.
- Android uses `adb shell screenrecord`, which has a 180s platform limit. `record start` publishes a durable device manifest. Longer recordings are split into MP4 chunks while the daemon stays alive; after daemon restart, `record stop` recovers only manifest-owned chunks and warns when gesture overlay telemetry was lost.

**Session app logs (token-efficient debugging):** Logging is off by default in normal flows. Enable it on demand for debugging. Logs are written to a file so agents can grep instead of loading full output into context.

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
- Preferred debug entrypoint: `logs clear --restart` for clean-window repro loops.
- `logs start` appends to `app.log` and rotates to `app.log.1` when the file exceeds 5 MB.
- `open` prints `Session state: <path>` and JSON includes `sessionStateDir`, `runnerLogPath`, `requestLogPath`, and `eventLogPath`. Use the session directory to inspect concurrent runs without parsing global daemon logs.
- `events.ndjson` contains the session event timeline; `requests/<request-id>.ndjson` contains daemon request diagnostics; `runner.log` contains Apple runner and `xcodebuild` output.
- `events.ndjson` rotates to `events.ndjson.1` when it exceeds 5 MB (`AGENT_DEVICE_EVENT_LOG_MAX_BYTES` overrides, in whole bytes); one rotated generation is kept. `events` cursors stay absolute across rotation, so `nextCursor` still resumes; a cursor older than the retained window fails with `COMMAND_FAILED` and `details.reason: "EVENT_LOG_CURSOR_EXPIRED"`, with `details.earliestCursor` naming the oldest cursor that still resolves. If the retained files and their window record disagree — a hand-deleted generation, an edited file, a corrupt `events.ndjson.window.json` — `events` fails with `details.reason: "EVENT_LOG_WINDOW_UNVERIFIED"` rather than answering from a guessed offset; appends continue regardless.
- Event timeline entries preserve command names, status, durations, bounded device/app inventory previews, lifecycle outcomes, artifact basenames, and structural action details such as scroll distance/direction, safe refs, and coordinates. User-entered text, clipboard contents, push/event payloads, selector values, free-form flags/messages/paths, and raw unknown command arguments are omitted or replaced with content-free placeholders. `--no-record` suppresses `action.recorded` entries, but request start/finish entries still record command/status/timing.
- `network dump [limit] [summary|headers|body|all]` parses recent HTTP(s) entries from `app.log` for app/device sessions and from managed `agent-browser` request history for web sessions; `network log ...` is an alias.
- Prefer `--include headers|body|all` when you want explicit detail level without relying on positional ordering.
- On macOS, `logs` and `network dump` are app-scoped and parse Unified Logging output associated with the active session app.
- Network dump limits: scans up to 4000 recent log lines, returns up to 200 entries, and truncates payload/header fields at 2048 characters.
- On web, `network dump` uses `agent-browser network requests`; request/response bodies are not exposed by that backend path, so use direct `agent-browser` HAR workflows for browser-specific body capture.
- Android `network dump` also surfaces logcat timestamps and can backfill status and duration from adjacent GIBSDK packet lines when the URL is logged separately.
- Android log streaming automatically rebinds to the app PID after process restarts.
- iOS simulator log capture now streams from inside the simulator with `simctl spawn <udid> log ...`, and `network dump` can recover recent simulator log history with `simctl log show` when the live app-log window is sparse.
- iOS log capture still relies on Unified Logging signals (for example `os_log`); plain stdout/stderr output may be limited depending on app/runtime.
- On iOS, `network dump` can return zero HTTP entries for real app activity when the app does not emit request metadata into Unified Logging. The response notes now distinguish between an empty repro window and a non-network app log window.
- Retention knobs: set `AGENT_DEVICE_APP_LOG_MAX_BYTES` and `AGENT_DEVICE_APP_LOG_MAX_FILES` to override rotation limits.
- Optional write-time redaction patterns: set `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` to a comma-separated regex list.

**Crash symbols (bounded local symbolication):** Use `debug symbols` when you already have an Apple crash artifact and local dSYMs and need the failing code path. The command matches crash Binary Images / IPS `usedImages` UUIDs to `dwarfdump --uuid` output, runs `atos`, writes a symbolicated artifact, and prints only the output path plus a compact crash report with app/thread, exception or termination, top symbolicated frames, and the first actionable frame finding. This is better than pasting raw crash logs because the agent sees the diagnosis and artifact path without ingesting the full crash body.

Crash routing: use `logs` for the lead-up timeline, `debug symbols` for a failing frame from `crash.ips`/`crash.log` plus matching dSYMs, and Xcode/LLDB for live state, breakpoints, variables, memory, or stepping.

```bash
agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
```

- `debug` is intentionally narrow: do not use it for app logs, network/audio evidence, performance samples, recordings, traces, or React Native internals.
- Android Java/R8 `mapping.txt` and native `ndk-stack`/`addr2line` symbolication are deferred; capture Android crash evidence with `logs` and symbolicate externally for now.
- The crash artifact body is written to `--out`; it is not dumped into agent context or default JSON.

**Grepping app logs:** Use `logs path` to get the file path, then run `grep` (or `grep -E`) on that path so only matching lines enter context—keeping token use low.

```bash
# Get path first (e.g. ~/.agent-device/sessions/default/app.log)
agent-device logs path

# Then grep the path; -n adds line numbers for reference
grep -n "Error\|Exception\|Fatal" ~/.agent-device/sessions/default/app.log
grep -n -E "Error|Exception|Fatal|crash" ~/.agent-device/sessions/default/app.log
grep -n -E "agent-device.*mark|before submit" ~/.agent-device/sessions/default/app.log

# Last 50 lines only (bounded context)
tail -50 ~/.agent-device/sessions/default/app.log
```

- Use `-n` to include line numbers. Use `-E` for extended regex and `|` without escaping in the pattern.
- Prefer targeted patterns (e.g. `Error`, `Exception`, your log tags) over reading the whole file.
- `logs mark "before submit"` lines are prefixed with `[agent-device][mark][...]`, so grep for `agent-device.*mark` when you need timing markers back quickly.

- iOS `record` works on simulators and CoreDevice-backed physical devices.
- iOS simulator recording uses native `simctl io ... recordVideo`.
- Physical iOS device capture is runner-based and built from repeated `XCUIScreen.main.screenshot()` frames (no native video stream/audio capture).
- App-scoped recording requires an active app session context (`open <app>` first). Use `--scope device`/`--scope system` only when whole-screen capture is the intended artifact.
- Physical iOS device capture is best-effort: dropped frames are expected and true 60 FPS is not guaranteed even with `--fps 60`.
- Physical-device capture defaults to 15 FPS.
- `--fps <n>` (1-120) applies to physical iOS device recording as an explicit FPS cap.
- `--quality <medium|high>` controls recording output quality. Android maps it to `adb shell screenrecord --bit-rate`; Apple targets use it for export/encoding. `medium` is the default; pass `high` for evidence, release notes, or debugging visual artifacts. Legacy numeric values are still accepted for compatibility: `5`-`7` map to `medium`, and `8`-`10` map to `high`.

## Tracing

```bash
agent-device trace start
agent-device trace start session.trace
agent-device trace stop
agent-device trace stop session.trace
```

- `trace start [path]` begins trace-log capture for the active session.
- `trace stop [path]` stops capture and optionally writes or finalizes the trace artifact at the provided path.
- `trace` is intended for lower-level session diagnostics than `record` or `logs`.

## Remote Metro workflow

When the cloud control plane owns the connection profile, connect can discover it directly:

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
- Cloud connection profile responses must return a JSON object at `connection.remoteConfigProfile`. The older `connection.remoteConfig` JSON string shape is no longer accepted.
- `--remote-config <path>` points to a local remote workflow profile that captures stable host, tenant/run, and any optional session, platform, lease backend, or Metro overrides for `connect`.
- `connect --remote-config ...` follows the same verification, state, and deferred-preparation flow using the local profile instead of cloud discovery. Direct-provider profiles therefore require their provider credentials when `connect` runs; no device lease is created until a later device command.
- Auth management commands are available for inspection and recovery: `agent-device auth status`, `agent-device auth login`, and `agent-device auth logout`. Human login stores a revocable CLI session locally; it does not create or persist an `adc_live_...` service token.
- Cloud auth uses three credential classes: `adc_agent_...` short-lived command tokens, revocable CLI session refresh credentials, and explicit `adc_live_...` service/API tokens for CI. The CLI implements credential selection, CI refusal, local storage permissions, logout, and output redaction; the cloud API must enforce token expiry, tenant/run scope, revocation, one-time device approval, polling rate limits, and dashboard/API separation.
- `AGENT_DEVICE_CLOUD_BASE_URL` should point at the bridge/control-plane API origin, not necessarily the dashboard origin. API-token setup links use `/api-keys` on that origin so the bridge can redirect users to the right dashboard page.
- Deferred Metro preparation also applies to `batch` when any step opens an app and the batch does not provide its own per-step runtime.
- `connect` without `--session` always creates a fresh remote session. Its human and JSON next steps include the generated `--session`; concurrent processes must preserve that value on every command so they cannot adopt another process's ambient connection. The active connection fallback remains a convenience for one sequential workflow only. To replace a connection, pass its returned session explicitly with `--session <name> --force`; `--force` without a session creates another connection without overwriting or releasing the previous one.
- After `connect`, `install-from-source`, `open`, `snapshot`, `devices`, `press`, `fill`, `screenshot`, and other normal commands can reuse active connection state in a single sequential workflow so agents do not repeat remote host/session/lease selectors inline. If `connection status` shows `leaseId=pending`, the first platform-bound command allocates or refreshes the lease. Passing the same `--remote-config` to a normal command is also supported for self-contained scripts; the CLI reuses matching saved state or creates it before dispatch.
- Self-contained remote scripts should end with `disconnect --remote-config <path>` or `disconnect` to release the lease and stop the owned Metro companion.
- Explicit command-line flags override connected defaults. When `open` uses explicit remote daemon or tenant flags without saved runtime hints, the CLI warns because React Native apps may launch without Metro bundle/runtime hints.
- `metroProxyBaseUrl` is the bridge origin. Do not prebuild `/api/metro/...` paths in the client profile; the CLI calls the bridge endpoints itself.
- For cloud stock React Native iOS, the bridge descriptor supplies direct wildcard HTTPS Metro hints such as `<runtime>.metro.agent-device.dev:443`. The XCTest runner package is still used for runner-backed device commands, not for Metro reachability.
- Android keeps using bridge-provided runtime routes such as `/api/metro/runtimes/<runtimeId>/...`.
- `metroPublicBaseUrl` is only needed for direct/non-bridge bundle hints. Bridged profiles can omit it and rely on `metroProxyBaseUrl`.
- `metro prepare --remote-config ...` remains an advanced inspection/debug path and can still write a `--runtime-file <path>` artifact when needed.
- The local Metro companion runs on the same machine as the React Native project and Metro. `disconnect` stops the companion owned by the connection, but it does not stop the user’s Metro server.

### Cloud profile response migration

`/api/control-plane/connection-profile` must return an object at `connection.remoteConfigProfile`, for example `{"connection":{"remoteConfigProfile":{"daemonBaseUrl":"https://bridge.example.com/agent-device","daemonTransport":"http","tenant":"acme","runId":"run-123"}}}`. The old `connection.remoteConfig` JSON-string wrapper is rejected.

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
- Historical lookup requires `--provider-session <id>` and `--provider <name>`. BrowserStack uses `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY`. AWS Device Farm uses the AWS CLI credential chain and infers the region from the session ARN when possible. See [BrowserStack](/docs/browserstack) and [AWS Device Farm](/docs/aws-device-farm) for CI credential setup.
- When a cloud runtime is registered in-process by an embedding host, `artifacts` can infer the active provider session from the current lease before disconnect.
- `disconnect --json` and `close --json` include provider release data when the runtime returns final cloud artifacts after session teardown. Some providers only finalize video/log URLs after the remote session is stopped, so retry `agent-device artifacts <provider-session-id> --provider <name> --json` if the first response is `pending`.

## iOS physical-device prerequisites

For CLI-discoverable setup guidance, run `agent-device help physical-device`.

- Xcode with `xcrun devicectl` and `xcrun xctrace` available.
- Paired/trusted physical device, connected, unlocked when needed, with Developer Mode enabled.
- Older devices discovered only through `xctrace` use the XCTest backend automatically; its runner commands travel through macOS `usbmuxd`, so keep the device connected by cable.
- XCTest-backed devices support open/close, interactions, snapshots, and screenshots. App inventory, install/reinstall, logs, performance sampling, recording, deep links, and launch arguments require CoreDevice.
- The `AgentDeviceRunner` XCTest host must be signed before commands can run on a physical device.
- Start with Automatic Signing and only these env vars:
  - `AGENT_DEVICE_IOS_TEAM_ID`
  - `AGENT_DEVICE_IOS_BUNDLE_ID` (runner bundle-id base; tests use `<id>.uitests`)
- Find team ids and Apple Development signing certificates with `security find-identity -v -p codesigning`.
- If Xcode cannot choose a profile, set `AGENT_DEVICE_IOS_PROVISIONING_PROFILE` to the profile name/specifier, not a file path.
- `AGENT_DEVICE_IOS_SIGNING_IDENTITY` is optional; omit it unless `xcodebuild` asks for a specific identity.
- The profile/team must allow `AGENT_DEVICE_IOS_BUNDLE_ID` and `<id>.uitests`.
- First-run XCTest setup/build can take longer than normal commands; keep the device connected and use `--debug` to inspect signing/build diagnostics if setup times out.
- If you override the iOS runner derived-data path and also force cleanup, keep `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` under the project `.tmp/` directory. Other cleanup override paths are rejected with a recovery hint.
- For daemon startup troubleshooting:
  - follow stale metadata hints for `<state-dir>/daemon.json` and `<state-dir>/daemon.lock` (`state-dir` defaults to `~/.agent-device` for packaged installs, or a worktree-scoped dir under `~/.agent-device/dev/` from source)

## iOS SpringBoard, widgets, and system-UI surfaces

For CLI-discoverable workflow guidance, run `agent-device help ios-system-ui`.

- `agent-device open com.apple.springboard --platform ios` binds the session to SpringBoard today; this is verified on iOS simulator only. Physical-iPhone SpringBoard support is not yet verified — see [#1296](https://github.com/callstack/agent-device/issues/1296).
- The full widget add/edit/remove flow is selector-driven from a fresh `snapshot -i`, except two coordinate-based steps: the empty-space long-press that enters edit mode, and (until fixed) the widget-gallery search-result rows, which currently return unlabeled accessibility nodes.
- SpringBoard labels vary by iOS version and locale; discover them from the current snapshot rather than hard-coding strings like `Edit` or `Add Widget`.
- Reopen the app bundle under test to return to normal app automation after a SpringBoard step.
