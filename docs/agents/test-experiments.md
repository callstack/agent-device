# Isolated test experiments

Use this for manual mutations, regression proof, or base comparisons. Scheduled mutation sweeps follow [gate maintenance](gates.md).
Keep the reviewed and implementation checkouts unchanged. Reviewers have read scopes, not edit ownership.

## Prepare

1. Record the reviewed SHA, `git status --porcelain=v1`, and any existing diff before the experiment.
2. Create a disposable checkout outside app-managed worktrees:

```sh
reviewed_sha=$(git rev-parse HEAD)
experiment_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-device-experiment.XXXXXX")
git worktree add --detach "$experiment_dir" "$reviewed_sha"
```

3. In that checkout, run `pnpm install --frozen-lockfile && pnpm build`.
   Do not reuse another checkout's `node_modules` or copy `.env`.
4. For base comparison, create it at the named base SHA instead. Record that SHA before running.
   Use the same command, environment, and worker limit. Run sequentially without competing test processes.
5. If the change is uncommitted, apply only its relevant patch and required untracked files to the disposable checkout.
   Record the patch input. It is not exact-commit evidence.

## Prove detection

- Regression: run the new test against code without the fix. It must fail for the claimed bug.
  Run it with the fix. It must pass. If it passes without the fix, improve the test.
- Mutation: run the unmodified focused suite. It must pass. Plant the production edit representing the claimed bug.
  Run the same suite. It must fail for that bug. Record counts, for example `8 passed` then `1 failed, 7 passed`.
- Test deletion: perform the mutation after removing the candidate. Prove the retained test detects it.
- Structural gate or selection rule: plant a violation or failing selected test. Verify the intended gate reports it.
- Unchanged-base failure: do not copy head changes into the base checkout. Preserve both logs and SHAs.

A setup failure is not evidence. Measure detection.
Use distinct checkouts and devices for parallel experiments.

## Finish

1. Remove only the disposable worktree you created: `git worktree remove --force "$experiment_dir"`.
2. Verify the reviewed SHA, status, and existing diff still match the recorded originals.
3. Report before/after counts, commands, SHAs or patch inputs, failure reason, and cleanup status.

Stop and report if the reviewed checkout changes, setup fails, or detection remains unproven.
Never restore files in the reviewed checkout to hide an experiment's edits.
