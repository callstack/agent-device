---
title: Replay & E2E Testing
---

# Replay & E2E Testing

Agents use refs for exploration and authoring. Replay scripts are deterministic runs that can be used for E2E testing.

## Core model

Two-pass workflow:

1. Agent pass: discover and interact with refs (`snapshot` -> `click @e..` / `fill @e..`).
2. Deterministic pass: run recorded `.ad` script with `replay`.

## Record a replay script

Enable recording during a session:

```bash
agent-device open Settings --platform ios --session e2e --save-script
agent-device snapshot -i --session e2e
agent-device click @e13 --session e2e
agent-device close --session e2e
```

By default, on `close`, a replay script is written to:

```text
~/.agent-device/sessions/<session>-<timestamp>.ad
```

You can also provide a custom output file path:

```bash
agent-device open Settings --platform ios --session e2e --save-script ./workflows/e2e-settings.ad
```

- `--save-script` value is treated as a file path.
- Parent directories are created automatically when they do not exist.
- For ambiguous bare values, use `--save-script=workflow.ad` or a path-like value such as `./workflow.ad`.

## Run replay

```bash
agent-device replay ~/.agent-device/sessions/e2e-2026-02-09T12-00-00-000Z.ad --session e2e-run
```

- Replay reads `.ad` scripts.

## Run Maestro compatibility flows

Agent Device can run a supported subset of Maestro YAML through the replay runtime:

```bash
agent-device replay ./flow.yaml --maestro --platform ios --session e2e-run
agent-device test ./maestro-flows --maestro --platform android --artifacts-dir ./tmp/maestro-artifacts
```

Maestro compatibility translates supported YAML commands into Agent Device replay actions. It is intended for common mobile flows, not full Maestro parity. Unsupported Maestro syntax fails loudly with the command or field name and a line number when available. If a missing command matters for your flows, use the compatibility tracker to check current support and share demand:

- Supported and unsupported capabilities: https://github.com/callstack/agent-device/issues/558
- New focused compatibility request: https://github.com/callstack/agent-device/issues/new

Currently supported areas include app launch with Apple-platform launch arguments and Android/iOS simulator `clearState`, `runFlow` file/inline with `when.platform`, `when.visible`, `when.notVisible`, and limited `when.true` boolean/platform expressions, `onFlowStart` and `onFlowComplete` hooks, deterministic `repeat.times`, `tapOn` including `optional`, `index`, `childOf`, `label`, and absolute/percentage point taps, `doubleTapOn` and `longPressOn`, `inputText`, focused-field `eraseText`, and `pasteText`, `openLink`, visibility assertions and `extendedWaitUntil`, `scroll` and `scrollUntilVisible`, absolute/percentage `swipe` and `swipe.label`, screenshots, keyboard dismiss, basic `pressKey`, `back`, animation waits, and `stopApp`, and ordered trusted `runScript` file/env scripts with `http.post`, `json`, and `output` variables. `runScript` is supported only as an ordered Maestro compatibility step for trusted file/env scripts; it can make network requests, and is not a native `.ad` command or security sandbox. Script execution uses Node `vm` only for compatibility isolation, not for security; the script timeout bounds synchronous execution, while `http.post` requests are bounded by the helper process timeout. Output keys cannot contain `.` because exported variables are addressed as `output.<key>`.

Maestro `env` values use the same replay precedence as `.ad` files: flow `env` is the default, shell `AD_VAR_*` values override it, and CLI `-e KEY=VALUE` wins over both.

Unsupported Maestro features such as `repeat.while`, full expression predicates beyond boolean literals and `maestro.platform` comparisons, `evalScript`, device utility commands, Android app launch arguments, and Android app state reset are tracked separately because they require neutral Agent Device runtime or device capabilities before they can be mapped safely.

## Export `.ad` scripts to Maestro YAML

Replay scripts can be exported to a Maestro YAML subset when you need to hand a recorded Agent Device flow to a Maestro runner:

```bash
agent-device replay export ./workflows/checkout.ad --format maestro --out ./maestro/checkout.yaml
```

`replay export` is a local file transform. It does not start the daemon or contact a device. If `--out` is omitted, the YAML is printed to stdout.

The exporter is intentionally strict. It writes Maestro YAML for compatible flow actions such as app launch, taps, long press, text input, keyboard dismiss/enter, back, text visibility assertions, coordinate swipes, basic scroll, screenshots, and `.ad` `env` directives. Agent-only inspection or maintenance actions such as `snapshot`, `get`, `record`, `trace`, `settings`, and unsupported selector shapes fail with the source line and action instead of being silently dropped. Known semantic differences are reported as warnings; for example, `.ad` `fill` exports as `tapOn` plus `inputText`, which may append text in Maestro rather than replacing existing field contents.

## Run a lightweight `.ad` suite

```bash
agent-device test ./workflows
agent-device test "./workflows/**/*.ad" --platform android
agent-device test ./workflows --timeout 60000 --retries 1
agent-device test ./workflows --artifacts-dir ./tmp/agent-device-artifacts
agent-device test ./workflows --reporter default --reporter junit:./tmp/junit.xml
```

- `test` discovers `.ad` files from files, directories, or globs and runs them serially.
- `context platform=...` inside each `.ad` file is the target source of truth for suite execution.
- `--platform` is a filter for suite discovery; files without platform metadata are skipped when a filter is present.
- `context timeout=...` and `context retries=...` can be declared per script; CLI flags override metadata. Retries are capped at `3`, and duplicate keys in the context header fail fast instead of silently overriding each other.
- By default, suite artifacts are written under `.agent-device/test-artifacts/<run-id>/...`. Each attempt writes `replay.ad`, `result.txt`, and `replay-timing.ndjson`. Failed attempts also keep copied logs and artifact files when the replay produced them.
- `replay-timing.ndjson` records attempt, cleanup, and per-step start/stop events with durations. Upload it from CI even for passing runs when comparing local and CI performance.
- Timeouts are cooperative: the runner marks the attempt failed at the timeout boundary, then gives the underlying replay a short grace period to stop before session cleanup.
- The default text reporter streams live progress on stderr while a suite runs, then prints the final summary, failed tests, and passed-on-retry flaky tests. Use `--verbose` to include step traces in completed-test progress output.
- `--reporter` is repeatable. Built-ins are `default` for the console summary and `junit:<path>` for JUnit XML. Passing any explicit reporter list replaces the implicit default reporter, so include `--reporter default` when you also want terminal output. `--report-junit <path>` remains a compatibility alias for `--reporter junit:<path>`.
- When `--fail-fast` and retries are both set, the current test still consumes its retries before the suite stops.

### Custom test reporters

Custom reporters are CLI-only presentation adapters. The daemon streams progress and returns the structured replay suite result; reporters run in the local CLI process and can render both live progress and final output.

```bash
agent-device test ./workflows --reporter ./scripts/replay-reporter.mjs
```

Reporter modules can export a reporter object, `reporter`, `createReporter`, or a default factory. Factories receive load context. Reporter hooks receive replay test domain objects and an IO context with `stdout` and `stderr` streams:

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
    const icon =
      test.status === 'pass' ? '✓' : test.status === 'fail' ? '⨯' : '-';
    const title = test.title?.trim() || test.file;
    const duration =
      typeof test.durationMs === 'number'
        ? ` ${(test.durationMs / 1000).toFixed(2)}s`
        : '';

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

Live reporter hooks are semantic: `onSuiteStart`, `onTestStart`, `onTestStep`, and `onTestResult` run while the daemon request is active; generic command progress frames are not exposed to test reporters. These live hooks are synchronous — they run from the progress stream as events arrive and are not awaited, so keep their work synchronous and defer anything async to `onSuiteEnd`, which the CLI awaits before exiting. `onSuiteEnd` receives the final suite result. `getExitCode` can only raise the suite exit code, never lower it: the highest reporter-provided code wins and failed tests still exit with `1` when no reporter raises it further, so a reporter cannot mask a failing suite.

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

Built-ins are provided by replay/test runtime and use the reserved `AD_*` namespace.

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

- Shell env (`AD_VAR_*`) is collected on the CLI/client side at request time, so the same values are seen whether the daemon runs locally or remotely.
- No nested fallback. `${A:-${B}}` is not supported.
- Unresolved `${VAR}` fails with a `file:line` reference. Typos are loud.

## Replay divergence and resume

A failing `replay`/`test` step returns a structured `REPLAY_DIVERGENCE` error instead of a bare failure. The report carries, bounded and redacted:

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
      "screen": { "state": "available", "refsGeneration": 3, "refs": [ /* ... */ ] },
      "suggestions": [{ "selector": "id=\"auth_continue\"", "basis": "id" }],
      "resume": { "allowed": true, "from": 4, "planDigest": "…64 hex chars…" }
    }
  }
}
```

Text output prints a compact summary of the same fields; `--json`/MCP carry the full object.

### Resuming a failed replay

`replay --from <n> --plan-digest <sha256>` resumes **at** plan step `n`, not after it, skipping `1..n-1` without executing them. Both flags come from a divergence report's `resume` field — `from` is the failed step, `planDigest` is the digest of the exact unchanged plan that produced it.

Choose one recovery workflow:

1. **Change the replay script.** Review the suggestion, edit the selector or include, then run a fresh full `replay ./flow.ad`. The old digest is intentionally invalid after any plan edit; do not combine it with the edited script. A later divergence supplies a new digest.
2. **Keep the replay plan unchanged.** Repair app/device state so the reported failed step can succeed when retried, then resume with the report's unchanged `from` and `planDigest`. If you manually complete the failed action itself, the reported `from` will execute it again; only do that when repeating the action is safe.

The unchanged-plan resume loop is:

1. Run `replay ./flow.ad`. On failure, read `resume` from the divergence.
2. Leave the script, includes, platform, and target unchanged. Repair app state yourself so the failed step can be retried safely. The daemon never infers or reconstructs app state — it only skips execution of the earlier steps.
3. `replay ./flow.ad --from <resume.from> --plan-digest <resume.planDigest>`.

```bash
agent-device replay ./flow.ad
# ... REPLAY_DIVERGENCE, resume: { allowed: true, from: 4, planDigest: "ab12...“ }
# (repair app state on the device)
agent-device replay ./flow.ad --from 4 --plan-digest ab12...
```

`resume.allowed` is `false`, with a `reason`, when resuming cannot be proven safe:

- a skipped step can produce `outputEnv` values (a Maestro `runScript` step) a later step might consume;
- the skipped range or the resume target itself is runtime control flow (a Maestro `retry:` or `runFlow.when:` block) — these execute dynamically and are never individually addressable by `--from`.

Passing `--plan-digest` that no longer matches the current script — because you edited it, an include changed, or platform-conditioned expansion differs — fails `INVALID_ARGS` before any action; run a fresh full replay to get a new digest. `--from` is `replay`-only; `test` rejects it (a suite run must stay full and deterministic).

## `--update`/`-u` (retired)

`--update`/`-u` no longer rewrites `.ad` files. Historically it retried a failing step against the recorded selector's candidate material and rewrote the line in place; the audit behind [ADR 0012](https://github.com/callstack/agent-device/blob/main/docs/adr/0012-interactive-replay.md) found that mechanism rarely able to act (it can only recover drift the original selector still matches, never a rename) and a silent rewrite is a target-binding risk on its own. The flag is kept, accepted, and is a complete no-op: every replay divergence already carries the same ranked `suggestions` the old heal path used to apply blind, whether or not `--update` is passed. Review a suggestion, then edit the `.ad` file yourself if it's right.

## Troubleshooting

- Replay fails after UI/layout changes:
  - Read the divergence report's `suggestions` and repair the selector by hand; there is no automated rewrite. Because the edit changes the plan digest, run a fresh full replay instead of using the old resume flags.
- Repeated re-runs are slow or the app is stateful, but the script is still correct:
  - Leave the replay plan unchanged, repair app state so the reported failed step can be retried, then use its `--from`/`--plan-digest`. Resume starts at `--from`; it does not skip that step.
- Replay file parse error:
  - Validate quoting in `.ad` lines (unclosed quotes are rejected).
- Maestro compatibility flow fails on unsupported syntax:
  - Check the linked command or field in https://github.com/callstack/agent-device/issues/558. If it is important to your suite, comment there or open a focused issue with a small flow snippet.
