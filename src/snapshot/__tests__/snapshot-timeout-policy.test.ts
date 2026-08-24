import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { isAndroidSnapshotTimeoutError } from '../snapshot-timeout-policy.ts';

function failure(details: Record<string, unknown> = {}) {
  return normalizeError(new AppError('COMMAND_FAILED', 'Android snapshot helper failed', details));
}

test('the typed reason published by the producer is what the policy recognizes', () => {
  assert.equal(
    isAndroidSnapshotTimeoutError(
      failure({ androidCaptureFailureReason: 'accessibility-timeout' }),
    ),
    true,
  );
});

/**
 * The prose is human-facing and may be reworded; it carries no decision. A failure that reads
 * exactly like a timeout but was never classified as one by its producer is not a timeout here.
 */
test('hint and helper prose alone are not timeout evidence', () => {
  const hintOnly = failure({
    hint: 'Android accessibility snapshots can be blocked by a foreground overlay.',
  });
  const helperProseOnly = failure({
    helper: { errorType: 'java.util.concurrent.TimeoutException', message: 'timed out' },
  });
  assert.equal(isAndroidSnapshotTimeoutError(hintOnly), false);
  assert.equal(isAndroidSnapshotTimeoutError(helperProseOnly), false);
});

test('an unclassified or differently classified failure is not a timeout', () => {
  assert.equal(isAndroidSnapshotTimeoutError(failure()), false);
  assert.equal(
    isAndroidSnapshotTimeoutError(failure({ androidCaptureFailureReason: 'something-else' })),
    false,
  );
  assert.equal(
    isAndroidSnapshotTimeoutError(
      failure({ androidSnapshotHelperFailureReason: 'system-window-only' }),
    ),
    false,
  );
});

test('the reason is read regardless of the error code its producer chose', () => {
  const unsupported = normalizeError(
    new AppError('UNSUPPORTED_OPERATION', 'helper unavailable', {
      androidCaptureFailureReason: 'accessibility-timeout',
    }),
  );
  assert.equal(isAndroidSnapshotTimeoutError(unsupported), true);
});
