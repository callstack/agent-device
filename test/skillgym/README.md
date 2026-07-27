# Skillgym For agent-device

This folder benchmarks the one thing only an agentic runner can prove: given the `agent-device` skill, does a real agent route to it, consult local CLI help before answering, and read captured `agent-device` output correctly in that agentic setting?

Everything else this suite used to cover moved to cheaper, stronger owners:

- Command-planning knowledge checks (can a model choose the right next command from a help slice, a captured output, or an error?) live in the help conformance bench (`scripts/help-conformance-bench.mjs`). Its plans are validated by the production CLI parser, its case list is enumerated against the help-topic registry (`scripts/__tests__/help-conformance-topic-coverage.test.ts`), and its quoted samples are pinned to the real renderers (`scripts/__tests__/help-conformance-sample-outputs.test.ts`).
- Live fixture-app behavior is owned by the deterministic iOS simulator e2e suite (`test/integration/ios-simulator-e2e/`) and its coverage manifest.

## What stays here

The suite uses two case tags:

- `fixture-smoke`: one routing smoke (`open-and-snapshot`) — a sane fixture-app plan from the skill plus local help, without reading project source.
- `skill-guidance`: four output-interpretation cases that require a REAL observed local help probe before scoring (`requireLocalCliHelp` + `suites/local-cli-help-policy.ts` over observed command events): `settle-diff-is-observation`, `sample-output-settled-diff-next-target`, `sample-output-not-settled-needs-observe`, `sample-output-private-ax-recovery-continues`. Allowing help without verifying that the runner actually read it can misclassify a model-prior failure as a help-guidance failure.

The captured output quoted in the skill-guidance cases is imported from `scripts/help-conformance-sample-outputs.mjs` — the same constants the bench embeds — so a renderer change fails the pinning test instead of silently grading agents against output the CLI no longer prints.

## Included files

- `../../examples/test-app/`: minimal Expo SDK 56 development-build fixture app
- `skillgym.config.ts`: starter config that runs Codex and Claude Haiku against this repo
- `suites/agent-device-smoke-suite.ts`: the routing + output-interpretation suite
- `suites/local-cli-help-policy.ts`: the observed-command policy that proves a real local help command ran

For help-layout A/B testing and command-planning regressions, use the bench instead of adding cases here: it feeds only the top-level first screen or one help topic, runs runner x case pairs concurrently (`HELP_BENCH_CONCURRENCY`, default 4), grades draft help rewrites with zero rebuild via `--override-doc <topicId>=<path>`, measures variance with `--repeat <n>` plus an aggregate pass-rate and failure-taxonomy report, and filters with `--cases`/`--case` and `--runners`/`--runner` (both repeatable/CSV) the same way as this suite.

`assertAgentDeviceEvidence` is intentionally soft when a runner does not expose skill-detection telemetry. When telemetry exists, the suite asserts that `agent-device` was loaded; when it is absent, the cases still judge command-planning output instead of failing on missing runner metadata.

The `codex-mini` baseline is a benchmark signal, not a required all-green gate. Its failures should map to command-planning regressions called out by individual case IDs; do not treat the historical pass/fail count as a fixed threshold.

SkillGym v0.8 command assertions are for observed command events. This suite primarily validates the command plan in the final answer, so it converts final-output command lines into a small planned-command report before calling `assert.commands.includes` or `assert.commands.notIncludes`.
The source-read guardrails use `assert.soft.*` plus deferred explain questions so one failing run can report multiple routing mistakes and can later be inspected with `skillgym explain`.
Suite types use the v0.8 root export name `Case`; older `TestCase` imports no longer typecheck.

## Running the suite

`skillgym` is installed as a repo dev dependency, so run the suite from the project root:

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
pnpm test:skillgym -- --tag skill-guidance
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

- Add a case here ONLY when it measures agentic behavior: skill routing, local-help consultation, or multi-turn discovery a single non-agentic call cannot show.
- Add command-planning knowledge checks to `scripts/help-conformance-cases.mjs` instead; the topic-coverage gate tells you which help topics are unbenchmarked.
- Add local-only cases that drive a live simulator only when the deterministic e2e suite cannot own the behavior.
