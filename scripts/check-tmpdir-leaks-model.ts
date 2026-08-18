import fs from 'node:fs';
import path from 'node:path';

// Every test run (Vitest via scripts/vitest-tmpdir-global-setup.ts, node --test
// via scripts/node-test-tmpdir.ts) redirects TMPDIR into one disposable,
// pid-tagged directory under this root and removes it at teardown.
//
// Rooted at /tmp rather than nested inside the current os.tmpdir(): macOS's
// per-user TMPDIR (/var/folders/.../T/) is already close to the 104-byte
// sun_path limit AF_UNIX sockets need, and tests that bind real sockets
// (e.g. runner-usbmux.test.ts) started hitting EINVAL once nested one level
// deeper. /tmp is short enough to leave headroom for those.
//
// Both redirection mechanisms and check-tmpdir-leaks.ts import these two from
// here rather than recomputing them, so they can't drift onto different
// directories (os.tmpdir() != /tmp on macOS, where TMPDIR is a deep per-user
// path).
export const TEST_RUN_TMP_ROOT = '/tmp';
export const TEST_RUN_TMP_PREFIX = 'agent-device-test-run-';

const PID_SUFFIX = new RegExp(`^${TEST_RUN_TMP_PREFIX}(\\d+)-`);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but we lack permission to signal it — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Directories owned by a still-running process are a concurrent test run
 * (e.g. another worktree), not a leak — only report the ones whose owning
 * process has already exited without cleaning up after itself.
 */
export function findLeakedRunDirectories(
  root: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEST_RUN_TMP_PREFIX))
    .filter((entry) => {
      const match = PID_SUFFIX.exec(entry.name);
      // No parseable pid means it didn't come from setup() as written — treat it as a leak.
      if (!match) return true;
      return !isAlive(Number(match[1]));
    })
    .map((entry) => entry.name);
}

/**
 * Removes the run directories an earlier, already-exited run left behind and
 * returns their names. A run's setup calls this before creating its own
 * directory, so the post-run leak check (check-tmpdir-leaks.ts) can only ever
 * report the run that just finished: a directory abandoned by an earlier run
 * that was killed before its teardown (SIGKILL on a tool timeout, OOM, a
 * cancelled CI job) is by construction the same thing that teardown would have
 * removed, and leaving it in place made every later, otherwise-green gate on
 * the host fail for a run it never ran. Live owners are never touched, so a
 * concurrent run in another worktree keeps its directory.
 */
export function pruneAbandonedRunDirectories(
  root: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  const abandoned = findLeakedRunDirectories(root, isAlive);
  for (const name of abandoned) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return abandoned;
}

/**
 * One stderr line, only when something was pruned: an earlier run on this
 * host died before its teardown, which the operator should know (a tool
 * timeout killed it, say) without it being a failure of this run.
 */
export function reportPrunedRunDirectories(pruned: readonly string[]): void {
  if (pruned.length === 0) return;
  process.stderr.write(
    `[tmpdir] pruned ${pruned.length} abandoned ${TEST_RUN_TMP_PREFIX}* director${pruned.length === 1 ? 'y' : 'ies'} left by an earlier killed run\n`,
  );
}
