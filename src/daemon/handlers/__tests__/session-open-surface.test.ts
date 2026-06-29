import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { resolveRequestedOpenSurface } from '../session-open-surface.ts';

test('resolveRequestedOpenSurface rejects surface flag on iOS', () => {
  assert.throws(
    () =>
      resolveRequestedOpenSurface({
        device: {
          platform: 'ios',
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
