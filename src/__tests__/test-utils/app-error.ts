import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';

/**
 * Asserts that `run` rejects with an {@link AppError} carrying `code` and,
 * when given, a message matching `message`. Replaces the hand-rolled
 * `assert.rejects(..., error instanceof AppError + code + match)` validator
 * repeated across platform tests.
 */
export async function assertRejectsAppError(
  run: () => Promise<unknown>,
  expected: { code: string; message?: RegExp },
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(
      error instanceof AppError,
      `expected AppError, got ${error?.constructor?.name ?? typeof error}: ${String(error)}`,
    );
    assert.equal(error.code, expected.code);
    if (expected.message) assert.match(error.message, expected.message);
    return true;
  });
}
