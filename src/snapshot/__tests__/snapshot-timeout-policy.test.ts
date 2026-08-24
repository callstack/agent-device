import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeError, AppError } from '@agent-device/kernel/errors';
import { isAndroidSnapshotTimeoutError } from '../snapshot-timeout-policy.ts';

function commandFailure(message: string, details: Record<string, unknown> = {}) {
  return normalizeError(new AppError('COMMAND_FAILED', message, details));
}

test('the daemon hint alone is enough when the helper never answered', () => {
  const error = commandFailure('uiautomator dump failed', {
    hint: 'Android accessibility snapshots can be blocked by a foreground overlay.',
  });
  assert.equal(isAndroidSnapshotTimeoutError(error), true);
});

test('a typed helper TimeoutException is enough without the hint text', () => {
  const error = commandFailure('helper reported a failure', {
    helper: { errorType: 'android.os.TimeoutException' },
  });
  assert.equal(isAndroidSnapshotTimeoutError(error), true);
});

test('a helper message that merely timed out counts, on either side of the seam', () => {
  const error = commandFailure('helper reported a failure', {
    helper: { message: 'snapshot timed out after 10000ms' },
  });
  assert.equal(isAndroidSnapshotTimeoutError(error), true);
});

test('an unrelated command failure is not timeout evidence', () => {
  assert.equal(isAndroidSnapshotTimeoutError(commandFailure('device offline')), false);
  assert.equal(
    isAndroidSnapshotTimeoutError(
      commandFailure('helper reported a failure', {
        helper: { errorType: 'java.lang.IllegalStateException' },
      }),
    ),
    false,
  );
});

test('only COMMAND_FAILED can carry the timeout shape', () => {
  const error = normalizeError(
    new AppError('UNSUPPORTED_OPERATION', 'Android accessibility snapshots can be blocked'),
  );
  assert.equal(isAndroidSnapshotTimeoutError(error), false);
});
