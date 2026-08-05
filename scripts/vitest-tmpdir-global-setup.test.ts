import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../src/utils/exec.ts';
import { TEST_RUN_TMP_PREFIX, TEST_RUN_TMP_ROOT } from './vitest-tmpdir-global-setup.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the configured Vitest lifecycle redirects worker TMPDIR and removes it after the run', async () => {
  const probeName = `vitest-tmpdir-probe-${process.pid}-${Date.now()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'src', '__tests__', probeName);
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-tmpdir-lifecycle-test-'));
  const evidencePath = path.join(evidenceRoot, 'worker-tmpdir.txt');
  const expectedSwiftCacheDir = path.join(os.tmpdir(), 'agent-device-swift-cache');
  let workerTmpDir: string | undefined;

  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

test('worker inherits the run-owned temp directory', () => {
  const tmpdir = os.tmpdir();
  expect(path.dirname(tmpdir)).toBe(${JSON.stringify(TEST_RUN_TMP_ROOT)});
  expect(path.basename(tmpdir)).toMatch(new RegExp(${JSON.stringify(
    `^${TEST_RUN_TMP_PREFIX}\\d+-`,
  )}));
  expect(process.env.AGENT_DEVICE_SWIFT_CACHE_DIR).toBe(${JSON.stringify(expectedSwiftCacheDir)});
  expect(process.env.AGENT_DEVICE_SWIFT_CACHE_DIR?.startsWith(tmpdir)).toBe(false);
  fs.writeFileSync(process.env.AGENT_DEVICE_TEST_TMPDIR_EVIDENCE_PATH!, tmpdir);
});
`,
  );

  try {
    await runCmd(
      path.join(REPOSITORY_ROOT, 'node_modules', '.bin', 'vitest'),
      ['run', '--project', 'unit-core', probePath],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          AGENT_DEVICE_SWIFT_CACHE_DIR: '',
          AGENT_DEVICE_TEST_TMPDIR_EVIDENCE_PATH: evidencePath,
        },
        timeoutMs: 30_000,
      },
    );

    workerTmpDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(path.dirname(workerTmpDir), TEST_RUN_TMP_ROOT);
    assert.match(path.basename(workerTmpDir), new RegExp(`^${TEST_RUN_TMP_PREFIX}\\d+-`));
    assert.equal(
      fs.existsSync(workerTmpDir),
      false,
      'global teardown must remove the run directory',
    );
  } finally {
    if (workerTmpDir) fs.rmSync(workerTmpDir, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
