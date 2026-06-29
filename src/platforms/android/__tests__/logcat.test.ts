import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { streamAndroidLogcatWithAdb } from '../logcat.ts';

test('streamAndroidLogcatWithAdb reports unsupported providers without spawn', () => {
  assert.throws(
    () => streamAndroidLogcatWithAdb({}),
    (error) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.message === 'Android ADB provider does not support streams',
  );
});
