# Validate a change

For mutations or base comparisons, use [isolated experiments](test-experiments.md).

## Run checks

1. During edits, run the focused test or `pnpm check:quick`.
2. Before you push, commit the change.
   Run `pnpm check:affected --run --head <commit>`.
3. For a broad refactor or an explicitly requested full gate, run `pnpm check`.

Serialized validation requires macOS or Linux.
On Windows, use plan mode or focused checks.
Both broad commands acquire the same host lock.
Wait for the owner to finish, or cancel your waiter with Ctrl-C.
Do not add lock wrappers. Do not delete lock files.
A wait ends after two hours. Nested validation fails immediately.
Focused tests do not lock. Avoid subprocess-heavy tests beside a broad gate.

The runner prints progress and a receipt path. The receipt contains:

- Refs.
- Checkout state.
- Command logs.
- Exits.
- Skips.
- Vitest results.

Execution stops at the first failure. Unexecuted checks remain `not-run`.

- `pnpm check:affected`: compact plan.
- `pnpm check:affected --verbose`: plan with selection reasons.
- `pnpm --silent check:affected --json`: JSON plan.
- `pnpm --silent check:affected --run --json`: JSON execution receipt on stdout; progress on stderr.
- `pnpm check:affected --run`: includes staged, unstaged, and untracked changes for local feedback.

Only a passed receipt with `exactCommit: true` proves validation at the named commit.
A dirty-tree pass is local feedback. Detected checkout changes invalidate the run.
Initial/final checks detect persistent changes. They do not sandbox the checkout.
During validation, stop all edits.

## Interpret selection

A package manifest or TypeScript config can affect every consumer.
A full selection for these changes is intentional.
`FAIL-OPEN` means the selector could not safely narrow the set.
Read `failOpenReasons` in plan JSON or `plan.failOpenReasons` in a receipt.
Do not reduce selection to get a pass.

Read required-check status on the PR.
The receipt lists skipped checks and owners in `results[].reason`.
GitHub owns:

- Full coverage.
- Native builds.
- Device lanes.
- Provider integration.
- Compatibility that uses history.

Related tests do not replace those obligations.
Check the Integration Tests and Coverage jobs at the actual PR head.
For docs-only changes, run the selected documentation checks.
Do not add tests that assert prose.

## A gate failed

Keep failure attribution separate from validation status.
Never call a failing gate passed.

| Evidence | Next action | Outcome |
| --- | --- | --- |
| New failure caused by this change | Fix its owner. After the fix, rerun. | Validation failed until a new run passes. |
| Suspected host contention or infrastructure fault | Save the log. In an isolated checkout, run the same failing command on unchanged base, without competing tests. | Until compared, the cause is unproven. A solo pass does not prove contention. |
| Same failure reproduced on unchanged base | Record SHAs, command, logs, and matching failure. Assign the blocker to a named person or linked issue. | Base-blocked. If publication is authorized, publish a draft with the blocker and remaining checks. Do not mark merge-ready. |
| Base comparison unavailable or inconclusive | Record the missing tool/device/evidence and next action. | Blocked, cause unproven. An authorized draft can record this. |
| Failure source fixed, environment repaired, or new upstream commit contains the fix | Run the failing check. Then run the affected gate on the current head. | Replace blocked status only with new evidence. |

Match failures by:

- Check.
- Location.
- Diagnostic code.
- Assertion.

Until a named owner or issue accepts the blocker, the implementing agent owns diagnosis.
Do not loop on an unchanged failure.
Do not widen timeouts. Do not mask exit codes.
Do not claim CI authority as a local pass.
Only if its log shows an infrastructure fault, rerun failed CI once.
If the same failure occurs twice, treat it as a finding.
