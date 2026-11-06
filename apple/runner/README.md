# agent-device iOS Runner

This folder contains the lightweight XCUITest runner used to provide element-level automation for Apple-family targets.

## Intent

- Provide a minimal XCTest target that exposes UI automation over a small HTTP server.
- Allow local builds via `xcodebuild` and caching for faster subsequent runs.
- Support simulator prebuilds where compatible.

## Status

Current internal runner for iOS, tvOS, and macOS desktop automation.

Protocol and maintenance references:

- Protocol overview: [`RUNNER_PROTOCOL.md`](RUNNER_PROTOCOL.md)
- TypeScript client: [`../../packages/apple-runner/src/index.ts`](../../packages/apple-runner/src/index.ts)
- Swift wire models: [`AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)

## Host App Files

`AgentDeviceRunner/AgentDeviceRunner/` is the host app the runner's XCTest bundle launches.

- `AgentDeviceRunnerApp.m`: the shipped host. The npm package ships it as build input, so it holds
  no test code: the plain title screen, the scene delegate, and the two hooks below.
  `+agentDeviceRootViewControllerClass` and `-agentDeviceWillAttachToWindow:` reach the fixture
  host by class name, never by symbol, so the packaged project builds with the fixtures file absent.
- `AgentDeviceRunnerAppFixtures.m`: the fixture host, `AgentDeviceRunnerFixtureViewController`.
  Every `--agent-device-*` launch-argument screen the `UnitTests/` suites drive lives here. It
  compiles only under `AGENT_DEVICE_RUNNER_UNIT_TESTS` and the npm packager drops it, so a user's
  host app carries no fixture screen. A class rename must update the host's lookup.

## UITest Runner File Map

`AgentDeviceRunnerUITests/RunnerTests` is split into focused files to reduce context size for contributors and LLM agents.

- `RunnerTests.swift`: shared state/constants, `setUp()`, and `testCommand()` entry flow.
- `RunnerTests+Models.swift`: wire protocol models (`Command`, `Response`, snapshot payload models).
- `RunnerTests+Environment.swift`: the listener port and token the daemon passes (`RunnerListenerConfiguration`).
- `RunnerTests+Transport.swift`: TCP request handling and HTTP parsing/encoding.
- `RunnerHttpRequestFraming.swift`: request-head admission (token, route, length limits).
- `RunnerListenerToken.swift`: the per-launch listener token.
- `RunnerTests+CommandDispatch.swift`: the dispatch entry (`executeAccepted`, `executeDispatched`),
  its recovery loops, target preparation, and recorded-failure conversion.
- `RunnerTests+CommandExecution.swift`: the prepared-command switch (`executeOnMainPrepared`).
- `RunnerTests+GestureExecution.swift`, `RunnerTests+ScrollDragExecution.swift`,
  `RunnerTests+TypeExecution.swift`, `RunnerTests+SnapshotExecution.swift`: per-family command
  execution.
- `RunnerTests+Lifecycle.swift`: activation/retry/stabilization and recording lifecycle helpers.
- `RunnerTests+Interaction.swift`: tap/drag/swipe/type/home/rotate/app-switcher helpers.
- `RunnerTests+Navigation.swift`: back/navigation-control helpers.
- `RunnerTests+Snapshot.swift`: fast/raw snapshot builders and include/filter helpers.
- `RunnerTests+SystemModal.swift`: SpringBoard/system modal detection and modal snapshot shaping.
- `RunnerTests+ScreenRecorder.swift`: nested `ScreenRecorder` implementation.
- `UnitTests/RunnerTests+<Source>Tests.swift`: the `AGENT_DEVICE_RUNNER_UNIT_TESTS` tests for each
  source file. The packaged runner source omits this directory.

## Snapshot Strategy

iOS snapshots have two explicit public capture modes:

- full/raw snapshots use recursive XCTest snapshots for rich hierarchy and diagnostics;
- interactive snapshots filter the same visible tree down to agent-facing refs.

Some iOS apps expose accessibility trees that lower-level AX services can inspect but XCTest cannot
serialize reliably. In those cases interactive snapshots may return a sparse root quickly, while
full snapshots preserve the XCTest error. A penalized simulator can recover through private AX;
physical devices use a short XCTest probe because no non-XCTest semantic backend is available
there. See
[`../../docs/adr/0004-ios-snapshot-backend-strategy.md`](../../docs/adr/0004-ios-snapshot-backend-strategy.md)
for the backend boundary and future simulator AX-service direction.
Presentation and geometry contracts are in
[`../snapshot-presentation/README.md`](../snapshot-presentation/README.md).

### Capture plans

The raw diagnostic plan derives from `SnapshotBackendKind.supportsRawProjection`, not from a manual list.
Thus, a backend with no hierarchy to return, such as the query sweep, cannot serve a raw plan.
The raw plan keeps tree-first error propagation.
The regular plan carries its umbrella deadline into the query-sweep and private-AX tiers.
When the budget is spent, later tiers stop.

### XCTest accessibility channel policy

These events penalize the XCTest accessibility channel for that bundle for a bounded window:

- A slow XCTest acquisition above the three-second threshold.
- A timed-out XCTest tier.
- Abandoned system-modal work.
- A regular-plan query-sweep timeout. The plan also refuses the partial capture.

Under a penalty, regular plans derive the next step from backend traits (`effectiveSnapshotCapturePlan`).
If a runnable non-XCTest backend exists, they defer to it.
If none exists, as on physical iOS devices, they run a short XCTest probe instead of the full tree slice.
A recovery probe is due thirty seconds after the penalty starts, and thirty seconds after each probe starts.
A regular plan with a due probe runs the bounded tree before the independent backend, in the same capture.
A failed recovery probe does not change the penalty deadline, because its short slice gives no new evidence about the channel.
A completed tree probe clears the penalty early only when its acquisition fits the probe slice and its quality is accepted.
Physical-device plans probe on every capture.
Explicit backend pins and the raw plan keep their order.
The plan deadline and the abandoned-main-thread-work gate apply to every attempt (#1105, #1156, #2621, #3844).

The runner starts no XCTest main-thread work after it answers a command.
Probe work that outlives its slice belongs to the capture that started it, so that response reports a busy main thread.
Every bounded main-thread dispatch that outlives its slice counts as occupying the main thread.
Thus, if a viewport read takes too long, the plan skips the sweep instead of queueing it.

A failure that XCTest records ends `testCommand` when the main-thread block that recorded it returns, whatever `continueAfterFailure` says.
On hostile trees, every `allElementsBoundByIndex` read of the query sweep fails with `kAXErrorIllegalArgument` and records `Failed to resolve query: ...`.
Thus, the runner mutes AX-server rejections in both XCTest fetch wordings.
Otherwise, the runner exits during a hostile snapshot and loses its per-bundle penalty and depth memory.

### Screen space

`XCUIElement.frame` and the app-anchored `XCUICoordinate` use screen space on a placed iPad window.
`XCUIElementSnapshot.frame` uses window content space.
The text-entry probe owns one screen box, `ResolvedTextEntryInput.frameOnScreen`.
A command reads the vector from the resolved window's box once, when it builds its target.
The readiness retap reads the vector again on its own branch.
The vector is `TextEntryContentTranslation` (`known`, `none`, or `unknown` when the read failed), with no default.
Thus, a failed read never counts as full screen.
`frameOnScreen` is nil without a snapshot (#3060) or with `unknown`.
When it is nil, the focus tap dispatches the caller's own point, and the refresh point, the caret tap, and the readiness retap dispatch nothing.
Probe matching compares the live `element.frame`, because a comparison dispatches nothing.

The synthesized-gesture route compares the AXRuntime frame of the primary app with the frame of the system app (`RunnerFullScreenEvidenceFromForeground`).
When XCTest cannot resolve the window, an iPad app that proves it fills its sole screen may use that screen as its gesture reference frame.
An app that does not prove it still requires a window.

## Protocol Notes

- The daemon posts JSON commands to `POST /command` on the runner's local HTTP listener, with the
  per-launch listener token on every request. See `RUNNER_PROTOCOL.md` for binding, token, and
  framing rules.
- The runner responds with a JSON envelope shaped as `{ ok, data?, error? }`.
- The protocol is internal to `agent-device`; when adding or renaming commands, update both wire models and the protocol tests/docs in the same change.
