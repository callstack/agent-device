# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted. Amended after local iOS Simulator acquisition moved to the host AX bridge while the
public surface remained two modes: regular interactive snapshots and raw diagnostic snapshots.

The Apple platform runtime owns acquisition routing and its generation-scoped XCTest fallback.
Host-side iOS validation, semantic presentation, and publication are owned by
`@agent-device/capture-kit`; structured snapshot quality verdicts and fallback warnings make
degraded or recovered output observable end to end.

## Context

Agent Device exposes iOS UI state through host AX acquisition on local Simulators and the long-lived
XCTest runner everywhere else. The snapshot surface has two durable needs:

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

Keep XCTest as the iOS automation runner. Route eligible local iOS Simulator snapshots through the
host AX bridge, present them once through the shared TypeScript engine, and use one typed XCTest
fallback when bridge acquisition or presentation fails. Disable the bridge for that app generation
after fallback; a new app generation re-enables it. Physical devices, providers, custom-action
captures, and interactions remain on their existing owners.

A WebKit page — Safari's, or a `WKWebView`'s — lives in a WebContent process and reaches UIKit's
tree as an `AXRemoteElement` under the web view, with its children in that other process. The
bridge reads one process, so it delivers the element as a leaf. The source refuses a tree in which
such a leaf sits under a `WebView`-typed ancestor and reaches the viewport (`remote-content-boundary`)
instead of publishing a screen without its page: refs issued from it would target the host views
around the page rather than the page. A leaf whose frame is zero-area or off screen hosts nothing
the capture can miss and is published; one that reports no frame is refused, because nothing proves
it empty. Remote elements outside a web view are not classified — no capture has shown one — and a
web view truncated away by the node or depth cap stays disclosed as truncation. XCTest resolves
remote elements, so the fallback serves the page (#2484).

The refusal opens the generation circuit, as any failure that says something about the app itself
does, so a hybrid app that showed one web screen takes XCTest for its remaining native screens until
it relaunches — the 0.20.x path for every screen. Re-asking the bridge per capture would instead
charge a refused bridge round trip to every `wait` poll on the web screen; the circuit keeps that cost
to one capture per generation. A refusal that says something about the screen rather than the app is
scoped per capture instead; the coordinate-space amendment below decides that case.

Keep the two public snapshot strategies explicit:

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
- **Host AX strategy**: acquire local Simulator trees as raw facts through the bounded host bridge.
  Every result crosses the same presentation boundary before publication. XCTest fallback carries
  explicit source residue, and comparisons require matching producer, intent, app generation,
  presentation key, and residue. Physical devices should use an equivalent non-XCTest semantic
  backend only if Apple exposes a supported channel.

The daemon should make degraded output observable. If an iOS interactive snapshot contains only the
application root or another sparse shape, surface a structured quality verdict and warning so
agents know the snapshot is degraded output rather than proof that the screen has no controls.

## Host-side ownership boundary

The shared TypeScript side has one snapshot-presentation facet. The neutral acquisition-to-presented
carrier and clip-fold geometry contract live in `@agent-device/contracts/snapshot-presentation`, while
`@agent-device/capture-kit` owns host-side iOS planning, folding, projection, eligibility, semantic
compaction, validation, and publication. Platform-specific presentation adapters retain only the
policy mechanics that cannot yet cross their runtime boundary. Daemon assembly owns only the ordering
of capture, compaction, occlusion, and ref publication. It does not own the presentation vocabulary
or a second geometry carrier.

Android acquisition remains in its platform module and adapts its raw hierarchy to the shared
carrier. Swift keeps its runner-side `SnapshotPresentation` implementation because it consumes the
capture-plan tier before the process boundary. The iOS engine fixture is the shared proof between
those runtimes; it does not imply that Swift and TypeScript share an implementation.
The macOS XCTest runner is the desktop-surface exception: its already-presented nodes bypass the iOS
presentation engine and continue through neutral snapshot assembly.

The same split now holds for the three remaining Wave 4 policies tracked by #1983, so the host-side
facet in `@agent-device/capture-kit` owns snapshot policy generally rather than presentation alone:

- **Freshness recovery.** The freshness window, the Android staleness classification and its
  thresholds, and the retry loop live in `packages/capture-kit/src/snapshot/snapshot-freshness/`.
  The loop is parameterized by a classifier and a retry schedule, so "how long may a backend lag
  behind a real transition" is a policy input rather than a constant the loop owns. The schedule is
  stated as a duration budget; the loop derives the deadline from the window's `markedAt` itself, so
  the budget is always spent from the action and a caller has no absolute instant it could get
  wrong.
  `src/daemon/session-snapshot-freshness.ts` keeps only what needs a session: reading and retiring
  the window on store-owned `SessionState`, and choosing the comparison baseline from snapshot
  lineage. It remains the declared R7 owner of `androidSnapshotFreshness`.
- **Timeout evidence.** Whether a capture failed because the hierarchy never arrived is decided
  once, at the deepest boundary that has the evidence, from machine-defined values only:
  `snapshot-capture-failure-reason.ts` maps the helper's structured `errorType` field
  (`java.util.concurrent.TimeoutException`, by exact equality) and the SIGKILL exit code 137 to
  the typed reason `accessibility-timeout` (`ANDROID_CAPTURE_FAILURE_REASONS` in
  `@agent-device/contracts/android-snapshot-quality`). The helper-result, session-protocol, and
  killed-instrumentation error constructors attach it; every layer above rewraps it rather than
  reclassifying. No message shape is consulted anywhere on that path, so rewording helper or
  wrapper prose cannot move the reason, and prose that merely reads like a timeout does not become
  one — both directions are asserted end to end against the real producer.
  `packages/capture-kit/src/snapshot/snapshot-timeout-policy.ts` reads the reason; the
  human-facing hint is derived from it rather than decided alongside it.

  The published `details.androidSnapshotTimeoutScreenshot` payload is vocabulary in
  `@agent-device/contracts/snapshot-timeout-evidence`, a union whose arms encode which claims can
  coexist. The annotated arm carries a non-empty ref tuple, so "annotated with zero refs" is not a
  state a caller can build, and no arm stores a ref count: a count beside the refs is a second
  source of truth the type system cannot hold in step, so it is derived from the refs instead.
  The daemon keeps the ordering that genuinely needs it: resolving a bound screenshot runtime,
  writing the artifact, annotating it from the stored observation, and emitting the diagnostics.
- **Screenshot-overlay policy.** Which Android nodes earn an overlay ref, and what rectangle an
  overlay for one of them covers, live in `packages/capture-kit/src/screenshot-overlay*.ts`. The
  daemon keeps approved artifact and ref assembly only: ranking, projection to screenshot pixels,
  drawing, and PNG IO.

`scripts/layering/snapshot-presentation-boundary.test.ts` enforces the direction, but only across
the roots `snapshot-policy` declares in `scripts/layering/architecture-ownership.ts`: nothing in
that snapshot tree may import `src/daemon/`, while the overlay modules beside the tree sit outside
those roots and are outside that gate. It carries a positive control, because a filter that stopped
matching would look identical to a boundary being obeyed.

The residual call sites #1983 also named are audited and deliberately left in place.
`src/daemon/direct-ios-selector.ts` carries no presentation policy: `isLocalIosRunnerSession` and
`readSimpleIosSelectorTarget` are session routing (device family, provider ownership, the
stabilization window), while `deriveDirectIosNodeSelector` and `isDirectIosSelectorFallbackError`
are selector derivation and ADR 0011 delegation-on-error. The latter two are pure and
daemon-independent, but their owner would be the selector pipeline governed by R19, not this
facet; moving them under ADR 0004 would widen it to a boundary it does not decide. The
observation and interaction consumers — `selector-capture-runtime.ts`,
`deferred-interaction-outcome.ts`, `snapshot-capture.ts` and
`interaction-touch-android-freshness.ts` — now reach freshness only through the facet or its
session binding.

New consumers must use the facet rather than add another daemon presentation path.

The acquisition/presentation boundary has two explicit vocabularies. An acquired input is raw node
evidence accompanied by its capture hint, viewport, lineage, and residue; the host engine folds and
projects that evidence. A presented input is the runner's primary payload plus validation facts; the
host engine validates it and performs semantic compaction once. Regular eligibility decides which
nodes belong in the regular presentation, while publication adds refs and emits only the primary
payload. An optional unscoped quality payload is validated for classification evidence and is never
published.

Semantic compaction may move an identifier; it may not un-make one. A structural `Other` wrapper
carrying an identifier and nothing else is suppressed in favour of its content, which is a
delegation: the identifier goes on living in whatever the wrapper stood for. A wrapper with no
content has nothing to delegate to, so suppressing it deletes the identifier from every canonical
view while `is`, `get`, and `click` still resolve it from the same capture. That deletion needs the
node's own declared `hittable: false`, because it is the only verdict in the capture that says the
wrapper is inert; a producer that reports no hittability for any node declares nothing, and an
absent fact is not a negative answer (#2638).

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

A third shape followed on the same app class once the plan recovered reliably. The query-sweep
tier's 19 `allElementsBoundByIndex` reads each fail with `kAXErrorIllegalArgument`, and XCTest
records every one as a test failure worded `Failed to resolve query: ...`. Any recorded failure the
runner does not mute ends `testCommand` as soon as the main-thread block that recorded it returns,
whatever `continueAfterFailure` says, so the runner died after (or during) every hostile snapshot
and the per-bundle penalty and depth memory died with it. The runner now mutes AX-server rejections
in both XCTest fetch wordings, and every bounded main-thread dispatch that outlives its slice counts
as occupying the main thread (the tree XPC and the system-modal probe previously kept a second count
of their own), so a viewport read that grinds makes the plan skip the sweep instead of queueing it.

## Recovery conformance and depth hints

The host AX bridge and the XCTest runner's private AX bridge recover rejected deep requests with
different native representations, ladders, and completeness evidence, and they stay separate
implementations. `contracts/fixtures/ios-ax-recovery-conformance.json` is their shared, executable
recovery contract: each producer replays every case through its own adapter, and the fixture
records per-producer expectations plus the intentional differences, so a change to either recovery
path is measured against the same synthetic native world. Common executable policy is extracted only
where the fixture proves equivalence; a shared engine is not a goal.

The host source additionally keeps a bounded accepted-depth hint per resolved target generation
and producer. It changes only the native levels the first request asks for, is learned only from a
finished recovery that observed a rejection, expires by hinted-capture count so ordinary screens
probe back to the full depth, and is never shared across apps, generations, or producers. The
route's generation circuit remains the only lifecycle owner.

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

Inside the runner the viewport is a declared fact, not a rectangle: `SnapshotViewport` is
`reported(box, interfaceOrientation)`, `derived(box)`, or `missing(reason)`, the cases of the host's
`IosViewportEvidence` (#2891). Only `reported` carries an orientation, so only it can anchor a
rotation in `SnapshotGeometrySpace`. With no box the clip skips, the cumulative-clip invariant has no
root clip to violate, and a node whose actionability depends on containment has no `hittable` on the
wire, as on the host bridge; disabled or degenerate nodes stay declared `false`. A rectangle becomes a
`Box` only through the initializer that checks it, and the shared guard refuses `CGRect.infinite` by
identity — its components and its extents are all finite, so no comparison would have caught the
value a failed read leaves behind. The two twins were not twins before #2908 landed: the Swift guard
already refused that value by identity, while the TypeScript one accepted it and both accepted finite
components whose right or bottom edge overflowed. Both now refuse both shapes, and every box either
guard accepted and is neither of those two shapes is still classified the same way. The runner route's
host evidence comes from the payload's root nodes (`resolveIosViewportEvidenceFromRoots` in
`packages/capture-kit/src/ios-snapshot-acquisition.ts`). `contracts/fixtures/snapshot-actionability-policy.json`
pins the predicate for shapes the 320x240 fold fixture cannot reach.

A regular `--depth` request is a presentation cut, not an acquisition bound. `CaptureHint` keeps raw
traversal depth (`--raw --depth`) separate from regular presented depth, but the recursive tree walk
no longer reads presented depth (or any geometry) while descending: for a regular capture it
enumerates the hierarchy — a runaway node cap bounds the walk (#1105, #1156) — and serializes each
node at reported traversal depth and the frame the platform reported. #2661 also removed the per-node
coordinate space (`geometrySpace` / `parentIsWindow`) that #2612 had threaded through every walker;
the one coordinate-space decision is now a single post-acquisition pass over the flat array
(`SnapshotGeometrySpace.normalized`, run in `captureWithBackend`) that keys on ancestry instead of a
value carried down the stack. That pass is why the earlier visible-depth frontier had to go: the
frontier consulted the shared fold mid-walk, and a post-walk normalization pass cannot feed a decision
the walk has already taken — the fold would read reported geometry, and a turned keyboard band in the
device's native space could be cut at the wrong presented depth before the pass ever ran. With the
frontier gone, no acquisition-time decision reads geometry, the walk is bounded only by raw traversal
depth and the node cap, and the visibility fold and the presented-depth cut both happen inside
`SnapshotPresentation`, on the normalized array, at `maximumDepth`. The frontier only ever engaged
when a presented depth was set (`snapshot --depth N`; `snapshot -i` carries none), so that is the
route whose cost the change could move. Measured there on the recursive tier, 15 warm captures per
cell against `main` on the same simulator: the form (135 raw nodes, 4 or 6 presented) and the
scrolled catalog list (279 raw nodes, 4 or 6 presented) walk their whole raw tree on this branch
where `main` pruned it at the presented depth, and acquisition p50 stays within ±4 % and p95 within
±7 % of `main` with mixed sign. The walk runs over an `XCUIElementSnapshot` tree the platform has
already materialized in one call, which is where acquisition time goes; the node construction the
frontier saved is not measurable on these trees. Screens that recover to private AX are untouched
by it. The bound that remains is the raw node cap. De-duplication drops a repeated node and re-parents its children onto that node's
own parent, so identical rows collapse under one addressable owner instead of splitting a subtree
across two nodes with the same identity. Scoped captures remain broad because depth is relative to the
scope root selected in presentation.

Backend capability declarations are part of the contract, and they describe how much acquisition
work a regular depth request bounds — never whether the backend may answer it. Every backend
serves a regular `--depth` request because presentation applies the presented-depth cut to
whatever hierarchy was acquired: the recursive tree and private AX both enumerate their hierarchy
and are cut afterwards (`presentation-cut`), and the flat query sweep has only its root and one
presented level (so a cut past depth 1 returns the sweep unchanged, `flat`). Completeness below an
acquisition cap is disclosed the same way it is for an
unscoped capture — through `truncated` and `effectiveDepth` — because a depth-capped regular
capture is a subset of the unscoped one from the same backend. Refusing the request instead
produced no answer at all: a plan pinned or deferred to private AX fell through to the synthetic
sparse root, which the daemon then rejected as a missing viewport (#2403). Raw depth remains
acquisition depth for every backend.

Acquisition-side limits remain explicit: raw private-AX captures still disclose their bridge-side
node cap, the flat query sweep still drops frameless elements because it has no hierarchy to attach
geometryless semantics to, and the recursive tree still has no raw-depth extension for deep XCTest
trees. Presentation cannot repair any of those acquisition limits.

When adding new iOS snapshot behavior, maintainers should first decide which strategy owns it. If a
change tries to make regular snapshots fast by dropping visible controls behind a node budget, or
tries to make raw snapshots safe by silently truncating, it is probably crossing strategy
boundaries.

## Amendment: in-place system surfaces (issue #2438)

Some UI is presented out of the app's process by a system bundle — `com.apple.SafariViewService`,
which hosts `ASWebAuthenticationSession` and `SFSafariViewController` for delegated OAuth/OIDC
sign-in. Two facts, both verified live on the iOS 26.2 Simulator, shape how it is captured:

- The surface dies if activated. `XCUIApplication.activate()` or `simctl launch` on the host cancels
  the authentication session and blacks the view. So the host must be observed and driven **in
  place**, never activated, and `open` refuses to launch a registered host.
- The local host AX bridge cannot see it. While the sheet is up the app remains the AX `primaryApp`,
  so the bridge serves the (occluded) app tree as if healthy. Only the XCTest runner, addressing the
  host by bundle id, can read and drive the sheet.

Decision. A closed registry names these hosts (`contracts/fixtures/ios-system-surface-hosts.json`,
mirrored by the TypeScript and Swift registries under a parity test). When a registered host is
genuinely presented, the runner serves and drives it in place and never adopts it as the cached
session target; the session binding stays on the app, so once the surface is gone the next command
resolves back to the app. On the Simulator a cheap, device-scoped host-side probe (a registered
host process running for the device) routes the capture to the runner instead of the bridge; when no
host is running the bridge fast path is untouched.

A presented surface also outranks an explicitly requested bundle id: the runner checks for a
presented host before it resolves or activates `command.appBundleId`, so a command that names a
*different* app is still served the sheet. That is deliberate — the sheet occludes the screen, so
the named app has nothing readable under it, and the capture discloses which surface it describes —
and it costs nothing once the sheet is gone, because the session binding never moved.

Presence is `XCUIApplication.state == .runningForeground`, not tree content. The live spike showed a
torn-down host still serving a *richer* tree than a live one, so content heuristics cannot separate
live from dead; foreground state can. Crucially, the only way a host is foreground with a stale tree
is if it was activated or relaunched — which the open guard and the in-place policy both refuse — so
this fix and the never-activate guard are one design: the guard is what makes the foreground
predicate sound. This also makes issue #2438's second bug (a stale tree served confidently after
teardown) unrepresentable for the delegated-auth flow, because the session never binds to the host.

Captures of a system surface carry a response-level `systemSurface` provenance and the shared
`iosSystemSurfaceDisclosure`, worded per host kind, so the agent is told the controls belong to a
system sheet (web sign-in, Apple Pay) rather than the app. They are also lineaged to the host rather
than the app, so their comparison identity differs from an app capture's by construction: every
consumer that asks "are these two captures the same presentation" refuses a cross-surface pair
through ordinary key equality, and no comparison site carries a surface check of its own. Physical
devices always use the runner, so the in-place serve applies there without a route change; the
Simulator route probe is the only Simulator-specific piece.

The Apple Pay host (`com.apple.PassbookUIService`) joined the registry for text entry as much as for
snapshots. Its billing, shipping, and contact forms hold text fields the session app's tree cannot
resolve, and a bare `type` addressed to the app process never sees that keyboard. Addressing the
host in place is what lets the runner's first-responder route type into them; no text-entry branch
changed for it.

## Amendment: the coordinate space of a captured subtree (issue #2612)

Some system surfaces keep their geometry in the device's native (portrait-up) space while the app
is rotated, and their *whole subtree* arrives turned with them. Measured on iPhone 17 Pro (iOS
26.2) with the system keyboard up over a landscape app frame `(0,0,874,402)`:
`UIRemoteKeyboardWindow` reports its own box as `(0,0,402,874)` — the app's box with its two side
lengths swapped — while the app's own window and `UITextEffectsWindow` both report `(0,0,874,402)`.
In portrait the two spaces coincide and nothing is turned. Nothing but that box says which space a
subtree reports in, and a consumer reading the numbers cannot tell a keyboard laid across the
bottom of a landscape screen from a strip running down its left edge: it refused app content the
keyboard was nowhere near and let a tap land on a key.

Decision. One published capture publishes one space — the app's orientation space — and the
producer settles it where the platform's frame is still the platform's, because downstream of the
capture the question is unanswerable: a merged tree carries no axis a reader could turn geometry
against. A window declares the space of its own subtree from its own box, which is either the app's
box or that box turned through a quarter, and anything that is not a window inherits the space of
the window above it. A published rect and the actionability verdict read from it come off the same
oriented frame, so an address and the permission to tap it cannot disagree. Where no space can be
named — no usable app frame, an interface orientation the platform did not report, or an app frame
square enough to be indistinguishable from its own quarter turn — the capture publishes what the
platform reported rather than guessing at a rotation, and consumers fail open on that geometry the
way they do on any missing platform fact. Detection and the way back share one rotation table with
synthesized dispatch — pure geometry that lives in the `AgentDeviceSnapshotPresentation` package
(`SnapshotCoordinateSpace.swift`), not in the XCTest bundle — and both languages replay it against
`contracts/fixtures/window-coordinate-space.json` in the ADR 0011 parity-table shape, which is what
stops capture from turning back with anything other than the exact inverse of what dispatch turns
forward.

Decision. A producer that cannot name the app's interface orientation refuses the screen rather
than publishing two spaces in one tree. The Simulator AX bridge cannot name it: the #2659 spike
(verdict on that issue, write-up in the diff of #2667) measured that the one AX attribute for it,
`XC_kAXXCAttributeApplicationOrientation` (id 1503), resolves but reads 0 through the guest's
snapshot channel and errors `kAXErrorServerNotFound` through XCTest's own reader, and that the only
cheap service read is *device* orientation, which diverges from the app's on a rotation-locked app.
So its decoder counts window roots reporting the app's box quarter-turned and
fails that capture (`window-coordinate-space-unresolved`, kind `unsupported`) — the same refusal
shape as `remote-content-boundary` above — and the route serves the runner, which reads the
orientation. A mixed tree is not half-usable: a published rect is an address, and once some rects
in a tree answer to a turned axis no pair of them answers "how far apart are these" any more, so
every consumer downstream would have to know which windows to distrust — a rule the capture could
have applied and did not. The refusal costs one runner round trip and is correct.

Decision. That refusal is scoped to the capture, not to the app generation. Entering the generation
circuit is for failures that are evidence about the app: a web-view screen is a property of a
hybrid app, so its screens keep the runner until it relaunches. A rotated surface is evidence about
the screen in front of the reader and about nothing else — it is up now and gone after the next
keystroke — so retiring the generation would move every later portrait capture of a healthy app
onto the runner to work around one landscape keyboard, the cost #2491 settled for a bridge that was
merely still being prepared. Which side of that line a failure falls on is a declared property of
its code rather than a judgment made at the call site.

What stays unnormalized, and why the consumer rule stays: the runner's recursive-tree capture now
answers the keyboard with a measured band instead of a rebuilt one, because the same run that owns
the tree can ask `app.keyboards` and gets an answer in the app's own orientation space (#2660). That
closes the keyboard question on the path that used to lean on this ADR's geometry most, and it is why
the guard's landscape refusals no longer depend on whether the tree arrived turned.

What did not move is the rest of the sentence. Capture settles the space in ONE pass over the flat
acquired array (`SnapshotGeometrySpace.normalized`, run once in `captureWithBackend` between
acquisition and presentation, #2661), keyed on each node's `type`, `parentIndex` and `rect`. The
runner's query-sweep tier still has no window ancestry, so nothing in its tree declares a native space:
its flat children hang off a synthetic application root that reports the app's own box under an
interface orientation the tier does not read, so the pass returns that tree exactly as reported — a
structural consequence of the same rule applied uniformly, not the per-tier omission a hand-threaded
space would have made it. The provider producers (`appium-source`, `limrun-ios-tree`) never see the
app's windows either; a capture from any of them publishes no keyboard fact, and a consumer reads that
silence as "this producer did not measure". Those paths publish what the platform reported, so the
last reader that can still refuse geometry it cannot place is the tap-path keyboard guard, and its
width rule therefore remains. The rule detects un-normalized
arrival, not a standing fact about iOS: the producers above do normalize, and a band taller than it
is wide is what one that did not looks like.

## Amendment: modal containment in the presentation cut

The bridge reads one window and reports every container hanging off it, while XCTest's own queries
answer only the presentation the user can reach. React Navigation's card-plus-modal example is the
measured case: three routes presented as sheets left three transition-view containers in one window
and one capture published 567 nodes across three screens, where the same app state under the runner
published 76 across the top screen alone. Maestro's visibility test is geometric, so a `tapOn`
resolved the covered screen's button and the flow failed on an assertion about the screen that never
arrived, and a `presentation: "formSheet"` route's fields matched intermittently (#2638).

Decision. The fold applies modal containment: when the last transition view under a container carries
UIKit's dimming view as its direct child and the producer reports that dimming view takes touches
(`userInteractionEnabled: true`), the earlier transition views whose frame that dimmed area spans are
cut, with their subtrees, from the regular and interactive projections. Every part of the claim is a
producer fact rather than an ordering guess — the dimming view is UIKit's own declaration that it dims
what sits behind, its interaction state says whether a touch there reaches what sits behind, and its
frame is the producer's rectangle, which is what a covered container must be inside. A presentation
with no dimming view, a dimming view the producer did not read or reports passing touches through,
and any container whose earlier sibling is not a transition view keep today's behavior: containment
is asserted only where the producer states it, so the rule fails closed rather than guessing which
siblings are shadows.

A sheet resting at an undimmed detent (`largestUndimmedDetentIdentifier`, react-native-screens
`sheetLargestUndimmedDetentIndex`) is why the interaction state is part of the claim. UIKit keeps the
dimming view in the tree at the same window-sized frame, and the presenting screen stays reachable: on
react-navigation's form-sheet example a press on the presenting screen's `Height Steps` button
navigates while the `Custom Dimming` sheet rests at its smallest detent. The bridge reports that
dimming view `userInteractionEnabled: false`, and `true` for the dimmed form sheet and the card modal.
No attribute the bridge already read told them apart, and `XC_kAXXCAttributeIsVisible` cannot either:
it reads false for the undimmed sheet's dimming view and for the card modal's. The bridge reads the
attribute for dimming views alone, in one follow-up read per view: requesting it on every node cost
about half again the capture time on a 492-node tree, while the targeted read did not move it.
Every source the cut removes is counted in the presentation's
`stats.modalContainedNodeCount` — internal evidence, per ADR 0026, never wire vocabulary — because
the same screen either side of an animation otherwise moves hundreds of comparable lines with nothing
to attribute them to.

Why this seam and not the neighbouring ones. The semantic presentation rules
(`IOS_PRESENTATION_RULES`) run only for the interactive projection, so a suppression rule there could
not deliver the same claim to a regular `snapshot`; the regular eligibility table is pinned against
its Swift twin, so widening it would move a cross-language contract that this rule does not touch; the
occlusion pass *marks* a node covered and keeps it published, and a published-but-marked node is
exactly the 567-versus-76 divergence being fixed, since visibility filtering reads geometry and not
the mark; and cutting at acquisition would leak the decision into `--raw`, which owes the reader the
tree the platform reported. Raw therefore still carries the covered screens.

Producers that report no UIKit class names or no dimming-view interaction state never trigger the
cut, and that is a fact about their output rather than a backend exception in the fold: the runner already omits modal-contained content
from its own queries, `appium-source` and `limrun-ios-tree` report element types and no classes, and
the macOS desktop surface arrives already presented. A scope naming a modal-contained screen now
publishes an empty projection, which is the same healthy empty answer any other unmatched scope gives
— the screen is not what is presented.
