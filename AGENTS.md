# AGENTS.md

`agent-device` is a CLI and daemon for automating devices and web targets.
The daemon owns sessions. Registry declarations route commands to platform runtimes.

## Task routing

Read only the row for your current task. Follow further links only when they apply.

| When the task involves | Read |
| --- | --- |
| Domain vocabulary | `CONTEXT.md`, `docs/agents/domain.md` |
| Architecture decisions | `docs/adr/README.md` |
| Source changes, package boundaries, routing, diagnostics | `docs/agents/code-ownership.md` |
| Running checks or diagnosing a failed gate | `docs/agents/testing.md` |
| Writing or changing tests | `docs/agents/test-authoring.md` |
| Auditing or deleting tests | `docs/agents/test-audit.md` |
| Mutation experiments or base comparisons | `docs/agents/test-experiments.md` |
| Changing gate selection, fuzzing, or mutation harnesses | `docs/agents/gates.md` |
| Selector capture, polling, interaction fast paths, replay | `docs/agents/selector-capture.md` |
| Adding or changing a CLI flag | `docs/agents/cli-flags.md` |
| Opening or updating a PR | `docs/agents/pull-requests.md` |
| Reviewing a change | `docs/agents/review.md` |
| Device-facing changes or manual device verification | `docs/agents/device-verification.md` |
| Writing issues or PRDs, and triage labels | `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` |
| Web backend setup or diagnostics | `docs/agents/web-backend.md` |

Device-facing changes affect live device behavior: dispatch, capture, interaction, app lifecycle, or native execution.
A daemon edit that changes none of these needs no device run.

Versioned CLI help owns command semantics. For app-driving startup, use the skill's routing card.

## Working rules

- Keep edits within the requested command family or module group. Inspect other platforms only when the task requires it.
- Fix recurring failures at the owning type, registry, or construction path. Do not reconstruct another owner's state.
- Use typed reasons and details for behavior. Never match error text.
- Add compatibility or fallback behavior only when explicitly requested or approved. Remove superseded paths during migrations.
- Encode invariants in names, types, and boundaries. Comments explain public APIs, tool directives, or constraints code cannot express.
- Resolve gate failures at the reported invariant. Do not suppress them or add an allowlist to get a pass.
- Use `@agent-device/selectors` for selector parsing and matching. See `docs/agents/code-ownership.md` for other shared owners.
- Keep skills as routing cards. Keep `CONTEXT.md` glossary-only. Update owning help and user docs when behavior changes.

## Worktree setup

- Use `pnpm`. Use OXC for lint and format. Run `pnpm format` repository-wide.
- In a fresh worktree, run `pnpm install --frozen-lockfile && pnpm build` before testing.
- Preserve other worktrees, devices, sessions, dirty files, and experiments.
- Never copy `.env` into a worktree. For host credentials, source the main checkout's file by absolute path.
- Give parallel workers disjoint files and distinct devices. `pnpm check:affected --run` and `pnpm check` serialize automatically.
- The layering scan reads tracked files. Stage new modules before trusting its result.
- Move a path's Fallow baseline entry when renaming its file. Do not regenerate unrelated baselines.

The validation lock reclaims provably dead owners automatically. Unknown owners remain blocking.
If waiting times out, report the printed owner and lock state; do not remove it by hand.

## Agent docs

Write short instructions with one action per sentence. Put the condition before its action.
Use the same term for the same concept. Keep commands and domain terms exact.
Route specialized rules to their task document. Delete duplicate or enforced rules before adding reminders.
