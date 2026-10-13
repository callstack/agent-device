import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { resolveRequestedOpenSurface } from '../../../platform-runtime-open-target.ts';

test('resolveRequestedOpenSurface rejects surface flag on iOS', () => {
  assert.throws(
    () =>
      resolveRequestedOpenSurface({
        device: {
          platform: 'apple',
          id: 'sim-1',
          name: 'iPhone 17',
          kind: 'simulator',
        },
        surfaceFlag: 'desktop',
        openTarget: undefined,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /surface is only supported on macOS/i.test(error.message),
  );
});
