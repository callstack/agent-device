import assert from 'node:assert/strict';
import { test } from 'vitest';
import { getAndroidKeyboardStatusWithAdb } from '../device-input-state.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import { AppError } from '../../../kernel/errors.ts';

test('getAndroidKeyboardStatusWithAdb exposes active input method package', async () => {
  const adb: AndroidAdbExecutor = async (args) => {
    assert.deepEqual(args, ['shell', 'dumpsys', 'input_method']);
    return {
      stdout:
        'mInputShown=true mCurMethodId=com.google.android.inputmethod.latin/.LatinIME inputType=0x1',
      stderr: '',
      exitCode: 0,
    };
  };

  await assert.doesNotReject(async () => {
    const state = await getAndroidKeyboardStatusWithAdb(adb);
    assert.deepEqual(state, {
      visible: true,
      inputType: '0x1',
      type: 'text',
      inputMethodPackage: 'com.google.android.inputmethod.latin',
      focusedPackage: undefined,
      focusedResourceId: undefined,
      inputOwner: 'unknown',
    });
  });
});

test('getAndroidKeyboardStatusWithAdb classifies tolerated adb failures with actionable hints', async () => {
  // allowFailure regression: the executor returns the nonzero result instead of
  // throwing, so the classified hint must come from the result-to-error path.
  const adb: AndroidAdbExecutor = async () => ({
    stdout: '',
    stderr: 'error: device offline',
    exitCode: 1,
  });

  const error = await getAndroidKeyboardStatusWithAdb(adb).then(
    () => assert.fail('expected the keyboard query to reject'),
    (err: unknown) => err,
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /adb reconnect/i);
});
