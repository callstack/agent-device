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
- TypeScript client: [`../../src/platforms/apple/core/runner/runner-client.ts`](../../src/platforms/apple/core/runner/runner-client.ts)
- Swift wire models: [`AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)

## UITest Runner File Map

`AgentDeviceRunnerUITests/RunnerTests` is split into focused files to reduce context size for contributors and LLM agents.

- `RunnerTests.swift`: shared state/constants, `setUp()`, and `testCommand()` entry flow.
- `RunnerTests+Models.swift`: wire protocol models (`Command`, `Response`, snapshot payload models).
- `RunnerTests+Environment.swift`: environment and CLI argument helpers (`RunnerEnv`).
- `RunnerTests+Transport.swift`: TCP request handling and HTTP parsing/encoding.
- `RunnerTests+CommandExecution.swift`: command dispatch (`execute*`) and command switch.
- `RunnerTests+Lifecycle.swift`: activation/retry/stabilization and recording lifecycle helpers.
- `RunnerTests+Interaction.swift`: tap/drag/swipe/type/home/rotate/app-switcher helpers.
- `RunnerTests+Navigation.swift`: back/navigation-control helpers.
- `RunnerTests+Snapshot.swift`: fast/raw snapshot builders and include/filter helpers.
- `RunnerTests+SystemModal.swift`: SpringBoard/system modal detection and modal snapshot shaping.
- `RunnerTests+ScreenRecorder.swift`: nested `ScreenRecorder` implementation.

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

- The daemon posts JSON commands to `POST /command` on the runner's local HTTP listener.
- The runner responds with a JSON envelope shaped as `{ ok, data?, error? }`.
- The protocol is internal to `agent-device`; when adding or renaming commands, update both wire models and the protocol tests/docs in the same change.
