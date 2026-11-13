import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTest } from '@agent-device/test-kit';

test('test --maestro forwards Maestro backend and platform for directory suites', async () => {
  const tmpDir = await mkdtempForTest('agent-device-cli-maestro-suite-');
  await fs.writeFile(
    path.join(tmpDir, 'auth-flow.yml'),
    ['appId: demo.app', '---', '- launchApp', ''].join('\n'),
  );

  try {
    const result = await runCliCapture(
      ['test', '--maestro', '--platform', 'android', tmpDir],
      async () => ({
        ok: true,
        data: {
          total: 1,
          executed: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          notRun: 0,
          durationMs: 5,
          failures: [],
          tests: [],
        },
      }),
    );

    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]?.command, 'test');
    assert.deepEqual(result.calls[0]?.positionals, [tmpDir]);
    assert.equal(result.calls[0]?.flags?.replayBackend, 'maestro');
    assert.equal(result.calls[0]?.flags?.platform, 'android');
    assert.equal(result.calls[0]?.meta?.requestProgress, 'replay-test');
    assert.doesNotMatch(result.stderr, /Running replay suite\.\.\./);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
