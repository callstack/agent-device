import { test } from 'vitest';
import { readIosClipboardText } from '../app-device-io.ts';
import { assertRejectsAppError } from '../../__tests__/app-error.ts';
import { IOS_TEST_DEVICE } from './apple-core-stub-helpers.ts';

test('readIosClipboardText rejects physical devices', async () => {
  await assertRejectsAppError(() => readIosClipboardText(IOS_TEST_DEVICE), {
    code: 'UNSUPPORTED_OPERATION',
  });
});
