# Validate a change

If you are a worker, use the CI log from the coordinator.

## Run local checks as a maintainer

Before testing in a new worktree, run `pnpm install --frozen-lockfile && pnpm build`.

1. During edits, run a focused test or `pnpm check:quick`.
2. Before you push, run `pnpm check:affected --run --head <commit>` on the committed change.
3. For a broad refactor or a requested full gate, run `pnpm check`.

Serialized validation requires macOS or Linux.
`pnpm check:affected --run`, `pnpm check`, and heavy `pnpm gate` ids share one lock.
On Windows, use plan mode or focused checks.
The lock reclaims provably dead owners. An unknown owner blocks.
If the two-hour wait ends, report the printed owner and lock state.
Do not add lock wrappers or remove the lock manually.
Focused tests do not lock.
Avoid subprocess-heavy tests beside a broad gate.
Stage new modules before the layering scan.

For a plan, run `pnpm check:affected`.
For reasons, add `--verbose`.
For JSON, run `pnpm --silent check:affected --json`.
With `--run --json`, stdout contains the receipt and stderr contains progress.
When head is `HEAD`, planning and execution include working-tree changes.

`pnpm check` runs every `localRunnable` check except `vitest-related`.
For each CI-only check, it names the CI lane.

Only a passed receipt with `exactCommit: true` proves a local pass at its named commit.
Checkout changes invalidate the run.
During validation, stop all edits.
The runner records the results in a receipt and stops at failure.

## Interpret selection

For package manifest or TypeScript config changes, retain full selection.
`FAIL-OPEN` means the selector could not safely narrow the set.
Read `failOpenReasons` in plan JSON or `plan.failOpenReasons` in a receipt.
Do not reduce selection to get a pass.

GitHub owns full coverage, native builds, device lanes, provider integration, and compatibility that uses history.
In a narrowed plan, related tests replace only provider integration.
For skip reasons, read `results[].reason`.
Keep #4050's full-unit fallback until source-read ownership is complete.

## Diagnose a gate failure as a maintainer

Never call a failing gate passed.

| Evidence | Required action |
| --- | --- |
| Failure from the change | Fix its owner and rerun. |
| Suspected infrastructure fault | Save the log. Run the same command at base without competing tests. |
| Matching failure at base | Report Base-blocked with SHAs, command, logs, and the owner or issue. If authorized to publish, open a draft with the remaining checks. |
| Missing or inconclusive base result | Report blocked with cause unproven. Give the missing evidence and next action. |
| Repaired fault or upstream fix | Rerun the failed check and affected gate at head. Change status only with new evidence. |

Match failures by check, location, diagnostic code, and assertion.

The coordinator owns diagnosis until a named owner or issue accepts it.
Do not widen timeouts. Do not mask exit codes.
If CI shows an infrastructure fault, rerun it once.
If the same failure occurs twice, treat it as a finding.
