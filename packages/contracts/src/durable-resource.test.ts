import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isConfirmedCleanup } from './durable-resource.ts';

test('cleanup confirmation distinguishes terminal cleanup from retained evidence', () => {
  assert.equal(isConfirmedCleanup({ status: 'cleaned' }), true);
  assert.equal(
    isConfirmedCleanup({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
    false,
  );
});
