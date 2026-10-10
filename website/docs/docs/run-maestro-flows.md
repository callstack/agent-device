---
title: Run Maestro flows
---

# Run Maestro flows

`agent-device` runs a subset of Maestro YAML flows on iOS and Android, and exports `.ad` scripts to Maestro YAML. This is a compatibility layer, not full Maestro support:

- Only the commands and fields in [Supported subset](#supported-subset) run. Anything else fails with source context instead of being skipped.
- Flows run on iOS and Android only.
- `runScript`, `evalScript`, and JavaScript conditions execute flow code on your machine without a security sandbox. Run only flows you trust.

For recording and replaying native `.ad` scripts, see [Replay & E2E testing](/docs/replay-e2e).

## Run a Maestro flow

Pass `--maestro` to `replay` or `test`:

```bash
agent-device replay ./flow.yaml --maestro --platform ios --session e2e-run
agent-device test ./maestro-flows --maestro --platform android --artifacts-dir ./tmp/maestro-artifacts
```

Keep the target binding, such as `--platform ios`, on the `replay` or `test` command. `agent-device help maestro` prints the same subset and boundaries as this page.

## Supported subset

- Flows: `launchApp` (with `clearState`, `permissions`, and Apple-only launch arguments; `permissions` apply after state clearing but before launch, and a `launchApp` without `permissions` touches nothing — there is no silent `all: allow` default); `setPermissions` (mid-flow permission grants, denials, and resets; `all` resolves in the backend — one simctl call on iOS, the declared permissions on Android — with specific entries overriding after it); `runFlow` file/inline; `runFlow.when` and `repeat.while` conditions (`platform`, `visible`, `notVisible`, and `true`, all re-evaluated before every `repeat` iteration); `onFlowStart`/`onFlowComplete`; `repeat` with `times`, `while`, or both; and retry.
- Interactions: `tapOn`, `doubleTapOn`, `longPressOn`, `inputText` on the focused element, `eraseText`, `openLink`, `hideKeyboard`, basic `pressKey`, and `back`; selector targets poll until available and support recursive `index`, `childOf`, `above`, `below`, `leftOf`, `rightOf`, `containsChild`, `containsDescendants`, points, and `optional`; outer command labels are metadata, not target selectors.
- Assertions and navigation: `assertVisible`, `assertNotVisible`, `assertTrue` (literal values and `${VAR}` lookups only; `""`, `"false"`, `"0"`, `"null"`, and `"undefined"` are falsy, everything else is truthy), `extendedWaitUntil`, `scroll`, `scrollUntilVisible`, absolute/percentage/target `swipe`, `takeScreenshot`, `waitForAnimationToEnd`, `clearState`, and `stopApp`.
- Scripts: ordered `runScript` file/env scripts with `http.post`, `json`, and `output` variables; `evalScript` inline expressions run flow-scoped JavaScript and write `output.*` leaves for later steps.

## Boundaries

- Permissions: every entry is one `settings permission` call, applied in order with `all` first; the step stops at the first entry the selected platform refuses, earlier entries stay applied, and the error names what landed. Android’s only allow level is while-in-use, so `location: inuse` and `location: never` mean `allow` and `deny` there, while `location: always` and `photos: limited` are Apple-only and fail. On iOS, which service a runtime changes is `simctl privacy`’s own verdict: current runtimes refuse a targeted `notifications` change and leave notifications untouched under `all`.
- Runtime: iOS and Android only; `launchApp.clearState` and standalone `clearState` support Android and iOS simulators, launch arguments are Apple-only, and other standalone device utility/state commands are unsupported.
- Expressions: `evalScript` and condition `true:` fields (`runFlow.when` and `repeat.while` share one evaluator) are evaluated as JavaScript (flow `env` and prior `output` leaves are string-typed); a `true:` field that is a boolean, a `maestro.platform` comparison, or plain literal text after `${VAR}` lookups is decided without JavaScript, with the `assertTrue` falsy table for literal text. Other fields stay literal or `${VAR}` lookup-only — `assertTrue` supports literals and bare lookups, and other expression-shaped payloads fail loud.
- Environment: flow `env` is the default, `AD_VAR_*` overrides it, and CLI `-e KEY=VALUE` wins over both.
- Failure diagnostics: resolved targets and `runFlow` paths are rendered, while `inputText` payloads remain hidden; do not place secrets in diagnostic identifiers.
- Trust: `runScript`, `evalScript`, and JavaScript condition `true:` fields execute flow scripts in-process via `node:vm`, which is not a security sandbox; `runScript` may make `http.post` network requests and its output keys cannot contain a dot. `evalScript` and `true:` fields that need JavaScript are refused outright for a flow accepted over the daemon’s remote HTTP surface, since that context can escape to the host.
- Errors and tracking: unsupported commands and fields fail with source context when available; open a focused issue only when implementation work is planned.
- Session takeover: `--keep-session` is a native `.ad` replay option and is rejected for Maestro YAML.

[ADR 0015](https://github.com/callstack/agent-device/blob/main/docs/adr/0015-direct-maestro-engine.md) lists the deliberate deviations from Maestro. If a missing feature matters for your suite, [open a focused issue](https://github.com/callstack/agent-device/issues/new) with a small flow snippet.

## Resume a failed Maestro flow

A failed Maestro step returns the same replay divergence report as an `.ad` script, including the resume information, and `replay --from <n> --plan-digest <sha256>` resumes it the same way. See [Resume a failed replay](/docs/replay-e2e#resume-a-failed-replay) for the workflow.

For Maestro flows, `--from` counts steps in the top-level plan. A `runFlow` with no condition, or with
a condition that resolves before the run, is flattened into its commands (or dropped when the condition
is false). A control step decided at run time (`runFlow`, `repeat`, or `retry`) counts as one step, and
you cannot resume at a command nested inside it. As with `.ad` replay, restore any state and
environment values the skipped steps would have set before you resume.

## Export `.ad` scripts to Maestro YAML

To run a recorded flow with Maestro, export the `.ad` script to Maestro YAML:

```bash
agent-device replay export ./workflows/checkout.ad --out ./maestro/checkout.yaml
```

`replay export` only converts the file: it does not start the daemon or contact a device. Without `--out`, it prints the YAML to stdout.

Each `open <appId>` exports with an explicit `launchApp.appId`, so a flow can switch between apps and return to the original app. The first app remains the flow's default `appId`; relaunch options and app-specific deep links stay attached to their authored targets.

Deep links, including schemes without `//` such as `tel:` and `mailto:`, export as `openLink`. A standalone `open tel:+15551234567` emits only the link command; `open com.example.app mailto:agent@example.test` emits the app launch followed by the link.

Export is strict. It writes Maestro YAML for compatible flow actions such as app launch, taps, long press, text input, keyboard dismiss/enter, back, home, text visibility assertions, coordinate swipes, basic scroll, screenshots, and `.ad` `env` directives. `home` exports as `pressKey: Home`, so flows that visit the home screen and reopen the app can be exported. Agent-only inspection or maintenance actions such as `snapshot`, `get`, `record`, `trace`, `settings`, and unsupported selector shapes fail with the source line and action instead of being silently dropped. Known semantic differences are reported as warnings; for example, `.ad` `fill` exports as `tapOn` plus `inputText`, which may append text in Maestro rather than replacing existing field contents. Native `.ad` `label=` selectors export as Maestro `text:` selectors and warn because Maestro text matching is broader than label-only matching. A strict `wait absent` is reported as unsupported rather than mapped to Maestro's more lenient `notVisible` condition.

## Troubleshooting

- A flow fails on unsupported syntax:
  - Check [ADR 0015](https://github.com/callstack/agent-device/blob/main/docs/adr/0015-direct-maestro-engine.md). If the missing feature matters to your suite, open a focused issue with a small flow snippet.
