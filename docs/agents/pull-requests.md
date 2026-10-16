# Open or update a PR

A request to open or ship a PR authorizes branch creation, commits, push, and PR creation after validation.
Apply authorization already given. Merging and releasing need separate authorization.

## Validate

Follow [validation](testing.md). Before pushing, run `pnpm check:affected --run --head <commit>`.
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

Give a fresh reviewer the worktree, head, base ref, and this prompt. Do not supply an implementation summary.

> You did not write this change. Assume it has bugs and find them. Read AGENTS.md and docs/agents/review.md.
> Read the full diff against the merge-base and untracked files. Open callers and siblings for each hunk.
> Keep this checkout read-only. Run experiments only in a separate disposable checkout.
> Report only findings with a triggering scenario: file:line, severity, what breaks, and the fix. If none, say so.

Fix accepted findings and rerun affected checks. Record a reason for rejected findings.
If no independent reviewer is available, reread the full diff cold and report that limitation.
An independent reviewer is required at the growth thresholds in [review guidance](review.md).

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
