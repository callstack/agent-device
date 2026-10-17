import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError, discloseDispatch, discloseUnclassifiedDispatch } from './errors.ts';

test('a producer verdict overwrites; the seam verdict fills only an unclassified failure', () => {
  const error = new AppError('COMMAND_FAILED', 'tap failed', { hint: 'retry' });
  assert.equal(discloseUnclassifiedDispatch(error, 'unknown'), error);
  assert.equal(error.details?.dispatched, 'unknown');
  assert.equal(discloseDispatch(error, 'no', { dispatchedSteps: 2 }), error);
  assert.deepEqual(error.details, { hint: 'retry', dispatchedSteps: 2, dispatched: 'no' });
  discloseUnclassifiedDispatch(error, 'unknown');
  assert.equal(error.details?.dispatched, 'no');
});
