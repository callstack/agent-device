import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { printHumanError } from '../output.ts';

test('printHumanError renders a structured cause unconditionally', () => {
  const err = new AppError(
    'COMMAND_FAILED',
    'The daemon failed to fetch the app source',
    undefined,
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    }),
  );

  const output = captureStderr(() => printHumanError(err));

  assert.match(output, /Cause: ECONNREFUSED connect ECONNREFUSED 10\.0\.0\.1:443/);
});

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let output = '';
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
    chunk: unknown,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return output;
}
