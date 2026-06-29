import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseTriggerAppEventArgs } from '../app-events.ts';
import { AppError } from '../../kernel/errors.ts';

test('parseTriggerAppEventArgs validates event name format', () => {
  assert.throws(
    () => parseTriggerAppEventArgs(['bad event']),
    (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});
