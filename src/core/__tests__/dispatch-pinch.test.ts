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

// tvOS is focus-only: coordinate multi-touch gestures have no meaning off the focused
// element, so rotate/transform reject up front (mirroring pinch above). This pins the
// UNSUPPORTED coordinate-gesture half of the tvOS interaction contract.
test('dispatch rotate-gesture rejects tvOS before runner call', async () => {
  await assert.rejects(
    () => dispatchCommand(TVOS_SIMULATOR, 'rotate-gesture', ['90']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /rotate is not supported on tvOS/i.test(error.message),
  );
});

test('dispatch transform-gesture rejects tvOS before runner call', async () => {
  await assert.rejects(
    () => dispatchCommand(TVOS_SIMULATOR, 'transform-gesture', ['1', '2', '3', '4', '1.5', '90']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /transform is not supported on tvOS/i.test(error.message),
  );
});
