import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { resolveRepoRoot } from './host.ts';

test('CLI refuses an unmarked existing root before any descendant can be cleared', async () => {
  const repoRoot = resolveRepoRoot();
  const stateDir = await mkdtempForTest('agent-device-ios-benchmark-cli-');
  const derivedPath = path.join(stateDir, 'derived-data', 'cell');
  const sentinel = path.join(derivedPath, 'must-survive');
  fs.mkdirSync(derivedPath, { recursive: true });
  fs.writeFileSync(sentinel, 'keep');

  let exitCode = 0;
  let stderr = '';
  try {
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(repoRoot, 'scripts/ios-snapshot-benchmark/run.ts'),
        '--udid',
        'unavailable-simulator',
        '--state-dir',
        stateDir,
        '--derived-path',
        derivedPath,
        '--skip-package-size',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 60_000,
      },
    );
  } catch (error) {
    const failure = error as { status?: unknown; stderr?: unknown };
    exitCode = typeof failure.status === 'number' ? failure.status : -1;
    stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString('utf8')
      : typeof failure.stderr === 'string'
        ? failure.stderr
        : '';
  }

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /benchmark-owned/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});
