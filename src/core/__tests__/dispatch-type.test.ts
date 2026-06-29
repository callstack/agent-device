import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchCommand } from '../dispatch.ts';
import { AppError } from '../../kernel/errors.ts';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

test('dispatch type rejects ref-shaped first positional with a repair hint', async () => {
  await assert.rejects(
    () => dispatchCommand(ANDROID_EMULATOR, 'type', ['@ref42', 'sent', 'the', 'update']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /does not accept a target ref/i.test(error.message) &&
      /Use fill @ref42 "text".*press @ref42 then type "text"/i.test(error.details?.hint ?? ''),
  );
});
