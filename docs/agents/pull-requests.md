# Open or update a PR

A request to open or ship a PR authorizes branch creation, commits, push, and PR creation.
Before you merge or release, get separate authorization.

## Validate

If you are a worker, publish the change with CI pending.
For maintainer validation, follow [validation](testing.md).
If you have authorization to open an incomplete draft, record its blocker.
For each review round, push once.
Each push restarts CI. Drafts skip device lanes.

If the task includes manual device verification, follow the [device guide](device-verification.md).
If a device or command blocks that run, report it.

- Published: the branch is pushed, the PR is open, and validation status is recorded at a named commit.
- Merge-ready: required checks pass at the head, with live evidence for device-facing changes.

A device-facing change affects live dispatch, capture, interaction, app lifecycle, or native execution.

Do not report skipped integration or coverage as passed.

## New public package

A new public package under `packages/` needs a safe transition on npm before its PR merges.
First, the maintainer publishes an empty placeholder version, for example `0.0.0`, under a dist-tag other than `latest`.
Then the maintainer configures the npm trusted publisher for the release workflow.
Only after these steps does the PR remove `"private": true`.

## Coordinator review

Give the reviewer the worktree, merge-base SHA, head SHA, and task requirements.
In the first review, do not supply an implementation summary.
Review that SHA range with AGENTS.md and [review guidance](review.md).

In later rounds, supply the SHA reviewed before, its findings, and their dispositions.
Review the changes since that SHA and the interactions that they affect.
After a rebase, compare the branch ranges with `git range-diff <old-base>..<old-head> <new-base>..<new-head>`.
Fix accepted findings with the smallest change. Prefer configuration or deletion to new code.
For rejected findings, record a reason.
If no independent reviewer is available, read the full diff again cold. Report that limitation.
At the [review](review.md) growth thresholds, this fallback is not enough.

## Scope and commits

Keep gross diffs below 1,000 lines, or 2,500 for one coherent change in self-contained commits.
Stack only layers that can merge independently.
Rename-only `refactor(move)` PRs are exempt when `git diff -M90% --stat origin/main...HEAD` proves no material content change.
Use conventional commit prefixes, without agent tags.
Never push tags.
Put enforcement edits in a final `chore(gates): <what and why>` commit.

For conflicts or relevant upstream changes, rebase. Disjoint changes alone do not require rebase.
After a rebase, keep old evidence attributed to its original SHA.

## PR body

The `pr-body` gate enforces the sections and the 250-word limit.
If the scope or evidence changes, update the body.
If the task requests a draft or the implementation is incomplete, open as draft.

- `## Summary`: the invariant and behavior, the reason, the linked issue, and scope expansion.
- `## Before / after`: for `feat` and `fix`, up to 3 calls at base and head, with the
  output that differs. Or state `No observable change` with a reason.
- `## Value`: for a refactor, 2–4 numbers measured at base and head.
- `## Validation`: validation status at the head SHA, available evidence, and unresolved risks.
  Use evidence accessible remotely.
  If CI is pending, record `CI pending`.
  For docs-only changes, explain why runtime tests do not apply.
