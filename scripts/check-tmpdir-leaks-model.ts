import fs from 'node:fs';
import { TEST_RUN_TMP_PREFIX } from './vitest-tmpdir-global-setup.ts';

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
 * Directories owned by a still-running process are a concurrent vitest run
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
