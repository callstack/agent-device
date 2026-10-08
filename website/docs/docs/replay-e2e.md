---
title: Replay & E2E Testing
---

# Replay & E2E Testing

Record a session as an `.ad` script, then run it again with `replay` or run a folder of scripts as an E2E suite with `test`.

## How it works

You work in two passes:

1. Explore: discover elements and act on refs (`snapshot` -> `click @e..` / `fill @e..`) while recording.
2. Replay: run the recorded `.ad` script with `replay` for a deterministic run.

## Record a replay script

Pass `--save-script` to `open`. When you `close` the session, the script is written:

```bash
agent-device open Settings --platform ios --session e2e --save-script
agent-device snapshot -i --session e2e
agent-device click @e13 --session e2e
agent-device close --session e2e
```

By default, the script goes to:

```text
~/.agent-device/sessions/<session>-<timestamp>.ad
```

To choose the output file, pass a path to `--save-script`:

```bash
agent-device open Settings --platform ios --session e2e --save-script ./workflows/e2e-settings.ad
```

- Missing parent directories are created.
- The script is written on the machine running the daemon, so `--save-script` is rejected when you use a remote daemon.
- For a bare file name that could be read as another argument, use `--save-script=workflow.ad` or a path-like value such as `./workflow.ad`.

## `.ad` line grammar

A `.ad` line is the CLI spelling of one command: `<command> [positional ...] [flag ...]`. Whitespace separates tokens, so a value with a space needs quotes.

```sh
open "com.example.app" --relaunch
scroll down --until 'id="far-button"'
press id="far-button"
wait 'label="Order summary"' 5000
close
```

- A token quoted with `"` or `'` is one argument. Single quotes keep a `"` literal, so `'id="far-button"'` and `"id=\"far-button\""` are the same selector — write whichever matches how you typed the command at the shell.
- Values in double quotes are JSON strings, so escape `\\`, `\"`, `\t`, and `\n`. Values in single quotes are literal, as at the shell: a backslash keeps its own character, and the only escape is `\'` for an apostrophe.
- A script line keeps only the flags that command records; CLI-only spellings and per-request options are not part of a step. The common flags a script does not carry are `--settle`, `--verify`, `scroll --pixels`/`--duration-ms`, and the device-selection flags (`--platform`, `--serial`, `--device`).
- `help <command>` prints the flags each command accepts. `help scripting` prints this grammar.

To reach an off-screen element, use a stop condition rather than a fixed scroll amount. A fixed amount passes on one screen size and fails on another:

```sh
# repeats until the element is on screen
scroll down --until 'id="checkout-submit"'
# one gesture, viewport-relative
scroll down 0.8
# run to the end of the content
scroll bottom
```

A `#` only starts a comment at the beginning of a line. A scroll line carries `--until` and keeps its distance as a positional (`scroll down 0.8 --until <selector>`). `wait` carries `--raw`, `--depth <n>`, and `--scope <selector|@ref>` to choose the capture its target is read from. Scripts use only these long spellings: the `-d`/`-s` CLI aliases are not flags in a script, so a hand-written line such as `wait text -s so funny` still waits for that literal text.

## Run replay

```bash
agent-device replay ~/.agent-device/sessions/e2e-2026-02-09T12-00-00-000Z.ad --session e2e-run
```

- Replay reads `.ad` scripts.
- The CLI reads script paths on your machine and sends the script, with the Maestro `runFlow` includes it can resolve and read, to the daemon. An include it cannot read is left out, and the run fails if it reaches that include. The same `replay` or `test` command works against a local or a remote daemon without copying files. A script that doesn't exist on your machine fails at once, naming the path you typed.
- A script that does not end in `close` leaves its session open. For a script that does end in
  `close`, pass `--keep-session` to skip only that final action and keep working in the same
  session:

  ```bash
  agent-device replay ./checkout.ad --session e2e-run --keep-session
  agent-device snapshot -i --session e2e-run
  ```

  Earlier `close` actions still run. `test` does not accept the flag because each suite attempt
  cleans up its own session.
- `press`, `click`, and `longpress` steps wait up to 2 seconds for their target to appear before
  they fail, so a step recorded against a screen that was still loading passes once the target
  shows up. The wait covers only a target that is not on screen yet: a target that is covered,
  off-screen, or matched by more than one element fails at once, as it does live. The replay output
  does not show the wait for a step that passed; run with `--debug` to see it in the diagnostics.
- When the target never appears, replay stops with `REPLAY_DIVERGENCE`, and
  `error.details.readiness` says how long the step waited and how many times it looked (`waitedMs`,
  `polls`, `end`). For a step recorded with a target annotation (the `# agent-device:target-v1`
  line above it), `error.details.divergence.kind` is `selector-miss` and the step is never sent.
  For a step without an annotation, `error.details.reason` is `selector_not_found`, as for a live
  command. If the app shows an empty accessibility tree during that wait, `error.details.reason`
  is `capture_sparse` instead; take a snapshot to see where the app is.

## Run Maestro compatibility flows

Pass `--maestro` to `replay` or `test` to run Maestro YAML flows. Only the subset below is supported:

```bash
agent-device replay ./flow.yaml --maestro --platform ios --session e2e-run
agent-device test ./maestro-flows --maestro --platform android --artifacts-dir ./tmp/maestro-artifacts
```

Supported subset:

- Flows: `launchApp` (with `clearState`, `permissions`, and Apple-only launch arguments; `permissions` apply after state clearing but before launch, and a `launchApp` without `permissions` touches nothing — there is no silent `all: allow` default); `setPermissions` (mid-flow permission grants, denials, and resets; `all` resolves in the backend — one simctl call on iOS, the declared permissions on Android — with specific entries overriding after it); `runFlow` file/inline; `runFlow.when` and `repeat.while` conditions (`platform`, `visible`, `notVisible`, and `true`, all re-evaluated before every `repeat` iteration); `onFlowStart`/`onFlowComplete`; `repeat` with `times`, `while`, or both; and retry.
- Interactions: `tapOn`, `doubleTapOn`, `longPressOn`, `inputText` on the focused element, `eraseText`, `openLink`, `hideKeyboard`, basic `pressKey`, and `back`; selector targets poll until available and support recursive `index`, `childOf`, `above`, `below`, `leftOf`, `rightOf`, `containsChild`, `containsDescendants`, points, and `optional`; outer command labels are metadata, not target selectors.
- Assertions and navigation: `assertVisible`, `assertNotVisible`, `assertTrue` (literal values and `${VAR}` lookups only; `""`, `"false"`, `"0"`, `"null"`, and `"undefined"` are falsy, everything else is truthy), `extendedWaitUntil`, `scroll`, `scrollUntilVisible`, absolute/percentage/target `swipe`, `takeScreenshot`, `waitForAnimationToEnd`, `clearState`, and `stopApp`.
- Scripts: ordered `runScript` file/env scripts with `http.post`, `json`, and `output` variables; `evalScript` inline expressions run flow-scoped JavaScript and write `output.*` leaves for later steps.

Boundaries:

- Permissions: every entry is one `settings permission` call, applied in order with `all` first; the step stops at the first entry the selected platform refuses, earlier entries stay applied, and the error names what landed. Android’s only allow level is while-in-use, so `location: inuse` and `location: never` mean `allow` and `deny` there, while `location: always` and `photos: limited` are Apple-only and fail. On iOS, which service a runtime changes is `simctl privacy`’s own verdict: current runtimes refuse a targeted `notifications` change and leave notifications untouched under `all`.
- Runtime: iOS and Android only; `launchApp.clearState` and standalone `clearState` support Android and iOS simulators, launch arguments are Apple-only, and other standalone device utility/state commands are unsupported.
- Expressions: `evalScript` and condition `true:` fields (`runFlow.when` and `repeat.while` share one evaluator) are evaluated as JavaScript (flow `env` and prior `output` leaves are string-typed); a `true:` field that is a boolean, a `maestro.platform` comparison, or plain literal text after `${VAR}` lookups is decided without JavaScript, with the `assertTrue` falsy table for literal text. Other fields stay literal or `${VAR}` lookup-only — `assertTrue` supports literals and bare lookups, and other expression-shaped payloads fail loud.
- Environment: flow `env` is the default, `AD_VAR_*` overrides it, and CLI `-e KEY=VALUE` wins over both.
- Failure diagnostics: resolved targets and `runFlow` paths are rendered, while `inputText` payloads remain hidden; do not place secrets in diagnostic identifiers.
- Trust: `runScript`, `evalScript`, and JavaScript condition `true:` fields execute flow scripts in-process via `node:vm`, which is not a security sandbox; `runScript` may make `http.post` network requests and its output keys cannot contain a dot. `evalScript` and `true:` fields that need JavaScript are refused outright for a flow accepted over the daemon’s remote HTTP surface, since that context can escape to the host.
- Errors and tracking: unsupported commands and fields fail with source context when available; open a focused issue only when implementation work is planned.
- Session takeover: `--keep-session` is a native `.ad` replay option and is rejected for Maestro YAML.

[ADR 0015](https://github.com/callstack/agent-device/blob/main/docs/adr/0015-direct-maestro-engine.md) lists the deliberate deviations from Maestro. If a missing feature matters for your suite, [open a focused issue](https://github.com/callstack/agent-device/issues/new) with a small flow snippet.

## Export `.ad` scripts to Maestro YAML

To run a recorded flow with Maestro, export the `.ad` script to Maestro YAML:

```bash
agent-device replay export ./workflows/checkout.ad --out ./maestro/checkout.yaml
```

`replay export` only converts the file: it does not start the daemon or contact a device. Without `--out`, it prints the YAML to stdout.

Each `open <appId>` exports with an explicit `launchApp.appId`, so a flow can switch between apps and return to the original app. The first app remains the flow's default `appId`; relaunch options and app-specific deep links stay attached to their authored targets.

Deep links, including schemes without `//` such as `tel:` and `mailto:`, export as `openLink`. A standalone `open tel:+15551234567` emits only the link command; `open com.example.app mailto:agent@example.test` emits the app launch followed by the link.

Export is strict. It writes Maestro YAML for compatible flow actions such as app launch, taps, long press, text input, keyboard dismiss/enter, back, home, text visibility assertions, coordinate swipes, basic scroll, screenshots, and `.ad` `env` directives. `home` exports as `pressKey: Home`, so flows that visit the home screen and reopen the app can be exported. Agent-only inspection or maintenance actions such as `snapshot`, `get`, `record`, `trace`, `settings`, and unsupported selector shapes fail with the source line and action instead of being silently dropped. Known semantic differences are reported as warnings; for example, `.ad` `fill` exports as `tapOn` plus `inputText`, which may append text in Maestro rather than replacing existing field contents. Native `.ad` `label=` selectors export as Maestro `text:` selectors and warn because Maestro text matching is broader than label-only matching. A strict `wait absent` is reported as unsupported rather than mapped to Maestro's more lenient `notVisible` condition.

## Run a lightweight `.ad` suite

```bash
agent-device test ./workflows
agent-device test "./workflows/**/*.ad" --platform android
agent-device test ./workflows --timeout 60000 --retries 1
agent-device test ./workflows --artifacts-dir ./tmp/agent-device-artifacts
agent-device test ./workflows --reporter default --reporter junit:./tmp/junit.xml
```

- `test` discovers `.ad` files from files, directories, or globs and runs them serially.
- Quote relative globs to expand them on the caller from its working directory, including when the directory name contains glob characters such as `[` or `{`. A missing file input without glob characters reports an error.
- The `context platform=...` header inside each `.ad` file decides which platform that file runs on.
- `--platform` filters which files run; with a filter, files without a `context platform=` header are skipped. When filtering leaves no runnable sources, the no-match error reports how many sources were skipped for having no `context platform=` header versus how many declared another platform. Add the header to run a file under a filter, or omit `--platform` and let the selected device decide.
- Set `context timeout=...` and `context retries=...` per script; CLI flags override them. Retries are capped at `3`, and duplicate keys in the context header fail fast instead of silently overriding each other.
- By default, suite artifacts are written under `.agent-device/test-artifacts/<run-id>/...`. Each attempt writes `replay.ad`, `result.txt`, and `replay-timing.ndjson`. Failed attempts also keep copied logs and artifact files when the replay produced them.
- Copied diagnostic artifacts receive numbered filenames when their names collide with another artifact, a replay source, timing trace, or attempt manifest. `result.txt` lists the retained names in `copiedArtifacts`.
- `replay-timing.ndjson` records attempt, cleanup, and per-step start/stop events with durations. Upload it from CI even for passing runs when comparing local and CI performance.
- When an attempt hits its timeout, it is marked failed and the replay gets a short grace period to stop before the session is cleaned up.
- The default text reporter streams live progress on stderr while a suite runs, then prints the final summary, failed tests, and passed-on-retry flaky tests. Use `--verbose` to include step traces in completed-test progress output.
- The default reporter prints a `Warnings:` section after the summary when any test accumulated composable warnings — for example a Maestro step with `optional: true` that was skipped — whether that test passed or failed. A failing `replay` run repeats the warnings it accumulated as `Warning:` lines after the error. `--json` carries the same strings in each test result's `warnings` array.
- `--reporter` is repeatable. Built-ins are `default` for the console summary and `junit:<path>` for JUnit XML. Passing any explicit reporter list replaces the implicit default reporter, so include `--reporter default` when you also want terminal output. `--report-junit <path>` is an alias for `--reporter junit:<path>`.
- JUnit reports preserve legal Unicode and whitespace, and replace characters forbidden by XML 1.0 (such as terminal ESC or NUL) with `U+FFFD` (`�`) so CI parsers can read the report. JSON and other reporters retain the original suite values.
- When `--fail-fast` and retries are both set, the current test still consumes its retries before the suite stops.

### Custom test reporters

A custom reporter formats suite output. It runs in the local CLI process, not the daemon, and can render both live progress and the final result.

```bash
agent-device test ./workflows --reporter ./scripts/replay-reporter.mjs
```

A reporter module can export a reporter object, `reporter`, `createReporter`, or a default factory. Factories receive a load context. Reporter hooks receive replay test objects and an IO context with `stdout` and `stderr` streams:

```js
// scripts/replay-reporter.mjs
import fs from 'node:fs';
import path from 'node:path';

export default function createReporter(loadContext) {
  return {
    name: 'summary-file',
    onTestStep(test, context) {
      context.stderr.write(`running ${test.file} ${test.stepIndex}/${test.stepTotal}\n`);
    },
    onSuiteEnd(suite, context) {
      context.stdout.write(`finished ${suite.total} tests\n`);
      fs.mkdirSync('./tmp', { recursive: true });
      fs.writeFileSync(
        path.join('./tmp', 'report.txt'),
        JSON.stringify(
          {
            total: suite.total,
            passed: suite.passed,
            failed: suite.failed,
            modulePath: loadContext.modulePath,
          },
          null,
          2,
        ),
        'utf8',
      );
    },
    getExitCode(suite) {
      return suite.failed > 0 ? 1 : 0;
    },
  };
}
```

For a live terminal reporter that prints each completed test as an emoji, title, and duration:

```js
// scripts/emoji-reporter.mjs
export default {
  name: 'emoji-status',
  onTestResult(test, context) {
    const icon = test.status === 'pass' ? '✓' : test.status === 'fail' ? '⨯' : '-';
    const title = test.title?.trim() || test.file;
    const duration =
      typeof test.durationMs === 'number' ? ` ${(test.durationMs / 1000).toFixed(2)}s` : '';

    context.stderr.write(`${icon} ${title}${duration}\n`);
  },
};
```

TypeScript reporters use the same object shape; compile them to JavaScript before passing them to `--reporter`:

```ts
const createReporter = () => ({
  name: 'typed-reporter',
  onSuiteStart(suite, context) {
    context.stderr.write(`starting ${suite.runnable} tests\n`);
  },
  onTestResult(test, context) {
    context.stderr.write(`${test.status} ${test.title ?? test.file}\n`);
  },
  onSuiteEnd(suite) {
    // Write artifacts, annotations, or summaries from suite.
  },
});

export default createReporter;
```

The CLI loads reporter modules with Node dynamic `import()`. Use `.mjs` or `.js` files at runtime; for TypeScript, compile the reporter to JavaScript before passing it to `--reporter`. Loading `.ts` files directly depends on Node's type-stripping behavior and is not part of the supported reporter contract.

The live hooks `onSuiteStart`, `onTestStart`, `onTestStep`, and `onTestResult` run while the suite is running; reporters do not receive generic command progress. Live hooks run as events arrive and are not awaited, so keep their work synchronous and move anything async to `onSuiteEnd`, which the CLI awaits before exiting. `onSuiteEnd` receives the final suite result. `getExitCode` can only raise the suite exit code, never lower it: the highest reporter-provided code wins and failed tests still exit with `1` when no reporter raises it further, so a reporter cannot mask a failing suite. Return an integer from `0` to `255`, or `undefined` to leave the exit code unchanged. Other values fail with `INVALID_ARGS`; in particular, codes such as `256` are rejected before they can wrap to a successful process exit.

## Parametrise `.ad` scripts

Substitute `${VAR}` tokens in `.ad` scripts using values from the CLI, shell env, script-local `env` directives, or built-ins.

```sh
context platform=android
env APP_ID=settings
env WAIT_SHORT=500

open ${APP_ID} --relaunch
wait ${WAIT_SHORT}
click "label=${APP_ID}"
```

### Precedence

| Source                       | Priority | Example                                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------------------- |
| CLI `-e KEY=VALUE`           | highest  | `agent-device test flow.ad -e APP_ID=demo`                              |
| Shell env prefixed `AD_VAR_` |          | `AD_VAR_APP_ID=demo agent-device test flow.ad` (imported as `APP_ID`)   |
| Script `env KEY=VALUE`       |          | `env APP_ID=settings` in header                                         |
| Built-ins                    | runtime  | `AD_PLATFORM`, `AD_SESSION`, `AD_FILENAME`, `AD_DEVICE`, `AD_ARTIFACTS` |

### Built-ins

`replay` and `test` provide these built-ins in the reserved `AD_*` namespace.

- `AD_PLATFORM` - matches `context platform=...` or the selected platform when available
- `AD_SESSION` - active session name
- `AD_FILENAME` - path of the running `.ad` file
- `AD_DEVICE` - device identifier (when `--device` is set)
- `AD_ARTIFACTS` - attempt artifacts directory (when running under `test`)

User-defined keys starting with `AD_` are rejected in `env`, `-e`, and shell imports such as `AD_VAR_AD_FOO`, so built-ins cannot be overridden.

Substitution happens inside parsed string values. It does not create extra arguments, so quote selectors or text values that contain spaces:

```sh
env SETTINGS="label=Account || label=Profile"
click "${SETTINGS}"
```

### Fallback and escape

```sh
wait ${WAIT_MS:-500}
```

`${VAR:-default}` yields `default` when `VAR` is unset.

```sh
echo "Price: \${APP}"
```

`\${APP}` emits a literal `${APP}` with no substitution.

### Recipes

Run one flow against two app variants in CI:

```sh
agent-device test ./flows/login.ad -e APP_ID=com.example.debug
agent-device test ./flows/login.ad -e APP_ID=com.example.release
```

Tune timings locally without editing the script:

```sh
AD_VAR_WAIT_SHORT=2000 agent-device replay ./flow.ad
```

Extract a reusable selector. Before:

```sh
click "label=Account || label=Profile || label=User"
wait 500
click "label=Account || label=Profile || label=User"
```

After:

```sh
env SETTINGS="label=Account || label=Profile || label=User"

click "${SETTINGS}"
wait 500
click "${SETTINGS}"
```

Quote `${VAR}` inside selector expressions so the whole expression is treated as a single argument.

### Notes

- `AD_VAR_*` values come from the shell that runs the CLI, so they apply the same way whether the daemon runs locally or remotely.
- Fallbacks do not nest: `${A:-${B}}` is not supported.
- An unresolved `${VAR}` fails with a `file:line` reference, so a misspelled variable name stops the run.

## Replay divergence and resume

A failing `replay`/`test` step returns a structured `REPLAY_DIVERGENCE` error. The report is size-bounded and redacted, and carries:

- **`step`** — the 1-based plan index and its source file/line (through Maestro `runFlow` includes).
- **`screen`** — a fresh post-failure snapshot digest with actionable refs, or `unavailable` with a reason/hint when capture failed or was sparse (never a stale tree).
- **`suggestions`** — up to 5 ranked, re-resolved candidates for the failing selector (id match ranks above role+label, which ranks above label-only), each with a `basis` you can inspect before acting.
- **`resume`** — whether and how to continue without re-running the script from the top.

```jsonc
{
  "code": "REPLAY_DIVERGENCE",
  "details": {
    "divergence": {
      "step": { "index": 4, "source": { "path": "flow.ad", "line": 6 } },
      "screen": {
        "state": "available",
        "refsGeneration": 3,
        "refs": [
          /* ... */
        ],
      },
      "suggestions": [{ "selector": "id=\"auth_continue\"", "basis": "id" }],
      "resume": { "allowed": true, "from": 4, "planDigest": "…64 hex chars…" },
    },
  },
}
```

Text output prints a compact summary of the same fields; `--json`/MCP carry the full object.

## Resume a failed replay

`replay --from <n> --plan-digest <sha256>` resumes **at** plan step `n`, not after it, skipping `1..n-1` without executing them. Both flags come from a divergence report's `resume` field — `from` is the failed step, `planDigest` is the digest of the exact unchanged plan that produced it.

Choose one recovery workflow:

1. **Change the replay script.** Review the suggestion, edit the selector or include, then run a fresh full `replay ./flow.ad`. The old digest is intentionally invalid after any plan edit; do not combine it with the edited script. A later divergence supplies a new digest.
2. **Keep the replay plan unchanged.** Repair app/device state so the reported failed step can succeed when retried, then resume with the report's unchanged `from` and `planDigest`. If you manually complete the failed action itself, the reported `from` will execute it again; only do that when repeating the action is safe.

The unchanged-plan resume loop is:

1. Run `replay ./flow.ad`. On failure, read `resume` from the divergence.
2. Leave the script, includes, platform, and target unchanged. Repair app state yourself so the failed step can be retried safely. Resume does not restore app state; it only skips the earlier steps.
3. `replay ./flow.ad --from <resume.from> --plan-digest <resume.planDigest>`.

```bash
agent-device replay ./flow.ad
# ... REPLAY_DIVERGENCE, resume: { allowed: true, from: 4, planDigest: "ab12...“ }
# (repair app state on the device)
agent-device replay ./flow.ad --from 4 --plan-digest ab12...
```

For Maestro flows, `--from` counts steps in the top-level plan. A `runFlow` with no condition, or with
a condition that resolves before the run, is flattened into its commands (or dropped when the condition
is false). A control step decided at run time (`runFlow`, `repeat`, or `retry`) counts as one step, and
you cannot resume at a command nested inside it. As with `.ad` replay, restore any state and
environment values the skipped steps would have set before you resume.

Passing `--plan-digest` that no longer matches the current script — because you edited it, an include changed, or platform-conditioned expansion differs — fails `INVALID_ARGS` before any action; run a fresh full replay to get a new digest. `--from` is `replay`-only; `test` rejects it (a suite run must stay full and deterministic).

## `--update`/`-u` (retired)

`--update`/`-u` does not rewrite `.ad` files. The flag is accepted and does nothing: every replay divergence carries ranked `suggestions` whether or not you pass it. Review a suggestion, then edit the `.ad` file yourself if it's right. [ADR 0012](https://github.com/callstack/agent-device/blob/main/docs/adr/0012-interactive-replay.md) explains why automatic rewriting was retired.

## Troubleshooting

- Replay fails after UI/layout changes:
  - Read the divergence report's `suggestions` and repair the selector by hand; there is no automated rewrite. Because the edit changes the plan digest, run a fresh full replay instead of using the old resume flags.
- Repeated re-runs are slow or the app is stateful, but the script is still correct:
  - Repair app state and resume with the unchanged `--from`/`--plan-digest`. See [Resume a failed replay](#resume-a-failed-replay).
- Replay file parse error:
  - Validate quoting in `.ad` lines (unclosed double quotes are rejected). A selector with a space
    needs quotes, and `help scripting` states how each quote form decodes.
- A replay passes on one device size and fails on another because a target was off screen:
  - The script used a fixed `scroll` amount. Replace it with the stop condition, `scroll down --until <selector>`,
    which repeats until the element is actually on screen.
- A `press` or `click` step fails because its target was not found, but the element is on the
  screenshot:
  - A `selector-miss` divergence, or `error.details.readiness.end: expired`, means the element was
    not in the accessibility tree for the whole 2-second wait: the selector is wrong for this
    build, or the element is not exposed to accessibility. `readiness.end: sparse` means the app
    showed an empty tree: the screen was mid-transition or the app had left. Add a `wait` step for
    a landmark on the new screen before the press.
- Maestro compatibility flow fails on unsupported syntax:
  - Check [ADR 0015](https://github.com/callstack/agent-device/blob/main/docs/adr/0015-direct-maestro-engine.md). If the missing feature matters to your suite, open a focused issue with a small flow snippet.
