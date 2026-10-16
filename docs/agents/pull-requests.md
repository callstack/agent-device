# Open or update a PR

A request to open or ship a PR authorizes these steps after validation:

- Branch creation.
- Commits.
- Push.
- PR creation.

Apply authorization already given. Merging and releasing need separate authorization.

## Validate

Follow [validation](testing.md).
Record the `check:affected --run --head` receipt in the PR body. A serialized gate stage can validate the pushed head instead.
Before you report publication, record that result.
For unresolved failures, follow the blocked-validation table.
An authorized incomplete draft can record a blocker. This is not a pass.
Push once per review round. Each push restarts CI. Drafts skip device lanes.

For device-facing changes, follow [device verification](device-verification.md).
Prove the changed route ran live. Fixtures and adjacent routes do not replace this evidence.
Report missing devices or commands.

- Published: the branch is pushed, the PR is open, and validation status is recorded at a named commit.
- Merge-ready: required checks pass at the actual head, with live evidence for device-facing changes.

Do not wait for CI merely to report publication.
Do not claim that skipped integration or coverage passed.

## Self-review

Commit the change.
Give an independent reviewer the worktree, the merge-base SHA, the head SHA, and the task requirements.
In the first review, do not supply an implementation summary.
Review that SHA range with AGENTS.md and [review guidance](review.md).

In later rounds, supply the SHA reviewed before, its findings, and their dispositions.
Review the changes since that SHA and the interactions that they affect.
After a rebase, compare the branch ranges with `git range-diff <old-base>..<old-head> <new-base>..<new-head>`.
Fix accepted findings. Rerun affected checks.
For rejected findings, record a reason.
If no independent reviewer is available, read the full diff again cold. Report that limitation.
At the growth thresholds in [review guidance](review.md), this fallback does not replace the required independent reviewer.

## Scope and commits

Keep gross diffs below 1,000 lines, or 2,500 for one coherent change in self-contained commits.
Measure with `git diff --stat origin/main...HEAD`.
Stack only layers that can merge independently.
Rename-only `refactor(move)` PRs are exempt when `git diff -M90% --stat origin/main...HEAD` proves no material content change.
Use conventional commit prefixes, without agent tags.
Put enforcement edits in a final `chore(gates): <what and why>` commit.

For conflicts or relevant upstream changes, rebase. Disjoint changes alone do not require rebase.
After a rebase, validate the new head. Keep old evidence attributed to its original SHA.

## PR body

Use ready-for-review by default. When requested or intentionally incomplete, use draft.
Keep the body below 250 words:

- `## Summary`: include:
  - The behavior and reason.
  - The touched-file count.
  - Scope expansion.
  - The linked issue.
  For public API changes, add 1–3 CLI/Node/MCP examples.
- `## Validation`: include:
  - The tested SHA.
  - Command results.
  - CI obligations.
  - Unresolved risks.
  Use evidence accessible remotely.
  For fixes, show base/head SHAs and the same command's results.
  For docs-only changes, explain why runtime tests do not apply.
