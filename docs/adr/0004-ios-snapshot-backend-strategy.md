# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted.
[ADR 0038](0038-snapshot-capture-source-routing.md) owns snapshot source routing for every platform.
This record keeps the iOS acquisition, presentation, geometry, and in-place system-surface contracts.

## Context

Agents need the user-visible UI and hints for content outside visible scroll containers.
Diagnostics and selector disambiguation need a raw tree with hierarchy, static text, wrappers, and ancestry.
Some real app trees make recursive `XCUIElement.snapshot()` fail with `kAXErrorIllegalArgument` or main-thread timeouts while the app stays usable.
Lower-level accessibility services can describe the same Simulator screen.

## Decision

**Two public modes.** The public modes stay regular interactive snapshots and raw diagnostic snapshots. The host AX bridge is a route, not a third mode.
The regular mode must not use an arbitrary node-count cutoff, because fixed controls late in traversal order, such as a tab bar after a long list, are part of its contract.
The raw mode may be noisy and large. If the transport cannot carry it, fail explicitly. Do not truncate the tree at a hard node count.
If XCTest reports a real AX serialization failure, the raw mode preserves that error instead of reporting an empty UI.
If an interactive snapshot has only the application root or another sparse shape, return a structured quality verdict and warning.

**Acquisition.** XCTest stays the iOS automation runner.
Route eligible local iPhone and iPad Simulator snapshots through the host AX bridge.
A provider iOS Simulator uses the same reader through the runner's `snapshotBridge` command.
tvOS and visionOS Simulators, the macOS host, physical devices, custom-action captures, and interactions keep their existing owners.
Physical devices should get a non-XCTest semantic backend only if Apple exposes a supported channel.
An observe-only capture skips the route and uses the provider's capture, because it must not activate the app or start work.

**Fallback.** If bridge acquisition fails without cancellation, or presentation fails, use one typed XCTest fallback with explicit source residue.
After a generation-scoped fallback, disable the bridge for that app generation. A new app generation enables it again.
A refusal that gives evidence about the screen, not the app, has capture scope, because the screen can change by the next keystroke.
ADR 0038 states the other fallback rules. `contracts/fixtures/ios-snapshot-bridge-refusals.json` is the one table of refusal scopes.
The bridge reads one process, so it refuses a tree in which remote web or scene-hosted content (`AXRemoteElement`) can be on screen (`remote-content-boundary`).
Refs from that tree would target the host views, and XCTest resolves remote elements (#2484).

**Ownership.** The Apple platform runtime owns acquisition routing and the generation-scoped fallback.
`@agent-device/contracts/ios-snapshot` holds the acquisition carrier. `@agent-device/capture-kit` owns host-side snapshot policy, including the clip fold.
Daemon assembly owns only the order of capture, compaction, occlusion, and ref publication.
New consumers must use the capture-kit policy facet. Do not add another daemon presentation path.
The Swift runner keeps its own `SnapshotPresentation` for the capture-plan tier before the process boundary.
Shared fixtures, not shared code, prove that the two engines agree.

**Presentation.** Acquisition publishes facts. Presentation interprets them, and every bridge result crosses that boundary before publication.
A regular `--depth` request is a presentation cut, not an acquisition bound. Raw depth stays acquisition depth.
Semantic compaction may move an identifier, but it must not delete one.
It deletes a contentless identifier wrapper only when the node declares `hittable: false`, because an absent fact is not a negative answer (#2638).
The fold cuts screens under a modal only where the producer states containment. The raw projection keeps the covered screens.

**Geometry.** One published capture publishes one space: the app's orientation space.
The producer settles it in one pass after acquisition, because a merged tree carries no axis that a downstream reader could use.
A window declares its subtree's space from its own box. Other nodes inherit it from the window above them.
If no space can be named, the capture publishes reported geometry, and consumers fail open.
A placed iPad window publishes screen space in points, because its viewport, its screenshot, and the digitizer use that space.

**System surfaces.** `contracts/fixtures/ios-system-surface-hosts.json` is the closed registry of system hosts that present UI out of the app's process.
Observe and operate a registered host in place. Never activate it. `open` refuses to launch it.
The runner never adopts the host as the session target, so after the surface closes, the next command resolves back to the app.
A presented surface takes precedence over an explicitly requested bundle id.
Presence is `XCUIApplication.state == .runningForeground`, not tree content.
A surface capture carries `systemSurface` provenance and the `iosSystemSurfaceDisclosure`, and its lineage is the host.
Before a Simulator capture uses the bridge, it proves host absence as ADR 0038 "Surface proof" requires.
If the proof fails or a host is present, use the runner for that capture without changing the app-generation circuit.

Decision history: #3801 permits acquisition overflow from system alerts at large Dynamic Type sizes. Presentation clips it with one `regular-geometry-clipped` quality note instead of failing the capture.

## Rationale

- Daemon filters, retries, or Maestro heuristics cannot recover nodes that XCTest never returned. They only make the failure slower.
- The generation circuit costs a hybrid app's web screen one refused round trip for each generation, not one on every `wait` poll.
- Activation (`XCUIApplication.activate()` or `simctl launch`) cancels an authentication session and makes the surface black. Without activation, a foreground host cannot have a stale tree.
- A torn-down host can serve a richer tree than a live host, and under a system sheet the app stays the AX `primaryApp`. Thus, tree content cannot prove presence.
- A published rect is an address. No pair of rects in a mixed-space tree can answer "how far apart", so that tree is not half-usable. A rect and its actionability verdict share one oriented frame, so they cannot disagree.

## Rejected alternatives

- A node-count cutoff or silent raw truncation: the cutoff drops late fixed controls, and the truncation is invisible to a reader.
- Another producer inside the runner (an AX-service special case, the private-AX backend, or a reader copy), or a guest bridge process on a provider Simulator: it needs its own lifecycle or the XCTest main thread, a copied reader drifts, and no provider supports a guest process.
- One recovery engine for both AX bridges: their native representations differ. `contracts/fixtures/ios-ax-recovery-conformance.json` is the shared contract.
- A cached surface verdict, a host `pgrep` probe per capture, or the provider's process table alone: a host can present again, the probe slows warm captures, and a sandbox can refuse the table.
- Modal containment through `IOS_PRESENTATION_RULES`, a wider eligibility table, the occlusion mark, or a cut at acquisition: they miss the regular projection, move a cross-language contract, keep covered nodes published, or change `--raw`.
- Host-side window geometry: in windowed mode the keyboard window and alerts are not measured from the window origin, and a screen size from the device-type profile or `simctl io` adds a host process and an undocumented format without the window origin.

## Consequences

- Regular snapshots serve agents and Maestro compatibility. Raw snapshots serve hierarchy. Both can fail explicitly on trees that XCTest cannot serialize.
- Before maintainers add iOS snapshot behavior, they should first decide which mode owns it.
- Producers that do not normalize space, such as the query sweep and `appium-source`, publish reported geometry. The tap-path keyboard guard keeps its width rule for them.
- [ADR 0026](0026-scroll-clip-authority.md) refines the fact/interpretation boundary for scroll geometry.
- Details: [presentation](../../apple/snapshot-presentation/README.md), [reader and surface proof](../../apple/snapshot-bridge/README.md), [capture plans and channel policy](../../apple/runner/README.md), [measurements](../evidence/ios-snapshot-adr-0004-measurements-2026-11-06.md).
- Open gaps:
  - Presentation cannot repair acquisition limits: the private-AX node cap, frameless elements that the query sweep drops, and no raw-depth extension for deep XCTest trees.
  - A future AX-service backend can regain semantic coverage on XCTest-broken trees.
  - Landscape under Windowed Apps, Stage Manager, and partly off-screen windows are unmeasured. A window that moves between read and dispatch drifts.
  - On a provider Simulator, the surface check needs the XCTest main thread, so a capture while that thread is stuck takes the XCTest fallback.
  - The runner nests the bridge envelope as a JSON string in its JSON response, which costs escaping on large trees.
