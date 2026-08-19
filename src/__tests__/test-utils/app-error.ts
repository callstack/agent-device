import assert from 'node:assert/strict';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

/**
 * What an {@link AppError} assertion may pin. `hint` is checked against the
 * hint a caller actually reads — `normalizeError`'s, not `details.hint` — so a
 * throw site that drops its hint and silently inherits `defaultHintForCode`
 * fails the assertion instead of passing on the default (ADR 0010: a hint is
 * required wherever the per-code default would mislead).
 */
type ExpectedAppError = { code: string; message?: RegExp; hint?: string | RegExp };

function assertAppError(error: unknown, expected: ExpectedAppError): true {
  assert.ok(
    error instanceof AppError,
    `expected AppError, got ${error?.constructor?.name ?? typeof error}: ${String(error)}`,
  );
  assert.equal(error.code, expected.code);
  if (expected.message) assert.match(error.message, expected.message);
  if (expected.hint !== undefined) {
    const { hint } = normalizeError(error);
    assert.ok(typeof hint === 'string', `expected a hint on ${error.code}, got ${String(hint)}`);
    if (typeof expected.hint === 'string') assert.equal(hint, expected.hint);
    else assert.match(hint, expected.hint);
  }
  return true;
}

/**
 * Asserts that `run` rejects with an {@link AppError} carrying `code` and,
 * when given, a message matching `message` and the exact `hint` a caller
 * reads. Replaces the hand-rolled
 * `assert.rejects(..., error instanceof AppError + code + match)` validator
 * repeated across platform tests.
 */
export async function assertRejectsAppError(
  run: () => Promise<unknown>,
  expected: ExpectedAppError,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => assertAppError(error, expected));
}

/**
 * Synchronous sibling of {@link assertRejectsAppError}: asserts that `fn`
 * throws an {@link AppError} carrying `code` and, when given, a message
 * matching `message` and the exact `hint`.
 */
export function assertThrowsAppError(fn: () => unknown, expected: ExpectedAppError): void {
  assert.throws(fn, (error: unknown) => assertAppError(error, expected));
}
