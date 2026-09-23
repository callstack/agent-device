import assert from 'node:assert/strict';
import { test } from 'vitest';
import { honoredScrollSwipeMidpoint, resolveScrollExecutionOptions } from './scroll-command.ts';

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

/**
 * The swipe midpoint is what lets a scroll ask whether its own gesture landed inside the container it
 * blamed for a no-op, so the pair that pins it is a leaf that reported coordinates and one that did
 * not: a tvOS scroll is a remote keypress, and guessing a midpoint there would invent evidence.
 */
test('honoredScrollSwipeMidpoint reports the middle of a swipe the leaf ran', () => {
  assert.deepEqual(honoredScrollSwipeMidpoint({ x1: 201, y1: 665, x2: 201, y2: 209 }), {
    x: 201,
    y: 437,
  });
});

test('honoredScrollSwipeMidpoint declines to guess where the owner reported no gesture', () => {
  assert.equal(honoredScrollSwipeMidpoint({ button: 'down' }), undefined);
  assert.equal(honoredScrollSwipeMidpoint({ x1: 201, y1: 665, x2: 201 }), undefined);
  assert.equal(honoredScrollSwipeMidpoint({ x1: 201, y1: 665, x2: 201, y2: 'none' }), undefined);
});
