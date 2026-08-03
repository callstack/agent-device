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

test('drag requires two non-empty targets and validates each timing phase', () => {
  for (const input of [
    { kind: 'drag', source: '', destination: 'id="drop-target"' },
    { kind: 'drag', source: 'id="drag-source"', destination: '   ' },
    { kind: 'drag', source: 'id="drag-source"', destination: 'id="drop-target"', sourceHoldMs: 0 },
    { kind: 'drag', source: 'id="drag-source"', destination: 'id="drop-target"', moveMs: 15 },
    {
      kind: 'drag',
      source: 'id="drag-source"',
      destination: 'id="drop-target"',
      destinationHoldMs: -1,
    },
  ]) {
    assert.throws(() => readGesturePayload(input), { code: 'INVALID_ARGS' });
  }

  assert.deepEqual(
    readGesturePayload({
      kind: 'drag',
      source: 'id="drag-source"',
      destination: '@e2~s42',
      destinationHoldMs: 0,
    }),
    {
      kind: 'drag',
      source: 'id="drag-source"',
      destination: '@e2~s42',
      sourceHoldMs: undefined,
      moveMs: undefined,
      destinationHoldMs: 0,
    },
  );

  assert.deepEqual(
    readGesturePayload({
      kind: 'drag',
      source: '  id="drag-source"  ',
      destination: '  id="drop-target" ',
    }),
    {
      kind: 'drag',
      source: 'id="drag-source"',
      destination: 'id="drop-target"',
      sourceHoldMs: undefined,
      moveMs: undefined,
      destinationHoldMs: undefined,
    },
  );
  assert.throws(
    () =>
      readGesturePayload({
        kind: 'drag',
        source: 'id="drag-source"',
        destination: 'id="drop-target"',
        sourceHoldMs: 4_000,
        moveMs: 4_000,
        destinationHoldMs: 4_000,
      }),
    { code: 'INVALID_ARGS', message: 'gesture drag total duration must be at most 10000' },
  );
});
