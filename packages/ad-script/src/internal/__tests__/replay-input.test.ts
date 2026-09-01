import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { parseReplayInput } from '../replay-input.ts';

test('parseReplayInput keeps .ad parsing generic for Maestro suites', () => {
  const parsed = parseReplayInput('open Demo\n', { replayBackend: 'maestro' });

  assert.deepEqual(
    parsed.actions.map((action) => action.command),
    ['open'],
  );
});

test('parseReplayInput rejects unknown replay backends', () => {
  assert.throws(
    () => parseReplayInput('open Demo\n', { replayBackend: 'unknown' }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Unsupported replay backend "unknown"/.test(error.message),
  );
});
