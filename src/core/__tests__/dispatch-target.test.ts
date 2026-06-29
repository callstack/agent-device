import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTargetDevice } from '../dispatch.ts';
import { AppError } from '../../kernel/errors.ts';

test('resolveTargetDevice requires platform when target selector is provided', async () => {
  await assert.rejects(
    () => resolveTargetDevice({ target: 'tv' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('requires --platform'),
  );
});
