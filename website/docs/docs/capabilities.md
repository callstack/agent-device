---
title: Capabilities
description: Which commands each target supports, read from the runtime code that decides it.
---

The target tables below are generated from the runtime command-admission facts that back the `capabilities` command: a command that leaves the code leaves this page. Labels, limits, and integration rows are maintained beside the generator, and command availability does not establish support for every operation, subcommand, or device model.

**Yes** means the facts admit every command in that row on the target and every operation the row advertises. **No** means at least one is refused. A qualified cell names the operations that answer there. Targets that share the same available operations print as one column.

Physical iOS devices discovered only through `xctrace` use the XCTest backend rather than CoreDevice: they support open/close, interactions, snapshots, and screenshots, while app inventory, installation, logs, performance sampling, recording, deep links, and launch arguments need CoreDevice.

One capability depends on the agent machine rather than the target: system audio sampling works only when the daemon runs on macOS, which is what this page assumes.

Check the device in front of you rather than trusting a table:

```bash
agent-device capabilities --platform ios --device "iPhone 17 Pro"
agent-device capabilities --session my-session --json
```

A provider column answers for that provider in its default configuration. Provider credentials, device selection, and artifact retrieval live on the provider pages.

## Inspect and verify the UI

### Inspect and verify the UI: mobile targets

| Capability and reference | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| --- | --- | --- | --- | --- | --- | --- |
| [Accessibility snapshot and snapshot diff](/docs/snapshots) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Refs, selectors, element lookup, and attribute reads](/docs/selectors) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Screenshots](/docs/commands#media-and-logs) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Wait for text, selectors, and timeouts](/docs/commands#wait-and-alerts) | Yes | Yes | Yes | Yes | Yes | Yes |

### Inspect and verify the UI: TV targets

| Capability and reference | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| --- | --- | --- | --- | --- | --- |
| [Accessibility snapshot and snapshot diff](/docs/snapshots) | Yes | Yes | Yes | Yes | No |
| [Refs, selectors, element lookup, and attribute reads](/docs/selectors) | Yes | Yes | Yes | Yes | No |
| [Screenshots](/docs/commands#media-and-logs) | Yes | Yes | Yes | Yes | No |
| [Wait for text, selectors, and timeouts](/docs/commands#wait-and-alerts) | Yes | Yes | Yes | Yes | No |

### Inspect and verify the UI: desktop and web targets

| Capability and reference | macOS desktop | macOS app | Linux desktop | Web browser |
| --- | --- | --- | --- | --- |
| [Accessibility snapshot and snapshot diff](/docs/snapshots) | Yes | Yes | Yes | Yes |
| [Refs, selectors, element lookup, and attribute reads](/docs/selectors) | Yes | Yes | Yes | Yes |
| [Screenshots](/docs/commands#media-and-logs) | Yes | Yes | Yes | Yes |
| [Wait for text, selectors, and timeouts](/docs/commands#wait-and-alerts) | Yes | Yes | Yes | Yes |

### Inspect and verify the UI: hosted provider sessions

| Capability and reference | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android | Revyl iOS | Revyl Android |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Accessibility snapshot and snapshot diff](/docs/snapshots) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Refs, selectors, element lookup, and attribute reads](/docs/selectors) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Screenshots](/docs/commands#media-and-logs) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Wait for text, selectors, and timeouts](/docs/commands#wait-and-alerts) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

What a **Yes** does not claim:

- **Accessibility snapshot and snapshot diff**: A capture returns a tree only when the app or desktop exposes an accessibility tree.

## Interact with the app

### Interact with the app: mobile targets

| Capability and reference | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| --- | --- | --- | --- | --- | --- | --- |
| [Tap, press, and fill](/docs/commands#interactions) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Type into the focused field](/docs/commands#interactions) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Long press](/docs/commands#interactions) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Scroll](/docs/commands#scroll) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Gesture plans and swipes](/docs/commands#pointer-and-gestures) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Hover and viewport size](/docs/commands#web-automation) | No | No | No | No | No | No |
| [Read, accept, and dismiss system alerts](/docs/commands#wait-and-alerts) | Yes | Yes | Yes | Yes | No | No |
| [Keyboard dismiss, enter, and status](/docs/commands#keyboard) | Dismiss and enter; status unsupported | Dismiss and enter; status unsupported | Yes | Yes | Dismiss and enter; status unsupported | Dismiss and enter; status unsupported |
| [React Native overlay dismissal](/docs/commands#react-native-overlays) | Yes | Yes | Yes | Yes | Yes | Yes |

### Interact with the app: TV targets

| Capability and reference | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| --- | --- | --- | --- | --- | --- |
| [Tap, press, and fill](/docs/commands#interactions) | Yes | Yes | Yes | Yes | No |
| [Type into the focused field](/docs/commands#interactions) | Yes | Yes | Yes | Yes | No |
| [Long press](/docs/commands#interactions) | Yes | Yes | Yes | Yes | No |
| [Scroll](/docs/commands#scroll) | Yes | Yes | Yes | Yes | No |
| [Gesture plans and swipes](/docs/commands#pointer-and-gestures) | Yes | Yes | Yes | Yes | No |
| [Hover and viewport size](/docs/commands#web-automation) | No | No | No | No | No |
| [Read, accept, and dismiss system alerts](/docs/commands#wait-and-alerts) | Yes | Yes | Yes | No | No |
| [Keyboard dismiss, enter, and status](/docs/commands#keyboard) | Yes | Yes | No | No | No |
| [React Native overlay dismissal](/docs/commands#react-native-overlays) | Yes | Yes | Yes | Yes | No |

### Interact with the app: desktop and web targets

| Capability and reference | macOS desktop | macOS app | Linux desktop | Web browser |
| --- | --- | --- | --- | --- |
| [Tap, press, and fill](/docs/commands#interactions) | Yes | Yes | Yes | Yes |
| [Type into the focused field](/docs/commands#interactions) | Yes | Yes | Yes | Yes |
| [Long press](/docs/commands#interactions) | Yes | Yes | Yes | No |
| [Scroll](/docs/commands#scroll) | Yes | Yes | Yes | Yes |
| [Gesture plans and swipes](/docs/commands#pointer-and-gestures) | Yes | Yes | Yes | No |
| [Hover and viewport size](/docs/commands#web-automation) | No | No | No | Yes |
| [Read, accept, and dismiss system alerts](/docs/commands#wait-and-alerts) | Yes | Yes | No | No |
| [Keyboard dismiss, enter, and status](/docs/commands#keyboard) | No | No | No | No |
| [React Native overlay dismissal](/docs/commands#react-native-overlays) | Yes | Yes | Yes | Yes |

### Interact with the app: hosted provider sessions

| Capability and reference | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android | Revyl iOS | Revyl Android |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Tap, press, and fill](/docs/commands#interactions) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Type into the focused field](/docs/commands#interactions) | Yes | Yes | Yes | Yes | Yes | Yes | No | No |
| [Long press](/docs/commands#interactions) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Scroll](/docs/commands#scroll) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Gesture plans and swipes](/docs/commands#pointer-and-gestures) | Yes | Yes | Yes | Yes | No | Yes | No | No |
| [Hover and viewport size](/docs/commands#web-automation) | No | No | No | No | No | No | No | No |
| [Read, accept, and dismiss system alerts](/docs/commands#wait-and-alerts) | No | No | No | No | Yes | Yes | No | No |
| [Keyboard dismiss, enter, and status](/docs/commands#keyboard) | Yes | Dismiss only; status and enter unsupported | Yes | Dismiss only; status and enter unsupported | No | Yes | No | No |
| [React Native overlay dismissal](/docs/commands#react-native-overlays) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

What a **Yes** does not claim:

- **Tap, press, and fill**: Android types non-ASCII text through the test input method: automatically on emulators, and on physical devices only with `open --test-ime`.
- **Type into the focused field**: Revyl enters text only at a point, so it refuses `type`; use `fill` on the field instead.
- **Gesture plans and swipes**: Multi-touch plans are part of `gesture` where the target runs them; a plan using an operation the target lacks fails at that step.
- **React Native overlay dismissal**: The command runs wherever tapping runs; it answers `detected: false` on a surface with no React Native overlay. Only iOS and Android apps present dismissable development overlays.

## Apps and devices

### Apps and devices: mobile targets

| Capability and reference | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| --- | --- | --- | --- | --- | --- | --- |
| [Open and close apps, URLs, and deep links](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Install and reinstall an app](/docs/commands#app-install-in-place) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Uninstall an app](/docs/commands#app-uninstall) | Yes | Yes | Yes | Yes | No | No |
| [Install from a source URL](/docs/commands#app-install-from-source-url) | Yes | Yes | Yes | Yes | No | No |
| [Installed app list](/docs/commands#app-state-and-app-lists) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Foreground app state](/docs/commands#app-state-and-app-lists) | Yes | Yes | Yes | Yes | Yes | Yes |
| [App switcher](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Get the device ready and boot simulators and emulators](/docs/commands#navigation) | Yes | Yes | Yes | Yes | No | No |
| [Shut down a simulator or emulator](/docs/commands#navigation) | Yes | No | Yes | No | No | No |
| [Prepare the Apple runner](/docs/commands#prepare-apple-runner) | Yes | Yes | No | No | No | No |

### Apps and devices: TV targets

| Capability and reference | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| --- | --- | --- | --- | --- | --- |
| [Open and close apps, URLs, and deep links](/docs/commands#navigation) | Yes | Yes | Yes | Yes | App open/close only; URLs and deep links rejected |
| [Install and reinstall an app](/docs/commands#app-install-in-place) | Yes | Yes | Yes | Yes | No |
| [Uninstall an app](/docs/commands#app-uninstall) | Yes | Yes | Yes | Yes | No |
| [Install from a source URL](/docs/commands#app-install-from-source-url) | Yes | Yes | Yes | Yes | No |
| [Installed app list](/docs/commands#app-state-and-app-lists) | Yes | Yes | Yes | Yes | No |
| [Foreground app state](/docs/commands#app-state-and-app-lists) | Yes | Yes | Yes | Yes | No |
| [App switcher](/docs/commands#navigation) | Yes | Yes | Yes | Yes | No |
| [Get the device ready and boot simulators and emulators](/docs/commands#navigation) | Yes | Yes | Yes | Yes | No |
| [Shut down a simulator or emulator](/docs/commands#navigation) | Yes | No | Yes | No | No |
| [Prepare the Apple runner](/docs/commands#prepare-apple-runner) | No | No | Yes | Yes | No |

### Apps and devices: desktop and web targets

| Capability and reference | macOS desktop | macOS app | Linux desktop | Web browser |
| --- | --- | --- | --- | --- |
| [Open and close apps, URLs, and deep links](/docs/commands#navigation) | Yes | Yes | Yes | Yes |
| [Install and reinstall an app](/docs/commands#app-install-in-place) | No | No | No | No |
| [Uninstall an app](/docs/commands#app-uninstall) | No | No | No | No |
| [Install from a source URL](/docs/commands#app-install-from-source-url) | No | No | No | No |
| [Installed app list](/docs/commands#app-state-and-app-lists) | Yes | Yes | No | No |
| [Foreground app state](/docs/commands#app-state-and-app-lists) | No | No | No | No |
| [App switcher](/docs/commands#navigation) | No | No | No | No |
| [Get the device ready and boot simulators and emulators](/docs/commands#navigation) | No | No | No | No |
| [Shut down a simulator or emulator](/docs/commands#navigation) | No | No | No | No |
| [Prepare the Apple runner](/docs/commands#prepare-apple-runner) | Yes | Yes | No | No |

### Apps and devices: hosted provider sessions

| Capability and reference | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android | Revyl iOS | Revyl Android |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Open and close apps, URLs, and deep links](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Install and reinstall an app](/docs/commands#app-install-in-place) | Yes | Yes | No | No | Yes | Yes | No | No |
| [Uninstall an app](/docs/commands#app-uninstall) | No | No | No | No | No | No | No | No |
| [Install from a source URL](/docs/commands#app-install-from-source-url) | Yes | Yes | No | No | Yes | Yes | No | No |
| [Installed app list](/docs/commands#app-state-and-app-lists) | No | No | No | No | Yes | Yes | No | No |
| [Foreground app state](/docs/commands#app-state-and-app-lists) | No | No | No | No | No | Yes | No | No |
| [App switcher](/docs/commands#navigation) | Yes | Yes | Yes | Yes | No | Yes | No | No |
| [Get the device ready and boot simulators and emulators](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Shut down a simulator or emulator](/docs/commands#navigation) | No | No | No | No | No | No | No | No |
| [Prepare the Apple runner](/docs/commands#prepare-apple-runner) | No | No | No | No | No | No | No | No |

What a **Yes** does not claim:

- **Foreground app state**: On iOS and macOS a bound session that owns an app identity or surface answers this from its own state, even where the sessionless probe cannot see a foreground app.
- **Get the device ready and boot simulators and emulators**: On a simulator or emulator this starts the machine. On a physical or hosted device it waits for the device that is already provisioned to answer rather than starting one.

## Evidence and diagnostics

### Evidence and diagnostics: mobile targets

| Capability and reference | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| --- | --- | --- | --- | --- | --- | --- |
| [Screen recording](/docs/commands#media-and-logs) | Yes | Yes | Yes | Yes | No | Yes |
| [App logs](/docs/debugging-profiling#logs) | Yes | Yes | Yes | Yes | Yes | Yes |
| [HTTP(S) request inspection](/docs/debugging-profiling#network-inspection) | Yes | Yes | Yes | Yes | No | No |
| [Performance samples (frames, memory, CPU profiles)](/docs/debugging-profiling#performance-snapshots) | Yes | Frames, memory, and CPU profiles; memory-snapshot artifact reports unavailable | Yes | Yes | Process RSS memory sample only; frames, memory-snapshot artifacts, CPU profiles, and native captures report unavailable | Process RSS memory sample only; frames, memory-snapshot artifacts, CPU profiles, and native captures report unavailable |
| [Audio probe](/docs/debugging-profiling#audio-probes) | Yes | No | Yes | No | No | No |

### Evidence and diagnostics: TV targets

| Capability and reference | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| --- | --- | --- | --- | --- | --- |
| [Screen recording](/docs/commands#media-and-logs) | Yes | Yes | Yes | Yes | No |
| [App logs](/docs/debugging-profiling#logs) | Yes | Yes | Yes | Yes | No |
| [HTTP(S) request inspection](/docs/debugging-profiling#network-inspection) | Yes | Yes | Yes | Yes | No |
| [Performance samples (frames, memory, CPU profiles)](/docs/debugging-profiling#performance-snapshots) | Yes | Yes | Yes | Yes | No |
| [Audio probe](/docs/debugging-profiling#audio-probes) | Yes | No | Yes | No | No |

### Evidence and diagnostics: desktop and web targets

| Capability and reference | macOS desktop | macOS app | Linux desktop | Web browser |
| --- | --- | --- | --- | --- |
| [Screen recording](/docs/commands#media-and-logs) | Yes | Yes | No | Yes |
| [App logs](/docs/debugging-profiling#logs) | Yes | Yes | No | No |
| [HTTP(S) request inspection](/docs/debugging-profiling#network-inspection) | Yes | Yes | No | Yes |
| [Performance samples (frames, memory, CPU profiles)](/docs/debugging-profiling#performance-snapshots) | Yes | Yes | No | No |
| [Audio probe](/docs/debugging-profiling#audio-probes) | Yes | No | No | Page media probe only; host capture unsupported |

### Evidence and diagnostics: hosted provider sessions

| Capability and reference | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android | Revyl iOS | Revyl Android |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Screen recording](/docs/commands#media-and-logs) | No | No | No | No | Yes | Yes | No | No |
| [App logs](/docs/debugging-profiling#logs) | No | No | No | No | Yes | Yes | No | No |
| [HTTP(S) request inspection](/docs/debugging-profiling#network-inspection) | No | No | No | No | Yes | Yes | No | No |
| [Performance samples (frames, memory, CPU profiles)](/docs/debugging-profiling#performance-snapshots) | No | No | No | No | No | No | No | No |
| [Audio probe](/docs/debugging-profiling#audio-probes) | No | No | No | No | No | No | No | No |

What a **Yes** does not claim:

- **Screen recording**: An iOS physical device records runner screenshots, not a native video stream: no audio, and dropped frames are expected. An Android clip covers 180 seconds, and a longer recording arrives as chunks.
- **HTTP(S) request inspection**: Local native app sessions inspect the HTTP(S) entries present in the session app log; traffic absent from those logs is not captured. The three WebDriver provider clouds refuse a live dump: their traffic is on the provider side, and TestMu AI can return provider network-log artifacts after the session ends. Managed web sessions inspect the browser request history.
- **Audio probe**: A simulator, emulator, or macOS desktop session samples host system audio, which works on a macOS agent host and needs Screen Recording permission there.

## System and hardware

### System and hardware: mobile targets

| Capability and reference | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| --- | --- | --- | --- | --- | --- | --- |
| [Back](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Home](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes |
| [Set screen orientation](/docs/commands#navigation) | Set only; unlock unsupported | Set only; unlock unsupported | Yes | Yes | No | No |
| [Phone hardware buttons](/docs/commands#navigation) | No | Volume only | Yes | Yes | No | No |
| [iPhone Action Button](/docs/commands#navigation) | Models with an Action Button only | Models with an Action Button only | No | No | No | No |
| [Foldable pose](/docs/commands#navigation) | Foldable models only | No | Foldable models only | No | No | No |
| [TV remote keys](/docs/commands#tv-targets) | No | No | No | No | No | No |
| [System and app settings helpers](/docs/commands#settings-helpers) | Yes | No | Yes | Yes | Clear app state only; other settings and reads unsupported | Clear app state only; other settings and reads unsupported |
| [Clipboard read and write](/docs/commands#clipboard) | Yes | No | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | No | No |
| [Push notification simulation](/docs/commands#push-notification-simulation) | Yes | No | Yes | Yes | No | No |
| [App event triggers through the app hook](/docs/commands#app-event-triggers-app-hook) | Yes | Yes | Yes | Yes | No | No |
| [Call and SMS simulation](/docs/commands#navigation) | No | No | Yes | No | No | No |

### System and hardware: TV targets

| Capability and reference | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| --- | --- | --- | --- | --- | --- |
| [Back](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes |
| [Home](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes |
| [Set screen orientation](/docs/commands#navigation) | Yes | Yes | No | No | No |
| [Phone hardware buttons](/docs/commands#navigation) | No | No | No | No | No |
| [iPhone Action Button](/docs/commands#navigation) | No | No | No | No | No |
| [Foldable pose](/docs/commands#navigation) | Foldable models only | No | No | No | No |
| [TV remote keys](/docs/commands#tv-targets) | Yes | Yes | Yes | Yes | Yes |
| [System and app settings helpers](/docs/commands#settings-helpers) | Yes | Yes | Set only; no reads | No | No |
| [Clipboard read and write](/docs/commands#clipboard) | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | Yes | No | No |
| [Push notification simulation](/docs/commands#push-notification-simulation) | Yes | Yes | Yes | No | No |
| [App event triggers through the app hook](/docs/commands#app-event-triggers-app-hook) | Yes | Yes | Yes | Yes | No |
| [Call and SMS simulation](/docs/commands#navigation) | Yes | No | No | No | No |

### System and hardware: desktop and web targets

| Capability and reference | macOS desktop | macOS app | Linux desktop | Web browser |
| --- | --- | --- | --- | --- |
| [Back](/docs/commands#navigation) | Yes | Yes | Yes | No |
| [Home](/docs/commands#navigation) | No | No | Yes | No |
| [Set screen orientation](/docs/commands#navigation) | No | No | No | No |
| [Phone hardware buttons](/docs/commands#navigation) | No | No | No | No |
| [iPhone Action Button](/docs/commands#navigation) | No | No | No | No |
| [Foldable pose](/docs/commands#navigation) | No | No | No | No |
| [TV remote keys](/docs/commands#tv-targets) | No | No | No | No |
| [System and app settings helpers](/docs/commands#settings-helpers) | Set only; no reads | No | No | No |
| [Clipboard read and write](/docs/commands#clipboard) | Yes | No | Yes | No |
| [Push notification simulation](/docs/commands#push-notification-simulation) | No | No | No | No |
| [App event triggers through the app hook](/docs/commands#app-event-triggers-app-hook) | Yes | Yes | No | No |
| [Call and SMS simulation](/docs/commands#navigation) | No | No | No | No |

### System and hardware: hosted provider sessions

| Capability and reference | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android | Revyl iOS | Revyl Android |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Back](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes |
| [Home](/docs/commands#navigation) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| [Set screen orientation](/docs/commands#navigation) | Set only; unlock unsupported | Set only; unlock unsupported | Set only; unlock unsupported | Set only; unlock unsupported | Set only; unlock unsupported | Yes | No | No |
| [Phone hardware buttons](/docs/commands#navigation) | Yes | Yes | Yes | Yes | No | Yes | No | No |
| [iPhone Action Button](/docs/commands#navigation) | No | No | No | No | No | No | No | No |
| [Foldable pose](/docs/commands#navigation) | No | No | No | No | No | No | No | No |
| [TV remote keys](/docs/commands#tv-targets) | No | No | No | No | No | No | No | No |
| [System and app settings helpers](/docs/commands#settings-helpers) | No | No | No | No | Set only; no reads | Yes | No | No |
| [Clipboard read and write](/docs/commands#clipboard) | Yes | Yes | Yes | Yes | Yes | Yes | No | No |
| [Push notification simulation](/docs/commands#push-notification-simulation) | No | No | No | No | No | No | No | No |
| [App event triggers through the app hook](/docs/commands#app-event-triggers-app-hook) | Yes | Yes | Yes | Yes | Yes | Yes | No | No |
| [Call and SMS simulation](/docs/commands#navigation) | No | No | No | No | No | No | No | No |

What a **Yes** does not claim:

- **Phone hardware buttons**: Each button is a separate operation; a target that answers the row still refuses buttons it does not model.
- **System and app settings helpers**: Each helper admits on its own, and a target may run only a subset of the helpers.
- **Clipboard read and write**: A **Yes** means the target exposes clipboard automation. Android depends on the build: AOSP clipboard services from `android13-release` through `android16-release` have no `cmd clipboard` implementation, so such a build refuses the commands, and on builds that answer, Android focus rules can still make a read come back blank.

## Capabilities that are not per-device commands

These come with the tool rather than with a target, so no column above decides them.

| Capability | What it needs | Where it is documented |
| --- | --- | --- |
| React component tree, inspect, and errors | Needs a React Native or Expo development build that registers the React DevTools backend, reachable through the app Metro dev server. No React DevTools window may be connected. | [React component tree, inspect, and errors](/docs/debugging-profiling#react-native-components) |
| React render profiling | Needs a development build of React Native 0.74 or later and its Metro dev server. Verified on Android emulators and iOS simulators, and over `proxy` and remote bridge sessions. | [React render profiling](/docs/debugging-profiling#react-native-performance-profiling) |
| JavaScript heap and profiles through CDP | Needs a Metro CDP target, so it applies to React Native and Expo apps. It runs a pinned npm helper on the agent host, and the first run may download it. | [JavaScript heap and profiles through CDP](/docs/debugging-profiling#react-native-js-memory-through-cdp) |
| Crash symbolication | Apple crash artifacts only (`.ips`, `.crash`, or log style), symbolicated against local `.dSYM` bundles with `atos`. Android Java and R8 mapping, and native `ndk-stack` output, are out of scope. | [Crash symbolication](/docs/debugging-profiling#crash-symbolication) |
| Native profiles and traces | Use `perf cpu profile` for Apple xctrace or Android simpleperf profiles, and `perf trace` for supported Apple xctrace or Android Perfetto captures; both need a supported app session. The separate `trace` command captures session diagnostic logs. | [Native profiles and traces](/docs/commands#tracing) |
| .ad replay scripts and the replay test runner | Runs supported `.ad` actions subject to target support and replay restrictions. Some resource operations are unavailable inside bounded replay even when they work standalone. | [.ad replay scripts and the replay test runner](/docs/replay-e2e#run-replay) |
| Batched command runs | Runs registry-approved batch commands serially in one session. Target admission still applies, and lifecycle and resource restrictions can reject operations that work standalone. | [Batched command runs](/docs/batching#run-a-batch-from-the-cli) |
| Maestro flow import and .ad export | Runs a documented subset of Maestro YAML on iOS and Android only. Exports compatible `.ad` actions to Maestro YAML; unsupported actions and selector shapes fail with source context, and semantic differences produce warnings. | [Maestro flow import and .ad export](/docs/run-maestro-flows#supported-subset) |
| MCP server | One `agent-device mcp` server per daemon exposes the device commands that mark themselves MCP-exposed, including provider sessions already connected on that daemon. | [MCP server](/docs/agent-setup#mcp-server) |
| Typed Node.js API | The typed client exposes device and session operations through domain methods and `client.command`. Daemon-backed methods share CLI command semantics and target restrictions; the client does not expose every CLI entry point. | [Typed Node.js API](/docs/client-api#command-methods) |
| Named sessions, leases, and parallel runs | Sessions and leases are daemon state, so parallel runs come from separate session names, device allowlists, and worktrees rather than from the target. Two worktrees can drive two platforms from one checkout. | [Named sessions, leases, and parallel runs](/docs/sessions#drive-two-platforms-from-one-checkout) |
| Remote daemon and device host | A `proxy` between the agent machine and the device host forwards the same daemon surface, so the device rows above apply across it. Provider clouds need no proxy. | [Remote daemon and device host](/docs/remote-proxy#what-the-proxy-exposes) |
| Hosted device providers | BrowserStack, AWS Device Farm, TestMu AI, Limrun, and Revyl appear as their own columns above. Provider artifact lookup after `close` works for the three WebDriver providers; Limrun and Revyl keep no artifacts. | [Hosted device providers](/docs/device-clouds#compare-providers) |
| Native, React Native, Expo, and Flutter apps | Native and Flutter apps use the interactions and accessibility data exposed by their target. React Native and Expo development builds can additionally expose React component inspection, render profiling, and Metro CDP tools when their documented prerequisites are met. | [Native, React Native, Expo, and Flutter apps](/docs/introduction#what-you-can-use-it-for) |

