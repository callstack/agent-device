# AGENTS.md

AGENTS.md is this repo's README for coding agents: project context, commands, conventions, non-obvious traps, and PR expectations in one predictable place. Keep it high-signal and living; prefer durable source-of-truth pointers over file inventories that drift.

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

## Principles (expensive lessons — each cost an incident)
- Guarantees erode at path boundaries. Any new dispatch path or fast path classifies its cells in `src/contracts/interaction-guarantees.ts` first; the typechecker forces completeness, you supply honesty. ADR 0011.
- A registry claim is not a semantic check: never mark a cell `runner` without reading whether the Swift code implements the guarantee's *definition*, not just a similar-sounding behavior.
- Delegation-on-error is not success-path parity. A fast path that falls back on failure can still succeed on a candidate the shared rules would refuse.
- Do not measure before confirming the code path can fire. An A/B whose B-arm cannot execute returns two green runs masquerading as evidence.
- Typed signals over message sniffing: key on structured details (`details.timeoutMs`, reason codes), never on error text. Remaining sniffs are owned debt with in-code rationale — do not copy the pattern.
- Snapshot output is the token budget. Never add per-node bytes to the tree; response-level metadata rides once per response.
- Warnings compose, never clobber. Append through the shared response builder; two clobber bugs shipped before this rule.
- Unreleased API surface dies free. Before treating a field as wire-compat, check `git tag --contains <commit>`; if it never shipped, delete it now.
- Push only behind `&&`-chained gates. `format:check && typecheck && lint && vitest && git push` — a push that can run after a failed gate eventually will.

## Scope & Changes
- Keep changes scoped to one command family or module group unless the task explicitly crosses boundaries. If scope expands, stop and confirm.
- Preserve daemon session semantics and platform behavior.
- Do not inspect both iOS and Android paths unless the task is explicitly cross-platform.
- Ship the minimum code that solves the problem: no speculative features, no single-use abstractions, and no unrelated cleanup.
- Match existing style. Remove imports/variables your change made unused.
- Test through public interfaces when possible. Do not add unrelated exports just to make tests easier.
- Unit tests never wait real time: inject the budget, derive the cadence from it, or assert the budget is wired — the slow-test ratchet (`scripts/vitest-slow-test-reporter.ts`) fails tests past 2x budget; speed rules and conversion patterns in `docs/agents/testing.md`.
- Prefer type-level checks when TypeScript can enforce a contract or invalid shape.
- Use `unknown` only at trust boundaries: parsed JSON, daemon/runtime payloads, catch values, generic I/O, or parser callbacks. Once a value is validated or its producer has a known contract, narrow to a domain type or focused parser/helper instead of carrying `unknown` through internal helper and formatter signatures.
- Keep modules small for agent context safety. The unit is not lines, it is questions: a file should answer one question, so `rg` -> read-whole-file stays one cheap bounded read.
  - numeric tripwires: target <= 300 LOC per implementation file; past 500, extract before adding behavior; past 1,000 is architecture debt unless it is generated data or a fixture snapshot. There is no exemption for tests (see below).
  - name files by the domain concept they answer (`runner-cache.ts`, `interaction-touch-response.ts`), not by layer leftovers (`utils2.ts`, `common.ts` accretion).
  - colocate machine-readable claims with the code they describe: coverage manifests beside contract tests, registry cells beside enforcement pointers, decision comments at the decision site — agents navigate by claims, not by directory listings.
  - test files mirror source topology 1:1: when a source module splits, split its test file the same way in the same PR. A 3,000-line family test aggregation makes every fixture lookup a whole-file read; the worst offenders (`interaction.test.ts`, platform `index.test.ts`) predate this rule and shrink opportunistically — do not add to them.
  - shared fixtures live as named exports in a sibling fixtures module (see `test/integration/interaction-contract/fixtures.ts`), never as inline literals repeated per test.
  - long guidance/data tables live behind focused modules instead of sharing a file with parser/runtime logic.
  - barrels only at package boundaries; internal barrels add a navigation hop per read. Legacy internal barrels are gated for removal (CONTEXT.md).
  - prefer deep modules over mechanical splits: extract when it improves locality for a concept callers already need, not just to reduce line count.
- Before finalizing a code change, do one tightening pass over touched and directly adjacent areas: drop obsolete code, redundant tests, stale helpers/fixtures, and needless duplication made unnecessary by the change.
- Prefer existing helpers. Add a helper only when it reduces real repetition or clarifies domain behavior.
- When adding new guidance, examples, schemas, or command metadata, decide whether it belongs in the command surface, CLI grammar, CLI help, MCP projection, or daemon runtime before editing.
- Prefer updating existing domain vocabulary in `CONTEXT.md` when naming a new durable module concept. Do not coin parallel names in docs, tests, and code.

## Routing & command identity (read the registries, not this file)
Command identity, routing, capability, and request-policy traits are *derived* artifacts — inspect their declaration sites instead of prose maps:
- one `CommandDescriptor` per command: `src/core/command-descriptor/registry.ts` (catalog, capabilities, MCP/CLI projection, batch policy, timeout policy — ADR 0008)
- daemon route ownership + request-policy traits: `src/daemon/daemon-command-registry.ts` (parity-tested)
- interaction dispatch paths × guarantees: `src/contracts/interaction-guarantees.ts` (ADR 0011)
- command names: `src/command-catalog.ts`; never re-create command string sets in handlers
Keep `src/daemon.ts` a thin router and `src/daemon/request-router.ts` orchestration-only. New daemon handler-family commands update the daemon command registry; its tests guard the traits.

## Toolchain Snapshot
- Package manager: `pnpm` only. Do not add or restore `package-lock.json`.
- Daemon state: packaged installs use `~/.agent-device`; source checkouts use worktree-scoped dirs under `~/.agent-device/dev/<basename-slug>-<hash>`. Use `pnpm daemon:state-dir` to inspect it, `--state-dir`/`AGENT_DEVICE_STATE_DIR` to override it, and `pnpm clean:daemon --prune-dev` to prune stale dev dirs. Daemons are isolated by worktree, but devices are not; target different devices/simulators for concurrent worktrees.
- Runtime baseline is Node >= 22. Prefer built-in Node APIs such as global `fetch`, Web Streams, and `AbortSignal.timeout` over compatibility wrappers unless the surrounding code needs a lower-level transport.
- Lint/format stack is OXC:
  - config: `.oxlintrc.json`, `.oxfmtrc.json`
- TypeScript is strict enough to surface dead code early: `strict`, `isolatedModules`, `noUnusedLocals`, and `noUnusedParameters` are enabled.
- The repo emits with `tsdown` (Rolldown) and typechecks with `tsgo` (native preview); the `typescript` package is not a dependency, so there is no `tsc` to fall back to. If declaration generation fails, inspect `tsconfig.lib.json` first.
- Dev-loop staleness has three layers; after editing runtime or runner code: `pnpm build` (dist), restart the daemon (it does not self-reload), and remember `shutdown` deliberately HANDS OFF a healthy simulator runner — the adopted runner keeps serving the old Swift binary until you kill its process or the source fingerprint changes. Verifying "my change did nothing" against an adopted runner is a classic false negative.
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
- Keep long help prose in `src/cli/parser/cli-help.ts`, flag definitions in `src/cli/parser/cli-flags.ts`, and command-specific usage/flag metadata with the command family metadata that owns the command.
- If build/type errors mention declaration generation, inspect `tsconfig.lib.json` before reading platform code.
- If lint failures appear after toolchain edits, check whether the rule is from `eslint/*`, `typescript/*`, `import/*`, or `node/*` in `.oxlintrc.json` before assuming source bugs.

## Apple Runner Seams
- The OS-agnostic Apple XCTest runner lives under `src/platforms/apple/core/runner/`; use `rg --files src/platforms/apple/core/runner` and read the seam you are changing before editing.
- Keep dependency direction clean: transport stays below client/session behavior, shared command/error contracts stay in the runner contract module, and xctestrun preparation/build/cache logic stays isolated from request execution.
- If changing runner connect errors, retry policy, or command typing, start in `src/platforms/apple/core/runner/runner-contract.ts` before touching client/transport files.

## Adding a New CLI Flag

A new snapshot/command flag touches only the layers that need to understand it. Follow this checklist in order:

1. `src/cli/parser/cli-flags.ts`: add to `CliFlags`, `FLAG_DEFINITIONS`, and the relevant exported flag group (e.g. `SNAPSHOT_FLAGS`). Then update the command family metadata/schema that exposes the flag; find the owner with `rg -n "<command>|supportedFlags|allowedFlags" src/commands src/cli/parser`. For schema-only CLI commands (`cdp`, `auth`, `connect`, `proxy`, `react-devtools`, `web`), the flag schema owner is `src/utils/cli-command-overrides.ts` (`SCHEMA_ONLY_CLI_COMMAND_SCHEMAS`).
2. `src/commands/cli-grammar/*`: read the CLI flag into command input when the CLI accepts it.
3. `src/commands/command-projection.ts` and command-family projection helpers: write the input into the daemon request only if the flag affects daemon execution.
4. `src/commands/*-command-contracts.ts`: add or update the command input schema only if the option should be available through Node.js or MCP as structured input.
5. `src/client/client-types.ts`: update the public typed client option only when the Node.js interface exposes the option.
6. `src/client/client-normalizers.ts`: update daemon flag normalization only when the request still needs a public-to-internal option translation.
7. `src/daemon/context.ts` and `src/core/dispatch-context.ts`: add the field only when it flows into platform dispatch.
8. Handler/platform modules: thread the option only after the command surface, grammar, and projection prove it belongs there.

9. `scripts/integration-progress-model.ts`: classify the flag (device-observable vs intentionally-outside) — the architecture-progress gate fails CI on unclassified public flags.
10. If the flag changes interaction semantics, revisit the affected cells in `src/contracts/interaction-guarantees.ts` (command scoping via `appliesTo` when the flag exists only on some commands).

Command-only flags (like `find --first`) that do not flow to the platform layer usually stop at steps 1-3 (plus step 9).

## Enforcement gates (when one fails, it located your incomplete change)
This repo encodes invariants as self-declaring gates. The correct response to a gate failure is to classify/cover the new thing, never to suppress or allowlist:
- public CLI flags must be classified: `scripts/integration-progress-model.ts`
- interaction guarantee matrix completeness + honesty: `src/contracts/__tests__/interaction-guarantees.test.ts` (gap waivers need `trackingIssue`; the pin list changes only in reviewed diffs)
- every enforced/delegated matrix cell needs a contract scenario: `src/contracts/__tests__/interaction-contract-coverage.test.ts` + `test/integration/interaction-contract/`
- interaction responses build only through `buildInteractionResponseData`: the construction-guard test
- every command declares a timeout policy on its descriptor: the timeout-policy completeness test
- TS/Swift rule parity: golden tables under `contracts/fixtures/` consumed by vitest and the gated XCTest
- cross-command apple-leak guard, folder DAG/import lint, fallow (dead code, duplication, complexity)

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
- For repo-owned `Agent Device Tester` verification, use `examples/test-app/README.md` as the source of truth for simulator, physical-device, Metro/dev-client, and app-surface verification steps. Do not treat an already installed `com.callstack.agentdevicelab` as sufficient unless the README's Metro/dev-build and `snapshot -i` checks prove the expected app surface is running.
- For Android RN/Expo/dev-client apps connected to any local Metro port, `adb reverse tcp:<port> tcp:<port>` is harmless and should be run before opening the app or URL on the emulator/device.
- In sandboxed agent environments, run manual `agent-device` CLI verification that starts the daemon outside the sandbox with escalation. The daemon binds localhost, and sandboxed runs can fail before any product code executes with `listen EPERM: operation not permitted 127.0.0.1` or repeated `Failed to start daemon`/metadata cleanup messages. Do not spend time debugging those as agent-device regressions; rerun the same command with escalation. Unit tests, typecheck, lint, and build can stay sandboxed unless they need platform devices or network/listener access.

## Known environment traps (do not debug these as regressions)
- First `node` exec right after the dev-signed Apple runner launches can block ~19s at 0% CPU (Gatekeeper re-verification). It poisons back-to-back CLI wall-clock timing; absorb with a throwaway `node -e 0` or measure in-process/daemon-side.
- A leftover session holding the device fails every subsequent command instantly with `DEVICE_IN_USE` naming the owner; the hint's `close --session` guidance is the fix, not daemon debugging.
- Contention flakes: `request-handler-catalog` ("specialized daemon routes...") and the doctor provider scenario time out under host load. Protocol before believing a regression: rerun in isolation AND reproduce on plain `origin/main` under the same load. A changing failure set that passes in isolation is contention, not your change.

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
- Before writing a new test, inspect `src/__tests__/test-utils/index.ts` and search for existing factories, fixtures, and mocked binaries with `rg -n "export .*make|export .*DEVICE|withMocked" src/__tests__/test-utils`.
- Use the test-utils barrel for imports and prefer named shared fixtures over inlining new `DeviceInfo`, `SessionState`, snapshot, store, or mocked-binary objects.
- Do not duplicate session/store/device helpers when a shared helper already exists; if a helper is missing, add it near the concept it serves and export it through the barrel.

## Testing Matrix
- Docs/skills only: no tests required unless a more specific rule below applies.
- CLI help/guidance changes in `src/cli/parser/cli-help.ts`, `src/utils/cli-command-overrides.ts`, or `src/utils/command-schema.ts`: run `pnpm exec vitest run src/cli/parser/__tests__ src/utils/__tests__/command-schema-guards.test.ts`.
- SkillGym prompt/assertion changes: run `pnpm test:skillgym:case <case-id>`; the script builds local CLI help first. For broad validation, use `pnpm test:skillgym`; append `-- --tag fixture-smoke` or `-- --tag skill-guidance` when validating one suite group.
- Non-TS, no behavior impact: no tests unless requested.
- Keep tests behavioral; do not assert shapes or cases TypeScript already proves.
- Any TS change: `pnpm typecheck` or `pnpm check:quick`.
- Fallow CI failures: reproduce with `pnpm check:fallow --base origin/main` instead of manually estimating complexity/dead-code impact.
- Test-only DI seam CI failures: the workflow enforces this; do not add optional `typeof` DI params in production code.
- Tooling/config change (`package.json`, `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`): `pnpm check:tooling`.
- Daemon handler/shared module change: `pnpm check:unit`.
- Platform/device-response change (anything emitting `platform`/`appleOs` on the wire, or shaping a daemon response): also run `pnpm test:integration:provider` and `pnpm test:coverage` — both exercise the `provider-integration` project (incl. the apple-platform-output leak guard); `pnpm check:unit` alone does NOT. Internal `apple` must never reach a command response — project through `publicPlatformString`.
- iOS runner/Swift change: `pnpm build:xcuitest`.
- Cross-platform behavior change: run `pnpm test:integration`.
- Any change in: `src/`, `test/`, `skills/`: `pnpm format`.

## PR Readiness Checklist
- Static gates first: required checks from **Testing Matrix** pass, `pnpm check:fallow --base origin/main` is clean when code quality/dead-code risk is relevant, CI guards are green, and no conflict markers or unmerged paths remain.
- Do not report a PR as CI-green from a local unit-only run alone: use `pnpm test:unit` for the repo unit bundle, or `vitest run --project unit-core --project android-adb` when invoking Vitest directly. The **Integration Tests** and **Coverage** jobs run the `provider-integration` project, so verify green on the actual PR head across those jobs, not just unit.
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
- Changing `tsconfig.lib.json`/build tooling without running `pnpm check:tooling`; declaration generation is stricter than a plain typecheck.

## Docs & Skills
- Versioned CLI help is the agent-facing source of truth. Put workflow guidance/help topics in `src/cli/parser/cli-help.ts`, flags in `src/cli/parser/cli-flags.ts`, command-specific schema/help metadata with the owning command family, and assertions near the focused CLI parser/help tests.
- Keep parser schema and help rendering separate: parser/help rendering lives in `src/cli/parser/`, while command schema metadata is derived from command metadata, command family declarations, and the schema-only merge path in `src/utils/cli-command-overrides.ts`.
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

## Finding Source Owners
- Do not turn this file into a source tree map. For implementation work, identify owner modules from the durable registries and then follow imports/tests from there.
- Command identity and projection: search command descriptors and command contracts first with `rg -n "<command>|CommandDescriptor|defineCommand" src/core/command-descriptor src/command-catalog.ts src/commands`.
- Daemon routing and policy: start with `src/daemon/daemon-command-registry.ts`, then trace to the named handler/request module with `rg -n "<command>|route|policy" src/daemon`.
- Platform behavior and capabilities: start with `src/core/capabilities.ts` and the relevant platform under `src/platforms/`; use `rg`, not broad directory reads.
- CLI help and command-planning guidance: start with `src/cli/parser/cli-help.ts` and `src/cli/parser/cli-flags.ts`; for command-specific schema, search `rg -n "helpDescription|summary|supportedFlags|allowedFlags" src/commands src/cli/parser src/utils/cli-command-overrides.ts`, and check `SCHEMA_ONLY_CLI_COMMAND_SCHEMAS` for schema-only CLI commands (`cdp`, `auth`, `connect`, `proxy`, `react-devtools`, `web`).

## Pull Requests
- Before opening PR: ensure no conflict markers/unmerged paths.
- Commit messages and PR titles should use conventional prefixes such as `feat:`, `fix:`, `chore:`, `perf:`, `refactor:`, `docs:`, `test:`, `build:`, or `ci:` as appropriate.
- Do not use bracketed automation prefixes such as `[codex]` or similar bot tags in commit messages or PR titles.
- Open a ready-for-review PR by default. Use a draft PR only when the user explicitly asks for one or the work is intentionally incomplete.
- PR body must be short, reviewer-oriented, and include:
  - `## Summary`: describe the user/API behavior, not the implementation file tour. Lead with what changed for operators, clients, command authors, or platform behavior. Use a compact before/after when it clarifies the workflow or bug fix. For new or changed public APIs, include 1-3 concrete CLI/Node/MCP examples that reviewers can scan. Include `Closes #123` when applicable.
  - `## Validation`: summarize meaningful evidence in concise prose or bullets. Prefer scenario names, manual device/browser evidence, changed screenshots, CI status, and notable failures/retries with their outcome. Avoid command accounting for routine local gates; mention an exact command only when it is unusual, manually reproducible evidence, or necessary to explain a residual risk. For docs-only changes, say why runtime validation is not applicable instead of writing a command checklist.
- Call out real tradeoffs, known gaps, or follow-ups explicitly; omit boilerplate when there are none.
- Include touched-file count and note if scope expanded beyond initial command family.

## Priority Order
- When guidance conflicts, apply in this order: **Hard Rules -> Scope & Changes -> Testing Matrix -> style/preferences**.
