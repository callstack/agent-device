# Open or update a PR

A request to open or ship a PR authorizes branch creation, commits, push, and PR creation after validation.
Apply authorization already given. Merging and releasing need separate authorization.

## Validate

Follow [validation](testing.md).
Record its receipt in the PR body. A serialized gate stage can validate the pushed head instead.
Record that result before reporting publication.
For unresolved failures, follow the blocked-validation table. An authorized incomplete draft can record a blocker; it is not a pass.
Push once per review round. Each push restarts CI. Drafts skip device lanes.

For device-facing changes, follow [device verification](device-verification.md).
Prove the changed route ran live. Fixtures and neighbouring routes do not replace this evidence.
Report missing devices or commands and incomplete session cleanup.

- Published: branch pushed, PR opened, validation status recorded at a named commit.
- Merge-ready: required checks pass at the actual head, with live evidence for device-facing changes.

Do not wait for CI merely to report publication. Do not claim skipped integration or coverage passed.

## Self-review

Commit the change. Give an independent reviewer the worktree, merge-base SHA, head SHA, and task requirements.
Keep the first review free of implementation summaries.
Review that SHA range using AGENTS.md and [review guidance](review.md).

In later rounds, provide the previously reviewed SHA, findings, and dispositions. Review changes since that SHA and their affected interactions.
After a rebase, compare branch ranges with `git range-diff <old-base>..<old-head> <new-base>..<new-head>`.
Fix accepted findings and rerun affected checks. Record a reason for rejected findings.
If no independent reviewer is available, reread the full diff cold and report that limitation.
At the growth thresholds in [review guidance](review.md), this fallback cannot replace the required independent reviewer.

## Scope and commits

Keep gross diffs below 1,000 lines, or 2,500 for one coherent change in self-contained commits.
Measure with `git diff --stat origin/main...HEAD`. Stack only independently landable layers.
Rename-only `refactor(move)` PRs are exempt when `git diff -M90% --stat origin/main...HEAD` proves no material content change.
Use conventional commit prefixes, without agent tags. Put enforcement edits in a final `chore(gates): <what and why>` commit.

Rebase for conflicts or relevant upstream changes. Disjoint changes alone do not require rebase.
After rebase, validate the new head. Keep old evidence attributed to its original SHA.

## PR body

Use ready-for-review by default. Use draft when requested or intentionally incomplete.
Keep the body below 250 words:

- `## Summary`: behavior and reason; touched-file count; scope expansion; linked issue.
  Add 1–3 CLI/Node/MCP examples for public API changes.
- `## Validation`: tested SHA, command results, CI obligations, and unresolved risks.
  Use remote-accessible evidence. For fixes, show base/head SHAs and the same command's results.
  For docs-only changes, explain why runtime tests do not apply.
