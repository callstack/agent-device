# ADR 0001: Provider-First Integration Scenarios

## Status

Accepted

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** Provider-first scenario coverage and semantic provider operations remain accepted.
> Request-bound runtime facets and explicit provider ownership supersede the monolithic `Interactor` and request callback-stack topology one command at a time.

## Rules at a glance

- For commands not yet migrated under ADR 0019, keep the legacy `Interactor` interface.
- For new command migrations, use bound runtime facets from ADR 0019.
- In provider-backed integration tests, run the real daemon request path. Replace only providers.
- By default, match provider transcripts without order. Use ordered transcripts only to test order.
- Keep HTTP coverage in a narrow suite for transport, auth, and response finalization.
- Keep synchronous host-tool calls local until their paths have semantic provider contracts.
- Mock-heavy handler tests should be deleted only after equivalent integration scenarios exist.

## Context

The test suite had many mocked unit tests for daemon handlers and dispatch.
These tests cost much to maintain and omitted important behavior in:

- Request admission.
- Locking.
- Session state.
- Handler routing.
- Dispatch.
- Interactor resolution.
- Command translation in platform modules.

Android already had an ADB provider boundary.
Apple-family and Linux platform modules mostly called host tools or runner commands directly.
Thus, device-free integration tests required mocks above important platform behavior.

## Decision

For commands not yet migrated under ADR 0019, keep `Interactor` as the legacy semantic interface between dispatch and platform behavior.
For new command migrations, use bound runtime facets from ADR 0019.

For commands that still use the legacy adapter, use these request-scoped provider boundaries below platform modules:

- Android ADB provider.
- Apple tool provider with semantic `simctl`, `devicectl`, macOS helper, and macOS host subproviders.
- Apple runner provider.
- Linux tool provider with semantic subproviders for desktop lifecycle, accessibility, clipboard, and screenshots.
- App-log provider for semantic start and stop of app log streams.
- Recording provider for semantic local and remote screen-recording starts that would otherwise use raw host processes.

When platform intent is sufficiently stable to name, provider contracts should expose semantic operations.
Android already does this for install, pull, and port-reverse behavior.
Apple tool execution has started this change through semantic `simctl`, `devicectl`, macOS helper, and macOS host runners.
For unclassified host-tool paths, generic command execution remains a local compatibility fallback.

The macOS host provider owns these operations:

- App open.
- App inventory.
- Clipboard access.
- Appearance control.

Remote desktop providers should not need to infer these intents from `open`, `find`, `plutil`, `pbcopy`, `pbpaste`, or `osascript`.
Linux desktop lifecycle exposes semantic `openTarget` and `closeApp` operations.
Provider-backed integration covers these user workflows.
Remote desktop providers should not need to infer intent from `xdg-open`, binary launch, `wmctrl`, or `pkill`.

Linux accessibility snapshots, clipboard access, screenshots, and input synthesis are also semantic.
Their stable contracts are:

- Capture this surface.
- Read or write clipboard text.
- Write a screenshot artifact.
- Perform this user input.

These contracts describe intent independently of `python3`/AT-SPI, `xclip`, `scrot`, `grim`, `xdotool`, or `ydotool`.
App-log stream start and stop are semantic observability behavior.
Thus, provider-backed integration injects an app-log provider instead of starting `log stream` or `logcat`.
iOS simulator screen recording uses a recording provider.
Its stable contract starts simulator recording for a specified device and output path.
The local implementation uses `xcrun simctl io recordVideo`.

Provider-backed integration tests run the real daemon request path and replace only these providers.
Tests may use provider transcripts for platform command contracts.
Tests may use scenario transcripts for broader user workflows.
By default, provider transcripts match calls without order.
Use ordered transcripts only when order is the behavior under test.

Prefer an in-process harness with providers for broad integration scenarios.
The harness should invoke the daemon request handler directly without a TCP listener.
It should preserve:

- Admission.
- Locking.
- Session state.
- Handler routing.
- Dispatch.
- Platform modules.
- Provider boundaries.

Keep HTTP coverage as a narrow contract suite for JSON-RPC transport, auth, and response finalization.

Descriptors control request provider scope inside the request router layer.
Each provider entry declares:

- How the provider applies to the resolved device.
- How the provider installs its scoped provider.
- Which request-local data the provider exposes to handlers.

If a request id exists, Apple runner providers use request-id scope.
Only unscoped local runner calls may use a fallback based on the device alone.

Synchronous host-tool calls are intentionally outside the provider boundary.
Each remaining synchronous Apple helper is local-only.
Before a remote or cloud provider can own that path, convert the helper.

Remaining generic Apple host-tool calls intentionally stay local-only unless a new adapter requires semantic operations:

- Perf process discovery and samples: `mdfind`, `ps`.
- Launch diagnostics: `plutil`, `otool`.
- Local runner product build and signature: `swift`, `codesign`, synchronous `plutil`.
- Local simulator UI launch: `open -a Simulator`.
- Plist compatibility fallbacks.
- Fallback implementations behind semantic macOS providers.

Provider-backed integration scenarios should avoid scripts of these host commands for user workflows.
If a user-facing workflow depends on one, consider a semantic provider method for that intent.

## Alternatives Considered

- **Mock handlers or `dispatchCommand`.** These tests cost less to write.
  They omit request admission, locking, session state, and platform command translation, where the main test gaps occurred.
- **Put the boundary at `Interactor`.** This is simpler and more uniform.
  It bypasses platform modules and would miss the iOS/Linux host-tool connections that motivated this change.
- **Start with a full semantic provider per platform operation.** This gives a cleaner final design.
  Too many operations require names in one change.
  The migration starts where contracts exist or tests show a need.
- **Run every provider-backed integration scenario through HTTP.** This gives maximum end-to-end coverage.
  Most scenarios would require TCP setup, sandbox permissions, and transport timeouts even when they do not test transport behavior.

## Consequences

Integration tests continue to cover platform command translation without real devices.

The request router owns a provider registry boundary.
The registry keeps platform-specific provider applicability local.
It composes provider scopes linearly.
Thus, a new platform does not require another chain of nested wrappers.

New remote or cloud adapters can implement neutral provider contracts without changes to daemon, dispatch, or session contracts.
Generic tool-provider fallbacks provide interim compatibility.
They are not the target contract for cloud adapters.
If an integration scenario still scripts raw host commands, reassess whether the platform intent is sufficiently stable for a semantic provider method.

Mock-heavy handler unit tests should be deleted only after equivalent provider-backed integration scenarios exist.
Unit tests remain appropriate for pure logic, parser matrices, selector matching, capability maps, and edge/error cases that integration tests express poorly.

A provider-backed integration scenario covers more of the real request path.
However, its failures may require more diagnosis than failures in narrow unit tests.
Scenario names and provider transcript entries should describe user workflows and real e2e examples, so failures identify useful actions.

Coverage is expected to improve over the old suite of handler unit tests.
However, the first migration does not meet the original 90% target.
The current coverage denominator also excludes some entrypoint and configuration files.
Thus, coverage should indicate trends instead of proving that tests exercise every public surface.

`pnpm test:integration:progress` generates operational metrics.
After integration tests, CI runs `pnpm test:integration:progress:check` to prevent silent regressions in:

- Public-command coverage.
- Device-observable workflow flag coverage.
- Public-flag classification.

After a coverage run, the script is the source of truth for:

- Provider-backed integration size.
- Handler-unit size.
- Mock-heavy handler pressure.
- Public-command coverage.
- Command-family ownership.
- Device-observable workflow flag coverage.
- Provider transcript pressure.
- Files with low coverage.

These flag categories stay in their owning unit/CLI suites:

- Config.
- Remote transport.
- Metro preparation.
- Parser/client-only.
- Report-writing.
- Boot-fallback.

The report lists them as explicit exclusions from the denominator.
Provider pressure distinguishes semantic Apple `simctl`/`devicectl`, macOS helper, and macOS host usage from generic Apple host-tool usage.
It also distinguishes semantic Linux desktop/accessibility/clipboard/screenshot/input usage from generic Linux tool usage.
Thus, the report shows remote-adapter pressure without classifying named subproviders as raw shell intent.

The progress CLI should remain a small report and check runner over a progress model.
The model owns discovery, coverage classification, provider-pressure accounting, and check-failure derivation.
The CLI owns Markdown output and process exit behavior.
The progress script runs as a Node type-stripped TypeScript script.
When the metadata API exposes the required facet, the script should consume command metadata directly.
Source parsing inside the model is an implementation detail, not the desired long-term interface.
It should remain limited to facets absent from runtime metadata.
Maps from typed client method calls to command names are one example.

Every public command should have at least one provider-backed integration scenario through the request router and request-scoped provider boundaries.
Unit tests remain for:

- Parser matrices.
- Selector matching.
- Capability maps.
- Malformed inputs.
- State machines.
- Cleanup behavior.
- Provider scope routing.
- Platform error boundaries.

The temporary migration roadmap is complete and was removed from the repository.
Future work should follow current evidence from the progress script, failing tests, or concrete adapter needs.
It should not follow a permanent refactor backlog.
