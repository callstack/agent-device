# AGENTS.md

`agent-device` is a CLI and daemon for automating Apple, Android, HarmonyOS, Vega, Linux, and web
targets. A long-lived daemon owns sessions; registry-derived commands route to platform runtimes.

## Task routing

Load only the procedures relevant to the task:

| When the task involves | Read |
| --- | --- |
| Domain vocabulary | `CONTEXT.md`, `docs/agents/domain.md` |
| Architecture decisions | `docs/adr/README.md` |
| Tests or gate selection | `docs/agents/testing.md` |
| Selector capture, polling, or interaction fast paths | `docs/agents/selector-capture.md` |
| Adding or changing a CLI flag | `docs/agents/cli-flags.md` |
| Opening or reviewing a PR | `docs/agents/pull-requests.md` |
| Apple runner changes or manual device verification | `docs/agents/device-verification.md` |
| Writing issues or PRDs, and triage labels | `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` |
| Web backend setup or diagnostics | `docs/agents/web-backend.md` |

Versioned CLI help owns command semantics. Read the relevant topic when behavior is unclear;
normal app-driving startup follows the skill's routing card.

## Incident-derived principles

- Classify interaction dispatch paths in `packages/contracts/src/interaction-guarantees.ts` and
  verify each claim against the native implementation.
- Delegation on error proves no success-path parity. A fast path may succeed on a candidate the
  shared rules would refuse.
- Prove both paths are reachable before measuring a fast path against its baseline.
- Repair recurring failures at the owning type, registry, or construction path; do not add guards
  that reconstruct another source of truth.
- Keep control-flow narration and review history out of implementation comments. Encode invariants
  in names, types, boundaries, and tests; reserve comments for public API docs, tool directives,
  and non-obvious constraints that cannot be encoded.
- Key behavior on typed reasons and details, never error text; do not copy existing message sniffs.
- Keep metadata at response level when it applies to the whole snapshot. Append warnings through
  the shared response builder; never replace prior warnings.
- Before preserving a compatibility shape, run `git tag --contains <commit>`. Unreleased API has no
  external compatibility obligation.

## Declaration sites and enforcement

Read the declaration rather than maintaining a prose copy:

- commands and their surface, runtime-use, batch, and timeout traits:
  `packages/command-registry/src/registry.ts`
- daemon route ownership and request-policy traits: `src/daemon/daemon-command-registry.ts`
- interaction paths and guarantees: `packages/contracts/src/interaction-guarantees.ts`
- canonical command names: `packages/command-registry/src/catalog.ts`
- device runtime-use declarations and fact admission:
  `packages/command-registry/src/registry.ts`, `src/daemon/runtime-admission.ts`, and
  `src/platform-runtime-gateway.ts`
- common command input fields, and which surface may write an input key (model, operator, retired):
  `src/commands/common-input-fields.ts` and `src/commands/input-audience.ts`

Shared selector parsing and matching belongs in `@agent-device/selectors`; request cancellation
and progress in `@agent-device/capture-kit` (`request-cancel`, `request-progress`); cross-layer
contracts in `@agent-device/contracts`; CLI flags in `src/commands/cli-grammar`; cross-surface schema
composition in `src/cli-schema`.

Resolve registry completeness failures at the missing declaration. Diagnose other gate failures
at their reported invariant; do not suppress them or add an allowlist to get a pass. Build interaction
responses through `buildInteractionResponseData`; change cross-language rules through golden tables
under `contracts/fixtures/`.

## Hard repository rules

- Plain `.mjs` packaging fixtures that cannot import TypeScript execution helpers keep child-process
  use local and prefer `execFile`.
- Apple target changes keep the kernel device model, runtime-fact admission, dispatch resolution,
  Apple discovery, and xctestrun preparation in sync.
- iOS simulator-set scoping must never hide the host macOS desktop target.
- Skills stay minimal routing cards.
- Add compatibility or fallback behavior only when explicitly requested or approved. Otherwise,
  complete the migration and remove superseded paths.
- Keep changes within one command family or module group unless the task explicitly crosses a
  boundary. Platform-neutral work does not license inspecting every platform implementation.

## Module and test topology

- Name modules for the domain question they answer and colocate machine-readable claims with their
  enforcement. Internal barrels are legacy; add barrels only at package boundaries.
- Implementation files target at most 300 lines. Extract before adding behavior past 500 lines;
  files past 1,000 lines are architecture debt unless generated or fixture data.
- Tests mirror source topology one-to-one. Split a source module and its test together; do not add to
  the legacy `interaction.test.ts` or platform `index.test.ts` aggregations. Pure moves carry their
  tests unchanged; rename-only hunks owe no new coverage.
- `src/daemon/handlers/session.ts` is already over budget; extract the relevant platform-specific
  concept before adding behavior.

## Toolchain and worktree traps

- Use `pnpm`; never add `package-lock.json`. OXC owns lint and format. Run `pnpm format`
  repository-wide, not path-scoped.
- A fresh worktree requires `pnpm install --frozen-lockfile && pnpm build`. Until then package and
  optional-peer resolution may point at another checkout and produce false failures.
- Parallel work needs disjoint edit ownership and distinct devices. Run one full gate per host;
  concurrent subprocess-backed suites can produce contention timeouts.
- The layering scan reads tracked files only. Stage a new module before trusting its result.
- Fallow baselines are path-keyed. Move the matching baseline entry when renaming a file; never bulk
  regenerate baselines to accept unrelated findings.

## Runtime and diagnostics seams

Diagnostics use `@agent-device/capture-kit/diagnostics`. Request diagnostics belong in the session request log;
session artifact paths come from `src/daemon/session-store.ts`. App/device logs remain in `app.log`;
Apple runner and xcodebuild output remains in `runner.log`.

Normalize failures with `normalizeError` and preserve `hint`, `diagnosticId`, `logPath`, and typed
`details`. An interaction taking five seconds or more is a daemon-log question: inspect runner
restart, stale-session recovery, accessibility failure, transport retry, and timeout evidence.

Optional probes and caches are best-effort only when the feature contract says so. Their budgets
must be shorter than the required operation they precede.

## Selector and replay invariants

Element interactions support selector and `@ref`, then record a selector chain after resolution.
Replay failures may re-resolve that chain only to produce a ranked divergence suggestion; ADR 0012
retired silent script rewriting.

Selector keys stay centralized in `@agent-device/selectors`; `is` predicates use
`evaluateIsPredicate`. On macOS, snapshot rectangles are absolute in window space and point actions
translate through the interaction root frame. Prefer selector or ref tests over raw coordinates.

## Documentation ownership

Keep this file to repository traps and routing. Put task procedures in `docs/agents/`, decisions in
ADRs, and command semantics in versioned help. Link to executable registries instead of duplicating
their rules. `CONTEXT.md` is glossary-only: no implementation paths, decisions, or migration status.

Behavior changes update owning help/metadata and user docs. Report docs or skill changes when relevant.
