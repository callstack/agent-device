import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchCommand } from '../dispatch.ts';
import { AppError } from '../../kernel/errors.ts';
import { MACOS_DEVICE, TVOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

test('dispatch pinch rejects helper-backed macOS surfaces', async () => {
  await assert.rejects(
    () => dispatchCommand(MACOS_DEVICE, 'pinch', ['1.5'], undefined, { surface: 'desktop' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /macOS app sessions/i.test(error.message),
  );
});

test('dispatch pinch rejects tvOS before runner call', async () => {
  await assert.rejects(
    () => dispatchCommand(TVOS_SIMULATOR, 'pinch', ['1.5']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /pinch is not supported on tvOS/i.test(error.message),
  );
});
