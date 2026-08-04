// Fails if any agent-device-test-run-* directory remains under
// TEST_RUN_TMP_ROOT after the unit suite finishes. scripts/vitest-tmpdir-global-setup.ts
// creates exactly one such directory per `vitest run` invocation and removes
// it in its globalTeardown; a leftover one means that invocation's process
// was killed (crash, OOM, timeout) before teardown could run. Run this after
// `pnpm test:unit`, not concurrently with it.
//
// Only covers vitest runs. node --test lanes (test:smoke,
// test:integration:node, ...) still use the real os.tmpdir() unredirected.

import fs from 'node:fs';
import path from 'node:path';
import { TEST_RUN_TMP_PREFIX, TEST_RUN_TMP_ROOT } from './vitest-tmpdir-global-setup.ts';

const leaks = fs
  .readdirSync(TEST_RUN_TMP_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEST_RUN_TMP_PREFIX));

if (leaks.length > 0) {
  const details = leaks.map((entry) => `- ${path.join(TEST_RUN_TMP_ROOT, entry.name)}`).join('\n');
  throw new Error(
    `Found ${leaks.length} leftover ${TEST_RUN_TMP_PREFIX}* director${leaks.length === 1 ? 'y' : 'ies'} in ${TEST_RUN_TMP_ROOT}:\n${details}\n` +
      'A vitest run was killed before its globalTeardown could run; investigate the run that produced them.',
  );
}

process.stdout.write(
  `No leaked ${TEST_RUN_TMP_PREFIX}* directories found in ${TEST_RUN_TMP_ROOT}.\n`,
);
