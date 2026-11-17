import fs from 'node:fs';
import { vi } from 'vitest';

/**
 * Answers the identity reader's `/proc` reads with nothing, so these files' `ps` doubles are the only
 * evidence. The reader prefers one `/proc/<pid>/stat` read over the `ps` row it parses, so on a runner
 * whose pid space has reached a fixture pid, the host's real state answered instead of the double and
 * the case saw a lifetime nobody wrote.
 */
export function mockLinuxProcessStatAbsent(): void {
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
    if (String(path).startsWith('/proc/')) {
      throw Object.assign(new Error('proc is unavailable in the ps fixture'), { code: 'ENOENT' });
    }
    return readFileSync(path, options);
  });
}
