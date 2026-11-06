# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted.
[ADR 0038](0038-snapshot-capture-source-routing.md) owns snapshot source routing for every platform.
Until the router from [#4205](https://github.com/callstack/agent-device/issues/4205) replaces the Apple route, the routing rules here describe the current iOS code.
This record keeps the iOS acquisition, presentation, geometry, and in-place system-surface contracts.

## Context

Agent Device reads iOS UI state through the host AX bridge on local Simulators, through the runner-served bridge on provider Simulators, and through the XCTest runner everywhere else.
Agents need regular context: the effective user-visible UI, fixed controls such as tab bars, and hints for content outside visible scroll containers.
Diagnostics and selector disambiguation need a raw tree with hierarchy, static text, wrappers, and ancestry.
Recursive `XCUIElement.snapshot()` gives that tree, but some real app trees make XCTest fail with `kAXErrorIllegalArgument` or main-thread timeouts while the app stays usable.
Lower-level accessibility services can describe the same Simulator screen.
Presentation filters can hide nodes, but they cannot recover nodes that XCTest never returned.

## Decision

**Two public modes.** The public surface stays two modes: regular interactive snapshots and raw diagnostic snapshots.
The host AX bridge is an acquisition route, not a third public mode.
The regular mode must not use an arbitrary node-count cutoff.
Fixed controls that come late in traversal order, such as a tab bar after a long list, are part of the regular contract.
The raw mode may be noisy and large.
If the transport cannot carry a raw response, fail explicitly. Do not truncate the tree at a hard node count.
If XCTest reports a real AX serialization failure, the raw mode preserves that error instead of reporting an empty UI.
If an interactive snapshot has only the application root or another sparse shape, return a structured quality verdict and warning.

**Acquisition.** XCTest stays the iOS automation runner.
Route eligible local iPhone and iPad Simulator snapshots through the host AX bridge.
A provider iOS Simulator uses the same reader, which the XCTest runner serves through the `snapshotBridge` command.
tvOS and visionOS Simulators, the macOS host, physical devices, custom-action captures, and interactions keep their existing owners.
Physical devices get a non-XCTest semantic backend only if Apple exposes a supported channel.
An observe-only capture skips the route and uses the provider's capture, because it must not activate the app or start work.

**Fallback.** If bridge acquisition or presentation fails, use one typed XCTest fallback.
XCTest fallback carries explicit source residue.
After a fallback, disable the bridge for that app generation.
A new app generation enables it again.
A refusal that gives evidence about the screen, not the app, has capture scope and keeps the generation on the bridge.
A `preparing` failure describes a bridge preparation that is still running, so it sends only that capture to XCTest.
A wedged runner reader (`bridge-reader-wedged`) retires the bridge for the runner session, across app generations.
The runner must not end itself to stop a read, because it also runs every XCTest command.
`contracts/fixtures/ios-snapshot-bridge-refusals.json` is the one table of refusal codes and scopes.

**Refusals.** The bridge reads one process.
If a remote-process leaf (`AXRemoteElement`) under a web view or a `_UISceneHostingView` reaches the viewport, or reports no frame, the source refuses the tree (`remote-content-boundary`).
Refs from that tree would target the host views around the page, and XCTest resolves remote elements (#2484).
This refusal is evidence about the app, so it opens the generation circuit.
The source refuses a bridge capture of an app window that does not fill the screen (`app-window-not-full-screen`).
A producer that cannot name the app's interface orientation refuses a tree with a quarter-turned window (`window-coordinate-space-unresolved`).
These two refusals have capture scope.

**Ownership.** The Apple platform runtime owns acquisition routing and the generation-scoped fallback.
`@agent-device/contracts/snapshot-presentation` holds the neutral acquisition-to-presented carrier and the clip-fold geometry contract.
`@agent-device/capture-kit` owns host-side snapshot policy: planning, folding, projection, eligibility, semantic compaction, validation, and publication.
Daemon assembly owns only the order of capture, compaction, occlusion, and ref publication.
New consumers must use the host-side policy facet in `@agent-device/capture-kit`. Do not add another daemon presentation path.
The Swift runner keeps its own `SnapshotPresentation`, because it consumes the capture-plan tier before the process boundary.
The shared engine fixtures prove that the Swift and TypeScript engines agree. They do not share an implementation.
The macOS desktop surface arrives already presented and skips the iOS presentation engine.

**Presentation.** Acquisition backends serialize facts: every traversed node at raw traversal depth with its reported frame.
Presentation applies visibility, eligibility, scope, and the regular depth cut.
Only `SnapshotPresentation` constructs `PresentedNode`, and backends read only the `CaptureHint`.
A hint narrows acquisition only where the backend can prove the narrowing complete.
A regular `--depth` request is a presentation cut, not an acquisition bound. Raw depth stays acquisition depth.
Comparisons require a matching producer, intent, app generation, presentation key, and residue.
An optional unscoped quality payload is validation evidence and is never published.
Semantic compaction may move an identifier, but it must not delete one.
It deletes a contentless identifier wrapper only when the node declares `hittable: false`, because an absent fact is not a negative answer (#2638).
The fold cuts screens under a modal only where the producer states containment: a UIKit dimming view that takes touches.
The raw projection keeps the covered screens.
[`apple/snapshot-presentation/README.md`](../../apple/snapshot-presentation/README.md) states the detailed presentation and geometry rules.

**Geometry.** One published capture publishes one space: the app's orientation space.
The producer settles the space, in one pass after acquisition, because a merged tree carries no axis that a downstream reader could use.
A window declares the space of its own subtree from its own box. Other nodes inherit the space of the window above them.
If no space can be named, the capture publishes reported geometry, and consumers fail open.
A placed iPad window publishes screen space in points, because its viewport, its screenshot, and the digitizer use that space.
Rotation and translation stay separate rules.
Presentation clips acquired overflow to the cumulative visible area and adds one `regular-geometry-clipped` quality note.

**System surfaces.** A closed registry (`contracts/fixtures/ios-system-surface-hosts.json`) names system hosts that present UI out of the app's process, such as `com.apple.SafariViewService`.
Observe and operate a registered system-surface host in place. Never activate it.
`open` refuses to launch a registered host.
When a registered host is in the foreground, the runner serves and operates it in place.
The runner never adopts the host as the session target, so the next command after the surface goes resolves back to the app.
A presented surface takes precedence over an explicitly requested bundle id.
Presence is `XCUIApplication.state == .runningForeground`, not tree content.
Before a Simulator capture uses the bridge, the route proves for that capture that no host is in the foreground: first from a ready runner's state read, and, when that read cannot answer, from the bridge's own process-table check.
On a local Simulator, the read never starts or replaces a runner.
On a provider Simulator, every capture needs the runner, so the proof starts a runner that is not up yet.
If the proof fails or a host is present, the capture uses the runner, and the app generation stays on the bridge.
A system-surface capture carries `systemSurface` provenance and the `iosSystemSurfaceDisclosure`, and its lineage is the host, not the app.

Decision history: #3801 permits acquisition overflow from system alerts at large Dynamic Type sizes and requires clipping with a typed quality note instead of capture failure.

## Rationale

- Regular and raw snapshots serve different readers. One strategy for both would either drop visible controls behind a budget or truncate the raw tree.
- More filters, retries, or Maestro heuristics in the daemon cannot recover nodes that XCTest never returned. They only make the failure slower.
- The generation circuit limits the cost of a hybrid app's web screen to one refused bridge round trip for each generation, instead of one on every `wait` poll.
- A screen-scoped refusal is up now and gone after the next keystroke. If it retired the generation, one alert or one landscape keyboard would send every later capture of a healthy app to XCTest, which costs seconds on a deep tree.
- Activation (`XCUIApplication.activate()` or `simctl launch`) cancels an authentication session and makes the surface black. The never-activate guard also makes the foreground predicate sound: a host can be foreground with a stale tree only after activation.
- A torn-down host can serve a richer tree than a live host, so tree content cannot prove presence.
- While a system sheet is up, the app stays the AX `primaryApp`, so the bridge serves the occluded app tree as if it were healthy.
- A mixed-space tree is not half-usable: a published rect is an address, and no pair of rects in that tree can answer "how far apart". The refusal costs one runner round trip.
- A published rect and the actionability verdict come from the same oriented frame, so an address and the permission to tap it cannot disagree.

## Rejected alternatives

- Arbitrary node-count cutoffs in the regular mode: they drop fixed controls that come late in traversal.
- Silent truncation of raw output: a reader cannot tell a truncated tree from the real tree.
- An AX-service backend as a special case inside the XCTest runner: it needs its own lifecycle, protocol, normalization, metrics, and fallback rules.
- One shared recovery engine for the host bridge and the runner's private AX bridge: their native representations differ. `contracts/fixtures/ios-ax-recovery-conformance.json` is the shared contract instead.
- A remembered "lingering" verdict for each host process: one process can present again.
- A cached absence verdict until the next action: a sheet presents after the action that requests it.
- A host-side `pgrep` and `ps` probe before each capture: it costs each warm capture about 45 ms (#2751).
- Modal containment through `IOS_PRESENTATION_RULES`, a wider eligibility table, the occlusion mark, or a cut at acquisition: they miss the regular projection, move a cross-language contract, keep covered nodes published, or change `--raw`.
- Moving a windowed bridge tree by the window origin: the keyboard window and alerts are not measured in that mode.
- Reading the screen size on the host from the device-type profile or `simctl io`: it adds a host process and an undocumented format, and it does not give the window origin.
- A guest bridge process with a forwarded socket on a provider Simulator: no provider has the features for it.
- Absence proof from the provider Simulator's process table alone: a sandbox can refuse that table.
- The runner's private-AX backend on a provider Simulator: it is another producer with another tree, and it needs the XCTest main thread.
- A copy of the reader sources in the runner: the two readers would drift.

## Consequences

- Regular snapshots stay the tool for agents and Maestro compatibility. Raw snapshots stay the tool when hierarchy matters.
- Both modes can still fail explicitly on trees that XCTest cannot serialize.
- Before you add iOS snapshot behavior, decide which mode owns it.
- Producers that do not normalize space, such as the query sweep and `appium-source`, publish reported geometry. The tap-path keyboard guard keeps its width rule for them.
- [ADR 0026](0026-scroll-clip-authority.md) refines the fact/interpretation boundary for scroll geometry.
- Package docs own the details: [`apple/snapshot-bridge/README.md`](../../apple/snapshot-bridge/README.md) for the reader, [`apple/runner/README.md`](../../apple/runner/README.md) for capture plans and the XCTest channel policy, and [`docs/evidence/ios-snapshot-adr-0004-measurements-2026-11-06.md`](../evidence/ios-snapshot-adr-0004-measurements-2026-11-06.md) for measurements.
- Open gaps:
  - Presentation cannot repair acquisition limits: the private-AX node cap, frameless elements that the query sweep drops, and no raw-depth extension for deep XCTest trees.
  - A future AX-service backend is the place to regain semantic coverage on XCTest-broken trees.
  - Landscape under Windowed Apps, Stage Manager, and a window partly off screen are unmeasured. A window that moves between a command's read and its dispatch drifts.
  - On a provider Simulator, the surface check needs the XCTest main thread, so a capture while that thread is stuck takes the XCTest fallback.
  - The runner carries the bridge envelope as a JSON string inside its JSON response, which costs escaping on large trees.
