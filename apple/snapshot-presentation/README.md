# Snapshot presentation

`AgentDeviceSnapshotPresentation` is the Swift presentation engine that the XCTest runner uses before the process boundary.
The host engine in `@agent-device/capture-kit` presents bridge acquisitions in TypeScript.
The two engines are separate implementations.
Shared fixtures under `contracts/fixtures/` are the proof that they agree.
[ADR 0004](../../docs/adr/0004-ios-snapshot-backend-strategy.md) records the decisions.
This document states the contracts that the code alone does not show.

## Acquisition and presentation

Acquisition backends construct `RawAXNode`.
Only `SnapshotPresentation` constructs `PresentedNode`.
Response payloads accept only presented nodes.
Every capture-plan backend returns a `SnapshotAcquisition`, and one `SnapshotPresentation.present` call presents it.

Acquisition backends are fact serializers.
They emit every traversed node at raw traversal depth with its reported frame.
`SnapshotAcquisition` carries the viewport.

`SnapshotPresentation.captureHint` derives a `CaptureHint` from the request.
Backends read the hint and never read `PresentationOptions`.
A hint names the projection that the acquisition must serve.
A hint narrows acquisition only where the backend can prove the narrowing complete for that projection.
Scope and its relative depth never narrow acquisition.
Raw depth narrows acquisition, because raw depth is traversal depth.

## Projections

`presentRegular` folds visibility, eligibility, scope, and scroll hints.
`presentRaw` returns the acquired tree, normalized.
`presentRaw` applies scope and depth only when the request asks for them.
The raw projection never carries `interactiveOnly`.
Thus, `interactive ⊆ regular ⊆ raw` holds for each backend.
`snapshot --raw -i` returns the acquired tree, not an interactive-filtered tree.

Presentation compares the requested projection with the hint that the acquisition used.
If they differ, presentation drops that tier with a structured `IOS_SNAPSHOT_PROJECTION_MISMATCH` failure.
This rule stops a recovered `snapshot --raw` from returning viewport-pruned nodes with the raw label.

## Regular eligibility

The top-level viewport carrier always survives.
Every other node needs an interactive accessibility type, or a non-empty label, identifier, or value.
Hittability does not admit an otherwise ineligible node.
Raw membership does not change.
This rule is runner eligibility, not daemon publication membership.
Daemon compaction keeps its declared noise suppressions.
When eligibility removes a structural wrapper, presentation reparents its surviving descendants to the nearest surviving ancestor.
Presentation then normalizes their indexes and depths.

## Scope

A trimmed non-empty scope selects the first presentation-preorder match whose subtree contributes to the requested projection.
The match examines label, identifier, and value, without case.
Presentation re-roots the selected subtree, and depth applies relative to that root.
If no node matches, presentation publishes an empty healthy projection.
`contracts/fixtures/snapshot-scope-policy.json` pins the Swift and TypeScript implementations.
Scoped iOS acquisition stays broad, also when depth is requested.
The daemon never applies scope again after the wire.
Android selects its root inside its TypeScript presentation.
Desktop surface runtimes keep their platform projection.

## Visibility fold

For every backend, `presentRegular` runs one visibility interpreter:

- The viewport ∩ scroll-container clip.
- The ancestor projection cursor.
- The sub-pixel decoration rule.
- Hidden-content hints (`hiddenContentAbove`, `hiddenContentBelow`) on scroll anchors.
- Reparenting of survivors with collapsed depth.

A node in a scroll container is visible only if it intersects the app viewport and the nearest visible scroll container.
Presentation visits offscreen descendants to set hidden-content hints, but it does not emit them as visible nodes.
With the cursor, an out-of-clip cell or scroll container hides descendants whose clamped frames would otherwise come back into the viewport.
The fold narrows the emitted `hittable` to the clip.
A node outside its clip, or a node without geometry, is never hittable.
Platform differences are a `SnapshotFoldPolicy` input to the shared algorithm, never a backend exception.
iOS uses the projection cursor.
macOS and tvOS use plain viewport intersection.

The fold returns a typed carrier with reported geometry and effective geometry.
`raw.rect` stays runner-internal reported geometry.
Regular presentation writes the effective rectangle through the wire `rect` field.
Raw projections and direct single-element reads keep reported geometry.

## Cumulative clip

Before presentation constructs a `PresentedNode`, it validates every framed regular node against its cumulative effective clip.
Frameless and degenerate semantic carriers stay eligible, but they are never actionable.
The raw projection is exempt.
Presentation clips acquired overflow to the cumulative visible area.
Presentation omits framed elements that are fully outside.
The result carries one aggregated `regular-geometry-clipped` quality note with the clipped and dropped node counts.
The capture publishes clipping notes as `snapshotQualityNotes`, independently of the capture verdict.
A producer without a capture verdict does not get an invented state or backend.
Clipping does not change a healthy capture into a recovered or sparse capture.
The blocking system-modal probe uses this presenter.
Raw system-modal captures keep reported geometry.
A violation in already-presented geometry stays a typed `IOS_SNAPSHOT_PRESENTATION_FAILED` failure with the `presentation-failed` snapshot-quality reason.

## Viewport

In the runner, the viewport is a declared fact, not a rectangle.
`SnapshotViewport` has the cases of the host's `IosViewportEvidence`:

- `reported(box, interfaceOrientation)`.
- `derived(box)`.
- `missing(reason)`.

Only `reported` carries an orientation, so only `reported` can anchor a rotation.
If the viewport has no box, presentation skips the clip.
If the viewport has no box, a node whose actionability depends on containment has no wire `hittable`.
Disabled or degenerate nodes stay `false`.
A rectangle becomes a `Box` only through the initializer that checks it.
The Swift guard and the TypeScript guard both refuse `CGRect.infinite` by identity, and finite components whose right or bottom edge overflows.
The components of `CGRect.infinite` are finite, so no range comparison catches it.
The runner route reads host evidence from the payload's root nodes (`resolveIosViewportEvidenceFromRoots` in `packages/capture-kit/src/ios-snapshot-acquisition.ts`).
`contracts/fixtures/snapshot-actionability-policy.json` pins the predicate for shapes that the fold fixture cannot reach.

## Depth

A regular `--depth` request is a presentation cut, not an acquisition bound.
`CaptureHint` keeps raw traversal depth (`--raw --depth`) separate from regular presented depth.
The recursive tree walk reads no geometry and no presented depth while it descends.
A runaway node cap bounds the walk.
Presentation applies the visibility fold and the presented-depth cut on the normalized array, at `maximumDepth`.
The walk must not read geometry, because the coordinate-space pass runs after the walk and a turned subtree would get a cut at the wrong depth.

Backend capability declarations state how much acquisition work a regular depth request bounds.
They never state whether a backend may answer the request.
The recursive tree and private AX enumerate their hierarchy, and presentation cuts it afterwards (`presentation-cut`).
The flat query sweep has only its root and one presented level, so a cut past depth 1 returns it unchanged (`flat`).
A depth-capped regular capture discloses completeness through `truncated` and `effectiveDepth`, the same as an unscoped capture.
A refusal of a depth request gave no answer at all (#2403).
Raw depth stays acquisition depth for every backend.

De-duplication drops a repeated node and reparents its children onto the parent of the dropped node.
Thus, identical rows collapse under one addressable owner.

## Coordinate space

One published capture publishes one space: the app's orientation space.
`SnapshotGeometrySpace.normalized` settles the space in one pass over the flat acquired array, in `captureWithBackend`, between acquisition and presentation.
The pass keys on each node's `type`, `parentIndex`, and `rect`.
A window declares the space of its own subtree from its own box.
That box is the app's box, or that box turned through a quarter.
A node that is not a window inherits the space of the window above it.
A published rect and the actionability verdict read from it come from the same oriented frame.

The capture publishes reported geometry when no space can be named:

- No usable app frame exists.
- The platform did not report an interface orientation.
- The app frame is too close to square to tell it from its own quarter turn.

Consumers fail open on that geometry.

`SnapshotCoordinateSpace.swift` holds one rotation table that capture shares with synthesized dispatch.
Both languages replay it against `contracts/fixtures/window-coordinate-space.json`.
Thus, capture turns back with the exact inverse of what dispatch turns forward.

The query-sweep tier has no window ancestry, so its tree publishes as reported.
`appium-source` sees no app windows, publishes no keyboard fact, and publishes as reported.
For those producers, the tap-path keyboard guard in `packages/contracts/src/tap-keyboard-occlusion.ts` keeps its width rule.
A band taller than it is wide is the output of a producer that did not normalize.
The runner's recursive tree reads the keyboard band from `app.keyboards` in the app's orientation space (#2660).

### Placed windows

A placed iPad window publishes screen space in points.
`SnapshotContentTranslation.offset` is the one rule, in the same normalization pass.
A carrier declares an offset only when its box is a `(0,0)`-anchored copy of the reported viewport box and the viewport starts elsewhere.
The offset is the viewport origin.
Every other carrier keeps its frames, so screen-space system windows do not move.
A full-screen window, an iPhone, and each foldable panel start at `(0,0)`, so they publish unchanged.
The fixture replays this rule in Swift only, because the bridge refuses a windowed tree before the host decoder reads one.

`CoordinateSpaceRotation` turns axes and never moves an origin.
A synthesized turn swaps the side lengths of the sole display, as the digitizer does.
A multi-screen host keeps the window box of its panel.

## Modal containment

The fold applies modal containment when these conditions are all true:

- The last transition view under a container has UIKit's dimming view as its direct child.
- The producer reports that the dimming view takes touches (`userInteractionEnabled: true`).

Then the fold removes the earlier transition views whose frame the dimmed area spans, with their subtrees, from the regular and interactive projections.
These cases keep the earlier behavior:

- A presentation with no dimming view.
- A dimming view that the producer did not read.
- A dimming view that the producer reports as passing touches through.
- A container whose earlier sibling is not a transition view.

The interaction state is part of the claim because a sheet at an undimmed detent keeps a window-sized dimming view and the presenting screen stays reachable.
UIKit `largestUndimmedDetentIdentifier` and react-native-screens `sheetLargestUndimmedDetentIndex` configure such a detent.
`XC_kAXXCAttributeIsVisible` cannot tell the two cases apart.
`stats.modalContainedNodeCount` counts every node that the cut removes.
Per ADR 0026, that count is internal evidence, never wire vocabulary.
A scope that names a modal-contained screen publishes an empty projection.

Producers that report no UIKit class names or no dimming-view interaction state never trigger the cut.
The runner already omits modal-contained content from its queries.
`appium-source` reports element types and no classes.
The macOS desktop surface arrives already presented.

