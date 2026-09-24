import assert from 'node:assert/strict';
import { AppError, defaultHintForCode, normalizeError } from '@agent-device/kernel/errors';

type ExpectedAppError = {
  code: string;
  message?: RegExp;
  /** Checked against `normalizeError(error).message`, e.g. the stderr excerpt a command failure appends. */
  normalizedMessage?: RegExp;
  /** `null` asserts the failure attached no hint of its own, so normalization falls back to the code default. */
  hint?: string | RegExp | null;
};

function assertAppError(error: unknown, expected: ExpectedAppError): true {
  assert.ok(
    error instanceof AppError,
    `expected AppError, got ${error?.constructor?.name ?? typeof error}: ${String(error)}`,
  );
  assert.equal(error.code, expected.code);
  if (expected.message) assert.match(error.message, expected.message);
  if (expected.normalizedMessage) {
    assert.match(normalizeError(error).message, expected.normalizedMessage);
  }
  if (expected.hint === null) {
    assert.equal(normalizeError(error).hint, defaultHintForCode(error.code));
  } else if (expected.hint !== undefined) {
    const { hint } = normalizeError(error);
    assert.ok(typeof hint === 'string', `expected a hint on ${error.code}, got ${String(hint)}`);
    if (typeof expected.hint === 'string') assert.equal(hint, expected.hint);
    else assert.match(hint, expected.hint);
  }
  return true;
}

export async function assertRejectsAppError(
  run: () => Promise<unknown>,
  expected: ExpectedAppError,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => assertAppError(error, expected));
}

export function assertThrowsAppError(fn: () => unknown, expected: ExpectedAppError): void {
  assert.throws(fn, (error: unknown) => assertAppError(error, expected));
}
