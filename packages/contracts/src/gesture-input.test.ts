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

const TAP_POINTS = [
  { x: 100, y: 200 },
  { x: 160, y: 200 },
];

test('tap reads its points, hold, count and pause', () => {
  assert.deepEqual(
    readGesturePayload({ kind: 'tap', points: TAP_POINTS, holdMs: 40, count: 3, pauseMs: 100 }),
    { kind: 'tap', points: TAP_POINTS, holdMs: 40, count: 3, pauseMs: 100 },
  );
});

test('tap refuses a hold below the planner floor, which press would accept', () => {
  assert.throws(() => readGesturePayload({ kind: 'tap', points: TAP_POINTS, holdMs: 15 }), {
    code: 'INVALID_ARGS',
    message: 'Expected holdMs to be at least 16.',
  });
  assert.equal(readGesturePayload({ kind: 'tap', points: TAP_POINTS, holdMs: 16 }).kind, 'tap');
});

test('tap refuses a series that cannot finish inside the request budget', () => {
  // 100 × (50 + 500) + 99 × 50 = 59 950 ms fits; one more repetition does not.
  assert.equal(
    readGesturePayload({ kind: 'tap', points: TAP_POINTS, count: 100, pauseMs: 50 }).kind,
    'tap',
  );
  assert.throws(
    () => readGesturePayload({ kind: 'tap', points: TAP_POINTS, count: 101, pauseMs: 50 }),
    { code: 'INVALID_ARGS', message: 'gesture tap series must fit within 60000ms.' },
  );
});

test('tap refuses pan-only and duration inputs', () => {
  assert.throws(() => readGesturePayload({ kind: 'tap', points: TAP_POINTS, pointerCount: 2 }), {
    code: 'INVALID_ARGS',
    message: 'pointerCount is supported only for gesture pan',
  });
  assert.throws(() => readGesturePayload({ kind: 'tap', points: TAP_POINTS, durationMs: 100 }), {
    code: 'INVALID_ARGS',
    message: 'gesture tap does not accept durationMs; use holdMs',
  });
});

test('tap-only inputs are refused on other gesture kinds', () => {
  for (const [field, value] of [
    ['points', TAP_POINTS],
    ['holdMs', 50],
    ['count', 2],
    ['pauseMs', 10],
  ] as const) {
    assert.throws(() => readGesturePayload({ kind: 'pinch', scale: 1.5, [field]: value }), {
      code: 'INVALID_ARGS',
      message: `${field} is supported only for gesture tap`,
    });
  }
});
