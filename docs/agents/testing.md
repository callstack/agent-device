# Validate a change

## Run checks

1. During edits, run the focused test or `pnpm check:quick`.
2. Before you push, commit the change.
   Run `pnpm check:affected --run --head <commit>`.
3. For a broad refactor or an explicitly requested full gate, run `pnpm check`.

Serialized validation requires macOS or Linux.
On Windows, use plan mode or focused checks.
Wait for the owner to finish.
Do not add lock wrappers.
A wait ends after two hours.
Focused tests do not lock.
Avoid subprocess-heavy tests beside a broad gate.

The runner stops at failure.
Its receipt records refs, checkout state, commands, exits, skips, and results.

For a plan, run `pnpm check:affected`.
For reasons, add `--verbose`.
For JSON, run `pnpm --silent check:affected --json`.
With `--run --json`, stdout contains the receipt and stderr contains progress.
When head is `HEAD`, planning and execution include working-tree changes.

`pnpm check` runs every `localRunnable` catalog check except `vitest-related`.
It skips each non-`localRunnable` check, naming its CI lane.

Only a passed receipt with `exactCommit: true` proves validation at the named commit.
A dirty-tree pass is local feedback.
Detected checkout changes invalidate the run.
Initial/final checks detect persistent changes.
They do not sandbox the checkout.
During validation, stop all edits.

## Interpret selection

For package manifest or TypeScript config changes, retain full selection.
`FAIL-OPEN` means the selector could not safely narrow the set.
Read `failOpenReasons` in plan JSON or `plan.failOpenReasons` in a receipt.
Do not reduce selection to get a pass.

Read required-check status on the PR.
GitHub owns full coverage, native builds, device lanes, provider integration, and compatibility that uses history.
On a narrowed plan, related tests replace only provider integration.
For skipped-check owners, read `results[].reason`.
Until source-read ownership is complete, keep #4050's full-unit production fallback.
Do not add tests that assert prose.

## A gate failed

Separate cause from validation status.
Never call a failing gate passed.

| Evidence | Required action |
| --- | --- |
| Failure caused by this change | Fix its owner and rerun. Until a run passes, report failed validation. |
| Suspected host or infrastructure fault | Save the log. Compare the same command on unchanged base in an isolated checkout without competing tests. Until compared, report cause unproven. A solo pass does not prove contention. |
| Matching failure on unchanged base | Report Base-blocked with SHAs, command, and logs. Name the blocker and owner or issue. For authorized publication, use a draft with remaining checks. Do not mark merge-ready. |
| Unavailable or inconclusive base comparison | Record the missing evidence and next action. Report blocked with cause unproven. |
| Repaired fault or upstream fix | Rerun the failed check and affected gate at head. Require new evidence to change blocked status. |

Match failures by check, location, diagnostic code, and assertion.

Until a named owner or issue accepts the blocker, the implementing agent owns diagnosis.
Do not loop on an unchanged failure.
Do not widen timeouts. Do not mask exit codes.
Do not claim CI authority as a local pass.
Only if its log shows an infrastructure fault, rerun failed CI once.
If the same failure occurs twice, treat it as a finding.
