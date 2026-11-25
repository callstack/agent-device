---
title: Commands
---

Find the command for a task and what to know before you run it on each platform. Each command's entry starts with a block generated from the CLI itself: its summary, synopsis, and options. The notes after it cover workflows, platform differences, and failure cases.

CLI help matches your installed version and is the exact reference. `agent-device help` lists the workflow and platform guides, and `help <command>` gives one command's exact behavior:

```bash
agent-device help
agent-device help workflow
agent-device help open
```

For persistent defaults and project-scoped CLI settings, see [Configuration](/docs/configuration). For MCP clients, see [MCP server](#mcp-server).

## Common options

<!-- generated:common-options -->

These options are allowed by 5 or more commands, so they are documented here once: `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`, `--out <path>`. A command's own entry omits them and names them in its `Also accepts` line. The shared row is the general case: where a command's semantics differ, that command states its own row.

| Option | What it does |
| --- | --- |
| `--settle` | After the action, wait for the UI to go quiet and return the settled diff vs the pre-action tree in the same response (best-effort; never fails the action) |
| `--settle-quiet <ms>` | Settle: quiet window the UI must hold to count as settled (default 500ms; 300ms when the settled tree comes from the iOS simulator snapshot bridge). On iOS, a broad screen replacement such as a modal dismissal is confirmed for at least 1500ms whatever window is asked for, within the --timeout settle deadline; a replacement from a screen the pre-action capture read as presenting nothing, such as a tab switch, gets no 1500ms confirmation and keeps the asked window |
| `--timeout <ms>` | Boot/Open/Prepare: startup budget covering the device boot (and runner preparation for prepare). Replay/Snapshot/Test: maximum wall-clock time for the command or attempt. With --settle: the settle-wait deadline (default 10s) |
| `--depth, -d <depth>` | Snapshot: limit snapshot depth |
| `--scope, -s <scope>` | Snapshot: scope snapshot to label/identifier |
| `--raw` | Snapshot: raw node output |
| `--out <path>` | Output path |

Exact behavior for one command: `agent-device help <command>`.

<!-- /generated -->

## Output and warnings

In text mode, every command prints each response warning as a `Warning:` line after its own output.
`get`, `find`, `clipboard`, and `record` print those lines on **stderr** instead, so
`value=$(agent-device get text …)` captures only the value. With `--json`, warnings stay in
`data.warnings` and no `Warning:` line is printed.

Text from a device or a remote daemon, such as a label or a file path, can hold control characters. The CLI prints them as JSON escapes such as `\u001b`, so printed JSON still parses back to the exact values. MCP and AI SDK structured content keeps the exact values.

## Navigation

```bash
agent-device boot --platform android --device Pixel_9_Pro_XL --headless
agent-device boot --platform ios --pick newest
agent-device shutdown --platform android --device Pixel_9_Pro_XL
agent-device open "https://example.com" --platform ios           # open link in web browser
agent-device open MyApp "myapp://screen/to" --platform ios       # open deep link to MyApp
agent-device open com.example.myapp --platform android --serial emulator-5554 --session my-session --relaunch
agent-device close
agent-device back
agent-device orientation landscape-left
agent-device hardware-button volume-up
agent-device lock-screen lock
agent-device fold half-open
agent-device telephony sms 5551234 "Your code is 1234"
agent-device device status --platform android --serial emulator-5554
agent-device device release --stale
agent-device daemon stop --clean
agent-device daemon status --json
```

Boot and shut down:

<!-- generated:command boot -->

Boot target device/simulator.

```bash
agent-device boot [--headless] [--pick newest] [--timeout <ms>]
```

| Option | What it does |
| --- | --- |
| `--headless` | Boot: launch Android emulator without a GUI window |
| `--pick newest` | Boot: when several equally preferred matches are all shut down, boot one (mobile over TV, newest OS, then name) instead of failing; booted ties still fail |

Also accepts: [common options](#common-options): `--timeout <ms>`.

Supported targets: [Get the device ready and boot simulators and emulators](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help boot`.

<!-- /generated -->

<!-- generated:command shutdown -->

Shutdown target simulator/emulator.

```bash
agent-device shutdown
```

Supported targets: [Shut down a simulator or emulator](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help shutdown`.

<!-- /generated -->

- `open` boots the device when needed, so you mainly need `boot` when you want a device ready without an app.
- When several shut-down devices match equally, `boot` fails with `AMBIGUOUS_MATCH`. Add `--pick newest` to choose one; it never picks between booted or provider devices.
- `shutdown` refuses a device that an active session uses. End that session with `close --shutdown` first. On [Limrun](/docs/limrun#create-and-delete-an-instance), `shutdown` deletes an instance that agent-device created, or releases an attachment to an existing one.
- A never-booted iOS Simulator can take minutes to boot. If the `--timeout` runs out, the command fails with `boot_timeout` and the device keeps booting, so a retry finds it further along. See [Sessions](/docs/sessions#wait-for-a-slow-or-busy-device).
- On macOS, the Android emulator window opens behind the focused app. This is best-effort: the emulator can still take focus if the focused app cannot be read, or if its window appears after the startup budget runs out.

Select a device:

- `--platform apple` covers iOS, tvOS, and macOS. Add `--target mobile|tv|desktop` to choose phone or tablet, TV, or desktop targets.
- With no `--device`, `--udid`, or `--serial`, a command that needs one device prefers virtual over physical and booted over offline devices. If several still tie, such as two booted emulators, it fails with `AMBIGUOUS_MATCH` and lists the candidates. Commands inside a session use the session's device.
- Commands without `--session` use an implicit session for your worktree and platform. For named sessions and `--session-lock`, see [Sessions](/docs/sessions).

Device claims and the daemon:

<!-- generated:command device -->

Inspect and recover enforced local device ownership without a daemon.

```bash
agent-device device status|release [--platform <platform>] [--udid <udid>] [--serial <serial>] [--stale]
```

| Option | What it does |
| --- | --- |
| `--stale` | Device status: show only claims with a provably stale owner |

Exact behavior: `agent-device help device`.

<!-- /generated -->

<!-- generated:command daemon -->

Stop a local daemon or show the providers it registered.

```bash
agent-device daemon stop [--clean] [--state-dir <path>] | daemon status [--state-dir <path>]
```

**`daemon stop`**

| Option | What it does |
| --- | --- |
| `--clean` | Daemon stop: remove retained runner processes and leases after stopping |

**`daemon status`**

Reads no options.

Exact behavior: `agent-device help daemon`.

<!-- /generated -->

- Each session claims its device. When another owner holds the claim, `open` fails with `DEVICE_IN_USE` and one of these reasons: `DEVICE_CLAIM_LIVE_OWNER`, `DEVICE_CLAIM_RECOVERY_PENDING`, or `DEVICE_CLAIM_OWNER_UNCERTAIN`. Nothing reached the device. If the device rebooted after the claim was taken, `open` takes the claim instead and reports the release in `warnings`. To wait for a held device, pass `open --wait <ms>`. See [Sessions](/docs/sessions#release-a-device-another-session-or-workspace-holds).
- `device status --json` shows whether a new session can take each device now (`acquirable`) and what blocks it (`blockedBy`). It does not contact the daemon or run recovery, so `open` can still decide differently.
- `device release --stale` clears a claim whose owner provably cannot release it, such as an exited process. It refuses live and uncertain owners.
- A command that needs the local daemon starts it when none runs. A daemon from another version is replaced only when it holds no work. Otherwise the command fails with `daemon-busy`. A daemon from a release too old to report its work fails with `daemon-incompatible`. End it deliberately with `daemon stop`. Node.js clients can choose differently; see [Daemon lifecycle](/docs/client-api#daemon-lifecycle).
- `daemon stop --clean` also removes the Apple runner processes and leases that daemon kept.
- On Windows, `daemon stop` force-terminates the daemon at once (`mode: "forced"`, `cleanupConfidence: "unknown"`) rather than waiting for an in-process teardown.
- On macOS, `daemon stop` can refuse a daemon that an older build started, with `details.terminationReason: identity-unverified`. Stop it with the build that started it, or send `SIGTERM` to its recorded PID. Do not run an older and a newer build on one macOS host: device claims and runner leases are shared by the host.
- `daemon stop` refuses a daemon that a host process embeds (`daemon-owner-embedded`). Close it in that process with the handle from `startAgentDevice()`. For the other refusals, see [Daemon lifecycle](/docs/client-api#daemon-lifecycle).
- `daemon status` reads the daemon's record without contacting it, including each registered provider and why a plugin failed to register. See [provider plugins](/docs/plugins).
- A `--state-dir` or `AGENT_DEVICE_STATE_DIR` must be a private directory of your own account. agent-device refuses one that another account owns or can write. See [Supported environment variables](/docs/configuration#supported-environment-variables).

Open apps and links:

<!-- generated:command open -->

Open an app, deep link or URL, save replays.

```bash
agent-device open [appOrUrl] [url] [--activity <component>] [--launch-console <path>] [--launch-args <arg>] [--test-ime] [--no-test-ime] [--save-script [path]] [--force, --overwrite] [--no-record] [--relaunch] [--foreground] [--timeout <ms>] [--wait <ms>] [--surface app|frontmost-app|desktop|menubar] [--metro-host <host>] [--metro-port <port>] [--bundle-url <url>] [--launch-url <url>] [--os <version|range>] [--image-tag <tag>] [--device-mode <slim|full>] [--device-baseline <name>] [--physical]
```

Aliases: `launch`, `relaunch`.

| Option | What it does |
| --- | --- |
| `--force, --overwrite` | Force replacement of existing state (connect: replace an active connection; --save-script: overwrite an existing target instead of refusing) |
| `--os <version\|range>` | Proxy lease: OS version or range the backend picks the device by (Android: API level); refused without such a backend |
| `--image-tag <tag>` | Proxy lease: Android system image tag the backend picks the device by; refused without such a backend |
| `--device-mode <slim\|full>` | Proxy lease: iOS simulator mode (slim or full) the backend leases; refused without such a backend |
| `--device-baseline <name>` | Proxy lease: saved device state (baseline) the backend restores on the leased device; refused without such a backend |
| `--physical` | Proxy lease: ask the backend for a physical device instead of a simulator or emulator; refused without such a backend |
| `--surface app\|frontmost-app\|desktop\|menubar` | macOS session surface for open (defaults to app) |
| `--metro-host <host>` | Session-scoped Metro/debug host hint |
| `--metro-port <port>` | Session-scoped Metro/debug port hint; on an emulator/simulator the host defaults to the loopback alias, physical devices still need --metro-host |
| `--bundle-url <url>` | Session-scoped bundle URL hint |
| `--launch-url <url>` | Session-scoped deep link / launch URL hint |
| `--test-ime` | open/test/replay: activate the headless Android test IME for deterministic Unicode text entry (default on for emulators; opt-in on real devices; on test/replay it applies to the sessions the flow opens) |
| `--no-test-ime` | open/test/replay: keep the real Android keyboard even on emulators (opt out of the headless test IME; on test/replay it applies to the sessions the flow opens) |
| `--activity <component>` | Android launch activity (package/Class, .Class, or Class) or HarmonyOS ability name; not for URL opens |
| `--launch-console <path>` | open: capture the initial local or Limrun iOS simulator launch console window to a file |
| `--launch-args <arg>` | open: repeatable launch argument forwarded verbatim to the platform launch command (iOS app process args; Android adb shell am start args). Linux and macOS reject the flag. |
| `--no-post-gesture-stabilization` | Scroll, swipe, gesture swipe, open: skip the movement check and the stabilization wait that follow a gesture, and on a local iOS simulator the first-screen wait after an app launch; use it only when your own polling verifies the screen |
| `--save-script [path]` | Arm evidence capture on open, publish the armed recording on close; close --save-script alone (without an armed open) is rejected — start with open --save-script, or use session save-script mid-session. Optional custom output path. On Windows, absolute paths need a drive letter or ordinary UNC share. |
| `--relaunch` | open: terminate app process before launching it |
| `--foreground` | open: keep normal app/device selection and return an initial snapshot of the first screen (a local iOS simulator waits up to 10s for it); without an app, resolve the sole running app on the sole booted iOS simulator; on HarmonyOS with an app target, fail when the launched app does not hold the foreground within 5s |
| `--no-record` | Do not record this action |
| `--wait <ms>` | Open: wait up to n ms for a device another session is holding before failing with DEVICE_IN_USE |

Also accepts: [common options](#common-options): `--timeout <ms>`.

Supported targets: [Open and close apps, URLs, and deep links](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help open`.

<!-- /generated -->

<!-- generated:command close -->

Close an app or end the session.

```bash
agent-device close [app] [--save-script [path]] [--force, --overwrite] [--shutdown]
```

| Option | What it does |
| --- | --- |
| `--force, --overwrite` | Force replacement of existing state (connect: replace an active connection; --save-script: overwrite an existing target instead of refusing) |
| `--save-script [path]` | Arm evidence capture on open, publish the armed recording on close; close --save-script alone (without an armed open) is rejected — start with open --save-script, or use session save-script mid-session. Optional custom output path. On Windows, absolute paths need a drive letter or ordinary UNC share. |
| `--shutdown` | close, disconnect: also shut down the session device where supported; a Limrun instance agent-device created is deleted with its data, an attached one keeps running. close also releases a lease or attachment kept on close |

Supported targets: [Open and close apps, URLs, and deep links](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help close`.

<!-- /generated -->

- `open <url>` opens deep links on Android and iOS, and `open <app> <url>` opens a deep link in that app on iOS. For macOS, see [Desktop targets](#desktop-targets).
- On iOS devices, `http(s)://` URLs open in Safari when no app is active. Custom-scheme URLs need an active app.
- Remote daemons refuse `file:` URLs with `REMOTE_HOST_INPUT_DENIED`. Serve local content over HTTP(S) instead.
- On a local iOS Simulator, the first capture after `open` waits for the app's first screen. If the wait ends first, the snapshot warns with `postGestureOutcome.kind: "loading"` or `"unsettled"`. Run `snapshot -i` or `wait text <expected>` before you act. An app whose first screen has no labeled controls, such as a game canvas, always waits the full time; pass `--no-post-gesture-stabilization` to skip the wait.
- `open --wait <ms>` waits for a device that another session holds. A claim held by another workspace is not waited for: `open` returns the recovery command at once. `install` and `reinstall` never wait.
- If an app on an iOS simulator shows an empty accessibility tree after an earlier XCTest session, run `open <app> --relaunch`, then `snapshot -i`.
- Android React Native: `open --relaunch` needs an installed package name, not an APK path. For Metro-served JS changes, run `metro reload` instead.
- `--metro-host`, `--metro-port`, `--bundle-url`, and `--launch-url` apply to the app that `open` opens. A later `open` without these flags applies them again only when it opens the same app. It opens another app, such as a system app, without them. An `open` that passes these flags for another app also removes the earlier hints from the app an earlier `open` applied them to.
- ADB-backed Android: `open settings --relaunch` restarts the app that the intent opened. It fails when the intent matches more than one activity.
- ADB-backed Android: `close` fails with `android-app-close-timeout` when the app does not leave the foreground or its processes do not exit in time. It fails with `android-process-probe-unavailable` when it cannot list the app's processes; if that happens before the stop, the app keeps running.
- On HarmonyOS, `open` reads the foreground app after the launch dispatch, for up to 5 seconds. When the opened app never holds the foreground, the open succeeds and `warnings` name it `open-not-foreground` with the app that holds the foreground, or the fact that no mission is foreground. A lock screen is a typical cause: unlock the device, then run the open again. When no read of the mission list succeeds in that budget, the warning names `open-foreground-probe-unreadable` instead and claims nothing about the app: check the device connection. With `--foreground`, an unconfirmed open fails with `details.reason: open-not-foreground` or `open-foreground-probe-unreadable`, matching the same two cases.
- If `close` cannot confirm its cleanup, it keeps the session and its device claim. Run `close` again with the same options to release the device, without `--save-script` if the first attempt saved the script. The same applies when `open --relaunch` cannot confirm its effects.

iOS Simulator launch prompt:

- When `open <app> --launch-url <url>` raises an `Open in "<App>"?` prompt for a scheme the session app owns, `open` taps **Open** and returns `launchConfirmation: "accepted"`. It reads the prompt in the Simulator's language.
- `launchConfirmation: "unanswered"` leaves the prompt on screen. For `launchConfirmationReason: url-owner-unresolved`, answer it with `alert accept`. For `alert-unrecognized`, read it with `alert get` first: it can be the app's own alert, such as a permission prompt.
- `launchConfirmationProbeFailure` means `open` could not tell whether a prompt is up. Check with `alert get` before you retry.
- `launch_confirmation_unanswered` means the app did not start after the prompt, or the prompt stayed up. Answer it with `alert accept` or `alert dismiss`.
- `launch_confirmation_foreign_app` means another app owns the scheme (`details.foreignAppBundleId`). Dismiss the prompt with `alert dismiss` and pass a URL that your app handles.
- `ios-simulator-openurl-timeout` means the Simulator did not answer the URL hand-off. It may still have received the URL, so check the screen, then retry or run `alert accept`.
- A prompt that appears after `open` saw the app is not answered. Use `alert accept`.

Back, orientation, and hardware buttons:

<!-- generated:command back -->

Navigate back in the app or system.

```bash
agent-device back [--in-app|--system] [--settle]
```

| Option | What it does |
| --- | --- |
| `--in-app` | Back: use app-provided back UI when available; on iOS, the one hittable navigation bar back button, confirmed by a bar change, else the verified left-edge back swipe |
| `--system` | Back: use system back input or gesture when available; on iOS, the same back as --in-app |

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`.

Supported targets: [Back](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help back`.

<!-- /generated -->

<!-- generated:command home -->

Go to the device home screen.

```bash
agent-device home
```

Supported targets: [Home](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help home`.

<!-- /generated -->

<!-- generated:command app-switcher -->

Open the device app switcher.

```bash
agent-device app-switcher
```

Supported targets: [App switcher](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help app-switcher`.

<!-- /generated -->

<!-- generated:command orientation -->

Set device orientation.

```bash
agent-device orientation <portrait|portrait-upside-down|landscape-left|landscape-right|auto>
```

Supported targets: [Set screen orientation](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help orientation`.

<!-- /generated -->

<!-- generated:command action-button -->

Press the iPhone, iPad, or Apple Watch Ultra Action Button.

```bash
agent-device action-button
```

Supported targets: [iPhone Action Button](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help action-button`.

<!-- /generated -->

<!-- generated:command shake -->

Shake an iOS simulator or Android emulator.

```bash
agent-device shake
```

Supported targets: [Shake](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help shake`.

<!-- /generated -->

<!-- generated:command hardware-button -->

Press a phone hardware button once.

```bash
agent-device hardware-button <volume-up|volume-down|power|mute|sleep|wake|media-play-pause|media-next|media-previous|media-rewind|media-fast-forward>
```

Supported targets: [Phone hardware buttons](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help hardware-button`.

<!-- /generated -->

<!-- generated:command lock-screen -->

Lock or unlock the device screen.

```bash
agent-device lock-screen <lock|unlock>
```

Supported targets: [Lock screen](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help lock-screen`.

<!-- /generated -->

- `back` uses the app's own back navigation: the back key on Android, the visible back control on macOS, and the Menu button on tvOS. On macOS, an app with no back control by identifier or "Back" label refuses with `in_app_back_control_unavailable` and nothing is pressed; press the app's control by its ref.
- iOS has no system back. `back` presses the navigation bar's system back button when it finds exactly one, and otherwise swipes from the left edge. It never presses a custom "Back" button, and it does not dismiss a modal or sheet: press that screen's Close or Cancel control. On Android, system back also closes dialogs.
- `back_swipe_no_change` means the swipe did not change the screen. `details.dismissControls` lists the Back, Close, and Cancel buttons at the top of the app window as selectors, for example `agent-device press 'role=button label="Close"'`. `back` never presses them itself, because they can discard a draft.
- `back_swipe_unverified` means `back` cannot tell whether it navigated, for example because the screen kept changing. Check with `snapshot`.
- `back_swipe_not_dispatched` means nothing reached the device, so a retry is safe.
- An app with a left-edge drawer can open the drawer instead of going back. When the app shows its own back or close control, press it by its ref.
- `back --system` sends system back: the Android back key or the tvOS Menu button. macOS has no system back and refuses it. visionOS refuses `back`.
- `orientation` works on iOS and Android mobile targets only. On ADB-backed Android, it turns auto-rotate off, and the lock stays after the session ends. `orientation auto` gives rotation back to the sensor on ADB-backed Android only. An iPhone Duo refuses `portrait-upside-down`.
- `action-button` reports that the press was sent, not what it triggered. A model without the button fails with `hardware_control_unavailable` and nothing is pressed. Simulators run no Shortcuts or App Intents, so verify the outcome on a physical iPhone.
- `shake` works on iOS simulators and local Android emulators, not on Android TV or remote providers. On iOS, the app gets a motion-shake event but no accelerometer data, so an app that detects shakes through CoreMotion does not see it. Take a snapshot to see what the app did.
- On Android, `shake-rest-acceleration-unreadable` means the emulator console returned no accelerometer reading, so nothing was sent. `shake-console-refused` after a swing means the accelerometer may not be back at rest. Check with `adb emu sensor get acceleration`.
- `hardware-button` presses a key once and reports the press, not what the OS did with it. Android presses every key. A physical iPhone or iPad presses volume only, iOS simulators refuse every key, and TV targets point you to `tv-remote`.
- On Android, `power` toggles the screen. After a press that turns the screen off, later commands can hit a locked screen; use `hardware-button wake`, or `lock-screen unlock` to dismiss the lock screen too.
- `lock-screen` returns once the device reports the lock state, in `state`. `lock` leaves a locked screen alone. Android verifies with the keyguard state that `dumpsys window` reports. On a device with a PIN, pattern, or password and "Power button instantly locks" off, the keyguard appears only after "Lock after screen timeout", so `lock` waits that long too: at least 5 s, which Android applies even to a shorter setting, and at most one minute. iOS simulators verify with SpringBoard's lock state and, for `lock`, a lock screen surface. On iOS, a dark screen is woken with the lock button first: `unlock` then swipes up and needs the screen on, and `lock` presses again if the screen woke unlocked. `unlock` lands on the app that was in front, not on the Home Screen. On Android it always sends the wake event, which leaves a screen that is on unchanged.
- The session app is not activated, so check the result with `screenshot`. On iOS, an app-scoped command such as `snapshot` brings the session app back to the front, which can dismiss the lock screen.
- `lock-screen unlock` never enters a credential. A PIN, pattern, password, or passcode lock fails with `lock-screen-secure`; on Android nothing is sent (`dispatched: no`). `lock-screen-unverified` means the device still reports the previous state. On Android, `lock` on a screen lock set to None fails with `lock-screen-disabled` and sends nothing (`dispatched: no`), because there is no lock screen to show. `lock-screen-state-unreadable` means `dumpsys` reported no keyguard state or no lock type for the foreground user, and nothing was sent.

Fold a foldable device:

<!-- generated:command fold -->

Fold or unfold a foldable iPhone simulator or Android emulator.

```bash
agent-device fold [closed|half-open|open] [--keyframes <json>]
```

| Option | What it does |
| --- | --- |
| `--keyframes <json>` | Fold: timed {atMs, angle} keyframes; final atMs is motion duration (up to 60000ms) |

Supported targets: [Foldable pose](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help fold`.

<!-- /generated -->

- `fold closed|half-open|open` sets the pose of an iPhone Duo simulator or a foldable Android emulator, such as `pixel_9_pro_fold`. It reports the pose only after the device confirms it. Physical devices are refused.
- Take a new snapshot after every fold, even a failed one. Refs and coordinates from before it are stale.
- On iOS, `fold` needs an Xcode with foldable HID support. The first fold on a host or Xcode builds a helper and takes longer. The response's panel size is not the next snapshot's viewport, so do not use it to place a tap.
- On a foldable iOS simulator, `home` and `app-switcher` press the Home button through the same helper, because the XCUITest Home press does not reach the home screen there. The first press on a host or Xcode builds the helper and takes longer.
- On an unfolded iPhone Duo simulator with the inner panel lit, run `gesture swipe split-view-left` or `gesture swipe split-view-right` to move the full-screen app to that half. Use `open <bundle>` to launch the second app or switch between the two apps. With both apps in Split View, run `gesture swipe split-view-exit` to drag the divider left and make the right-hand app fill the screen. Other devices, a closed Duo, and WebDriver providers refuse these presets with `split_view_unavailable` before any touch.
- `--keyframes` plays a timed hinge trajectory on iOS only, for example `fold --keyframes '[{"atMs":0,"angle":0},{"atMs":1667,"angle":160},{"atMs":5000,"angle":180}]'`.
- For failure reasons, see [error reasons](/docs/error-reasons). For panels and poses, see `agent-device help foldable`.

Simulate an incoming call or SMS:

<!-- generated:command telephony -->

Simulate an incoming call or SMS on an Android emulator over adb.

```bash
agent-device telephony call|accept|cancel <number> | telephony sms <number> <text>
```

Supported targets: [Call and SMS simulation](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help telephony`.

<!-- /generated -->

- Use `telephony` to check how an app reacts to a call or message, for example whether video playback pauses and resumes.
- It works on Android emulators through the local adb executor only. Physical devices and every other platform refuse it with `UNSUPPORTED_OPERATION`.
- The emulator console refuses some events, such as `accept` for a number with no call, with `telephony-console-refused`.
- The emulator drops characters such as emoji from an SMS and delivers the rest.
- The call screen or notification can cover the app. Take a new snapshot before you use refs.

Remote daemons and tenants:

- `--tenant`, `--session-isolation tenant`, `--run-id`, and `--lease-id` enforce lease admission on tenant-scoped daemons.
- `--daemon-base-url http(s)://host:port[/base-path]` calls a remote HTTP daemon instead of a local one. Add `--daemon-auth-token <token>` (or `AGENT_DEVICE_DAEMON_AUTH_TOKEN`) for a non-loopback URL.
- Remote screenshots download to the path you pass. When a remote `record stop` names no destination, the client saves the file in your working directory and warns.
- To drive a Mac's simulators from another machine, see [Remote proxy](#remote-proxy). For hosted devices in CI, see [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), or [TestMu AI](/docs/testmu). For `connect --remote-config`, see [Remote Metro workflow](#remote-metro-workflow).

## Human Takeover

<!-- generated:command takeover -->

Pause agent interactions while a person controls a device.

```bash
agent-device takeover [status | hold | release <hold-id>] [--session <name>]
```

**`takeover hold`**

| Option | What it does |
| --- | --- |
| `--tenant <id>` | Tenant scope identifier for isolated daemon sessions |
| `--run-id <id>` | Run identifier used for tenant lease admission checks |
| `--lease-id <id>` | Lease identifier bound to tenant/run admission scope |
| `--reason <text>` | Human-control hold reason a blocked agent sees (takeover hold) |
| `--ttl-ms <ms>` | Human-control hold TTL in milliseconds, 1000 to 86400000 (takeover hold; default 60000) |
| `--session <name>` | Named session (implicit default is scoped to this workspace + platform) |

**`takeover status`**

| Option | What it does |
| --- | --- |
| `--daemon-transport auto\|socket\|http` | Daemon client transport preference |
| `--tenant <id>` | Tenant scope identifier for isolated daemon sessions |
| `--session-isolation none\|tenant` | Session isolation strategy (tenant prefixes session namespace) |
| `--run-id <id>` | Run identifier used for tenant lease admission checks |
| `--lease-id <id>` | Lease identifier bound to tenant/run admission scope |
| `--session <name>` | Named session (implicit default is scoped to this workspace + platform) |

**`takeover release`**

| Option | What it does |
| --- | --- |
| `--daemon-transport auto\|socket\|http` | Daemon client transport preference |
| `--tenant <id>` | Tenant scope identifier for isolated daemon sessions |
| `--session-isolation none\|tenant` | Session isolation strategy (tenant prefixes session namespace) |
| `--run-id <id>` | Run identifier used for tenant lease admission checks |
| `--lease-id <id>` | Lease identifier bound to tenant/run admission scope |
| `--session <name>` | Named session (implicit default is scoped to this workspace + platform) |

Exact behavior: `agent-device help takeover`.

<!-- /generated -->

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
restart; reconnect and take the hold again. See [Remote proxy](/docs/remote-proxy#human-takeover).

## Web Automation

<!-- generated:command web -->

Manage web automation backend.

```bash
agent-device web setup | web doctor
```

Exact behavior: `agent-device help web`.

<!-- /generated -->

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

- Run `web setup` before first use and in CI bootstrap. Web commands never install the backend themselves. `web doctor` verifies the install.
- Each web session has its own browser, cookies, and storage. Sessions with different `--session` names run at once. A session name is 1 to 30 letters, digits, `_`, or `-` (1 to 17 under tenant isolation); another name fails with `web_session_name_invalid`. Without `--session`, each workspace gets its own browser.
- Supported: URL open, snapshot refs, `get text/attrs`, `is visible/hidden/exists/absent/focused/text`, `find text/selector`, click/press, hover, fill/type, wait, `network dump`, `audio probe`, screenshot, close, and replay scripts made from those commands.
- A coordinate or selector `fill` clicks the point and replaces the field's text. When the click does not reach an editable text field, such as a date input or a field in a cross-origin frame, it fails with `text_entry_focus_not_observed` and types nothing. Run `snapshot -i` and fill the field by ref instead.
- `hover --settle` on web needs a selector or coordinate target, because web refs carry no geometry.
- `audio probe` samples HTML media levels; see [Debugging and profiling](/docs/debugging-profiling#audio-probes).
- Not supported: tab/window/devtools control, network routing/interception/HAR, cookies/storage, downloads/uploads, arbitrary page scripting, multi-page orchestration, and raw browser diagnostics. Use `agent-browser` directly for those.

## Device isolation scopes

```bash
agent-device devices --platform ios --ios-simulator-device-set /tmp/tenant-a/simulators
agent-device devices --platform android --android-device-allowlist emulator-5554,device-1234
```

- `--ios-simulator-device-set <path>` limits simulator discovery and commands to that simulator set. iOS physical devices are not listed while it is set.
- `--android-device-allowlist <serials>` limits Android discovery and selection to those serials.
- Set the same scopes with the `iosSimulatorDeviceSet` and `androidDeviceAllowlist` config keys, or `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`.
- A daemon started with `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET=<path>` scopes every iOS request to that set and refuses another path with `ios_simulator_device_set_outside_daemon_set`. A daemon that the CLI starts keeps the first value until it restarts.
- Scopes apply before `--device`, `--udid`, and `--serial`, so an out-of-scope selector fails with `DEVICE_NOT_FOUND`.
- If the selected Xcode cannot find a scoped simulator, the Apple runner fails to start with `simulator_set_destination_not_found`.
- On macOS, daemon startup removes a symlink at `~/Library/Developer/XCTestDevices`, including one you made yourself. A symlinked `XCTestDevices` is not supported.

## Device discovery

<!-- generated:command devices -->

List available devices and simulators.

```bash
agent-device devices
```

Exact behavior: `agent-device help devices`.

<!-- /generated -->

<!-- generated:command capabilities -->

List supported commands for the selected device.

```bash
agent-device capabilities
```

Exact behavior: `agent-device help capabilities`.

<!-- /generated -->

```bash
agent-device devices --platform ios
agent-device devices --platform vega --target tv
agent-device capabilities --platform android
agent-device capabilities --session checkout --json
```

- `devices` lists available targets after `--platform` and [isolation scopes](#device-isolation-scopes). Each device shows `model` and `osVersion` when the platform reports them. These fields describe a device and are not selectors.
- `open --json` and `session list --json` report the attached device the same way, so a CI job can record the OS a run used. A cloud provider can grant a different OS than you asked for.
- `capabilities --json` lists the commands the target supports in `availableCommands`. Use it instead of keeping your own platform support table. On Android, `targetReadiness.press: "bounded-geometry"` means ref and selector presses already wait for moving targets, so a test harness needs no fixed delay before a tap.

### HarmonyOS command boundary

HarmonyOS support uses HDC and ArkUI `uitest`. On API 24 devices it supports lifecycle and HAP deployment, ArkUI snapshot/screenshot and selector reads, one-pointer touch and text actions, keyboard `enter`/`dismiss`, app logs, foreground app state, process RSS samples, and `settings clear-app-state`. Run `agent-device capabilities --platform harmonyos` for the command list of a selected device.

- Gestures use one pointer. Multi-touch gestures and `gesture drag` return `UNSUPPORTED_OPERATION`.
- Physical devices support whole-screen recording with `record start <path> --scope device` or `--scope system`, without `--fps`, `--quality`, or `--hide-touches`. Emulator recording is refused.
- Not available: orientation, clipboard, alerts, network/audio capture, push and app-event delivery, React Native helpers, and trace capture. `settings` supports only `clear-app-state`. `perf memory sample` reports process RSS only.

## Diagnostics

<!-- generated:command doctor -->

Diagnose device, app, dev-server, and RN/Expo readiness.

```bash
agent-device doctor [--platform ios|android|harmonyos|vega|macos|linux|web|apple] [--app <id-or-name>] [--remote]
```

| Option | What it does |
| --- | --- |
| `--app <id-or-name>` | Target an app without opening it: doctor verifies an installed app by id or name; settings applies an app-scoped change (permission, iOS location) to a bundle id or package |
| `--remote` | Doctor: check remote connection setup instead of local device inventory |

Exact behavior: `agent-device help doctor`.

<!-- /generated -->

```bash
agent-device doctor
agent-device doctor --platform ios
agent-device doctor --platform android --app com.example.myapp
agent-device doctor --remote --json
```

- `doctor` is read-only: it never boots, installs, or changes the device. Without `--platform`, it checks every discoverable target.
- `--app` checks whether the app is installed and enables app-specific diagnostics. To check Metro reachability, run `doctor` locally on the Metro host from your project directory.
- `--remote` runs only the checks that don't need a booted device; use it in CI bootstrap.

## Prepare Apple runner

<!-- generated:command prepare -->

Pre-warm platform helpers before automation.

```bash
agent-device prepare ios-runner --platform ios|macos [--timeout <ms>]
```

Also accepts: [common options](#common-options): `--timeout <ms>`.

Supported targets: [Prepare the Apple runner](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help prepare`.

<!-- /generated -->

```bash
agent-device prepare ios-runner --platform ios --timeout 240000
```

- In Apple CI setup, run `prepare ios-runner` after the device boots and the app is installed, before the first `snapshot`, `replay`, or `test`. It builds or reuses the Apple runner, starts it, and checks that it answers.
- In JSON output, the phase timings can overlap. Use `timing.additiveParts` for totals that add up.
- CI may cache `~/.agent-device/apple-runner/derived` when the cache key includes the exact agent-device package contents and Xcode version. agent-device rebuilds a cached runner whose files changed, and trims old cache entries; see `AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP` in [Configuration](/docs/configuration#supported-environment-variables).
- `runner_cache_uncertifiable` means the build products could not be verified. Point `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` at a plain directory you own, or follow the error hint.
- `~/.agent-device/ios-runner` belongs to older versions. Delete it once no older version runs.
- Runner build and start output goes to the session's `runner.log`. `daemon.log` covers daemon startup.

## TV targets

<!-- generated:command tv-remote -->

Press a TV remote navigation, media, or hardware button.

```bash
agent-device tv-remote [press|longpress] <up|down|left|right|select|menu|home|back|volume-up|volume-down|mute|power|sleep|wake|media-play-pause|media-play|media-pause|media-stop|media-next|media-previous|media-rewind|media-fast-forward|channel-up|channel-down|last-channel|guide|info|captions|tv-input|color-red|color-green|color-yellow|color-blue|android-keycode:<n>> [--duration-ms <ms>]
```

| Option | What it does |
| --- | --- |
| `--duration-ms <ms>` | Scroll: pace the gesture over this duration when supported; tv-remote: hold the button this long (Android TV long-presses on any positive value) |

Supported targets: [TV remote keys](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help tv-remote`.

<!-- /generated -->

```bash
agent-device open YouTube --platform android --target tv
agent-device apps --platform android --target tv
agent-device snapshot -i --platform android --target tv
agent-device tv-remote press down --platform android --target tv
agent-device tv-remote press select --platform android --target tv
agent-device tv-remote longpress select --platform android --target tv
agent-device tv-remote android-keycode:300 --platform android --target tv
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

- TV targets include Apple TV and Android TV simulators, emulators, and devices, plus Fire TV devices running Fire OS. Vega OS support is limited to the Vega Virtual Device (VVD).
- TV targets are focus-first: move focus with `tv-remote` before you select a control. Do not use raw `adb shell input keyevent` in command plans.
- `tv-remote` is TV-only. Phones, tablets, and WebDriver (Appium) sessions refuse it.
- All TV backends support `up`, `down`, `left`, `right`, `select`, `menu`, `home`, and `back`. The other named buttons are Android TV only. For an Android TV button without a name, use `android-keycode:<n>`.
- A response confirms that the button was sent. It does not verify playback, volume, or display state, and `power` and `sleep` can turn the screen off.
- On Android TV, `longpress` has no exact hold time. On tvOS and Vega, `--duration-ms` is an exact hold.
- Fire TV with Fire OS connects as an Android TV device over ADB: enable ADB debugging in Settings > My Fire TV > Developer options, run `adb connect <device-ip>:5555`, and use `--platform android --target tv`. Android TV snapshots need Android 6.0 or newer.
- tvOS supports the same runner commands as iOS. `back` is the Menu button and `home` is Home. Simulator-only helpers such as `settings` and `push` stay simulator-only, and multi-touch gestures are refused.
- Vega OS: use `--platform vega --target tv` with component IDs such as `com.example.app.main`. The VVD supports open, close, `back`, `home`, and the eight navigation buttons. It has no snapshot, screenshot, or selectors, so use the VVD display as visual truth. Physical Vega OS devices, including some Fire TV models, are not supported.
- LG webOS and Samsung Tizen TVs run through optional plugins. See [LG webOS](/docs/webos) and [Samsung Tizen](/docs/tizen).
- On Android TV and tvOS, use `screenshot --overlay-refs` to see which control has focus when focus metadata is missing.

## watchOS simulators

Apple Watch simulators use the same XCUITest runner as iOS. Select one with `--platform ios` and its `--udid` or `--device` name; a watch is never picked when another Apple simulator matches.

```bash
agent-device open com.apple.NanoSettings --platform ios --device "Apple Watch Series 11 (46mm)" --session watch
agent-device snapshot -i --session watch
agent-device press 'label="Smart Stack"' --session watch --settle
agent-device scroll down --session watch
agent-device swipe 180 124 20 124 --session watch
agent-device back --session watch
agent-device close --session watch --shutdown
```


- Simulators only. The host needs the watchOS simulator runtime: `xcodebuild -downloadPlatform watchOS`.
- `scroll up|down` turns the Digital Crown, which also moves pickers and steppers that have crown focus. `scroll left|right` is refused; swipe instead.
- `gesture swipe right-edge` goes back. `back` works only while a navigation back button is shown; on a root screen it refuses with `back_swipe_not_dispatched`, so press the screen's close control by ref.
- `home` presses the Digital Crown and acts on whatever is on screen: from an app it shows the watch face, and from the watch face it opens the app grid. Other commands act on the session app and bring it to the foreground first, so they cannot reach the watch face overlays such as Notification Center and the Smart Stack.
- `fill` and `type` type into the system input sheet and press its Done button by its English label. On another system language, the command fails with `TEXT_INPUT_COMMIT_NOT_OBSERVED` and the text stays in the sheet; press its commit button by ref.
- `action-button` works on Apple Watch Ultra only.
- `record` captures the watch screen as on an iOS simulator.
- `open`, `close`, `install`, `uninstall`, `boot`, `snapshot`, `find`, `wait`, `is`, `get`, `press`, `longpress`, `appstate`, and `screenshot` work as on iOS.
- Every other command is refused with `unsupported-platform-leaf`, including `orientation`, `keyboard`, `app-switcher`, `clipboard`, `settings`, `alert`, `logs`, `network`, `perf`, `push`, `apps`, and multi-touch gestures.
- Open apps by their watch bundle ID, such as `com.apple.NanoSettings`. Aliases such as `settings` resolve to iPhone bundle IDs.

## Desktop targets

```bash
agent-device devices --platform macos
agent-device open TextEdit --platform macos
agent-device open --platform macos --surface desktop
agent-device snapshot -i --platform apple --target desktop
```

- `--platform macos`, or `--platform apple --target desktop`, selects the host Mac as a `desktop` target. Run `agent-device help macos` for the exact contract.
- Use an `app` session for normal app control: `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `back`, `screenshot`, `record`. In an app session, `screenshot` captures the app window, not the whole desktop.
- Use the other surfaces to inspect desktop-wide UI before you choose an app: `frontmost-app` is the focused app, `desktop` is the visible windows, and `menubar` is the active app's menu bar and menu extras. `desktop` is inspect-only. To act inside one app, open it in an `app` session.
- `open <app> --platform macos --surface menubar` targets one app's menu bar extras. Prefer it for status-item apps.
- `open <app>` attaches to a copy of the app that is already running, including one you started yourself. A copy still registering with macOS, or copies running from more than one path, can get a second instance.
- Prefer selectors and `@ref`s over x/y, because window positions shift between runs. Use `click --button secondary` for context menus, then run `snapshot -i` again.
- On `frontmost-app` and `menubar`, Finder and similar apps read two quick `--count` clicks as a double-click. Pass an `--interval-ms` longer than the system double-click time to keep them apart.
- macOS also supports `clipboard`, `trigger-app-event`, `logs`, `network dump`, `audio probe` (needs Screen Recording permission), `alert`, and part of `settings` (see [Settings helpers](#settings-helpers)).
- Mobile-only commands are unsupported on macOS: `boot`, `shutdown`, `home`, `orientation`, `app-switcher`, `action-button`, `shake`, `fold`, `install`, `reinstall`, `uninstall`, `install-from-source`, and `push`.

Set `AGENT_DEVICE_MACOS_APP_BACKEND=native` to run macOS app sessions without XCTest. The app can stay behind other windows, and your pointer stays yours. With the native backend:

- Each app on the `app` surface is a device of its own, so several agents can drive different apps on one Mac. Two sessions on the same app conflict. A `desktop`, `menubar`, or `frontmost-app` session holds the whole Mac.
- An app session opens and closes only its own app. Use a new `--session` for another app or surface.
- An app session refuses `clipboard`, `settings`, and `audio probe` with `unsupported-device-scope`, because they act on the whole Mac. Use a `--surface desktop` session for them.
- An app session cannot see UI that another process shows, such as a system permission prompt.
- Electron and other Chromium-based apps show their web content in the snapshot. The first `snapshot` turns on the app's Chromium accessibility tree, which stays on while the app runs.
- `click`, `press`, and `fill` need an element with an accessibility action inside one of the app's windows, not its menu bar. `scroll` scrolls the area at the center of the front window.
- `screenshot` captures only the app's front window, even when it is covered.
- `click --button secondary` fails with `context-menu-not-observed` when no menu opened. Take a snapshot and retry on another element.
- `record`, `prepare`, `back`, `longpress`, `--hold-ms`, `--double-tap`, and gestures fail with `unsupported-device-backend`. Use the default XCTest backend for those.
- Copies of one app need distinct bundle ids. Use one agent-device version per claims directory.

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

<!-- generated:command snapshot -->

Capture or diff the accessibility tree.

```bash
agent-device snapshot [--diff] [-i] [--depth, -d <depth>] [--scope, -s <scope>] [--raw] [--actions] [--observe-only] [--force-full] [--timeout <ms>]
```

| Option | What it does |
| --- | --- |
| `--diff` | Snapshot: show structural diff against the previous session baseline |
| `--record` | Force-record this action into a repair-armed heal; per-invocation only, the retired config key "record" no longer opts in (mutually exclusive with --no-record) |
| `-i` | Snapshot: interactive elements only |
| `--actions` | Snapshot: name the affordances merged inside an element (iOS sim); not directly invokable — reach them via the detail screen, labeled children, or coordinates |
| `--observe-only` | Snapshot: observe the iOS session app without activation or foreground repair |
| `--force-full` | Snapshot: re-emit the full tree even when unchanged |

Also accepts: [common options](#common-options): `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Accessibility snapshot, snapshot diff, and audit](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help snapshot`.

<!-- /generated -->

<!-- generated:command get -->

Read element text or attributes.

```bash
agent-device get text|attrs <@ref|selector>
```

| Option | What it does |
| --- | --- |
| `--record` | Force-record this action into a repair-armed heal; per-invocation only, the retired config key "record" no longer opts in (mutually exclusive with --no-record) |

Also accepts: [common options](#common-options): `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Refs, selectors, element lookup, and attribute reads](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help get`.

<!-- /generated -->

```bash
agent-device snapshot -i
agent-device snapshot -i -s "Settings"
agent-device diff snapshot -i
agent-device get text @e1
agent-device get attrs @e1
```


- `--raw` returns the full provider tree, including offscreen nodes and structural wrappers. See [iOS capture behavior](/docs/snapshots#ios-capture-behavior) and [Android capture behavior](/docs/snapshots#android-capture-behavior).
- A source checkout must run `pnpm build:android` before Android verification, because Android snapshots install a bundled helper.
- `truncated: true` means the capture hit a backend node limit and the last elements are missing; see [Truncated captures](/docs/snapshots#truncated-captures).
- For `viewport`, `--scope`, and `--actions`, see [Snapshots](/docs/snapshots).
- `diff snapshot` compares with the previous snapshot in the session, then makes the new one the baseline. A snapshot read with different flags starts a new baseline instead of listing changes.

### Audit the current screen

<!-- generated:command audit -->

Report advisory accessibility findings.

```bash
agent-device audit
```

Supported targets: [Accessibility snapshot, snapshot diff, and audit](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help audit`.

<!-- /generated -->

`audit` checks the current screen for accessibility problems. Findings are review prompts, not failures, and `audit` changes nothing on the device.

- It checks for small targets, controls with no accessible name, controls of one role that share a name, and controls covered by other UI. `agent-device help audit` describes each check and its exemptions.
- On Android, `audit` also prints an estimated TalkBack swipe order for each app window, as refs. The estimate uses TalkBack's ordering rules on the captured tree, so it can differ from TalkBack where TalkBack scrolls, moves between windows, or reads web content. Confirm an order problem with TalkBack on a device.
- On iOS 17+ with the XCTest runner, `audit` also runs Apple's native accessibility checks. Other targets run the heuristic checks only. Apple's Dynamic Type and clipped-text checks are not run; `agent-device help accessibility` describes the large text check to use instead.
- A system alert over the app stops Apple's checks with `native_audit_blocked_by_alert`. Run `agent-device alert accept` or `agent-device alert dismiss`, then run `audit` again. A runner answer the CLI cannot read fails with `native-audit-invalid-result`.
- When a native finding matches a captured element, it includes its ref. Otherwise, match its `rect` against a new snapshot before you act. A finding without a rect names no element, so report it without acting.
- Like `find`, `audit` returns pinned refs such as `@eN-s<refsGeneration>`; press those. Take a new snapshot before you use other refs.

## Wait and alerts

<!-- generated:command wait -->

Wait for a duration, text, selector, strict absence, or stable UI.

```bash
agent-device wait <ms>|text <text>|@ref|<selector>|absent <selector> [timeoutMs]|stable [quietMs] [timeoutMs]
```

Also accepts: [common options](#common-options): `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Wait for text, selectors, and timeouts](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help wait`.

<!-- /generated -->

<!-- generated:command alert -->

Inspect, accept, or dismiss a platform alert.

```bash
agent-device alert [get|accept|dismiss|wait] [timeout]
```

Supported targets: [Read, accept, and dismiss system alerts](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help alert`.

<!-- /generated -->

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

- Prefer `wait text` or a selector wait over a fixed `wait <ms>`. Selector waits resolve selectors the same way as `click` and `is`.
- `wait absent <selector>` is strict absence: it passes only when a complete, readable capture has zero matches, so hidden or off-screen matches keep it pending. It refuses `--scope` and `--depth`.
- `wait text <value>` never matches an editable field by its current value. So `wait text` after `fill` waits until the app shows that text elsewhere, for example after Save. To check the field itself, use `is text <selector> <value>` or `get text`.
- `wait @ref` waits for the ref's label text, so a duplicate label can match another element. To wait for one field, use a selector such as `wait 'id="email"'`.
- Wait failures carry `error.details.reason`; see [error reasons](/docs/error-reasons#wait). Retry `wait_capture_stalled` and `wait_runner_restart_exhausted`. Retry `wait_readiness_exhausted` with a timeout that covers the iOS runner start. `wait_target_absent`, `wait_target_present`, `wait_stable_timeout`, and `wait_deadline_exceeded` mean the screen did not reach the expected state in time. `wait_landmark_identity_mismatch` comes from a replay guard. `predicate_failed` means strict `wait absent` could not prove absence because no valid capture arrived.
- Branch on `readableCaptures`, `waitedMs`, `matches`, and `firstMatch` instead of parsing error text. A timed-out wait also lists its `polls` and a `logPath` to the full request log.

Handle system alerts:

- `alert` handles system alerts on iOS, macOS, and Android permission dialogs. On iOS it also covers app-owned modal popups and Safari's page prompts.
- Use `alert get` for a quick check, and `alert wait <short-ms>` only when a prompt may appear after async work. Do not use `settings permission` to answer a dialog already on screen; it is for setup before a flow.
- `accept` and `dismiss` are sent once and never replayed, even if the response is lost. A closed alert does not prove that a permission was granted, so verify the app outcome.
- `accept` picks the lasting grant, such as `Allow While Using App` over `Allow Once`, or "Allow all" on Android's partial-media sheet. On iOS, `dismiss` presses only a recognized decline button, such as `Cancel` or `Don't Allow`. iOS simulators also recognize these labels in the device's preferred languages; on physical iOS devices, tvOS, and visionOS the runner cannot read the OS strings, so it recognizes the system prompts' Simplified Chinese wording from a built-in table, at the rank of the English label each entry translates; wording the table does not cover stays unknown.
- On iOS and Android, an unrecognized or ambiguous button fails with `ALERT_BUTTON_NOT_FOUND` or `alert_button_undecided`, and nothing is pressed. Read the labels with `alert get`, then press your choice with `snapshot -i` and `press @ref`. macOS falls back to the default or cancel button, then the first or last button.
- `ALERT_UNRESOLVED` means the runner found an alert it cannot act on. Inspect it with `screenshot` and `snapshot -i`, then `press @ref` on the visible button.
- `alert-window-expired`, `ALERT_CONFIRMATION_UNAVAILABLE`, `ALERT_DEADLINE_EXCEEDED`, and `dispatched: unknown` mean the press may have happened. Run `alert get` before you act again.
- An `alert get` that fails with `runner_main_thread_timeout` does not mean there is no alert. Run `alert get` again.
- A screen with no alert answers `alert get --json` with `status`: `none`, on every platform that serves `alert`. Branch on `status`, not on the message.
- If a sheet or permission prompt is visible but `alert` reports none, run `snapshot -i -s "<visible label>"`, then `press @ref` on the visible button.

## Interactions

<!-- generated:command click -->

Click or tap a UI target.

```bash
agent-device click <x y|@ref|@ref,...|selector>
```

| Option | What it does |
| --- | --- |
| `--count <n>` | Repeat count for press, swipe and gesture tap series |
| `--interval-ms <ms>` | Delay between press iterations |
| `--hold-ms <ms>` | Press or gesture tap hold duration for each iteration; for gesture pan, the hold before the move |
| `--jitter-px <n>` | Deterministic per-axis coordinate jitter in pixels |
| `--double-tap` | Use double-tap gesture per press iteration |
| `--verify` | Capture cheap post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot |
| `--button primary\|secondary\|middle` | Click: choose mouse button (middle reserved for future macOS support) |

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Tap, press, and fill](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help click`.

<!-- /generated -->

<!-- generated:command press -->

Short-press a UI target.

```bash
agent-device press <x y|@ref|@ref,...|selector>
```

Aliases: `tap`.

| Option | What it does |
| --- | --- |
| `--count <n>` | Repeat count for press, swipe and gesture tap series |
| `--interval-ms <ms>` | Delay between press iterations |
| `--hold-ms <ms>` | Press or gesture tap hold duration for each iteration; for gesture pan, the hold before the move |
| `--jitter-px <n>` | Deterministic per-axis coordinate jitter in pixels |
| `--double-tap` | Use double-tap gesture per press iteration |
| `--verify` | Capture cheap post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot |

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Tap, press, and fill](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help press`.

<!-- /generated -->

<!-- generated:command focus -->

Focus input at screen coordinates.

```bash
agent-device focus <x> <y>
```

Supported targets: [Refs, selectors, element lookup, and attribute reads](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help focus`.

<!-- /generated -->

```bash
agent-device click @e1
agent-device click @e1 --button secondary   # macOS secondary click / context menu
agent-device click @e13,@e14                # one plan, one admission pass
agent-device press @e13,@e14                # a two-key plan; up to 16 refs
agent-device focus @e2
agent-device fill @e2 "text"          # Replace the field value
agent-device fill @e2 "search" --delay-ms 100
printf %s "$PASSWORD" | agent-device fill @e2 --text-stdin   # Text from stdin, kept out of argv
agent-device type "text"              # Type into focused field without clearing
agent-device type "query" --delay-ms 100
agent-device press 300 500
agent-device press 300 500 --count 12 --interval-ms 45
agent-device press 300 500 --count 6 --hold-ms 120 --interval-ms 30 --jitter-px 2
agent-device swipe 540 1500 540 500
agent-device swipe 540 1500 540 500 --count 8 --pause-ms 30 --pattern ping-pong
agent-device gesture pan 200 420 0 -80 500
agent-device gesture pan 200 420 80 -40 700 --pointer-count 2
agent-device gesture fling right 200 420 180
agent-device gesture drag 'id="drag-source"' 'id="drop-target"'
agent-device gesture drag @e4-s12 'label="Archive"' 700 600 200
agent-device longpress 300 500 800
agent-device hover @e12 --settle       # Web only: move the pointer without pressing
agent-device scroll down 0.5
agent-device scroll down --pixels 320
agent-device scroll down --until 'label="Sign in"'
agent-device scroll refresh           # pull-to-refresh at the top of the list
agent-device gesture pinch 2.0          # zoom in 2x
agent-device gesture pinch 0.5 200 400 # zoom out at coordinates
agent-device gesture pinch 2 @e17       # zoom in 2x centered on an element
agent-device gesture rotate 35 200 420 # rotate app content
agent-device gesture transform 200 420 80 -40 2 35 700 # combined pan, zoom, and rotate
agent-device gesture tap 80 300 200 450 310 600        # three fingers at once
agent-device gesture tap 80 300 200 450 --count 20 --pause-ms 100 # repeated two-finger tap
```


A successful `click` or `press` means the action was sent to where the command found the target. It does not confirm that the element received it or that the screen changed. When the next step depends on it, add `--verify` (reports `changedFromBefore`), add `--settle` (returns the diff once the UI goes quiet), or follow with `wait <selector>`. Before you retry a failed interaction, see [Retry after a failed command](#retry-after-a-failed-command).

`--settle` reads the tree in the same view as the refs you last read: the full tree after `snapshot`, the interactive view after `snapshot -i`.

After an action that animated the screen, a `click` or `press` on a ref or selector waits for the target to come to rest. If it does not, the command refuses with `target_still_moving` and nothing is pressed. Run `wait <selector>` on the target and retry, or add `--settle`. A refused `@ref` press needs a new `snapshot -i`, because the wait retires the ref. Presses at raw coordinates, and `click @ref` on the web, skip this check.

A raw-coordinate press has no ref to wait on and skips that check. To confirm that a coordinate press changed the screen, capture before and after, then diff:

```bash
agent-device screenshot --out before.png
agent-device press 201 500
agent-device diff screenshot --baseline before.png --out diff.png --json
```

`diff screenshot` ranks the changed regions and writes the tinted diff PNG. Before you retry a coordinate press that produced no change, see [Screenshots](#media-and-logs).

On iOS, a press on a control nested inside a larger touch control, such as a swipe action beside its row, refuses with `target_not_hittable` when the platform reports the control as not hittable. Reveal the control, for example by swiping its row, and take a new `snapshot -i`.

A comma-separated ref plan, such as `press @e13,@e14`, presses 2 to 16 refs as one command. Run `snapshot -i` first and copy the refs exactly. A refusal after the first press reports `details.dispatchedSteps`; plan again from a new `snapshot -i`. While script recording is armed, a plan needs `--no-record`. See `agent-device help press`.

If rotation stops repeated iOS presses, inspect the screen before you continue with the remaining presses.

### Text entry

<!-- generated:command fill -->

Replace text in a UI input.

```bash
agent-device fill <x> <y> <text> | fill <@ref|selector> <text> | fill <x y|@ref|selector> --text-stdin
```

| Option | What it does |
| --- | --- |
| `--delay-ms <ms>` | Delay between typed characters |
| `--record-as <VAR>` | Fill: send the live text but publish ${VAR} in an armed .ad recording |
| `--text-stdin` | Fill: read the text from stdin (max 64 KiB, one trailing newline removed) instead of argv |
| `--verify` | Capture cheap post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot |

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Tap, press, and fill](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help fill`.

<!-- /generated -->

<!-- generated:command type -->

Append text to the focused input.

```bash
agent-device type <text> [--delay-ms <ms>]
```

| Option | What it does |
| --- | --- |
| `--delay-ms <ms>` | Delay between typed characters |

Supported targets: [Type into the focused field](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help type`.

<!-- /generated -->

- `fill` replaces the field value. `type` appends to the focused field: use `fill @ref "text"` to target a field, or `press @ref` then `type "text"`.
- Use plain `fill` or `type` first. Add `--delay-ms` only when a debounced or search-as-you-type field misses characters.
- `fill --text-stdin` keeps a secret out of process arguments. Pipe it with `printf %s`. Output shows the value as `${VAR}` with `--record-as <VAR>`, and as `[REDACTED]` otherwise. While script recording is armed, pass `--record-as <VAR>` or `--no-record`. Batch steps do not accept `--text-stdin`.
- `--text-stdin` and `--record-as` keep the text out of agent-device's own output and scripts. On iOS, XCTest's own logs and `.xcresult` bundle can still hold typed text, so use test-only credentials. See [Security and trust](/docs/security-trust).
- On iOS, a masked field that shows as many bullets as its placeholder can look empty after a failed clear, so `fill` can type next to the old text. Check the field after you fill a secure field.
- Android text entry is owned by agent-device. Do not fall back to raw `adb`, clipboard, or paste; if the backend cannot type non-ASCII text, report the gap. Android `fill` verifies the text and fails instead of retrying when the IME captures input.

Text-entry errors and what to do:

- `TEXT_INPUT_NOT_FOCUSED` (`type`, iOS `fill`): focus a visible text input and retry. If accessibility does not expose the input, focus it by coordinates. If the input you want already has focus, end editing with a visible control, then retry.
- `NO_TEXT_INPUT_AT_POINT` (`no_text_input_at_point`, iOS `fill`): no text input is under the point, and nothing changed. A ref or selector fill aims at the center of its node, so run `snapshot -i` and pick the input node itself.
- `TEXT_INPUT_PROBE_UNAVAILABLE` (`text_input_probe_unavailable`, iOS `fill`): the runner could not look up the input, and nothing changed. Retry the fill.
- `TEXT_INPUT_SYNTHESIS_UNAVAILABLE` (iOS `type "\n"`): show the software keyboard, then retry.
- `TEXT_INPUT_COMMIT_NOT_OBSERVED` (iOS `fill`): the field may hold none, part, or all of the text. Run `snapshot -i`; if the field is wrong, retry `fill` with the `--delay-ms` value from the error hint.
- `TEXT_INPUT_CLEAR_NOT_OBSERVED` (iOS `fill`): the old text was not cleared, so nothing was typed. Inspect with `snapshot -i`, then retry `fill`.
- `TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED` (iOS `fill`): the text is too long for one command, and nothing was typed. Fill up to the limit that the hint names, then append the rest with `type`. A longer timeout does not help.
- `TEXT_ENTRY_MISMATCH` (iOS `fill`): the field shows dropped characters or no change. App masks and filters can cause this too (`5` into `$0.00` can show `$0.05`). Retry `fill` only if the field needs correction, with the `--delay-ms` value from the error hint.

Recover from these with `fill`, never `type`, because `type` appends to what the field already holds. The exception is the budget error above.

On iOS, a single-line `fill` that ends in a submit key, or a field that disappears after typing, succeeds without verification. Assert the resulting screen.

`fill` returns `verification: "unconfirmed"` when the field's value differs from the request but no failure is proven, such as app formatting (`00 062 91 77` for `000629177`). Inspect `requested`, `before`, and `after`, then assert the value or the resulting screen:

```bash
agent-device wait 'id="field-phone" value="00 062 91 77"'
```

### Pointer and gestures

<!-- generated:command longpress -->

Hold a UI target to open a context menu.

```bash
agent-device longpress <x y|@ref|selector> [durationMs]
```

Aliases: `long-press`.

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Long press](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help longpress`.

<!-- /generated -->

<!-- generated:command hover -->

Hover the pointer over a UI target (web only).

```bash
agent-device hover <x y|@ref|selector>
```

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`, `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Hover and viewport size](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help hover`.

<!-- /generated -->

<!-- generated:command swipe -->

Fling between coordinates.

```bash
agent-device swipe <x1> <y1> <x2> <y2> [--count <n>] [--pause-ms <ms>] [--pattern one-way|ping-pong]
```

| Option | What it does |
| --- | --- |
| `--count <n>` | Repeat count for press, swipe and gesture tap series |
| `--no-post-gesture-stabilization` | Scroll, swipe, gesture swipe, open: skip the movement check and the stabilization wait that follow a gesture, and on a local iOS simulator the first-screen wait after an app launch; use it only when your own polling verifies the screen |
| `--pause-ms <ms>` | Delay between swipe or gesture tap iterations |
| `--pattern one-way\|ping-pong` | Swipe repeat pattern |

Supported targets: [Gesture plans and swipes](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help swipe`.

<!-- /generated -->

<!-- generated:command gesture -->

Run pan, fling, swipe, pinch, rotate, transform, tap, or drag gestures.

```bash
agent-device gesture <pan|fling|swipe|pinch|rotate|transform|tap|drag> ...
```

**`gesture pan`**

| Option | What it does |
| --- | --- |
| `--pointer-count <1\|2>` | Gesture pan: number of touch pointers (default 1) |
| `--hold-ms <ms>` | Press or gesture tap hold duration for each iteration; for gesture pan, the hold before the move |

**`gesture tap`**

| Option | What it does |
| --- | --- |
| `--count <n>` | Repeat count for press, swipe and gesture tap series |
| `--hold-ms <ms>` | Press or gesture tap hold duration for each iteration; for gesture pan, the hold before the move |
| `--pause-ms <ms>` | Delay between swipe or gesture tap iterations |

**`gesture fling`**

Reads no options.

**`gesture swipe`**

| Option | What it does |
| --- | --- |
| `--no-post-gesture-stabilization` | Scroll, swipe, gesture swipe, open: skip the movement check and the stabilization wait that follow a gesture, and on a local iOS simulator the first-screen wait after an app launch; use it only when your own polling verifies the screen |

**`gesture pinch`**

Reads no options.

**`gesture rotate`**

Reads no options.

**`gesture transform`**

Reads no options.

**`gesture drag`**

Reads no options.

Supported targets: [Gesture plans and swipes](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help gesture`.

<!-- /generated -->

- Touch platforms refuse `hover`; use `longpress` for a hold. For `hover` on the web, see [Web Automation](#web-automation).
- `swipe` is a quick throw. `gesture pan` is a deliberate timed drag with one pointer, or two with `--pointer-count 2`. `gesture fling` is a fast directional throw. To update old scripts, see [Rewrite old gesture commands](/docs/migrating-gestures).
- `gesture pan --hold-ms <ms>` holds one pointer before it moves, for drag handles that expose no element and so no ref, such as reorder grips.
- `gesture drag source destination` holds one pointer from a selector or ref to another. It refuses coordinates; for a coordinate drag, use `gesture pan <x> <y> <dx> <dy> [ms] --hold-ms <ms>`. It and `--hold-ms` work on Android touch devices and iOS/iPadOS only.
- `gesture pinch`, `gesture rotate`, `gesture transform`, and two-finger `gesture pan` work in Android, iOS, and iPadOS app sessions. iOS sessions through a WebDriver provider refuse them. A path that does not fit the viewport fails instead of being clamped. Use `orientation` to rotate the device.
- `swipe` and `gesture` coordinates use the units `snapshot` reports: points on Apple platforms, not screenshot pixels. A gesture that leaves the viewport fails with `GESTURE_TRAJECTORY_OUT_OF_BOUNDS`, and the message names the viewport size and the first point outside it. A `gesture pinch`, `rotate`, `transform`, or two-finger `pan` that cannot keep its fingers far enough apart in the viewport fails the same way, and its message names only the viewport.
- `gesture tap` touches 2 to 5 points at once in Android and iOS/iPadOS app sessions. WebDriver providers refuse it unless they declare `tapGesture` support. Three or more fingers can trigger iOS system gestures such as undo, so verify app state afterwards. Use `press` for one finger.
- On iOS, a long press, scroll, or swipe that fails with `synthesized_gesture_not_dispatched` sent nothing, so a retry is safe. `synthesized_gesture_outcome_unknown` means it may have run; check the screen first.
- On iOS, a one-finger `gesture pan` can cross into the keyboard area. Use it for an intended drag where the app supports interactive keyboard dismissal.
- Apps may not report exactly the requested pan, scale, and rotation. Verify app state, and prefer separate `gesture pan`, `gesture pinch`, or `gesture rotate` commands when exact values matter. See `agent-device help gestures`.

### Scroll

<!-- generated:command scroll -->

Scroll in a direction or to an edge.

```bash
agent-device scroll <direction|top|bottom|refresh> [amount] [--until <selector>] [--max-passes <n>] [--pixels <n>] [--duration-ms <ms>] [--settle]
```

| Option | What it does |
| --- | --- |
| `--duration-ms <ms>` | Scroll: pace the gesture over this duration when supported; tv-remote: hold the button this long (Android TV long-presses on any positive value) |
| `--pixels <n>` | Scroll: explicit gesture distance in pixels |
| `--until <selector>` | Scroll: repeat passes until the selector is visible on screen |
| `--max-passes <n>` | Scroll --until: maximum gestures |
| `--no-post-gesture-stabilization` | Scroll, swipe, gesture swipe, open: skip the movement check and the stabilization wait that follow a gesture, and on a local iOS simulator the first-screen wait after an app launch; use it only when your own polling verifies the screen |

Also accepts: [common options](#common-options): `--settle`, `--settle-quiet <ms>`, `--timeout <ms>`.

Supported targets: [Scroll](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help scroll`.

<!-- /generated -->

Things to know:

- A scroll does not land on an exact position. The amount is a fraction of the viewport (`0.5` is half), and the app's scroll physics decide the final offset.
- To reach an off-screen element, use `scroll down --until <selector>`. It also works in `.ad` scripts on any screen size; see [Replay and E2E testing](/docs/replay-e2e). For a long list, raise `--max-passes`. If the request times out, inspect the screen and search again.
- `--settle` returns the settled diff with new refs, so you do not need another `snapshot -i` before the next action.
- Read `movement` in the result: `moved`, `at-edge`, `unchanged`, or `unobserved`. After `scroll refresh`, `unchanged` means that nothing changed on screen, not that a refresh found nothing new. Check the app's refresh indicator or content.
- `scroll refresh` is one slow pull down. On Android it starts inside the scroll container; on iOS it runs down the middle of the screen, so a list only in the top or bottom part of the screen is not pulled.
- With a keyboard up, the scroll stays above the keyboard and leaves it open. If too little room is left, end editing first: on Android, use `keyboard dismiss`; on iOS, use a visible dismissal control.
- A refused scroll names its cause in `details.reason`, and the hint gives the next step; see [error reasons](/docs/error-reasons#scroll). Run `scroll top` after `scroll_refresh_not_at_top`. Other reasons: `scroll_keyboard_occludes_surface`, `scroll_no_progress`, `scroll_until_pass_limit`, `scroll_until_edge_reached`, `scroll_until_no_progress`, `scroll_until_capture_unreadable`, `scroll_edge_pass_limit`, `scroll_edge_no_progress`, `scroll_edge_capture_unreadable`, `scroll_max_passes_requires_until`, and `scroll_max_passes_invalid`.
- `--no-post-gesture-stabilization` is for a caller that polls the screen itself, such as a test runner. Without your own polling, the next read can return a tree that is still moving. In the Node client or a batch step, pass `postGestureStabilization: false`. To apply it to every command, set `postGestureStabilization` to `false` in your user config, or set `AGENT_DEVICE_POST_GESTURE_STABILIZATION=0`.

## Retry after a failed command

When a command fails, read `error.details.dispatched` before you retry:

- `no`: the action never reached the device. Check `details.reason` before you retry.
- `unknown`: the action may have landed. Take a snapshot before you retry; a blind retry can tap, type, or navigate twice.
- Missing: no guarantee. Treat it as `unknown`.

Read-only commands such as `get`, `snapshot`, and `wait` report `no`. Once any step of a request reached the device, the failure is `unknown`.

For a failed `batch` or `replay`, check completed steps and `details.dispatchedSteps` first, because earlier steps may have run. A step refused with `bounded_composite_resource_unsupported` must run as a separate command: run it with its original arguments and the same `--session`. `details.standaloneCommandName` names the command but is not a complete command line.

An Apple runner that returns `COMMAND_ALREADY_FINISHED` cannot replay that command's outcome. Run `snapshot -i` to see the result before you send another interaction.

[Error reasons](/docs/error-reasons) lists the typed reasons by command and subsystem. These refusals carry `dispatched: no`, so nothing ran:

- `session_or_device_selector_required`: open a session or pass `--platform`.
- `named_session_not_found`: the daemon was replaced or restarted, or the name is wrong. Run `agent-device session list` to see the sessions it holds. Some commands report the same cause as `SESSION_NOT_FOUND` without a reason.
- `session_app_required`: run `open <app>`, or name the app, as in `settings clear-app-state com.example.app`.
- `app_not_installed`: run `apps --all` for the exact bundle id or package, or install the app.
- `malformed_request`: fix the client that built the request; resending it unchanged fails the same way.
- `remote_daemon_unavailable`: the remote daemon did not answer its health check. Make it reachable, or clear `--daemon-base-url` or `AGENT_DEVICE_DAEMON_BASE_URL`. For a saved `connect` connection, run `disconnect` to return to the local daemon.
- `webdriver_route_unsupported`: the device cloud's driver does not implement the route. The limit is the driver, not the device.
- `find` with no match (`COMMAND_FAILED`, no reason): no `find` action ran. Run `snapshot -i` to see the current elements, or scroll first if the element may be off-screen.

iOS runner refusals carry a typed `error.details.reason` too:

- `runner_busy`: the runner ran nothing. Retry the command.
- `runner_main_thread_timeout`: the action may still land (`dispatched: unknown`). Take a snapshot before you retry.
- `synthesized_gesture_not_dispatched` and `synthesized_gesture_outcome_unknown`: see [Pointer and gestures](#pointer-and-gestures).

The reasons that `back`, text entry, and `keyboard` report are listed under those commands.

## Find (semantic)

<!-- generated:command find -->

Find an element and act.

```bash
agent-device find <locator|text> [action] [value] [--first|--last]
```

| Option | What it does |
| --- | --- |
| `--record` | Force-record this action into a repair-armed heal; per-invocation only, the retired config key "record" no longer opts in (mutually exclusive with --no-record) |
| `--first` | Find: pick the first match when ambiguous |
| `--last` | Find: pick the last match when ambiguous |

Also accepts: [common options](#common-options): `--depth, -d <depth>`, `--raw`.

Supported targets: [Refs, selectors, element lookup, and attribute reads](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help find`.

<!-- /generated -->

```bash
agent-device find "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find role button click
agent-device find "Follow" list
```

`find` locates an element by text, label, or role and runs an action on it (`click` by default). See [Selectors](/docs/selectors) for the action list, ambiguous matches, and `--first`/`--last`.

## Assertions

<!-- generated:command is -->

Check a UI predicate on a selector.

```bash
agent-device is <predicate> <selector> [value] [--depth, -d <depth>] [--scope, -s <scope>] [--raw]
```

| Option | What it does |
| --- | --- |
| `--record` | Force-record this action into a repair-armed heal; per-invocation only, the retired config key "record" no longer opts in (mutually exclusive with --no-record) |

Also accepts: [common options](#common-options): `--depth, -d <depth>`, `--scope, -s <scope>`, `--raw`.

Supported targets: [Refs, selectors, element lookup, and attribute reads](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help is`.

<!-- /generated -->

```bash
agent-device is visible 'role="button" label="Continue"'
agent-device is exists 'id="primary-cta"'
agent-device is absent 'label="Loading..."'
agent-device is hidden 'text="Loading..."'
agent-device is editable 'id="email"'
agent-device is selected 'label="Wi-Fi"'
agent-device is checked 'role=switch label="Wi-Fi"'
agent-device is text 'id="greeting"' "Welcome back"
```


- `is` exits non-zero when the predicate fails. It takes selectors, not refs like `@e3`.
- Supported predicates are `visible`, `hidden`, `exists`, `absent`, `editable`, `selected`, `checked`, `focused`, and `text`.
- `is visible` passes when the element is in the visible viewport. `is exists` only checks that the selector matches.
- `is checked` passes only on a switch, checkbox, or radio that is explicitly checked. An iOS `mixed` state fails it.
- `is absent` passes only when a complete, readable, settled capture has zero matches. It does not mean hidden, and it refuses `--scope` and `--depth`.
- A predicate about one element fails with `AMBIGUOUS_MATCH` when the selector matches several nodes; that is not a missing element. The error lists up to five candidate refs, so you can act on one directly. See [Selectors](/docs/selectors#find-an-element).
- On iOS, React Native text appears as two nodes with the same label. `is`, `get attrs`, and replay treat the pair as one; `find ... list` and `snapshot --json` show both.
- On the web, static page text is readable by `wait text`, `find text`, `get text`, and `text=`, but it has no ref and is never a tap target. Use `text=` for page text, or add `editable=true` to name a field.
- The first read after a scroll or swipe can report `postGestureOutcome`. With `kind: "unsettled"` or `"loading"`, a miss does not prove absence, so read again. With `kind: "no-effect"`, nothing changed: the list may be at its edge or ignore synthesized scrolls, and a raw `swipe x1 y1 x2 y2` inside it can move it.

## Replay

<!-- generated:command replay -->

Replay a recorded session or Maestro flow.

```bash
agent-device replay <path> | replay export <file.ad> [--out <path>]
```

| Option | What it does |
| --- | --- |
| `--force, --overwrite` | Force replacement of existing state (connect: replace an active connection; --save-script: overwrite an existing target instead of refusing) |
| `--metro-host <host>` | Session-scoped Metro/debug host hint |
| `--metro-port <port>` | Session-scoped Metro/debug port hint; on an emulator/simulator the host defaults to the loopback alias, physical devices still need --metro-host |
| `--bundle-url <url>` | Session-scoped bundle URL hint |
| `--test-ime` | open/test/replay: activate the headless Android test IME for deterministic Unicode text entry (default on for emulators; opt-in on real devices; on test/replay it applies to the sessions the flow opens) |
| `--no-test-ime` | open/test/replay: keep the real Android keyboard even on emulators (opt out of the headless test IME; on test/replay it applies to the sessions the flow opens) |
| `--save-script [path]` | Arm a repair transaction from this replay (ADR 0012): recording starts at step 1, and the healed script commits when the repair-armed session tears down (close, close --save-script, or idle-reap). Independent of the open/close authoring arm-on-open. Optional custom output path. |
| `--update, -u` | Replay: retired as a rewrite (ADR 0012) — never edits the .ad file; every divergence already carries ranked selector suggestions, --update or not |
| `--from <n>` | Replay: resume at 1-based plan step n, skipping 1..n-1 without executing them (requires --plan-digest; see a divergence report's resume field). replay only, not test |
| `--plan-digest <sha256>` | Replay: the plan digest a --from resume must match (from a prior divergence report); mismatch, edits, or include/platform-expansion changes fail INVALID_ARGS before any action |
| `--keep-session` | Replay: leave the session active by suppressing exactly an authored terminal close in a native .ad script; replay only, not test or Maestro YAML |
| `--maestro` | Replay: treat input as a supported Maestro YAML subset; unsupported syntax fails loudly. See agent-device help maestro for commands and boundaries |
| `-e KEY=VALUE, --env KEY=VALUE` | Replay/Test: inject or override a ${KEY} variable for the script (repeatable) |

Also accepts: [common options](#common-options): `--timeout <ms>`, `--out <path>`.

Exact behavior: `agent-device help replay`.

<!-- /generated -->

<!-- generated:command test -->

Run replay test suites.

```bash
agent-device test <path-or-glob>...
```

| Option | What it does |
| --- | --- |
| `--metro-host <host>` | Session-scoped Metro/debug host hint |
| `--metro-port <port>` | Session-scoped Metro/debug port hint; on an emulator/simulator the host defaults to the loopback alias, physical devices still need --metro-host |
| `--bundle-url <url>` | Session-scoped bundle URL hint |
| `--test-ime` | open/test/replay: activate the headless Android test IME for deterministic Unicode text entry (default on for emulators; opt-in on real devices; on test/replay it applies to the sessions the flow opens) |
| `--no-test-ime` | open/test/replay: keep the real Android keyboard even on emulators (opt out of the headless test IME; on test/replay it applies to the sessions the flow opens) |
| `--update, -u` | Replay: retired as a rewrite (ADR 0012) — never edits the .ad file; every divergence already carries ranked selector suggestions, --update or not |
| `--maestro` | Replay: treat input as a supported Maestro YAML subset; unsupported syntax fails loudly. See agent-device help maestro for commands and boundaries |
| `-e KEY=VALUE, --env KEY=VALUE` | Replay/Test: inject or override a ${KEY} variable for the script (repeatable) |
| `--fail-fast` | Test: stop the suite after the first failing script; with sharding, each shard stops independently |
| `--retries <n>` | Test: retry each failed script up to n additional times |
| `--record-video` | Test: record each replay attempt to recording.mp4 in its attempt artifacts |
| `--artifacts-dir <path>` | Test: root directory for suite artifacts |
| `--reporter <name-or-path>` | Test: add a replay suite reporter; use default, junit:&lt;path>, or a custom reporter path (repeatable) |
| `--report-junit <path>` | Test: compatibility alias for --reporter junit:&lt;path> |
| `--shard-all <n>` | Test: run the full suite on each of n devices; combine with --device id1,id2 for explicit connected devices; AD_SHARD_INDEX is zero-based |
| `--shard-split <n>` | Test: split runnable suite entries across n devices; AD_SHARD_INDEX is zero-based |

Also accepts: [common options](#common-options): `--timeout <ms>`.

Exact behavior: `agent-device help test`.

<!-- /generated -->

```bash
agent-device open Settings --platform ios --session e2e --save-script [path]
agent-device replay ./session.ad      # Run deterministic replay from .ad script
agent-device test ./suite             # Run every .ad file in a folder or glob serially
agent-device test ./suite --timeout 60000 --retries 1
agent-device replay ./session.ad --from 4 --plan-digest <sha256>   # Execute step 4; if already completed, use the next safe index with this digest
agent-device replay ./session.ad --keep-session   # Suppress its terminal close and continue interactively
```

- `replay` reads script paths on the calling machine, so the same command works with a local or remote daemon.
- `test` runs a serial suite and streams `pass`/`fail`/`skip` on stderr (`--verbose` prints every result). `--platform` filters by each script's `context platform=...` header, `--timeout` and `--retries` (max `3`) apply per attempt, and artifacts default to `.agent-device/test-artifacts`.
- A failing step returns a `REPLAY_DIVERGENCE` report with the `--from` step and `--plan-digest` to resume from. See [Resume a failed replay](/docs/replay-e2e#resume-a-failed-replay).

See [Replay and E2E testing](/docs/replay-e2e) for recording and CI workflow details, and [Run Maestro flows](/docs/run-maestro-flows) for Maestro YAML.

## Batch

<!-- generated:command batch -->

Run multiple commands.

```bash
agent-device batch [--steps <json> | --steps-file <path>]
```

| Option | What it does |
| --- | --- |
| `--steps <json>` | Batch: JSON array of {"command","input"} steps |
| `--steps-file <path>` | Batch: read steps JSON from file |
| `--on-error stop` | Batch: stop when a step fails |
| `--max-steps <n>` | Batch: maximum number of allowed steps |

Also accepts: [common options](#common-options): `--out <path>`.

Exact behavior: `agent-device help batch`.

<!-- /generated -->

```bash
agent-device batch --steps-file /tmp/batch-steps.json --json
agent-device batch --steps '[{"command":"open","input":{"app":"settings"}}]'
```

- `batch` runs a JSON array of `{ command, input, runtime? }` steps in a single daemon request and stops at the first failing step.
- In non-JSON mode, successful batches print a short per-step summary.

See [Batching](/docs/batching) for payload format, response shape, and usage guidelines.

## App install (in-place)

<!-- generated:command install -->

Install an app binary from a path.

```bash
agent-device install <path> | install <app> <path> [--os <version|range>] [--image-tag <tag>] [--device-mode <slim|full>] [--device-baseline <name>] [--physical]
```

| Option | What it does |
| --- | --- |
| `--os <version\|range>` | Proxy lease: OS version or range the backend picks the device by (Android: API level); refused without such a backend |
| `--image-tag <tag>` | Proxy lease: Android system image tag the backend picks the device by; refused without such a backend |
| `--device-mode <slim\|full>` | Proxy lease: iOS simulator mode (slim or full) the backend leases; refused without such a backend |
| `--device-baseline <name>` | Proxy lease: saved device state (baseline) the backend restores on the leased device; refused without such a backend |
| `--physical` | Proxy lease: ask the backend for a physical device instead of a simulator or emulator; refused without such a backend |

Supported targets: [Install and reinstall an app](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help install`.

<!-- /generated -->

```bash
agent-device install com.example.app ./build/app.apk --platform android
agent-device install com.example.app ./build/MyApp.app --platform ios
agent-device install ./build/entry-default-signed.hap --platform harmonyos
```

- `install <app> <path>` installs without uninstalling first and keeps app data where the platform allows. Use it for upgrade flows.
- It supports Android devices and emulators, iOS simulators, CoreDevice iOS devices, and HarmonyOS devices. On xctrace-only devices, install the app with Xcode before you open it by bundle ID.
- Formats: Android `.apk`/`.aab`, iOS `.app`/`.ipa`, HarmonyOS `.hap`. For an `.ipa` with several app bundles, `<app>` picks one by bundle id or name.
- `.aab` needs `bundletool` in `PATH`, or `AGENT_DEVICE_BUNDLETOOL_JAR=<absolute-path-to-bundletool-all.jar>` with `java` in `PATH`.
- Remote daemons upload local app files for you. Prefix the path with `remote:` to use a path on the daemon host. A public remote daemon refuses host paths with `REMOTE_HOST_INPUT_DENIED`.

## App reinstall (fresh state)

<!-- generated:command reinstall -->

Replace an installed app with a new build.

```bash
agent-device reinstall <app> <path> [--os <version|range>] [--image-tag <tag>] [--device-mode <slim|full>] [--device-baseline <name>] [--physical]
```

| Option | What it does |
| --- | --- |
| `--os <version\|range>` | Proxy lease: OS version or range the backend picks the device by (Android: API level); refused without such a backend |
| `--image-tag <tag>` | Proxy lease: Android system image tag the backend picks the device by; refused without such a backend |
| `--device-mode <slim\|full>` | Proxy lease: iOS simulator mode (slim or full) the backend leases; refused without such a backend |
| `--device-baseline <name>` | Proxy lease: saved device state (baseline) the backend restores on the leased device; refused without such a backend |
| `--physical` | Proxy lease: ask the backend for a physical device instead of a simulator or emulator; refused without such a backend |

Supported targets: [Install and reinstall an app](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help reinstall`.

<!-- /generated -->

```bash
agent-device reinstall com.example.app ./build/app.apk --platform android
agent-device reinstall com.example.app ./build/MyApp.app --platform ios
```

- `reinstall <app> <path>` uninstalls and installs in one command, for login resets and repeatable test setup. Device coverage, formats, and remote upload match `install`.
- On iOS and Android, if the new archive cannot be unpacked, the installed app and its data stay. An install failure after the uninstall can still leave the app removed.

## App uninstall

<!-- generated:command uninstall -->

Remove an installed app.

```bash
agent-device uninstall <app> [--os <version|range>] [--image-tag <tag>] [--device-mode <slim|full>] [--device-baseline <name>] [--physical]
```

| Option | What it does |
| --- | --- |
| `--os <version\|range>` | Proxy lease: OS version or range the backend picks the device by (Android: API level); refused without such a backend |
| `--image-tag <tag>` | Proxy lease: Android system image tag the backend picks the device by; refused without such a backend |
| `--device-mode <slim\|full>` | Proxy lease: iOS simulator mode (slim or full) the backend leases; refused without such a backend |
| `--device-baseline <name>` | Proxy lease: saved device state (baseline) the backend restores on the leased device; refused without such a backend |
| `--physical` | Proxy lease: ask the backend for a physical device instead of a simulator or emulator; refused without such a backend |

Supported targets: [Uninstall an app](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help uninstall`.

<!-- /generated -->

```bash
agent-device uninstall com.example.app --platform android
```

- `uninstall <app>` removes an installed app, for example to start a test without it. Device coverage matches `install`.
- A package name or bundle id that is not installed succeeds with `wasInstalled: false`. Another name that matches nothing fails with `APP_NOT_INSTALLED`.

## App install from source URL

<!-- generated:command install-from-source -->

Install app builds from URLs.

```bash
agent-device install-from-source <url>
```

| Option | What it does |
| --- | --- |
| `--header <name:value>` | install-from-source: repeatable HTTP header for URL downloads |
| `--retain-paths` | install-from-source: keep materialized artifact paths after install |
| `--retention-ms <ms>` | install-from-source: retain files for 1-2147483647 ms |

Supported targets: [Install from a source URL](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help install-from-source`.

<!-- /generated -->

```bash
agent-device install-from-source https://example.com/builds/app.apk --platform android
agent-device install-from-source https://example.com/builds/app.aab --platform android
```

- `install-from-source <url>` installs an artifact that the daemon can reach at a URL. Use `install` or `reinstall` for local files. Device coverage matches `install`.
- A URL may point to an Android `.apk` or `.aab`, or to an archive with one `.apk`, `.aab`, `.ipa`, or iOS `.app`.
- Sensitive `--header` values are not forwarded to other origins.
- `--retain-paths` keeps the downloaded and extracted files for a while, so you can inspect them.
- Downloads follow at most five redirects, never downgrade HTTPS to HTTP, and are size-limited. `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are honored.

### Install a GitHub Actions artifact

GitHub gives each artifact a signed download URL. The URL needs no credentials, so the device or remote daemon can fetch the build directly. The URL expires after about one minute, so get it right before the install:

```bash
url=$(curl -fsS -o /dev/null -w '%{redirect_url}' \
  -H "Authorization: Bearer $(gh auth token)" \
  https://api.github.com/repos/<owner>/<repo>/actions/artifacts/<artifact-id>/zip)
agent-device install-from-source "$url" --platform android
```

In a GitHub Actions job, use `${{ secrets.GITHUB_TOKEN }}` instead of `gh auth token`. The token stays on the machine that runs the command.

## Push notification simulation

<!-- generated:command push -->

Deliver a push notification payload.

```bash
agent-device push <bundleOrPackage> <payloadOrJson>
```

Supported targets: [Push notification simulation](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help push`.

<!-- /generated -->

```bash
agent-device push com.example.app ./payload.apns --platform ios
agent-device push com.example.app '{"aps":{"alert":"Welcome","badge":1}}' --platform ios
agent-device push com.example.app '{"action":"com.example.app.PUSH","extras":{"title":"Welcome","unread":3,"promo":true}}' --platform android
```

- `push` takes a payload file or inline JSON and delivers to the session device or the one named by `--platform`, `--device`, `--udid`, or `--serial`.
- iOS: simulator only, with an APNs-style JSON object payload.
- A daemon that serves the public remote surface accepts only an inline JSON object payload. It refuses payload file paths with reason `REMOTE_HOST_INPUT_DENIED`.
- Android: sends a broadcast with the payload `{"action":"<intent-action>","receiver":"<optional component>","extras":{...}}`. Extras may be strings, booleans, or numbers.

## App event triggers (app hook)

<!-- generated:command trigger-app-event -->

Invoke an app-defined automation event.

```bash
agent-device trigger-app-event <event> [payloadJson]
```

Supported targets: [App event triggers through the app hook](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help trigger-app-event`.

<!-- /generated -->

```bash
agent-device trigger-app-event screenshot_taken '{"source":"qa"}'
```

- `trigger-app-event` opens your app's deep-link hook with an app-defined event; it does not post OS-level notifications. `payloadJson` must be a JSON object.
- Needs an active session or a device selector (`--platform`, `--device`, `--udid`, `--serial`). On iOS physical devices, open the app in the session first.
- Set the URL template with `AGENT_DEVICE_APP_EVENT_URL_TEMPLATE`, or per platform with `AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE`, `AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE`, or `AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`. Placeholders are `{event}`, `{payload}`, and `{platform}`, for example `myapp://agent-device/event?name={event}&payload={payload}`.

## Settings helpers

<!-- generated:command settings -->

Change OS settings and app permissions.

```bash
agent-device settings <wifi|bluetooth|airplane|mobile-data|keep-awake|location|animations> <on|off> | settings location set <lat> <lon> | settings appearance <light|dark|toggle> | settings text-size [extra-small|small|medium|large|extra-large|extra-extra-large|extra-extra-extra-large|accessibility-medium|accessibility-large|accessibility-extra-large|accessibility-extra-extra-large|accessibility-extra-extra-extra-large] | settings <faceid|touchid> <match|nonmatch|enroll|unenroll> | settings fingerprint <match|nonmatch> | settings clear-app-state [app-id] | settings reset-keychain clear | settings permission <grant|deny|reset> <all|camera|microphone|contacts|contacts-limited|notifications|calendar|location|location-always|media-library|motion|reminders|siri> | settings permission <grant|deny|reset> photos [full|limited] | settings permission <grant|reset> <accessibility|screen-recording|input-monitoring> [--app <id-or-name>]
```

| Option | What it does |
| --- | --- |
| `--app <id-or-name>` | Target an app without opening it: doctor verifies an installed app by id or name; settings applies an app-scoped change (permission, iOS location) to a bundle id or package |

Supported targets: [System and app settings helpers](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help settings`.

<!-- /generated -->

```bash
agent-device settings wifi off
agent-device settings mobile-data off
agent-device settings location set 37.3349 -122.009
agent-device settings animations off
agent-device settings text-size accessibility-extra-large
agent-device settings appearance dark
agent-device settings faceid match
agent-device settings fingerprint nonmatch
agent-device settings clear-app-state com.example.app
agent-device settings permission grant photos limited
agent-device settings permission grant camera --app com.example.app
agent-device settings permission grant accessibility --platform macos
```


Use `settings` to set up device state before a flow, not to answer a dialog already on screen. `agent-device help settings` lists where each setting runs.

Platform support:

- iOS `settings` works on simulators only.
- macOS supports only `settings appearance` and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>`.
- `settings location set <lat> <lon>` works on iOS simulators and Android emulators.
- A target that does not serve a setting refuses it with `UNSUPPORTED_OPERATION` before anything changes.

Device settings:

- `settings animations off` (Android) stabilizes runs with heavy animation. Turn animations back on afterwards.
- `settings bluetooth` and `settings mobile-data` are Android only and need adb. `settings bluetooth` needs Android 8.1 or newer, and `settings airplane` needs Android 11 or newer. Connectivity takes a moment to settle, so poll the app instead of asserting offline behavior at once.
- On iOS simulators, `settings wifi` and `settings airplane` change only the status bar, and the output prints a warning that says so. The simulator keeps using the Mac's network, so these settings cannot test offline behavior.
- Pair `settings mobile-data on` with `settings wifi off` to move a session, such as a video stream, from Wi-Fi to cellular. On a multi-SIM device, or one without an active SIM, the command can fail even when the switch took effect.
- `settings text-size` without a category reads the current size. It works on iPhone and iPad simulators and on Android. A running app picks up a new size only after `open <app> --relaunch`.

Biometrics:

- `faceid` and `touchid` work on iPhone and iPad simulators. `fingerprint` works on Android emulators and on devices that have `cmd fingerprint`.
- `match` and `nonmatch` simulate a valid or invalid scan. `enroll` and `unenroll` change enrollment.

App state:

- `settings clear-app-state [app-id]` clears the data of the session app or the named app. It is unsupported on iOS physical devices and macOS.
- It does not touch the keychain, so keychain-backed logins survive. `settings reset-keychain clear` resets the iOS simulator keychain for **every** app on that simulator; pair it with `clear-app-state` for a fresh-install reset.
- A built-in app with no data container, such as `com.apple.Preferences`, refuses with `app-no-data-container`. Erase or recreate the simulator to reset it.

Permissions:

- On iOS and Android, `permission` applies to the session app. Pass `--app <bundle-id, package, or name>` to target an installed app without opening it, for example to grant a permission before first launch. `--app` counts only on the command line; `AGENT_DEVICE_TARGET_APP` never retargets a settings change.
- Refusals change nothing: `app_not_installed` (install the app or fix the id), `session_app_required` (run `open <app>` or name the app), `setting_app_not_package` (an Android intent alias such as `settings` is not a package), and `setting_app_not_consumed` (a device-wide setting such as `location set`, `mobile-data`, or `bluetooth` takes no app).
- On iOS simulators, the simulator decides which permissions it can change and refuses the rest. `grant all` skips a refused service with a warning.
- On Android, a permission group applies only the permissions the app declares. `full|limited` applies only to iOS `photos`.
- Android kills a running app when you revoke one of its granted permissions. After `deny` or `reset`, run `open <app> --relaunch` when the warning says so.
- On macOS, `grant` opens System Settings when access needs your approval; it never grants silently. `deny` is unsupported.

## App state and app lists

<!-- generated:command appstate -->

Show the foreground app and activity.

```bash
agent-device appstate
```

Supported targets: [Foreground app state](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help appstate`.

<!-- /generated -->

<!-- generated:command apps -->

List installed apps or deferred provider app assets.

```bash
agent-device apps [--all]
```

| Option | What it does |
| --- | --- |
| `--all` | Apps: include system/OEM apps |

Supported targets: [Installed app list](/docs/capabilities#apps-and-devices).

Exact behavior: `agent-device help apps`.

<!-- /generated -->

```bash
agent-device appstate
agent-device apps --platform ios
agent-device apps --platform ios --all
agent-device apps --platform android
agent-device apps --platform android --all
```

- Android and HarmonyOS `appstate` report the live foreground package and activity.
- iOS and macOS `appstate` need a session and report that session's app. On iOS, a live runner adds the app's `state`, such as `runningBackground` after `home`. `appstate` never starts a runner. It does not report which other app took the screen. A command that had to bring the app back reports a [`targetActivation` disclosure](#foreground-repairs-on-ios).

## Foreground repairs on iOS

An iOS session is bound to one app, but a deep link or a system sheet can hand the screen to another app. The next command brings the session app back so it can answer, and reports that repair:

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

- Anything captured earlier in the session described the other app. Capture again, or drive the other app in its own session.
- **Silence is not proof.** A coordinate `press`, a `press @ref`, or a `wait <text>` that passes at once can bring the app back without saying so. When it matters, run `snapshot -i` and read its disclosure.
- A coordinate `press` on a system surface, such as a notification banner or Control Center, runs in place and does not bring the app back.
- No read starts a stopped app, because a launch could drop a URL waiting behind an "Open in …?" prompt. Reads fail with `APP_NOT_RUNNING` instead. Answer the prompt with `alert accept`, or relaunch with `open`.

## Clipboard

<!-- generated:command clipboard -->

Read or write device clipboard text.

```bash
agent-device clipboard read | clipboard write <text>
```

Supported targets: [Clipboard read and write](/docs/capabilities#system-and-hardware).

Exact behavior: `agent-device help clipboard`.

<!-- /generated -->

```bash
agent-device clipboard write ""   # clear clipboard
```

Things to know:

- Treat `clipboard read` output as sensitive. It can contain copied secrets.
- The command works without a session when you pass a device selector (`--platform`, `--device`, `--udid`, `--serial`).
- iOS physical devices return `UNSUPPORTED_OPERATION`. Android 16 (API 36) does too, and `capabilities` omits `clipboard` there; see [Known limitations](/docs/known-limitations#android-no-clipboard-access-over-adb-on-android-16).

## Keyboard

<!-- generated:command keyboard -->

Inspect, press, or dismiss the device keyboard.

```bash
agent-device keyboard [status|get|dismiss|enter|return]
```

Supported targets: [Keyboard dismiss, enter, and status](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help keyboard`.

<!-- /generated -->

Things to know:

- `keyboard status` reports whether the software keyboard is visible and, when it can tell, the Return key's action as `returnKey`.
- `keyboard enter` sends Return to the focused input, so focus the intended field first. The app decides what Return does. If it returns `keyboard_return_unavailable`, check the screen before you retry, because Return may have reached the app.
- On iOS, `keyboard dismiss` does not close a visible keyboard: it returns `keyboard_dismiss_unavailable` and presses nothing. Press the visible Hide Keyboard key or the app control that ends editing. If the app supports interactive dismissal, drag down inside the scrollable content with `gesture pan x y 0 dy durationMs` and a positive `dy`.
- On Android, `keyboard dismiss` returns `keyboard_dismiss_unavailable` when the keyboard stays up.

## Performance diagnostics

<!-- generated:command perf -->

Check frames, memory, or native profiles.

```bash
agent-device perf frames --json
agent-device perf memory sample --json
agent-device perf memory snapshot [--kind android-hprof|memgraph] [--out <path>]
agent-device perf cpu profile start --kind xctrace [--template <name>] --out <profile.trace>
agent-device perf cpu profile stop --kind xctrace --out <profile.trace>
agent-device perf cpu profile report --kind xctrace [--template <name>] --out <report.json>
agent-device perf trace start --kind xctrace [--template <name>] --out <path>
agent-device perf trace stop --kind xctrace --out <path>
agent-device perf cpu profile start --kind simpleperf --out <cpu.perf.data>
agent-device perf cpu profile stop --kind simpleperf
agent-device perf cpu profile report --kind simpleperf --out <cpu-report.json>
agent-device perf trace start|stop --kind perfetto [--out <path>]
```

**`perf frames`**

Reads no options.

**`perf memory sample`**

Reads no options.

**`perf memory snapshot`**

| Option | What it does |
| --- | --- |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--out <path>` | Output path |

**`perf cpu profile start`**

| Option | What it does |
| --- | --- |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--template <name>` | Perf xctrace template name, for example Time Profiler |
| `--out <path>` | Output path |

**`perf cpu profile stop`**

| Option | What it does |
| --- | --- |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--out <path>` | Output path |

**`perf cpu profile report`**

| Option | What it does |
| --- | --- |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--template <name>` | Perf xctrace template name, for example Time Profiler |
| `--out <path>` | Output path |

**`perf trace start`**

| Option | What it does |
| --- | --- |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--template <name>` | Perf xctrace template name, for example Time Profiler |
| `--out <path>` | Output path |

**`perf trace stop`**

| Option | What it does |
| --- | --- |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--out <path>` | Output path |

Supported targets: [Performance samples (frames, memory, CPU profiles)](/docs/capabilities#evidence-and-diagnostics).

Exact behavior: `agent-device help perf`.

<!-- /generated -->

<!-- generated:command cdp -->

Inspect CDP targets, JS heap, and leaks.

```bash
agent-device cdp [...args]
```

Exact behavior: `agent-device help cdp`.

<!-- /generated -->

```bash
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
```

- Name one area: `frames`, `memory`, `cpu`, or `trace`. Perf commands need an app session; run `open <app>` first.
- `perf frames` returns frame health, such as `droppedFramePercent`. `perf memory sample` returns a compact memory sample. `perf memory snapshot`, `perf cpu profile`, and `perf trace` write artifacts and return their paths.
- `cdp` samples the React Native JavaScript heap through Metro; see [Debugging and profiling](/docs/debugging-profiling#react-native-js-memory-through-cdp).
- App startup duration is in the `startup` result of `open`.
- Platform limits that decide which command to use:
  - `perf frames`: Android, and connected iOS devices. iOS simulators and macOS report it unavailable.
  - `perf memory snapshot --kind android-hprof`: Android, for a debuggable or profileable process. `--kind memgraph`: iOS simulators and macOS.
  - `--kind xctrace`: iOS simulators, connected iOS devices, and macOS. It does not profile Android; use `--kind simpleperf` or `--kind perfetto` there. All three need the app running.
  - HarmonyOS is memory-only.

For the measurement workflow and output examples, see [Performance snapshots](/docs/debugging-profiling#performance-snapshots).

## React Native components

<!-- generated:command react-devtools -->

React Native components, props/state/hooks, and render profiling.

```bash
agent-device react-devtools tree [@ref|Name]|find <Name>|inspect <@ref|Name>|errors|profile start|stop|report [Component]|commit [N]
```

Exact behavior: `agent-device help react-devtools`.

<!-- /generated -->

```bash
agent-device react-devtools tree [@ref|Name] [--depth 8] [--limit 60]
agent-device react-devtools find <Name> [--exact] [--limit 20]
agent-device react-devtools inspect <@ref|Name>
agent-device react-devtools errors [--limit 10]
```

- `tree` prints the mounted component tree with `@c` refs. Pass a ref or a unique name to print one branch.
- `find` lists components whose name contains the text. `inspect` prints a component's owners, props, state, hooks, and logged errors.
- `errors` lists the components that logged console errors or warnings while rendering. On React Native 0.74 and 0.76, the list can be incomplete.
- An open React DevTools window owns the component tree, so `tree`, `find`, and `errors` fail with `tree-unavailable` until you close it and the app reloads.

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


- `profile start` records React renders. `profile stop` ends the recording, prints the slowest commits and up to five findings, and saves the recording for `report` and `commit`.
- `profile report` lists components by self time with why they rendered. `profile commit <N>` shows what rendered in one commit.
- Profiling connects through the app's Metro dev server and needs no setup. It works with development builds of React Native 0.74 and later on Android emulators, iOS simulators, `agent-device proxy` connections, and remote bridge sessions. On a remote bridge, it needs the Metro server next to the agent, from `metro prepare` or `--metro-host`/`--metro-port`.
- When several apps or devices share one dev server, pick one with `--app <bundle-id>` or `--metro-device <name>`.
- See [Debugging and profiling](/docs/debugging-profiling#react-native-performance-profiling) for the findings and the workflow.

## React Native overlays

<!-- generated:command react-native -->

Run React Native automation helpers.

```bash
agent-device react-native dismiss-overlay
```

Supported targets: [React Native overlay dismissal](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help react-native`.

<!-- /generated -->

```bash
agent-device react-native dismiss-overlay --platform android
```

- `react-native dismiss-overlay` clears a development overlay (redbox/LogBox error or collapsed warning banner) that blocks interaction, and is a no-op when none is present. It works on iOS simulators/devices and Android emulators/devices.

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
- `open` points the app at the Metro server you name, including an Expo dev client that registers a single `exp+<slug>` scheme. A dev build that boots straight into its embedded bundle still needs a native rebuild.
- Each session remembers its dev server for a flagless `metro reload --session <name>`; see [Metro reload](#metro-reload).
- Rebuild and reinstall when native code, native dependencies, bundle identifiers, entitlements, or generated native project files change.
- Close every session when done:

```bash
agent-device close --platform ios --session rn-a
agent-device close --platform ios --session rn-b
```

## Metro reload

<!-- generated:command metro -->

Prepare the dev server or reload apps.

```bash
agent-device metro prepare (--public-base-url <url> | --proxy-base-url <url>) [--project-root <path>] [--port <port>] [--kind auto|react-native|expo|repack]
agent-device metro reload [--metro-host <host>] [--metro-port <port>] [--bundle-url <url>]
```

**`metro prepare`**

| Option | What it does |
| --- | --- |
| `--project-root <path>` | metro prepare: React Native project root (default: cwd) |
| `--kind <kind>` | Kind selector for commands that support it, such as metro prepare or perf artifact collectors |
| `--metro-kind auto\|react-native\|expo\|repack` | metro prepare: detect or force the React Native dev-server launcher kind |
| `--public-base-url <url>` | metro prepare: public base URL used for direct dev-server bundle hints |
| `--proxy-base-url <url>` | metro prepare: optional bridge origin for remote dev-server access |
| `--bearer-token <token>` | metro prepare: host bridge bearer token (or AGENT_DEVICE_METRO_BEARER_TOKEN; falls back to AGENT_DEVICE_DAEMON_AUTH_TOKEN) |
| `--port <port>` | metro prepare: local dev-server port (default: 8081) |
| `--listen-host <host>` | metro prepare: host dev server listens on (default: 0.0.0.0) |
| `--status-host <host>` | metro prepare: host used for local dev-server /status polling (default: 127.0.0.1) |
| `--startup-timeout-ms <ms>` | metro prepare: timeout while waiting for the dev server to become ready |
| `--probe-timeout-ms <ms>` | metro prepare: timeout for /status and proxy bridge calls; metro reload: timeout for the reload request |
| `--runtime-file <path>` | metro prepare: optional file path to persist the JSON result |
| `--no-reuse-existing` | metro prepare: always start a fresh Metro process |
| `--no-install-deps` | metro prepare: skip package-manager install when node_modules is missing |

**`metro reload`**

| Option | What it does |
| --- | --- |
| `--metro-host <host>` | Session-scoped Metro/debug host hint |
| `--metro-port <port>` | Session-scoped Metro/debug port hint; on an emulator/simulator the host defaults to the loopback alias, physical devices still need --metro-host |
| `--probe-timeout-ms <ms>` | metro prepare: timeout for /status and proxy bridge calls; metro reload: timeout for the reload request |
| `--bundle-url <url>` | Session-scoped bundle URL hint |

Exact behavior: `agent-device help metro`.

<!-- /generated -->

```bash
agent-device metro reload
agent-device metro reload --metro-host localhost --metro-port 8081
agent-device metro reload --bundle-url "http://localhost:8081/index.bundle?platform=ios"
```

- `metro reload` asks connected React Native dev builds to reload JavaScript without restarting the native process, like pressing `r` in the Metro terminal.
- Without flags, it reloads the dev server the session bound through `metro prepare` or `open`'s Metro hints. When no session bound one, and the daemon that answered `open` reported the session's device as one of its own local devices, it next uses the dev-server address the app itself stored (an iOS simulator only) when a dev server there serves this project, then a local dev server whose reported project root is this directory or a parent or child of it. Run it from the project's own directory, or pass `--metro-port`, because a local search matches the working directory. If neither local lookup resolves, it fails with `details.reason: 'metro_dev_server_unresolved'`; a provider device, a device inherited from an earlier request, or an app-less session retains the existing `localhost:8081` default. A reused session name never reloads a previous project's server.
- Use `open <app> --relaunch` instead when the app is not connected to Metro, the reload fails, or the native process must restart. See `agent-device help metro` for the binding rules.

## Media and logs

<!-- generated:command screenshot -->

Capture a screenshot.

```bash
agent-device screenshot [path] [--out <path>] [--overlay-refs] [--crop-on <selector-expression>] [--pixel-density <n>] [--screen-mask <black>] [--fullscreen, --full, -f] [--scale <0.01-1>] [--no-stabilize] [--normalize-status-bar] [--capture-backend runner]
```

| Option | What it does |
| --- | --- |
| `--overlay-refs` | Screenshot: draw current snapshot refs and target rectangles onto the saved PNG; diff screenshot: also write a separate current-screen overlay guide |
| `--crop-on <selector-expression>` | Screenshot: crop the capture to the frame of the selector resolved on the same screen |
| `--pixel-density <n>` | Screenshot: output PNG pixel density in pixels per logical point; iOS-family simulators only, other targets refuse it |
| `--screen-mask <black>` | Screenshot or live screenshot diff: fill the iOS simulator screen outline with black; requires simctl capture |
| `--fullscreen, --full, -f` | Screenshot: on web capture the full page; on macOS app sessions capture the full desktop instead of the app window |
| `--scale <0.01-1>` | Screenshot: resize both dimensions by this factor (or use AGENT_DEVICE_SCREENSHOT_SCALE) |
| `--no-stabilize` | Screenshot: capture immediately without Android status-bar stabilization (the default) |
| `--normalize-status-bar` | Screenshot: temporarily normalize iOS simulator or ADB-backed Android status-bar chrome for deterministic screenshot diffs; ADB-backed Android waits for transient UI to fade |
| `--capture-backend runner` | Screenshot: on Apple targets capture through the XCTest runner (XCUIScreen), which leaves out the simulator-drawn Dynamic Island, instead of simctl; refused on other platforms, provider sessions and macOS surfaces the helper captures, and with --pixel-density, --screen-mask and --normalize-status-bar |

Also accepts: [common options](#common-options): `--out <path>`.

Supported targets: [Screenshots](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help screenshot`.

<!-- /generated -->

<!-- generated:command viewport -->

Resize the active web viewport for the current session.

```bash
agent-device viewport <width> <height>
```

Supported targets: [Hover and viewport size](/docs/capabilities#interact-with-the-app).

Exact behavior: `agent-device help viewport`.

<!-- /generated -->

```bash
agent-device screenshot                 # Auto filename
agent-device screenshot page.png --scale 0.3
agent-device screenshot page.png --overlay-refs
agent-device screenshot page.png --crop-on 'label="Save"'
agent-device screenshot baseline.png --screen-mask black --normalize-status-bar
agent-device viewport 1280 900 --platform web   # For fixed-layout or 100vh apps
agent-device diff screenshot --baseline baseline.png --out diff.png
agent-device diff screenshot --baseline baseline.png current.png --out diff.png
agent-device record start session.mp4 --scope device
agent-device record stop
```

**Screenshots**

- Set `AGENT_DEVICE_SCREENSHOT_SCALE=0.3` or `screenshotScale` in config to save tokens by default; `--scale` overrides it. Leave it unset or pass `--scale 1` for pixel-diff baselines. `--max-size` is refused; use `--scale`.
- ADB-backed Android screenshots capture at once. Use `--normalize-status-bar` for repeatable status-bar chrome and to wait for transient UI to fade.
- `--overlay-refs` takes a new snapshot and draws refs on the image. With `--json`, each ref also has a screenshot-space `center` for a `press <x> <y>` fallback. At small scales, labels can become unreadable.
- `--crop-on` works on iOS simulators, Android emulators, physical iPhones in portrait, and the Tizen and webOS TV plugins. It needs exactly one framed node, and the crop is re-encoded, so do not byte-compare it with an older crop.
- On macOS, `--fullscreen` applies only to app sessions. Other surfaces always capture the main display.
- On iOS simulators with a Dynamic Island, use `--capture-backend runner` to leave the island out of the capture.
- `--screen-mask black` blacks out the screen's rounded corners on handheld iOS simulators. It does not redact app content.
- The result can report `displayRotation`. The saved image is always upright.

**Screenshot diffs**

<!-- generated:command diff -->

Diff snapshot or screenshot.

```bash
agent-device diff snapshot [-i] [-d <depth>] [-s <scope>] [--raw] | diff screenshot --baseline <path> [current.png] [--out <diff.png>] [--threshold <0-1>] [--overlay-refs] [--screen-mask <black>]
```

**`diff snapshot`**

| Option | What it does |
| --- | --- |
| `-i` | Snapshot: interactive elements only |
| `--depth, -d <depth>` | Snapshot: limit snapshot depth |
| `--scope, -s <scope>` | Snapshot: scope snapshot to label/identifier |
| `--raw` | Snapshot: raw node output |

**`diff screenshot`**

| Option | What it does |
| --- | --- |
| `--out <path>` | Output path |
| `--overlay-refs` | Screenshot: draw current snapshot refs and target rectangles onto the saved PNG; diff screenshot: also write a separate current-screen overlay guide |
| `--screen-mask <black>` | Screenshot or live screenshot diff: fill the iOS simulator screen outline with black; requires simctl capture |
| `--baseline, -b <path>` | Diff screenshot: path to baseline image file |
| `--threshold <0-1>` | Diff screenshot: color distance threshold (default 0.1) |

Supported targets: [Accessibility snapshot, snapshot diff, and audit](/docs/capabilities#inspect-and-verify-the-ui).

Exact behavior: `agent-device help diff`.

<!-- /generated -->

- `diff screenshot` compares a live capture, or a saved `current.png` with no session, against `--baseline`. It ranks changed regions; `--out` writes a diff PNG with changed pixels tinted red. It reads no text, so look at the images yourself for a qualitative review.
- Keep `--threshold` above `0` when either input is JPEG.
- An image of another size is scaled to the baseline width. Extra or missing rows at the bottom count as differences, and system bars are not cropped.
- `--overlay-refs` also lists the refs under changed regions. It needs a live capture.
- Live iOS simulator diffs normalize status-bar chrome. Pass `--screen-mask black` to match a baseline captured with `screenshot --screen-mask black`.

**Recordings**

<!-- generated:command record -->

Start or stop screen recording.

```bash
agent-device record start [path] [--scope <app|device|system>] [--fps <n>] [--quality <medium|high>] [--hide-touches] | record stop | record contact-sheet <video.mp4> [--out <sheet.png>]
```

**`record start`**

| Option | What it does |
| --- | --- |
| `--fps <n>` | Record: target frames per second (iOS physical device runner); also lowers the touch-overlay rate, which never exceeds 30 |
| `--quality <medium\|high>` | Record: output quality preset; Android maps this to screenrecord bitrate, Limrun sessions map medium to recorder quality 5 and high to 8; Apple export always preserves the captured resolution, so it has no effect there. Legacy numeric values 5-7 map to medium; 8-10 map to high |
| `--hide-touches` | Record: skip touch-overlay post-processing for faster raw benchmark videos |
| `--scope <app\|device\|system>` | Record: app requires an active app session; device/system records the whole screen |

**`record stop`**

Reads no options.

**`record contact-sheet`**

| Option | What it does |
| --- | --- |
| `--out <path>` | Output path |

Supported targets: [Screen recording](/docs/capabilities#evidence-and-diagnostics).

Exact behavior: `agent-device help record`.

<!-- /generated -->

- `record start` defaults to app scope, which needs an active app session from `open <app>`; the backend decides what is captured. A local iOS simulator recording always captures the whole display, even at app scope. Use `--scope device` or `--scope system` for whole-screen capture (several apps, settings, the home screen) where the backend supports it.
- On physical iOS devices, a recording is a series of runner screenshots: no audio, about 15 FPS by default, and dropped frames are expected.
- Burned-in touch overlays export only on macOS hosts. Elsewhere, or when the export takes too long, `record stop` returns the raw video with `overlayWarning`.
- Android splits long recordings into MP4 chunks. A clip can end early when the screen stops changing; `capturedDurationMs` and a warning report how much the video covers.
- `android_screenrecord_startup_failed` means the device refused to record, and `details.stderr` holds the device's message. agent-device has no other Android recording backend.
- Limrun sessions always record the whole screen.
- `apple_simulator_recording_busy` means another recording holds the simulator. Run `record stop` in the session that owns it.
- `record stop` is safe to repeat. If it returns `video_validator_compile_timeout`, or the request ends during export, run `record stop` again; the recording is kept. `video_validator_unavailable` names a host failure to repair before you retry.
- `record start --scope device` without a session creates one, and `record stop` ends it, unless something else started using the session meanwhile.
- On a remote daemon, a recording whose leased session ends stays downloadable by the tenant for a short time through `GET /artifacts`.
- `record contact-sheet` turns an exported MP4 into one PNG grid of the frames where the screen changed, each labeled with its time. It needs no session and runs on macOS hosts only. A short-lived screen between samples can be missing.

**Session app logs:** See [Debugging and profiling](/docs/debugging-profiling#logs) for the clean-repro and grep workflow.

<!-- generated:command logs -->

Manage session app logs.

```bash
agent-device logs path | logs start | logs stop | logs clear [--restart] | logs doctor | logs mark [message...]
```

**`logs path`**

Reads no options.

**`logs start`**

Reads no options.

**`logs stop`**

Reads no options.

**`logs clear`**

| Option | What it does |
| --- | --- |
| `--restart` | logs clear: stop active stream, clear logs, then start streaming again |

**`logs doctor`**

Reads no options.

**`logs mark`**

Reads no options.

Supported targets: [App logs](/docs/capabilities#evidence-and-diagnostics).

Exact behavior: `agent-device help logs`.

<!-- /generated -->

<!-- generated:command events -->

Read session event timeline.

```bash
agent-device events [limit] [cursor]
```

Exact behavior: `agent-device help events`.

<!-- /generated -->

<!-- generated:command network -->

Inspect HTTP(S) traffic from session logs.

```bash
agent-device network dump [limit] [summary|headers|body|all] [--include summary|headers|body|all] | network log [limit] [summary|headers|body|all] [--include summary|headers|body|all]
```

| Option | What it does |
| --- | --- |
| `--include summary\|headers\|body\|all` | Network: include headers, bodies, or both in output |

Supported targets: [HTTP(S) request inspection](/docs/capabilities#evidence-and-diagnostics).

Exact behavior: `agent-device help network`.

<!-- /generated -->

```bash
agent-device logs path                  # e.g. ~/.agent-device/sessions/default/app.log
agent-device logs start                 # Stream app output to that file (requires open first)
agent-device logs clear                 # Truncate app.log and remove rotated app.log.N files (requires a stopped stream)
agent-device logs mark "before submit"  # Insert a timeline marker into app.log
agent-device events 50 100              # Page 50 events starting at cursor 100
agent-device network dump 25 --include all
```

- `logs` works on iOS simulators and devices, Android, and macOS. On Apple targets, capture relies on Unified Logging (`os_log`), so plain stdout and stderr may be missing.
- On iOS physical devices, `logs start` relaunches the session app and `logs stop` ends it. Run `open <app>` again after `logs stop`.
- `logs start` rotates `app.log` by size. Set `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` to a comma-separated regex list to redact secrets as lines are written. Write `\,` for a literal comma outside `{m,n}`, `[...]`, or `(...)`.
- `open` prints `Session state: <path>`; see [Sessions](/docs/sessions#find-a-sessions-logs-and-artifacts) for the files it holds.
- `events` reads the session timeline, which leaves out typed content. Events are best effort and can be dropped under load. A cursor older than the kept window fails with `EVENT_LOG_CURSOR_EXPIRED` and `details.earliestCursor`.
- `network dump` reads recent HTTP(S) entries from `app.log`, or from the browser's request history on web. Prefer `--include` over the positional detail level. Web does not expose bodies.
- On iOS, `network dump` can miss requests that the app does not log, so a missing endpoint is not proof. See [Network inspection](/docs/debugging-profiling#network-inspection).

**Audio probes:** `audio probe` samples HTML media elements on the web and host system audio on macOS, where it needs Screen Recording permission. See [Debugging and profiling](/docs/debugging-profiling#audio-probes).

<!-- generated:command audio -->

Probe audio levels.

```bash
agent-device audio probe start [durationSeconds] [bucketMs] | audio probe status | audio probe stop
```

Supported targets: [Audio probe](/docs/capabilities#evidence-and-diagnostics).

Exact behavior: `agent-device help audio`.

<!-- /generated -->

```bash
agent-device audio probe start 10 1000
agent-device audio probe status
agent-device audio probe stop
```

**Crash symbols:** `debug symbols` symbolicates an Apple crash artifact against local dSYMs, writes the symbolicated artifact to `--out`, and prints a compact crash report. See [Crash symbolication](/docs/debugging-profiling#crash-symbolication).

<!-- generated:command debug -->

Symbolicate Apple crash artifacts.

```bash
agent-device debug symbols --artifact <crash.ips|crash.log> (--dsym <App.dSYM> | --search-path <dir>) [--out <symbolicated>]
```

| Option | What it does |
| --- | --- |
| `--artifact <path>` | Debug symbols: Apple crash artifact path (.ips, .crash, or .log) |
| `--dsym <path>` | Debug symbols: matching .dSYM bundle path |
| `--search-path <dir>` | Debug symbols: directory to scan for matching .dSYM bundles |

Also accepts: [common options](#common-options): `--out <path>`.

Exact behavior: `agent-device help debug`.

<!-- /generated -->

```bash
agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
```

## Tracing

<!-- generated:command trace -->

Start or stop trace capture.

```bash
agent-device trace start [path] | trace stop [path]
```

Exact behavior: `agent-device help trace`.

<!-- /generated -->

```bash
agent-device trace start
agent-device trace start session.trace
agent-device trace stop
agent-device trace stop session.trace
```

- `trace` captures a trace log for the active session; `trace stop` writes or finalizes the artifact at its path. Use it for lower-level session diagnostics than `record` or `logs` provide.

## Remote proxy

<!-- generated:command proxy -->

Expose a local daemon through an HTTP tunnel.

```bash
agent-device proxy [--host <host>] [--port <port>] [--public-origin <origin>] [--daemon-auth-token <token>] [--state-dir <path>]
```

| Option | What it does |
| --- | --- |
| `--state-dir <path>` | Daemon state directory (defaults to ~/.agent-device for packages, or a worktree-scoped dev dir from source) |
| `--daemon-auth-token <token>` | Remote HTTP daemon or proxy auth token (sent as request token and bearer header) |
| `--host <host>` | Proxy: host interface to bind (default: 127.0.0.1) |
| `--port <port>` | Proxy: TCP port to bind (default: 0, choose a free port) |
| `--public-origin <origin>` | Proxy: public HTTP(S) origin for upload tickets |

Exact behavior: `agent-device help proxy`.

<!-- /generated -->

Run `proxy` on the machine that can reach the simulator, emulator, or device, and drive it from another machine through an HTTP tunnel. It prints a daemon auth token: anyone who has it can control the daemon behind the proxy. Pass `--public-origin` when the tunnel terminates TLS, so app uploads use HTTPS. See [Remote proxy](/docs/remote-proxy) for the tunnel setup and `connect proxy`.

## Remote Metro workflow

When the cloud control plane owns the connection profile, `connect` discovers it. Name the session once, because every command on a cloud connection must name it:

```bash
export AGENT_DEVICE_SESSION=checkout-ios
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

- `connect` saves the connection and waits to lease a device and prepare Metro until a command needs them. `connect --remote-config <path>` uses a local profile instead of the cloud one.
- Cloud auth: `connect` uses your stored CLI session, and starts login in an interactive shell. In CI, use an `adc_live_...` service token. Manage the CLI session with `agent-device auth status`, `auth login`, and `auth logout`. Interactive login prints the code that the browser page must show; approve only when they match. When the cloud rotates the session credential during a refresh, the CLI stores the replacement and any session expiry. One command refreshes a stored session at a time; a command that waits too long fails with a session-file lock timeout, so retry it. A revoked session fails with `cli_session_revoked`, a refresh without a token fails with `cli_session_refresh_unanswered`, and a session directory that cannot be written fails with `cli_session_store_unwritable`. A refresh goes only to the cloud origin stored with the session: an `AGENT_DEVICE_CLOUD_BASE_URL` with another origin fails with `cloud_login_origin_mismatch` until you log in again or unset it. A session saved by an older CLI fails with `cli_session_issuer_unverified`; run `agent-device auth login`. Cloud auth requests follow at most three redirects on the same origin. A 307 or 308 resends the POST; a 301, 302 or 303 continues as a GET without the body. A redirect to another origin, a fourth redirect, or a target with no readable Location or with a username or password fails with `cloud_auth_redirect_refused` before anything is sent to it.
- `AGENT_DEVICE_CLOUD_BASE_URL` is the bridge API origin, which is not always the dashboard.
- On a connection with a lease provider, such as the cloud or `connect proxy`, every command must name the session with `--session`, `AGENT_DEVICE_SESSION`, or config, or it fails with `REMOTE_SESSION_REQUIRED`. On other profiles, commands without a session use the most recent connection, which is safe only for one sequential workflow. To replace a connection, pass `--session <name> --force`.
- After `connect`, normal commands reuse the connection. `connection status` shows `leaseId=pending` until the first command that needs a device.
- End with `disconnect` to release the lease and stop the Metro companion. It does not stop your Metro server. If it cannot release the lease, it prints the lease id so you can release it manually.
- `metroProxyBaseUrl` is the bridge origin; do not add `/api/metro/...` paths. `metroPublicBaseUrl` is only for direct bundle hints without a bridge.

<!-- generated:command connect -->

Configure remote or provider state.

```bash
agent-device connect [provider] [--remote-config <path>] [--daemon-base-url <url>] [--tenant <id>] [--run-id <id>] [--lease-id <id>] [--lease-backend <backend>] [--force] [--no-login]
```

| Option | What it does |
| --- | --- |
| `--remote-config <path>` | Load remote host + Metro workflow settings from a specific profile file |
| `--daemon-base-url <url>` | Explicit remote HTTP daemon base URL (skip local daemon discovery/startup) |
| `--tenant <id>` | Tenant scope identifier for isolated daemon sessions |
| `--run-id <id>` | Run identifier used for tenant lease admission checks |
| `--lease-id <id>` | Lease identifier bound to tenant/run admission scope |
| `--lease-backend ios-simulator\|ios-instance\|android-instance\|harmonyos-instance\|macos-app` | Lease backend for remote tenant connection admission |
| `--provider-app <ref-or-path>` | Cloud provider app reference or local app path used when creating hosted WebDriver sessions |
| `--provider-os-version <version>` | Hosted cloud provider OS version, for example 17 or 14.0 |
| `--provider-device-type real\|virtual` | TestMu AI device pool: real devices or virtual devices (emulators and simulators). Defaults to virtual |
| `--provider-project <name>` | Hosted cloud provider project label |
| `--provider-build <name>` | Hosted cloud provider build label |
| `--provider-session-name <name>` | Hosted cloud provider session label |
| `--provider-device-orientation portrait\|landscape` | Screen orientation a hosted cloud provider session starts in. Set this rather than rotating after launch: a session that boots landscape renders login webviews landscape |
| `--provider-geo-location <country>` | Hosted cloud provider IP geolocation country code, for example US |
| `--provider-timezone <zone>` | Hosted cloud provider device time zone, for example New_York |
| `--provider-appium-version <version>` | Hosted cloud provider Appium server version, for example 3.2.0. Without it each provider starts its own default (Appium 1.x on BrowserStack) |
| `--provider-language <language>` | Hosted cloud provider app language, for example Fr |
| `--provider-locale <locale>` | Hosted cloud provider device locale, for example Fr |
| `--provider-network-profile <profile>` | Hosted cloud provider named network condition profile, for example 4g-lte-advanced-good. Mutually exclusive with --provider-custom-network |
| `--provider-custom-network <shape>` | Hosted cloud provider custom network shape. Mutually exclusive with --provider-network-profile |
| `--provider-no-resign-app` | iOS only: keep an Enterprise-signed app as uploaded instead of letting the provider re-sign it, which strips entitlements such as push notifications |
| `--provider-network-logs` | Limrun: capture session network traffic; artifacts and close write it as a HAR file on the daemon host and print its path and any capture failures. Pass --provider-network-hosts with your app API hosts. Captured traffic exits through the daemon host, the HAR holds raw headers and bodies, certificate-pinned hosts and HTTPS hosts without HTTP/2 fail to connect, and DNS-over-HTTPS bypasses the capture |
| `--provider-network-hosts <list>` | With --provider-network-logs: comma-separated hosts to capture, such as your app API hosts (exact hosts, wildcards like *.example.com, or localhost:&lt;port> routes). Replaces the noisy default of common public domains plus localhost:8081 |
| `--aws-project-arn <arn>` | AWS Device Farm project ARN for hosted WebDriver sessions |
| `--aws-device-arn <arn>` | AWS Device Farm device ARN for hosted WebDriver sessions |
| `--aws-app-arn <arn>` | AWS Device Farm app ARN attached to hosted remote access sessions |
| `--aws-region <region>` | AWS region for Device Farm API calls |
| `--aws-interaction-mode INTERACTIVE\|NO_VIDEO\|VIDEO_ONLY` | AWS Device Farm remote access interaction mode |
| `--force, --overwrite` | Force replacement of existing state (connect: replace an active connection; --save-script: overwrite an existing target instead of refusing) |
| `--no-login` | Connect: fail instead of starting implicit cloud login |
| `--os <version\|range>` | Proxy lease: OS version or range the backend picks the device by (Android: API level); refused without such a backend |
| `--image-tag <tag>` | Proxy lease: Android system image tag the backend picks the device by; refused without such a backend |
| `--device-mode <slim\|full>` | Proxy lease: iOS simulator mode (slim or full) the backend leases; refused without such a backend |
| `--device-baseline <name>` | Proxy lease: saved device state (baseline) the backend restores on the leased device; refused without such a backend |
| `--physical` | Proxy lease: ask the backend for a physical device instead of a simulator or emulator; refused without such a backend |

Exact behavior: `agent-device help connect`.

<!-- /generated -->

<!-- generated:command disconnect -->

Clear remote connection state and release leases.

```bash
agent-device disconnect [--shutdown]
```

| Option | What it does |
| --- | --- |
| `--shutdown` | close, disconnect: also shut down the session device where supported; a Limrun instance agent-device created is deleted with its data, an attached one keeps running. close also releases a lease or attachment kept on close |

Exact behavior: `agent-device help disconnect`.

<!-- /generated -->

If agent-device cannot read or parse a session's own saved connection file or the active-session pointer, it cannot establish which session owns that file. It keeps the file and refuses with `connection_record_owner_unknown`. A session's own saved connection file that cannot be read refuses every command that uses that session's saved connection. An unreadable active-session pointer refuses `connect` and any command that rewrites the saved connection. The error names the file. Make it readable, or remove it if no session needs it. A file from an older build whose owner cannot be proven is left in place and is not used. A command that only reads the saved connection, such as `connection status`, changes no file. It uses an older build's file for the session where that file is, and it treats a file that fails validation as no connection. Only a command that saves or removes the saved connection moves an older file to its session's own file, or removes a file that fails validation. If an older file cannot move because its session's own file already exists, that command refuses with `connection_session_mismatch`. The refused file is kept, and so is the occupied session file. This is also true when both files name the same session, and when the occupied file cannot be read.

<!-- generated:command auth -->

Manage cloud login state.

```bash
agent-device auth status|login|logout
```

Exact behavior: `agent-device help auth`.

<!-- /generated -->

<!-- generated:command connection -->

Inspect the saved remote connection.

```bash
agent-device connection status
```

Exact behavior: `agent-device help connection`.

<!-- /generated -->

## Session inspection

<!-- generated:command session -->

List sessions, show the state dir, or publish a script.

```bash
agent-device session list | session state-dir | session save-script [path] [--force]
```

**`session list`**

Reads no options.

**`session state-dir`**

Reads no options.

**`session save-script`**

| Option | What it does |
| --- | --- |
| `--force, --overwrite` | Force replacement of existing state (connect: replace an active connection; --save-script: overwrite an existing target instead of refusing) |

Exact behavior: `agent-device help session`.

<!-- /generated -->

```bash
agent-device session list
agent-device session list --json
```

- `session list` shows active daemon sessions for your workspace. Add `--json` for session metadata.
- `session list --json` reports `kind`, `model`, and `osVersion` flat on each entry when the host reported them: read `sessions[0].osVersion`, not `sessions[0].device.osVersion`, which is the device name.

## Cloud provider artifacts

<!-- generated:command artifacts -->

List daemon or cloud provider session artifacts.

```bash
agent-device artifacts [provider-session-id] [--provider <name>]
```

| Option | What it does |
| --- | --- |
| `--provider <name>` | Cloud provider name for provider-scoped commands |
| `--provider-session <id>` | Cloud provider session id or ARN |

Exact behavior: `agent-device help artifacts`.

<!-- /generated -->

```bash
agent-device artifacts --provider browserstack --provider-session <webdriver-session-id> --json
agent-device artifacts --provider aws-device-farm --provider-session <remote-access-session-arn> --json
```

- `artifacts` lists the provider-hosted videos, logs, and dashboard links as `cloudArtifacts`. See [Device clouds](/docs/device-clouds#compare-providers) for what each provider returns.
- To look up a past session, pass `--provider <name>` and `--provider-session <id>`.
- Providers can finish their URLs only after the session stops, so retry `artifacts` if the first response is `pending`.

## MCP server

<!-- generated:command mcp -->

Start MCP server.

```bash
agent-device mcp [--structured]
```

| Option | What it does |
| --- | --- |
| `--structured` | MCP: advertise tool output schemas and return structuredContent; results are text only by default |

Exact behavior: `agent-device help mcp`.

<!-- /generated -->

Run `agent-device mcp` from an MCP client that supports direct tools. Configure the server with `AGENT_DEVICE_*` environment variables in the client's server entry; tool calls cannot pass them. For client setup and what MCP does not expose, see [AI agent setup](/docs/agent-setup#mcp-server).

## Provider plugins

<!-- generated:command plugins -->

Manage installed provider plugins.

```bash
agent-device plugins list [--state-dir <path>]|add <package[@version]>|update <package>|remove <package>
```

**`plugins list`**

| Option | What it does |
| --- | --- |
| `--state-dir <path>` | Daemon state directory (defaults to ~/.agent-device for packages, or a worktree-scoped dev dir from source) |

**`plugins add`**

Reads no options.

**`plugins update`**

Reads no options.

**`plugins remove`**

Reads no options.

Exact behavior: `agent-device help plugins`.

<!-- /generated -->

```bash
agent-device plugins add @agent-device/testmu
agent-device plugins list --json
```

Provider plugins add device providers that agent-device does not bundle. Installing one requires npm on your host. `plugins list --json` works without a daemon; `daemon status` shows which providers a running daemon registered. See [Provider plugins](/docs/plugins).

## iOS physical-device prerequisites

For CLI-discoverable setup guidance, run `agent-device help physical-device`.

- Older devices found only through `xctrace` use the XCTest backend. Keep them connected by cable.
- XCTest-backed devices support open, close, interactions, snapshots, and screenshots. App inventory, install, logs, performance sampling, recording, deep links, and launch arguments need CoreDevice.
- For Xcode, pairing, Developer Mode, and Apple runner signing, see [Installation](/docs/installation#ios-physical-device-prerequisites).

## iOS SpringBoard, widgets, and system-UI surfaces

For CLI-discoverable workflow guidance, run `agent-device help ios-system-ui`.

- `agent-device open com.apple.springboard --platform ios` binds the session to SpringBoard on iOS simulators and physical iPhones. The widget add, edit, and remove flow is verified on simulators only.
- Two steps of the widget flow need coordinates: the long-press on empty space that starts edit mode, and the unlabeled widget-gallery search results.
- SpringBoard labels vary by iOS version and language, so read them from the current snapshot instead of hard-coding `Edit` or `Add Widget`.
- Open the app under test again to return to normal app automation.
