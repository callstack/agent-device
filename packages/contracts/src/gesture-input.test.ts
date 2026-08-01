import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readGesturePayload } from './gesture-input.ts';

test('structured gesture input rejects durations outside the planner range', () => {
  const cases = [
    {
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 30, y: 40 },
      durationMs: 0,
    },
    {
      kind: 'transform',
      origin: { x: 10, y: 20 },
      delta: { x: 30, y: 40 },
      scale: 1.2,
      degrees: 20,
      durationMs: 10_001,
    },
  ];

  for (const input of cases) {
    assert.throws(
      () => readGesturePayload(input),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'INVALID_ARGS' &&
        'message' in error &&
        typeof error.message === 'string' &&
        error.message.includes('16') &&
        error.message.includes('10000'),
    );
  }
});

test('rotate does not accept velocity', () => {
  assert.deepEqual(readGesturePayload({ kind: 'rotate', degrees: 45 }), {
    kind: 'rotate',
    degrees: 45,
    origin: undefined,
  });

  assert.throws(() => readGesturePayload({ kind: 'rotate', degrees: 45, velocity: 1 }), {
    code: 'INVALID_ARGS',
  });
});
