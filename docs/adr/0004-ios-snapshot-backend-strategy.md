# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted.

Completed process history is in git history.

The Apple platform runtime owns acquisition routes and its generation-scoped XCTest fallback.
`@agent-device/capture-kit` owns host-side iOS validation, semantic presentation, and publication.
Structured snapshot quality verdicts and fallback warnings expose degraded or recovered output through the complete path.

## Rules at a glance

- For eligible local iOS Simulator snapshots, use host AX acquisition and shared TypeScript presentation.
- If bridge acquisition or presentation fails, use one typed XCTest fallback.
- After an app-specific failure, disable the bridge for that app generation. A new generation enables it again.
- Keep screen-specific coordinate-space refusals scoped to the capture.
- Keep regular visibility and raw diagnostics as explicit public strategies.
- Regular snapshots must not omit visible controls through an arbitrary node-count cutoff.
- If raw output exceeds transport capacity, fail explicitly instead of silently truncating it.
- New host-side consumers must use the snapshot policy facet.
- Acquire raw facts. Apply visibility, eligibility, scope, and regular depth in presentation.
- Observe registered system surfaces in place. Never activate them.

## Context

Agent Device exposes iOS UI state through host AX acquisition on local Simulators and the long-lived XCTest runner elsewhere.
The snapshot surface has two durable needs:

- Regular context for agents: effective user-visible UI, fixed controls such as tab bars, and hints about content outside visible scroll containers.
- Rich diagnostics and selector disambiguation: raw recursive XCTest snapshots that preserve hierarchy, static text, wrappers, scroll containers, and ancestry.

These needs should not use one capture strategy without distinction.
Recursive `XCUIElement.snapshot()` provides rich data.
However, some real app trees cause `kAXErrorIllegalArgument` or main-thread timeouts while the app remains visually usable.
Bluesky is the current known example.
Lower-level accessibility services can describe simulator screens even when recursive XCTest snapshots and typed `XCUIElementQuery` enumeration return no useful child nodes.
Physical iOS devices can have the same XCTest accessibility-channel timeout without an available lower-level semantic backend.

Presentation filters cannot correct this failure.
The daemon's snapshot presentation can hide noisy or inaccessible nodes.
It cannot recover nodes that XCTest never returns.
More filters, Maestro-specific heuristics, or daemon retries would only make the failure slower and less predictable.

## Decision

Keep XCTest as the iOS automation runner.
Route eligible local iOS Simulator snapshots through the host AX bridge.
Present them once through the shared TypeScript engine.
If bridge acquisition or presentation fails, use one typed XCTest fallback.
After fallback, disable the bridge for that app generation, subject to the capture-scoped exception below.
A new app generation enables it again.
Physical devices, providers, custom-action captures, and interactions retain their existing owners.

A WebKit page in Safari or a `WKWebView` runs in a WebContent process.
Its connection to UIKit's tree is an `AXRemoteElement` under the web view.
Its children remain in the other process.
The bridge reads one process, so it returns the element as a leaf.
If that leaf has a `WebView`-typed ancestor and reaches the viewport, the source refuses the tree with `remote-content-boundary`.
Otherwise, published refs would target host views around the page instead of the page.
A zero-area or offscreen leaf cannot contain visible content omitted by the capture, so the source publishes it.
If the leaf reports no frame, the source refuses it because no fact proves it empty.

A scene-hosted remote view controller, such as a share or action extension, uses the same structure.
It presents an `AXRemoteElement` leaf under a `_UISceneHostingView`.
The extension's controls remain in its own process.
The source refuses this leaf under the same rule.
Remote elements under other hosts remain unclassified because no capture has shown them.
If a node or depth cap removes the host, the capture continues to disclose truncation.
XCTest resolves remote elements, so the fallback serves the page or extension (#2484).

This refusal opens the generation circuit because it provides evidence about the app.
After a hybrid app shows one web screen, its remaining native screens use XCTest until relaunch.
This is the 0.20.x path for every screen.
A bridge attempt on each capture would add a refused round trip to every `wait` poll on the web screen.
The circuit limits this cost to one capture per generation.
A screen-specific refusal instead has capture scope.
The coordinate-space amendment below defines that case.

Keep the two public snapshot strategies explicit:

- **Regular visible strategy**: use recursive XCTest snapshots.
  Emit the effective user-visible tree, visible ancestors, and scroll-hidden hints.
  If XCTest returns sparse output, use the capture plan's fallbacks.
  A node inside a scroll container is user-visible only if it intersects the app viewport and nearest visible scroll container.
  Offscreen descendants should be visited to set `hiddenContentAbove` / `hiddenContentBelow`.
  They should not be emitted as normal visible nodes.
  This strategy must not use an arbitrary node-count cutoff.
  Fixed controls late in traversal, such as bottom tab bars after long lists, belong to the visible UI contract.
- **Raw diagnostic strategy**: use recursive XCTest snapshots for raw snapshots, diagnostics, and cases that require hierarchy.
  Raw output may be noisy and large.
  If the transport cannot carry the response, fail explicitly.
  Do not silently truncate the tree at a hard node count.
  If XCTest reports a real AX serialization failure, preserve the error instead of reporting an empty UI.
- **Host AX strategy**: acquire local Simulator trees as raw facts through the bounded host bridge.
  Before publication, pass every result through the same presentation boundary.
  XCTest fallback carries explicit source residue.
  Comparisons require matching producer, intent, app generation, presentation key, and residue.
  Physical devices should use an equivalent non-XCTest semantic backend only if Apple exposes a supported channel.

The daemon should expose degraded output.
If an iOS interactive snapshot contains only the application root or another sparse shape, return a structured quality verdict and warning.
Thus, agents can distinguish degraded output from proof that a screen has no controls.

## Host-side ownership boundary

The shared TypeScript side has one snapshot-presentation facet.
`@agent-device/contracts/snapshot-presentation` owns the neutral acquisition-to-presented carrier and clip-fold geometry contract.
`@agent-device/capture-kit` owns these host-side iOS responsibilities:

- Plans.
- Clip fold.
- Projection.
- Eligibility.
- Semantic compaction.
- Validation.
- Publication.

Platform-specific presentation adapters retain only policy mechanics that cannot yet cross their runtime boundary.
Daemon assembly owns only the order of capture, compaction, occlusion, and ref publication.
It does not own the presentation vocabulary or a second geometry carrier.

Android acquisition remains in its platform module and adapts its raw hierarchy to the shared carrier.
Swift retains its runner-side `SnapshotPresentation` implementation because it consumes the capture-plan tier before the process boundary.
The iOS engine fixture provides shared proof between these runtimes.
It does not imply a shared implementation between Swift and TypeScript.
The macOS XCTest runner is the desktop-surface exception.
Its already-presented nodes bypass the iOS presentation engine and continue through neutral snapshot assembly.

The host-side facet in `@agent-device/capture-kit` owns snapshot policy generally, including the three remaining Wave 4 policies tracked by #1983:

- **Freshness recovery.** `packages/capture-kit/src/snapshot/snapshot-freshness/` owns the freshness window, Android staleness classification, its thresholds, and the retry loop.
  A classifier and retry schedule parameterize the loop.
  Thus, the permitted backend delay after a real transition is a policy input, not a loop-owned constant.
  The schedule states a duration budget.
  The loop derives the deadline from the window's `markedAt`.
  Thus, the budget starts at the action, and callers cannot supply an incorrect absolute instant.
  `packages/daemon/src/core/session-snapshot-freshness.ts` retains only session-dependent operations.
  It reads and retires the window on store-owned `SessionState` and selects the comparison baseline from snapshot lineage.
  It remains the declared R7 owner of `androidSnapshotFreshness`.
- **Timeout evidence.** The deepest boundary with evidence classifies a hierarchy timeout once, from machine-defined values only.
  `snapshot-capture-failure-reason.ts` maps the helper's structured `errorType` and SIGKILL exit code 137 to `accessibility-timeout`.
  The `errorType` match requires exact equality with `java.util.concurrent.TimeoutException`.
  `ANDROID_CAPTURE_FAILURE_REASONS` in `@agent-device/contracts/android-snapshot-quality` defines the typed reason.
  The helper-result, session-protocol, and killed-instrumentation error constructors attach it.
  Each higher layer preserves it in its wrapper instead of reclassifying it.
  No layer on this path examines message text.
  Changes to helper or wrapper prose cannot change the reason.
  Text that resembles a timeout does not create that reason.
  End-to-end assertions against the real producer verify both properties.
  `packages/capture-kit/src/snapshot/snapshot-timeout-policy.ts` reads the reason and derives the human-facing hint from it.

  `@agent-device/contracts/snapshot-timeout-evidence` owns the published `details.androidSnapshotTimeoutScreenshot` vocabulary.
  Its union members encode which claims can coexist.
  The annotated member carries a non-empty ref tuple, so callers cannot construct an annotation with zero refs.
  No member stores a ref count.
  A separate count would create a second source of truth that types cannot keep consistent.
  Instead, the count is derived from the refs.
  The daemon retains this required order:

  1. Resolve a bound screenshot runtime.
  2. Write the artifact.
  3. Annotate it from the stored observation.
  4. Emit the diagnostics.

- **Screenshot-overlay policy.** `packages/capture-kit/src/screenshot-overlay*.ts` decides which Android nodes receive an overlay ref and which rectangle the overlay covers.
  The daemon retains only approved artifact and ref assembly: rank, projection to screenshot pixels, drawing, and PNG IO.

`scripts/layering/snapshot-presentation-boundary.test.ts` enforces the dependency direction across roots declared by `snapshot-policy` in `scripts/layering/architecture-ownership.ts`.
Nothing in that snapshot tree may import `packages/daemon/src/`.
Overlay modules beside the tree are outside those roots and outside that gate.
The test has a positive control.
Without it, a filter that stopped matching would appear identical to a respected boundary.

The residual call sites named by #1983 remain intentionally in place after an audit.
`packages/daemon/src/core/direct-ios-selector.ts` contains no presentation policy.
`isLocalIosRunnerSession` and `readSimpleIosSelectorTarget` route sessions by device family, provider ownership, and stabilization window.
`deriveDirectIosNodeSelector` and `isDirectIosSelectorFallbackError` provide selector derivation and ADR 0011 delegation-on-error.
The latter two are pure and daemon-independent.
However, R19's selector pipeline would own them, not this facet.
A move under ADR 0004 would extend this ADR beyond its boundary.
These observation and interaction consumers access freshness only through the facet or its session binding:

- `selector-capture-runtime.ts`.
- `deferred-interaction-outcome.ts`.
- `snapshot-capture.ts`.
- `interaction-touch-android-freshness.ts`.

New consumers must use the facet instead of another daemon presentation path.

The acquisition/presentation boundary has two explicit vocabularies.
An acquired input contains raw node evidence, capture hint, viewport, lineage, and residue.
The host engine folds and projects that evidence.
A presented input contains the runner's primary payload and validation facts.
The host engine validates it and performs semantic compaction once.
Regular eligibility determines membership in regular presentation.
Publication adds refs and emits only the primary payload.
An optional unscoped quality payload is validated as classification evidence and is never published.

Semantic compaction may move an identifier but may not delete its identity.
A structural `Other` wrapper with only an identifier is suppressed in favor of its content.
The content receives the identifier through delegation.
If the wrapper has no content, no recipient exists.
Its suppression would delete the identifier from every canonical view while `is`, `get`, and `click` still resolve it from the same capture.
That deletion requires the node's own declared `hittable: false`.
Only this verdict states that the wrapper is inert.
A producer that reports no hittability declares nothing.
An absent fact is not a negative answer (#2638).

## Regression Notes

PR #639 made XCTest AX serialization failures explicit instead of returning empty snapshots.
This diagnostic behavior is correct, but it exposes apps whose accessibility trees XCTest cannot serialize.
Recovery belongs in the regular visible capture plan.
Healthy apps retain the fast recursive tree path.
When only fallback tiers can provide visible controls, degraded app classes can return bounded output with explicit limits.

Issue #1105 identifies another failure in the same app class.
On large or animated screens, recursive capture can take many seconds before failure instead of immediately returning `kAXErrorIllegalArgument`.
This can exceed the runner's main-thread watchdog and fill the main queue with retries.
The plan passes its shared deadline to the query-sweep and private-AX tiers.
After the budget expires, later recovery tiers stop.
A slow, timed-out, or watchdog-abandoned XCTest capture penalizes that bundle's XCTest accessibility channel for a bounded window.
Subsequent regular plans derive their next step from backend traits through `effectiveSnapshotCapturePlan`.
If a runnable non-XCTest backend exists, the plan uses that independent tier.
Otherwise, as on current physical iOS devices, it uses a short XCTest probe instead of the full tree slice.
Thus, healthy screens can recover without another long capture of the failing screen.
The raw diagnostic plan is exempt and retains tree-first error propagation.

The query-sweep tier has 19 `allElementsBoundByIndex` reads.
Each can fail with `kAXErrorIllegalArgument` on the same app class.
XCTest records each as a test failure worded `Failed to resolve query: ...`.
An unmuted failure ends `testCommand` when its main-thread block returns, regardless of `continueAfterFailure`.
A runner exit also loses the per-bundle penalty and depth memory.
Thus, the runner mutes AX-server rejections in both XCTest fetch wordings.
Each bounded main-thread dispatch that exceeds its slice counts as main-thread occupancy.
If a viewport read takes too long, the plan skips the sweep instead of adding it to the queue.

## Recovery conformance and depth hints

The host AX bridge and the XCTest runner's private AX bridge retain separate recovery implementations.
They use different native representations, recovery tiers, and completeness evidence for rejected deep requests.
`contracts/fixtures/ios-ax-recovery-conformance.json` is their shared executable recovery contract.
Each producer replays every case through its own adapter.
The fixture records per-producer expectations and intentional differences.
Thus, changes to either path use the same synthetic native evidence.
Extract common executable policy only where the fixture proves equivalence.
A shared engine is not a goal.

The host source also retains a bounded accepted-depth hint per resolved target generation and producer.
The hint changes only the native levels requested by the first request.
Only a finished recovery that observed a rejection can establish it.
It expires by hinted-capture count, so ordinary screens probe the full depth again.
It is never shared across apps, generations, or producers.
The route's generation circuit remains the only lifecycle owner.

## Consequences

Regular snapshots remain appropriate for agents and Maestro compatibility because they describe what a user can currently perceive and operate.
Raw snapshots remain appropriate when hierarchy matters.
Both may still fail explicitly on trees that XCTest cannot capture.
This failure is useful because another identical recursive capture is unlikely to return a different tree.

A future AX-service backend is the correct place to restore semantic coverage for apps such as Bluesky.
It should be a platform backend with its own lifecycle, protocol, normalization, timing metrics, and fallback rules.
It should not be another special case inside the XCTest runner.

The acquisition/presentation boundary preserves behavior through types.
Acquisition backends construct `RawAXNode`.
Only `SnapshotPresentation` constructs `PresentedNode`.
Response payloads accept only presented nodes.
Each capture-plan backend returns `SnapshotAcquisition`.
The exhaustive backend switch routes through one `SnapshotPresentation.present` call.
`PresentationOptions` is the stable request-policy input to that boundary.

`SnapshotPresentation` makes regular eligibility backend-neutral.
The top-level viewport carrier survives.
Every other node needs an interactive accessibility type or a non-empty label, identifier, or value.
Hittability does not admit an otherwise ineligible node.
Raw membership remains unchanged.
This is runner eligibility, distinct from daemon publication membership.
Backend-neutral daemon compaction retains ownership of its declared noise suppressions.
If eligibility removes a structural wrapper, presentation attaches surviving descendants to the nearest surviving ancestor.
It normalizes their indexes and depths.

Scope is a presentation specification, not an acquisition or daemon-compaction policy.
A trimmed non-empty scope selects the first presentation-preorder match whose subtree contributes to the requested projection.
The match examines label, identifier, and value without case sensitivity.
The selected subtree receives a new root.
Depth applies relative to that root.
If no match exists, publication returns an empty healthy projection.
`contracts/fixtures/snapshot-scope-policy.json` fixes expectations for Swift and TypeScript implementations.
Scoped iOS acquisition remains broad, including with requested depth, until an adapter can prove a narrowing hint complete.
The daemon never reapplies scope after the wire.
Android selects its root inside TypeScript presentation.
Desktop surface runtimes retain their platform projection.

Presentation has two projections, and acquisition has one input.
`SnapshotPresentation.captureHint` derives a `CaptureHint` from the request.
Backends read the hint, never `PresentationOptions`.
A hint names the projection that acquisition must serve.
It may narrow acquisition only where the backend can prove completeness for that projection.
Scope and its relative depth never narrow acquisition.
Raw depth does narrow acquisition because it is traversal depth.
The raw projection never carries `interactiveOnly`.
`presentRegular` folds visibility, eligibility, scope, and scroll hints.
`presentRaw` returns the normalized acquired tree.
It applies scope and depth only when the request specifies them.
Thus, `interactive ⊆ regular ⊆ raw` holds per backend, independently of implementation.
`snapshot --raw -i` therefore returns the acquired tree without an interactive filter.

Two structural rules prevent a backend from returning the wrong projection.
Without them, a recovered `snapshot --raw` could return viewport-pruned nodes labeled raw.
The raw diagnostic plan derives from `SnapshotBackendKind.supportsRawProjection`, not a manual list.
Thus, a backend without hierarchy, such as query sweep, cannot enter a raw plan.
Presentation compares the requested projection with the acquisition's capture hint.
If they differ, it drops that tier with a structured `IOS_SNAPSHOT_PROJECTION_MISMATCH` failure.
It does not present that tier under the requested label.

The clip fold belongs to presentation.
Acquisition backends serialize facts.
They emit each traversed node at raw traversal depth with its reported frame.
`SnapshotAcquisition` carries the viewport.
The fold returns a typed carrier with reported and effective geometry.
`raw.rect` remains runner-internal reported geometry.
Regular presentation writes the carrier's effective rectangle through the existing wire `rect` field.
Raw projections and direct single-element reads retain reported geometry.

For every backend, `presentRegular` runs one visibility interpreter with:

- Viewport ∩ scroll-container clip.
- An ancestor projection cursor.
- The sub-pixel decoration rule.
- Hidden-content hints on scroll anchors.
- Surviving nodes attached to surviving ancestors with collapsed depth.

The cursor prevents an out-of-clip Cell or scroll container's descendants from reappearing through clamped frames.
The fold also restricts emitted `hittable` to the clip.
Nodes outside their clip or without geometry are never hittable, regardless of backend reports.
Platform differences enter the shared algorithm through `SnapshotFoldPolicy`, never a backend exception.
iOS uses cursor projection.
macOS/tvOS use plain viewport intersection.

Before constructing `SnapshotPresentation.PresentedNode`, the presentation owner validates each framed regular node against its cumulative effective clip.
Frameless and degenerate semantic carriers remain eligible but never actionable.
Raw projection remains exempt by contract.
A violation produces a typed `IOS_SNAPSHOT_PRESENTATION_FAILED` capture failure with the named `presentation-failed` snapshot-quality reason.
Recovery and the existing TypeScript verdict/warning contract preserve that failure.

Inside the runner, `SnapshotViewport` is a declared fact with the same cases as host `IosViewportEvidence` (#2891):

- `reported(box, interfaceOrientation)`.
- `derived(box)`.
- `missing(reason)`.

Only `reported` carries an orientation, so only it can establish a rotation in `SnapshotGeometrySpace`.
Without a box, the clip is skipped, and the cumulative-clip invariant has no root clip to violate.
A node whose actionability depends on containment has no wire `hittable`, as on the host bridge.
Disabled or degenerate nodes remain explicitly `false`.
A rectangle becomes a `Box` only through the validating initializer.
The shared guard rejects `CGRect.infinite` by identity.
Its components and extents are finite, so numeric comparisons cannot reject the value left by a failed read.
Both guards reject that shape and finite components whose right or bottom edge overflows.
They preserve every other box classification that either guard previously accepted.
The runner route derives host evidence from payload root nodes through `resolveIosViewportEvidenceFromRoots` in `packages/capture-kit/src/ios-snapshot-acquisition.ts`.
`contracts/fixtures/snapshot-actionability-policy.json` fixes the predicate for shapes outside the 320x240 fold fixture's range.

A regular `--depth` request cuts presentation, not acquisition.
`CaptureHint` separates raw traversal depth (`--raw --depth`) from regular presented depth.
During descent, the recursive tree walk reads neither presented depth nor geometry.
For regular capture, it enumerates the hierarchy under a runaway node cap (#1105, #1156).
It serializes each node at reported traversal depth with its platform-reported frame.
A single post-acquisition pass over the flat array decides coordinate space from ancestry.
`SnapshotGeometrySpace.normalized` runs in `captureWithBackend` (#2661).
It replaces the per-node `geometrySpace` / `parentIsWindow` values from #2612.

A post-acquisition normalization pass cannot supply normalized geometry to an earlier traversal decision.
Thus, a visible-depth frontier that consults the shared fold during traversal would read reported geometry.
It could cut a rotated keyboard band in native device space at the wrong presented depth.
No acquisition-time decision therefore reads geometry.
Only raw traversal depth and the node cap bound the walk.
Inside `SnapshotPresentation`, visibility fold and presented-depth cut use the normalized array at `maximumDepth`.

The earlier frontier applied only with presented depth, through `snapshot --depth N`.
`snapshot -i` carries no presented depth.
Thus, only the former route could change cost after its removal.
Measurements used the recursive tier, 15 warm captures per cell, and `main` on the same simulator:

- Form: 135 raw nodes, 4 or 6 presented.
- Scrolled catalog list: 279 raw nodes, 4 or 6 presented.
- Acquisition p50: within ±4 % of `main`, with mixed sign.
- Acquisition p95: within ±7 % of `main`, with mixed sign.

The changed walk visits the full raw tree where `main` pruned at presented depth.
The platform already materializes the `XCUIElementSnapshot` tree in one call, which dominates acquisition time.
The saved node construction has no measurable cost on these trees.
Screens that recover to private AX remain unaffected.
The raw node cap remains the bound.
De-duplication drops a repeated node and attaches its children to that node's parent.
Thus, identical rows have one addressable owner instead of a subtree split across duplicate identities.
Scoped captures remain broad because depth is relative to the scope root selected in presentation.

Backend capability declarations describe how much acquisition work a regular depth request bounds.
They never determine whether a backend may answer it.
Every backend serves regular `--depth` requests because presentation cuts the acquired hierarchy.
Recursive tree and private AX enumerate their hierarchy before the cut (`presentation-cut`).
Flat query sweep has only its root and one presented level.
A cut beyond depth 1 leaves the sweep unchanged (`flat`).
`truncated` and `effectiveDepth` disclose completeness below an acquisition cap, as for unscoped capture.
A depth-capped regular capture is a subset of the same backend's unscoped capture.
Refusal previously left a plan pinned or deferred to private AX with only a synthetic sparse root.
The daemon then rejected it for a missing viewport (#2403).
For every backend, raw depth remains acquisition depth.

Acquisition-side limits remain explicit:

- Raw private-AX captures disclose the bridge-side node cap.
- Flat query sweep drops frameless elements because it has no hierarchy for geometryless semantics.
- Recursive tree has no raw-depth extension for deep XCTest trees.

Presentation cannot repair these acquisition limits.

Before new iOS snapshot behavior is added, maintainers should decide which strategy owns it.
A change probably crosses strategy boundaries if it drops visible controls for a regular node budget or silently truncates raw snapshots.

## Amendment: in-place system surfaces (issue #2438)

Some UI appears outside the app's process in a system bundle.
For delegated OAuth/OIDC sign-in, `com.apple.SafariViewService` hosts `ASWebAuthenticationSession` and `SFSafariViewController`.
Two facts verified live on the iOS 26.2 Simulator determine capture behavior:

- **Activation destroys the surface.** `XCUIApplication.activate()` or `simctl launch` on the host cancels the authentication session and makes the view black.
  Thus, the host must be observed and operated **in place**, never activated.
  `open` refuses to launch a registered host.
- **The local host AX bridge cannot see the surface.** While the sheet appears, the app remains the AX `primaryApp`.
  The bridge returns the occluded app tree as healthy.
  Only the XCTest runner can read and operate the sheet through the host's bundle id.

Decision. A closed registry names these hosts in `contracts/fixtures/ios-system-surface-hosts.json`.
TypeScript and Swift registries mirror it under a parity test.
When a registered host is genuinely presented, the runner serves and operates it in place.
It never adopts the host as the cached session target.
The session binding remains on the app.
After the surface disappears, the next command resolves to the app again.
On the Simulator, a low-cost device-scoped host-side probe detects a registered host process for the device.
It routes capture to the runner instead of the bridge.
Without a running host, the bridge fast path remains unchanged.

A presented surface also takes precedence over an explicitly requested bundle id.
Before the runner resolves or activates `command.appBundleId`, it examines whether a host is presented.
Thus, even a command for a different app receives the sheet.
This is intentional because the sheet occludes the screen and leaves no readable content from the named app.
The capture discloses which surface it describes.
After the sheet disappears, no extra cost remains because the session binding never changed.

Presence means `XCUIApplication.state == .runningForeground`, independently of tree content.
The live experiment showed that a stopped host could return a richer tree than a live host.
Thus, content heuristics cannot distinguish live and stopped hosts, but foreground state can.
A host can be foreground with a stale tree only after activation or relaunch.
The open guard and in-place policy both refuse those operations.
The never-activate guard therefore makes the foreground predicate valid.
The session never binds to the host.
Thus, delegated-auth flow cannot retain a stale host tree after teardown, the second bug in issue #2438.

System-surface captures carry response-level `systemSurface` provenance and shared `iosSystemSurfaceDisclosure`, worded for each host kind.
This tells the agent that controls belong to a system sheet, such as web sign-in or Apple Pay, instead of the app.
Their lineage identifies the host instead of the app.
Thus, their comparison identity differs from an app capture's identity by construction.
Ordinary key equality rejects cross-surface comparisons for every consumer.
Comparison sites need no separate surface checks.
Physical devices always use the runner, so in-place behavior applies without a route change.
Only the route probe is Simulator-specific.

The Apple Pay host, `com.apple.PassbookUIService`, belongs to the registry for text entry as well as snapshots.
Its billing, shipping, and contact forms contain text fields absent from the session app's tree.
A bare `type` addressed to the app process cannot see that keyboard.
The runner's first-responder route can type into those fields when it addresses the host in place.
This requires no changed text-entry branch.

## Amendment: the coordinate space of a captured subtree (issue #2612)

Some system surfaces report geometry in the device's native portrait-up space while the app is rotated.
Their whole subtree uses that space.
Measurements used iPhone 17 Pro, iOS 26.2, and the system keyboard over a landscape app frame `(0,0,874,402)`.
`UIRemoteKeyboardWindow` reported `(0,0,402,874)`, with the app's side lengths exchanged.
The app window and `UITextEffectsWindow` both reported `(0,0,874,402)`.
In portrait, the spaces coincide and no rotation occurs.
Only the box identifies the subtree's reported space.
From the numbers alone, consumers cannot distinguish a landscape bottom keyboard from a strip down the left edge.
This caused refusals of uncovered app content and permitted a tap on a key.

Decision. One published capture uses one space: the app's orientation space.
The producer resolves space while the platform frame still has its original context.
After capture, a merged tree has no axis for consumers to rotate against.
A window's own box declares its subtree's space.
That box is either the app's box or its quarter turn.
Non-window nodes inherit space from the window above them.
Published rectangles and their actionability verdicts use the same oriented frame.
Thus, an address and permission to tap it cannot disagree.

When space cannot be identified, the capture publishes platform-reported geometry without an assumed rotation.
This applies when:

- No usable app frame exists.
- The platform does not report interface orientation.
- The app frame is too square to distinguish from its quarter turn.

Consumers fail open on that geometry, as for other missing platform facts.
Detection and inverse normalization share one rotation table with synthesized dispatch.
This pure geometry belongs to `AgentDeviceSnapshotPresentation` in `SnapshotCoordinateSpace.swift`, outside the XCTest bundle.
Both languages replay `contracts/fixtures/window-coordinate-space.json` in ADR 0011's parity-table shape.
This ensures that capture applies the exact inverse of the forward dispatch rotation.

Decision. A producer that cannot identify the app's interface orientation refuses the screen instead of publishing two spaces in one tree.
The Simulator AX bridge cannot identify that orientation.
The #2659 experiment, with verdict in that issue and details in #2667's diff, measured the only AX attribute for it.
`XC_kAXXCAttributeApplicationOrientation` (id 1503) resolves but reads 0 through the guest snapshot channel.
Through XCTest's reader, it returns `kAXErrorServerNotFound`.
The only low-cost service read gives device orientation, which differs from app orientation in a rotation-locked app.

The decoder therefore counts window roots that report the app's box quarter-turned.
It fails that capture with `window-coordinate-space-unresolved`, kind `unsupported`.
This uses the same refusal shape as `remote-content-boundary`.
The route then serves the runner, which reads orientation.
A mixed-space tree cannot provide reliable partial geometry.
Each published rectangle is an address.
If some rectangles use a rotated axis, consumers cannot compare distances between arbitrary rectangles.
Every downstream consumer would need a rule to distrust selected windows.
Capture has the evidence to apply that rule itself.
The refusal costs one runner round trip and is correct.

Decision. This refusal has capture scope, not app-generation scope.
The generation circuit applies to failures that provide evidence about the app.
A web-view screen identifies a hybrid app, so its screens retain the runner until relaunch.
A rotated surface provides evidence only about the current screen.
It can disappear after the next keystroke.
If it retired the generation, every later portrait capture of a healthy app would use the runner because of one landscape keyboard.
Issue #2491 rejected that cost for a bridge still in preparation.
The failure code declares its scope.
Call sites do not decide it independently.

The runner's recursive-tree capture measures the keyboard band instead of reconstructing it.
The same run can query `app.keyboards` and receive geometry in the app's orientation space (#2660).
This resolves the keyboard question on the path most dependent on this ADR's geometry.
The guard's landscape refusals therefore no longer depend on whether the tree arrived rotated.

Capture still resolves space in one pass over the flat acquired array.
`SnapshotGeometrySpace.normalized` runs once in `captureWithBackend`, between acquisition and presentation (#2661).
It uses each node's `type`, `parentIndex`, and `rect`.
The runner's query-sweep tier has no window ancestry, so its tree declares no native space.
Its flat children attach to a synthetic application root with the app's box.
The tier does not read interface orientation.
Thus, the uniform rule returns that tree exactly as reported.
This is a structural consequence, not a tier-specific exception.

Provider producers `appium-source` and `limrun-ios-tree` also do not see app windows.
Their captures publish no keyboard fact.
Consumers interpret absence as a producer that did not measure the keyboard.
These paths publish platform-reported geometry.
The tap-path keyboard guard is the last consumer able to refuse geometry it cannot place.
Thus, its width rule remains.
The rule detects unnormalized input, not a universal iOS property.
The producers described above do normalize geometry.
A band taller than it is wide indicates a producer that did not normalize it.

## Amendment: modal containment in the presentation cut

The bridge reads one window and reports all attached containers.
XCTest queries return only the presentation available to the user.
React Navigation's card-plus-modal example provides measured evidence.
Three routes presented as sheets left three transition-view containers in one window.
One bridge capture published 567 nodes across three screens.
In the same app state, the runner published 76 nodes from only the top screen.
Maestro tests visibility geometrically.
Thus, `tapOn` resolved a covered screen's button, and the flow failed an assertion about a screen that never appeared.
A `presentation: "formSheet"` route's fields also matched intermittently (#2638).

Decision. The fold applies modal containment under all these conditions:

- A container's last transition view has UIKit's dimming view as a direct child.
- The producer reports that the dimming view takes touches (`userInteractionEnabled: true`).
- The dimmed area spans the frame of an earlier transition view.

It removes those earlier transition views and their subtrees from regular and interactive projections.
Each condition is a producer fact, not an assumption about order.
UIKit's dimming view declares what it dims.
Its interaction state states whether a touch reaches content behind it.
Its frame supplies the rectangle that must contain the covered container.
These cases retain existing behavior:

- No dimming view exists.
- The producer did not read the dimming view.
- The dimming view passes touches through.
- The earlier sibling is not a transition view.

Containment applies only where the producer declares it.
The rule fails closed instead of guessing which siblings are covered.

A sheet at an undimmed detent explains the interaction-state condition.
The relevant controls are `largestUndimmedDetentIdentifier` and react-native-screens `sheetLargestUndimmedDetentIndex`.
UIKit retains the dimming view with its window-sized frame, while the presenting screen remains reachable.
In react-navigation's form-sheet example, `Height Steps` on the presenting screen navigates while `Custom Dimming` rests at its smallest detent.
The bridge reports `userInteractionEnabled: false` for that dimming view.
It reports `true` for the dimmed form sheet and card modal.
No previously read attribute distinguishes them.
`XC_kAXXCAttributeIsVisible` also cannot distinguish them.
It reads false for both the undimmed sheet's dimming view and the card modal's dimming view.

The bridge reads interaction state only for dimming views, with one subsequent read per view.
A read on every node added about half the capture time on a 492-node tree.
The targeted read did not change capture time.
Presentation counts every removed source in `stats.modalContainedNodeCount`.
Per ADR 0026, this is internal evidence, never wire vocabulary.
Without it, the same screen before and after animation can change hundreds of comparable lines without attribution.

Semantic presentation rules (`IOS_PRESENTATION_RULES`) apply only to the interactive projection.
A suppression rule there could not provide the same behavior for regular `snapshot`.
The regular eligibility table has parity with its Swift equivalent.
An extension there would change a cross-language contract outside this rule's scope.
The occlusion pass marks covered nodes but retains them in publication.
Visibility filters read geometry, not that mark.
Thus, published-but-marked nodes retain the 567-versus-76 divergence.
A cut during acquisition would affect `--raw`, which must preserve the platform-reported tree.
Raw therefore retains covered screens.
These constraints place modal containment in the presentation cut.

Producers without UIKit class names or dimming-view interaction state never trigger the cut.
This follows from their output facts, not backend exceptions in the fold.
The runner already omits modal-contained content from its queries.
`appium-source` and `limrun-ios-tree` report element types without classes.
The macOS desktop surface arrives already presented.
A scope that names a modal-contained screen publishes an empty projection.
This is the same healthy empty result as another unmatched scope because the named screen is not presented.
