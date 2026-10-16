# Validate a change

For mutations or base comparisons, use [isolated experiments](test-experiments.md).

## Run checks

1. While editing, run the focused test or `pnpm check:quick`.
2. Before pushing, commit the change. Run `pnpm check:affected --run --head <commit>`.
3. For a broad refactor or an explicitly requested full gate, run `pnpm check`.

Serialized validation requires macOS or Linux. On Windows, use plan mode or focused checks.
Both broad commands acquire the same host lock. Wait for the owner to finish, or cancel your waiter with Ctrl-C.
Do not add lock wrappers or delete lock files. A wait ends after two hours. Nested validation fails immediately.
Focused tests do not lock. Avoid subprocess-heavy tests beside a broad gate.

The runner prints progress and a receipt path with refs, checkout state, command logs, exits, skips, and Vitest results.
Execution stops at the first failure. Unexecuted checks remain `not-run`.

- `pnpm check:affected`: compact plan.
- `pnpm check:affected --verbose`: plan with selection reasons.
- `pnpm --silent check:affected --json`: JSON plan.
- `pnpm --silent check:affected --run --json`: JSON execution receipt on stdout; progress on stderr.
- `pnpm check:affected --run`: include staged, unstaged, and untracked changes for local feedback.

Only a passed receipt with `exactCommit: true` proves validation at the named commit.
A dirty-tree pass is local feedback. Detected checkout changes invalidate the run.
Initial/final checks detect persistent changes; they do not sandbox the checkout. Stop all edits during validation.

## Interpret selection

A package manifest or TypeScript config can affect every consumer. A full selection for these changes is intentional.
`FAIL-OPEN` means the selector could not safely narrow the set. Read `failOpenReasons` in plan JSON or `plan.failOpenReasons` in a receipt.
Do not reduce selection to get a pass.

Read required-check status on the PR. The receipt lists skipped checks and owners in `results[].reason`.
GitHub owns full coverage, native builds, device lanes, provider integration, and history-backed compatibility.
Related tests do not replace those obligations. Check the Integration Tests and Coverage jobs at the actual PR head.
For docs-only changes, run the selected documentation checks. Do not add tests asserting prose.

## A gate failed

Keep failure attribution separate from validation status. Never call a failing gate passed.

| Evidence | Next action | Outcome |
| --- | --- | --- |
| New failure caused by this change | Fix its owner. Rerun after the fix. | Validation failed until a new run passes. |
| Suspected host contention or infrastructure fault | Save the log. Run the same failing command on unchanged base in an isolated checkout, without competing tests. | Cause unproven until compared. A solo pass does not prove contention. |
| Same failure reproduced on unchanged base | Record SHAs, command, logs, and matching failure. Assign the blocker to a named person or linked issue. | Base-blocked. If publication is authorized, publish a draft with the blocker and remaining checks. Do not mark merge-ready. |
| Base comparison unavailable or inconclusive | Record the missing tool/device/evidence and next action. | Blocked, cause unproven. An authorized draft can record this. |
| Failure source fixed, environment repaired, or new upstream commit contains the fix | Run the failing check, then the affected gate on the current head. | Replace blocked status only with new evidence. |

Match failures by check, location, diagnostic code, and assertion.
The implementing agent owns diagnosis until a named owner or issue accepts the blocker.
Do not loop on an unchanged failure. Do not widen timeouts, mask exit codes, or invoke CI authority as a local pass.
Rerun failed CI once only when its log shows an infrastructure fault. Treat the same failure twice as a finding.
