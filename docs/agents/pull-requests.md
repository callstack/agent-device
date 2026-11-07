# Open or update a PR

After validation, a request to open or ship a PR authorizes branch creation, commits, push, and PR creation. Merging and releasing need separate authorization.

## Validate

Follow [validation](testing.md).
Record the `check:affected --run --head` receipt in the PR body. A serialized gate stage can validate the pushed head instead.
An authorized incomplete draft can record a blocker. A blocker is not a pass.
Push once per review round. Each push restarts CI. Drafts skip device lanes.

For device-facing changes, follow [device verification](device-verification.md).
Report missing devices or commands.

- Published: the branch is pushed, the PR is open, and validation status is recorded at a named commit.
- Merge-ready: required checks pass at the head, with live evidence for device-facing changes.

Do not wait for CI merely to report publication.
Do not report skipped integration or coverage as passed.

## New public package

A new public package under `packages/` needs a safe transition on npm before its PR merges.
First, the maintainer publishes an empty placeholder version, for example `0.0.0`, under a dist-tag other than `latest`.
Then the maintainer configures the npm trusted publisher for the release workflow.
Only after these steps does the PR remove `"private": true`.

## Self-review

Give an independent reviewer the worktree, the merge-base SHA, the head SHA, and the task requirements.
In the first review, do not supply an implementation summary.
Review that SHA range with AGENTS.md and [review guidance](review.md).

In later rounds, supply the SHA reviewed before, its findings, and their dispositions.
Review the changes since that SHA and the interactions that they affect.
After a rebase, compare the branch ranges with `git range-diff <old-base>..<old-head> <new-base>..<new-head>`.
Fix accepted findings with the smallest change. Prefer configuration or deletion to new code.
Rerun affected checks.
For rejected findings, record a reason.
If no independent reviewer is available, read the full diff again cold. Report that limitation.
At the growth thresholds in [review guidance](review.md), this fallback does not replace the required independent reviewer.

## Scope and commits

Keep gross diffs below 1,000 lines, or 2,500 for one coherent change in self-contained commits.
Measure with `git diff --stat origin/main...HEAD`.
Stack only layers that can merge independently.
Rename-only `refactor(move)` PRs are exempt when `git diff -M90% --stat origin/main...HEAD` proves no material content change.
Use conventional commit prefixes, without agent tags.
Never push tags.
Put enforcement edits in a final `chore(gates): <what and why>` commit.

For conflicts or relevant upstream changes, rebase. Disjoint changes alone do not require rebase.
After a rebase, validate the new head. Keep old evidence attributed to its original SHA.

## PR body

Use ready-for-review by default. Use draft when requested or incomplete.
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
