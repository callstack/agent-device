import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { normalizeDevice, normalizeOpenForegroundComposition } from './client-normalizers.ts';

test('embedded daemon errors sanitize an untrusted cause before client exposure', () => {
  const secret = 'adc_live_remote-secret';
  const oversizedCode = `token=${secret} ${'c'.repeat(500)}`;
  const message =
    `request to https://user:pass@example.test/app?token=${secret} failed: bearer ${secret} ` +
    'x'.repeat(500);

  const result = normalizeOpenForegroundComposition({
    initialSnapshotError: {
      code: 'COMMAND_FAILED',
      message: 'capture failed',
      cause: { code: oversizedCode, message },
    },
  });

  const cause = result.initialSnapshotError?.cause;
  assert.ok(cause);
  assert.equal(JSON.stringify(cause).includes(secret), false);
  assert.match(cause.message, /REDACTED/);
  assert.equal(cause.message.length, 400);
  assert.match(cause.message, /<truncated>$/);
  assert.match(cause.code ?? '', /^token=\[REDACTED\]/);
  assert.equal(cause.code?.length, 400);
  assert.match(cause.code ?? '', /<truncated>$/);
});

test('device normalization preserves the projected claim owner and drops malformed ones', () => {
  const base = {
    platform: 'ios',
    target: 'mobile',
    kind: 'simulator',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    booted: true,
  };
  const claimed = normalizeDevice({
    ...base,
    claimedBy: { session: 'qa', workspace: '/worktrees/qa' },
  });
  expect(claimed.claimedBy).toEqual({ session: 'qa', workspace: '/worktrees/qa' });

  expect(normalizeDevice(base).claimedBy).toBeUndefined();
  expect(normalizeDevice({ ...base, claimedBy: { session: 42 } }).claimedBy).toBeUndefined();
});
