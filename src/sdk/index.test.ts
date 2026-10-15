import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ANDROID_CONTENT_RECOVERY_REASONS } from '@agent-device/contracts/android-snapshot-quality';
import { throwDaemonError } from '@agent-device/kernel/errors';
import { AppError, isUnreadableCaptureContentError, normalizeAgentDeviceError } from './index.ts';

// Public-entry contract, through `./index.ts`: a client polling with `snapshot` classifies the
// error it caught after the daemon wire round trip, not the producer's in-process error.

function caughtAfterWire(thrown: AppError): unknown {
  try {
    throwDaemonError(normalizeAgentDeviceError(thrown));
  } catch (error) {
    return error;
  }
  return assert.fail('throwDaemonError returned');
}

test('an Android content verdict stays unreadable across the daemon wire', () => {
  for (const reason of ANDROID_CONTENT_RECOVERY_REASONS) {
    const verdict = new AppError('COMMAND_FAILED', 'insufficient app content', {
      androidSnapshotHelperFailureReason: reason,
      retriable: true,
    });

    assert.equal(isUnreadableCaptureContentError(caughtAfterWire(verdict)), true, reason);
  }
});

test('a retriable mechanism failure is not an unreadable capture', () => {
  const adbDrop = new AppError('COMMAND_FAILED', 'adb connection dropped', {
    reason: 'connection_dropped',
    retriable: true,
  });

  assert.equal(isUnreadableCaptureContentError(caughtAfterWire(adbDrop)), false);
});
