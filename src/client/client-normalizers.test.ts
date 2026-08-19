import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeOpenForegroundComposition } from './client-normalizers.ts';

test('embedded daemon errors sanitize an untrusted cause before client exposure', () => {
  const secret = 'adc_live_remote-secret';
  const message =
    `request to https://user:pass@example.test/app?token=${secret} failed: bearer ${secret} ` +
    'x'.repeat(500);

  const result = normalizeOpenForegroundComposition({
    initialSnapshotError: {
      code: 'COMMAND_FAILED',
      message: 'capture failed',
      cause: { code: `token=${secret}`, message },
    },
  });

  const cause = result.initialSnapshotError?.cause;
  assert.ok(cause);
  assert.equal(JSON.stringify(cause).includes(secret), false);
  assert.match(cause.message, /REDACTED/);
  assert.ok(cause.message.length < message.length);
  assert.equal(cause.code, 'token=[REDACTED]');
});
