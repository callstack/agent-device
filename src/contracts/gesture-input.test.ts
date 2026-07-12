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
      kind: 'fling',
      direction: 'left',
      origin: { x: 10, y: 20 },
      durationMs: 10_001,
    },
    { kind: 'swipe', preset: 'left', durationMs: 0 },
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
