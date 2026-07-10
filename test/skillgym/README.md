# Skillgym For agent-device

This folder is a starter `skillgym` setup for benchmarking the `agent-device` skill with a controlled Expo target app.

## Why `skillgym` fits here

`skillgym` is useful for `agent-device` in three layers:

1. Skill-routing checks: verify that the runner loads `skills/agent-device/SKILL.md` and its required references before it answers.
2. Workflow-planning checks: verify that the agent describes the right `agent-device` loop for a known fixture app.
3. Optional live-device smoke runs: locally, you can extend prompts so the agent actually drives `agent-device` against a simulator or device.

The included suite focuses on the first two layers so it stays stable and CI-safe.
The suite uses SkillGym v0.8 case tags:

- `fixture-smoke`: fixture-specific app surface coverage
- `skill-guidance`: command-planning guidance regressions

## Included files

- `../../examples/test-app/`: minimal Expo SDK 56 development-build fixture app for broad UI coverage
- `skillgym.config.ts`: starter config that runs Codex and Claude Haiku against this repo
- `suites/agent-device-smoke-suite.ts`: planning suite for skill routing, fixture-aware flows, and skill-guidance regressions

## Current coverage

The suite keeps the app small while separating coverage into two non-overlapping groups.

Fixture smoke cases cover concrete app surfaces:

- open/snapshot/close defaults with the installed Expo development build
- banners, alerts, toggles, and quick actions on Home
- search debounce, filters, long-list scroll, favorites, and cart updates in Catalog
- detail navigation, quantity edits, note append, and save-to-cart on Product
- form validation, success submit, iOS keyboard-dismiss fallback, and reset on Checkout form
- diagnostics load/error/retry plus reset alert handling in Settings
- accessibility audit via screenshot + snapshot

Skill-guidance regression cases cover distinct command-planning habits:

- read-only inspection versus mutation
- fresh `@ref` targeting, durable selectors, raw-rect fallbacks, and off-screen scroll recovery
- interpreting representative `agent-device` output, including settled diffs, not-settled hints, and private-AX recovery warnings
- text replacement, append semantics, supported field clearing, keyboard status, and keyboard fallback
- install/open setup, Expo Go/dev-client launch paths, app discovery, session scoping, and app-owned navigation fallbacks
- Metro reload, logs, network dump, alert fallback, and screenshot evidence
- performance metrics, React DevTools profiling, gestures, settings, and trace capture
- remote config, macOS menu bar surfaces, replay update, same-session mutation ordering, and batch schema/recording

Use SkillGym for stable behavior regressions: can a runner choose the right next command from help, app-contract facts, or representative CLI output? For rapid help-layout A/B testing, prefer the lighter help conformance bench (`scripts/help-conformance-bench.mjs`) because it can feed only the top-level first screen or one help topic without letting the runner read the full help page, it runs runner x case pairs concurrently (`HELP_BENCH_CONCURRENCY`, default 4), and it can grade a draft help rewrite with zero rebuild via `--override-doc <topicId>=<path>` (repeatable; last occurrence per topic wins), which loads that file's contents in place of shelling out to `node bin/agent-device.mjs help <topicId>` for that one topic while still applying the same post-processing as the live source (the `--help:first30` doc id stays capped to its first 30 lines), so the A/B grade compares like with like; a topic id no selected case uses fails fast instead of silently grading the real doc. It also includes three "next-command quiz" cases (`settle-diff-is-observation`, `sample-output-settled-diff-next-target`, `sample-output-not-settled-needs-observe`) ported from this suite's skill-guidance regressions, for scoring how a runner reads representative captured `agent-device` output — including the `--settle` "unchanged interactive (N):" tail — instead of full help text. Filter with `--cases`/`--case` and `--runners`/`--runner` (both repeatable/CSV) the same way as this suite.

`assertAgentDeviceEvidence` is intentionally soft when a runner does not expose skill-detection telemetry. When telemetry exists, the suite asserts that `agent-device` was loaded; when it is absent, the cases still judge command-planning output instead of failing on missing runner metadata.

The `codex-mini` baseline is a benchmark signal, not a required all-green gate. Its failures should map to command-planning regressions called out by individual case IDs; do not treat the historical pass/fail count as a fixed threshold.

SkillGym v0.8 command assertions are for observed command events. This suite primarily validates the command plan in the final answer, so it converts final-output command lines into a small planned-command report before calling `assert.commands.includes` or `assert.commands.notIncludes`.
The source-read guardrails use `assert.soft.*` plus deferred explain questions so one failing run can report multiple routing mistakes and can later be inspected with `skillgym explain`.
Suite types use the v0.8 root export name `Case`; older `TestCase` imports no longer typecheck.

## Suggested workflow

1. Start with the included smoke suite to benchmark routing and default guidance.
2. Extend the suite with app-specific prompts that cover a new command-planning category rather than duplicating an existing one.
3. Add local-only cases that expect real `agent-device` shell commands once you are ready to involve a running simulator.

## Running the suite

`skillgym` is installed as a repo dev dependency, so run the starter suite from the project root:

```bash
cd /absolute/path/to/agent-device
pnpm install
pnpm test:skillgym
```

Prefer the package scripts so the environment guard and local CLI build run consistently:

```bash
cd /absolute/path/to/agent-device
pnpm test:skillgym
pnpm test:skillgym:case open-and-snapshot
```

Useful v0.8 filters, reporters, and recovery options:

```bash
pnpm test:skillgym -- --tag fixture-smoke
pnpm test:skillgym -- --reporter json
pnpm test:skillgym -- --repeat 3 --repeat-failure 1
```

Optional Vercel AI Gateway runner:

```bash
AI_GATEWAY_API_KEY=<token> \
SKILLGYM_ENABLE_VERCEL_GATEWAY=1 \
pnpm test:skillgym:case open-and-snapshot --runner gpt-nano-gateway
```

`gpt-nano-gateway` uses SkillGym's OpenCode adapter with a repo-injected `@ai-sdk/openai-compatible` provider pointed at `https://ai-gateway.vercel.sh/v1` and model `openai/gpt-5.4-nano`. It is disabled by default so normal runs do not require Gateway credentials, OpenCode auth, or Gateway spend. `VERCEL_OIDC_TOKEN` can be used instead of `AI_GATEWAY_API_KEY`; the config passes either token as the bearer credential for Gateway.

If you need to run `skillgym` directly while developing the runner itself, build first so agents can call `node bin/agent-device.mjs help workflow`:

```bash
pnpm build
pnpm exec skillgym run \
  ./test/skillgym/suites/agent-device-smoke-suite.ts \
  --config ./test/skillgym/skillgym.config.ts \
  --case open-and-snapshot
```

Use `--reporter github-actions` in CI when you want annotations in GitHub Actions logs.

The config uses `schedule: parallel` so the planning suite can run case/runner pairs concurrently up to SkillGym v0.8's default available-machine parallelism cap. This is safe for the included suite because cases validate command plans and local CLI help, not live shared device state or workspace edits. Override with `--max-parallel <n>` for local experiments that need a different cap.
Use `--repeat <n>` when you want stability sampling rather than a single pass. Use `--repeat-failure <n>` for local benchmark recovery from transient runner failures; keep it off for strict regression checks unless you explicitly want retry artifacts.
When a run fails on an assertion that records explain questions, run `pnpm exec skillgym explain <artifact-dir>` against the failed `repeat-*` artifact directory to resume the runner and collect its explanation.

Prerequisites:

- `codex` CLI installed and authenticated, because the starter config uses the Codex runner
- `claude` CLI installed and authenticated, because the same cases also run against Claude Haiku
- repo dependencies installed with `pnpm install`
- if you want the fixture app running locally, use `pnpm test-app:install` and then `pnpm test-app:ios` or `pnpm test-app:android`

Sandbox note:

The configured runners call external Codex and Claude model backends. In Codex sandboxes with `CODEX_SANDBOX_NETWORK_DISABLED=1`, `pnpm test:skillgym` and direct `skillgym run --config ./test/skillgym/skillgym.config.ts` fail fast before building or launching runners. Run the suite from a normal authenticated local shell instead. If you are in a sandbox that has explicitly approved network access and you still want to launch external runners, set `SKILLGYM_ALLOW_EXTERNAL_RUNNERS_IN_SANDBOX=1`.

## Where to extend next

- Add suite cases that ask for selector-based plans against `Agent Device Tester`.
- Add local-only prompts that expect `agent-device open`, `snapshot`, `snapshot -i`, `get`, and `wait`.
- Add regression snapshots once the prompt set stabilizes.
