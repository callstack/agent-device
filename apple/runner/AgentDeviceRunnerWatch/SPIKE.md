# Spike #4735: watchOS simulators with the XCUITest runner

Do not merge this branch. It records evidence for the go or no-go decision.

## Environment

- Xcode 27.1 (27A9275), watchOS 27.0 simulator runtime (24R362), downloaded with `xcodebuild -downloadPlatform watchOS` (3.83 GB).
- Simulators: Apple Watch Series 11 (46mm) (default set), Apple Watch SE 3 (40mm) (default set), Apple Watch Series 11 (42mm) (private set `/private/tmp/ad-watch-spike-set`).
- Host: Apple silicon Mac, macOS 27.0.

## What the branch changes

- `AgentDeviceRunnerWatch/project.yml`: an isolated XcodeGen project. A SwiftUI watch host app plus a `bundle.ui-testing` target that compiles the existing `AgentDeviceRunnerUITests/` sources (without `UnitTests/`). `AgentDeviceRunner.xcodeproj` is unchanged.
- Runner Swift, all behind `os(watchOS)`:
  - `RunnerTests+Orientation.swift`: watchOS joins the no-orientation set.
  - `RunnerTests+ScreenRecorder.swift`: watchOS has no `AVAssetWriter`; a stub refuses `recordStart`.
  - `RunnerTests.swift`: watchOS has no SpringBoard (its shell is Carousel), so the blocking-modal probe is off. Without this, the first snapshot fails the XCTest case with "Application com.apple.springboard is not running" and the runner exits.
  - `RunnerTests+TextTyping.swift`: type through the app (`app.typeText`), because watchOS edits text in a system input sheet and the tapped field never takes keyboard focus.
  - `RunnerTests+CommandExecution.swift`: a probe on `remotePress` for Digital Crown rotation, crown press, and hand gestures. This is not a wire contract.
- Host TypeScript: discovery classifies watch runtimes as `appleOs: 'watchos'`, a `watchOS` runner profile (`watchsimulator` SDK), and the sentinel is removed only on the demo path (interactor, open/close, prepare, snapshot, app state, screenshot, readiness, boot, shutdown, deployment). Other watchOS refusals stay.

## Build (question 1)

```sh
cd apple/runner/AgentDeviceRunnerWatch && xcodegen generate
xcodebuild build-for-testing -project AgentDeviceRunnerWatch.xcodeproj -scheme AgentDeviceRunnerWatch \
  -destination 'generic/platform=watchOS Simulator' -derivedDataPath <derived> CODE_SIGNING_ALLOWED=NO
```

The first build had 47 errors in two files only: `XCUIDevice.orientation` and `AVAssetWriter` are unavailable. All Objective-C bridge files (AX snapshot bridge, synthesized gesture and text entry, edge touch, XCTest event bridge) compiled unchanged. After the guards the build exits 0.

```sh
TEST_RUNNER_AGENT_DEVICE_RUNNER_PORT=47911 TEST_RUNNER_AGENT_DEVICE_RUNNER_TOKEN=<32+ bytes> \
xcodebuild test-without-building -xctestrun <derived>/Build/Products/AgentDeviceRunnerWatch_watchsimulator27.0-arm64-x86_64.xctestrun \
  -destination 'platform=watchOS Simulator,id=<udid>' -only-testing:AgentDeviceRunnerUITests/RunnerTests/testCommand
```

```
AGENT_DEVICE_RUNNER_AUTH=required
AGENT_DEVICE_RUNNER_DESIRED_PORT=47911
AGENT_DEVICE_RUNNER_LISTENER_READY
AGENT_DEVICE_RUNNER_PORT=47911
```

## Transport and other apps (questions 2 and 3)

`POST http://127.0.0.1:47911/command` with the token header works from the host, as on iOS simulators.
`{"command":"uptime"}` answers `ok: true`.
`{"command":"snapshot","appBundleId":"com.apple.NanoSettings"}` launches Settings through `XCUIApplication(bundleIdentifier:)` ("Open com.apple.NanoSettings ... Wait for com.apple.NanoSettings to idle") and returns 19 nodes in 45 ms with frames, hittability, and a 208x248 viewport.

## Runner command matrix (question 4), raw protocol, Series 11 (46mm)

| Command | Result |
| --- | --- |
| `snapshot` | Works. Tree, frames, hittability, identifiers (`NOTIFICATIONS_ID`), clipped-geometry notes. |
| `tap` coordinate / selector | Works. A counter fixture incremented twice. A cell tap navigated. |
| `longPress` | Works. |
| `drag` | Works. The Settings list scrolled. |
| `scroll` | Needs work: `synthesizedCoordinateContext` is iOS-only, so it returns "could not resolve a usable interaction frame". Route to drag or Digital Crown. |
| `swipe` (direction) | Refused today ("only supported on tvOS"); the host maps swipes to drag on touch targets. |
| `type` | Needs work. The default element route fails ("Neither element nor any descendant has keyboard focus") and the XCTest failure ends the runner. App-wide `typeText` after a field tap typed `hello` into the input sheet, and a tap on Done committed it to the field. |
| `keyboardStatus` | Needs work: reports `visible: false` while the watch keyboard is in the tree. |
| `backInApp` | Needs work: falls into the visionOS refusal text. A tap on the `Back` button (15,18 35x35) works. |
| `home` | Works (crown press). |
| `rotate` | Must stay refused: no orientation on watchOS. |
| `actionButton` | Typed refusal on a model without the button (Series 11). Expect it to work on Ultra; not verified. |
| `screenshot` | Works. |
| `appState`, `terminate`, `querySelector`, `findText` | Work. |
| `recordStart` | Must stay refused in the runner (no `AVAssetWriter`). Use `simctl io recordVideo` on the host. |
| Digital Crown rotate (`rotateDigitalCrown(delta:)`) | Works: +0.5 scrolled Settings from Notifications to Wi-Fi, -0.5 scrolled back. No command exists yet. |
| Hand gestures (`perform(handGesture: .doubleTap / .flick)`) | Dispatch without error. Effect not verified in Settings. `.flick` needs watchOS 26+. No command exists yet. |
| `gesture` multi-touch (pinch, rotate) | Must stay refused. |

## CLI demo (completion condition), branch-built CLI

```sh
agent-device devices --platform apple
# agent-device spike watch (ios simulator target=mobile model="Apple Watch Series 11 (46mm)" os=27.0) booted=true
# --json: "appleOs": "watchos"
agent-device open com.apple.NanoSettings --platform ios --udid <udid> --session watch-spike --ios-xctestrun-file <watch xctestrun>
# Opened: com.apple.NanoSettings
agent-device snapshot -i --session watch-spike         # 13 nodes, 0.35 s warm
agent-device press 'label="Smart Stack"' --session watch-spike --settle
# Tapped label="Smart Stack" (104, 150); settled after 2208ms: +9 -12
agent-device screenshot watch-demo.png --session watch-spike   # 208x248, shows the Smart Stack screen
```

## simctl paths (question 5)

- Discovery lists every watch simulator in the default set and in a private set with `--ios-simulator-device-set`.
- `boot` on an unbooted SE 3 (40mm): "Boot ready" in 32 s.
- `install com.callstack.agentdevice.runner <watch .app>`: "Installed" in 4 s.
- `open`, `screenshot` (simctl path, no runner): work.
- `close --shutdown`: works.
- Gap: `boot` and `open` without `--ios-xctestrun-file` start a managed runner build from `AgentDeviceRunner.xcodeproj`, which xcodebuild rejects: "watchOS Simulator platform doesn't match AgentDeviceRunner.app's supported platforms". The failure is non-fatal for boot and screenshot.

## Simlock and proxy (question 6)

agent-device has no Simlock code (ADR 0021). A leased simulator reaches agent-device only through `--ios-simulator-device-set`.
That path works for a watch: in a private set, discovery, boot, `xcodebuild test-without-building -DVTSimulatorSetLocation`, open, snapshot, and screenshot all work (cold snapshot 7.3 s).
`agent-device proxy` forwards daemon requests and has no Apple OS branch. It needs no change. It was not exercised in this spike.
Whether Simlock itself provisions watch device types is a Simlock question.

## Gesture research (swipes, pan, system surfaces)

Apple's guidance:
- [Use buttons and gestures](https://support.apple.com/en-gb/guide/watch/apd1d9d7efca/watchos): tap, touch and hold, swipe (one finger up, down, left, right), drag. Crown: press (watch face or Home Screen), double-click (App Switcher), press and hold (Siri), turn (scroll, zoom, adjust; on the face it opens the Smart Stack). Side button: press (Control Center), double-click (Apple Pay), hold (SOS and power). Action button on Ultra. Hand gestures: double tap, wrist flick. Cover to mute.
- [Zoom](https://support.apple.com/en-mt/guide/watch/apd95f904443/watchos): the two-finger pan and two-finger double tap belong to the Zoom accessibility feature only.
- [Notifications](https://support.apple.com/en-am/guide/watch/apde978ebff5/watchos): swipe down from the face opens Notification Center.
- watchOS 27 SDK: SwiftUI `DragGesture`, `TapGesture`, `SpatialTapGesture`, `LongPressGesture`, and `SpatialEventGesture` (watchOS 11+) exist. `MagnifyGesture`, `MagnificationGesture`, `RotateGesture`, and `RotationGesture` are `@available(watchOS, unavailable)`. Apps cannot use pinch or rotate.

Fixture: the host app has a navigation push (edge-swipe back), list rows with leading and trailing swipe actions, horizontal and vertical page `TabView`s, and a drag pad that prints its translation.
Dispatch routes compared: the runner's `drag` (public `XCUICoordinate` press-then-drag), the private synthesizer (`RunnerSynthesizedGesture.synthesizeGesture`, which needs the resolved app window), and `XCUIElement.swipeUp/Down/Left/Right`.

| Gesture | drag | synthesizer | XCUIElement swipe | Crown |
| --- | --- | --- | --- | --- |
| Back: swipe right from the left edge (x≈1) | Works | Works | No (starts at center) | n/a |
| Swipe right from mid-screen | No back (correct) | No back (correct) | No | n/a |
| Row trailing action (swipe left) | Shows Delete; tap deletes | n/a | n/a | n/a |
| Row leading action (swipe right) | n/a | Shows Pin | n/a | n/a |
| Horizontal pages | Works | Works | Works | Does not page |
| Left-edge swipe on horizontal pages | Goes back, not to the previous page | | | |
| Vertical pages | Works (up) | Works (down) | Up works; down did not | Pages coarsely: 0.5 turn did nothing, 1.0 moved one or two pages |
| Pan in a custom view (`DragGesture`) | Exact translation (120,10) | Exact translation (-100,5) | n/a | n/a |
| Two-finger pan (synthesizer, two pointers) | n/a | Not registered | n/a | n/a |
| Notification Center: swipe down from top edge on the face | Works ("No Notifications" in the tree) | | | |
| Smart Stack: swipe up from bottom edge on the face | Works; the tree is empty (gap) | | | 1.0 turn works; 0.3 does not |
| Swipe left or right on the face | No face change (off by default) | | | |
| Touch and hold on the face | Face editing ("Customizable", Edit) | | | |
| App Switcher: crown double-click | Two `press(.home)` calls are too slow; they open the Home Screen. No double-press API. | | | |
| Control Center: side button | No `XCUIDeviceButton` for the side button | | | |
| Hand double tap → `handGestureShortcut(.primaryAction)` | Dispatched, no effect in the simulator | | | |

Other findings:
- `home` (crown press) toggles: from an app or overlay it goes to the face, and from the face it opens the Home Screen grid. The grid is readable in the `com.apple.Carousel` tree with app labels and frames.
- `XCUIElement` swipes and the velocity form of press-then-drag wait for the app to idle first and stalled the main thread for 30 s+. Inside `withBoundedInteractionIdleTimeoutIfSupported` they work. The runner's `drag` already does this.
- The first tap after a crown scroll was swallowed once. Settle after crown rotation.
