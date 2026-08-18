// Fails if any agent-device-test-run-* directory under TEST_RUN_TMP_ROOT is
// abandoned — its owning process has exited without running its cleanup
// (crash, OOM, timeout kill) AND no live process still holds it as TMPDIR.
// Directories owned by a still-running process are left alone: a concurrent
// `vitest run` (or node --test lane, wrapped by scripts/node-test-tmpdir.ts) in
// another worktree keeps its own directory present until its own teardown,
// which is not a leak; so are the orphaned children of a killed run, until the
// last of them exits. See check-tmpdir-leaks-model.ts for the liveness model.
//
// Covers both redirection mechanisms sharing this root/prefix: Vitest's
// globalSetup/globalTeardown (scripts/vitest-tmpdir-global-setup.ts) and the
// node --test wrapper (scripts/node-test-tmpdir.ts, #1595) that every
// `node --test` package.json script now runs through. Both prune what an
// earlier killed run left behind before creating their own directory, so a
// failure here names the run that just finished — never a historical one.

import path from 'node:path';
import { TEST_RUN_TMP_ROOT, findLeakedRunDirectories } from './check-tmpdir-leaks-model.ts';

const leaks = findLeakedRunDirectories(TEST_RUN_TMP_ROOT);

if (leaks.length > 0) {
  const details = leaks.map((name) => `- ${path.join(TEST_RUN_TMP_ROOT, name)}`).join('\n');
  throw new Error(
    `Found ${leaks.length} abandoned agent-device-test-run-* director${leaks.length === 1 ? 'y' : 'ies'} in ${TEST_RUN_TMP_ROOT}:\n${details}\n` +
      'Their owning process has already exited, so their globalTeardown never ran (crash, OOM, timeout kill); investigate the run that produced them.',
  );
}

process.stdout.write(
  `No abandoned agent-device-test-run-* directories found in ${TEST_RUN_TMP_ROOT}.\n`,
);
