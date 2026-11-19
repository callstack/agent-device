import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { assertScrollRefreshCompatible, resolveScrollExecutionOptions } from './scroll-command.ts';
import { decodeScrollDirectionResult } from './scroll-runtime.ts';

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
test('decodeScrollDirectionResult reports the middle of a swipe the leaf ran', () => {
  assert.deepEqual(decodeScrollDirectionResult({ x1: 201, y1: 665, x2: 201, y2: 209 }).midpoint, {
    x: 201,
    y: 437,
  });
});

test('decodeScrollDirectionResult declines to guess where the owner reported no gesture', () => {
  assert.equal(decodeScrollDirectionResult({ button: 'down' }).midpoint, undefined);
  assert.equal(decodeScrollDirectionResult({ x1: 201, y1: 665, x2: 201 }).midpoint, undefined);
  assert.equal(
    decodeScrollDirectionResult({ x1: 201, y1: 665, x2: 201, y2: 'none' }).midpoint,
    undefined,
  );
});

test('assertScrollRefreshCompatible refuses --until and --max-passes on a refresh with a typed reason', () => {
  assertScrollRefreshCompatible({ refresh: true });
  assertScrollRefreshCompatible({ refresh: false, until: 'id=x' });
  assert.throws(
    () => assertScrollRefreshCompatible({ refresh: true, until: 'id=x' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'scroll_refresh_until_unsupported',
  );
  assert.throws(
    () => assertScrollRefreshCompatible({ refresh: true, maxPasses: 3 }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_until_unsupported',
  );
});

test('resolveScrollExecutionOptions keeps a controlled release and no hold or anchor fields', () => {
  const resolved = resolveScrollExecutionOptions({ pixels: 320, durationMs: 1200 });
  assert.equal(resolved.releaseBehavior, 'controlled');
  assert.equal('holdMs' in resolved, false);
  assert.equal('anchorTop' in resolved, false);
});
