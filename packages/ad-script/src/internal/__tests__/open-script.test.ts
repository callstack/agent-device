import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { parseReplayOpenFlags } from '../open-script.ts';

test.each([
  { args: ['--surface'] },
  { args: ['--surface', 'unknown'] },
  { args: ['--surface', '--relaunch'] },
])('open replay refuses malformed surface arguments $args', ({ args }) => {
  assert.throws(
    () => parseReplayOpenFlags(args),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});
