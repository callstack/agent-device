# Isolated test experiments

Use this for manual mutations, regression proof, or base comparisons. For scheduled mutation sweeps, follow [gate maintenance](gates.md).
Do not change the reviewed or implementation checkout.

## Prepare

1. Before the experiment, record the reviewed SHA, `git status --porcelain=v1`, and any existing diff.
2. Create a disposable checkout outside app-managed worktrees:

```sh
reviewed_sha=$(git rev-parse HEAD)
experiment_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-device-experiment.XXXXXX")
git worktree add --detach "$experiment_dir" "$reviewed_sha"
```

3. In that checkout, run `pnpm install --frozen-lockfile && pnpm build`.
   Do not use the `node_modules` of a different checkout.
4. For a base comparison, create the checkout at the named base SHA. Record that SHA before you run.
   Use the same command, environment, and worker limit. Run in sequence, with no competing test processes.
5. If the change is uncommitted, apply only its patch and the necessary untracked files to the disposable checkout.
   Record the patch input. It is not exact-commit evidence.

## Prove detection

- Regression: run the new test on the code without the fix. It must fail for the claimed bug.
  Run it with the fix. It must pass. If it passes without the fix, make the test better.
- Mutation: run the unmodified focused suite. It must pass. Plant the production edit that represents the claimed bug.
  Run the same suite. It must fail for that bug. Record the counts, for example `8 passed`, then `1 failed, 7 passed`.
- Test deletion: remove the candidate, then do the mutation. Prove that a retained test detects it.
- Structural gate or selection rule: plant a violation or a failing selected test. Verify that the intended gate reports it.
- Unchanged-base failure: do not copy head changes into the base checkout. Keep both logs and SHAs.

A setup failure is not evidence. Measure detection.

## Finish

1. Remove only the disposable worktree you created: `git worktree remove --force "$experiment_dir"`.
2. Verify that the reviewed SHA, status, and existing diff match the recorded originals.
3. Report before and after counts, commands, SHAs or patch inputs, failure reason, and cleanup status.

If the reviewed checkout changes, setup fails, or detection is not proven, stop and report.
Do not hide that change by restoring files.
