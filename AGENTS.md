# AGENTS.md

`agent-device` is a CLI and daemon for automating Apple, Android, HarmonyOS, Vega, Linux, and web
targets. A long-lived daemon owns sessions; registry-derived commands route to platform runtimes.

## Task execution

- Complete implementation, review, validation, and publication within the requested scope.
  Resolve routine choices from code and context; ask only when an answer changes scope, correctness,
  or authorization. Continue independent work while awaiting an answer.
- User instructions take precedence over repository and skill guidance, subject to system and
  developer constraints. Reuse approval already granted for the action. If guidance blocks progress,
  link the exact file, quote the instruction, and explain what remains blocked and why.
- Incorporate corrections and answer side questions while preserving the active objective unless
  the user cancels or replaces it. Preserve unrelated work in the checkout.
- When delegation is available and permitted, use it for independent investigation, implementation
  with disjoint file ownership, or review when it improves the outcome. Assign bounded scopes and
  expected evidence; verify results. Serialize full gates and device use.
- Lead updates and final responses with the outcome. Use concise, plain prose; include changed
  behavior, relevant validation, and unresolved limits. Finish unblocked work.

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

When running or changing CLI commands, use versioned help as the behavior reference: start with
`agent-device help workflow`, then the relevant topic help.

## Incident-derived principles

- Guarantees erode at path boundaries. Classify every interaction dispatch path in
  `packages/contracts/src/interaction-guarantees.ts`; a registry claim is not proof that the native
  implementation satisfies the guarantee's definition.
- Delegation on error proves no success-path parity. A fast path may succeed on a candidate the
  shared rules would refuse.
- Prove that a code path can fire before measuring it. An A/B test with an unreachable arm is two
  green runs without evidence.
- A green regression test counts only after it has been observed red against the pre-fix code. Plant
  a violation for new structural gates and verify the gate names the invariant.
- Repair recurring failures at their owning interface with types, a registry, or one construction
  path. A custom guard that reconstructs another source of truth needs redesign, not another
  exception.
- Treat explanatory implementation comments as a failed design review. Do not narrate control flow,
  preserve review history, or justify a workaround in code. Express the invariant through names,
  types, module boundaries, and tests; put history in the PR or an ADR. Allow only public API docs,
  tool directives, and a brief citation to an external constraint that cannot be encoded.
- Key behavior on typed reasons and details, never error text. Existing message sniffs are owned debt
  and must not be copied.
- Snapshot output is the token budget: do not add per-node metadata when response-level metadata can
  be emitted once. Append warnings through the shared response builder; never replace prior warnings.
- Before preserving a compatibility shape, run `git tag --contains <commit>`. Unreleased API has no
  external compatibility obligation.

## Declaration sites and enforcement

Read the declaration rather than maintaining a prose copy:

- commands and their surface, runtime-use, batch, and timeout traits:
  `src/core/command-descriptor/registry.ts`
- daemon route ownership and request-policy traits: `src/daemon/daemon-command-registry.ts`
- interaction paths and guarantees: `packages/contracts/src/interaction-guarantees.ts`
- canonical command names: `src/command-catalog.ts`
- device runtime-use declarations and fact admission:
  `src/core/command-descriptor/registry.ts`, `src/daemon/runtime-admission.ts`, and
  `src/platform-runtime-gateway.ts`
- common command input fields, and which surface may write an input key (model, operator, retired):
  `src/commands/common-input-fields.ts` and `src/commands/input-audience.ts`

Shared selector parsing and matching belongs in `@agent-device/selectors`; request cancellation
and progress in `@agent-device/capture-kit` (`request-cancel`, `request-progress`); cross-layer
contracts in `@agent-device/contracts`; CLI flags in `src/commands/cli-grammar`; cross-surface schema
composition in `src/cli-schema`.

The enforced registries are self-declaring. A failing completeness, parity, coverage, timeout,
layering, or construction gate means the new cell or path is unclassified; do not suppress or
allowlist it. Interaction responses are built only through `buildInteractionResponseData`, and
cross-language rules change through golden tables under `contracts/fixtures/`.

## Hard repository rules

- Plain `.mjs` packaging fixtures that cannot import TypeScript execution helpers keep child-process
  use local and prefer `execFile`.
- Apple target changes keep the kernel device model, runtime-fact admission, dispatch resolution,
  Apple discovery, and xctestrun preparation in sync.
- iOS simulator-set scoping must never hide the host macOS desktop target.
- Skills may carry a minimal start/routing card; command semantics belong in versioned CLI help.
- Do not add compatibility or fallback behavior without explicit approval. Complete migrations and
  remove superseded paths.
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
- Shared fixtures are named exports in a sibling fixture module, not repeated inline literals.
- `src/daemon/handlers/session.ts` is already over budget; extract the relevant platform-specific
  concept before adding behavior.

## Toolchain and worktree traps

- Use `pnpm`; never add `package-lock.json`. OXC owns lint and format. Run `pnpm format`
  repository-wide, not path-scoped.
- A fresh worktree requires `pnpm install --frozen-lockfile && pnpm build`. Until then package and
  optional-peer resolution may point at another checkout and produce false failures.
- Run one full gate per host at a time. Subprocess-backed tests under concurrent worktrees produce
  timeout-shaped contention failures.
- Select gates through `docs/agents/testing.md`; follow `docs/agents/pull-requests.md` before pushing.
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

Before adding guidance, decide whether the command surface, CLI grammar/help, MCP projection, daemon
runtime, ADR, or task procedure owns it. Link to executable registries instead of copying their
contents. Keep a sentence in this file only when no gate, lint rule, versioned help, ADR, or
decision-site comment can own it. `CONTEXT.md` is glossary-only: no implementation paths,
architecture decisions, migration state, or workflows.

Behavior changes update their owning help/metadata and user docs. In the final summary,
state whether docs or skills changed and why.
