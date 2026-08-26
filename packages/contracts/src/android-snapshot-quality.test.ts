import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ANDROID_CONTENT_RECOVERY_REASONS,
  isAndroidContentRecoveryReason,
  isUnreadableCaptureContentError,
} from './android-snapshot-quality.ts';

test('Android content-recovery reasons are a single guarded taxonomy', () => {
  assert.deepEqual(ANDROID_CONTENT_RECOVERY_REASONS, [
    'empty-helper-output',
    'system-window-only',
    'content-poor-app-window',
  ]);
  for (const reason of ANDROID_CONTENT_RECOVERY_REASONS) {
    assert.equal(isAndroidContentRecoveryReason(reason), true);
    assert.equal(
      isUnreadableCaptureContentError({ details: { androidSnapshotHelperFailureReason: reason } }),
      true,
    );
  }
  assert.equal(isAndroidContentRecoveryReason('helper-timeout'), false);
  assert.equal(
    isUnreadableCaptureContentError({
      details: { androidSnapshotHelperFailureReason: 'helper-timeout' },
    }),
    false,
  );
});
