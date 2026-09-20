# ADR 0025: Foldable Apple Panels — Capture the Lit Panel

## Status

Accepted (2026-09-20). Covers iPhone Duo (iOS 27.1, `iPhone19,4`) and any Apple device that
reports more than one integrated CoreDevice display.

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
| Density normalization | Use the captured panel's own `pointScale`; a runner-fallback capture keeps the scale probe because `XCUIScreen.main` may be a different panel |
| Pose must be reported | Report `closed`, `fully-open`, or `unknown` from panel power, and never narrower |
| A pose change is requested | Refuse in guidance, not by inventing a command: no official host API sets pose |
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

## Pose is derived, and official control does not exist

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
  usable: it is still not an API, and the Device Hub device surface exposes zero accessibility
  nodes.

Consequences that are now policy: no `fold`/`unfold`/`half-unfold` command, because a command that
cannot do the thing is worse than no command, and because a private per-guest XPC channel is exactly
the kind of undocumented hook that breaks without notice. Guidance in `agent-device help foldable`
tells agents pose is operator-controlled, and a derived `fully-open` verdict is documented to cover
Apple's `fullyOpen` **and** `partiallyOpen` — panel power cannot separate them, so only an in-app
`UIHinge.status` read can.

## Refuted alternatives

- **Pose commands backed by `simctl io screenConfig power`.** Rejected: it does not move
  `UIHinge.status`, so the app under test would not behave as folded. It would produce green tests
  of a state the device is not in.
- **Pose commands backed by macOS UI automation of Device Hub.** Rejected: the Device Hub device
  surface reports zero accessibility nodes, so it is coordinate-only and permission-bound
  (Screen Recording), and no Xcode framework exposes the control it would press. Kept as a
  documented possibility in help, not as shipped automation.
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
coordinates do not survive it. `agent-device help foldable` states this and states that agents must
report which poses remain unverified rather than assume a pose was set.

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

## Accepted evidence gaps

- **Runner screenshot fallback.** `XCUIScreen.main` is hardcoded in the runner's `screenshot`
  command and in the synthesized-gesture reference frame. The `simctl` path is the default for iOS
  simulators, so the fix above covers the proven failure, but the runner fallback and the
  physical-device path are unverified on an open Duo. `XCUIScreen` exposes no geometry, identity, or
  `active` flag — only `screens` and `mainScreen` — so choosing the lit panel there cannot be done
  officially without pairing screenshots against panel geometry, which is the pixel heuristic this
  ADR rejects. Left unresolved rather than guessed.
- **Quarter-turn detection.** Both Duo panels report `currentOrientation: rot90`, and no available
  path rotates a foldable, so the orientation half of the inventory is carried but never exercised
  against a changed value.
- **Pose control.** No official host API sets the hinge angle, so both poses above depend on an
  operator opening or closing the device in Device Hub.

