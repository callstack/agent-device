import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ANDROID_CONTENT_RECOVERY_REASONS } from '@agent-device/contracts/android-snapshot-quality';
import { throwDaemonError } from '@agent-device/kernel/errors';
import { splitRefGenerationSuffix } from '@agent-device/kernel/snapshot';
import {
  AppError,
  formatPinnedRef,
  isUnreadableCaptureContentError,
  normalizeAgentDeviceError,
} from './index.ts';

// Public-entry contract, through `./index.ts`: a client polling with `snapshot` classifies the
// error it caught after the daemon wire round trip, not the producer's in-process error.

test('the public SDK formats capture refs for the installed live-ref grammar', () => {
  const pinned = formatPinnedRef('@e4', 7);
  assert.equal(pinned, '@e4-s7');
  assert.deepEqual(splitRefGenerationSuffix(pinned), { base: '@e4', generation: 7 });
  assert.equal(formatPinnedRef('e4', 7), '@e4-s7');
});

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
