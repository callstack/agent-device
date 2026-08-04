# ADR 0013: Unified Gesture Plans

## Status

Accepted

## Context

Gesture intent was previously interpreted at several private boundaries: command aliases produced
positional strings, daemon dispatch reparsed them, the `Interactor` exposed parallel semantic
methods, and each platform derived its own two-contact geometry. That duplicated validation,
responses, and behavior behind the three public surfaces: CLI, Node.js, and MCP.

Two-contact geometry also differed by platform. Android used a fixed radius while Apple derived a
radius from the app frame. Neither path validated every planned point against the active
interaction viewport before injection.

`scroll` remains a separate command because it owns viewport/edge traversal and content-state
verification rather than a single physical gesture. Its Android physical movement still lowers to
the Android planned-touch executor.

## Decision

Public gesture inputs normalize once in `packages/contracts/src/gesture-normalization.ts`. This is the
explicit public compatibility boundary: canonical semantic intent is produced before entering the
runtime. Deprecated arguments that have been removed (timed `swipe`, timed `gesture fling`,
`gesture rotate` `velocity`) are rejected with actionable `INVALID_ARGS` messages rather than
silently reinterpreted. The private daemon wire remains free to carry compatibility-only hints
that do not appear on public surfaces; Maestro timed swipes use
`internal.gestureExecutionProfile: 'endpoint-hold'` to preserve iOS fast-swipe-then-hold behavior
while still routing through the canonical `pan` input.

The runtime plans canonical intent in `packages/contracts/src/gesture-plan.ts`. Contact topology is separate
from motion:

- one contact: pan or fling with a complete pointer trajectory and an explicit execution profile;
- two contacts: pan, pinch, rotate, or transform with two complete, synchronized trajectories.

`swipe` without a duration remains public sugar for a fixed-duration fling. Timed public forms
(`swipe x1 y1 x2 y2 durationMs`, `gesture fling direction x y distance durationMs`,
`gesture swipe preset durationMs`, and `gesture rotate degrees x y velocity`) are rejected; callers
must use `gesture pan` for deliberate timed translation and `gesture rotate` without `velocity`.
Maestro-authored swipes normalize to the canonical `pan` input (origin, delta, durationMs) and carry
the `endpoint-hold` execution profile through a daemon-internal compatibility seam
(`internal.gestureExecutionProfile`). This preserves the iOS fast-swipe-then-hold behavior that
matches Maestro's XCTest driver, without exposing the profile on the public command surface. Maestro
materializes its 400 ms default when duration is omitted. A genuine public `pan` uses the `timed-pan`
profile, so compatibility-only paths retain their release behavior without becoming a new semantic
intent. Pinch fixes translation and rotation at zero; rotate fixes
translation at zero and scale at one; two-finger pan fixes scale at one and rotation at zero;
transform can apply all three
components atomically. Intent remains on the plan even when aliases share an executor.

The planner owns deterministic multi-touch geometry. Contacts start at -90 degrees, except Android
pinch starts horizontally because a vertical pinch is captured by common vertical app scroll
containers before the pinch recognizer activates. The same explicit planning profile preserves the
proven frame-count convention for dense two-contact trajectories: Android rounds while Apple
truncates the duration/16 ms frame count. The Android transport lowerer uses that same Android
sampling profile for one-contact endpoint plans. These are planner inputs, not adapter-generated
trajectories. The larger of pinch's initial and final spans is 40% of the
viewport's shorter side, preserving the proven Apple pinch geometry; other two-contact intents use
25% to keep translation and rotation trajectories compact. The other span follows from the requested scale, and both must
satisfy a 48-point reliability floor. Combined transforms progress translation, scale, and rotation
together inside one uninterrupted two-contact sequence so recognizers observe every intent without an
adapter regenerating geometry. The planner does not clamp points, cache the viewport, or distort
the requested components. Every injected sample must fit the freshly resolved active-app
interaction viewport; otherwise the request fails before injection with
`GESTURE_TRAJECTORY_OUT_OF_BOUNDS` and actionable details. Span and angle remain internal because
no established automation use case justifies a public tuning surface.

Platform adapters consume the canonical plan:

- Android's `executeAndroidTouchPlan` adapter seam sends planned touch, including gesture plans plus
  the physical movement for scroll and long-press, to provider-native touch injection when
  available, otherwise to the bundled instrumentation helper. One-contact endpoint plans lower in
  `src/platforms/android/touch-plan.ts` to 16 ms linear transport samples before either injection
  path; two-contact plans retain their exact planned samples. A stationary long-press needs no
  viewport on the helper path; the executor adds the paired provider-owned viewport only for
  provider-native touch. Android touch execution never falls back to `adb input swipe`. Public
  scroll durations below one 16 ms planner frame normalize to that physical minimum and report the
  executed duration. Scroll evidence reports absolute injected coordinates against zero-origin
  extents that include the viewport offset. Because Android permits only one instrumentation owner
  of `UiAutomation`, snapshot capture, gesture viewport resolution, and planned-touch injection
  share one bundled automation helper: a live persistent helper session executes touch commands
  directly, and without one the same helper runs one-shot. Nothing stops the snapshot session
  around gestures anymore (amended 2026-07, issue #1275; previously a separate one-shot
  multi-touch helper forced a session stop/restart around every local gesture).
- iOS lowers one-contact endpoint-hold plans to the established fast-swipe synthesis profile. That
  profile reaches the endpoint in 100 ms, then holds there for the planned duration before lifting,
  matching Maestro's XCTest driver. One-contact plans are linear and therefore carry only their
  start and end samples, with the authored duration between them. Two-contact plans convert every
  planned point to native orientation and feed the exact arrays to the private XCTest event bridge.
  macOS lowers a one-contact plan to its drag executor and tvOS lowers it to remote direction. Core
  admission and the Apple adapter both consume the same shared multi-touch support policy;
  multi-touch remains capability-gated to iOS simulators.
- WebDriver lowers a supported plan to synchronized W3C pointer action sources. A one-contact
  endpoint plan becomes pointer down, one timed W3C `pointerMove` from start to end, and pointer up;
  the driver owns interpolation across that W3C tick. Multi-touch remains capability-gated until a
  provider proves it.

The `Interactor` and backend expose one compositional `performGesture(plan)` primitive instead of a
method per semantic alias. The old scalar Apple and Android multi-touch executors and the
public-command alias-to-positionals-to-reparse route are deleted. `.ad` keeps its established
positional syntax through one named codec; CLI, Node.js, and MCP send structured input. Providers
should compose transport/device bindings with the shared platform adapter rather than reimplement
the interaction runtime.

That `.ad` codec is the script format's own syntax, not a compatibility shim, and is not scheduled
for removal (amended 2026-07, issue #1216). Its only remaining callers are the CLI argv parse and
the `.ad` line parse — both the current public syntax — so there is nothing left to migrate off.
A structured `.ad` gesture payload was rejected: it would make recordings unreadable and ungreppable
for no behavioral gain.

Argument arity for both callers comes from one table (`PUBLIC_GESTURE_SYNTAX`), so a form removed
from the CLI is removed from `.ad` in the same edit. A `.ad` script that still carries a removed
positional fails when the script is parsed, before the replay executes any device action, with the
offending line and its rewrite. Arity is the only thing checked at parse time: `${VAR}` tokens
resolve after planning, and interpolation never splits a token, so the count is decidable while the
values are not. The removal process these inputs follow — announce, warn for one minor release,
publish the migration guide, prove the repository is clean, then remove the branch and its tests —
is documented in the public
[gesture migration guide](https://agent-device.dev/docs/migrating-gestures).

Repeated coordinate swipes are bounded at the public command contract and daemon trust boundary.
Individual count and pause limits prevent pathological fields, while the combined planned gesture
and pause schedule must fit within 60 seconds so valid fields cannot compose into an unbounded
session lock.

Public two-finger pan is additive: `pointerCount?: 1 | 2` on pan and CLI
`--pointer-count 2`; omission remains one contact. Responses share the canonical
`kind`, `durationMs`, `pointerCount`, `from`, and `to` fields, followed by backend evidence.
Recording/replay keeps its existing public command identity and session semantics.

ADR 0011's element dispatch-path matrix remains unchanged: coordinate gestures do not resolve
selectors or refs and therefore cannot claim element-targeting guarantees.

## Consequences

- CLI, Node.js, MCP, runtime, and platform adapters share one normalization and planning model.
- Adding an ergonomic gesture alias does not add a platform implementation.
- One-finger pan remains the default and explicit two-finger pan retains pan intent.
- The active viewport is resolved for each gesture, so rotation, keyboard, and window changes do
  not use stale geometry.
- On bare ADB, Android scroll and long-press require the bundled automation helper (the snapshot
  helper APK) and `UiAutomation`; helper installation or runtime failure is surfaced directly
  rather than degrading to an approximate `adb input swipe`.
- Canonical one-contact plans contain only two samples: a 10-second pan is two shared-plan samples
  instead of 626. Android expands that plan only at the transport boundary, while two-contact
  plans remain cadence-bounded because their synchronized geometry is part of their contract.
- Unit tests cover canonical plan shape, Android lowering, helper/provider payloads, and WebDriver
  action construction. They cannot prove timing or event delivery inside the private XCTest bridge,
  so iOS timing changes require live simulator evidence that observes the requested content change
  and records the runner start/end uptime delta alongside the requested duration.

## Alternatives Considered

- Keep positional aliases and share only geometry math: rejected because validation, response, and
  routing would still have two implementations.
- Make platform gesture APIs the source of truth: rejected because their timing, geometry, and
  recognizer behavior differ and cannot provide cross-platform semantics.
- Make swipe a public synonym for pan: rejected because battle-tested gesture vocabulary treats a
  fling/swipe as a quick directional throw and pan as deliberate timed translation.
- Add `two-finger-pan`: rejected because pointer count is topology, not a new motion intent.
- Expose span/angle controls: rejected until a concrete automation use case needs them.
- Consolidate scroll command semantics: rejected because edge/content verification is distinct;
  only its Android physical touch execution is shared.
