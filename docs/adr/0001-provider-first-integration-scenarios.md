# ADR 0001: Provider-First Integration Scenarios

## Status

Accepted

Completed process history is in git history.

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** Provider-first scenario coverage and semantic provider operations remain accepted.
> Request-bound runtime facets and explicit provider ownership supersede the monolithic `Interactor` and the request callback-stack topology one command at a time.

## Rules at a glance

- For commands not yet migrated under ADR 0019, keep `Interactor` as the legacy semantic interface.
- For new command cutovers, use the bound runtime facets of ADR 0019.
- Provider-backed integration tests run the real daemon request path and replace only the providers.
- By default, provider transcripts match calls as an unordered contract.
  Use ordered transcripts only when order is the behavior under test.
- Keep HTTP coverage as a narrow contract suite for JSON-RPC transport, auth, and response finalization.
- Synchronous host-tool calls are intentionally outside the provider seam.
  Before a remote or cloud provider can own the path of a synchronous Apple helper, you must convert the helper.
- Mock-heavy handler unit tests should be deleted only after equivalent provider-backed integration scenario coverage exists.

## Context

The test suite had many mocked unit tests for daemon handlers and dispatch.
These tests were expensive to maintain, and they skipped important behavior in these areas:

- Request admission.
- Locking.
- Session state.
- Handler routing.
- Dispatch.
- Interactor resolution.
- Command translation in platform modules.

Android already had an ADB provider seam.
Apple-family and Linux platform modules mostly called host tools or runner commands directly.
Thus, device-free integration tests were difficult unless the tests mocked too high in the stack.

## Decision

For commands not yet migrated under ADR 0019, keep `Interactor` as the legacy semantic interface between dispatch and platform behavior.
New command cutovers use the bound runtime facets of ADR 0019.

For commands that still use the legacy adapter, use these request-scoped provider seams below platform modules:

- Android ADB provider.
- Apple tool provider with semantic `simctl`, `devicectl`, macOS helper, and macOS host subproviders.
- Apple runner provider.
- Linux tool provider with semantic subproviders for desktop lifecycle, accessibility, clipboard, and screenshots.
- App-log provider for semantic start and stop of app log streams.
- Recording provider for semantic local and remote screen-recording start operations that would otherwise be raw host processes.

When the platform intent is stable enough to name, provider contracts should expose semantic operations.
Android already does this for install, pull, and port-reverse behavior.
Apple tool execution has started to move in that direction with semantic `simctl`, `devicectl`, macOS helper, and macOS host runners.
Generic command execution remains as a local compatibility fallback for host-tool paths that are not classified yet.

The macOS host provider owns these operations:

- App open.
- App inventory.
- Clipboard.
- Appearance.

The reason is that remote desktop providers should not need to infer these intents from `open`, `find`, `plutil`, `pbcopy`, `pbpaste`, or `osascript`.

Linux desktop lifecycle exposes semantic `openTarget` and `closeApp` operations for two reasons:

- Provider-backed integration covers these user workflows.
- Remote desktop providers should not need to infer intent from `xdg-open`, binary launch, `wmctrl`, or `pkill`.

Linux accessibility snapshots, clipboard, screenshots, and input synthesis are also semantic, because their stable contracts are these:

- "capture this surface"
- "read/write clipboard text"
- "write a screenshot artifact"
- "perform this user input"

The local implementation details `python3`/AT-SPI, `xclip`, `scrot`, `grim`, `xdotool`, and `ydotool` are not the contracts.

App-log stream start/stop is semantic observability behavior, not generic host process execution.
Thus, provider-backed integration injects an app-log provider, and it does not spawn `log stream` or `logcat`.

iOS simulator screen recording now uses a recording provider, because the stable contract is "start simulator recording for this device and output path".
The local implementation detail `xcrun simctl io recordVideo` is not the contract.

Provider-backed integration tests run the real daemon request path and replace only those providers.
Tests may use provider transcripts for platform command contracts.
Tests may use scenario transcripts for broader user workflows.
By default, provider transcripts match calls as an unordered contract.
Use ordered transcripts only when order is the behavior under test.

For broad scenarios, prefer an in-process provider-backed integration harness.
The harness should invoke the daemon request handler directly, without a bound TCP listener.
It should preserve:

- Admission.
- Locking.
- Session state.
- Handler routing.
- Dispatch.
- Platform modules.
- Provider seams.

Keep HTTP coverage as a narrow contract suite for JSON-RPC transport, auth, and response finalization.

Inside the request router layer, descriptors drive the request provider scope.
Each provider entry declares:

- How the provider applies to the resolved device.
- How the provider installs its scoped provider.
- Which request-local data the provider exposes to handlers.

When a request id exists, Apple runner providers are request-id scoped.
A fallback by device alone is allowed only for unscoped local runner calls.

Synchronous host-tool calls are intentionally not part of the provider seam.
Any remaining synchronous Apple helper is local-only.
Before a remote or cloud provider can own the path of such a helper, you must convert the helper.

Remaining generic Apple host-tool calls intentionally stay local-only, unless a new adapter creates pressure to promote them:

- Perf process discovery and sampling: `mdfind`, `ps`.
- Launch diagnostics: `plutil`, `otool`.
- Local runner product build and signing: `swift`, `codesign`, synchronous `plutil`.
- Local simulator UI launch: `open -a Simulator`.
- Plist compatibility fallbacks.
- Fallback implementations behind semantic macOS providers.

Provider-backed integration scenarios should avoid scripted calls to these host commands for user workflows.
A user-facing workflow that depends on one of these commands is naming pressure for a semantic provider method.

## Alternatives Considered

- **Mock handlers or `dispatchCommand`.** These tests are cheaper to write.
  But they skip request admission, locking, session state, and platform command translation.
  These areas were the main sources of test blind spots.
- **Put the seam at `Interactor`.** This is simpler and more uniform.
  But it bypasses platform modules, and it would not catch the iOS/Linux host-tool wiring issues that motivated this change.
- **Start with a full semantic provider per platform operation.** This gives a cleaner end state.
  But it has too much surface to name correctly in one pass.
  The migration starts where contracts already exist or where tests create pressure.
- **Run every provider-backed integration scenario through HTTP.** This gives maximum end-to-end coverage.
  But most scenarios would pay for TCP setup, sandbox permissions, and transport timeouts, even when transport behavior is not under test.

## Consequences

Integration tests continue to cover platform command translation without real devices.

The request router owns a provider registry seam.
But platform-specific provider applicability remains localized in that registry.
The registry composes provider scopes linearly.
Thus, a new platform does not require another chain of nested wrappers.

New remote or cloud-backed adapters can implement neutral provider contracts without changes to daemon, dispatch, or session contracts.
Generic tool-provider fallbacks are an interim compatibility layer.
They are not the target contract for cloud adapters.
If a provider-backed integration scenario still scripts raw host commands, that is a signal to reassess whether the platform intent is stable enough for a semantic provider method.

Mock-heavy handler unit tests should be deleted only after equivalent provider-backed integration scenario coverage exists.
Unit tests remain appropriate for pure logic, parser matrices, selector matching, capability maps, and edge/error cases that integration tests would express poorly.

The trade-off is coarser failure localization.
A provider-backed integration scenario catches more of the real request path.
But its failures may require more diagnosis than failures in a narrow unit test.
Scenario names and provider transcript entries should stay rooted in user workflows and real e2e examples, so that failures remain actionable.

Coverage is expected to improve over the old handler-heavy unit suite.
But the first migration does not meet the original 90% target.
The current coverage denominator also excludes some entrypoint and configuration files.
Thus, coverage should be treated as a trend signal, not as proof that tests exercise every public surface.

`pnpm test:integration:progress` generates operational metrics.
After integration tests, CI runs `pnpm test:integration:progress:check`, so that these metrics cannot silently regress:

- Public-command coverage.
- Device-observable workflow flag coverage.
- Public-flag classification.

The script is the source of truth for:

- Provider-backed integration size.
- Handler-unit size.
- Mock-heavy handler pressure.
- Public-command coverage.
- Command-family ownership.
- Device-observable workflow flag coverage.
- Provider transcript pressure.
- Low-coverage files after a coverage run.

These flags stay in their owning unit/CLI suites:

- Config, output, diagnostics, and transport.
- Remote connection and session-lock policy.
- Cloud artifact provider lookup.
- Metro and React Native runtime preparation.
- Apple launch and perf artifact options.
- Parser/client-only command flags.
- Daemon lifecycle control.
- Platform boot fallback without a provider seam.
- Open foreground auto-resolution (RFC prototype).
- Local device contention waiting.
- Apple simulator screenshot, private-AX, and observe-only capture options.
- Daemon screenshot selector crop.

`summarizeProviderScenarioFlagExclusions` in `scripts/integration-progress-model.ts` is the full list.
The report lists these flags as explicit exclusions, so they are not silently missing from the denominator.
Provider pressure separates semantic Apple `simctl`/`devicectl`, macOS helper, and macOS host usage from generic Apple host-tool usage.
It also separates semantic Linux desktop/accessibility/clipboard/screenshot/input usage from generic Linux tool usage.
Thus, remote-adapter pressure is visible, and named subproviders do not count as raw shell intent.

The progress CLI should stay a thin report and check runner over a progress model.
The model owns discovery, coverage classification, provider-pressure accounting, and check-failure derivation.
The CLI owns Markdown output and process exit behavior.
The progress script runs as a Node type-stripped TypeScript script.
When the metadata API exposes the necessary facet, the script should consume command metadata directly.
Source parsing inside the model is an implementation detail, not the desired long-term interface.
Source parsing should remain limited to facets that runtime metadata does not represent yet.
One example is the map from typed client method calls back to command names.

Every public command should have at least one provider-backed integration scenario that runs through the request router and the request-scoped provider seams.
Unit tests remain for:

- Parser matrices.
- Selector matching.
- Capability maps.
- Malformed inputs.
- State machines.
- Cleanup behavior.
- Provider scope routing.
- Platform error boundaries.

Future work should be justified from live pressure in the progress script, from failing tests, or from concrete adapter needs.
A standing refactor backlog is not a justification for future work.
