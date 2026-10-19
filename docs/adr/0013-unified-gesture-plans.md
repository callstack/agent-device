# ADR 0013: Unified Gesture Plans

## Status

Accepted

Completed process history is in git history.

## Rules at a glance

- Normalize public gesture input once in `packages/contracts/src/gesture-normalization.ts`.
- Plan canonical intent in `packages/contracts/src/gesture-plan.ts`. Keep contact topology separate from motion.
- Reject removed deprecated arguments with actionable `INVALID_ARGS` messages. Do not silently reinterpret them.
- Carry Maestro's `endpoint-hold` profile only on the private daemon wire. A genuine public `pan` uses `timed-pan`.
- Every injected sample must fit the freshly resolved active-app interaction viewport.
  Otherwise, the request fails before injection with `GESTURE_TRAJECTORY_OUT_OF_BOUNDS`.
  The planner does not clamp points, cache the viewport, or distort the requested components.
- Android touch execution never falls back to `adb input swipe`.
- On Android, gestures do not stop or restart the snapshot session.
- Keep the positional `.ad` codec. One `PUBLIC_GESTURE_SYNTAX` table defines argument arity for the CLI argv parse and the `.ad` line parse.
- For repeated coordinate swipes, the combined planned gesture and pause schedule must fit within 60 seconds.
- For target-authored drag, resolve both endpoints before device injection. On replay, verify both identities before pointer-down.
- Admit target-authored drag only on Android touch devices and iOS/iPadOS.
- iOS timing changes require live simulator evidence from an independent app-observed postcondition.

## Context

Several private boundaries previously interpreted gesture intent:

- Command aliases produced positional strings.
- Daemon dispatch parsed them again.
- The `Interactor` exposed parallel semantic methods.
- Each platform derived its own two-contact geometry.

This duplicated validation, responses, and behavior behind the three public surfaces: CLI, Node.js, and MCP.

Two-contact geometry also differed by platform.
Android used a fixed radius, while Apple derived a radius from the app frame.
Neither path validated every planned point against the active interaction viewport before injection.

`scroll` remains a separate command because it owns viewport/edge traversal and content-state verification, not a single physical gesture.
Its Android physical movement still lowers to the Android planned-touch executor.

## Decision

Public gesture inputs normalize once in `packages/contracts/src/gesture-normalization.ts`.
This is the explicit public compatibility boundary.
Canonical semantic intent is produced before the input enters the runtime.
These removed deprecated arguments are rejected with actionable `INVALID_ARGS` messages, not silently reinterpreted:

- Timed `swipe`.
- Timed `gesture fling`.
- `gesture rotate` `velocity`.

The private daemon wire remains free to carry compatibility-only hints that do not appear on public surfaces.
Maestro timed swipes use `internal.gestureExecutionProfile: 'endpoint-hold'` and still route through the canonical `pan` input.
This preserves the iOS fast-swipe-then-hold behavior.

The runtime plans canonical intent in `packages/contracts/src/gesture-plan.ts`.
Contact topology is separate from motion:

- One contact: pan, fling, or target-authored drag with a complete pointer trajectory and an explicit execution profile.
- Two contacts: pan, pinch, rotate, or transform with two complete, synchronized trajectories.

Public `swipe` without a duration remains an alias for a fixed-duration fling.
These timed public forms are rejected:

- `swipe x1 y1 x2 y2 durationMs`.
- `gesture fling direction x y distance durationMs`.
- `gesture swipe preset durationMs`.
- `gesture rotate degrees x y velocity`.

For deliberate timed translation, callers must use `gesture pan`.
For rotation, callers must use `gesture rotate` without `velocity`.
Maestro-authored swipes normalize to the canonical `pan` input (origin, delta, durationMs).
They carry the `endpoint-hold` execution profile through a daemon-internal compatibility seam (`internal.gestureExecutionProfile`).
This preserves the iOS fast-swipe-then-hold behavior that matches Maestro's XCTest driver.
The public command surface does not expose the profile.
If the duration is omitted, Maestro materializes its 400 ms default.
A genuine public `pan` uses the `timed-pan` profile.
Thus, compatibility-only paths retain their release behavior and do not become a new semantic intent.

Each intent fixes some plan components:

- Pinch fixes translation and rotation at zero.
- Rotate fixes translation at zero and scale at one.
- Two-finger pan fixes scale at one and rotation at zero.
- Transform can apply all three components atomically.

Intent remains on the plan even when aliases share an executor.

The planner owns deterministic multi-touch geometry.
Contacts start at -90 degrees, except that Android pinch starts horizontally.
The reason is that common vertical app scroll containers capture a vertical pinch before the pinch recognizer activates.
The same explicit planning profile preserves the proven frame-count convention for dense two-contact trajectories.
Android rounds the duration/16 ms frame count.
Apple truncates it.
The Android transport lowerer uses that same Android sampling profile for one-contact endpoint plans.
These are planner inputs, not adapter-generated trajectories.

For pinch, the larger of the initial and final spans is 40% of the viewport's shorter side.
This preserves the proven Apple pinch geometry.
Other two-contact intents use 25% to keep translation and rotation trajectories compact.
The requested scale determines the other span.
Both spans must satisfy a 48-point reliability floor.
Combined transforms progress translation, scale, and rotation together inside one uninterrupted two-contact sequence.
Thus, recognizers observe every intent, and no adapter regenerates geometry.
The planner does not clamp points, cache the viewport, or distort the requested components.
Every injected sample must fit the freshly resolved active-app interaction viewport.
Otherwise, the request fails before injection with `GESTURE_TRAJECTORY_OUT_OF_BOUNDS` and actionable details.
Span and angle remain internal because no established automation use case justifies a public tuning surface.

Platform adapters consume the canonical plan:

- **Android.** The `executeAndroidTouchPlan` adapter seam sends planned touch.
  Planned touch includes gesture plans and the physical movement for scroll and long-press.
  If provider-native touch injection is available, the seam sends planned touch to it.
  Otherwise, the seam sends planned touch to the bundled instrumentation helper.
  `packages/platform-android/src/touch-plan-lowering.ts` lowers one-contact endpoint plans to approximately 16 ms transport samples before either injection path.
  Controlled directional scrolls accelerate for one frame, then decelerate through release within the requested duration.
  They do not append a tail.
  Inertial scrolls and general one-contact plans retain linear interpolation.
  Two-contact plans retain their exact planned samples.
  Easing reduces release momentum but does not guarantee an exact content offset.
  Transport samples are typed as strictly denser than the canonical endpoint pair.
  Thus, a skipped lowering is a type error at the injection seams, not a silently sparse gesture.
  A stationary long-press needs no viewport on the helper path.
  The executor adds the paired provider-owned viewport only for provider-native touch.
  Android touch execution never falls back to `adb input swipe`.
  Public scroll durations below one 16 ms planner frame normalize to that physical minimum and report the executed duration.
  Scroll evidence reports absolute injected coordinates against zero-origin extents that include the viewport offset.
  Android permits only one instrumentation owner of `UiAutomation`.
  Snapshot capture, gesture viewport resolution, and planned-touch injection therefore share one bundled automation helper.
  A live persistent helper session executes touch commands directly.
  Without a live session, the same helper runs one-shot.
  Gestures do not stop or restart the snapshot session (amended 2026-07, issue #1275).
- **Apple.** iOS lowers one-contact endpoint-hold plans to the established fast-swipe synthesis profile.
  That profile reaches the endpoint in 100 ms, then holds there for the planned duration before it lifts.
  This matches Maestro's XCTest driver.
  An endpoint-hold plan is linear and therefore carries only its start and end samples, with the authored duration between them.
  Two-contact plans convert every planned point to native orientation and send the exact arrays to the private XCTest event bridge.
  macOS lowers a one-contact plan to its drag executor.
  tvOS lowers a one-contact plan to remote direction.
  Core admission and the Apple adapter both consume the same shared multi-touch support policy.
  Multi-touch is capability-gated to iOS and iPadOS, on simulators and physical devices, through the XCTest runner.

  iOS deliberately retains three one-contact motion schedules behind the shared private-XCTest event bridge.
  Apple's public drag API models the phases independently as an [initial hold, movement velocity, and destination hold](https://developer.apple.com/documentation/xcuiautomation/xcuicoordinate/press%28forduration%3Athendragto%3Awithvelocity%3Athenholdforduration%3A%29).
  UIKit also reports the finger-up velocity together with the scroll view's predicted [resting content offset](https://developer.apple.com/documentation/uikit/uiscrollviewdelegate/scrollviewwillenddragging%28_%3Awithvelocity%3Atargetcontentoffset%3A%29).
  UIKit then applies the scroll view's configured [post-lift deceleration rate](https://developer.apple.com/documentation/uikit/uiscrollview/decelerationrate-swift.property).
  The distribution of movement over time is therefore observable gesture input, not an adapter implementation detail.

  The three schedules shape that velocity differently:

  - `endpoint-hold` moves quickly for 100 ms and becomes stationary before lift.
  - `timed-pan` and target-authored drag submit the authored samples unchanged.
    They preserve piecewise-linear movement plus explicit source and destination holds.
  - The runner's fused `scroll` reuses `endpoint-hold` for inertial release.
    For controlled release, the fused `scroll` instead expands the movement to evenly spaced samples, one per approximately 16 ms, capped at 30.
    Controlled release uses cubic ease-out `s(t) = 1 - (1 - t)³`.

  A linear segment has constant movement velocity through its endpoint, unless a destination hold follows it.
  Cubic ease-out decelerates from the first movement and has zero slope at lift.
  Its starting velocity is three times its average.
  Thus, identical endpoints and total durations can produce different recognizer and deceleration outcomes.
  Neither a destination hold nor an analytically zero endpoint slope proves a controlled release by itself.
  XCTest event sampling and app recognizer thresholds can still leave observable post-lift motion.
  Live evidence must therefore measure the resulting content offset after pointer-up.

  Live iOS characterization in [issue #1586](https://github.com/callstack/agent-device/issues/1586) compared an eased sampled schedule with the linear schedules.
  It confirmed that distinction.
  In the tested range, the schedules crossed the same fling-recognizer thresholds.
  However, they produced materially different post-release ScrollView positions and long-duration recognition behavior.
  This distinction is intentional policy at the Apple adapter boundary, not a second interpretation of a `GesturePlan`.
  Changes require live evidence for both recognizer activation and post-release content movement.
- **WebDriver.** WebDriver lowers a supported plan to synchronized W3C pointer action sources.
  A one-contact endpoint plan becomes pointer down, one timed W3C `pointerMove` from start to end, and pointer up.
  The driver owns interpolation across that W3C tick.
  Multi-touch remains capability-gated until a provider proves it.

The `Interactor` and backend expose one compositional `performGesture(plan)` primitive instead of one method per semantic alias.
The old scalar Apple and Android multi-touch executors are deleted.
The public-command alias-to-positionals-to-reparse route is also deleted.
`.ad` keeps its established positional syntax through one named codec.
CLI, Node.js, and MCP send structured input.
Providers should compose transport/device bindings with the shared platform adapter instead of a reimplementation of the interaction runtime.

That `.ad` codec is the script format's own syntax, not a compatibility shim.
It is not scheduled for removal (amended 2026-07, issue #1216).
Its callers include the CLI argv parse, the `.ad` line parse, and the recording path.
`packages/daemon/src/execution/interaction/internal/interaction-gesture.ts` encodes gesture inputs for recordings.
`packages/daemon/src/core/session-script-writer.ts` decodes recorded drag endpoints.
`packages/replay-port/src/daemon-port/target-token.ts` decodes drag endpoints to select the replay target token.
`packages/daemon/src/core/session-script-active-publication.ts` decodes drag endpoints to validate target evidence before script publication.
These are current syntax and recording consumers, so nothing is left to migrate off.
A structured `.ad` gesture payload was rejected.
It would make recordings unreadable and impossible to search with grep, for no behavioral gain.

One table, `PUBLIC_GESTURE_SYNTAX`, defines argument arity for both parsers.
Thus, a form removed from the CLI is removed from `.ad` in the same edit.
If a `.ad` script still carries a removed positional, the script fails when it is parsed.
This failure occurs before the replay executes any device action.
The error names the offending line and its rewrite.
Arity is the only thing checked at parse time.
`${VAR}` tokens resolve after planning, and interpolation never splits a token.
Thus, the count is decidable at parse time, but the values are not.
These inputs follow a removal process.
The public [gesture migration guide](https://oss.callstack.com/agent-device/docs/migrating-gestures) documents it:

1. Announce the removal.
2. Warn for one minor release.
3. Publish the migration guide.
4. Prove that the repository is clean.
5. Remove the branch and its tests.

Repeated coordinate swipes are bounded at the public command contract and at the daemon trust boundary.
Individual count and pause limits prevent pathological fields.
The combined planned gesture and pause schedule must fit within 60 seconds.
Thus, valid fields cannot compose into an unbounded session lock.

Public two-finger pan is additive: `pointerCount?: 1 | 2` on pan, and CLI `--pointer-count 2`.
Omission remains one contact.
Responses share the canonical `kind`, `durationMs`, `pointerCount`, `from`, and `to` fields, followed by backend evidence.
Recording/replay keeps its existing public command identity and session semantics.

Target-authored drag is additive: `gesture drag <source> <destination>`.
Each endpoint accepts a selector or a pinned snapshot ref.
Both endpoints resolve before device injection.
Their center points then lower to one uninterrupted single-pointer plan:

1. Hold at the source.
2. Move over the authored duration.
3. Optionally, hold at the destination.
4. Release.

Both endpoint-resolution disclosures and portable selector chains are returned to the caller.
Recordings replace session-local refs at both endpoints with those selector chains.
Recordings also attach one `targets-v1` annotation that contains independent source and destination identity evidence.
Before pointer-down, replay verifies both identities.
Replay also guards both independent endpoint resolutions against the verified elements.
Ref admission happens for both endpoints before either endpoint is dispatched.
After the gesture, the usual mutation boundary expires the frame.
This contract includes the source hold, timed movement, and destination hold phases.
Thus, target-authored drag is admitted only on Android touch devices and iOS/iPadOS, whose adapters preserve the full plan.

ADR 0011's coordinate path remains unchanged.
Coordinate-authored gestures do not resolve selectors or refs and therefore cannot claim element-targeting guarantees.
Before it enters the coordinate gesture executor, target-authored drag explicitly runs the shared selector/ref resolution preflight.
Its endpoint resolution and recording contracts are tested at that composition seam.

## Consequences

- CLI, Node.js, MCP, runtime, and platform adapters share one normalization and planning model.
- A new ergonomic gesture alias does not add a platform implementation.
- One-finger pan remains the default, and explicit two-finger pan retains pan intent.
- The active viewport is resolved for each gesture.
  Rotation, keyboard, and window changes therefore do not use stale geometry.
- On bare ADB, Android scroll and long-press require the bundled automation helper, which is the snapshot helper APK, and `UiAutomation`.
  Helper installation or runtime failure is surfaced directly.
  It does not degrade to an approximate `adb input swipe`.
- Canonical one-contact plans contain only two samples.
  A 10-second pan therefore has two shared-plan samples instead of 626.
  Android expands that plan only at the transport boundary.
  Two-contact plans remain cadence-bounded because their synchronized geometry is part of their contract.
- Unit tests cover canonical plan shape, Android lowering, helper/provider payloads, and WebDriver action construction.
  They cannot prove timing or event delivery inside the private XCTest bridge.
  iOS timing changes therefore require live simulator evidence from an independent app-observed postcondition.
  Runner start/end uptime deltas can supplement that evidence.
  Request echoes or internal timing alone do not prove that the app recognized the intended gesture.

## Alternatives Considered

- **Keep positional aliases and share only geometry math.** Rejected because validation, response, and routing would still have two implementations.
- **Make platform gesture APIs the source of truth.** Rejected because their timing, geometry, and recognizer behavior differ and cannot provide cross-platform semantics.
- **Make swipe a public synonym for pan.** Rejected because established gesture vocabulary treats a fling/swipe as a quick directional throw and pan as deliberate timed translation.
- **Add `two-finger-pan`.** Rejected because pointer count is topology, not a new motion intent.
- **Expose span/angle controls.** Rejected until a concrete automation use case needs them.
- **Consolidate scroll command semantics.** Rejected because edge/content verification is distinct.
  Only its Android physical touch execution is shared.
