# ADR 0025: Foldable Apple Panels — Capture the Lit Panel

## Status

Accepted (2026-09-20; the pose-settle rule amended 2026-09-21 under #2730). Covers iPhone Duo
(iOS 27.1, `iPhone19,4`) and any Apple device that reports more than one integrated CoreDevice
display.

An iPhone Duo carries two integrated panels — Apple's **outer display** and **inner display** —
and lights one of them at a time. Which one is lit is the device pose. Two independent facts
follow, and this ADR keeps them separate: **which panel a capture must name**, and **what pose the
device is in**. The first is answered by an official host API; the second only by inference.

## Rules at a glance

| Situation | Behavior |
| --- | --- |
| Any iOS simulator capture | Resolve the CoreDevice display table first; capture the panel the system currently lights |
| Device has more than one integrated panel | Pass `--display=<panel name>` on every `simctl io screenshot`; never rely on the implicit default |
| Panel power is ambiguous (zero or several lit panels) | Still name a panel — the `primary` one — emit `apple_display_capture_ambiguous`, and report the pose as `unknown` |
| Device has one integrated panel | Keep the pre-panel behavior exactly: no display flag, no pose, unchanged scale probe |
| Density normalization | Use the captured panel's own `pointScale`; a runner-fallback capture uses the pixels-per-point that capture reported about itself |
| Pose must be reported | From panel power alone, report `closed`, `fully-open`, or `unknown`, and never narrower; `fold` reports the exact pose because it reads the hinge angle |
| A pose change is requested | `agent-device fold <closed\|half-open\|open>`: press the pose control in the Device Hub window through macOS accessibility, then read the hinge angle back from CoreDevice until it agrees — for `half-open`, until two consecutive readings agree; refuse the pose if it never does |
| The hinge reaches `half-open` but keeps moving | Refuse it as `fold-pose-unsettled` with the observed and previous angles: an angle inside the open interval is an observed category, not a pose the hinge holds |
| An external display is attached | It is not a panel: it never makes the device multi-screen and never produces a pose |
| CoreDevice cannot answer | Return an unresolved inventory and keep the single-panel capture path; a missing host feature is not a capture failure |

## Contracts

`packages/platform-apple/src/core/display-inventory.ts` owns the panel model and is the only
reader of CoreDevice display info.

- **Authority.** `xcrun devicectl device info displays --json-output` (`jsonVersion` 5) is the only
  screen authority. It reports per panel: `name` (which `simctl io --display` also accepts),
  `displayId`, `nativeSize`, `pointScale`, `currentOrientation`, `type`, `primary`, `active`, and
  `backlightState`. It works for simulators (`reality: simulated`) and physical devices alike.
- **Panel power.** `backlightState` is the authority and `active` is only a fallback, because
  `active` is genuinely absent from real payloads: a single-panel iPhone 17 reports
  `backlightState: activeOn` and no `active` key at all, so a parser keyed on `active` would call
  that panel dark. The `BacklightState` union is `activeOn`, `inactiveOn`, `activeDimmed`, `off`,
  `unknown`; the first three are lit. An unrecognized future case is `unknown`, not `dark`, because
  guessing dark would aim a capture at a panel that may be showing nothing.
- **Panel identity.** A device is multi-screen when it reports more than one `type: integrated`
  panel. CoreDevice marks one panel `primary`; that panel is the outer display, because it is the
  panel that stays lit while the device is closed. `primary` and the lit count are the whole model:
  the inventory labels panels `outer`/`inner` nowhere, because no caller consumes a label — every
  decision is made from `primary` plus panel power, and a name derived from array order or from
  geometry would be a second source of truth ready to invert silently. When the primary panel is
  also the largest, the `primary` attribute still decides and the conflict is emitted as
  `apple_display_primary_geometry_conflict` rather than silently repaired by a geometry rule.
- **Capture target.** `resolveAppleCaptureDisplay` returns a panel for every multi-panel device and
  `undefined` only for a single-panel device or an unresolved inventory. When panel power identifies
  exactly one lit panel that panel is named; otherwise the `primary` panel is named anyway,
  `ambiguous` is set, and `apple_display_capture_ambiguous` is emitted. A multi-panel device never
  receives a display-less capture, because the implicit default is precisely the black-and-exit-0
  failure being fixed; naming a possibly-dark panel is a visible, diagnosable miss instead.
- **No pose field.** Panel power cannot separate Apple's `UIHinge.Status.fullyOpen` from
  `.partiallyOpen` — both leave the inner panel lit and the outer panel dark — so a derived pose
  could only ever mean "not closed" while looking like a fact. The inventory therefore reports what
  it measured (`primary`, panel power, geometry, orientation) and leaves pose to the app under test,
  which can read `UIHinge.status` exactly. A caller that needs the pose asks the operator and
  re-snapshots.
- **No cache.** The probe runs per capture. Which panel is lit is precisely what an operator
  changes by folding or opening the device, so a cached inventory would resume capturing the dark
  panel — the exact failure being fixed. The probe runs under
  `IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS` (5s), deliberately below the 20s screenshot deadline it
  precedes, so a wedged CoreDevice cannot spend the capture's own budget; measured real cost is
  0.16–0.26s against 4.93s for the screenshot.

## Why the default capture had to stop being implicit

`simctl io screenshot` without `--display` picks the **highest** screen ID, not the primary panel.
On a closed Duo that is the inner panel, which is dark. The command exits 0 and writes a valid PNG
whose content is black, so every downstream consumer trusts a capture of nothing:

| Capture path | Before | After |
| --- | --- | --- |
| `screenshot` on a closed Duo | 669x951 @1x, mean luma 0.09 (black) | 466x678 @1x, mean luma 65.8 (the lit outer panel) |
| `screenshot` on an open Duo | 951x669 @1x, mean luma 241 (correct by luck: the highest screen ID is the lit inner panel) | 951x669 @1x naming `LCD-1` explicitly |
| `screenshot` on iPhone 17 | 402x874 @1x, mean luma 104.9 | unchanged |

This is the failure behind reports that the tool "picks the wrong screen" on iPhone Duo. It was
never a selection problem: only the lit panel is capturable, so naming the lit panel is the whole
fix, and no screen-selection flag is warranted.

`SIMULATOR_MAINSCREEN_SCALE` is likewise fixed to one panel while the captured panel can be the
other, so density normalization now takes `pointScale` from the panel that was captured.

### Runner capture follows the app's window (#2728)

Naming the lit panel only helps a capture that asks CoreDevice. The runner captured
`XCUIScreen.main`, one fixed panel, so a capture reached through the runner — the fallback when
`simctl` fails, and every visual verification inside the runner — followed a panel chosen at build
time instead of the app. The runner now resolves the app window first, reads the display off that
same window instance, and encodes the capture upright, because the image handed back for a panel
the system presents turned has its buffer sideways.

The capture reports the display ID it used, the pixel size it encoded, and the pixels-per-point of
that image, so density normalization reads the source it captured instead of applying a scale the
host inferred. A runner that reports nothing measured nothing, and normalization keeps the pre-panel
answer rather than borrowing a scale from a panel nobody captured.

A capture asks the target app's window first and the system surface's window second. The home screen
is SpringBoard's window, so a capture with no session app — or with one that is not running — still
has a display that owns a window, and asking for it keeps the foldable rule intact: the answer is
always a display a window actually occupies, never `XCUIScreen.main`, which on a Duo is the dark
panel whenever the app is inside. A capture fails closed with a typed reason only when neither
resolves a window. An app with no window is refused on the query's own `exists` answer as well as on
its frame: a windowless app answers `frame` with `(0,0 0x0)` without raising, so geometry alone
cannot say "no window".

Both answers are measured rather than assumed. A session with no app, and one whose app was terminated while still bound, answer the window query with `resolved=no`, and the capture that follows names the lit panel — on an unfolded Duo that is `LCD-1`, and the resulting home-screen image contains no black pixel. An app suspended by `home` keeps answering with a usable window, so it takes the first branch and still captures the panel it is on.

`screenshot` is a runner-lifecycle command and skips the app-activation preflight, which left its
app as the runner host process on a fresh runner — a process with no window at all. It resolves the
requested bundle id for observation instead, and never activates an app to learn what it is
foregrounded on. Measured on a live Duo through the runner route, one command with unchanged flags:

| Pose | Lit panel | Capture | Mean luma |
| --- | --- | --- | --- |
| Open (hinge 180°) | `LCD-1` (ID 3) | 951x669 @1x | 214 |
| Half-open (hinge 130°) | `LCD-1` (ID 3) | 951x669 @1x | 214 |
| Closed (hinge 0°) | `LCD` (ID 1) | 466x678 @1x | 177 |

The closed row is the point: the same command followed the app onto the other panel without being
told, and every row is real content where a main-screen capture of the unlit panel is black.

## Pose control: Device Hub's control, CoreDevice's verdict

`agent-device fold` sets the pose, and the split above still holds: the press is not evidence,
the read-back is. The pieces, each of which was checked on the shipping 27.1 toolchain:

| Piece | Finding |
| --- | --- |
| Who sets the pose | Device Hub's `CoreDevicePopDeviceKitExtension` (the V68 device view with its `poses` action bar) hands a "vendor defined" orientation-control payload to `CoreDevicePopCoreDeviceExtension`, which sends it through CoreDevice's private HID channel. No CLI, `simctl`, `devicectl`, or XCUITest surface reaches that channel |
| The public seam | The action bar's pose controls are ordinary `AXButton`s described `Closed`, `Book`, and `Open` in the Device Hub window; the simulated screen inside the same window is an `iOSContentGroup` with the app's own nodes. The earlier finding that the device surface exposes "zero accessibility nodes" was an artifact of System Events, which sees Device Hub with pid 0 because the app is launched through a trampoline; an `AXUIElement` built from the real pid works |
| Reading the pose | `xcrun devicectl device motion hinge-angle --device <udid>` streams the hinge angle for the Duo simulator (`Range:0-180°`): Closed 0°, Book 130°, Open 180°. The stream does not end when `--session-timeout` elapses, so one read is bounded by devicectl's own `--timeout`, whose smallest accepted value is 5 seconds; the sample it printed before aborting itself is the reading |
| Device identity | Device Hub titles the window `<name> – iOS 27.1`, which two simulators sharing a name cannot distinguish. Its sidebar rows carry `AXIdentifier` `TableRow.Device.<UDID>`, and setting `AXSelected` on a row switches the window to that device, so the row is `fold`'s only device handle — but a missing row plus a same-named twin's matching title skips the selection before any press, and the confirmation is by title too (see Accepted evidence gaps) |
| No window | A simulator booted headlessly leaves Device Hub running with no window. LaunchServices cannot address the trampolined process by bundle id (`open -b`, `NSRunningApplication.activate` do nothing), but a `kAEReopenApplication` event sent to the pid restores the device window, the same event a Dock click sends |

The rule this yields: `closed` and `open` are the hinge's two end stops, so one read at the stop is
the pose. Every other angle is `half-open`, including the ones a hinge sweeps through on its way
somewhere else, so an angle in that open interval proves only the category — the pose is the hinge
*resting* there, which two consecutive reads show by both classifying as `half-open` and agreeing
within 0.5°. Each read takes the last sample the five-second stream printed, so a moving hinge is
reported where it is now. The run that first exposed the animation — before the amendment below —
read 175.1° one stream after pressing Book and 130° two streams later; the run recorded under the
amended rule is in "Verified on a booted Duo". A budget that ends with the hinge at some other pose is
refused as `fold-pose-unverified` with the angle CoreDevice still reports; one that ends on an
unsettled `half-open` angle is refused as `fold-pose-unsettled` (see the amendment below). The
response of a verified pose carries the angle and the lit panel's point
size, because the point size is what tells an agent its refs are stale.

Requirements the command states in its own errors: Accessibility permission for the host
(`accessibility-permission`), a running Device Hub (`fold` launches it in the background the way
`open` does), a device window it can reopen (`device-hub-window-missing`), and a sidebar row for
the UDID (otherwise `device-hub-identity-unconfirmed`). A single-panel simulator is refused before anything is
pressed (`single-panel-device`), and the leaf fact refuses physical devices and every non-iPhone
simulator OS.

Window discovery reads `AXWindows` from every matching Device Hub process within one shared
retry budget. These are application-wide windows; discovery does not click through monitors or
move windows to the main display. A failed accessibility read retains its AX status and returns
`device-hub-window-read-failed`, rather than masquerading as an empty window list. Only successful
empty reads trigger a reopen. A matching UDID sidebar row is required before pressing, including
when a window title already matches. An unrelated window does not stop attempts on other
windows or empty processes. A hidden sidebar is revealed through that window’s own toolbar button;
application-wide menus cannot redirect the action to another window. Sidebar reads and
restoration use bounded AX calls. Cleanup is registered before a sidebar press, since an AX reply
can time out after the action applied. Selection verifies the row's `AXSelected` state and the
window title even after an uncertain reply. Discovery passes the proven row to selection instead
of searching twice. Inconclusive candidates report `device-hub-identity-unconfirmed` with each
candidate's outcome; exhausting the shared budget before finishing work reports
`device-hub-discovery-timeout`. Neither claims a device is absent. Active host display IDs stay
in discovery error details; display geometry does not participate in AX window selection.

## Amendment: an observed half-open angle is not a settled pose (issue #2730)

The rule above first ended the other way: `half-open` was also reported when the four-read budget
ran out while the hinge still read `half-open`, because a refusal was not allowed to name the pose
that was asked for. That reasoning confuses an observed category with a completed pose change.
`half-open` is an open interval, so a hinge travelling between the end stops passes through it on
every fold; four readings that each land inside the interval and never agree describe a hinge in
motion, and reporting them as a pose tells an agent the Book preset is on screen when nothing is at
rest there. The interval rule also cannot pin a value: Device Hub's Book preset measures 130° on
this iOS 27.1 Duo, which is one device's measurement, not the success condition — stability is.

So `fold half-open` succeeds only on two consecutive readings that both classify as `half-open` and
differ by at most 0.5°. Numerical proximity is not agreement when the pair straddles a category
boundary: 179° is `open` and 178.8° is `half-open` although they differ by 0.2°, and those are two
poses, not one resting hinge. A budget that ends on an unsettled `half-open` angle fails with
`COMMAND_FAILED`, `details.reason: "fold-pose-unsettled"`, `requestedPose`, `observedPose`,
`hingeAngleDegrees` and the previous reading, and says the hinge was observed half-open and did not
settle — never that it failed to reach half-open, which its own observed pose refutes.
`fold-pose-unverified` stays for a budget ending on another pose, and keeps classifying from that
final sample alone: a hinge that passed through `half-open` on its way to the end stop is refused as
unverified, because the pose it ended in is not the one that was asked for.
The attempt count, the per-read timeout, cancellation, and the open/closed end-stop
rule are unchanged: an unsettled fold costs the same four hinge streams it always did.

## Pose is derived from panel power, and official control does not exist

Apple ships fold state as an **app-side, read-only** API: `UIHinge.status`
(`.closed`/`.partiallyOpen`/`.fullyOpen`) observed through `UIHingeInteraction`, and SwiftUI
`DeviceHinge` / `.onHingeChange`, both `ios(27.1)`. There is no `UITraitCollection` trait for it.

No **official** host-side control channel exists. Each candidate was checked against the shipping
toolchain:

| Candidate | Result |
| --- | --- |
| `simctl` subcommands | no `hinge`/`fold`/`pose` surface; no such token in the `simctl` binary or in `CoreSimulator.framework` |
| `simctl io` | `screenshot`/`recordVideo` take `--display`; `screenConfig` sets `power` and `geometry` per screen — neither changes hinge state |
| XCUITest | no hinge token in any `XCUIAutomation` header; `XCUIDeviceButton` is Home/VolumeUp/VolumeDown/Action/Camera only |
| CoreDevice | `com.apple.coredevice.action.streamhingeangle`, `HingeAngleManager`, `DeviceHingeAngleSnapshot` and `HingeAngleStreamConfig` exist in `/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework` (and `dtdeviceinfod`), but they **stream** an angle; the Duo reports no such feature, and `devicectl` exposes no CLI for it |
| `devicectl` | `device info displays` reports panel state only |
| `Xcode.app` frameworks | no hinge reference in `Xcode.app/Contents/{SharedFrameworks,Frameworks}`, so Device Hub's own control is not a hinge API shipped inside Xcode |

Two searches came back empty rather than negative, and are recorded as limits rather than refuted
claims:

- The **simulator guest runtime** was not enumerated for a host-reachable control channel. Symbol
  archaeology turned up a private SpringBoard service (`SBDisplayToolService`,
  `com.apple.springboard.sbdisplay.service`) with `setPrimary:displayUUID:`,
  `setBacklightState:displayUUID:` and `replayHingeSamplesWithOptions:path:`, plus
  `SBContinuousFoldController` and a `com.apple.springboard.fold` notification. No client, launch
  path, or invocation from this host was found, so it is an **unproven private lead** — not adopted,
  and not a basis for any claim that pose control is possible.
- Device Hub's control could live in a private framework outside `Xcode.app`. That would not make it
  usable: it is still not an API.

Consequences that are now policy: no private per-guest XPC channel is driven, because an undocumented
hook is exactly the kind that breaks without notice; the one host control that exists is Device
Hub's own, and `fold` drives it through the accessibility API and trusts only the CoreDevice
read-back (see the section above). A pose derived from panel power alone is still documented to
cover Apple's `fullyOpen` **and** `partiallyOpen` — panel power cannot separate them, so only the
hinge angle or an in-app `UIHinge.status` read can.

## Refuted alternatives

- **Pose commands backed by `simctl io screenConfig power`.** Rejected: it does not move
  `UIHinge.status`, so the app under test would not behave as folded. It would produce green tests
  of a state the device is not in.
- **Pose commands backed by coordinate clicks on Device Hub.** Rejected: a coordinate press is
  blind to which window and which device it lands on and needs Screen Recording to aim. The
  accessibility press `fold` uses names the control, the window, and the device row, needs only
  Accessibility permission, and is still not trusted on its own: the hinge read-back is.
- **A `fold` that reports the pose it requested.** Rejected: the press is dispatched to whatever
  Device Hub window is frontmost for that device, and a press on the wrong window succeeds
  silently. Only the CoreDevice hinge angle says the device moved.
- **Luma or content heuristics to pick the lit panel.** Rejected: a black screenshot is legitimate
  content elsewhere, and the repo already forbids deciding on pixels when a typed fact exists.
  CoreDevice reports `active`/`backlightState` directly.
- **A `--screen outer|inner` flag.** Rejected as unnecessary: the inactive panel renders black, so
  a non-active selection can only ever capture nothing. Revisit only when a device shows content on
  two panels at once.
- **Reading the device type's `capabilities.plist` for the panel table.** Rejected: `devicectl`
  reports live panel state, which the plist cannot, and works identically on physical devices.

## Consequences for agents

A pose change moves the app to a different panel with different point size, so refs and
coordinates do not survive it. `agent-device help foldable` states this, `fold` says so in its own
message, and agents fold to each pose a task names and re-snapshot rather than assume one.

`simctl io recordVideo` has the same implicit-display default as `screenshot`, so recording names
the lit panel through the same resolver. On an open Duo the 27.1 toolchain accepts the panel name
and honors it per panel; sampled mean luma over the whole frame:

| `recordVideo` argv | exported size | mean luma |
| --- | --- | --- |
| `--display=LCD-1` (lit inner) | 2006x2852 | 241.42 |
| `--display=LCD` (dark outer) | 1398x2034 | 0.00 |
| no `--display` | 2006x2852 | 241.42 |

`record start`/`record stop` exit 0 in both poses, and with `--hide-touches` the export keeps the
captured geometry (`2006x2852`, mean luma 241.42). Without it the touch-overlay exporter loses the
track geometry, and on a long clip the frames too.

The trigger is the overlay drawing touch events, not panel rotation. Measured on an iPhone 17
(iOS 27.0), which has no rotated panel: four seconds with no interaction exports `1206x2622`
intact, ten seconds containing two taps exports `220x480`, and the same two taps under
`--hide-touches` export `1206x2622` with the screen content changing across frames. A 97-second
recording with touches exported `480x220` at mean luma 0.00 throughout. An earlier draft of this
section blamed the inner panel's `rot90` track, which was wrong: every failing sample then available
had merely been captured on that panel, and the one non-rotated sample that looked intact had
contained no touches to draw. Feeding an untouched raw `simctl` capture straight into
`recording-overlay.swift` reproduces a `0x0` zero-duration output. Tracked in #2707.

## Verified on a booted Duo

Closed pose: `screenshot` moved from `669x951` luma 0.09 to `466x678` luma 65.8; a tap on Safari's
address field at `(191, 620)` opened the keyboard; and on the `examples/test-app` dev build a
41-node `snapshot -i`, a tap that dismissed the dev-menu sheet at `(345, 301)`, and a Catalog-tab tap
at `(128, 626)` that settled `+19 -15`.

Open pose, after an operator opened the device: the capture names `LCD-1` at `951x669 @1x`,
`snapshot -i` returns Safari's nodes on that surface, `tap @e4` resolves to `(590, 478)` inside it,
and text sent with `type` is found again by `find text` — hit testing and read-back both follow the
lit panel. A ref issued before the fold is refused afterwards as an expired frame rather than
replayed at the new point size, which is the pose-change rule working as designed.

Half-open pose under the amended settle rule, on a booted iPhone Duo (iOS 27.1) at this PR's head:
`fold open` reported 180° on its end-stop reading, and `fold half-open` from that open pose reported
130° naming `LCD-1` at `669x951pt`. The hinge was travelling when the press landed and still came to
rest inside the interval, so requiring a settled pair did not lose the Book preset. A
`devicectl device motion hinge-angle` stream read afterwards reported `Angle:130,0° Velocity:+0,0°/s`
— the hinge is where the pair rule said it was. The run's session was closed and its daemon stopped
afterwards.

## Which XCTest capture surface sees the lit panel

#2727 measured every `XCUIScreenshotProviding` surface a runner can reach against the `simctl io
screenshot --display=<panel>` capture of the panel CoreDevice reports lit, on iPhone Duo (iOS 27.1,
Xcode 27.1 beta) closed at hinge 0° and open at 180°, with a 130° session on different app content
as the corroboration run and iPhone 17 (iOS 27.0) as the single-panel control. Poses came from the
hinge read-back, not from the pose that was requested — the amendment above is why that is the only
defensible source: the first two inner-panel sessions were booked as open and both read back 130°,
so they are recorded here as corroboration and the settled 180° session carries the table. A
different app screen was shown per session, so neither panel could be mistaken for the other by
content, and the app was left untouched between the oracle and the runner capture, so a luma gap is
a source difference rather than a content one. Mean luma comes from a 48x48 resample; panel
identity comes from CoreDevice's `displayId` and pixel agreement from comparing decoded pixels, so
no claim here rests on luma. Captured dimensions are PNG header dimensions, which is the panel's
native geometry — the capture's own orientation presents some of them turned.

| Capture surface | Outer panel lit (closed) | Inner panel lit (open, 180°) | Verdict |
| --- | --- | --- | --- |
| `simctl` capture of the lit panel | `1398x2034`, luma 221.86 | `2853x2007`, luma 192.02 | reference |
| `XCUIScreen.main.screenshot()` | `1398x2034`, luma 221.90 | `1398x2034`, **luma 0.00** | Names the outer panel in every pose, so it is correct only while that panel is lit |
| `XCUIApplication.screenshot()` | `1398x2034`, luma 221.90 | `2006x2852`, **luma 0.00** | Inner geometry, outer content: follows `app.screen`, which stays pinned to panel `1` |
| `XCUIScreen.screens[i].screenshot()` | its own panel | its own panel | Correct per object; naming the panel is the caller's job, never a default |
| Resolved `window.screenshot()` | `1398x2034`, luma 221.90, 0 of 2,843,532 pixels differing from that panel's own screen capture | `2006x2852`, luma 192.03, 142 of 5,721,112 pixels differing by at most one per channel | **Captures the display the window is on in every pose** |
| `window.screenshot()` with no prior `frame` read | not run | identical to the row above, 0 pixels differing | The element resolves its own snapshot; the frame-first rule belongs to the identity read below, not to the capture |
| `element.screenshot()` | `566x168` crop of a `188.67x56` pt cell | `168x1061` crop of a `353.67x56` pt cell | Correct; the crop is taken in the panel's native geometry, so it is turned relative to the element's frame |

The 130° corroboration session reproduced every verdict on the inner panel, including the black
`XCUIScreen.main`, the black application capture, and the window capture matching its panel's own
screen capture to within 187 pixels of 5,721,112 at content luma 236.91. So a window capture is the
same pixels as the screen capture of the panel its window sits on, and it is the only full-panel
surface measured that needed no pose knowledge. `element.screenshot()` followed the fold too, but
returns one element rather than a panel.

Four facts the capture path cannot read off the image:

- **Identity, and how little of it is declared.** `XCUIScreen.h` declares `screens` and
  `mainScreen` alone, and documents `mainScreen` as "the primary screen of the device", so naming
  the outer panel in every pose is the documented behavior and not a malfunction. `displayID`,
  `scale`, and `bounds` answered KVC on every screen measured while `frame` and `name` raised
  `NSUnknownKeyException`, but none of those keys appears in any XCTest header in this toolchain:
  the identity read is as undocumented as the one #2724 already relies on for gesture routing, and
  #2728 inherits that breakage risk whichever way it goes. It should reuse #2724's resolved-display
  read rather than open a third route to the same private key. The ordering #2724 recorded held
  here: `app.screen` and an unresolved window reported `displayID` `1` while the app was visibly on
  panel `3`, and the resolved window reported `3`. `XCUIScreen` carries no panel-power fact and no
  `displayWithID:` lookup, so a panel is chosen by filtering `XCUIScreen.screens` and
  `backlightState` stays CoreDevice's. - **Geometry.** The capture carries the panel's own scale
  (measured `3`, equal to that panel's CoreDevice `pointScale`) in the panel's *native* geometry
  rather than the interface orientation: on the `rot90` inner panel the PNG is `2006x2852` with the
  landscape content rotated inside it and the `UIImage` carrying capture orientation raw value `3`,
  whose display size transposes the panel, where `simctl` exports the same panel `2853x2007`
  upright. The runner's production encoder and `XCUIScreenshot`'s produce 0 differing pixels for
  one capture from `358,402` and `328,181` encoded bytes, so the turn belongs to the capture and
  not to an encoder. Rotating is not enough to compare the two: the runner's canvas is `2006x2852`
  and `simctl`'s `2853x2007`, a pixel apart on each axis, so #2729's normalization owes a rotation
  and a crop. - **Overlays.** A screen capture and a window capture are both display captures — the
  second cropped to the window — so the software keyboard, a SpringBoard-hosted permission alert,
  and the status bar all appear in either. It cuts the other way as well: that alert's own window
  resolved to `displayID` `3`, the dark panel in the closed pose, and capturing it yielded a black
  `668x950` crop indistinguishable from any capture of a dark panel. Whether a system window on the
  *lit* panel captures was not measured, so a system surface is verified on the app's panel, not
  through its window. - **Unresolved window.** Asking an element that does not exist for screenshot
  data raises `Element Window (First Match) cannot request screenshot data because it does not
  exist` instead of capturing anything, but that is the element route only: `XCUIAutomation` also
  contains `Could not resolve displayID for snapshot %@; falling back to main display (id %lld)`,
  so an internal snapshot-to-display resolution failure can reach the main display silently. A
  helper therefore resolves the window itself and reports its own typed reason, and does not treat
  that message text as the contract. Defaulting to `XCUIScreen.main` on that path would be this
  ADR's original bug, renamed.

On the single-panel control every surface agreed: one screen, `1206x2622`, `rot0`, upright crops, no
rotation to repair. A window-resolved source changes nothing there except that its identity becomes
explicit.

## Interaction display and viewport

On an unfolded Duo, `XCUIApplication.frame` reports the inner panel in native portrait
coordinates (669x951), while the app window and its controls report landscape coordinates
(951x669). The iOS capture viewport and synthesized gesture reference frame therefore come
from the resolved app window. Normalizing against the application frame rotates an already
oriented window; inverting that normalization alone does not produce native digitizer coordinates.
The measured inner-panel button row in `contracts/fixtures/window-coordinate-space.json` maps
window (476,226) to native digitizer (226,475).

Synthesized gesture records use `initWithName:displayID:interfaceOrientation:` and the resolved
window's `screen.displayID`. Reading the window frame must precede reading its screen: an
unresolved element can still report the main screen. `app.screen` is not the display authority
for interactions on this device. Coordinate-based XCTest actions also originate at the resolved
window, so long presses and coordinate fallbacks carry its display identity.

CoreDevice remains the capture-panel authority for host screenshots and recordings. Gesture
routing follows the window hosting the target app, without a hard-coded panel ID or cached pose.
Verification must observe a fresh app-visible outcome: event synthesis success and
`TouchEventsCompleted` alone do not prove a hit. On iOS 27.1, explicit inner-panel events reach
UIKit; the silent misses investigated here came from the default outer-display route and the
incorrect viewport, not an inner-panel delivery prohibition.

## Accepted evidence gaps

- **Runner capture on a physical foldable.** The runner resolves the app's own display and was
  verified across the open, half-open, and closed poses on a simulated Duo, but the same route on a
  physical foldable was never exercised.
- **Runner observation paths that sample a frame.** Keyboard settling, screen recording, and the
  navigation fallback now take their frame from the display owning a window and each states in
  `runner.log` what it looked at, but none was watched on a device that changes panel under it. A
  pose change mid-recording still changes the captured display under a writer sized from the first
  frame, and that mismatch was never exercised.
- **Desktop capture paths.** The two `#if os(macOS)` siblings of the `screenshot` capture in
  `RunnerTests+CommandExecution.swift` keep capturing the desktop screen, which also reaches the
  screen through Screen Capture Kit in `AgentDeviceMacOSHelper`; only the iOS branches changed
  target, and the desktop behavior stays unmeasured here.

- **Quarter-turn detection.** Both Duo panels report
  `currentOrientation: rot90`, and no available path rotates a foldable, so the orientation half of
  the inventory is carried but never exercised against a changed value. - **Pose control on a
  second Device Hub instance.** Discovery checks every matching process, but simultaneous Xcodes
  and the secondary-display fold matrix remain unverified on live hardware. - **A hinge that
  settles slowly.** Four reads is twenty seconds of streams, and a Duo that needs longer to come to
  rest inside `half-open` is now refused where the superseded rule would have reported a pose.
  Every Duo run observed for this change settled inside the budget; no simulator that needs longer
  was seen, so the budget stays as it is rather than growing on a hypothesis.

- **Pose control when two simulators share a name.** The earlier title-only fallback could press
  a different Duo when the intended device's row was unavailable; hinge verification refused the
  result only after the other device had moved. Discovery now requires the UDID row, and selection
  confirms `AXSelected` as well as the window title before pressing. Live wrong-UDID refusal and
  hidden-sidebar recovery were checked; the simultaneous same-name simulator matrix remains open.
- **Physical foldables.** Device Hub poses simulators only; the leaf fact refuses a physical device,
  and the hinge stream on one was not exercised.
