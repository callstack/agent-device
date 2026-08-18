import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../src/utils/exec.ts';
import { TEST_RUN_TMP_PREFIX, TEST_RUN_TMP_ROOT } from './check-tmpdir-leaks-model.ts';

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

// INT32_MAX exceeds every platform's pid range (Linux pid_max caps at 2^22,
// macOS at 99999), so kill(pid, 0) is ESRCH by construction — an owner that
// is dead and can never be reused mid-test, unlike a freshly exited child's pid.
const NEVER_A_PID = 2_147_483_647;

test('global setup prunes a run directory abandoned by an earlier killed run and keeps a live one', async () => {
  const stamp = crypto.randomUUID();
  const abandoned = path.join(
    TEST_RUN_TMP_ROOT,
    `${TEST_RUN_TMP_PREFIX}${NEVER_A_PID}-planted-${stamp}`,
  );
  // Owned by this test process, which is alive for the whole nested run: the
  // same shape as a concurrent run in another worktree, and must survive.
  const live = path.join(
    TEST_RUN_TMP_ROOT,
    `${TEST_RUN_TMP_PREFIX}${process.pid}-planted-${stamp}`,
  );
  const probeName = `vitest-tmpdir-prune-probe-${process.pid}-${stamp}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'src', '__tests__', probeName);
  fs.mkdirSync(path.join(abandoned, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(abandoned, 'nested', 'leftover.txt'), 'from a killed run');
  fs.mkdirSync(live);
  fs.writeFileSync(
    probePath,
    `import { test } from 'vitest';

test('noop probe: the run itself is the subject', () => {});
`,
  );

  try {
    const result = await runCmd(
      path.join(REPOSITORY_ROOT, 'node_modules', '.bin', 'vitest'),
      ['run', '--project', 'unit-core', probePath],
      { cwd: REPOSITORY_ROOT, timeoutMs: 30_000 },
    );
    assert.equal(result.exitCode, 0, `probe run failed:\n${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(abandoned), false, 'setup must prune the abandoned run directory');
    assert.equal(fs.existsSync(live), true, 'setup must never touch a live owner’s run directory');
  } finally {
    fs.rmSync(abandoned, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
  }
});
