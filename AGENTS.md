# AGENTS.md

`agent-device` is a CLI and daemon that automates devices and web targets.
The daemon owns sessions. Registry declarations route commands to platform runtimes.

## Worker handoff

For a delegated task, CI owns validation.
Do not run local gates, check scripts, coverage, or project-wide tests.
If you write a test, run only that test file.
If the task asks you to publish a change, push it.
Report the head SHA with checks pending.
Do not wait for CI.

## Task routing

If the task names the owning file, start there.
For each question that remains, use the matching row.

| When the task involves | Read |
| --- | --- |
| Domain vocabulary | `CONTEXT.md` |
| Architecture decisions | `docs/adr/README.md` |
| Write or amend an ADR | `docs/adr/FORMAT.md` |
| Source, package boundaries, routing, diagnostics, CI | `docs/agents/code-ownership.md` |
| A CI failure to fix or local validation for maintainers | `docs/agents/testing.md` |
| New or changed tests | `docs/agents/test-authoring.md` |
| Test audits or deletions | `docs/agents/test-audit.md` |
| Mutation experiments or base comparisons | `docs/agents/test-experiments.md` |
| Gate selection, fuzzing, or mutation harnesses | `docs/agents/gates.md` |
| Selector capture, polling, interaction fast paths, replay | `docs/agents/selector-capture.md` |
| A new or changed CLI flag | `docs/agents/cli-flags.md` |
| A PR to open or update | `docs/agents/pull-requests.md` |
| A change to review | `docs/agents/review.md` |
| Trust boundaries, untrusted paths, security review | `docs/agents/security.md` |
| Apple runner or device-facing changes | `docs/agents/device-verification.md` |
| Issues, PRDs, or triage labels | `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` |
| Web backend setup or diagnostics | `docs/agents/web-backend.md` |

A device-facing change affects dispatch, capture, interaction, app lifecycle, or native execution.

The versioned CLI help owns command semantics. To drive an app, start with the skill's routing card.

## Working rules

- Keep edits in the requested command family or module group. Examine other platforms only when the task needs it.
- Fix a recurring failure at the owning type, registry, or construction path. Do not rebuild another owner's state.
- Use typed reasons and details for behavior. Do not match error text.
- Add compatibility or fallback behavior only on explicit request or approval. During a migration, remove superseded paths.
- Encode invariants in names, types, and boundaries. Write comments only for public APIs, tool directives, or constraints that code cannot show.
- Resolve a gate failure at the reported invariant. Do not suppress it. Do not add an allowlist to get a pass.
- Use `@agent-device/selectors` to parse and match selectors. For other shared owners, see `docs/agents/code-ownership.md`.
- Keep skills as routing cards. Keep `CONTEXT.md` a glossary only. When behavior changes, update the owning help and user docs.

## Worktree setup

- Use `pnpm`. Use OXC to format the files you change.
- If a requested reproduction or a permitted test needs setup, prepare only what it needs.
- Do not change other worktrees, devices, sessions, dirty files, or experiments. Do not use `git stash`; all worktrees share it.
- Do not copy `.env` into a worktree. For host credentials, source the main checkout's file by absolute path.
- Give each parallel worker different files and devices.
- The layering scan reads only tracked files. Stage new modules before you trust its result.
- When you rename a file, move its Fallow baseline entry. Do not regenerate unrelated baselines.

## Agent docs

Write agent docs in ASD-STE100. Write one instruction per sentence.
Put the condition before the instruction. Use one term for one concept.
Keep commands and domain terms exact. Put specialized rules and new shared constraints in the owning task document, not agent memory.
Before you add a reminder, delete duplicate or enforced rules.
