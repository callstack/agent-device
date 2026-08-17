# AGENTS.md

`agent-device` is a CLI + daemon that automates Apple-platform (iOS/tvOS/macOS), Android, and web
targets for coding agents. A long-lived daemon owns device sessions; commands route through a
registry-derived command surface to per-platform backends.

This file carries the traps and invariants you cannot infer by reading the code. Everything
situational lives one hop away — load it when the task calls for it.

| When the task involves | Read |
| --- | --- |
| Domain vocabulary, architecture language, capture-reliability contract | `CONTEXT.md` |
| Accepted architecture decisions | `docs/adr/README.md` (a "read when you touch…" index) |
| Which gates to run, test speed rules, shared fixtures | `docs/agents/testing.md` |
| Adding or changing a CLI flag | `docs/agents/cli-flags.md` |
| Opening a PR, or reviewing one | `docs/agents/pull-requests.md` |
| Running commands against a real device | `docs/agents/device-verification.md` |
| Issues, PRDs, triage labels | `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` |
| Web automation backend setup/diagnostics | `docs/agents/web-backend.md` |
| Planning device automation commands | `agent-device help workflow`, then topic help (`debugging`, `react-native`, `react-devtools`, `physical-device`, `macos`, `dogfood`) |

Versioned CLI help is the agent-facing source of truth for command behavior — prefer it over any
prose in this repo, including this file.

## Principles (expensive lessons — each cost an incident)

- Guarantees erode at path boundaries. Any new dispatch path or fast path classifies its cells in
  `packages/contracts/src/interaction-guarantees.ts` first; the typechecker forces completeness, you supply
  honesty. ADR 0011.
- A registry claim is not a semantic check: never mark a cell `runner` without reading whether the
  Swift code implements the guarantee's *definition*, not just a similar-sounding behavior.
- Delegation-on-error is not success-path parity. A fast path that falls back on failure can still
  succeed on a candidate the shared rules would refuse.
- Do not measure before confirming the code path can fire. An A/B whose B-arm cannot execute returns
  two green runs masquerading as evidence.
- A green check is evidence only once you have seen it red. Prove a new regression test against the
  pre-fix code (revert, run, quote the failing number), a moved test against its gates (planted type
  error, discovered-count delta), a structural gate against a planted violation. Three vacuous
  regression tests shipped in one day before this rule; review caught all three.
- Regression tests are evidence, not the default repair. First make the error class impossible at
  the owning interface with types, a registry, or one construction path; then add the smallest
  interface-level regression that proves the invariant. If a custom guard starts reconstructing a
  compiler, schema, or scope model—or needs a second omission patch—redesign it around the source of
  truth instead of adding another exception.
- Typed signals over message sniffing: key on structured details (`details.timeoutMs`, reason codes),
  never on error text. Remaining sniffs are owned debt with in-code rationale — do not copy them.
- Snapshot output is the token budget. Never add per-node bytes to the tree; response-level metadata
  rides once per response.
- Warnings compose, never clobber. Append through the shared response builder; two clobber bugs
  shipped before this rule.
- Unreleased API surface dies free. Before treating a field as wire-compat, check
  `git tag --contains <commit>`; if it never shipped, delete it now.
- Push only behind an `&&`-chained affected gate:
  `pnpm check:affected --run && git push`. A push that can run after a failed gate eventually will;
  GitHub remains authoritative for reported device/toolchain lanes.

## Derived registries — read the declaration site, not prose

Command identity, routing, capability, and request-policy traits are *derived* artifacts. Inspect the
declaration site rather than any map someone wrote down:

- one `CommandDescriptor` per command: `src/core/command-descriptor/registry.ts` (catalog,
  capabilities, MCP/CLI projection, batch policy, timeout policy — ADR 0008)
- daemon route ownership + request-policy traits: `src/daemon/daemon-command-registry.ts`
  (parity-tested)
- interaction dispatch paths × guarantees: `packages/contracts/src/interaction-guarantees.ts` (ADR 0011)
- command names: `src/command-catalog.ts` — never re-create command string sets in handlers
- capabilities: `src/core/capabilities.ts` is the only home for command/device support checks

`src/daemon.ts` stays a thin router and `src/daemon/request-router.ts` orchestration-only; command
logic belongs in handlers. New daemon handler-family commands update the daemon command registry.

Shared selector parsing/matching/resolution lives in `@agent-device/selectors`; request cancellation/progress
primitives in `src/request`; cross-layer platform and command data contracts in `src/contracts`. CLI
grammar owns flag declarations under `src/commands/cli-grammar`; cross-surface CLI schema composition
lives in `src/cli-schema`.

## Enforcement gates (a failing gate located your incomplete change)

Invariants here are self-declaring gates. The correct response to a failure is to classify or cover
the new thing — never to suppress or allowlist it.

- public CLI flags must be classified: `scripts/integration-progress-model.ts`
- guarantee matrix completeness + honesty: `src/__tests__/contracts/interaction-guarantees.test.ts`
  (gap waivers need a `trackingIssue`; the pin list changes only in reviewed diffs)
- every enforced/delegated matrix cell needs a contract scenario:
  `src/__tests__/contracts/interaction-contract-coverage.test.ts` + `test/integration/interaction-contract/`
- interaction responses build only through `buildInteractionResponseData` (construction-guard test)
- every command declares a timeout policy on its descriptor (timeout-policy completeness test)
- TS/Swift rule parity: golden tables under `contracts/fixtures/`, consumed by vitest and the gated
  XCTest — change the rule only via the table
- cross-command apple-leak guard; folder DAG/import lint (zero value-import cycles, zero target-spine
  back-edges); fallow (dead code, duplication, complexity)

## Hard Rules

- Process execution goes through `src/utils/exec.ts` (`runCmd`, `runCmdStreaming`, `runCmdSync`,
  `runCmdBackground`, `runCmdDetached`). Do not import raw `spawn`/`spawnSync` elsewhere — extend an
  exec helper instead. Plain `.mjs` packaging fixtures that cannot import TS helpers keep
  child-process usage local and prefer `execFile`/`execFileSync`.
- Interactions use the daemon session flow: `open` before, `close` after.
- `keyboard dismiss` is the iOS keyboard dismissal path. It may tap safe native controls such as
  `Done`, but must not fall back to system back navigation.
- Do not remove shared snapshot/session model behavior without full migration.
- Apple-family target changes keep `packages/kernel/src/device.ts`, `src/core/capabilities.ts`,
  `src/core/dispatch-resolve.ts`, `src/platforms/apple/core/devices.ts`, and
  `src/platforms/apple/core/runner/runner-xctestrun.ts` in sync.
- iOS simulator-set scoping is iOS-specific: `iosSimulatorDeviceSet` must not hide the host macOS
  desktop target when `--platform macos` or `--target desktop` is requested.
- Use `inferFillText` (`src/daemon/action-utils.ts`), `uniqueStrings` (`@agent-device/kernel/collections`),
  and `evaluateIsPredicate` (`@agent-device/selectors`) rather than reimplementing them.
- Do not update `skills/**/SKILL.md` for command behavior or workflow guidance unless the user asks.
  Skills are thin routers to versioned CLI help; they must not carry behavior details.

## Scope & shape

- Keep changes to one command family or module group unless the task explicitly crosses boundaries.
  If scope expands, stop and confirm. Preserve daemon session semantics and platform behavior.
- Do not inspect both iOS and Android paths unless the task is explicitly cross-platform.
- Prefer composition at platform boundaries: public aliases normalize into shared primitives, and
  providers contribute transport/device bindings instead of cloning interaction runtimes.
- Use `unknown` only at trust boundaries — parsed JSON, daemon/runtime payloads, catch values,
  generic I/O, parser callbacks. Once validated, narrow to a domain type instead of carrying
  `unknown` through internal helper and formatter signatures.
- When asked to make a change, do not unilaterally add a fallback. Complete the migration and remove
  superseded code and documentation rather than preserving an old path “just in case.” Get explicit
  approval before adding compatibility or fallback behavior.
- Before finalizing, do one tightening pass over touched and adjacent areas: drop obsolete code,
  redundant tests, stale helpers/fixtures, and duplication the change made unnecessary.
- Name durable module concepts with `CONTEXT.md` vocabulary. Do not coin parallel names across docs,
  tests, and code.
Module size is about agent context safety, and the unit is questions, not lines: a file should answer
one question so `rg` → read-whole-file stays one cheap bounded read.

- tripwires: target ≤300 LOC per implementation file; past 500, extract before adding behavior; past
  1,000 is architecture debt unless it is generated data or a fixture snapshot. Tests are not exempt.
- name files by the domain concept they answer (`runner-cache.ts`, `interaction-touch-response.ts`),
  not by layer leftovers (`utils2.ts`, `common.ts` accretion).
- colocate machine-readable claims with the code they describe — coverage manifests beside contract
  tests, registry cells beside enforcement pointers, decision comments at the decision site. Agents
  navigate by claims, not directory listings.
- test files mirror source topology 1:1; when a source module splits, split its test file in the same
  PR. A 3,000-line family aggregation makes every fixture lookup a whole-file read.
  `interaction.test.ts` and platform `index.test.ts` predate this rule and shrink opportunistically —
  do not add to them.
- shared fixtures are named exports in a sibling fixtures module (see
  `test/integration/interaction-contract/fixtures.ts`), never inline literals repeated per test.
- long guidance/data tables live behind focused modules, not beside parser/runtime logic.
- barrels only at package boundaries. Legacy internal barrels are gated for removal (`CONTEXT.md`).
- extract when it improves locality for a concept callers already need, not to hit a line count.
- `src/daemon/handlers/session.ts` and `src/platforms/apple/core/apps.ts` are already over budget.
  Extract the Apple-family/macOS-specific helpers before adding behavior to either.

## Toolchain gotchas

- `pnpm` only. Do not add or restore `package-lock.json`. ESLint/Prettier are gone — the lint/format
  stack is OXC (`.oxlintrc.json`, `.oxfmtrc.json`). Read `.oxlintrc.json` before treating lint output
  as a source-level bug.
- Daemon state: packaged installs use `~/.agent-device`; source checkouts use worktree-scoped dirs
  under `~/.agent-device/dev/<basename-slug>-<hash>`. Inspect with `pnpm daemon:state-dir`, override
  with `--state-dir`/`AGENT_DEVICE_STATE_DIR`, prune with `pnpm clean:daemon --prune-dev`. Daemons
  are isolated per worktree; **devices are not** — target different devices for concurrent worktrees.
- Node ≥22. Prefer built-ins (`fetch`, Web Streams, `AbortSignal.timeout`) over compatibility
  wrappers unless the surrounding code needs a lower-level transport.
- Emit with `tsdown` (Rolldown), typecheck with TypeScript 7 via `tsc`. Declaration generation uses
  the TS7 native executable and is stricter than a plain typecheck: if it fails, inspect
  `tsconfig.lib.json` (it needs an explicit `rootDir: "./src"`) and `tsdown.config.ts` first, and run
  `pnpm check:tooling` for any build-tooling edit.
- Prefer the aggregate `package.json` scripts; they encode the expected validation bundles better
  than ad hoc command lists. `pnpm format` formats the whole repo (`oxfmt` with no path list), and
  the only exclusion list is `.oxfmtrc.json` `ignorePatterns` — Markdown, the Maestro conformance
  corpus, and generated baselines. Run `pnpm format`, never `oxfmt <path>`: a path argument
  reformats a subset and hides whatever else drifted.
- Before pushing, default to **`pnpm check:affected --run`**. It selects the relevant local gates and
  reports native/device checks left to GitHub. Use **`pnpm check`**
  (`check:tooling && check:fallow && check:unit`) for broad refactors or an explicitly requested full
  deterministic core gate. Neither command claims to reproduce every GitHub job.
  Fallow's baselines are keyed by path, so a change that RENAMES a file must move that file's
  entry in `fallow-baselines/health.json` — regenerating the baselines would silently accept
  every other outstanding finding too.

## Apple runner seams

The OS-agnostic XCTest runner lives under `src/platforms/apple/core/runner/`. Keep dependency
direction clean: transport below client/session behavior, shared command/error contracts in the
runner contract module, xctestrun preparation/build/cache isolated from request execution. For
connect errors, retry policy, or command typing, start in
`src/platforms/apple/core/runner/runner-contract.ts` before touching client/transport files.

## Diagnostics, errors, logs

- Diagnostics source of truth: `src/utils/diagnostics.ts` (`withDiagnosticsScope`,
  `updateDiagnosticsScope`, `emitDiagnostic`, `withDiagnosticTimer`, `flushDiagnosticsToSessionFile`).
  No ad-hoc stderr/file logging where these apply; redaction stays centralized here.
- Request diagnostics belong in `sessions/<effective-session>/requests/<request-id>.ndjson`. The
  top-level daemon log is for lifecycle/startup and pre-session failures. Session artifact paths come
  from `src/daemon/session-store.ts` — do not hand-build them in handlers.
- Logs backend: `src/daemon/app-log.ts`. `session.ts` orchestrates only (start/stop/path/doctor/mark)
  and must not duplicate backend logic. App/device logs stay in `app.log`; Apple runner and
  `xcodebuild` subprocess output belongs in the session-scoped `runner.log`. Preserve the external
  grep/tail workflow documented in help/skills.
- Normalize user-facing failures via `normalizeError` (`@agent-device/kernel/errors`). Payload contract:
  `code`, `message`, `hint`, `diagnosticId`, `logPath`, `details`. Preserve `hint`, `diagnosticId`,
  and `logPath` when wrapping or rethrowing. Errors say what failed, why when known, and how to
  recover — recovery steps go in `hint` when the action is not obvious.
- `--debug` is canonical; `--verbose` is a backward-compatible alias.
- An interaction that unexpectedly takes 5+ seconds is a daemon-log question, not an app question:
  check the session `daemon.log` or the failure `logPath` for runner restart, stale session recovery,
  AX failure, transport retry, or command timeout evidence.
- Optional optimizations (cache/preflight/probe) are best-effort unless the feature contract says
  otherwise: on failure, timeout, non-OK, or unusable shape, fall back to the required command path.
  Keep their timeouts shorter than the operation they precede.

## Selector system

- Interaction commands (`click`, `fill`, `get`, `is`) and `wait` accept selectors and `@ref`.
- Pipeline: **parse → resolve → act → record selectorChain → re-resolve as a divergence suggestion on
  replay failure.** Call `buildSelectorChainForNode` after resolving target nodes.
- New element-targeting interactions must support selector + `@ref` and record `selectorChain` so
  `collectReplaySelectorCandidates` (`src/daemon/handlers/session-replay-heal.ts`) can rank it in a
  divergence report (`session-replay-divergence.ts`). ADR 0012 retired `--update`'s silent
  rewrite-on-heal; there is no automated write path to hook into.
- New selector keys stay centralized in the private parser under `packages/selectors`; new `is` predicates belong in
  `evaluateIsPredicate`.
- On macOS, snapshot rects are absolute in window space. Point-based runner interactions translate
  through the interaction root frame — do not assume app-origin `(0,0)`. Prefer selector or `@ref`
  over raw x/y in tests and docs, especially on macOS where window position varies across runs.

## Known environment traps (do not debug these as regressions)

- The first `node` exec right after the dev-signed Apple runner launches can block ~19s at 0% CPU
  (Gatekeeper re-verification). It poisons back-to-back CLI wall-clock timing; absorb it with a
  throwaway `node -e 0`, or measure in-process/daemon-side.
- A leftover session holding the device fails every subsequent command instantly with
  `DEVICE_IN_USE` naming the owner. The hint's `close --session` guidance is the fix, not daemon
  debugging.
- Contention flakes: `request-handler-catalog` ("specialized daemon routes...") and the doctor
  provider scenario time out under host load. Before believing a regression, rerun in isolation AND
  reproduce on plain `origin/main` under the same load. A changing failure set that passes in
  isolation is contention, not your change. The files CI may rerun once for a timeout-shaped failure
  are enumerated in `scripts/lib/contention-retry.ts` (docs/agents/testing.md, "Contention retry
  policy").

## Docs & skills

- Before adding guidance, examples, schemas, or command metadata anywhere, decide which layer owns
  it: the command surface, CLI grammar, CLI help, MCP projection, or daemon runtime. Picking the
  layer after writing is how the same contract ends up duplicated across two of them.
  `docs/agents/cli-flags.md` walks the layers for the flag case.
- Decide docs impact with the change, not after. For behavior/CLI-surface changes: update
  help/metadata, README or `website/docs/**` when user-facing, and a help-conformance bench case
  (`scripts/help-conformance-*.mjs`) when command-planning guidance changes.
- State in the final summary whether docs/skills were updated, and why not if they weren't.
- README altitude: the intro is a category line, the job pitch with the platform list, and the
  works-with/proof line — nothing else. Per-platform transports, tool names, vendor lists, and
  support caveats go in "How it works" and `website/docs/**`. A new platform adds its name to the
  intro list and its backend to "How it works", nothing more.

When guidance conflicts, Hard Rules win, then scope, then testing, then style.
