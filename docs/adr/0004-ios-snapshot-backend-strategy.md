# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted. Amended after iOS snapshot capture was simplified to two public modes:
regular interactive snapshots and raw diagnostic snapshots.

The current implementation is owned by `RunnerTests+SnapshotCapturePlan.swift`. Capture plans
declare their XCTest backend chain, and structured snapshot quality verdicts make degraded or
recovered output observable end to end.

## Context

Agent Device exposes iOS UI state through snapshots produced by the long-lived XCTest runner. The
runner has two durable snapshot needs:

- agent-facing regular context, where the important contract is the effective user-visible UI,
  fixed controls such as tab bars, and scroll-hidden hints for content outside visible scroll
  containers;
- rich diagnostics and selector disambiguation, where a raw recursive XCTest snapshot is useful
  because it preserves hierarchy, static text, wrappers, scroll containers, and ancestry.

These needs should not share one capture strategy blindly. Recursive `XCUIElement.snapshot()` is
rich, but some real app trees can make XCTest fail with `kAXErrorIllegalArgument` or main-thread
timeouts while the same app remains visually usable. Bluesky is the current known example:
lower-level accessibility services can describe simulator screens even when XCTest recursive
snapshots and typed `XCUIElementQuery` enumeration degrade to no useful child nodes. Physical iOS
devices can show the same XCTest accessibility-channel timeout shape even when no lower-level
semantic backend is available.

This is different from presentation filtering. The daemon's snapshot presentation can hide noisy
or inaccessible nodes, but it cannot recover nodes that XCTest never returns. More filters,
Maestro-specific heuristics, or retries in the daemon would only make this failure slower and less
predictable.

## Decision

Keep XCTest as the default iOS automation runner and split iOS snapshot capture into explicit
strategies:

- **Regular visible strategy**: use recursive XCTest snapshots, emit the effective user-visible
  tree plus visible ancestors and scroll-hidden hints, and fall back through the capture plan when
  XCTest returns sparse output. A node inside a scroll container is user-visible only when it
  intersects both the app viewport and the nearest visible scroll container. Offscreen descendants
  should be visited to set `hiddenContentAbove` / `hiddenContentBelow`, not emitted as normal
  visible nodes. This strategy must not use an arbitrary node-count cutoff: fixed controls that are
  later in traversal order, such as bottom tab bars after long lists, are part of the visible UI
  contract.
- **Raw diagnostic strategy**: use recursive XCTest snapshots for raw snapshots, diagnostics, and
  cases that need hierarchy. Raw output is allowed to be noisy and large; if the transport cannot
  carry the response, fail explicitly instead of silently truncating the tree at a hard node count.
  If XCTest reports a real AX serialization failure, preserve that error instead of pretending the
  UI is empty.
- **Future AX-service strategy**: treat Bluesky-class failures as evidence that XCTest is
  not a complete semantic snapshot backend. A robust semantic fix should add a host-side simulator
  accessibility backend, similar in role to existing simulator accessibility inspection tools,
  and acquire its output as `RawAXNode` values. Every backend crosses the same
  `SnapshotPresentation` construction boundary before producing wire-facing `PresentedNode` values.
  That backend can be simulator-only; physical devices should use an equivalent non-XCTest semantic
  backend only if Apple exposes a supported channel.

The daemon should make degraded output observable. If an iOS interactive snapshot contains only the
application root or another sparse shape, surface a structured quality verdict and warning so
agents know the snapshot is degraded output rather than proof that the screen has no controls.

## Host-side ownership boundary

The shared TypeScript side has one snapshot-presentation facet. The neutral acquisition-to-presented
carrier and clip-fold geometry contract live in `@agent-device/contracts/snapshot-presentation`; the
host-side iOS post-wire policies and shared tree helpers live under `src/snapshot/snapshot-presentation/`.
Platform-specific presentation adapters retain only the policy mechanics that cannot yet cross their
runtime boundary. Daemon assembly owns only the ordering of capture, compaction, occlusion, and ref
publication. It does not own the presentation vocabulary or a second geometry carrier.

Android acquisition remains in its platform module and adapts its raw hierarchy to the shared
carrier. Swift keeps its runner-side `SnapshotPresentation` implementation because it consumes the
capture-plan tier before the process boundary. The contract fixture under
`contracts/fixtures/snapshot-presentation-conformance.json` is the shared proof between those
runtimes; it does not imply that Swift and TypeScript share an implementation.

This is the first ownership slice of the Wave 4 debt tracked by #1983. Freshness recovery,
timeout evidence, and screenshot-overlay policy retain their existing daemon adapters until their
neutral host seams are extracted; new consumers must use the facet rather than add another daemon
presentation path.

## Regression Notes

PR #639 made XCTest AX serialization failures explicit instead of swallowing them as empty
snapshots. That was the correct diagnostic change, but it exposed apps whose accessibility trees
XCTest cannot serialize.

Later work moved recovery into the regular visible capture plan so healthy apps keep the fast
recursive tree path while degraded app classes can still return bounded, honest output when
fallback tiers are the only available source of visible controls.

Issue #1105 showed a second failure shape on the same app class: instead of failing fast with
`kAXErrorIllegalArgument`, the recursive tree capture can grind for many seconds on
heavy/animating screens before failing, pushing the chained plan past the runner's main-thread
watchdog and burying the main queue under retries. The plan now carries its umbrella deadline
into the query-sweep and private-AX tiers (later ladder rungs stop when the budget is spent),
and a slow, timed-out, or watchdog-abandoned XCTest-backed capture penalizes the XCTest
accessibility channel for that bundle for a bounded window. Subsequent regular plans derive the
next step from backend traits (`effectiveSnapshotCapturePlan`): when a runnable non-XCTest backend
exists, they defer to that independent tier; when it does not, as on physical iOS devices today,
they run a short XCTest probe instead of the full tree slice so healthy screens can recover without
repeating the hostile-screen grind. The raw diagnostic plan is exempt — it keeps tree-first error
propagation.

## Consequences

Regular snapshots remain the right tool for agents and Maestro compatibility because they describe
what a user can currently perceive and interact with. Raw snapshots remain the right tool when
hierarchy matters. Both may still fail loudly on XCTest-broken trees; that failure is useful
because retrying the same recursive capture is unlikely to reveal a different tree.

A future AX-service backend is the correct place to regain Bluesky-class semantic coverage. It
should be added as a platform backend with its own lifecycle, protocol, normalization, timing
metrics, and fallback rules, not as another special case inside the XCTest runner.

The acquire/present migration begins with a behavior-preserving typed seam: acquisition backends
construct `RawAXNode`, `SnapshotPresentation` alone constructs `PresentedNode`, and response payloads
accept only presented nodes. Its second behavior-preserving step makes every capture-plan backend
return `SnapshotAcquisition` and routes the exhaustive backend switch through one
`SnapshotPresentation.present` call. `PresentationOptions` is the stable request-policy input to
that boundary. Until the remaining migration steps move interpretation into the boundary, acquisition
still reads those options and raw nodes intentionally carry the derived fields produced by the
existing backends.

The first semantic migration layer makes regular eligibility backend-neutral inside
`SnapshotPresentation`: the top-level viewport carrier survives, and every other node needs an
interactive accessibility type or a non-empty label, identifier, or value. Hittability no longer
admits an otherwise ineligible node. Raw membership remains unchanged. This is runner eligibility,
not daemon publication membership; backend-blind daemon compaction retains ownership of its declared
noise suppressions. When eligibility removes a structural wrapper, presentation reparents its
surviving descendants to the nearest surviving ancestor and normalizes their indexes and depths.

The second semantic layer makes scope a presentation specification rather than an acquisition or
daemon-compaction policy. A trimmed non-empty scope selects the first presentation-preorder match
whose subtree contributes to the requested projection; matching inspects label, identifier, and
value case-insensitively. The selected subtree is re-rooted, depth is applied relative to that root,
and no match publishes an empty healthy projection. Swift and TypeScript implementations are pinned
by `contracts/fixtures/snapshot-scope-policy.json`.
Scoped iOS acquisition stays broad (including when depth is requested) until an adapter can prove a
narrowing hint complete. The daemon never reapplies scope after the wire; Android selects its root
inside its TypeScript presentation and desktop surface runtimes retain their platform projection.

The third semantic layer splits presentation into two projections and gives acquisition one input.
`SnapshotPresentation.captureHint` derives a `CaptureHint` from the request; backends read the hint,
never `PresentationOptions`. A hint names the projection the acquisition must serve and may narrow
acquisition only where the backend can prove the narrowing complete for that projection: scope and
its relative depth never narrow, raw depth does (raw depth *is* traversal depth), and the raw
projection never carries `interactiveOnly`. `presentRegular` folds visibility, eligibility, scope,
and scroll hints; `presentRaw` is the acquired tree, normalized, with scope and depth applied only
when the request asked for them — so `interactive ⊆ regular ⊆ raw` holds per backend rather than per
backend implementation. `snapshot --raw -i` therefore returns the acquired tree instead of an
interactive-filtered one.

Two structural rules keep a backend from answering a request with the other projection, the shape
that let a recovered `snapshot --raw` return viewport-pruned nodes labeled raw: the raw diagnostic
plan is derived from `SnapshotBackendKind.supportsRawProjection` rather than hand-listed, so a
backend with no hierarchy to return (the query sweep) cannot be planned for raw; and presentation
compares the requested projection with the hint the acquisition was captured under, dropping that
tier with a structured `IOS_SNAPSHOT_PROJECTION_MISMATCH` failure instead of presenting it under the
requested label.

The fourth semantic layer moves the clip fold itself into presentation. Acquisition backends are
fact serializers: every traversed node is emitted at raw traversal depth with its reported frame,
and `SnapshotAcquisition` carries the viewport. The fold returns a typed carrier with both values:
`raw.rect` remains runner-internal reported geometry, while regular presentation writes the
carrier's effective rectangle through the existing wire `rect` field; raw projections and direct
single-element reads retain reported geometry. `presentRegular` runs the one visibility
interpreter for every backend — viewport ∩ scroll-container clip, the ancestor projection cursor
(an out-of-clip Cell or scroll container hides descendants whose clamped frames would otherwise
leak back into the viewport), the sub-pixel decoration rule, hidden-content hints booked onto
scroll anchors, and reparenting of survivors with collapsed depth. The fold also narrows the
emitted `hittable` to the clip: nothing outside its clip, and nothing without geometry, is ever
hittable regardless of what a backend reported. Platform differences are a `SnapshotFoldPolicy`
input to the shared algorithm (iOS cursor-projected; macOS/tvOS plain viewport intersection),
never a backend exception. The presentation owner validates every framed regular node against its
cumulative effective clip before constructing `SnapshotPresentation.PresentedNode`; frameless and
degenerate semantic carriers stay
eligible but are never actionable, while raw projection remains exempt by contract. A violation is
a typed `IOS_SNAPSHOT_PRESENTATION_FAILED` capture failure with the named `presentation-failed`
snapshot-quality reason, preserved through recovery and the existing TypeScript verdict/warning
contract.

The visible-depth frontier completes that migration for unscoped regular captures. `CaptureHint`
keeps raw traversal depth (`--raw --depth`) separate from regular presented depth. A
hierarchy-capable tree capture walks through structural wrappers until each branch ends or reaches
the requested presented depth; regular presentation then applies the depth limit after the shared
fold and eligibility collapse. This keeps shallow probes bounded by the requested presented
frontier without inventing a raw-depth multiplier. Scoped captures remain broad because depth is
relative to the scope root selected in presentation.

Backend capability declarations are part of the contract: recursive tree supports the presented
frontier, the flat query sweep supports only its root and one presented level, and private AX is
raw-depth-only for regular depth requests until it has an equivalent hierarchy-aware frontier.
The capture plan does not claim deeper regular-depth completeness from a backend that cannot prove
it. Raw depth remains acquisition depth for every backend.

Acquisition-side limits remain explicit: raw private-AX captures still disclose their bridge-side
node cap, the flat query sweep still drops frameless elements because it has no hierarchy to attach
geometryless semantics to, and the recursive tree still has no raw-depth extension for deep XCTest
trees. Presentation cannot repair any of those acquisition limits.

When adding new iOS snapshot behavior, maintainers should first decide which strategy owns it. If a
change tries to make regular snapshots fast by dropping visible controls behind a node budget, or
tries to make raw snapshots safe by silently truncating, it is probably crossing strategy
boundaries.
