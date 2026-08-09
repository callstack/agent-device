# ADR 0001: Provider-First Integration Scenarios

## Status

Accepted

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** Provider-first scenario
> coverage and semantic provider operations remain accepted. The monolithic `Interactor` and the
> request callback-stack topology are superseded one command at a time by request-bound runtime
> facets and explicit provider ownership.

## Context

The test suite had many mocked daemon handler and dispatch unit tests. Those tests were expensive to maintain and skipped important behavior across request admission, locking, session state, handler routing, dispatch, Interactor resolution, and platform module command translation.

Android already had an ADB provider seam. Apple-family and Linux platform modules mostly called host tools or runner commands directly, which made device-free integration tests difficult without mocking too high in the stack.

## Decision

For commands not yet migrated under ADR 0019, keep `Interactor` as the legacy semantic interface
between dispatch and platform behavior. New command cutovers use ADR 0019's bound runtime facets.

For commands still on the legacy adapter, use these request-scoped provider seams below platform
modules:

- Android ADB provider
- Apple tool provider with semantic `simctl`, `devicectl`, macOS helper, and macOS host subproviders
- Apple runner provider
- Linux tool provider, with semantic desktop lifecycle, accessibility, clipboard, and screenshot subproviders
- App-log provider for semantic app log stream start/stop
- Recording provider for semantic local/remote screen-recording start operations that would otherwise be raw host processes

Provider contracts should expose semantic operations when the platform intent is stable enough to name. Android already does this for install, pull, and port-reverse behavior. Apple tool execution has started moving in that direction with semantic `simctl`, `devicectl`, macOS helper, and macOS host runners; generic command execution remains as a local compatibility fallback for host-tool paths that have not been classified yet. The macOS host provider owns app opening, app inventory, clipboard, and appearance because remote desktop providers should not need to infer those intents from `open`, `find`, `plutil`, `pbcopy`, `pbpaste`, or `osascript`. Linux desktop lifecycle exposes semantic `openTarget` and `closeApp` operations because provider-backed integration covers those user workflows and remote desktop providers should not need to infer intent from `xdg-open`, binary launch, `wmctrl`, or `pkill`. Linux accessibility snapshots, clipboard, screenshots, and input synthesis are also semantic because the stable contracts are "capture this surface", "read/write clipboard text", "write a screenshot artifact", and "perform this user input", not the local implementation details `python3`/AT-SPI, `xclip`, `scrot`, `grim`, `xdotool`, or `ydotool`. App-log stream start/stop is semantic observability behavior rather than generic host process execution, so provider-backed integration injects an app-log provider instead of spawning `log stream` or `logcat`. iOS simulator screen recording now uses a recording provider because the stable contract is "start simulator recording for this device and output path", not the local implementation detail `xcrun simctl io recordVideo`.

Provider-backed integration tests run the real daemon request path and replace only those providers. Tests may use provider transcripts for platform command contracts and scenario transcripts for broader user workflows. Provider transcripts match calls as an unordered contract by default; use ordered transcripts only when ordering is the behavior under test.

Prefer an in-process provider-backed integration harness for broad scenarios: it should invoke the daemon request handler directly, preserving admission, locking, session state, handler routing, dispatch, platform modules, and provider seams without binding a TCP listener. Keep HTTP coverage as a narrow contract suite for JSON-RPC transport, auth, and response finalization.

Request provider scoping is descriptor-driven inside the request router layer. A provider entry declares how it applies to the resolved device, how it installs its scoped provider, and what request-local data it exposes to handlers. Apple runner providers are request-id scoped when a request id exists; fallback by device alone is only allowed for unscoped local runner calls.

Synchronous host-tool calls are intentionally not part of the provider seam. Any remaining sync Apple helper is local-only and must be converted before a remote/cloud provider can own that path.

Remaining generic Apple host-tool calls are intentionally local-only unless a new adapter creates pressure to promote them: perf process discovery/sampling (`mdfind`, `ps`), launch diagnostics (`plutil`, `otool`), local runner product build/signing (`swift`, `codesign`, sync `plutil`), local simulator UI launch (`open -a "Device Hub"` or `open -a Simulator`), plist compatibility fallbacks, and fallback implementations behind semantic macOS providers. Provider-backed integration scenarios should avoid scripting those host commands for user workflows; a user-facing workflow that depends on one of them is naming pressure for a semantic provider method.

## Alternatives Considered

- Mock handlers or `dispatchCommand`: cheaper to write, but it skips request admission, locking, session state, and platform command translation, which were the main sources of test blind spots.
- Put the seam at `Interactor`: simpler and more uniform, but it bypasses platform modules and would not catch the iOS/Linux host-tool wiring issues that motivated this change.
- Start with a full semantic provider per platform operation: cleaner end state, but too much surface to name correctly in one pass. The migration starts where contracts already exist or where tests create pressure.
- Run every provider-backed integration scenario through HTTP: maximum end-to-end coverage, but it makes most scenarios pay for TCP setup, sandbox permissions, and transport timeouts even when transport behavior is not under test.

## Consequences

Platform command translation remains covered by integration tests without requiring real devices.

The request router owns a provider registry seam, but platform-specific provider applicability remains localized in that registry. The registry composes provider scopes linearly so adding a platform does not require another nested wrapper chain.

New remote or cloud-backed adapters can implement neutral provider contracts without changing daemon, dispatch, or session contracts. Generic tool-provider fallbacks are an interim compatibility layer, not the target contract for cloud adapters. When a provider-backed integration scenario still scripts raw host commands, that is a signal to reassess whether the platform intent has become stable enough for a semantic provider method.

Mock-heavy handler unit tests should be deleted only after equivalent provider-backed integration scenario coverage exists. Unit tests remain appropriate for pure logic, parser matrices, selector matching, capability maps, and edge/error cases that integration tests would express poorly.

The trade-off is coarser failure localization: a provider-backed integration scenario catches more of the real request path but may require more diagnosis than a narrow unit test. Scenario names and provider transcript entries should stay rooted in user workflows and real e2e examples so failures remain actionable.

Coverage is expected to improve over the old handler-heavy unit suite, but the first migration does not meet the original 90% target. The current coverage denominator also excludes some entrypoint and configuration files, so coverage should be treated as a trend signal rather than proof that every public surface is exercised.

Operational metrics are generated by `pnpm test:integration:progress`. CI runs `pnpm test:integration:progress:check` after integration tests so public-command coverage, device-observable workflow flag coverage, and public-flag classification cannot silently regress. The script is the source of truth for provider-backed integration size, handler-unit size, mock-heavy handler pressure, public-command coverage, command-family ownership, device-observable workflow flag coverage, provider transcript pressure, and low-coverage files after a coverage run. Config, remote transport, Metro preparation, parser/client-only, report-writing, and boot-fallback flags stay in their owning unit/CLI suites and are reported as explicit exclusions rather than silently missing from the denominator. Provider pressure separates semantic Apple `simctl`/`devicectl`, macOS helper, and macOS host usage from generic Apple host-tool usage, and separates semantic Linux desktop/accessibility/clipboard/screenshot/input usage from generic Linux tool usage, so remote-adapter pressure is visible without treating named subproviders as raw shell intent.

The progress CLI should stay a thin report and check runner over a progress model. The model owns discovery, coverage classification, provider-pressure accounting, and check-failure derivation; the CLI owns Markdown output and process exit behavior. The progress script runs as a Node type-stripped TypeScript script and should consume command metadata directly when the metadata API exposes the needed facet. Source parsing inside the model is an implementation detail, not the desired long-term interface, and should remain limited to facets that are not yet represented as runtime metadata, such as mapping typed client method calls back to command names.

Every public command should have at least one provider-backed integration scenario that runs through the request router and request-scoped provider seams. Unit tests remain for parser matrices, selector matching, capability maps, malformed inputs, state machines, cleanup behavior, provider scope routing, and platform error boundaries.

The temporary migration roadmap is complete and intentionally removed from the repository. Future work should be justified from live pressure in the progress script, failing tests, or concrete adapter needs rather than from a standing refactor backlog.
