# Capabilities

The target tables below are generated from the runtime command-admission facts that back the `capabilities` command: a command that leaves the code leaves this page. Labels, limits, and integration rows are maintained beside the generator, and command availability does not establish support for every operation, subcommand, or device model.
It covers agent-device 0.21.34-dev, generated 2026-10-27.

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

### Mobile targets

| Capability and reference                                                                                    | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| ----------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- | ---------------- | -------------- | ------------------ | ---------------- |
| [Accessibility snapshot and snapshot diff](/agent-device/pr-preview/pr-3938/docs/snapshots.md)              | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Refs, selectors, element lookup, and attribute reads](/agent-device/pr-preview/pr-3938/docs/selectors.md)  | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Screenshots](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                             | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Wait for text, selectors, and timeouts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |

### TV targets

| Capability and reference                                                                                    | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| ----------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | -------------- | ----------- | ------------- |
| [Accessibility snapshot and snapshot diff](/agent-device/pr-preview/pr-3938/docs/snapshots.md)              | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Refs, selectors, element lookup, and attribute reads](/agent-device/pr-preview/pr-3938/docs/selectors.md)  | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Screenshots](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                             | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Wait for text, selectors, and timeouts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes                 | Yes                         | Yes            | Yes         | No            |

### Desktop and web targets

| Capability and reference                                                                                    | macOS desktop | macOS app | Linux desktop | Web browser |
| ----------------------------------------------------------------------------------------------------------- | ------------- | --------- | ------------- | ----------- |
| [Accessibility snapshot and snapshot diff](/agent-device/pr-preview/pr-3938/docs/snapshots.md)              | Yes           | Yes       | Yes           | Yes         |
| [Refs, selectors, element lookup, and attribute reads](/agent-device/pr-preview/pr-3938/docs/selectors.md)  | Yes           | Yes       | Yes           | Yes         |
| [Screenshots](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                             | Yes           | Yes       | Yes           | Yes         |
| [Wait for text, selectors, and timeouts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes           | Yes       | Yes           | Yes         |

### Hosted provider sessions

| Capability and reference                                                                                    | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- | ----------------------- | ------------------- | ---------- | -------------- |
| [Accessibility snapshot and snapshot diff](/agent-device/pr-preview/pr-3938/docs/snapshots.md)              | Yes                                      | Yes                              | Yes                     | Yes                 | Yes        | Yes            |
| [Refs, selectors, element lookup, and attribute reads](/agent-device/pr-preview/pr-3938/docs/selectors.md)  | Yes                                      | Yes                              | Yes                     | Yes                 | Yes        | Yes            |
| [Screenshots](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                             | Yes                                      | Yes                              | Yes                     | Yes                 | Yes        | Yes            |
| [Wait for text, selectors, and timeouts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes                                      | Yes                              | Yes                     | Yes                 | Yes        | Yes            |

What a **Yes** does not claim:

- **Accessibility snapshot and snapshot diff**: A capture returns a tree only when the app or desktop exposes an accessibility tree.

## Interact with the app

### Mobile targets

| Capability and reference                                                                                     | iOS Simulator                         | iOS device (CoreDevice)               | Android emulator | Android device | HarmonyOS emulator                    | HarmonyOS device                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------- | ---------------- | -------------- | ------------------------------------- | ------------------------------------- |
| [Tap, press, fill, and type](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                 | Yes                                   | Yes                                   | Yes              | Yes            | Yes                                   | Yes                                   |
| [Long press](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                                 | Yes                                   | Yes                                   | Yes              | Yes            | Yes                                   | Yes                                   |
| [Scroll](/agent-device/pr-preview/pr-3938/docs/commands.md#scroll)                                           | Yes                                   | Yes                                   | Yes              | Yes            | Yes                                   | Yes                                   |
| [Gesture plans and swipes](/agent-device/pr-preview/pr-3938/docs/commands.md#pointer-and-gestures)           | Yes                                   | Yes                                   | Yes              | Yes            | Yes                                   | Yes                                   |
| [Hover and viewport size](/agent-device/pr-preview/pr-3938/docs/commands.md#web-automation)                  | No                                    | No                                    | No               | No             | No                                    | No                                    |
| [Read, accept, and dismiss system alerts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes                                   | Yes                                   | Yes              | Yes            | No                                    | No                                    |
| [Keyboard dismiss, enter, and status](/agent-device/pr-preview/pr-3938/docs/commands.md#keyboard)            | Dismiss and enter; status unsupported | Dismiss and enter; status unsupported | Yes              | Yes            | Dismiss and enter; status unsupported | Dismiss and enter; status unsupported |
| [React Native overlay dismissal](/agent-device/pr-preview/pr-3938/docs/commands.md#react-native-overlays)    | Yes                                   | Yes                                   | Yes              | Yes            | Yes                                   | Yes                                   |

### TV targets

| Capability and reference                                                                                     | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| ------------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------- | -------------- | ----------- | ------------- |
| [Tap, press, fill, and type](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                 | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Long press](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                                 | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Scroll](/agent-device/pr-preview/pr-3938/docs/commands.md#scroll)                                           | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Gesture plans and swipes](/agent-device/pr-preview/pr-3938/docs/commands.md#pointer-and-gestures)           | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Hover and viewport size](/agent-device/pr-preview/pr-3938/docs/commands.md#web-automation)                  | No                  | No                          | No             | No          | No            |
| [Read, accept, and dismiss system alerts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes                 | Yes                         | Yes            | No          | No            |
| [Keyboard dismiss, enter, and status](/agent-device/pr-preview/pr-3938/docs/commands.md#keyboard)            | Yes                 | Yes                         | No             | No          | No            |
| [React Native overlay dismissal](/agent-device/pr-preview/pr-3938/docs/commands.md#react-native-overlays)    | Yes                 | Yes                         | Yes            | Yes         | No            |

### Desktop and web targets

| Capability and reference                                                                                     | macOS desktop | macOS app | Linux desktop | Web browser |
| ------------------------------------------------------------------------------------------------------------ | ------------- | --------- | ------------- | ----------- |
| [Tap, press, fill, and type](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                 | Yes           | Yes       | Yes           | Yes         |
| [Long press](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                                 | Yes           | Yes       | Yes           | No          |
| [Scroll](/agent-device/pr-preview/pr-3938/docs/commands.md#scroll)                                           | Yes           | Yes       | Yes           | Yes         |
| [Gesture plans and swipes](/agent-device/pr-preview/pr-3938/docs/commands.md#pointer-and-gestures)           | Yes           | Yes       | Yes           | No          |
| [Hover and viewport size](/agent-device/pr-preview/pr-3938/docs/commands.md#web-automation)                  | No            | No        | No            | Yes         |
| [Read, accept, and dismiss system alerts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | Yes           | Yes       | No            | No          |
| [Keyboard dismiss, enter, and status](/agent-device/pr-preview/pr-3938/docs/commands.md#keyboard)            | No            | No        | No            | No          |
| [React Native overlay dismissal](/agent-device/pr-preview/pr-3938/docs/commands.md#react-native-overlays)    | Yes           | Yes       | Yes           | Yes         |

### Hosted provider sessions

| Capability and reference                                                                                     | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS           | AWS Device Farm Android | AWS Device Farm iOS                        | Limrun iOS | Limrun Android |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------ | ----------------------- | ------------------------------------------ | ---------- | -------------- |
| [Tap, press, fill, and type](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                 | Yes                                      | Yes                                        | Yes                     | Yes                                        | Yes        | Yes            |
| [Long press](/agent-device/pr-preview/pr-3938/docs/commands.md#interactions)                                 | Yes                                      | Yes                                        | Yes                     | Yes                                        | Yes        | Yes            |
| [Scroll](/agent-device/pr-preview/pr-3938/docs/commands.md#scroll)                                           | Yes                                      | Yes                                        | Yes                     | Yes                                        | Yes        | Yes            |
| [Gesture plans and swipes](/agent-device/pr-preview/pr-3938/docs/commands.md#pointer-and-gestures)           | Yes                                      | Yes                                        | Yes                     | Yes                                        | No         | Yes            |
| [Hover and viewport size](/agent-device/pr-preview/pr-3938/docs/commands.md#web-automation)                  | No                                       | No                                         | No                      | No                                         | No         | No             |
| [Read, accept, and dismiss system alerts](/agent-device/pr-preview/pr-3938/docs/commands.md#wait-and-alerts) | No                                       | No                                         | No                      | No                                         | Yes        | Yes            |
| [Keyboard dismiss, enter, and status](/agent-device/pr-preview/pr-3938/docs/commands.md#keyboard)            | Yes                                      | Dismiss only; status and enter unsupported | Yes                     | Dismiss only; status and enter unsupported | No         | Yes            |
| [React Native overlay dismissal](/agent-device/pr-preview/pr-3938/docs/commands.md#react-native-overlays)    | Yes                                      | Yes                                        | Yes                     | Yes                                        | Yes        | Yes            |

What a **Yes** does not claim:

- **Tap, press, fill, and type**: Android types non-ASCII text through the test input method: automatically on emulators, and on physical devices only with `open --test-ime`.
- **Gesture plans and swipes**: Multi-touch plans are part of `gesture` where the target runs them; a plan using an operation the target lacks fails at that step.
- **React Native overlay dismissal**: The command runs wherever tapping runs; it answers `detected: false` on a surface with no React Native overlay. Only iOS and Android apps present dismissable development overlays.

## Apps and devices

### Mobile targets

| Capability and reference                                                                                               | iOS Simulator | iOS device (CoreDevice) | Android emulator | Android device | HarmonyOS emulator | HarmonyOS device |
| ---------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- | ---------------- | -------------- | ------------------ | ---------------- |
| [Open and close apps, URLs, and deep links](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)              | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Install and reinstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-in-place)                 | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Uninstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-uninstall)                                    | Yes           | Yes                     | Yes              | Yes            | No                 | No               |
| [Install from a source URL](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-from-source-url)             | Yes           | Yes                     | Yes              | Yes            | No                 | No               |
| [Installed app list](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                        | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Foreground app state](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                      | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [App switcher](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                           | Yes           | Yes                     | Yes              | Yes            | Yes                | Yes              |
| [Get the device ready and boot simulators and emulators](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation) | Yes           | Yes                     | Yes              | Yes            | No                 | No               |
| [Shut down a simulator or emulator](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                      | Yes           | No                      | Yes              | No             | No                 | No               |
| [Prepare the Apple runner](/agent-device/pr-preview/pr-3938/docs/commands.md#prepare-apple-runner)                     | Yes           | Yes                     | No               | No             | No                 | No               |

### TV targets

| Capability and reference                                                                                               | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD)                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | -------------- | ----------- | ------------------------------------------------- |
| [Open and close apps, URLs, and deep links](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)              | Yes                 | Yes                         | Yes            | Yes         | App open/close only; URLs and deep links rejected |
| [Install and reinstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-in-place)                 | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [Uninstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-uninstall)                                    | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [Install from a source URL](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-from-source-url)             | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [Installed app list](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                        | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [Foreground app state](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                      | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [App switcher](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                           | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [Get the device ready and boot simulators and emulators](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation) | Yes                 | Yes                         | Yes            | Yes         | No                                                |
| [Shut down a simulator or emulator](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                      | Yes                 | No                          | Yes            | No          | No                                                |
| [Prepare the Apple runner](/agent-device/pr-preview/pr-3938/docs/commands.md#prepare-apple-runner)                     | No                  | No                          | Yes            | Yes         | No                                                |

### Desktop and web targets

| Capability and reference                                                                                               | macOS desktop | macOS app | Linux desktop | Web browser |
| ---------------------------------------------------------------------------------------------------------------------- | ------------- | --------- | ------------- | ----------- |
| [Open and close apps, URLs, and deep links](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)              | Yes           | Yes       | Yes           | Yes         |
| [Install and reinstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-in-place)                 | No            | No        | No            | No          |
| [Uninstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-uninstall)                                    | No            | No        | No            | No          |
| [Install from a source URL](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-from-source-url)             | No            | No        | No            | No          |
| [Installed app list](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                        | Yes           | Yes       | No            | No          |
| [Foreground app state](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                      | No            | No        | No            | No          |
| [App switcher](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                           | No            | No        | No            | No          |
| [Get the device ready and boot simulators and emulators](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation) | No            | No        | No            | No          |
| [Shut down a simulator or emulator](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                      | No            | No        | No            | No          |
| [Prepare the Apple runner](/agent-device/pr-preview/pr-3938/docs/commands.md#prepare-apple-runner)                     | Yes           | Yes       | No            | No          |

### Hosted provider sessions

| Capability and reference                                                                                               | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- | ----------------------- | ------------------- | ---------- | -------------- |
| [Open and close apps, URLs, and deep links](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)              | Yes                                      | Yes                              | Yes                     | Yes                 | Yes        | Yes            |
| [Install and reinstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-in-place)                 | Yes                                      | Yes                              | No                      | No                  | Yes        | Yes            |
| [Uninstall an app](/agent-device/pr-preview/pr-3938/docs/commands.md#app-uninstall)                                    | No                                       | No                               | No                      | No                  | No         | No             |
| [Install from a source URL](/agent-device/pr-preview/pr-3938/docs/commands.md#app-install-from-source-url)             | Yes                                      | Yes                              | No                      | No                  | Yes        | Yes            |
| [Installed app list](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                        | No                                       | No                               | No                      | No                  | Yes        | Yes            |
| [Foreground app state](/agent-device/pr-preview/pr-3938/docs/commands.md#app-state-and-app-lists)                      | No                                       | No                               | No                      | No                  | No         | Yes            |
| [App switcher](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                           | Yes                                      | Yes                              | Yes                     | Yes                 | No         | Yes            |
| [Get the device ready and boot simulators and emulators](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation) | Yes                                      | Yes                              | Yes                     | Yes                 | Yes        | Yes            |
| [Shut down a simulator or emulator](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                      | No                                       | No                               | No                      | No                  | No         | No             |
| [Prepare the Apple runner](/agent-device/pr-preview/pr-3938/docs/commands.md#prepare-apple-runner)                     | No                                       | No                               | No                      | No                  | No         | No             |

What a **Yes** does not claim:

- **Foreground app state**: On iOS and macOS a bound session that owns an app identity or surface answers this from its own state, even where the sessionless probe cannot see a foreground app.
- **Get the device ready and boot simulators and emulators**: On a simulator or emulator this starts the machine. On a physical or hosted device it waits for the device that is already provisioned to answer rather than starting one.

## Evidence and diagnostics

### Mobile targets

| Capability and reference                                                                                                                 | iOS Simulator | iOS device (CoreDevice)                                                        | Android emulator | Android device | HarmonyOS emulator                                                                                                      | HarmonyOS device                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ | ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [Screen recording](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                                                     | Yes           | Yes                                                                            | Yes              | Yes            | No                                                                                                                      | Yes                                                                                                                     |
| [App logs](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#logs)                                                            | Yes           | Yes                                                                            | Yes              | Yes            | Yes                                                                                                                     | Yes                                                                                                                     |
| [HTTP(S) request inspection](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#network-inspection)                            | Yes           | Yes                                                                            | Yes              | Yes            | No                                                                                                                      | No                                                                                                                      |
| [Performance samples (frames, memory, CPU profiles)](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#performance-snapshots) | Yes           | Frames, memory, and CPU profiles; memory-snapshot artifact reports unavailable | Yes              | Yes            | Process RSS memory sample only; frames, memory-snapshot artifacts, CPU profiles, and native captures report unavailable | Process RSS memory sample only; frames, memory-snapshot artifacts, CPU profiles, and native captures report unavailable |
| [Audio probe](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#audio-probes)                                                 | Yes           | No                                                                             | Yes              | No             | No                                                                                                                      | No                                                                                                                      |

### TV targets

| Capability and reference                                                                                                                 | Android TV emulator | Android TV / Fire OS device | tvOS Simulator | tvOS device | Vega OS (VVD) |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | -------------- | ----------- | ------------- |
| [Screen recording](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                                                     | Yes                 | Yes                         | Yes            | Yes         | No            |
| [App logs](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#logs)                                                            | Yes                 | Yes                         | Yes            | Yes         | No            |
| [HTTP(S) request inspection](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#network-inspection)                            | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Performance samples (frames, memory, CPU profiles)](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#performance-snapshots) | Yes                 | Yes                         | Yes            | Yes         | No            |
| [Audio probe](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#audio-probes)                                                 | Yes                 | No                          | Yes            | No          | No            |

### Desktop and web targets

| Capability and reference                                                                                                                 | macOS desktop | macOS app | Linux desktop | Web browser                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------- | ------------- | ----------------------------------------------- |
| [Screen recording](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                                                     | Yes           | Yes       | No            | Yes                                             |
| [App logs](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#logs)                                                            | Yes           | Yes       | No            | No                                              |
| [HTTP(S) request inspection](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#network-inspection)                            | Yes           | Yes       | No            | Yes                                             |
| [Performance samples (frames, memory, CPU profiles)](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#performance-snapshots) | Yes           | Yes       | No            | No                                              |
| [Audio probe](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#audio-probes)                                                 | Yes           | No        | No            | Page media probe only; host capture unsupported |

### Hosted provider sessions

| Capability and reference                                                                                                                 | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android | AWS Device Farm iOS | Limrun iOS | Limrun Android |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- | ----------------------- | ------------------- | ---------- | -------------- |
| [Screen recording](/agent-device/pr-preview/pr-3938/docs/commands.md#media-and-logs)                                                     | No                                       | No                               | No                      | No                  | Yes        | Yes            |
| [App logs](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#logs)                                                            | No                                       | No                               | No                      | No                  | Yes        | Yes            |
| [HTTP(S) request inspection](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#network-inspection)                            | No                                       | No                               | No                      | No                  | Yes        | Yes            |
| [Performance samples (frames, memory, CPU profiles)](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#performance-snapshots) | No                                       | No                               | No                      | No                  | No         | No             |
| [Audio probe](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#audio-probes)                                                 | No                                       | No                               | No                      | No                  | No         | No             |

What a **Yes** does not claim:

- **Screen recording**: An iOS physical device records runner screenshots, not a native video stream: no audio, and dropped frames are expected. An Android clip covers 180 seconds, and a longer recording arrives as chunks.
- **HTTP(S) request inspection**: Local native app sessions inspect the HTTP(S) entries present in the session app log; traffic absent from those logs is not captured. The three WebDriver provider clouds refuse a live dump: their traffic is on the provider side, and TestMu AI can return provider network-log artifacts after the session ends. Managed web sessions inspect the browser request history.
- **Audio probe**: A simulator, emulator, or macOS desktop session samples host system audio, which works on a macOS agent host and needs Screen Recording permission there.

## System and hardware

### Mobile targets

| Capability and reference                                                                                                 | iOS Simulator                     | iOS device (CoreDevice)           | Android emulator                                                    | Android device                                                      | HarmonyOS emulator                                         | HarmonyOS device                                           |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| [Back](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                               | Yes                               | Yes                                                                 | Yes                                                                 | Yes                                                        | Yes                                                        |
| [Home](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                               | Yes                               | Yes                                                                 | Yes                                                                 | Yes                                                        | Yes                                                        |
| [Set screen orientation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | Set only; unlock unsupported      | Set only; unlock unsupported      | Yes                                                                 | Yes                                                                 | No                                                         | No                                                         |
| [Phone hardware buttons](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | No                                | Volume only                       | Yes                                                                 | Yes                                                                 | No                                                         | No                                                         |
| [iPhone Action Button](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                     | Models with an Action Button only | Models with an Action Button only | No                                                                  | No                                                                  | No                                                         | No                                                         |
| [Foldable pose](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                            | Foldable models only              | No                                | Foldable models only                                                | No                                                                  | No                                                         | No                                                         |
| [TV remote keys](/agent-device/pr-preview/pr-3938/docs/commands.md#tv-targets)                                           | No                                | No                                | No                                                                  | No                                                                  | No                                                         | No                                                         |
| [System and app settings helpers](/agent-device/pr-preview/pr-3938/docs/commands.md#settings-helpers)                    | Yes                               | No                                | Yes                                                                 | Yes                                                                 | Clear app state only; other settings and reads unsupported | Clear app state only; other settings and reads unsupported |
| [Clipboard read and write](/agent-device/pr-preview/pr-3938/docs/commands.md#clipboard)                                  | Yes                               | No                                | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | No                                                         | No                                                         |
| [Push notification simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#push-notification-simulation)           | Yes                               | No                                | Yes                                                                 | Yes                                                                 | No                                                         | No                                                         |
| [App event triggers through the app hook](/agent-device/pr-preview/pr-3938/docs/commands.md#app-event-triggers-app-hook) | Yes                               | Yes                               | Yes                                                                 | Yes                                                                 | No                                                         | No                                                         |
| [Call and SMS simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                  | No                                | No                                | Yes                                                                 | No                                                                  | No                                                         | No                                                         |

### TV targets

| Capability and reference                                                                                                 | Android TV emulator                                                 | Android TV / Fire OS device                                         | tvOS Simulator     | tvOS device | Vega OS (VVD) |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ | ----------- | ------------- |
| [Back](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                                                                 | Yes                                                                 | Yes                | Yes         | Yes           |
| [Home](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                                                                 | Yes                                                                 | Yes                | Yes         | Yes           |
| [Set screen orientation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | Yes                                                                 | Yes                                                                 | No                 | No          | No            |
| [Phone hardware buttons](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | No                                                                  | No                                                                  | No                 | No          | No            |
| [iPhone Action Button](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                     | No                                                                  | No                                                                  | No                 | No          | No            |
| [Foldable pose](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                            | Foldable models only                                                | No                                                                  | No                 | No          | No            |
| [TV remote keys](/agent-device/pr-preview/pr-3938/docs/commands.md#tv-targets)                                           | Yes                                                                 | Yes                                                                 | Yes                | Yes         | Yes           |
| [System and app settings helpers](/agent-device/pr-preview/pr-3938/docs/commands.md#settings-helpers)                    | Yes                                                                 | Yes                                                                 | Set only; no reads | No          | No            |
| [Clipboard read and write](/agent-device/pr-preview/pr-3938/docs/commands.md#clipboard)                                  | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | Build-dependent; unavailable on AOSP builds without `cmd clipboard` | Yes                | No          | No            |
| [Push notification simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#push-notification-simulation)           | Yes                                                                 | Yes                                                                 | Yes                | No          | No            |
| [App event triggers through the app hook](/agent-device/pr-preview/pr-3938/docs/commands.md#app-event-triggers-app-hook) | Yes                                                                 | Yes                                                                 | Yes                | Yes         | No            |
| [Call and SMS simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                  | Yes                                                                 | No                                                                  | No                 | No          | No            |

### Desktop and web targets

| Capability and reference                                                                                                 | macOS desktop      | macOS app | Linux desktop | Web browser |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------ | --------- | ------------- | ----------- |
| [Back](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                | Yes       | Yes           | No          |
| [Home](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | No                 | No        | Yes           | No          |
| [Set screen orientation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | No                 | No        | No            | No          |
| [Phone hardware buttons](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | No                 | No        | No            | No          |
| [iPhone Action Button](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                     | No                 | No        | No            | No          |
| [Foldable pose](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                            | No                 | No        | No            | No          |
| [TV remote keys](/agent-device/pr-preview/pr-3938/docs/commands.md#tv-targets)                                           | No                 | No        | No            | No          |
| [System and app settings helpers](/agent-device/pr-preview/pr-3938/docs/commands.md#settings-helpers)                    | Set only; no reads | No        | No            | No          |
| [Clipboard read and write](/agent-device/pr-preview/pr-3938/docs/commands.md#clipboard)                                  | Yes                | No        | Yes           | No          |
| [Push notification simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#push-notification-simulation)           | No                 | No        | No            | No          |
| [App event triggers through the app hook](/agent-device/pr-preview/pr-3938/docs/commands.md#app-event-triggers-app-hook) | Yes                | Yes       | No            | No          |
| [Call and SMS simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                  | No                 | No        | No            | No          |

### Hosted provider sessions

| Capability and reference                                                                                                 | BrowserStack Android / TestMu AI Android | BrowserStack iOS / TestMu AI iOS | AWS Device Farm Android      | AWS Device Farm iOS          | Limrun iOS                   | Limrun Android |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------- | ---------------------------- | ---------------------------- | ---------------------------- | -------------- |
| [Back](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                                      | Yes                              | Yes                          | Yes                          | Yes                          | Yes            |
| [Home](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                                     | Yes                                      | Yes                              | Yes                          | Yes                          | Yes                          | Yes            |
| [Set screen orientation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | Set only; unlock unsupported             | Set only; unlock unsupported     | Set only; unlock unsupported | Set only; unlock unsupported | Set only; unlock unsupported | Yes            |
| [Phone hardware buttons](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                   | Yes                                      | Yes                              | Yes                          | Yes                          | No                           | Yes            |
| [iPhone Action Button](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                     | No                                       | No                               | No                           | No                           | No                           | No             |
| [Foldable pose](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                            | No                                       | No                               | No                           | No                           | No                           | No             |
| [TV remote keys](/agent-device/pr-preview/pr-3938/docs/commands.md#tv-targets)                                           | No                                       | No                               | No                           | No                           | No                           | No             |
| [System and app settings helpers](/agent-device/pr-preview/pr-3938/docs/commands.md#settings-helpers)                    | No                                       | No                               | No                           | No                           | Set only; no reads           | Yes            |
| [Clipboard read and write](/agent-device/pr-preview/pr-3938/docs/commands.md#clipboard)                                  | Yes                                      | Yes                              | Yes                          | Yes                          | Yes                          | Yes            |
| [Push notification simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#push-notification-simulation)           | No                                       | No                               | No                           | No                           | No                           | No             |
| [App event triggers through the app hook](/agent-device/pr-preview/pr-3938/docs/commands.md#app-event-triggers-app-hook) | Yes                                      | Yes                              | Yes                          | Yes                          | Yes                          | Yes            |
| [Call and SMS simulation](/agent-device/pr-preview/pr-3938/docs/commands.md#navigation)                                  | No                                       | No                               | No                           | No                           | No                           | No             |

What a **Yes** does not claim:

- **Phone hardware buttons**: Each button is a separate operation; a target that answers the row still refuses buttons it does not model.
- **System and app settings helpers**: Each helper admits on its own, and a target may run only a subset of the helpers.
- **Clipboard read and write**: A **Yes** means the target exposes clipboard automation. Android depends on the build: AOSP clipboard services from `android13-release` through `android16-release` have no `cmd clipboard` implementation, so such a build refuses the commands, and on builds that answer, Android focus rules can still make a read come back blank.

## Capabilities that are not per-device commands

These come with the tool rather than with a target, so no column above decides them.

| Capability                                    | What it needs                                                                                                                                                                                                                                                                | Where it is documented                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| React component tree, inspect, and errors     | Needs a React Native or Expo development build that registers the React DevTools backend, reachable through the app Metro dev server. No React DevTools window may be connected.                                                                                             | [React component tree, inspect, and errors](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#react-native-components)           |
| React render profiling                        | Needs a development build of React Native 0.74 or later and its Metro dev server. Verified on Android emulators and iOS simulators, and over `proxy` and remote bridge sessions.                                                                                             | [React render profiling](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#react-native-performance-profiling)                   |
| JavaScript heap and profiles through CDP      | Needs a Metro CDP target, so it applies to React Native and Expo apps. It runs a pinned npm helper on the agent host, and the first run may download it.                                                                                                                     | [JavaScript heap and profiles through CDP](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#react-native-js-memory-through-cdp) |
| Crash symbolication                           | Apple crash artifacts only (`.ips`, `.crash`, or log style), symbolicated against local `.dSYM` bundles with `atos`. Android Java and R8 mapping, and native `ndk-stack` output, are out of scope.                                                                           | [Crash symbolication](/agent-device/pr-preview/pr-3938/docs/debugging-profiling.md#crash-symbolication)                                     |
| Native profiles and traces                    | Use `perf cpu profile` for Apple xctrace or Android simpleperf profiles, and `perf trace` for supported Apple xctrace or Android Perfetto captures; both need a supported app session. The separate `trace` command captures session diagnostic logs.                        | [Native profiles and traces](/agent-device/pr-preview/pr-3938/docs/commands.md#tracing)                                                     |
| .ad replay scripts and the replay test runner | Runs supported `.ad` actions subject to target support and replay restrictions. Some resource operations are unavailable inside bounded replay even when they work standalone.                                                                                               | [.ad replay scripts and the replay test runner](/agent-device/pr-preview/pr-3938/docs/replay-e2e.md#run-replay)                             |
| Batched command runs                          | Runs registry-approved batch commands serially in one session. Target admission still applies, and lifecycle and resource restrictions can reject operations that work standalone.                                                                                           | [Batched command runs](/agent-device/pr-preview/pr-3938/docs/batching.md#run-a-batch-from-the-cli)                                          |
| Maestro flow import and .ad export            | Runs a documented subset of Maestro YAML on iOS and Android only. Exports compatible `.ad` actions to Maestro YAML; unsupported actions and selector shapes fail with source context, and semantic differences produce warnings.                                             | [Maestro flow import and .ad export](/agent-device/pr-preview/pr-3938/docs/run-maestro-flows.md#supported-subset)                           |
| MCP server                                    | One `agent-device mcp` server per daemon exposes the device commands that mark themselves MCP-exposed, including provider sessions already connected on that daemon.                                                                                                         | [MCP server](/agent-device/pr-preview/pr-3938/docs/agent-setup.md#mcp-server)                                                               |
| Typed Node.js API                             | The typed client exposes device and session operations through domain methods and `client.command`. Daemon-backed methods share CLI command semantics and target restrictions; the client does not expose every CLI entry point.                                             | [Typed Node.js API](/agent-device/pr-preview/pr-3938/docs/client-api.md#command-methods)                                                    |
| Named sessions, leases, and parallel runs     | Sessions and leases are daemon state, so parallel runs come from separate session names, device allowlists, and worktrees rather than from the target. Two worktrees can drive two platforms from one checkout.                                                              | [Named sessions, leases, and parallel runs](/agent-device/pr-preview/pr-3938/docs/sessions.md#drive-two-platforms-from-one-checkout)        |
| Remote daemon and device host                 | A `proxy` between the agent machine and the device host forwards the same daemon surface, so the device rows above apply across it. Provider clouds need no proxy.                                                                                                           | [Remote daemon and device host](/agent-device/pr-preview/pr-3938/docs/remote-proxy.md#what-the-proxy-exposes)                               |
| Hosted device providers                       | BrowserStack, AWS Device Farm, TestMu AI, and Limrun appear as their own columns above. Provider artifact lookup after `close` works for the three WebDriver providers; Limrun keeps no artifacts.                                                                           | [Hosted device providers](/agent-device/pr-preview/pr-3938/docs/device-clouds.md#compare-providers)                                         |
| Native, React Native, Expo, and Flutter apps  | Native and Flutter apps use the interactions and accessibility data exposed by their target. React Native and Expo development builds can additionally expose React component inspection, render profiling, and Metro CDP tools when their documented prerequisites are met. | [Native, React Native, Expo, and Flutter apps](/agent-device/pr-preview/pr-3938/docs/introduction.md#what-you-can-use-it-for)               |
