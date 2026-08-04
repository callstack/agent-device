// Ratchet on raw fs.mkdtemp/mkdtempSync call sites in test files: cleanup no
// longer depends on them (scripts/vitest-tmpdir-global-setup.ts sweeps
// everything regardless of call site), but src/__tests__/test-utils/tmp-dir.ts
// is the documented, discoverable way to get a scratch dir, so new test code
// should use it instead of reinventing fs.mkdtemp(path.join(os.tmpdir(), ...)).
// The count may only shrink from BASELINE as call sites migrate.

import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from './lib/walk-files.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const HELPER_FILE = path.join(repoRoot, 'src/__tests__/test-utils/tmp-dir.ts');
const MKDTEMP_CALL = /\bmkdtemp(?:Sync)?\(/g;
const BASELINE = 632;

const testFiles = walkFiles(path.join(repoRoot, 'src'), (file) => {
  if (file === HELPER_FILE) return false;
  return file.endsWith('.test.ts') || file.includes(`${path.sep}__tests__${path.sep}`);
});

const { count, sites } = testFiles.reduce(
  (acc, file) => {
    const content = fs.readFileSync(file, 'utf8');
    const matches = content.match(MKDTEMP_CALL) ?? [];
    if (matches.length > 0) acc.sites.push(`${path.relative(repoRoot, file)}: ${matches.length}`);
    acc.count += matches.length;
    return acc;
  },
  { count: 0, sites: [] as string[] },
);

if (count > BASELINE) {
  throw new Error(
    `Found ${count} raw fs.mkdtemp/mkdtempSync call sites in test files, up from the recorded ${BASELINE}.\n` +
      `Use mkdtempForTest / mkdtempForTestSync from src/__tests__/test-utils/tmp-dir.ts for new scratch dirs instead.\n` +
      sites.join('\n'),
  );
}

process.stdout.write(
  `${count} raw fs.mkdtemp/mkdtempSync call sites in test files (baseline ${BASELINE}, only shrinks).\n`,
);
