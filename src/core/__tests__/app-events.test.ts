import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseTriggerAppEventArgs } from '../app-events.ts';
import { AppError } from '@agent-device/kernel/errors';

test('parseTriggerAppEventArgs validates event name format', () => {
  assert.throws(
    () => parseTriggerAppEventArgs(['bad event']),
    (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});
