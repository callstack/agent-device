import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../kernel/errors.ts';
import {
  createRequestCanceledError,
  isRequestCanceledError,
  resolveRequestTrackingId,
} from './cancel.ts';

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

test('isRequestCanceledError accepts structured and legacy cancellation errors', () => {
  assert.equal(isRequestCanceledError(createRequestCanceledError()), true);
  assert.equal(isRequestCanceledError(new AppError('COMMAND_FAILED', 'request canceled')), true);
  assert.equal(isRequestCanceledError(new AppError('COMMAND_FAILED', 'different message')), false);
});
