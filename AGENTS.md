# AGENTS.md

Minimal operating guide for AI coding agents in this repo.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues for `callstack/agent-device`; external PRs are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Follow the issue label workflow in `docs/agents/triage-labels.md`, including `ready-for-agent` and `ready-for-human`.

### Domain docs

Single-context repo. Read `CONTEXT.md` for domain language and testing/architecture vocabulary, and `docs/adr/` for accepted architecture decisions. See `docs/agents/domain.md`.

## First 60 Seconds
- Classify task type:
  - Info-only (triage/review/questions/docs guidance): no code edits and no test runs unless explicitly requested.
  - Code change: make minimal scoped edits and run only required checks from **Testing Matrix**.
- State assumptions explicitly. If uncertain, ask.
- Read required context, not the whole repo:
  - tooling/build/linting: `package.json` and `tsconfig*.json`
  - architecture, routing, command contracts, platform boundaries, diagnostics, or review: relevant `docs/adr/`
  - durable naming/testing vocabulary: `CONTEXT.md`
- Start with at most 3 files: the owning module, one shared helper, and one downstream caller/adapter if needed. Use `rg` before opening large files.
- Define verifiable success criteria before editing.
- Decide docs/skills impact up front.

## Scope & Changes
- Keep changes scoped to one command family or module group unless the task explicitly crosses boundaries. If scope expands, stop and confirm.
- Preserve daemon session semantics and platform behavior.
- Do not inspect both iOS and Android paths unless the task is explicitly cross-platform.
- Ship the minimum code that solves the problem: no speculative features, no single-use abstractions, and no unrelated cleanup.
- Match existing style. Remove imports/variables your change made unused.
- Test through public interfaces when possible. Do not add unrelated exports just to make tests easier.
- Prefer type-level checks when TypeScript can enforce a contract or invalid shape.
- Use `unknown` only at trust boundaries: parsed JSON, daemon/runtime payloads, catch values, generic I/O, or parser callbacks. Once a value is validated or its producer has a known contract, narrow to a domain type or focused parser/helper instead of carrying `unknown` through internal helper and formatter signatures.
- Keep modules small for agent context safety:
  - target <= 300 LOC per implementation file when practical.
  - if a file grows past 500 LOC, plan/extract focused submodules before adding new behavior.
  - if a file grows past 1,000 LOC, treat it as architecture debt unless it is generated data, a fixture snapshot, or an integration test aggregation.
  - long guidance/data tables should live behind focused modules instead of sharing a file with parser/runtime logic.
  - prefer deep modules over mechanical splits: extract when it improves locality for a concept callers already need, not just to reduce line count.
- Before finalizing a code change, do one tightening pass over touched and directly adjacent areas: drop obsolete code, redundant tests, stale helpers/fixtures, and needless duplication made unnecessary by the change.
- Prefer existing helpers. Add a helper only when it reduces real repetition or clarifies domain behavior.
- When adding new guidance, examples, schemas, or command metadata, decide whether it belongs in the command surface, CLI grammar, CLI help, MCP projection, or daemon runtime before editing.
- Prefer updating existing domain vocabulary in `CONTEXT.md` when naming a new durable module concept. Do not coin parallel names in docs, tests, and code.

## Routing
- Keep `src/daemon.ts` as a thin router.
- Keep command names centralized in `src/command-catalog.ts`; do not re-create command identity sets in handlers or request policy modules.
- Keep daemon routing and request-policy traits centralized in `src/daemon/daemon-command-registry.ts`; request modules should consume its predicates instead of recreating command string sets. See `docs/adr/0003-daemon-command-registry.md`.
- Keep command input/output contracts in the command modules:
  - command surface and shared schemas: `src/commands/command-surface.ts`, `src/commands/command-contract.ts`, `src/commands/command-input.ts`
  - typed client command execution: `src/commands/client-command-contracts.ts`
  - command families: `src/commands/interaction-command-contracts.ts`, `src/commands/batch-command.ts`, with other typed client contracts in `src/commands/client-command-contracts.ts`
  - CLI positional/flag grammar: `src/commands/cli-grammar.ts` and `src/commands/cli-grammar/*`
  - typed input to daemon request projection: `src/commands/command-projection.ts`
  - CLI/client/runtime output projection: `src/commands/cli-output.ts`, `src/commands/client-output.ts`, `src/commands/runtime-output.ts`
- Do not reintroduce CLI-shaped command adapters or schemas as a second source of truth. CLI, Node.js, and MCP should project from command contracts.
- Keep `src/daemon/request-router.ts` as request orchestration: auth, diagnostics scope, request admission, locking, handler chain, and fallback dispatch.
- New daemon handler-family commands must update `src/daemon/daemon-command-registry.ts` with the route and request-policy traits. `src/daemon/__tests__/daemon-command-registry.test.ts` guards route and policy traits; handler catalog tests keep executable handler sanity checks.
- Put request policies in focused request modules:
  - tenant/lease/selector/lock admission: `src/daemon/request-admission.ts`
  - artifact/error finalization: `src/daemon/request-finalization.ts`
  - request-scoped platform provider scoping: `src/daemon/request-platform-providers.ts`
  - generic fallback dispatch + action recording: `src/daemon/request-generic-dispatch.ts`
  - recording invalidation health: `src/daemon/request-recording-health.ts`
- Put command logic in handler modules:
  - session/apps/appstate/open/close/replay/logs: `src/daemon/handlers/session.ts`
  - click/fill/get/is: `src/daemon/handlers/interaction.ts`
  - snapshot/wait/alert/settings: `src/daemon/handlers/snapshot.ts`
  - find: `src/daemon/handlers/find.ts`
  - record/trace: `src/daemon/handlers/record-trace.ts`
- Commands routed as generic in `src/daemon/daemon-command-registry.ts` fall through to daemon fallback dispatch after specialized handlers return null.

## Toolchain Snapshot
- Package manager: `pnpm` only. Do not add or restore `package-lock.json`.
- Daemon state: packaged installs use `~/.agent-device`; source checkouts use worktree-scoped dirs under `~/.agent-device/dev/<basename-slug>-<hash>`. Use `pnpm daemon:state-dir` to inspect it, `--state-dir`/`AGENT_DEVICE_STATE_DIR` to override it, and `pnpm clean:daemon --prune-dev` to prune stale dev dirs. Daemons are isolated by worktree, but devices are not; target different devices/simulators for concurrent worktrees.
- Runtime baseline is Node >= 22. Prefer built-in Node APIs such as global `fetch`, Web Streams, and `AbortSignal.timeout` over compatibility wrappers unless the surrounding code needs a lower-level transport.
- Lint/format stack is OXC:
  - config: `.oxlintrc.json`, `.oxfmtrc.json`
- TypeScript is strict enough to surface dead code early: `strict`, `isolatedModules`, `noUnusedLocals`, and `noUnusedParameters` are enabled.
- The repo emits with `rslib`, not `tsc`. If declaration generation fails, inspect `tsconfig.lib.json` first.
- `tsconfig.lib.json` needs an explicit `rootDir: "./src"` for declaration layout.
- Use the aggregate scripts in `package.json` when possible; they encode the expected validation bundles better than ad hoc command lists.

## Exploration & Token Use
- Prefer these first-pass commands over broad reads:
  - `rg -n "<symbol|command|flag>" src test`
  - `rg --files src/daemon/handlers src/platforms/apple src/platforms/ios src/platforms/android`
  - `git diff -- <path>` for active-branch context
  - read `.oxlintrc.json` before treating lint output as source-level bugs
- For files over 500 LOC, search for the relevant type/function/section first, then read a bounded range.
- Do not run integration tests by default.
- Keep long help prose in `src/utils/cli-help.ts`, flag definitions in `src/utils/cli-flags.ts`, and CLI-specific usage/flag metadata in `src/utils/cli-command-overrides.ts`.
- If build/type errors mention declaration generation, inspect `tsconfig.lib.json` before reading platform code.
- If lint failures appear after toolchain edits, check whether the rule is from `eslint/*`, `typescript/*`, `import/*`, or `node/*` in `.oxlintrc.json` before assuming source bugs.

## Command Family Lookup
- `logs`: `src/daemon/handlers/session.ts` -> `src/daemon/app-log.ts` -> `src/daemon/handlers/__tests__/session.test.ts`
- `open/close/replay/apps/appstate`: `src/daemon/handlers/session.ts` -> `src/daemon/session-store.ts` -> `src/daemon/handlers/__tests__/session.test.ts`
- `click/fill/get/is`: `src/daemon/handlers/interaction.ts` -> `src/daemon/selectors.ts` -> `src/daemon/handlers/__tests__/interaction.test.ts`
- `snapshot/wait/settings/alert`: `src/daemon/handlers/snapshot.ts` -> `src/daemon/snapshot-processing.ts` -> `src/daemon/handlers/__tests__/snapshot-handler.test.ts`
- `record/trace`: `src/daemon/handlers/record-trace.ts` -> `src/platforms/apple/core/runner/runner-client.ts` -> `src/daemon/handlers/__tests__/record-trace.test.ts`

## Apple Runner Seams
- The OS-agnostic Apple XCTest runner lives under `src/platforms/apple/core/runner/`. Keep dependency direction clean:
  - `runner-client.ts`: command execution + retry behavior
  - `runner-transport.ts`: connection/probing/HTTP transport
  - `runner-contract.ts`: shared `RunnerCommand` type and runner connect/error helpers
  - `runner-session.ts`: session lifecycle and request/response execution
  - `runner-xctestrun.ts`: xctestrun preparation/build/cache logic
- `runner-transport.ts` must not import back from `runner-client.ts`.
- If changing runner connect errors, retry policy, or command typing, start in `src/platforms/apple/core/runner/runner-contract.ts` before touching client/transport files.

## Adding a New CLI Flag

A new snapshot/command flag touches only the layers that need to understand it. Follow this checklist in order:

1. `src/utils/cli-flags.ts`: add to `CliFlags`, `FLAG_DEFINITIONS`, and the relevant exported flag group (e.g. `SNAPSHOT_FLAGS`). Add the flag to `CLI_COMMAND_OVERRIDES` in `src/utils/cli-command-overrides.ts` for each command that supports it; command names/descriptions come from command contracts unless CLI help needs a specific override.
2. `src/commands/cli-grammar/*`: read the CLI flag into command input when the CLI accepts it.
3. `src/commands/command-projection.ts` and command-family projection helpers: write the input into the daemon request only if the flag affects daemon execution.
4. `src/commands/*-command-contracts.ts`: add or update the command input schema only if the option should be available through Node.js or MCP as structured input.
5. `src/client-types.ts`: update the public typed client option only when the Node.js interface exposes the option.
6. `src/client-normalizers.ts`: update daemon flag normalization only when the request still needs a public-to-internal option translation.
7. `src/daemon/context.ts` and `src/core/dispatch-context.ts`: add the field only when it flows into platform dispatch.
8. Handler/platform modules: thread the option only after the command surface, grammar, and projection prove it belongs there.

Command-only flags (like `find --first`) that do not flow to the platform layer usually stop at steps 1-3.

## Hard Rules
- Use process helpers from `src/utils/exec.ts` for TypeScript process execution: `runCmd`, `runCmdStreaming`, `runCmdSync`, `runCmdBackground`, and `runCmdDetached`. Do not import raw `spawn`/`spawnSync` outside `src/utils/exec.ts`; add or extend an exec helper instead. Plain `.mjs` packaging fixtures that cannot import TypeScript helpers should keep child-process usage local and prefer `execFile`/`execFileSync` over spawn.
- Use daemon session flow for interactions (`open` before interactions, `close` after).
- Every manual `agent-device open` must have a matching `agent-device close` before the agent finishes, using the same `--session`, `--platform`, `--udid`, and `--state-dir` flags.
- Use `keyboard dismiss` for iOS keyboard dismissal; it may tap safe native controls such as `Done` but must not fall back to system back navigation.
- Do not remove shared snapshot/session model behavior without full migration.
- Command/device support must come from `src/core/capabilities.ts`.
- Apple-family target changes must keep `src/kernel/device.ts`, `src/core/capabilities.ts`, `src/core/dispatch-resolve.ts`, `src/platforms/apple/core/devices.ts`, and `src/platforms/apple/core/runner/runner-xctestrun.ts` in sync.
- iOS simulator-set scoping is iOS-specific: do not let `iosSimulatorDeviceSet` hide the host macOS desktop target when `--platform macos` or `--target desktop` is requested.
- If Swift runner code changes, run `pnpm build:xcuitest`.
- Use `inferFillText` and `uniqueStrings` from `src/daemon/action-utils.ts`.
- Use `evaluateIsPredicate` from `src/daemon/is-predicates.ts` for assertion logic.

## Logs Contract
- Logs backend/source of truth is `src/daemon/app-log.ts`.
- `session.ts` should orchestrate only (start/stop/path/doctor/mark), not duplicate backend logic.
- App logs are distinct from runner/platform output. Keep app/device log capture in `app.log`; Apple runner and `xcodebuild` subprocess output belongs in the session-scoped `runner.log`.
- Preserve external grep/tail workflow in docs/skills.

## Diagnostics & Errors
- Diagnostics source of truth: `src/utils/diagnostics.ts`
  - `withDiagnosticsScope`, `updateDiagnosticsScope`, `emitDiagnostic`, `withDiagnosticTimer`, `flushDiagnosticsToSessionFile`
- Request diagnostics belong in `sessions/<effective-session>/requests/<request-id>.ndjson` once the effective session is resolved. The top-level daemon log is for daemon lifecycle/startup and pre-session failures.
- Session artifact paths are centralized in `src/daemon/session-store.ts`; do not hand-build session log paths in handlers.
- Do not add ad-hoc stderr/file logging where diagnostics helpers apply.
- Normalize user-facing failures via `src/kernel/errors.ts` (`normalizeError`).
- Failure payload contract: `code`, `message`, `hint`, `diagnosticId`, `logPath`, `details`.
- User-facing errors should be short and actionable: say what failed, why when known, and how to recover. Put recovery steps in `hint` when the action is not obvious, for example restart/retry, use plain screenshot when AX state is unavailable, navigate with coordinates, or inspect logs.
- If an interaction unexpectedly takes 5+ seconds, inspect the relevant daemon log before attributing it to the app. Check the session `--state-dir` `daemon.log` or the failure `logPath` for runner restart, stale session recovery, AX failure, transport retry, or command timeout evidence.
- Preserve `hint`, `diagnosticId`, `logPath` when wrapping/rethrowing errors.
- `--debug` is canonical; `--verbose` is backward-compatible alias.
- Keep redaction centralized in diagnostics helpers.

## Optional Optimizations
- Treat optional optimization calls such as cache/preflight/probe requests as best-effort unless the feature contract says they are required. If an optimization fails, times out, returns non-OK, or returns an unusable shape, prefer falling back to the existing required command path.
- Keep optimization timeouts shorter than the underlying operation timeout. A preflight should not consume the full budget for a later upload or command.

## React Native Verification
- After changing runtime code exercised through `bin/agent-device.mjs` or the daemon, run `pnpm build` and `pnpm clean:daemon` before manual device verification so snapshots use current `dist` output.
- For Android RN/Expo/dev-client apps connected to any local Metro port, `adb reverse tcp:<port> tcp:<port>` is harmless and should be run before opening the app or URL on the emulator/device.
- In sandboxed agent environments, run manual `agent-device` CLI verification that starts the daemon outside the sandbox with escalation. The daemon binds localhost, and sandboxed runs can fail before any product code executes with `listen EPERM: operation not permitted 127.0.0.1` or repeated `Failed to start daemon`/metadata cleanup messages. Do not spend time debugging those as agent-device regressions; rerun the same command with escalation. Unit tests, typecheck, lint, and build can stay sandboxed unless they need platform devices or network/listener access.

## Manual Device Session Hygiene
- Treat every manually opened `agent-device` session as a resource that must be closed, including exploratory sessions and failed verification attempts.
- For experiments, use a purpose-specific session name and, when practical, an isolated `--state-dir` under `/private/tmp` when you need cleanup isolation beyond the current worktree's default daemon.
- Keep track of each opened session in the working notes. Before final response, close each one with the same flags used to open it.
- If `close` or a later command is blocked by stale daemon metadata, inspect running processes first with `ps -ax | rg "agent-device|xcodebuild test-without-building"`. Stop only exact stale PIDs that belong to the verification run, then run `pnpm clean:daemon`.
- If cleanup cannot be completed, report the remaining session name, state dir, process IDs, and metadata paths as a blocker.

## Selector System Rules
- Interaction commands (`click`, `fill`, `get`, `is`) and `wait` accept selectors and `@ref`.
- Pipeline: **parse -> resolve -> act -> record selectorChain -> heal on replay**.
- Keep selector parsing/matching in `src/daemon/selectors.ts`.
- Call `buildSelectorChainForNode` after resolving target nodes.
- New element-targeting interactions must support selector + `@ref`, record `selectorChain`, and hook replay healing (`healReplayAction` in `session.ts` + selector helpers in `session-replay-heal.ts`).
- New selector keys remain centralized in `selectors.ts`.
- New `is` predicates belong in `evaluateIsPredicate`.
- On macOS, snapshot rects are absolute in window space. Point-based runner interactions must translate through the interaction root frame; do not assume app-origin `(0,0)` coordinates.
- Prefer selector or `@ref` interactions over raw x/y commands in tests and docs, especially on macOS where window position can vary across runs.

## Shared Test Utilities
- Before writing a new test, check `src/__tests__/test-utils/` for existing helpers:
  - `device-fixtures.ts`: canonical `DeviceInfo` constants (`ANDROID_EMULATOR`, `IOS_SIMULATOR`, `IOS_DEVICE`, `MACOS_DEVICE`, `LINUX_DEVICE`, etc.)
  - `session-factories.ts`: `makeSession`, `makeIosSession`, `makeAndroidSession`, `makeMacOsSession`
  - `store-factory.ts`: `makeSessionStore` (creates temp `SessionStore` instances)
  - `snapshot-builders.ts`: `buildNodes`, `makeSnapshotState`
  - `mocked-binaries.ts`: `withMockedAdb`, `withMockedXcrun` (stub CLI binaries for dispatch tests)
- Use `import { ... } from '<relative-path>/__tests__/test-utils/index.ts'` for convenient barrel imports.
- Prefer shared fixtures over inlining new `DeviceInfo` or `SessionState` objects in tests.
- Do not duplicate `makeSessionStore`, `makeSession`, or device constants when a shared helper already exists.

## Testing Matrix
- Docs/skills only: no tests required unless a more specific rule below applies.
- CLI help/guidance changes in `src/utils/cli-help.ts`, `src/utils/cli-command-overrides.ts`, or `src/utils/command-schema.ts`: run `pnpm exec vitest run src/utils/__tests__/args.test.ts`.
- SkillGym prompt/assertion changes: run `pnpm test:skillgym:case <case-id>`; the script builds local CLI help first. For broad validation, use `pnpm test:skillgym`; append `-- --tag fixture-smoke` or `-- --tag skill-guidance` when validating one suite group.
- Non-TS, no behavior impact: no tests unless requested.
- Keep tests behavioral; do not assert shapes or cases TypeScript already proves.
- Any TS change: `pnpm typecheck` or `pnpm check:quick`.
- Fallow CI failures: reproduce with `pnpm check:fallow --base origin/main` instead of manually estimating complexity/dead-code impact.
- Test-only DI seam CI failures: the workflow enforces this; do not add optional `typeof` DI params in production code.
- Tooling/config change (`package.json`, `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`): `pnpm check:tooling`.
- Daemon handler/shared module change: `pnpm check:unit`.
- iOS runner/Swift change: `pnpm build:xcuitest`.
- Cross-platform behavior change: run `pnpm test:integration`.
- Any change in: `src/`, `test/`, `skills/`: `pnpm format`.

## PR Readiness Checklist
- Static gates first: required checks from **Testing Matrix** pass, `pnpm check:fallow --base origin/main` is clean when code quality/dead-code risk is relevant, CI guards are green, and no conflict markers or unmerged paths remain.
- Command-surface changes preserve CLI, Node.js, daemon, MCP, help, docs, and SkillGym coverage where that surface is affected. Do not duplicate command contracts across layers.
- Device-facing behavior is not merge-ready until it has real simulator/emulator/device evidence for the changed path. Fixture-backed tests can prove contracts, but they do not replace a live run that creates or observes the artifact/state the feature claims to handle.
- If live verification is blocked, state the blocker, exact command or device needed, and downgrade the PR to residual risk instead of calling it ready.
- Runtime output must stay agent-friendly: compact defaults, top offenders first for diagnostics/perf, bounded arrays in JSON, artifact paths for large raw data, and progressive lookup for deeper detail.
- Before final response or PR handoff, close every manual `agent-device` session opened during verification and report any cleanup that could not be completed.
- Reviewers should check sibling PR ordering, hidden behavior changes, docs/help impact, and whether the tightening pass removed obsolete code/tests introduced or made unnecessary by the change.

## PR Review Checklist
- Review against the linked issue, not only the diff. State the issue's motivating behavior and verify the PR fixes that behavior directly.
- Check relevant ADRs before reviewing architecture, routing, command-surface, platform-boundary, diagnostics, or testing-strategy changes. Treat ADR conflicts as review findings unless the PR updates/supersedes the ADR explicitly.
- Read issue dependency notes such as `Blocked by: ...`, linked PRs, and sibling branches before judging correctness. If a PR should be stacked on another branch, call out the base/sequence problem before reviewing details.
- Trace the real production route from command surface through daemon/request routing to the platform backend. Tests that mock away the router or exercise only a helper do not prove the shipped path.
- For each key regression test, identify what deletion, revert, or old implementation would make it fail. If reverting the implementation still passes, the test is vacuous and must be fixed.
- Check for hidden behavior changes separately from intended refactors, especially output shape, warning/error propagation, artifact paths, and fallback/retry tiers.
- Verify that tests cover the issue's motivating failure, not just the new abstraction or shared helper. Prefer before/after evidence when an external reviewer or issue reports a concrete divergence.
- Treat green CI as necessary but insufficient for device-facing or routing-sensitive work. Require live simulator/emulator/device evidence where the changed path depends on platform behavior.

## Common Mistakes
- Adding command logic to `src/daemon.ts` instead of handlers.
- Adding capability checks outside `src/core/capabilities.ts`.
- Inlining `is` predicate logic in handlers.
- Returning non-normalized user-facing errors.
- Duplicating logs backend logic in handlers instead of `src/daemon/app-log.ts`.
- Growing `src/daemon/handlers/session.ts` or `src/platforms/apple/core/apps.ts` further without extracting Apple-family/macOS-specific helpers first.
- Reintroducing an npm lockfile or assuming ESLint/Prettier still exist in this repo.
- Changing `tsconfig.lib.json`/build tooling without running `pnpm check:tooling`; declaration generation is stricter than `tsc --noEmit`.

## Docs & Skills
- Versioned CLI help is the agent-facing source of truth. Put workflow guidance/help topics in `src/utils/cli-help.ts`, flags in `src/utils/cli-flags.ts`, CLI command overrides in `src/utils/cli-command-overrides.ts`, and assertions for important copy in `src/utils/__tests__/args.test.ts`.
- Keep parser schema and help rendering separate: `src/utils/command-schema.ts` composes contract-derived command schemas with CLI overrides; `src/utils/cli-help.ts` owns help topics and usage rendering.
- Before planning device automation commands, read `agent-device help workflow`; then read topic help such as `debugging`, `react-native`, `react-devtools`, `physical-device`, `macos`, or `dogfood` when relevant. This is required even when local agent skills are unavailable.
- Skills are thin routers. Keep `skills/**/SKILL.md` focused on when to use the skill, version gating, which `agent-device help <topic>` page to read, and a short default loop. Do not duplicate full CLI manuals in skills.
- For behavior/CLI surface changes, update help/metadata, README or `website/docs/**` when user-facing, and a SkillGym case in `test/skillgym/suites/agent-device-smoke-suite.ts` when command-planning guidance changes.
- Do not update `skills/**/SKILL.md` for command behavior or workflow guidance unless the user explicitly asks; skills must route to versioned CLI help instead of carrying behavior details.
- Keep SkillGym cases behavioral and command-planning oriented. Prefer prompts that assert the user-visible contract and expected command family over brittle exact output, but forbid known bad patterns.
- Use `pnpm test:skillgym:case <case-id>` for focused SkillGym validation; it runs the environment guard and builds local CLI help before `skillgym run`.
- Run SkillGym broad validation with `pnpm test:skillgym`; append v0.8 filters such as `-- --tag fixture-smoke` for focused suite groups.
- In final summaries, state whether docs/skills were updated; if not, explain why.

## When Blocked
- If blocked by network/device/auth/permissions, stop and report:
  - blocker
  - why it blocks completion
  - exact next command/action needed to unblock

## Key Files
- CLI parse + formatting: `src/bin.ts`, `src/cli.ts`, `src/utils/args.ts`
- CLI help + option metadata: `src/utils/cli-help.ts`, `src/utils/cli-flags.ts`, `src/utils/cli-command-overrides.ts`, `src/utils/command-schema.ts`, `src/utils/cli-option-schema.ts`
- Daemon client transport: `src/daemon-client.ts`
- Daemon state/store: `src/daemon/session-store.ts`
- Selector DSL and matching: `src/daemon/selectors.ts`
- `is` predicate evaluation: `src/daemon/is-predicates.ts`
- Shared action helpers: `src/daemon/action-utils.ts`
- Snapshot shaping + labels: `src/daemon/snapshot-processing.ts`
- Handler context helpers: `src/daemon/context.ts`, `src/daemon/device-ready.ts`
- Request routing/policy: `src/daemon/daemon-command-registry.ts`, `src/daemon/request-router.ts`, `src/daemon/request-admission.ts`, `src/daemon/request-generic-dispatch.ts`
- Dispatcher + capability map: `src/core/dispatch.ts`, `src/core/dispatch-context.ts`, `src/core/dispatch-interactions.ts`, `src/core/capabilities.ts`
- Command identity + command surface: `src/command-catalog.ts`, `src/commands/command-surface.ts`, `src/commands/command-contract.ts`, `src/commands/client-command-contracts.ts`
- CLI grammar: `src/commands/cli-grammar.ts`, `src/commands/cli-grammar/*`
- Daemon request projection: `src/commands/command-projection.ts`
- Platform backends: `src/platforms/apple/*`, `src/platforms/ios/*`, `ios-runner/*`, `src/platforms/android/*`

## Pull Requests
- Before opening PR: ensure no conflict markers/unmerged paths.
- Commit messages and PR titles should use conventional prefixes such as `feat:`, `fix:`, `chore:`, `perf:`, `refactor:`, `docs:`, `test:`, `build:`, or `ci:` as appropriate.
- Do not use bracketed automation prefixes such as `[codex]` or similar bot tags in commit messages or PR titles.
- Open a ready-for-review PR by default. Use a draft PR only when the user explicitly asks for one or the work is intentionally incomplete.
- PR body must be short and include:
  - `## Summary`: lead with benefits and reviewer-relevant outcomes. Prefer a compact before/after when it makes the improvement clearer. Include the issue closed by the PR using `Closes #123` when applicable.
  - `## Validation`: answer this prompt in concise prose: "How did you verify the change, and what passed or changed on screen?" Prefer evidence over command dumps; mention the relevant check category or scenario, and include screenshots when visual/UI behavior is relevant.
- Call out real tradeoffs, known gaps, or follow-ups explicitly; omit boilerplate when there are none.
- Include touched-file count and note if scope expanded beyond initial command family.

## Priority Order
- When guidance conflicts, apply in this order: **Hard Rules -> Scope & Changes -> Testing Matrix -> style/preferences**.
