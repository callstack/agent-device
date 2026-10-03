import assert from 'node:assert/strict';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

type ExpectedAppError = {
  code: string;
  message?: RegExp;
  hint?: string | RegExp;
  /** The machine-readable `details.reason` the refusal must carry; key behavior on this, not on `message`. */
  reason?: string;
  /** The `details.dispatched` disclosure the producer must have proven. */
  dispatched?: 'no' | 'unknown';
};

function assertAppError(error: unknown, expected: ExpectedAppError): true {
  assert.ok(
    error instanceof AppError,
    `expected AppError, got ${error?.constructor?.name ?? typeof error}: ${String(error)}`,
  );
  assert.equal(error.code, expected.code);
  if (expected.message) assert.match(error.message, expected.message);
  if (expected.reason !== undefined) {
    assert.equal(
      error.details?.reason,
      expected.reason,
      `expected details.reason ${expected.reason}, got ${JSON.stringify(error.details)}`,
    );
  }
  if (expected.dispatched !== undefined) {
    assert.equal(error.details?.dispatched, expected.dispatched);
  }
  if (expected.hint !== undefined) {
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
