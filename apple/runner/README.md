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
- TypeScript client: [`../../packages/platform-apple/src/runner/runner-client.ts`](../../packages/platform-apple/src/runner/runner-client.ts)
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

## Protocol Notes

- The daemon posts JSON commands to `POST /command` on the runner's local HTTP listener, with the
  per-launch listener token on every request. See `RUNNER_PROTOCOL.md` for binding, token, and
  framing rules.
- The runner responds with a JSON envelope shaped as `{ ok, data?, error? }`.
- The protocol is internal to `agent-device`; when adding or renaming commands, update both wire models and the protocol tests/docs in the same change.
