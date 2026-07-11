# ADR 0013: Unified Gesture Plans

## Status

Accepted

## Context

Gesture intent was represented repeatedly across the public command surface, daemon positional
aliases, the `Interactor`, and platform adapters. The public `gesture` command expanded into an
internal command name and positional strings, then platform dispatch parsed those strings again.
The portable runtime owned swipe and pinch while the local daemon bypassed that runtime for pan,
fling, rotate, and transform. This left two validation/response paths and made it easy for semantic
aliases to drift.

Two-contact geometry also differed by platform. Android used a fixed radius and a horizontal pinch
axis while Apple derived a radius from the active frame and started its transform path at -90
degrees. Neither host-side path could prove the complete pointer trajectories stayed inside the
viewport before injection.

`scroll` is intentionally different: it owns viewport/edge traversal, content-state verification,
and runner fallback policy. Folding it into touch-trajectory planning would erase those semantics.

## Decision

Represent every coordinate gesture as a typed semantic input and normalize it through
`src/core/gesture-plan.ts`. A plan separates contact topology from motion:

- one contact: swipe, pan, or fling intent plus its trajectory and duration;
- two contacts: pan, pinch, rotate, or transform intent plus centroid translation, scale, rotation,
  duration, initial span, initial angle, and both complete pointer trajectories.

Semantic intent remains present even when two aliases share the same physical synthesizer. Pinch
always plans zero translation and zero rotation; rotate always plans zero translation and scale 1;
two-finger pan always plans scale 1 and zero rotation; transform may combine all three components.

The planner owns deterministic multi-touch geometry. It starts contacts at -90 degrees, prefers a
maximum radius equal to one eighth of the viewport's shorter side (close to the proven Android helper's
historical 160 px radius on a 1344 px-wide emulator), and reduces the unspecified internal span
only as needed to fit the requested path. It never clamps individual points or changes requested
translation, scale, or rotation. A plan whose reliable minimum span cannot fit fails before platform
dispatch with `INVALID_ARGS`, reason `GESTURE_TRAJECTORY_OUT_OF_BOUNDS`, the viewport/path details,
and a recovery hint. Span and initial angle remain internal because no established automation use
case justifies public tuning.

Both native platforms consume the planned points while preserving their proven injection machinery:

- Android keeps provider-native injection first and the bundled instrumentation helper second.
  Providers receive the canonical paths. The local helper retains its proven semantic pinch and
  rotate requests while deriving center, span, scale, rotation, and duration from the canonical
  plan; Android's recognizers do not reliably activate for the otherwise equivalent sampled helper
  streams. A
  two-contact plan never broadens to `adb input swipe`; issue #690 separately owns the legacy
  one-contact swipe fallback. Local planning resolves the viewport from display geometry without
  starting accessibility capture. Before local helper injection, it stops the persistent snapshot
  helper because Android permits only one instrumentation owner of `UiAutomation`; snapshots restart
  that helper lazily after the gesture. Provider-native injection is unaffected.
- Apple keeps the private XCTest two-pointer path executor. Unsupported Apple OS/device-kind
  contracts remain capability-gated and return actionable errors.

Public two-finger pan is additive: `pointerCount?: 1 | 2` on the pan variant and Node convenience API,
with CLI `--pointer-count 2`. Omission means one contact. The existing repetition `count` field is not
reused.

The daemon request wire gains an optional structured gesture input. This is additive under ADR 0006
and removes the alias-to-positionals-to-reparse path while preserving the cross-process invoke seam
from ADR 0008. Recording/replay keeps the public `gesture` identity and user-facing arguments.

ADR 0011's element dispatch-path matrix remains unchanged: coordinate gestures do not resolve
selectors or refs and therefore must not claim element-targeting guarantees. This ADR is the sibling
contract for gesture planning and native execution.

## Consequences

- CLI, Node, MCP, daemon, portable runtime, and platform adapters share one semantic validation and
  planning model.
- One-finger pan remains the default; an explicit two-finger pan is discoverable without adding a
  second public command.
- Pinch, rotate, two-finger pan, and transform share geometry while remaining distinguishable to
  providers, diagnostics, responses, and app recognizers.
- Android's pinch contact axis becomes the shared -90-degree axis. This is a physical-path
  normalization; pinch semantics remain unchanged and are protected by recognizer-level regression
  coverage.
- The planned trajectory payload is larger than scalar transform parameters, bounded by the gesture
  duration and 16 ms cadence. In return, native executors stop independently inventing geometry and
  bounds behavior.

## Alternatives Considered

- Keep the positional aliases and only share helper math: rejected because validation, response, and
  routing would still have two behavioral implementations.
- Add a separate `two-finger-pan` command: rejected because contact count is a topology option on pan,
  not a new motion intent.
- Expose span/angle controls: rejected until a concrete automation case needs them; exposing geometry
  policy now would freeze an unexplained public contract.
- Consolidate scroll too: rejected because scroll's edge/content verification and fallback policy are
  materially different.
