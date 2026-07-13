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

Public gesture inputs normalize once in `src/contracts/gesture-normalization.ts`. This is the
explicit compatibility boundary: convenience APIs and deprecated arguments become canonical
semantic intent before entering the runtime. The private daemon wire is free to evolve with that
model; compatibility is owed at CLI, Node.js, and MCP.

The runtime plans canonical intent in `src/contracts/gesture-plan.ts`. Contact topology is separate
from motion:

- one contact: pan or fling with a complete pointer trajectory;
- two contacts: pan, pinch, rotate, or transform with two complete, synchronized trajectories.

`swipe` is public sugar for a fixed-duration fling. Its historical optional duration remains a
thin compatibility alias to pan and reports a deprecation. The same rule applies to the historical
fling duration. Pinch fixes translation and rotation at zero; rotate fixes translation at zero and
scale at one; two-finger pan fixes scale at one and rotation at zero; transform can apply all three
components atomically. Intent remains on the plan even when aliases share an executor.

The planner owns deterministic multi-touch geometry. Contacts start at -90 degrees, except Android
pinch starts horizontally because a vertical pinch is captured by common vertical app scroll
containers before the pinch recognizer activates. The same explicit planning profile preserves the
proven frame-count convention: Android rounds while Apple truncates the duration/16 ms frame count.
These are planner inputs, not adapter-generated trajectories. The larger of pinch's initial and final spans is 40% of the
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
  available, otherwise to the bundled instrumentation helper. The helper injects the exact planned
  pointer samples. A stationary long-press needs no viewport on the helper path; the executor adds
  the paired provider-owned viewport only for provider-native touch. Android touch execution never
  falls back to `adb input swipe`. Public scroll durations below one 16 ms planner frame normalize
  to that physical minimum and report the executed duration. Scroll evidence reports absolute
  injected coordinates against zero-origin extents that include the viewport offset. The snapshot helper is stopped
  before local gesture instrumentation because Android permits only one instrumentation owner of
  `UiAutomation`.
- iOS converts every planned point to native orientation and feeds the exact arrays to the existing
  private XCTest event bridge. macOS lowers a one-contact plan to its drag executor and tvOS lowers
  it to remote direction. Core admission and the Apple adapter both consume the same shared
  multi-touch support policy; multi-touch remains capability-gated to iOS simulators.
- WebDriver lowers a supported plan to synchronized W3C pointer action sources. Multi-touch remains
  capability-gated until a provider proves it.

The `Interactor` and backend expose one compositional `performGesture(plan)` primitive instead of a
method per semantic alias. The old scalar Apple and Android multi-touch executors and the
public-command alias-to-positionals-to-reparse route are deleted. `.ad` keeps its established
positional syntax through one named replay compatibility codec; CLI, Node.js, and MCP send
structured input. Providers should compose transport/device bindings with the shared platform
adapter rather than reimplement the interaction runtime.

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
- On bare ADB, Android scroll and long-press require the bundled touch helper and `UiAutomation`;
  helper installation or runtime failure is surfaced directly rather than degrading to an
  approximate `adb input swipe`.
- Pointer plans are larger than scalar requests but bounded by duration and the 16 ms sample
  cadence; deleting duplicate scalar executors offsets the package cost.

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
