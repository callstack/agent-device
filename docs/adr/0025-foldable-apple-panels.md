# ADR 0025: Foldable Apple Panels — Capture the Lit Panel

## Status

Accepted (2026-09-20).
The pose-settle amendment is dated 2026-09-21 under #2730.
The touch-overlay export diagnosis was corrected on 2026-09-22 under #2707.
The Android emulator pose amendment is dated 2026-10-10.
This ADR covers iPhone Duo (iOS 27.1, `iPhone19,4`) and Apple devices with more than one integrated CoreDevice display.
The amendment below also covers foldable Android emulators.

An iPhone Duo has Apple's **outer display** and **inner display**.
It lights one panel at a time according to device pose.
This ADR separates two facts: **which panel a capture must name** and **what pose the device is in**.
An official host API answers the first question.
Only inference answers the second question.

## Rules at a glance

| Situation | Behavior |
| --- | --- |
| Any iOS simulator capture | First resolve the CoreDevice display table. Capture the panel that the system currently lights. |
| More than one integrated panel | Pass `--display=<panel name>` on every `simctl io screenshot`. Never use the implicit default. |
| Zero or multiple lit panels | Name the `primary` panel. Emit `apple_display_capture_ambiguous`. Report pose as `unknown`. |
| One integrated panel | Preserve pre-panel behavior exactly: no display flag, no pose, unchanged scale probe. |
| Density normalization | Use the captured panel's `pointScale`. For runner fallback, use that capture's reported pixels-per-point. |
| Pose report | From panel power alone, report only `closed`, `fully-open`, or `unknown`, never a narrower pose. `fold` reports the exact pose because it reads the hinge angle. |
| Pose request | `agent-device fold <closed\|half-open\|open>` sends private HID inside the simulator. Then it reads the hinge angle back from CoreDevice until the angle agrees. For `half-open`, two consecutive readings must agree. If the readings never agree, refuse the pose. |
| The hinge reaches `half-open` but keeps moving | Refuse with `fold-pose-unsettled` and the observed and previous angles. An angle inside the open interval is an observed category, not a pose that the hinge holds. |
| External display | It is not a panel. It creates neither multi-screen classification nor a pose. |
| CoreDevice cannot answer | Return unresolved inventory. Preserve single-panel capture. An absent host feature is not a capture failure. |

## Contracts

`packages/platform-apple/src/core/display-inventory.ts` owns the panel model.
It is the only reader of CoreDevice display information.

- **Authority.**
  `xcrun devicectl device info displays --json-output` (`jsonVersion` 5) is the only screen authority.
  It reports these per-panel values:
  - `name`, also accepted by `simctl io --display`.
  - `displayId`.
  - `nativeSize`.
  - `pointScale`.
  - `currentOrientation`.
  - `type`.
  - `primary`.
  - `active`.
  - `backlightState`.
  It works for simulators with `reality: simulated` and physical devices.
- **Panel power.**
  `backlightState` is authoritative. `active` is only a fallback because real payloads can omit it.
  A single-panel iPhone 17 reports `backlightState: activeOn` without an `active` key.
  An `active`-only parser would classify this panel as dark.
  The `BacklightState` union contains `activeOn`, `inactiveOn`, `activeDimmed`, `off`, and `unknown`.
  The first three mean lit.
  An unrecognized future value means `unknown`, not dark.
  An assumed dark state could select a panel without content.
- **Panel identity.**
  More than one `type: integrated` panel makes a device multi-screen.
  CoreDevice marks one panel `primary`.
  It is the outer display because it remains lit when the device closes.
  The complete model uses `primary` and the lit count.
  The inventory assigns no `outer`/`inner` labels because no caller consumes them.
  Every decision uses `primary` and panel power.
  Array order or geometry would create another authority that could silently invert identity.
  If the primary panel is also largest, `primary` still decides.
  In that case, emit `apple_display_primary_geometry_conflict`. Do not silently replace identity with a geometry rule.
- **Capture target.**
  `resolveAppleCaptureDisplay` returns a panel for every multi-panel device.
  It returns `undefined` only for a single-panel device or unresolved inventory.
  If exactly one panel is lit, name that panel.
  Otherwise, name `primary`, set `ambiguous`, and emit `apple_display_capture_ambiguous`.
  A multi-panel device never receives a capture without a display name.
  The implicit default caused the black-image, exit-0 failure.
  An explicitly named, possibly dark panel makes failure visible and diagnosable.
- **No pose field.**
  Panel power cannot distinguish Apple's `UIHinge.Status.fullyOpen` from `.partiallyOpen`.
  Both light the inner panel and darken the outer panel.
  A derived pose could therefore mean only "not closed", although it would appear factual.
  The inventory reports measured `primary`, panel power, geometry, and orientation.
  It leaves exact pose to the app under test through `UIHinge.status`.
  If a caller needs pose, it asks the operator and takes another snapshot.
- **No cache.**
  The probe executes per capture.
  An operator changes the lit panel through a fold or open action.
  Cached inventory could resume capture of the dark panel and recreate the failure.
  `IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS` limits the probe to 5s, below the subsequent 20s screenshot deadline.
  Thus, an unresponsive CoreDevice cannot consume the capture's own budget.
  Measured cost is 0.16–0.26s, compared with 4.93s for the screenshot.

## Why the default capture had to stop being implicit

Without `--display`, `simctl io screenshot` selects the **highest** screen ID, not the primary panel.
On a closed Duo, this is the dark inner panel.
It exits 0 with a valid black PNG. Every downstream consumer trusts that capture of nothing.

| Capture path | Before | After |
| --- | --- | --- |
| `screenshot` on a closed Duo | 669x951 @1x, mean luma 0.09 (black) | 466x678 @1x, mean luma 65.8 (the lit outer panel) |
| `screenshot` on an open Duo | 951x669 @1x, mean luma 241 (the highest screen ID happens to identify the lit inner panel) | 951x669 @1x naming `LCD-1` explicitly |
| `screenshot` on iPhone 17 | 402x874 @1x, mean luma 104.9 | unchanged |

This explains reports that the tool "picks the wrong screen" on iPhone Duo.
It was never a selection problem.
Only the lit panel is capturable.
Thus, the name of the lit panel is the whole fix, and a screen-selection flag is not warranted.

`SIMULATOR_MAINSCREEN_SCALE` also refers to one fixed panel.
A capture can use the other panel.
Density normalization therefore uses the captured panel's `pointScale`.

### Runner capture follows the app's window (#2728)

A named lit panel helps only captures that ask CoreDevice.
The runner previously captured the fixed `XCUIScreen.main` panel.
This affected fallback after `simctl` failure and every runner visual verification.
The selected panel depended on the build instead of the app.
The runner now resolves the app window first and reads the display from that same window instance.
It encodes the capture upright because a turned panel supplies a sideways buffer.

The capture reports its display ID, encoded pixel size, and image pixels-per-point.
Normalization uses this source metadata instead of a host-inferred scale.
If the runner reports nothing, it measured nothing.
In that case, normalization keeps its pre-panel result instead of borrowing a scale from a panel that nobody captured.
This payload is a cross-language contract, not a consumer-specific cast.
`packages/contracts/src/screen-capture-contract.ts` owns the read.
The Swift struct owns the write.
These are the only two declarations of its shape.
`contracts/fixtures/screen-capture-metadata.json` supplies the wire key and two measured poses.
The vitest twin and runner unit-test lane decode this golden table.
Contract drift therefore fails CI on both sides.

Capture first asks for the target app's window, then the system surface's window.
SpringBoard owns the home-screen window.
Thus, a session without an app, or with a stopped app, can still resolve a window's display.
The result always names a display occupied by a window.
It never defaults to `XCUIScreen.main`, which is dark on a Duo when the app uses the inner panel.
A capture fails closed with a typed reason only when neither window resolves.
The query uses both `exists` and frame evidence to refuse an app without a window.
Such an app returns `(0,0 0x0)` from `frame` without an exception.
Geometry alone cannot prove that no window exists.

A visual check of the app's own transition requires different evidence.
The `back` fallback compares before/after captures to determine whether this app changed after receiving a leading tap.
Two SpringBoard home-screen captures are byte-identical regardless of the app's behavior.
System-surface fallback would therefore report false "unchanged" evidence for the failure under test.
The check observes only the app's own resolved window.
If none resolves, typed refusal produces an unknown outcome instead of false no-change evidence from another process (#2728).

Required and optional helper consumers differ in their frame requirements.
`screenshot` and the `record start` bootstrap frame require a capture.
The recording writer takes its dimensions from that first image.
Each uses the shared `APP_SCREEN_*` reason for capture failure.
A runtime without a window therefore returns typed failure, never generic failure.
Keyboard stability and recording pumps tolerate nil frames.
An absent frame between polls is normal and supplies no display-identity evidence (#2728).

Measurements confirm both branches.
A session without an app and a bound session with a terminated app return `resolved=no` from the window query.
The subsequent capture names the lit panel.
On an unfolded Duo, it names `LCD-1`; the home-screen image contains no black pixel.
An app suspended through `home` retains a usable window.
It takes the first branch and captures its panel.

`screenshot` is a runner-lifecycle command and skips app-activation preflight.
On a fresh runner, this previously selected the runner host process, which has no window.
It now resolves the requested bundle ID for observation.
It never activates an app to determine its foreground display.
A live Duo runner route measured these results with unchanged command flags:

| Pose | Lit panel | Capture | Mean luma |
| --- | --- | --- | --- |
| Open (hinge 180°) | `LCD-1` (ID 3) | 951x669 @1x | 214 |
| Half-open (hinge 130°) | `LCD-1` (ID 3) | 951x669 @1x | 214 |
| Closed (hinge 0°) | `LCD` (ID 1) | 466x678 @1x | 177 |

The same command follows the app to the other panel in the closed pose without an explicit panel request.
Each row captures content; main-screen capture of the unlit panel returns black.

## Amendment: headless simulator HID replaces Device Hub (2026-09-22)

The guest HID experiment supersedes the Device Hub pose decision and its private-API rejection.
Git history retains that rejection, the obsolete UI discovery/sidebar process, and its evidence gaps.
`fold` runs a small Objective-C helper through `simctl spawn <udid>`.
It requires neither Device Hub nor host Accessibility.
After a cold boot, `open` shows the standalone Simulator app.
`open` has no Device Hub option.

The helper uses IOCFSerialize for `{provider: "com.apple.Virtualization.VirtualMachines", source:
"hinge-slider-control", type: "range", value: angle}`.
Inside the simulator, it dispatches a vendor HID event with usage page 0xff61, usage 0x5b, and version 0.
Requested angles are 0°, 130°, and 180°.
Half-open preserves the observed Book angle without a promise of UI animation or orientation parity.
CoreDevice readback and the half-open stability rule remain authoritative.

This decision explicitly accepts private HID for simulator folds.
The selected Xcode compiles packaged source into a unique temporary directory per request.
Cleanup occurs after success and failure.
Build and dispatch are bounded and cancellable, without UI fallback.
Local headless tests verified all three poses, panel changes, and an inner-panel screenshot.
Physical devices, logged-out hosts, and hosted CI remain unverified.
Duo coverage remains local.
An absent public setter did not prove that Device Hub was necessary.

### Timed hinge trajectories

`fold` accepts a preset or 2–64 `{atMs, angle}` keyframes.
Times start at zero and increase strictly to at most 60 seconds.
Angles remain in 0–180°.
One simulator process interpolates linearly against a monotonic clock at approximately 60Hz.
It skips missed frames instead of extending the timeline.
Equal angles express holds.
Preparation and final verification occur outside motion time.
Cancellation sends SIGTERM to simctl, followed by bounded SIGKILL escalation, so simctl can terminate the guest helper.
Abrupt simctl termination can orphan the animation.
Live cancellation at two seconds removed the guest process.
The hinge angle stayed at 67.9° beyond the five-second deadline.
Cancellation performs no automatic reset.
Final custom angles require readback within 0.5° and the existing interior stability check.
Category agreement alone is insufficient.
Shared golden fixtures define native and TypeScript validation.
Existing fold request policy expires refs on successful or interrupted mutation.
Hosted Duo tests remain local-only.

## Pose control: Device Hub's control, CoreDevice's verdict

`agent-device fold` sets the pose.
The split above still holds: the press is not evidence, and the read-back is evidence.
The headless HID amendment above replaces the Device Hub press.
Git history retains the superseded Device Hub process.

`xcrun devicectl device motion hinge-angle --device <udid>` streams the Duo simulator hinge angle over `Range:0-180°`.
Measured presets are Closed 0°, Book 130°, and Open 180°.
`--session-timeout` does not stop the stream.
Each read therefore uses devicectl's own `--timeout`, whose minimum accepted value is 5 seconds.
The sample printed before timeout is the reading.
This read path was checked on the shipping 27.1 toolchain.

`closed` and `open` are hinge end stops.
One read at the stop proves the pose.
Every other angle is `half-open`, including transient angles during movement.
An interior angle proves only a category.
A held pose requires two consecutive readings that both classify as `half-open` and differ by at most 0.5°.
Each read uses the final sample from the five-second stream, so it reports the hinge's current position.
Before the amendment, one run read 175.1° one stream after Book and 130° two streams later.
"Verified on a booted Duo" records the amended-rule run.

If the budget ends at another pose, refuse with `fold-pose-unverified` and CoreDevice's observed angle.
If it ends at unsettled `half-open`, refuse with `fold-pose-unsettled`.
A verified response includes the angle and lit panel's point size.
That point size tells an agent its refs are stale.

A single-panel simulator is refused before mutation with `single-panel-device`.
The leaf fact refuses physical devices and every non-iPhone simulator OS.

## Amendment: an observed half-open angle is not a settled pose (issue #2730)

The former rule also reported `half-open` when the four-read budget ended while the hinge still read `half-open`.
The reason was that a refusal was not allowed to name the requested pose.
This confuses an observed category with a completed pose change.
A hinge crosses the half-open interval on every movement between end stops.
Four readings inside the interval without agreement describe motion, not a held Book preset.
The interval also cannot specify one angle.
The Device Hub Book preset measured 130° on this iOS 27.1 Duo.
That measurement is device-specific; stability is the success condition.

`fold half-open` succeeds only when two consecutive readings classify as `half-open` and differ by at most 0.5°.
Numerical proximity across a category boundary is insufficient.
179° is `open`, while 178.8° is `half-open`.
Their 0.2° difference does not prove one held pose.
If the budget ends at unsettled `half-open`, fail with `COMMAND_FAILED` and these details:

- `details.reason: "fold-pose-unsettled"`
- `requestedPose`
- `observedPose`
- `hingeAngleDegrees`
- The previous reading.

The message says the hinge was observed half-open but did not settle.
It never claims failure to reach half-open, which the observation disproves.
`fold-pose-unverified` remains the reason when the budget ends at another pose.
It classifies only the final sample.
A hinge that passes through `half-open` and ends at an end stop is refused as unverified, because its final pose is not the requested pose.
Attempt count, per-read timeout, cancellation, and open/closed end-stop rules remain unchanged.
An unsettled fold still consumes four hinge streams.

If the first hinge read returns no sample, the pose remains unconfirmed regardless of cause.
For example, devicectl 651.13.5 in Xcode 27.1 RC build 27A9275 lacks `device motion`.
An unreachable device also prints no sample.
HID has already dispatched, so refusal uses `fold-pose-dispatched-unverified`.
This distinguishes unconfirmed dispatch from an observed contradictory pose.
`hingeReadFailure` retains the read failure.
Its stderr supplies the cause instead of an assumption.
If panel power identifies exactly one lit panel, the error includes `screen` evidence.
Panel power cannot distinguish `half-open` from `open`, so the `screen` evidence is never promoted to a verified pose.
A later no-sample read after an earlier sample retains its own reason.

## Pose is derived from panel power, and official control does not exist

Apple's **app-side, read-only** API exposes `UIHinge.status` as `.closed`/`.partiallyOpen`/`.fullyOpen` through `UIHingeInteraction`.
SwiftUI exposes `DeviceHinge` / `.onHingeChange`.
Both require `ios(27.1)`.
There is no `UITraitCollection` hinge trait.

No **official** host control channel exists.
The shipping-toolchain investigation recorded these candidate results:

| Candidate | Result |
| --- | --- |
| `simctl` subcommands | No `hinge`/`fold`/`pose` surface; No such token in the `simctl` binary or in `CoreSimulator.framework` |
| `simctl io` | `screenshot`/`recordVideo` take `--display`; `screenConfig` sets `power` and `geometry` per screen — Neither changes hinge state. |
| XCUITest | No hinge token in any `XCUIAutomation` header; `XCUIDeviceButton` is Home/VolumeUp/VolumeDown/Action/Camera only |
| CoreDevice | `com.apple.coredevice.action.streamhingeangle`, `HingeAngleManager`, `DeviceHingeAngleSnapshot` and `HingeAngleStreamConfig` exist in `/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework` (and `dtdeviceinfod`), They **stream** an angle. The Duo reports no such feature. `devicectl` exposes no CLI for it. |
| `devicectl` | `device info displays` reports panel state only |
| `Xcode.app` frameworks | No hinge reference in `Xcode.app/Contents/{SharedFrameworks,Frameworks}`, Device Hub control is therefore not a hinge API shipped inside Xcode. |

Two searches came back empty, not negative. This ADR records them as limits, not as refuted claims:

- The investigation did not enumerate the simulator guest runtime for a host-reachable control channel.
  Symbol searches found private SpringBoard `SBDisplayToolService`, `com.apple.springboard.sbdisplay.service`, and these methods:
  - `setPrimary:displayUUID:`
  - `setBacklightState:displayUUID:`
  - `replayHingeSamplesWithOptions:path:`
  They also found `SBContinuousFoldController` and a `com.apple.springboard.fold` notification.
  No client, launch path, or invocation from this host was found.
  This is an **unproven private lead**, not an adopted mechanism or proof of possible pose control.
- Device Hub's control could reside in a private framework outside `Xcode.app`.
  That would still not provide a usable API.

Panel-power-derived pose still covers Apple's `fullyOpen` **and** `partiallyOpen`.
Only hinge-angle readback or in-app `UIHinge.status` distinguishes them.

## Refuted alternatives

- **Pose commands backed by `simctl io screenConfig power`: rejected.**
  It does not change `UIHinge.status`.
  The app would not behave as folded, and tests could pass for a state absent from the device.
- **Pose commands backed by coordinate clicks on Device Hub: rejected.**
  Coordinates cannot identify the target window/device and require Screen Recording for alignment.
  The superseded accessibility approach named the control, window, and device row and required only Accessibility permission.
  That approach still required hinge readback instead of trusting the press.
- **A `fold` that reports the requested pose: rejected.**
  A press on the wrong Device Hub window can silently succeed.
  Only CoreDevice hinge-angle readback proves movement of the selected device.
- **Luma or content heuristics for panel selection: rejected.**
  Black screenshots can represent valid content.
  Repository policy prohibits pixel-based decisions when typed facts exist.
  CoreDevice directly reports `active`/`backlightState`.
- **A `--screen outer|inner` flag: rejected as unnecessary.**
  The inactive panel renders black, so its capture contains no content.
  Revisit only when a device shows content on two panels simultaneously.
- **The device type's `capabilities.plist` as panel inventory: rejected.**
  It lacks the live panel state that `devicectl` reports.
  `devicectl` also works identically on physical devices.

## Consequences for agents

Pose changes move the app to a panel with a different point size.
Refs and coordinates do not survive the change.
`agent-device help foldable` and `fold`'s message state this requirement.
Agents fold to each requested pose and take another snapshot instead of assuming pose.

`simctl io recordVideo` shares screenshot's implicit display default.
Recording therefore names the lit panel through the same resolver.
On an open Duo, the 27.1 toolchain accepts and honors the panel name.
The measurements sample mean luma across the complete frame:

| `recordVideo` argv | exported size | mean luma |
| --- | --- | --- |
| `--display=LCD-1` (lit inner) | 2006x2852 | 241.42 |
| `--display=LCD` (dark outer) | 1398x2034 | 0.00 |
| no `--display` | 2006x2852 | 241.42 |

`record start`/`record stop` exit 0 in both poses.
With `--hide-touches`, export preserves captured geometry: `2006x2852`, mean luma 241.42.
Before #2707's fix, touch-overlay export without that flag lost track geometry and, on long clips, frames.

### The touch-overlay export lost geometry for any capture, not a rotated one (#2707)

Touch-event overlays caused the failure, not panel rotation.
#2707 measured an iPhone 17 simulator with iOS 27.0, a non-rot90 panel, and Xcode 27.1 beta:

- Four seconds without interaction exported intact `1206x2622`.
- Ten seconds with two taps exported `220x480`.
- The same taps with `--hide-touches` exported `1206x2622` with changing screen content.
- A 97-second touched recording exported `480x220` with mean luma 0.00 throughout.

The earlier attribution to the inner panel's `rot90` track was incorrect.
All then-known failing samples used that panel.
The apparently intact non-rotated sample had no touches.
`recording-overlay.swift` copies untouched raw `simctl` capture through without changes.
Thus, `--hide-touches` and an empty gesture list preserved capture.
The failure belonged to overlay export, not the panel.

Synthetic capture measurements on this host identified the export preset as the cause.
Overlay burn-in fully re-encodes through `AVAssetExportSession`.
The default `medium` tier selected `AVAssetExportPresetMediumQuality`.
This fixed-canvas preset reduces the long edge to 480px.
It changes `1206x2622` to `220x480` and landscape capture to `480x220`.
Only `AVAssetExportPresetHighestQuality` preserves arbitrary geometry.
Hardware encoding makes full-resolution export inexpensive: approximately 1–2s for 90s at `1206x2622`.
Thus, `high` was not slower.

`recording-overlay.swift` now always exports through the geometry-preserving preset at both quality tiers.
`--quality` no longer reduces capture resolution.
Before adoption, it verifies that the composited track's resolved size matches the capture.
It also rejects uniformly black output when the raw capture had visible content.
Either failure throws instead of publishing the output.
The caller drops the overlay, retains raw capture, and reports `overlayWarning` on `record stop`.
The same synthetic captures now match `--hide-touches`:

| Overlay | Interactions | Exported size (before → after) | Black? |
| --- | --- | --- | --- |
| default | two taps, 1206x2622 source | `220x480` → `1206x2622` | no |
| default | taps + scroll, landscape source | `480x220` → source size | no |
| `--hide-touches` | two taps | `1206x2622` → `1206x2622` | no |

The `after` column comes from this host's offline synthetic harness.
It reproduces the failure and confirms preserved geometry after the fix.
`test/integration/recording-overlay.test.ts` carries the on-device completion measurements for a non-rot90 target and Duo inner panel.
`AGENT_DEVICE_RECORDING_E2E` enables this device-lane case.
It compares touched export with a `--hide-touches` control.
It asserts equal track size and verifies that the overlay drew touches.

The device test reads transform-applied export dimensions through AVFoundation.
`test/integration/support/recording-inspect.swift` reports `renderWidth`/`renderHeight` through the overlay tool's same `resolvedRenderSize`.
Thus, `rot90` comparison uses upright geometry instead of the sideways encoded grid.
Shipped packages gain no second MP4 geometry parser.

A quarter-turn transform can place the upright frame outside a zero-origin composition canvas.
Duo inner capture has natural size `2006x2852` and transform `[0, 1, -1, 0, 0, 0]`.
Its upright `2852x2006` bounds start at `x=-2852`.
Without translation into the render canvas, the transform clips content and triggers the all-black check (#2774).
The overlay derives render size and origin translation from the same transformed bounds.
Native export regressions cover identity, translated quarter turns, and negative-origin quarter turns.
They assert upright content, unchanged geometry, and drawn touches.

## Verified on a booted Duo

In the closed pose, `screenshot` changed from `669x951` at luma 0.09 to `466x678` at luma 65.8.
A Safari address-field tap at `(191, 620)` opened the keyboard.
The `examples/test-app` dev build produced a 41-node `snapshot -i`.
A tap at `(345, 301)` dismissed the dev-menu sheet.
A Catalog-tab tap at `(128, 626)` settled `+19 -15`.

After an operator opened the device, capture explicitly named `LCD-1` at `951x669 @1x`.
`snapshot -i` returned Safari nodes on that surface.
`tap @e4` resolved inside it at `(590, 478)`.
`find text` found text sent through `type`.
Hit tests and readback therefore followed the lit panel.
A pre-fold ref was refused as an expired frame instead of replayed at the new point size.

The amended settle rule was verified on a booted iPhone Duo with iOS 27.1 at that PR's head.
`fold open` reported an end-stop reading of 180°.
From that pose, `fold half-open` reported 130° and `LCD-1` at `669x951pt`.
The moving hinge settled inside the interval.
The two-reading requirement therefore preserved the Book preset.
A subsequent `devicectl device motion hinge-angle` stream printed `Angle:130,0° Velocity:+0,0°/s`.
This confirmed the settled pair's result.
The session closed and its daemon stopped after the run.

## Which XCTest capture surface sees the lit panel

#2727 compared every runner-reachable `XCUIScreenshotProviding` surface against `simctl io screenshot --display=<panel>` for CoreDevice's lit panel.
The targets were iPhone Duo with iOS 27.1 and Xcode 27.1 beta, closed at 0° and open at 180°.
A 130° session with different app content corroborated results.
An iPhone 17 with iOS 27.0 served as the single-panel control.
Hinge readback determined pose, not the requested preset. The amendment above makes hinge readback the only defensible source for these recorded poses.
Two initial inner-panel sessions requested open but read back 130°.
They therefore serve as corroboration; the settled 180° session supplies the table.

Each session showed a different app screen to distinguish panel content.
The app remained unchanged between the reference and runner captures.
Thus, luma differences reflect sources rather than content changes.
Mean luma uses a 48x48 resample.
CoreDevice `displayId` supplies identity, and decoded-pixel comparison supplies agreement.
No claim here depends on luma.
PNG headers supply captured dimensions in native panel geometry.
Capture orientation presents some images turned.

| Capture surface | Outer panel lit (closed) | Inner panel lit (open, 180°) | Verdict |
| --- | --- | --- | --- |
| `simctl` capture of the lit panel | `1398x2034`, luma 221.86 | `2853x2007`, luma 192.02 | reference |
| `XCUIScreen.main.screenshot()` | `1398x2034`, luma 221.90 | `1398x2034`, **luma 0.00** | Names the outer panel in every pose. Correct only when that panel is lit. |
| `XCUIApplication.screenshot()` | `1398x2034`, luma 221.90 | `2006x2852`, **luma 0.00** | Inner geometry, outer content. Follows `app.screen`, fixed to panel `1`. |
| `XCUIScreen.screens[i].screenshot()` | its own panel | its own panel | Correct per object. The caller must name the panel; there is no default. |
| Resolved `window.screenshot()` | `1398x2034`, luma 221.90, 0 of 2,843,532 pixels differing from that panel's own screen capture | `2006x2852`, luma 192.03, 142 of 5,721,112 pixels differing by at most one per channel | **Captures the display the window is on in every pose** |
| `window.screenshot()` with no prior `frame` read | not run | identical to the row above, 0 pixels differing | The element resolves its own snapshot. The frame-first rule applies only to the identity read below. |
| `element.screenshot()` | `566x168` crop of a `188.67x56` pt cell | `168x1061` crop of a `353.67x56` pt cell | Correct. The crop uses native panel geometry and is turned relative to the element frame. |

The 130° session reproduced every inner-panel verdict.
`XCUIScreen.main` and application captures were black.
Window capture matched the panel screen capture within 187 pixels of 5,721,112 at content luma 236.91.
Window capture therefore produces the pixels of its window's display.
It is the only measured full-panel surface that required no pose knowledge.
`element.screenshot()` also followed the fold but returned only one element.

The image cannot establish these four facts:

- **Identity and declaration limits.**
  `XCUIScreen.h` declares only `screens` and `mainScreen`.
  It describes `mainScreen` as "the primary screen of the device".
  Selection of the outer panel in every pose is therefore documented behavior.
  On all measured screens, KVC answered `displayID`, `scale`, and `bounds`.
  `frame` and `name` raised `NSUnknownKeyException`.
  No XCTest header in this toolchain declares these keys.
  This identity read has the same undocumented dependency as #2724's gesture routing.
  #2728 inherits that breakage risk with either choice.
  It should reuse #2724's resolved-display read instead of adding a third path to the private key.
  The ordering from #2724 reproduced here.
  `app.screen` and an unresolved window reported `displayID` `1` while the app visibly occupied panel `3`.
  The resolved window reported `3`.
  `XCUIScreen` supplies neither panel power nor a `displayWithID:` lookup.
  Selection filters `XCUIScreen.screens`; CoreDevice retains `backlightState` authority.
- **Geometry.**
  Capture reports its panel's scale, measured as `3`, equal to CoreDevice `pointScale`.
  Geometry is native, not interface-oriented.
  On the `rot90` inner panel, the PNG is `2006x2852` with landscape content rotated inside it.
  The `UIImage` capture orientation has raw value `3`, whose display size transposes the panel.
  `simctl` exports the same panel upright as `2853x2007`.
  Production runner encoding and `XCUIScreenshot` encoding produce 0 different pixels from one capture, despite `358,402` versus `328,181` encoded bytes.
  The rotation therefore belongs to capture, not encoding.
  Rotation alone cannot equalize the images: raw `2006x2852` and `simctl` `2853x2007` differ by one pixel per axis.
  The shipped encoder draws upright at the image's own logical size and scale, without a crop.
  It preserves the one-pixel difference.
  Stretching to nominal CoreDevice dimensions would invent pixels absent from capture (#2741).
- **Overlays.**
  Screen capture and window capture both capture a display; window capture crops it to the window.
  Both include the software keyboard, SpringBoard permission alerts, and status bar.
  However, that alert's own window resolved to `displayID` `3`, the dark panel in the closed pose.
  Its capture returned a black `668x950` crop, indistinguishable from other dark-panel captures.
  The investigation did not measure a system window on the lit panel.
  System-surface verification therefore uses the app's panel instead of the system window.
- **Unresolved window.**
  A nonexistent element raises `Element Window (First Match) cannot request screenshot data because it does not exist` for screenshot requests.
  This refusal belongs only to the element route.
  `XCUIAutomation` also contains `Could not resolve displayID for snapshot %@; falling back to main display (id %lld)`.
  An internal snapshot-to-display failure can therefore silently select the main display.
  The helper resolves the window itself and reports its own typed reason.
  It does not use that message text as a contract.
  A default to `XCUIScreen.main` would recreate the original failure.

Every surface agreed on the single-panel control: one screen, `1206x2622`, `rot0`, upright crops, and no rotation correction.
A window-resolved source changes only explicit identity there.

## Interaction display and viewport

On an unfolded Duo, `XCUIApplication.frame` reports inner-panel native portrait coordinates, 669x951.
The app window and controls report landscape coordinates, 951x669.
The iOS capture viewport and synthesized gesture reference frame therefore use the resolved app window.
Normalization against the application frame rotates an already-oriented window.
Inversion of that normalization alone does not produce native digitizer coordinates.
The measured inner-panel button row in `contracts/fixtures/window-coordinate-space.json` maps window (476,226) to native digitizer (226,475).

Synthesized gesture records use `initWithName:displayID:interfaceOrientation:` and the resolved window's `screen.displayID`.
The window frame read must precede its screen read.
An unresolved element can still report the main screen.
`app.screen` is not authoritative for interaction display on this device.
Coordinate-based XCTest actions also originate at the resolved window.
Long presses and coordinate fallbacks therefore retain its display identity.

CoreDevice remains authoritative for host screenshot and recording panels.
Gesture routes follow the target app's window without a fixed panel ID or cached pose.
Verification must observe a fresh app-visible outcome.
Event synthesis success and `TouchEventsCompleted` alone do not prove a hit.
On iOS 27.1, explicit inner-panel events reach UIKit.
The silent misses investigated here came from default outer-display routes and incorrect viewports, not a prohibition on inner-panel delivery.

## Accepted evidence gaps

- **Runner capture on a physical foldable.**
  The app-display route was verified on simulated Duo open, half-open, and closed poses.
  The same route remains untested on physical foldables.
- **Runner frame observations.**
  Keyboard settling, screen recording, and navigation fallback now sample the display that owns a window.
  Each records its observation in `runner.log`.
  Keyboard settling was observed once on a lit panel behind a `returnKeyType="done"` field:
  `AGENT_DEVICE_RUNNER_KEYBOARD_STABILITY samples=3 captured=3 settled=yes`.
  Navigation fallback was observed once on a lit panel as the no-change control (#2741):
  `AGENT_DEVICE_RUNNER_IN_APP_BACK_VISUAL_VERIFICATION ... changed=no`.
  Neither was observed during a pose change.
  Screen recording was never observed.
  A mid-recording pose change moves capture to another display under a writer sized from the first frame.
  This mismatch remains untested.
- **Desktop capture paths.**
  Two `#if os(macOS)` screenshot siblings in `RunnerTests+CommandExecution.swift` still capture the desktop screen.
  `AgentDeviceMacOSHelper` also reaches it through Screen Capture Kit.
  Only iOS branches changed target.
  Desktop behavior remains unmeasured here.
- **Quarter-turn detection.**
  Both Duo panels report `currentOrientation: rot90`.
  No available path rotates a foldable.
  Inventory therefore carries orientation without a test against changed orientation.
- **A slowly settled hinge.**
  Four reads consume twenty seconds of streams.
  A Duo that takes longer to settle inside `half-open` is refused.
  The former rule would have reported pose.
  Every Duo run observed for this change settled within budget.
  No slower simulator was observed, so the budget remains unchanged rather than increasing for an unobserved case.
- **Physical foldables.**
  The leaf fact refuses a physical device.
  The hinge stream was never exercised on a physical device.

## Android emulators (amendment, 2026-10-10)

The same `fold` command poses a foldable Android emulator.
It keeps the two facts of this ADR separate in the same way: which panel a capture must name and what pose the device is in.
There is no host display authority.
Emulator-console `posture <id>` sets the hinge sensor to the profile's angle:

- Pixel folds: 0°, 90°, 180°.
- Generic "7.6in Foldable": 15°, 90°, 165°.

Verification polls `cmd device_state print-state` until the guest commits the posture's `CLOSED`, `HALF_OPENED`, or `OPENED` state.
`WindowManager` derives `FoldingFeature` from this state.
Hinge-sensor readback supplies the reported angle; it does not determine success.
All observed Android profiles use 90° for half-open; Duo uses 130°.

A fold to the cover display can show keyguard.
Emulator images do not honor Android's "continue using apps on fold" setting.
`fold` dismisses keyguard so later captures show the app instead of the lock screen.
A profile that lists none of these device states has no hinge.
It is refused as `single-panel-device`, the same typed reason as a single-panel simulator.
Keyframes and panel geometry remain Apple-only.
The emulator console supports only fixed postures.
Android reports the app window on the next snapshot instead of a panel.
