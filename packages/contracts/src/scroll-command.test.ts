import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveScrollExecutionOptions } from './scroll-command.ts';

test('resolveScrollExecutionOptions keeps ordinary scrolls controlled', () => {
  assert.deepEqual(resolveScrollExecutionOptions({ amount: 0.5 }), {
    amount: 0.5,
    releaseBehavior: 'controlled',
  });
});

test('resolveScrollExecutionOptions marks edge scrolls inertial without changing platform timing', () => {
  assert.deepEqual(resolveScrollExecutionOptions({}, 'bottom'), {
    releaseBehavior: 'inertial',
  });
  assert.deepEqual(resolveScrollExecutionOptions({ durationMs: 80 }, 'top'), {
    durationMs: 80,
    releaseBehavior: 'inertial',
  });
});
