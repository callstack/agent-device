// Fails if any `agent-device-test-run-<pid>` directory remains in the real
// system tmpdir after the unit suite finishes. Each worker removes its own
// directory in its vitest afterAll hook (src/__tests__/tmp-dir-setup.ts); a
// leftover one means a worker was killed (crash, OOM, timeout) before that
// hook ran. Run this after `pnpm test:unit`, not concurrently with it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = os.tmpdir();
const leaks = fs
  .readdirSync(tmpRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^agent-device-test-run-\d+$/.test(entry.name));

if (leaks.length > 0) {
  const details = leaks.map((entry) => `- ${path.join(tmpRoot, entry.name)}`).join('\n');
  throw new Error(
    `Found ${leaks.length} leftover agent-device-test-run-* director${leaks.length === 1 ? 'y' : 'ies'} in ${tmpRoot}:\n${details}\n` +
      'A unit-test worker was killed before its cleanup hook ran; investigate the run that produced them.',
  );
}

process.stdout.write(`No leaked agent-device-test-run-* directories found in ${tmpRoot}.\n`);
