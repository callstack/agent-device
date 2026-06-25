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
agent-device rotate portrait
agent-device rotate landscape-left
agent-device app-switcher
```

- `boot` ensures the selected target is ready without launching an app.
- `boot` requires either an active session or an explicit device selector.
- `shutdown` turns off the selected Apple simulator or Android emulator.
- `shutdown` must not target an active session device; use `close --shutdown` to end the session and turn it off.
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
- `rotate <orientation>` forces a mobile device into `portrait`, `portrait-upside-down`, `landscape-left`, or `landscape-right`.
- `rotate` is supported on iOS and Android mobile targets. macOS and tvOS do not expose it.
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom scheme URLs require an active app in the session.
- Commands that omit `--session` use an implicit `default` session scoped to the caller's current git worktree or working directory. This keeps independent local agents from accidentally attaching to each other's default session.
- `--session <name>` or `AGENT_DEVICE_SESSION` opt into an explicitly named session when a script intentionally wants to share or reuse that session name.
- A configured `AGENT_DEVICE_SESSION` implies bound-session lock mode by default. The CLI forwards that policy to the daemon, which enforces the same conflict handling for CLI, typed client, and direct RPC requests.
- `--session-lock reject|strip` and `AGENT_DEVICE_SESSION_LOCK=reject|strip` remain available for explicit named-session automation. Older lock aliases remain accepted for compatibility.
- Direct RPC callers can pass `meta.lockPolicy` and optional `meta.lockPlatform` on `agent_device.command` requests for the same daemon-enforced behavior.
- In `batch`, steps that omit `platform` still inherit the parent batch `--platform`; lock-mode defaults do not override that parent setting.
- Tenant-scoped daemon runs can pass `--tenant`, `--session-isolation tenant`, `--run-id`, and `--lease-id` to enforce lease admission.
- Remote daemon clients can pass `--daemon-base-url http(s)://host:port[/base-path]` to skip local daemon discovery/startup and call a remote HTTP daemon directly.
- Use `--daemon-auth-token <token>` (or `AGENT_DEVICE_DAEMON_AUTH_TOKEN`) for explicit service/API-token automation against non-loopback remote daemon URLs; the client sends it in both the JSON-RPC request token and HTTP auth headers.
- Use [Remote Proxy](/docs/remote-proxy) when you need to run `agent-device proxy` on a Mac with simulator/device access and drive it from another machine through cloudflared, ngrok, or another HTTP tunnel.
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
agent-device fill @e13 "test@example.com" --platform web
agent-device wait text "Welcome" --platform web
agent-device network dump 25 --include headers --platform web
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
- Supported through `agent-device`: URL open, snapshot refs, `get text/attrs`, `is visible/exists/text`, `find text/selector`, click/press, fill/type, wait, `network dump`, screenshot, close, and replay scripts composed from those commands.
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
agent-device devices --platform ios --ios-simulator-device-set /tmp/tenant-a/simulators
agent-device devices --platform android --android-device-allowlist emulator-5554,device-1234
```

- `devices` lists available targets after applying any platform selector or isolation scope flags.
- Use `--platform` to narrow discovery to Apple-family (`ios`, `tvOS`, `macOS`) or Android targets.
- Use `--ios-simulator-device-set` and `--android-device-allowlist` when you need tenant- or lab-scoped discovery.

## Prepare Apple runner

```bash
agent-device prepare ios-runner --platform ios --timeout 240000
```

- `prepare ios-runner` is intended for Apple-platform CI setup before `snapshot`, `replay`, or `test`.
- Run it after the simulator/device is booted and the app is installed, but before the first snapshot, replay, or test command.
- It builds or reuses the local XCTest runner, starts a runner session, and verifies that the runner can answer a lightweight health command.
- If health checking exposes a bad restored runner artifact, Agent Device marks that artifact bad and rebuilds once.
- If a fresh runner launch gets stuck before accepting connections, Agent Device invalidates that runner session and launches it once more without forcing a rebuild.
- CI may cache `~/.agent-device/ios-runner/derived` when the cache key includes the exact Agent Device package contents and selected Xcode version.
- Avoid broad `restore-keys` fallbacks for runner caches. Reusing runner artifacts across Agent Device or Xcode versions can restore stale `.xctestrun` products; `prepare ios-runner` already handles bad exact-cache artifacts and one retryable non-connecting runner launch.
- Runner build/start output is written to the session's `runner.log`. The top-level `daemon.log` is reserved for daemon lifecycle/startup issues.

## TV targets

```bash
agent-device open YouTube --platform android --target tv
agent-device apps --platform android --target tv
agent-device open Settings --platform ios --target tv
agent-device screenshot apple-tv.png --platform ios --target tv
```

- AndroidTV app launch and app listing resolve TV launchable activities via `LEANBACK_LAUNCHER`.
- TV target selection supports both simulator/emulator and connected physical devices (AppleTV + AndroidTV).
- tvOS supports the same runner-driven interaction/snapshot flow as iOS (`snapshot`, `wait`, `press`, `fill`, `get`, `scroll`, `back`, `home`, `app-switcher`, `record`, and related selector flows).
- On tvOS, runner `back`/`home`/`app-switcher` map to Siri Remote actions (`menu`, `home`, double-home).
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
- macOS also supports `clipboard read|write`, `trigger-app-event`, `logs`, `network dump`, `alert`, `settings appearance`, and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>`.
- In macOS app sessions, `screenshot` captures the target app window bounds rather than the full desktop.
- Prefer selector or `@ref`-driven interactions on macOS. Window position can shift between runs, so raw x/y point commands are less stable than snapshot-derived targets.
- Use `click --button secondary` for context menus on macOS, then run `snapshot -i` again.
- Mobile-only helpers remain unsupported on macOS: `boot`, `shutdown`, `home`, `rotate`, `app-switcher`, `install`, `reinstall`, `install-from-source`, and `push`.

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
agent-device snapshot [--diff] [-i] [-d <depth>] [-s <scope>] [--raw]
agent-device diff snapshot [-i] [-d <depth>] [-s <scope>] [--raw]
agent-device get text @e1
agent-device get attrs @e1
```

- iOS snapshots use XCTest on simulators and physical devices.
- Android snapshots use the bundled Android snapshot helper when the npm package includes it. The
  first helper-backed snapshot verifies and installs the helper APK if it is missing or outdated;
  helper failures fall back to one-shot helper capture, then stock UIAutomator, and include
  `androidSnapshot.fallbackReason` in typed results. Local ADB-backed sessions keep the helper
  process warm over an `adb forward` socket and report `androidSnapshot.helperTransport` as
  `persistent-session`; set `AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION=0` to disable that fast
  path. Source checkouts without a bundled helper use stock UIAutomator. The helper serializes
  Android interactive window roots when available, so keyboard and system-overlay nodes can appear
  alongside the app root; `androidSnapshot.captureMode` and `androidSnapshot.windowCount` describe
  the capture.
- `diff snapshot` compares the current snapshot with the previous session baseline and then updates baseline.
- `snapshot --diff` is an alias for `diff snapshot`.
- Default snapshot text is an agent-facing, token-efficient view for planning and targeting actions. It may collapse helper/accessibility noise; use `--raw` or `--json` when you need the full provider tree.

## Wait and alerts

```bash
agent-device wait 1500
agent-device wait text "Welcome back"
agent-device wait @e12
agent-device wait 'role="button" label="Continue"' 5000
agent-device alert
agent-device alert get
agent-device alert wait 3000
agent-device alert accept
agent-device alert dismiss
```

- `wait` accepts a millisecond duration, `text <value>`, a snapshot ref (`@eN`), or a selector.
- `wait <selector> [timeoutMs]` polls until the selector resolves or the timeout expires.
- `wait @ref [timeoutMs]` requires an existing session snapshot from a prior `snapshot` command.
- `wait @ref` resolves the ref to its label/text from that stored snapshot, then polls for that text; it does not track the original node identity.
- Because `wait @ref` is text-based after resolution, duplicate labels can match a different element than the original ref target.
- `wait` shares the selector/snapshot resolution flow used by `click`, `fill`, `get`, and `is`.
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
agent-device swipe 540 1500 540 500 120
agent-device swipe 540 1500 540 500 120 --count 8 --pause-ms 30 --pattern ping-pong
agent-device gesture pan 200 420 0 -80 500
agent-device gesture fling right 200 420 180
agent-device longpress 300 500 800
agent-device scroll down 0.5
agent-device scroll down --pixels 320
agent-device gesture pinch 2.0          # zoom in 2x
agent-device gesture pinch 0.5 200 400 # zoom out at coordinates
agent-device gesture rotate 35 200 420 # rotate app content
agent-device gesture transform 200 420 80 -40 2 35 700 # combined pan, zoom, and rotate
```

`fill` clears then types. `type` does not clear.
`type` accepts text only. Do not pass `@ref` to `type`; use `fill @ref "text"` to target a field directly, or `press @ref` then `type "text"` to append in the focused field.
Use plain `fill` or `type` first for ordinary login and form fields. Use `--delay-ms` on `type` or `fill` only when a debounced search field or search-as-you-type input actually misses characters, or when the app must receive incremental updates.
Delayed typing intentionally prefers paced character entry over clipboard-style fallbacks so the target field receives each incremental update.
On Android, `fill` also verifies text and treats IME-owned capture as a terminal failure instead of retrying against the wrong field.
Android text entry is owned by `agent-device`: provider-native injection when available, then chunk-safe ASCII shell input. Do not switch to raw `adb`, clipboard, or paste as an agent fallback. If non-ASCII is unsupported in the current backend, report the tool/device gap.
`click --button secondary` is the desktop context-menu flow on macOS.
`click --button middle` is reserved for future runner support and currently returns an explicit unsupported-operation error on macOS.
`swipe` accepts an optional `durationMs` argument (default `250ms`, range `16..10000`).
On iOS, swipe duration is clamped to a safe range (`16..60ms`) to avoid longpress side effects.
`gesture pan` accepts `x y dx dy [durationMs]` for deliberate drags. Android preserves the requested travel duration; iOS uses XCTest drag primitives where this value is the pre-drag hold duration.
`gesture fling` accepts `up|down|left|right x y [distance] [durationMs]` for fast directional throws.
`gesture rotate` accepts `degrees [x] [y] [velocity]`; the degree sign controls direction and velocity controls speed.
`gesture transform` accepts `x y dx dy scale degrees [durationMs]` for one combined pan/zoom/rotate gesture on Android and iOS simulators.
On iOS simulators it uses private XCTest synthesis for a continuous two-finger pan/scale/rotation path, so verify app-level metrics instead of assuming the requested values map exactly to recognizer output.
On Android, `gesture transform` injects a geometric two-finger path. App recognizers may report non-exact pan, scale, and rotation values, so verify qualitative state such as `pan changed yes`, `pinch changed yes`, and `rotate changed yes` unless the app explicitly promises exact centroid metrics. If exact app-state values matter, prefer isolated `gesture pan`, `gesture pinch`, or `gesture rotate` commands.
`scroll` accepts either a relative amount (`0.5` means roughly half of the viewport on that axis) or `--pixels <n>` for a fixed-distance gesture. Large distances are clamped to the usable drag band so the gesture stays reliable across Android, iOS, and macOS.
Default snapshot text output is visible-first, so off-screen interactive content is summarized instead of shown as tappable refs.
When a target only appears in an off-screen summary, use `scroll <direction>` and then take a fresh `snapshot -i`. For repeated checks, a small shell loop is enough:

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
`gesture pinch` is supported on Android and iOS simulator app sessions.
`gesture rotate` is supported on Android and iOS simulator app sessions. Use `rotate` for device orientation. On iOS the optional `velocity` argument is ignored — rotation is synthesized over a fixed duration and direction is taken from the sign of `degrees`.
`gesture transform` is supported on Android and iOS simulator app sessions.

## Find (semantic)

```bash
agent-device find "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find role button click
```

## Assertions

```bash
agent-device is visible 'role="button" label="Continue"'
agent-device is exists 'id="primary-cta"'
agent-device is hidden 'text="Loading..."'
agent-device is editable 'id="email"'
agent-device is selected 'label="Wi-Fi"'
agent-device is text 'id="greeting"' "Welcome back"
```

- `is` evaluates UI predicates against a selector expression and exits non-zero on failure.
- Supported predicates are `visible`, `hidden`, `exists`, `editable`, `selected`, and `text`.
- `is visible` checks whether the resolved element is present in the current visible snapshot viewport. A node without its own rect still passes when a visible ancestor within the viewport provides the on-screen geometry.
- `is exists` only checks whether the selector matches in the current snapshot.
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
agent-device replay -u ./session.ad   # Update selector drift and rewrite .ad script in place
```

- `replay` runs deterministic `.ad` scripts.
- `test` runs one or more `.ad` scripts as a serial suite from files, directories, or glob inputs.
- `test --platform <platform>` filters suite files by `context platform=...` metadata instead of overriding the script target.
- `test --timeout <ms>` and `test --retries <n>` apply per script attempt; `context timeout=...` and `context retries=...` can be declared inside the `.ad` header. Retries are capped at `3`, duplicate metadata keys are rejected, and timeouts are cooperative.
- `test --artifacts-dir <path>` overrides the default suite artifact root at `.agent-device/test-artifacts`.
- `test` prints a short `Running replay suite...` line before dispatch, then streams one-line `pass`, `fail`, or `skip` progress on stderr as each suite entry finishes or retries. Each line includes current/total suite position and elapsed seconds such as `pass 3/6 ... duration=12.34s`. The final summary still prints failures and flaky passed-on-retry tests by default; add `--verbose` to print every final result.
- `replay -u` updates stale recorded actions and rewrites the same script.
- `--save-script` records a replay script on `close`; optional path is a file path and parent directories are created.

See [Replay & E2E](/docs/replay-e2e) for recording, Maestro compatibility, and CI workflow details.

## Batch

```bash
agent-device batch --steps-file /tmp/batch-steps.json --json
agent-device batch --steps '[{"command":"open","input":{"app":"settings"}}]'
```

- `batch` runs a JSON array of steps in a single daemon request.
- Each step has `command`, `input`, and optional `runtime`.
- `input` uses the same fields as the matching MCP/Node command.
- Legacy CLI step payloads with `positionals`/`flags` still run with a deprecation warning and will be removed in the next major version.
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
- Supports Android devices/emulators, iOS simulators, and iOS physical devices.
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
- Supports Android devices/emulators, iOS simulators, and iOS physical devices.
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
- Supports the same device coverage as `install`: Android devices/emulators, iOS simulators, and iOS physical devices.
- Use `install` or `reinstall` for local `.apk`, `.aab`, `.app`, and `.ipa` paths; use `install-from-source` when the artifact already exists at a URL reachable by the daemon.
- Direct Android URL sources may be `.apk` or `.aab`.
- Trusted artifact service URLs may resolve to archives containing one installable `.apk`, `.aab`, `.ipa`, or iOS `.app` tar archive. Prefer `--github-actions-artifact` for GitHub Actions artifacts that a compatible remote daemon can resolve with its own credentials.
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
- Fingerprint simulation is supported on Android targets where `cmd fingerprint` or `adb emu finger` is available.
  On physical Android devices, only `cmd fingerprint` is attempted.
- Permission actions are scoped to the active session app.
- iOS permission targets: `camera`, `microphone`, `photos` (`full` or `limited`), `contacts`, `notifications`.
- Android permission targets: `camera`, `microphone`, `photos`, `contacts`, `notifications`.
- macOS permission targets: `accessibility`, `screen-recording`, `input-monitoring`.
- On macOS, `settings permission grant ...` checks/request access and opens System Settings guidance when needed; it does not silently grant TCC permissions.
- On macOS, `settings permission deny ...` is intentionally unsupported.
- Android uses `pm grant|revoke` for runtime permissions (`reset` maps to revoke) and `appops` for notifications.
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
- `keyboard dismiss` attempts a non-navigation keyboard dismissal on Android and a native dismiss gesture/control on iOS, including common safe controls such as a keyboard toolbar `Done` button, then confirms the keyboard is hidden.
- If the keyboard remains visible after the platform-native dismiss path, the command returns an explicit `UNSUPPORTED_OPERATION` error instead of falling back to back navigation.
- On iOS, `keyboard dismiss` is best-effort and can fail when the active app exposes no native dismiss gesture/control. Prefer a visible app dismiss control, or use `back --system` only when system navigation is an acceptable side effect.
- Works with active sessions and explicit selectors (`--platform`, `--device`, `--udid`, `--serial`).
- `keyboard status|get` is supported on Android emulator/device.
- `keyboard dismiss` is supported on Android emulator/device and best-effort on iOS simulator/device.

## Performance metrics

```bash
agent-device perf --json
agent-device metrics --json
agent-device perf metrics --json
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

- `perf metrics` returns a session-scoped metrics JSON blob. Bare `perf` and `metrics` remain aliases for `perf metrics`.
- `perf frames` returns a focused frame/jank-health JSON blob from the same frame sampling source used by `perf metrics`.
- `perf memory sample` returns a compact memory-only JSON blob for agents investigating growth/leaks without collecting a large artifact. It is better than raw memory command output for first-pass diagnosis because arrays are bounded, top offenders are compact, and the payload omits unrelated startup/CPU/frame data.
- Example sample shape: `{"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}`.
- `perf memory snapshot` writes a heap/memgraph artifact to disk and returns path, size, kind, method, and support metadata. Large artifacts are never dumped into CLI/MCP/default JSON output.
- Example default snapshot output: `Memory artifact (android-hprof): /tmp/app.hprof (42MB)`.
- `cdp` targets React Native JavaScript heap evidence through Metro CDP. Use it for JS heap usage samples and heap snapshots; use `perf memory sample` and `perf memory snapshot` for native/process memory. See [Debugging & Profiling](/docs/debugging-profiling) for the bounded leak workflow.
- `perf cpu profile ... --kind xctrace` records an Apple `.trace` with the requested xctrace template and writes a compact JSON report from the most recent CPU profile trace.
- `perf trace ... --kind xctrace` records an Apple `.trace` such as Animation Hitches for native diagnosis.
- xctrace perf commands return artifact paths and compact metadata only; inspect `.trace` files in Instruments/Xcode instead of dumping trace contents into agent context.
- `perf cpu profile ... --kind simpleperf` starts/stops Android native CPU profiling for the active session package and can generate a compact JSON report artifact from the captured profile.
- `perf trace ... --kind perfetto` starts/stops Android Perfetto trace capture for the active session package.
- Native profile/trace outputs are compact agent evidence: state, artifact path, size, and method. Raw `.perf.data` and `.perfetto-trace` contents stay on disk.
- Without `--json`, `perf` prints a compact summary: frame health when reliable frame data is available, otherwise CPU/memory when those samples are available.
- Use native perf stop/report results as compact agent evidence, not raw profiler output. A successful Perfetto stop can return `state: "stopped"`, `outPath: "/tmp/app.perfetto-trace"`, `sizeBytes: 5392410`, and `method: "adb-shell-perfetto"` while the 5.3 MB raw trace stays on disk as the artifact.
- `startup` is sampled from `open-command-roundtrip`: elapsed wall-clock time around each `open` command dispatch for the active session app target.
- Android app sessions with an active package also sample:
  - `fps` frame health from `adb shell dumpsys gfxinfo <package> framestats`, with `droppedFramePercent` as the primary value and `worstWindows` for dropped-frame clusters
  - `memory` from `adb shell dumpsys meminfo <package>` with values reported in kilobytes (`kB`)
  - `cpu` from `adb shell dumpsys cpuinfo`, aggregated across matching package processes and reported as a recent percentage snapshot
- Apple app sessions with an active bundle ID also sample:
  - `fps` frame health from `xcrun xctrace` Animation Hitches on connected iOS devices, with `droppedFramePercent` as the primary value and `worstWindows` for hitch clusters
  - `memory` from process RSS snapshots reported in kilobytes (`kB`)
  - `cpu` from process CPU usage snapshots reported as a recent percentage
- Platform support:
  - `startup`: iOS simulator, iOS physical device, Android emulator/device
  - `memory` and `cpu`: Android emulator/device, macOS app sessions, iOS simulators with an active app session (`open <app>` first), and iOS physical devices with an active app session
  - `fps`: Android emulator/device app sessions and connected iOS device app sessions. iOS simulator and macOS frame health is reported unavailable because Apple tooling does not expose trustworthy app hitch data there.
  - `perf memory snapshot --kind android-hprof`: Android emulator/device app sessions with a running debuggable/profileable process and permitted heap dumping
  - `perf memory snapshot --kind memgraph`: iOS simulator and macOS app sessions with a running app process. Physical iOS devices report memgraph unavailable with a recovery hint.
  - `perf memory trace --kind heapprofd`: deferred until Android Perfetto/heapprofd plumbing is available.
  - `perf cpu profile --kind xctrace`: iOS simulator app sessions, connected iOS device app sessions where xctrace can attach to the active process, and macOS app sessions when the app process can be resolved from the bundle ID.
  - `perf trace --kind xctrace`: iOS simulator app sessions, connected iOS device app sessions where xctrace can attach to the active process, and macOS app sessions when the selected xctrace template supports the target.
  - Android native profiling is not implemented under Apple xctrace perf; Android profiling is tracked separately.
- If no startup sample exists yet for the session, run `open <app|url>` first and retry `perf metrics`.
- Android URL/deep-link opens infer the foreground package after launch when possible, including Expo Go/dev-client shells. If the session still has no app package/bundle ID, package-bound metrics remain unavailable until you `open <app>`.
- Android frame health is reset after each successful `perf metrics` or `perf frames` read and after `open <app>`, so run `perf frames`, perform the interaction, then run `perf frames` again for a focused window.
- Android Simpleperf and Perfetto collectors require an active Android app session with a running package process. They return artifact paths, sizes, and compact state summaries; they do not print profile or trace contents into the agent context. iOS native Simpleperf/Perfetto support is not provided by these commands.
- On physical iOS devices, `perf metrics` and `perf frames` record short `xcrun xctrace` samples. Keep the device unlocked, connected, and the app active in the foreground while sampling.
- Interpretation note: this startup metric is command round-trip timing and does not represent true first frame / first interactive app instrumentation.
- CPU data is a lightweight process snapshot, so an idle app may legitimately read as `0`.

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
- Keep using `snapshot`, `press`, `fill`, `logs`, `network`, `perf metrics`, and `perf frames` for device/app runtime evidence. Use `react-devtools` for React internals.
- For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, start with `agent-device help react-native`.
- On Android, use `alert get`, `alert wait <short-ms>`, `alert accept`, and `alert dismiss` for runtime permission prompts and native alerts. On iOS, use the same alert commands for XCTest alerts, app-owned modal popups with native blocking markers, and blocking system dialogs. Do not use `settings permission` to answer a dialog already on screen; reserve it for setup or resetting permission state before a flow.
- React Native development builds can connect to the DevTools daemon on port 8097. For Android emulators or physical devices, run `adb reverse tcp:8097 tcp:8097` if the app cannot reach the host.
- Direct Android `open` URL targets for local Metro hosts with a port auto-configure host reachability. For app/package launches or unsupported flows, run `adb reverse tcp:8081 tcp:8081` if the app cannot reach local Metro.
- For Android and iOS sessions connected through a remote bridge profile, `react-devtools` registers a lease-scoped companion tunnel to the sandbox-local DevTools daemon at `127.0.0.1:8097`. Android bridge profiles use the bridge-owned remote `adb reverse` mapping; iOS bridge profiles use the bridge-owned wildcard Metro host tunnel. The CLI keeps the companion alive until `agent-device react-devtools stop` or `agent-device disconnect`.
- For remote iOS bridge sessions, open the app once to create the bridge session, run `agent-device react-devtools start`, then relaunch the same bundle id with `agent-device open <bundle-id> --platform ios --relaunch` before `wait --connected`. React Native attempts the legacy DevTools websocket during JavaScript startup, so starting DevTools after the first launch can miss that connection attempt.
- Remote bridge React DevTools assumes the React Native-bundled DevTools behavior in React Native 0.83+. Older browser/Chromium DevTools workflows are not assumed to exist inside remote sandboxes. Expo projects should be verified against the SDK's bundled React Native version before relying on this path; this release does not claim a separately verified Expo SDK version.
- For cross-platform validation with explicit target selectors, use separate sessions/devices and restart `react-devtools` between iOS and Android runs.

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
- On iOS simulators, `open` writes React Native's per-simulator debug server settings before launching, so `rn-a` can use port `8081` while `rn-b` uses port `8082`.
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

- `metro reload` calls Metro's `/reload` endpoint, the same mechanism used by pressing `r` in the Metro terminal.
- Use it for React Native dev builds that are already connected to Metro when JS changes should be loaded without restarting the native app process.
- If an active remote connection has Metro runtime hints, `metro reload` uses those saved hints. Otherwise it defaults to `http://localhost:8081/reload`.
- Pass `--metro-host`, `--metro-port`, or `--bundle-url` when you need to target a specific Metro instance.
- Fall back to `open <app> --relaunch` when the app is not connected to Metro, reload fails, or the native process itself must restart.

## Media and logs

```bash
agent-device screenshot                 # Auto filename
agent-device screenshot page.png        # Explicit screenshot path
agent-device screenshot page.png --max-size 1024  # Downscale longest edge for agent-friendly artifacts
agent-device screenshot page.png --overlay-refs  # Draw current @eN refs and target rectangles onto the PNG
agent-device screenshot page.png --platform web --fullscreen  # On web, --fullscreen/--full/-f captures the entire document
agent-device viewport 1280 900 --platform web                # Resize the active web viewport for fixed-layout or 100vh apps
agent-device screenshot textedit.png    # App-session window capture on macOS
agent-device screenshot --fullscreen    # Force full-screen capture on macOS app sessions
agent-device open --platform macos --surface desktop && agent-device screenshot desktop.png
agent-device diff screenshot --baseline baseline.png --out diff.png
agent-device diff screenshot --baseline baseline.png current.png --out diff.png
agent-device diff screenshot --baseline baseline.png --out diff.png --overlay-refs
agent-device record start               # Start screen recording to auto filename
agent-device record start session.mp4   # Start recording to explicit path
agent-device record start session.mp4 --fps 30  # Override iOS device runner FPS
agent-device record start session.mp4 --max-size 1024 # Downscale longest edge
agent-device record start session.mp4 --quality high # Higher-quality export (slower)
agent-device record stop                # Stop active recording
```

- Recordings always produce a video artifact. When touch visualization is enabled, they also produce a gesture telemetry sidecar that can be used for post-processing or inspection.
- `screenshot --max-size <px>` preserves aspect ratio and only downscales when the saved PNG's longest edge is larger than the requested size.
- `screenshot --overlay-refs` captures a fresh full snapshot and burns visible `@eN` refs plus their target rectangles into the saved PNG.
- `screenshot --max-size <px> --overlay-refs` writes a smaller image and draws refs for that final image size; avoid very small max sizes when text, icons, or labels need to remain readable.
- `diff screenshot` compares the current live screenshot to `--baseline`, or compares `--baseline` to an optional saved `current.png` path without requiring an active session, then prints ranked changed regions with screen-space rectangles, shape, size, density, average color, and luminance, and writes a diff PNG with a light grayscale current-screen context, red-tinted changed pixels, and outlined changed regions when `--out` is provided. JSON also includes normalized bounds.
- If `tesseract` is installed, `diff screenshot` also adds best-effort OCR text deltas, movement clusters, and bbox size-change hints to the text and JSON output. OCR improves descriptions only; it does not change the pixel comparison or the diff PNG.
- When OCR is available, `diff screenshot` also reports best-effort non-text visual deltas by masking OCR text boxes out of the diff and clustering remaining residuals. These are hints for icons, controls, and separators, not semantic icon recognition.
- `diff screenshot --overlay-refs` additionally writes a separate current-screen overlay guide for live captures without using that annotated image for the pixel comparison. If current-screen refs intersect changed regions, the output lists the best ref matches under those regions. Saved-image comparisons do not have live accessibility refs, so `--overlay-refs` is unavailable when a `current.png` path is provided.
- In `--json` mode, each overlay ref also includes a screenshot-space `center` point for coordinate fallback like `press <x> <y>`.
- Burned-in touch overlays are exported only on macOS hosts, because the overlay pipeline depends on Swift + AVFoundation helpers.
- On Linux or other non-macOS hosts, `record stop` still succeeds and returns the raw video plus telemetry sidecar, and includes `overlayWarning` when burn-in overlays were skipped.

**Session app logs (token-efficient debugging):** Logging is off by default in normal flows. Enable it on demand for debugging. Logs are written to a file so agents can grep instead of loading full output into context.

```bash
agent-device logs path                  # Print session log file path (e.g. ~/.agent-device/sessions/default/app.log)
agent-device logs start                 # Start streaming app stdout/stderr to that file (requires open first)
agent-device logs stop                  # Stop streaming
agent-device logs clear                 # Truncate app.log + remove rotated app.log.N files (requires stopped stream)
agent-device logs clear --restart       # Stop stream, clear log files, and start streaming again
agent-device logs doctor                # Show logs backend/tool checks and readiness hints
agent-device logs mark "before submit"  # Insert timeline marker into app.log
agent-device network dump 25            # Parse recent HTTP(s) requests (method/url/status)
agent-device network dump 25 --include all # Include parsed headers/body when available (truncated)
agent-device network dump 25 --include headers --platform web # Browser requests via managed agent-browser
```

- Supported on iOS simulator, iOS physical device, and Android.
- Preferred debug entrypoint: `logs clear --restart` for clean-window repro loops.
- `logs start` appends to `app.log` and rotates to `app.log.1` when the file exceeds 5 MB.
- `open` prints `Session state: <path>` and JSON includes `sessionStateDir`, `runnerLogPath`, and `requestLogPath`. Use the session directory to inspect concurrent runs without parsing global daemon logs.
- `requests/<request-id>.ndjson` contains daemon request diagnostics for the session; `runner.log` contains Apple runner and `xcodebuild` output.
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

- `debug` is intentionally narrow: do not use it for app logs, network evidence, performance samples, recordings, traces, or React Native internals.
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

- iOS `record` works on simulators and physical devices.
- iOS simulator recording uses native `simctl io ... recordVideo`.
- Physical iOS device capture is runner-based and built from repeated `XCUIScreen.main.screenshot()` frames (no native video stream/audio capture).
- Physical iOS device recording requires an active app session context (`open <app>` first).
- Physical iOS device capture is best-effort: dropped frames are expected and true 60 FPS is not guaranteed even with `--fps 60`.
- Physical-device capture defaults to 15 FPS.
- `--fps <n>` (1-120) applies to physical iOS device recording as an explicit FPS cap.
- `--max-size <px>` preserves aspect ratio and only downscales when the recording's longest edge is larger than the requested size.
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
- `connect --remote-config ...` follows the same state and deferred-preparation flow using the local profile instead of cloud discovery.
- Auth management commands are available for inspection and recovery: `agent-device auth status`, `agent-device auth login`, and `agent-device auth logout`. Human login stores a revocable CLI session locally; it does not create or persist an `adc_live_...` service token.
- Cloud auth uses three credential classes: `adc_agent_...` short-lived command tokens, revocable CLI session refresh credentials, and explicit `adc_live_...` service/API tokens for CI. The CLI implements credential selection, CI refusal, local storage permissions, logout, and output redaction; the cloud API must enforce token expiry, tenant/run scope, revocation, one-time device approval, polling rate limits, and dashboard/API separation.
- `AGENT_DEVICE_CLOUD_BASE_URL` should point at the bridge/control-plane API origin, not necessarily the dashboard origin. API-token setup links use `/api-keys` on that origin so the bridge can redirect users to the right dashboard page.
- Deferred Metro preparation also applies to `batch` when any step opens an app and the batch does not provide its own per-step runtime.
- After `connect`, `install-from-source`, `open`, `snapshot`, `devices`, `press`, `fill`, `screenshot`, and other normal commands reuse active connection state so agents do not repeat remote host/session/lease selectors inline. If `connection status` shows `leaseId=pending`, the first platform-bound command allocates or refreshes the lease. Passing the same `--remote-config` to a normal command is also supported for self-contained scripts; the CLI reuses matching saved state or creates it before dispatch.
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

## iOS physical-device prerequisites

For CLI-discoverable setup guidance, run `agent-device help physical-device`.

- Xcode + `xcrun devicectl` available.
- Paired/trusted physical device, connected, unlocked when needed, with Developer Mode enabled.
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
