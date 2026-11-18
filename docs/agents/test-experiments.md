# Isolated test experiments

Use this for manual mutations, regression proof, and base comparisons. Scheduled sweeps follow [gate maintenance](gates.md).
Do not change the reviewed or implementation checkout.

## Prepare

1. First, record the reviewed SHA, `git status --porcelain=v1`, and any existing diff.
2. Create a disposable checkout outside app-managed worktrees:

```sh
reviewed_sha=$(git rev-parse HEAD)
experiment_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-device-experiment.XXXXXX")
git worktree add --detach "$experiment_dir" "$reviewed_sha"
```

3. Install and build in that checkout. Do not reuse another checkout's `node_modules`.
4. For a base comparison, check out the named base SHA, and record it before you run.
   Use the same command, environment, and worker limit. Run in sequence, without competing test processes.
5. If the change is uncommitted, apply only its patch and needed untracked files to the disposable checkout.
   Record the patch input. It is not exact-commit evidence.

## Prove detection

- Regression: without the fix, the new test must fail for the claimed bug. With the fix, it must pass. Otherwise, improve the test.
- Mutation: the unmodified focused suite must pass. Plant the production edit for the claimed bug. The same suite must then fail for that bug. Record the counts, for example `8 passed`, then `1 failed, 7 passed`.
- Test deletion: remove the candidate, then mutate. Prove that a retained test detects it.
- Structural gate or selection rule: plant a violation or a failing selected test. The intended gate must report it.
- Unchanged-base failure: do not copy head changes into the base checkout. Keep both logs and SHAs.

A setup failure is not evidence. Measure detection.

## Finish

1. Remove only the disposable worktree you created: `git worktree remove --force "$experiment_dir"`.
2. Verify the reviewed SHA, status, and diff against the recorded originals.
3. Report before and after counts, commands, SHAs or patch inputs, failure reason, and cleanup status.

If the reviewed checkout changes, setup fails, or detection is not proven, stop and report.
Do not hide that change by restoring files.
