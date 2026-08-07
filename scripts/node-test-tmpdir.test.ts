import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../src/utils/exec.ts';
import { TEST_RUN_TMP_PREFIX, TEST_RUN_TMP_ROOT } from './vitest-tmpdir-global-setup.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(REPOSITORY_ROOT, 'scripts', 'node-test-tmpdir.ts');

// Date.now() alone collides when this file's top-level tests happen to start
// within the same millisecond (observed in practice), which overwrites one
// probe's source with another's; the random suffix makes each probe path
// unique regardless of scheduling.
function writeProbe(evidencePath: string): string {
  const probeName = `node-test-tmpdir-probe-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('probe records its inherited TMPDIR', () => {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, os.tmpdir());
});
`,
  );
  return probePath;
}

test('the wrapper redirects a node --test child TMPDIR and removes it after the run', async () => {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-lifecycle-test-'));
  const evidencePath = path.join(evidenceRoot, 'child-tmpdir.txt');
  const probePath = writeProbe(evidencePath);
  let childTmpDir: string | undefined;

  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      { cwd: REPOSITORY_ROOT, timeoutMs: 30_000 },
    );
    assert.equal(result.exitCode, 0, `probe run failed:\n${result.stdout}\n${result.stderr}`);

    childTmpDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(path.dirname(childTmpDir), TEST_RUN_TMP_ROOT);
    assert.match(path.basename(childTmpDir), new RegExp(`^${TEST_RUN_TMP_PREFIX}\\d+-`));
    assert.equal(
      fs.existsSync(childTmpDir),
      false,
      'the wrapper must remove the run directory after the child exits',
    );
  } finally {
    if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('the wrapper still cleans up and forwards a nonzero exit code when the child fails', async () => {
  // Diffing the whole shared TEST_RUN_TMP_ROOT listing is racy here: this
  // file itself runs as one of several node --test files/workers sharing
  // that root (e.g. alongside vitest-tmpdir-global-setup.test.ts in
  // check:tmpdir-leaks:test), any of which can create and remove their own
  // sibling run directory mid-diff. Recording the probe's actual TMPDIR (the
  // same technique as the test above) and checking only that one path avoids
  // the shared-directory race entirely.
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-lifecycle-fail-'));
  const evidencePath = path.join(evidenceRoot, 'child-tmpdir.txt');
  const probeName = `node-test-tmpdir-probe-fail-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';

test('deliberately failing probe', () => {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, os.tmpdir());
  assert.fail('intentional failure to verify exit-code forwarding');
});
`,
  );

  let childTmpDir: string | undefined;
  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      { cwd: REPOSITORY_ROOT, timeoutMs: 30_000, allowFailure: true },
    );
    assert.notEqual(result.exitCode, 0, 'a failing child must propagate a nonzero exit code');

    childTmpDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(path.dirname(childTmpDir), TEST_RUN_TMP_ROOT);
    assert.match(path.basename(childTmpDir), new RegExp(`^${TEST_RUN_TMP_PREFIX}\\d+-`));
    assert.equal(fs.existsSync(childTmpDir), false, `wrapper left behind: ${childTmpDir}`);
  } finally {
    if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
