# Open or update a PR

After validation, a request to open or ship a PR authorizes branch creation, commits, push, and PR creation. Merging and releasing need separate authorization.

## Validate

Record the `check:affected --run --head` receipt in the PR body. A serialized gate stage can validate the pushed head instead.
An authorized incomplete draft can record a blocker. A blocker is not a pass.
Push once per review round. Each push restarts CI. Drafts skip device lanes.

Report missing devices or commands.

- Published: the branch is pushed, the PR is open, and validation status is recorded at a commit.
- Merge-ready: required checks pass at the head, with live evidence for device-facing changes.

Do not wait for CI merely to report publication.
Do not report skipped integration or coverage as passed.
Before a PR that adds a public package merges, the maintainer completes the npm onboarding in `CONTRIBUTING.md`.

## Self-review

Give an independent reviewer the worktree, merge-base and head SHAs, and task requirements.
Give no implementation summary in the first review.
Review that SHA range with AGENTS.md and [review guidance](review.md).

In later rounds, supply the SHA reviewed before, its findings, and their dispositions.
Review the changes since that SHA and the interactions they affect.
After a rebase, compare the branch ranges with `git range-diff <old-base>..<old-head> <new-base>..<new-head>`.
Fix accepted findings with the smallest change. Prefer configuration or deletion to new code.
Rerun affected checks.
For rejected findings, record a reason.
Without an independent reviewer, reread the full diff cold and report that limitation.
This fallback does not replace the reviewer that [review guidance](review.md) requires at its growth thresholds.

## Scope and commits

Keep gross diffs below 1,000 lines, or 2,500 for one coherent change in self-contained commits.
Measure with `git diff --stat origin/main...HEAD`.
Stack only layers that can merge independently.
A rename-only `refactor(move)` PR is exempt when `git diff -M90% --stat origin/main...HEAD` shows no material change.
Use conventional commit prefixes, without agent tags.
Never push tags.
Put enforcement edits in a final `chore(gates): <what and why>` commit.

For conflicts or relevant upstream changes, rebase. Disjoint changes alone need no rebase.
After a rebase, validate the new head. Keep old evidence attributed to its original SHA.

## PR body

Use ready-for-review by default. Use draft when requested or incomplete.
Keep the body under 250 words:

- `## Summary`: the behavior and reason, touched-file count, scope expansion, and linked issue.
  For public API changes, add 1–3 CLI/Node/MCP examples.
- `## Validation`: the tested SHA, command results, CI obligations, and unresolved risks.
  Use remotely accessible evidence.
  For fixes, show base/head SHAs and the same command's results.
  For docs-only changes, explain why runtime tests do not apply.
