// When a lane's `schedule:` trigger was registered (#1430).
//
// The Actions API only reports when the workflow *file* was created, which is the wrong anchor for
// first-run grace: adding `schedule:` to a workflow that has existed for a year yields an old
// creation date plus an empty scheduled-run history, so a lane that is not yet due would alert
// immediately. Git history knows when the trigger actually appeared, so ask it — and when it cannot
// answer (shallow clone, no git), return null so the caller stays pending rather than guessing.

import { runCmdSync } from '../../src/utils/exec.ts';

/** Commit date of the newest commit that changed the number of `schedule:` occurrences. */
export function scheduleRegisteredAt(workflowDir: string, workflow: string): string | null {
  const file = `${workflowDir}/${workflow}`;
  const result = runCmdSync(
    'git',
    ['log', '-1', '--format=%cI', '--pickaxe-regex', '-S', '^\\s*schedule:', '--', file],
    { timeoutMs: 10_000, allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  const date = result.stdout.trim();
  return date.length > 0 && Number.isFinite(Date.parse(date)) ? date : null;
}
