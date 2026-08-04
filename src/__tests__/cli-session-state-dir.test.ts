import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

test('session state-dir prints the resolved source-checkout daemon state dir without daemon startup', async () => {
  const root = mkdtempForTestSync('agent-device-session-state-dir-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const result = await runCliCapture(['session', 'state-dir', '--json'], {
      env: { HOME: home },
    });

    assert.equal(result.code, null);
    assert.equal(result.calls.length, 0);
    const payload = JSON.parse(result.stdout) as { success: boolean; data: { stateDir: string } };
    assert.equal(payload.success, true);
    assert.match(payload.data.stateDir, /\/\.agent-device\/dev\//);
    assert.equal(payload.data.stateDir.startsWith(home), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session state-dir respects explicit state dir overrides', async () => {
  const root = mkdtempForTestSync('agent-device-session-state-dir-');
  try {
    const result = await runCliCapture(['session', 'state-dir', '--state-dir', './custom-state'], {
      cwd: root,
    });

    assert.equal(result.code, null);
    assert.equal(result.calls.length, 0);
    assert.equal(result.stdout.trim(), path.join(fs.realpathSync.native(root), 'custom-state'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
