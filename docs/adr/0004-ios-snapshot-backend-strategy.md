# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted.
This ADR was amended after local iOS Simulator acquisition moved to the host AX bridge.
The public surface remains two modes: regular interactive snapshots and raw diagnostic snapshots.
The host AX bridge is an acquisition route, not a third public mode.

Completed process history is in git history.

The Apple platform runtime owns acquisition routing and its generation-scoped XCTest fallback.
`@agent-device/capture-kit` owns host-side iOS validation, semantic presentation, and publication.
Structured snapshot quality verdicts and fallback warnings make degraded or recovered output observable end to end.

## Rules at a glance

- Route eligible local iOS Simulator snapshots through the host AX bridge. Present them once through the shared TypeScript engine.
  An iPad Simulator is a local iOS Simulator for this rule.
- Refuse a bridge capture of an app window that does not fill the screen.
- If bridge acquisition or presentation fails, use one typed XCTest fallback.
- After fallback, disable the bridge for that app generation, except for `preparing` failures and capture-scoped failures.
  A new app generation enables it again.
- A refusal that provides evidence about the screen, not the app, has capture scope.
- Keep the regular visible strategy and the raw diagnostic strategy explicit as the two public snapshot strategies.
- The regular visible strategy must not use an arbitrary node-count cutoff.
- If the transport cannot carry a raw response, fail explicitly instead of silently truncating the tree at a hard node count.
- New consumers must use the host-side snapshot policy facet in `@agent-device/capture-kit` instead of adding another daemon presentation path.
- Acquisition backends serialize facts. Presentation applies visibility, eligibility, scope, and the regular depth cut.
- Observe and operate a registered system-surface host in place. Never activate it.

## Context

Agent Device exposes iOS UI state through host AX acquisition on local Simulators and the long-lived XCTest runner everywhere else.
The snapshot surface has two durable needs:

- Agent-facing regular context. Here the important contract is the effective user-visible UI, fixed controls such as tab bars, and scroll-hidden hints for content outside visible scroll containers.
- Rich diagnostics and selector disambiguation. Here a raw recursive XCTest snapshot is useful because it preserves hierarchy, static text, wrappers, scroll containers, and ancestry.

These needs should not share one capture strategy without distinction.
Recursive `XCUIElement.snapshot()` is rich.
However, some real app trees can make XCTest fail with `kAXErrorIllegalArgument` or main-thread timeouts while the same app remains visually usable.
Bluesky is the current known example.
Lower-level accessibility services can describe simulator screens even when recursive XCTest snapshots and typed `XCUIElementQuery` enumeration degrade to no useful child nodes.
Physical iOS devices can show the same XCTest accessibility-channel timeout shape even when no lower-level semantic backend is available.

This failure is different from presentation filtering.
The daemon's snapshot presentation can hide noisy or inaccessible nodes.
It cannot recover nodes that XCTest never returns.
More filters, Maestro-specific heuristics, or retries in the daemon would only make this failure slower and less predictable.

## Decision

Keep XCTest as the iOS automation runner.
Route eligible local iOS Simulator snapshots through the host AX bridge.
Present them once through the shared TypeScript engine.
If bridge acquisition or presentation fails, use one typed XCTest fallback.
After fallback, disable the bridge for that app generation, except for `preparing` failures and the capture-scoped exception below.
A `preparing` failure describes a bridge preparation that is still running, not the app.
It sends only that capture to XCTest.
A new app generation enables it again.
Physical devices, providers, custom-action captures, and interactions remain on their existing owners.
The iPad amendment below defines which Simulators are local iOS Simulators.

A WebKit page in Safari or in a `WKWebView` lives in a WebContent process.
It reaches UIKit's tree as an `AXRemoteElement` under the web view.
Its children are in that other process.
The bridge reads one process, so it delivers the element as a leaf.
If such a leaf has a `WebView`-typed ancestor and reaches the viewport, the source refuses the tree (`remote-content-boundary`).
The source refuses the tree instead of publishing a screen without its page.
If the source published that tree, refs issued from it would target the host views around the page instead of the page.
If the leaf frame is zero-area or off screen, the leaf hosts nothing that the capture can miss, so the source publishes it.
If the leaf reports no frame, the source refuses it because nothing proves it empty.

A scene-hosted remote view controller (a share or action extension presented over the host app) reaches the tree in the same way.
It is an `AXRemoteElement` leaf under a `_UISceneHostingView`.
The extension's controls are in its own process.
The source refuses that leaf by the same rule.
Remote elements under any other host are not classified.
No capture has shown one.
If the node cap or the depth cap removes the host, the capture still discloses it as truncation.
XCTest resolves remote elements, so the fallback serves the page or the extension (#2484).

The refusal opens the generation circuit, as any failure that provides evidence about the app itself does.
Thus, after a hybrid app shows one web screen, its remaining native screens use XCTest until the app relaunches.
In 0.20.x, every screen used this XCTest path.
A bridge request on each capture would instead add a refused bridge round trip to every `wait` poll on the web screen.
The circuit limits that cost to one capture per generation.
A refusal that provides evidence about the screen instead of the app has capture scope.
The coordinate-space amendment below decides that case.

Keep the two public snapshot strategies explicit:

- **Regular visible strategy**: use recursive XCTest snapshots.
  Emit the effective user-visible tree, visible ancestors, and scroll-hidden hints.
  If XCTest returns sparse output, fall back through the capture plan.
  A node inside a scroll container is user-visible only if it intersects both the app viewport and the nearest visible scroll container.
  Offscreen descendants should be visited to set `hiddenContentAbove` / `hiddenContentBelow`.
  They should not be emitted as normal visible nodes.
  This strategy must not use an arbitrary node-count cutoff.
  Fixed controls that are later in traversal order, such as bottom tab bars after long lists, are part of the visible UI contract.
- **Raw diagnostic strategy**: use recursive XCTest snapshots for raw snapshots, diagnostics, and cases that need hierarchy.
  Raw output is allowed to be noisy and large.
  If the transport cannot carry the response, fail explicitly instead of silently truncating the tree at a hard node count.
  If XCTest reports a real AX serialization failure, preserve that error instead of reporting an empty UI.
- **Host AX strategy**: acquire local Simulator trees as raw facts through the bounded host bridge.
  Before publication, every result crosses the same presentation boundary.
  XCTest fallback carries explicit source residue.
  Comparisons require matching producer, intent, app generation, presentation key, and residue.
  Physical devices should use an equivalent non-XCTest semantic backend only if Apple exposes a supported channel.

The daemon should make degraded output observable.
If an iOS interactive snapshot contains only the application root or another sparse shape, return a structured quality verdict and warning.
Thus, agents know that the snapshot is degraded output, not proof that the screen has no controls.

## Host-side ownership boundary

The shared TypeScript side has one snapshot-presentation facet.
The neutral acquisition-to-presented carrier and the clip-fold geometry contract live in `@agent-device/contracts/snapshot-presentation`.
`@agent-device/capture-kit` owns these host-side iOS responsibilities:

- Planning.
- Folding.
- Projection.
- Eligibility.
- Semantic compaction.
- Validation.
- Publication.

Platform-specific presentation adapters retain only the policy mechanics that cannot yet cross their runtime boundary.
Daemon assembly owns only the order of capture, compaction, occlusion, and ref publication.
It does not own the presentation vocabulary or a second geometry carrier.

Android acquisition remains in its platform module and adapts its raw hierarchy to the shared carrier.
Swift keeps its runner-side `SnapshotPresentation` implementation because it consumes the capture-plan tier before the process boundary.
The iOS engine fixture is the shared proof between those runtimes.
It does not imply that Swift and TypeScript share an implementation.
The macOS XCTest runner is the desktop-surface exception.
Its already-presented nodes bypass the iOS presentation engine and continue through neutral snapshot assembly.

The same split holds for the three remaining Wave 4 policies tracked by #1983.
Thus, the host-side facet in `@agent-device/capture-kit` owns snapshot policy generally, not only presentation:

- **Freshness recovery.** The freshness window, the Android staleness classification and its thresholds, and the retry loop live in `packages/capture-kit/src/snapshot/snapshot-freshness/`.
  A classifier and a retry schedule parameterize the loop.
  Thus, "how long may a backend lag behind a real transition" is a policy input, not a constant that the loop owns.
  The schedule is stated as a duration budget.
  The loop itself derives the deadline from the window's `markedAt`.
  Thus, the budget is always spent from the action, and a caller has no absolute instant that it could get wrong.
  `packages/daemon/src/core/session-snapshot-freshness.ts` keeps only the operations that need a session.
  It reads and retires the window on store-owned `SessionState`, and it chooses the comparison baseline from snapshot lineage.
  It remains the declared R7 owner of `androidSnapshotFreshness`.
- **Timeout evidence.** The deepest boundary that has the evidence decides once whether a capture failed because the hierarchy never arrived.
  It decides from machine-defined values only.
  `snapshot-capture-failure-reason.ts` maps the helper's structured `errorType` field and the SIGKILL exit code 137 to the typed reason `accessibility-timeout`.
  The `errorType` match is an exact equality with `java.util.concurrent.TimeoutException`.
  `ANDROID_CAPTURE_FAILURE_REASONS` in `@agent-device/contracts/android-snapshot-quality` defines the typed reason.
  The helper-result, session-protocol, and killed-instrumentation error constructors attach it.
  Every layer above rewraps it instead of reclassifying it.
  No code on that path examines a message shape.
  Thus, a change to helper or wrapper prose cannot move the reason.
  Prose that only resembles a timeout does not become one.
  End-to-end assertions against the real producer verify both directions.
  `packages/capture-kit/src/snapshot/snapshot-timeout-policy.ts` reads the reason.
  The human-facing hint is derived from the reason, not decided beside it.

  The published `details.androidSnapshotTimeoutScreenshot` payload is vocabulary in `@agent-device/contracts/snapshot-timeout-evidence`.
  It is a union whose arms encode which claims can coexist.
  The annotated arm carries a non-empty ref tuple, so "annotated with zero refs" is not a state that a caller can build.
  No arm stores a ref count.
  A count beside the refs is a second source of truth that the type system cannot keep consistent.
  Thus, the count is derived from the refs instead.
  The daemon keeps the ordering that genuinely needs it:

  1. Resolve a bound screenshot runtime.
  2. Write the artifact.
  3. Annotate it from the stored observation.
  4. Emit the diagnostics.

- **Screenshot-overlay policy.** `packages/capture-kit/src/screenshot-overlay*.ts` decides which Android nodes earn an overlay ref and which rectangle an overlay for one of them covers.
  The daemon keeps only approved artifact and ref assembly: ranking, projection to screenshot pixels, drawing, and PNG IO.

`scripts/layering/snapshot-presentation-boundary.test.ts` enforces the direction, but only across the roots that `snapshot-policy` declares in `scripts/layering/architecture-ownership.ts`.
Nothing in that snapshot tree may import `packages/daemon/src/`.
The overlay modules beside the tree are outside those roots and outside that gate.
The test carries a positive control, because a filter that stopped matching would look identical to an obeyed boundary.

The residual call sites that #1983 also named are audited and intentionally left in place.
`packages/daemon/src/core/direct-ios-selector.ts` carries no presentation policy.
`isLocalIosRunnerSession` and `readSimpleIosSelectorTarget` are session routing (device family, provider ownership, the stabilization window).
`deriveDirectIosNodeSelector` and `isDirectIosSelectorFallbackError` are selector derivation and ADR 0011 delegation-on-error.
The latter two are pure and daemon-independent.
However, their owner would be the selector pipeline that R19 governs, not this facet.
A move under ADR 0004 would widen this ADR to a boundary that it does not decide.
These observation and interaction consumers now reach freshness only through the facet or its session binding:

- `selector-capture-runtime.ts`.
- `deferred-interaction-outcome.ts`.
- `snapshot-capture.ts`.
- `interaction-touch-android-freshness.ts`.

New consumers must use the facet instead of adding another daemon presentation path.

The acquisition/presentation boundary has two explicit vocabularies.
An acquired input is raw node evidence with its capture hint, viewport, lineage, and residue.
The host engine folds and projects that evidence.
A presented input is the runner's primary payload plus validation facts.
The host engine validates it and performs semantic compaction once.
Regular eligibility decides which nodes belong in the regular presentation.
Publication adds refs and emits only the primary payload.
An optional unscoped quality payload is validated for classification evidence and is never published.

Semantic compaction may move an identifier, but it may not delete one.
A structural `Other` wrapper that carries an identifier and nothing else is suppressed in favor of its content.
This suppression is a delegation: the identifier continues to exist in whatever the wrapper represented.
If the wrapper has no content, it has nothing to delegate to.
Thus, its suppression deletes the identifier from every canonical view while `is`, `get`, and `click` still resolve it from the same capture.
That deletion needs the node's own declared `hittable: false`.
This is the only verdict in the capture that says the wrapper is inert.
A producer that reports no hittability for any node declares nothing.
An absent fact is not a negative answer (#2638).

## Regression Notes

PR #639 made XCTest AX serialization failures explicit instead of returning them as empty snapshots.
That diagnostic change was correct, but it exposed apps whose accessibility trees XCTest cannot serialize.

Later work moved recovery into the regular visible capture plan.
Thus, healthy apps keep the fast recursive tree path.
When fallback tiers are the only available source of visible controls, degraded app classes can still return bounded, honest output.

Issue #1105 showed a second failure shape on the same app class.
On heavy or animating screens, the recursive tree capture can work for many seconds before it fails, instead of failing fast with `kAXErrorIllegalArgument`.
This pushes the chained plan past the runner's main-thread watchdog and fills the main queue with retries.
The plan now carries its umbrella deadline into the query-sweep and private-AX tiers.
When the budget is spent, later ladder rungs stop.
A slow, timed-out, or watchdog-abandoned XCTest-backed capture penalizes the XCTest accessibility channel for that bundle for a bounded window.
Subsequent regular plans derive the next step from backend traits (`effectiveSnapshotCapturePlan`).
If a runnable non-XCTest backend exists, they defer to that independent tier.
If it does not exist, as on physical iOS devices today, they run a short XCTest probe instead of the full tree slice.
Thus, healthy screens can recover without another long capture of the hostile screen.
The raw diagnostic plan is exempt and keeps tree-first error propagation.

A third shape followed on the same app class after the plan recovered reliably.
On that app class, each of the query-sweep tier's 19 `allElementsBoundByIndex` reads fails with `kAXErrorIllegalArgument`.
XCTest records every one as a test failure worded `Failed to resolve query: ...`.
Any recorded failure that the runner does not mute ends `testCommand` as soon as the main-thread block that recorded it returns, whatever `continueAfterFailure` says.
Thus, the runner exited after (or during) every hostile snapshot, and the per-bundle penalty and depth memory were lost with it.
The runner now mutes AX-server rejections in both XCTest fetch wordings.
Every bounded main-thread dispatch that outlives its slice counts as occupying the main thread.
Thus, if a viewport read takes too long, the plan skips the sweep instead of queueing it.

## Recovery conformance and depth hints

The host AX bridge and the XCTest runner's private AX bridge recover rejected deep requests with different native representations, ladders, and completeness evidence.
They stay separate implementations.
`contracts/fixtures/ios-ax-recovery-conformance.json` is their shared, executable recovery contract.
Each producer replays every case through its own adapter.
The fixture records per-producer expectations and the intentional differences.
Thus, a change to either recovery path is measured against the same synthetic native world.
Common executable policy is extracted only where the fixture proves equivalence.
A shared engine is not a goal.

The host source also keeps a bounded accepted-depth hint per resolved target generation and producer.
The hint changes only the native levels that the first request asks for.
It is learned only from a finished recovery that observed a rejection.
It expires by hinted-capture count, so ordinary screens probe back to the full depth.
It is never shared across apps, generations, or producers.
The route's generation circuit remains the only lifecycle owner.

## Consequences

Regular snapshots remain the right tool for agents and Maestro compatibility because they describe what a user can currently perceive and interact with.
Raw snapshots remain the right tool when hierarchy matters.
Both may still fail explicitly on XCTest-broken trees.
That failure is useful because another identical recursive capture is unlikely to reveal a different tree.

A future AX-service backend is the correct place to regain Bluesky-class semantic coverage.
It should be added as a platform backend with its own lifecycle, protocol, normalization, timing metrics, and fallback rules.
It should not be added as another special case inside the XCTest runner.

The acquire/present migration begins with a typed seam that preserves behavior:

- Acquisition backends construct `RawAXNode`.
- `SnapshotPresentation` alone constructs `PresentedNode`.
- Response payloads accept only presented nodes.

Its second step also preserves behavior.
It makes every capture-plan backend return `SnapshotAcquisition`.
It routes the exhaustive backend switch through one `SnapshotPresentation.present` call.
`PresentationOptions` is the stable request-policy input to that boundary.

The first semantic migration layer makes regular eligibility backend-neutral inside `SnapshotPresentation`.
The top-level viewport carrier survives.
Every other node needs an interactive accessibility type or a non-empty label, identifier, or value.
Hittability no longer admits an otherwise ineligible node.
Raw membership remains unchanged.
This is runner eligibility, not daemon publication membership.
Backend-blind daemon compaction retains ownership of its declared noise suppressions.
If eligibility removes a structural wrapper, presentation reparents its surviving descendants to the nearest surviving ancestor.
Presentation also normalizes their indexes and depths.

The second semantic layer makes scope a presentation specification instead of an acquisition or daemon-compaction policy.
A trimmed non-empty scope selects the first presentation-preorder match whose subtree contributes to the requested projection.
The match examines label, identifier, and value case-insensitively.
The selected subtree is re-rooted.
Depth applies relative to that root.
If no node matches, presentation publishes an empty healthy projection.
`contracts/fixtures/snapshot-scope-policy.json` pins the Swift and TypeScript implementations.
Scoped iOS acquisition stays broad (including when depth is requested) until an adapter can prove a narrowing hint complete.
The daemon never reapplies scope after the wire.
Android selects its root inside its TypeScript presentation.
Desktop surface runtimes retain their platform projection.

The third semantic layer splits presentation into two projections and gives acquisition one input.
`SnapshotPresentation.captureHint` derives a `CaptureHint` from the request.
Backends read the hint, never `PresentationOptions`.
A hint names the projection that the acquisition must serve.
A hint may narrow acquisition only where the backend can prove the narrowing complete for that projection.
Scope and its relative depth never narrow acquisition.
Raw depth does narrow it, because raw depth *is* traversal depth.
The raw projection never carries `interactiveOnly`.
`presentRegular` folds visibility, eligibility, scope, and scroll hints.
`presentRaw` is the acquired tree, normalized.
It applies scope and depth only when the request asked for them.
Thus, `interactive ⊆ regular ⊆ raw` holds per backend, not per backend implementation.
`snapshot --raw -i` therefore returns the acquired tree instead of an interactive-filtered tree.

Two structural rules keep a backend from answering a request with the other projection.
An answer with the other projection is the shape that let a recovered `snapshot --raw` return viewport-pruned nodes labeled raw.
The first rule derives the raw diagnostic plan from `SnapshotBackendKind.supportsRawProjection`, not from a manual list.
Thus, a backend with no hierarchy to return (the query sweep) cannot be planned for raw.
In the second rule, presentation compares the requested projection with the hint that the acquisition was captured under.
If they differ, presentation drops that tier with a structured `IOS_SNAPSHOT_PROJECTION_MISMATCH` failure.
It does not present that tier under the requested label.

The fourth semantic layer moves the clip fold itself into presentation.
Acquisition backends are fact serializers.
They emit every traversed node at raw traversal depth with its reported frame.
`SnapshotAcquisition` carries the viewport.
The fold returns a typed carrier with both values: reported geometry and effective geometry.
`raw.rect` remains runner-internal reported geometry.
Regular presentation writes the carrier's effective rectangle through the existing wire `rect` field.
Raw projections and direct single-element reads retain reported geometry.

For every backend, `presentRegular` runs the one visibility interpreter, which includes:

- Viewport ∩ scroll-container clip.
- The ancestor projection cursor.
- The sub-pixel decoration rule.
- Hidden-content hints booked onto scroll anchors.
- Reparenting of survivors with collapsed depth.

With the cursor, an out-of-clip Cell or scroll container hides descendants whose clamped frames would otherwise leak back into the viewport.
The fold also narrows the emitted `hittable` to the clip.
Nothing outside its clip, and nothing without geometry, is ever hittable, regardless of what a backend reported.
Platform differences are a `SnapshotFoldPolicy` input to the shared algorithm, never a backend exception.
iOS is cursor-projected.
macOS/tvOS use plain viewport intersection.

Before it constructs `SnapshotPresentation.PresentedNode`, the presentation owner validates every framed regular node against its cumulative effective clip.
Frameless and degenerate semantic carriers stay eligible but are never actionable.
Raw projection remains exempt by contract.
Overflow in acquired geometry is clipped to the cumulative visible area.
Fully outside framed elements are omitted.
The presentation result carries one aggregated `regular-geometry-clipped` quality note with clipped and dropped node counts.
Clipping notes are published as `snapshotQualityNotes` independently of the capture verdict.
A producer without a capture verdict does not receive an invented state or backend.
Clipping does not change a healthy capture into a recovered or sparse capture.
The blocking system-modal probe uses this presenter instead of publishing reported frames as regular output.
Raw system-modal captures retain reported geometry.
A violation in already-presented geometry remains a typed `IOS_SNAPSHOT_PRESENTATION_FAILED` capture failure with the named `presentation-failed` snapshot-quality reason.
The host validator retains its cumulative-clip check.
Decision history: #3801 permits acquisition overflow from system alerts at large Dynamic Type sizes and requires clipping with a typed quality note instead of capture failure.

Inside the runner, the viewport is a declared fact, not a rectangle.
`SnapshotViewport` has the cases of the host's `IosViewportEvidence` (#2891):

- `reported(box, interfaceOrientation)`.
- `derived(box)`.
- `missing(reason)`.

Only `reported` carries an orientation, so only it can anchor a rotation in `SnapshotGeometrySpace`.
If the viewport has no box, the clip is skipped, and the cumulative-clip invariant has no root clip to violate.
If the viewport has no box, a node whose actionability depends on containment has no wire `hittable`, as on the host bridge.
Disabled or degenerate nodes stay declared `false`.
A rectangle becomes a `Box` only through the initializer that checks it.
The shared guard refuses `CGRect.infinite` by identity.
The components and the extents of that value are all finite, so no comparison would have caught the value that a failed read leaves behind.
The Swift guard and the TypeScript guard both refuse two shapes: `CGRect.infinite`, and finite components whose right or bottom edge overflows.
Every box that either guard accepted before #2908, and that is neither of those two shapes, is still classified the same way.
The runner route's host evidence comes from the payload's root nodes (`resolveIosViewportEvidenceFromRoots` in `packages/capture-kit/src/ios-snapshot-acquisition.ts`).
`contracts/fixtures/snapshot-actionability-policy.json` pins the predicate for shapes that the 320x240 fold fixture cannot reach.

A regular `--depth` request is a presentation cut, not an acquisition bound.
`CaptureHint` keeps raw traversal depth (`--raw --depth`) separate from regular presented depth.
However, the recursive tree walk no longer reads presented depth (or any geometry) while it descends.
For a regular capture, it enumerates the hierarchy, and a runaway node cap bounds the walk (#1105, #1156).
It serializes each node at reported traversal depth with the frame that the platform reported.
The change in #2661 also removed the per-node coordinate space (`geometrySpace` / `parentIsWindow`) that #2612 had threaded through every walker.
The one coordinate-space decision is now a single post-acquisition pass over the flat array.
That pass (`SnapshotGeometrySpace.normalized`, run in `captureWithBackend`) keys on ancestry instead of a value carried down the stack.

That pass is why the earlier visible-depth frontier was removed.
The frontier consulted the shared fold during the walk.
A post-walk normalization pass cannot feed a decision that the walk has already taken.
The fold would read reported geometry.
Thus, a turned keyboard band in the device's native space could be cut at the wrong presented depth before the pass ran.
With the frontier gone, no acquisition-time decision reads geometry.
The walk is bounded only by raw traversal depth and the node cap.
The visibility fold and the presented-depth cut both happen inside `SnapshotPresentation`, on the normalized array, at `maximumDepth`.

The frontier only engaged when a presented depth was set (`snapshot --depth N`).
`snapshot -i` carries no presented depth.
Thus, `snapshot --depth N` is the route whose cost the change could move.
Measurements on that route used the recursive tier, 15 warm captures per cell, against `main` on the same simulator:

- Form: 135 raw nodes, 4 or 6 presented.
- Scrolled catalog list: 279 raw nodes, 4 or 6 presented.
- Acquisition p50: within ±4 % of `main`, with mixed sign.
- Acquisition p95: within ±7 % of `main`, with mixed sign.

On the measured branch, both screens walk their whole raw tree, where `main` pruned it at the presented depth.
The walk runs over an `XCUIElementSnapshot` tree that the platform has already materialized in one call, which is where acquisition time goes.
The node construction that the frontier saved is not measurable on these trees.
Screens that recover to private AX are not affected.
The bound that remains is the raw node cap.
De-duplication drops a repeated node and re-parents its children onto that node's own parent.
Thus, identical rows collapse under one addressable owner instead of a subtree split across two nodes with the same identity.
Scoped captures remain broad because depth is relative to the scope root selected in presentation.

Backend capability declarations are part of the contract.
They describe how much acquisition work a regular depth request bounds, never whether the backend may answer it.
Every backend serves a regular `--depth` request because presentation applies the presented-depth cut to whatever hierarchy was acquired.
The recursive tree and private AX both enumerate their hierarchy and are cut afterwards (`presentation-cut`).
The flat query sweep has only its root and one presented level.
Thus, a cut past depth 1 returns the sweep unchanged (`flat`).
Completeness below an acquisition cap is disclosed in the same way as for an unscoped capture, through `truncated` and `effectiveDepth`, because a depth-capped regular capture is a subset of the unscoped capture from the same backend.
A refusal of the request instead produced no answer at all.
A plan pinned or deferred to private AX fell through to the synthetic sparse root, which the daemon then rejected as a missing viewport (#2403).
Raw depth remains acquisition depth for every backend.

Acquisition-side limits remain explicit:

- Raw private-AX captures still disclose their bridge-side node cap.
- The flat query sweep still drops frameless elements because it has no hierarchy to attach geometryless semantics to.
- The recursive tree still has no raw-depth extension for deep XCTest trees.

Presentation cannot repair any of those acquisition limits.

When maintainers add new iOS snapshot behavior, they should first decide which strategy owns it.
A change probably crosses strategy boundaries if it tries to make regular snapshots fast by dropping visible controls behind a node budget.
A change also probably crosses strategy boundaries if it tries to make raw snapshots safe by silently truncating them.

## Amendment: in-place system surfaces (issue #2438)

A system bundle presents some UI outside the app's process.
For example, `com.apple.SafariViewService` hosts `ASWebAuthenticationSession` and `SFSafariViewController` for delegated OAuth/OIDC sign-in.
Two facts, both verified live on the iOS 26.2 Simulator, decide how such UI is captured:

- **The surface dies if activated.** `XCUIApplication.activate()` or `simctl launch` on the host cancels the authentication session and makes the view black.
  Thus, the host must be observed and operated **in place**, never activated.
  `open` refuses to launch a registered host.
- **The local host AX bridge cannot see the surface.** While the sheet is up, the app remains the AX `primaryApp`.
  Thus, the bridge serves the (occluded) app tree as if it were healthy.
  Only the XCTest runner, which addresses the host by bundle id, can read and operate the sheet.

Decision. A closed registry names these hosts (`contracts/fixtures/ios-system-surface-hosts.json`).
The TypeScript and Swift registries mirror it under a parity test.
When a registered host is genuinely presented, the runner serves and operates it in place.
The runner never adopts the host as the cached session target.
The session binding stays on the app.
Thus, after the surface is gone, the next command resolves back to the app.
On the Simulator, the route first asks a ready runner for the `XCUIApplication.state` of every registered host.
This is the same foreground predicate that the runner uses to serve a surface in place.
If every host reports a state other than foreground, the capture stays on the bridge.
A host process outlives the surface it presented.
For example, password AutoFill at sign-in leaves `SafariViewService` running for the rest of the session.
If a host reports foreground, the capture goes to the runner.
The read never starts or replaces a runner.
If no runner is ready or the read fails, a device-scoped host-side probe checks for a registered host process that runs for the device.
If such a process is running, the capture goes to the runner.
If no such process is running, the capture stays on the bridge.
If the probe cannot answer, the capture goes to the runner with the reason `system-surface-probe-unavailable`.
The runner read comes first because the probe spawns processes on every capture.
Rejected: remembering a lingering verdict per host process. One process can present again.

A presented surface also takes precedence over an explicitly requested bundle id.
The runner checks for a presented host before it resolves or activates `command.appBundleId`.
Thus, a command that names a *different* app still receives the sheet.
This is intentional.
The sheet occludes the screen, so the named app has nothing readable under it, and the capture discloses which surface it describes.
After the sheet is gone, this costs nothing, because the session binding never moved.

Presence is `XCUIApplication.state == .runningForeground`, not tree content.
The live experiment showed a torn-down host that still served a *richer* tree than a live host.
Thus, content heuristics cannot separate a live host from a dead host, but foreground state can.
A host can be foreground with a stale tree only if it was activated or relaunched.
The open guard and the in-place policy both refuse those operations.
Thus, this fix and the never-activate guard are one design: the guard makes the foreground predicate sound.
Because the session never binds to the host, issue #2438's second bug cannot occur for the delegated-auth flow.
That bug was a stale tree served confidently after teardown.

Captures of a system surface carry a response-level `systemSurface` provenance and the shared `iosSystemSurfaceDisclosure`, worded per host kind.
Thus, the agent is told that the controls belong to a system sheet (web sign-in, Apple Pay) instead of the app.
These captures are also lineaged to the host instead of the app.
Thus, their comparison identity differs from an app capture's identity by construction.
Every consumer that asks "are these two captures the same presentation" refuses a cross-surface pair through ordinary key equality.
No comparison site carries a surface check of its own.
Physical devices always use the runner, so the in-place serve applies there without a route change.
The Simulator route probe is the only Simulator-specific piece.

The Apple Pay host (`com.apple.PassbookUIService`) joined the registry for text entry as much as for snapshots.
Its billing, shipping, and contact forms hold text fields that the session app's tree cannot resolve.
A bare `type` addressed to the app process never sees that keyboard.
When the runner addresses the host in place, its first-responder route can type into those fields.
No text-entry branch changed for it.

## Amendment: the coordinate space of a captured subtree (issue #2612)

Some system surfaces keep their geometry in the device's native (portrait-up) space while the app is rotated.
Their *whole subtree* arrives turned with them.
A measurement used iPhone 17 Pro (iOS 26.2) with the system keyboard up over a landscape app frame `(0,0,874,402)`:

- `UIRemoteKeyboardWindow` reports its own box as `(0,0,402,874)`, which is the app's box with its two side lengths swapped.
- The app's own window and `UITextEffectsWindow` both report `(0,0,874,402)`.

In portrait, the two spaces coincide and nothing is turned.
Nothing but that box says which space a subtree reports in.
From the numbers alone, a consumer cannot tell a keyboard across the bottom of a landscape screen from a strip down its left edge.
Thus, the consumer refused app content far from the keyboard and let a tap land on a key.

Decision. One published capture publishes one space: the app's orientation space.
The producer settles the space where the platform's frame is still the platform's frame.
The reason is that downstream of the capture, the question cannot be answered: a merged tree carries no axis that a reader could turn geometry against.
A window declares the space of its own subtree from its own box.
That box is either the app's box or that box turned through a quarter.
Anything that is not a window inherits the space of the window above it.
A published rect and the actionability verdict read from it come from the same oriented frame.
Thus, an address and the permission to tap it cannot disagree.

In some cases, no space can be named:

- No usable app frame exists.
- The platform did not report an interface orientation.
- The app frame is square enough to be indistinguishable from its own quarter turn.

In these cases, the capture publishes what the platform reported instead of guessing a rotation.
Consumers fail open on that geometry, as they do on any missing platform fact.
Detection and the way back share one rotation table with synthesized dispatch.
That table is pure geometry that lives in the `AgentDeviceSnapshotPresentation` package (`SnapshotCoordinateSpace.swift`), not in the XCTest bundle.
Both languages replay it against `contracts/fixtures/window-coordinate-space.json` in the ADR 0011 parity-table shape.
This replay stops capture from turning back with anything other than the exact inverse of what dispatch turns forward.

Decision. A producer that cannot name the app's interface orientation refuses the screen instead of publishing two spaces in one tree.
The Simulator AX bridge cannot name that orientation.
The #2659 spike (verdict on that issue, write-up in the diff of #2667) measured these facts:

- The one AX attribute for it, `XC_kAXXCAttributeApplicationOrientation` (id 1503), resolves but reads 0 through the guest's snapshot channel.
- Through XCTest's own reader, that attribute errors with `kAXErrorServerNotFound`.
- The only cheap service read is *device* orientation, which diverges from the app's orientation on a rotation-locked app.

Thus, the bridge's decoder counts window roots that report the app's box quarter-turned.
It fails that capture (`window-coordinate-space-unresolved`, kind `unsupported`).
This is the same refusal shape as `remote-content-boundary` above.
The route then serves the runner, which reads the orientation.
A mixed tree is not half-usable.
A published rect is an address.
After some rects in a tree answer to a turned axis, no pair of rects in that tree can answer "how far apart are these" any more.
Thus, every downstream consumer would have to know which windows to distrust.
The capture could have applied that rule and did not.
The refusal costs one runner round trip and is correct.

Decision. That refusal is scoped to the capture, not to the app generation.
The generation circuit is for failures that are evidence about the app.
A web-view screen is a property of a hybrid app, so its screens keep the runner until the app relaunches.
A rotated surface is evidence about the screen in front of the reader and about nothing else.
It is up now and gone after the next keystroke.
If the refusal retired the generation, every later portrait capture of a healthy app would move to the runner because of one landscape keyboard.
That is the cost that #2491 settled for a bridge that was only still in preparation.
Which side of that line a failure falls on is a declared property of its code, not a judgment made at the call site.
The foreground-ownership refusals (`foreground-owner-unverified`, `foreground-owner-changed`) are on the capture side of that line.
Another surface owns the foreground, such as a permission alert over the app or the app's own launch transition.
That is evidence about the screen.
When the refusal retired the generation, one alert sent every later capture of the app to XCTest, which costs seconds per capture on a deep tree.
The cost of capture scope is one refused bridge request on each capture that the other surface covers.

The rest of this section states what stays unnormalized, and why the consumer rule stays.
The runner's recursive-tree capture now answers the keyboard with a measured band instead of a rebuilt band.
The reason is that the same run that owns the tree can ask `app.keyboards` and gets an answer in the app's own orientation space (#2660).
This closes the keyboard question on the path that used to depend most on this ADR's geometry.
It is also why the guard's landscape refusals no longer depend on whether the tree arrived turned.

Capture still settles the space in ONE pass over the flat acquired array.
`SnapshotGeometrySpace.normalized` runs once in `captureWithBackend`, between acquisition and presentation (#2661).
The pass keys on each node's `type`, `parentIndex`, and `rect`.
The runner's query-sweep tier still has no window ancestry, so nothing in its tree declares a native space.
Its flat children hang off a synthetic application root that reports the app's own box.
That root reports the box under an interface orientation that the tier does not read.
Thus, the pass returns that tree exactly as reported.
This is a structural consequence of the same rule applied uniformly.
It is not the per-tier omission that a hand-threaded space would have made it.

The provider producers (`appium-source`, `limrun-ios-tree`) never see the app's windows either.
A capture from any of them publishes no keyboard fact.
A consumer reads that silence as "this producer did not measure".
Those paths publish what the platform reported.
Thus, the last reader that can still refuse geometry that it cannot place is the tap-path keyboard guard, and its width rule therefore remains.
The rule detects un-normalized arrival, not a standing fact about iOS.
The producers that the earlier sections of this ADR describe do normalize.
A band taller than it is wide is what the output of a producer that did not normalize looks like.

## Amendment: modal containment in the presentation cut

The bridge reads one window and reports every container attached to it.
XCTest's own queries answer only the presentation that the user can reach.
React Navigation's card-plus-modal example is the measured case.
Three routes presented as sheets left three transition-view containers in one window.
One capture published 567 nodes across three screens.
The same app state under the runner published 76 nodes across the top screen alone.
Maestro's visibility test is geometric.
Thus, a `tapOn` resolved the covered screen's button, and the flow failed on an assertion about the screen that never arrived.
Also, the fields of a `presentation: "formSheet"` route matched intermittently (#2638).

Decision. The fold applies modal containment when all of these conditions are true:

- The last transition view under a container carries UIKit's dimming view as its direct child.
- The producer reports that the dimming view takes touches (`userInteractionEnabled: true`).

Then the fold cuts the earlier transition views whose frame that dimmed area spans.
It cuts them, with their subtrees, from the regular and interactive projections.
Every part of the claim is a producer fact, not a guess from order:

- The dimming view is UIKit's own declaration that it dims what sits behind it.
- Its interaction state says whether a touch there reaches what sits behind it.
- Its frame is the producer's rectangle, which is what a covered container must be inside.

These cases keep today's behavior:

- A presentation with no dimming view.
- A dimming view that the producer did not read.
- A dimming view that the producer reports as passing touches through.
- Any container whose earlier sibling is not a transition view.

Containment is asserted only where the producer states it.
Thus, the rule fails closed instead of guessing which siblings are shadows.

A sheet that rests at an undimmed detent is why the interaction state is part of the claim.
UIKit `largestUndimmedDetentIdentifier` and react-native-screens `sheetLargestUndimmedDetentIndex` configure such a detent.
UIKit keeps the dimming view in the tree at the same window-sized frame, and the presenting screen stays reachable.
In react-navigation's form-sheet example, a press on the presenting screen's `Height Steps` button navigates while the `Custom Dimming` sheet rests at its smallest detent.
The bridge reports that dimming view as `userInteractionEnabled: false`.
It reports `true` for the dimmed form sheet and for the card modal.
No attribute that the bridge already read told them apart.
`XC_kAXXCAttributeIsVisible` cannot tell them apart either.
It reads false for the undimmed sheet's dimming view and for the card modal's dimming view.

The bridge reads the attribute for dimming views alone, in one follow-up read per view.
A request for it on every node increased the capture time by about half on a 492-node tree.
The targeted read did not change the capture time.
Every source that the cut removes is counted in the presentation's `stats.modalContainedNodeCount`.
Per ADR 0026, that count is internal evidence, never wire vocabulary.
The count exists because otherwise the same screen on either side of an animation moves hundreds of comparable lines with nothing to attribute them to.

The neighboring seams do not fit this rule:

- The semantic presentation rules (`IOS_PRESENTATION_RULES`) run only for the interactive projection. Thus, a suppression rule there could not deliver the same claim to a regular `snapshot`.
- The regular eligibility table is pinned against its Swift twin. Thus, a wider table would move a cross-language contract that this rule does not touch.
- The occlusion pass *marks* a node covered and keeps it published. Visibility filtering reads geometry, not the mark. Thus, a published-but-marked node is exactly the 567-versus-76 divergence that this rule fixes.
- A cut at acquisition would leak the decision into `--raw`, which owes the reader the tree that the platform reported.

Raw therefore still carries the covered screens.

Producers that report no UIKit class names or no dimming-view interaction state never trigger the cut.
That is a fact about their output, not a backend exception in the fold:

- The runner already omits modal-contained content from its own queries.
- `appium-source` and `limrun-ios-tree` report element types and no classes.
- The macOS desktop surface arrives already presented.

A scope that names a modal-contained screen now publishes an empty projection.
That is the same healthy empty answer that any other unmatched scope gives, because the screen is not what is presented.

## Amendment: iPad Simulators (issue #3844)

An iPad Simulator runs the iOS Simulator runtime that the bridge reader is built for.
On XCTest, a deep UIKit tree on an iPad Simulator can keep a long session in private-AX fallback.

Decision. The bridge serves iPhone and iPad Simulators.
tvOS and visionOS Simulators, the macOS host, providers, and physical devices keep XCTest.

Two iPad facts change what the bridge reports.

The iPadOS floating tab bar draws each item as a collection-view cell that holds an item view.
Neither node carries the button trait.
Both nodes carry the private tab-button trait (bit 28).
XCTest types an element with that trait as `Button`.
The decoder does the same.
Otherwise, a `role=button` tab selector that matches the runner tree does not match the bridge tree.

The snapshot API reports the frames of a windowed app relative to its window, not to the screen.
Windowed Apps and Stage Manager both put an app in such a window.
A tap at a published point then misses the app.
The guest compares the AXRuntime frame of the primary app with the frame of the system app.
Both frames use the native space of the screen, also in landscape.
If the frames differ, the guest refuses the capture (`app-window-not-full-screen`) before acquisition.
This refusal provides evidence about the screen arrangement, not the app, so it has capture scope.
If the runtime cannot report either frame, the guest keeps the capture.

The XCTest fallback is not correct for a windowed app either.
The runner clips window-relative element frames against the screen-relative app frame.
That is a runner gap.
It is not a reason to publish a bridge tree that is known to be wrong.

Rejected alternatives:

- Move the tree by the window origin. The bridge would then be the only correct producer for a windowed app. The keyboard window and alerts were not measured in that mode, so the refusal stays until they are.
- Read the screen size on the host from the device type profile or from `simctl io`. That adds a host process and a format that Apple does not document. It also does not give the window origin.
