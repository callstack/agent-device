import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
} from './request-cancel.ts';

test('resolveRequestTrackingId generates unique ids for fallback seeds', () => {
  const first = resolveRequestTrackingId(undefined, 42);
  const second = resolveRequestTrackingId(undefined, 42);
  assert.match(first, /^req:42:/);
  assert.match(second, /^req:42:/);
  assert.notEqual(first, second);
});

test('createRequestCanceledError includes stable cancellation reason marker', () => {
  const err = createRequestCanceledError();
  assert.equal(err.code, 'COMMAND_FAILED');
  assert.equal(err.message, 'request canceled');
  assert.equal(err.details?.reason, 'request_canceled');
  assert.match(String(err.details?.hint), /canceled intentionally/);
});

// The factory is the ONE way to build a canceled error (#1774 consolidated the
// hand-rolled copies): callers may add evidence or a sharper hint, but cannot
// build one the predicate misses, and the cause survives for diagnostics.
test('createRequestCanceledError carries caller evidence but never loses its reason', () => {
  const cause = new Error('socket closed');
  const err = createRequestCanceledError(
    { releasedSessionId: 'wd-1', hint: 'released it', reason: 'something_else' },
    cause,
  );
  assert.equal(err.details?.reason, 'request_canceled');
  assert.equal(err.details?.releasedSessionId, 'wd-1');
  assert.equal(err.details?.hint, 'released it');
  assert.equal(err.cause, cause);
  assert.equal(isRequestCanceledError(err), true);
  assert.equal(isRequestCanceledError(new AppError('UNKNOWN', 'request canceled')), false);
});

test('isRequestCanceledError accepts structured and legacy cancellation errors', () => {
  assert.equal(isRequestCanceledError(createRequestCanceledError()), true);
  assert.equal(isRequestCanceledError(new AppError('COMMAND_FAILED', 'request canceled')), true);
  assert.equal(isRequestCanceledError(new AppError('COMMAND_FAILED', 'different message')), false);
});

// A canceled request's signal carries the typed error as its reason, so every
// `signal.throwIfAborted()`, aborted fetch, and `throw signal.reason` downstream
// reports a canceled request rather than a bare DOMException that normalizes to
// UNKNOWN — without each site having to know the factory exists.
test('a canceled request aborts its signal with the typed canceled error', () => {
  const registration = registerRequestAbort('req-typed-abort');
  try {
    markRequestCanceled('req-typed-abort');
    const signal = registration!.controller.signal;
    assert.equal(signal.aborted, true);
    assert.equal(isRequestCanceledError(signal.reason), true);
    assert.throws(
      () => signal.throwIfAborted(),
      (error: unknown) => isRequestCanceledError(error),
    );
  } finally {
    clearRequestAbortRegistration(registration);
  }
});
