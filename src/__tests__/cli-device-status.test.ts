import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runCliCapture } from './cli-capture.ts';

test('device status is daemonless and does not send a daemon request', async () => {
  const result = await runCliCapture(['device', 'status', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 0);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, { success: true, data: { claims: [] } });
});
