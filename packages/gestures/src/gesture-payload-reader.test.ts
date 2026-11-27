import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readGesturePayload } from './gesture-payload-reader.ts';
import { AppError } from '@agent-device/kernel/errors';

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

test('drag refuses coordinate endpoints and carries the held pan that makes the move', () => {
  const refusal = (source: string, destination: string, timing: Record<string, number> = {}) => {
    try {
      readGesturePayload({ kind: 'drag', source, destination, ...timing });
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      const { reason, endpoint, pan } = error.details ?? {};
      return { reason, endpoint, pan };
    }
    assert.fail(`expected drag ${source} -> ${destination} to be refused`);
  };
  const reason = 'drag_endpoint_is_coordinates';

  // gesture drag "170 1595" "540 160" 1200 800 600: the pan keeps the hold and the move time.
  assert.deepEqual(
    refusal('170 1595', '540 160', { sourceHoldMs: 1200, moveMs: 800, destinationHoldMs: 600 }),
    {
      reason,
      endpoint: 'source',
      pan: { x: 170, y: 1595, dx: 370, dy: -1435, durationMs: 800, holdMs: 1200 },
    },
  );
  assert.deepEqual(refusal('170,1595', '540,160'), {
    reason,
    endpoint: 'source',
    pan: { x: 170, y: 1595, dx: 370, dy: -1435, durationMs: 500, holdMs: 800 },
  });
  assert.deepEqual(refusal('id="row-1"', '540 160'), {
    reason,
    endpoint: 'destination',
    pan: undefined,
  });
  // Unquoted coordinates split into bare numbers, and an invalid moveMs: the endpoints are
  // still named, without a pan.
  assert.deepEqual(
    refusal('170', '1595', { sourceHoldMs: 540, moveMs: 15, destinationHoldMs: 1200 }),
    {
      reason,
      endpoint: 'source',
      pan: undefined,
    },
  );
  // A selector whose value is a number stays a selector.
  assert.equal(
    readGesturePayload({ kind: 'drag', source: 'label="170"', destination: '@e2' }).kind,
    'drag',
  );
  // An empty or blank segment is no coordinate, so these are left to the selector checks.
  for (const endpoint of [',', '170,', '170 , ']) {
    assert.equal(
      readGesturePayload({ kind: 'drag', source: endpoint, destination: '@e2' }).kind,
      'drag',
      endpoint,
    );
  }
  assert.deepEqual(refusal('170,', '540 160'), { reason, endpoint: 'destination', pan: undefined });
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
      destination: '@e2-s42',
      destinationHoldMs: 0,
    }),
    {
      kind: 'drag',
      source: 'id="drag-source"',
      destination: '@e2-s42',
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
    ['count', 2],
    ['pauseMs', 10],
  ] as const) {
    assert.throws(() => readGesturePayload({ kind: 'pinch', scale: 1.5, [field]: value }), {
      code: 'INVALID_ARGS',
      message: `${field} is supported only for gesture tap`,
    });
  }
  assert.throws(() => readGesturePayload({ kind: 'pinch', scale: 1.5, holdMs: 50 }), {
    code: 'INVALID_ARGS',
    message: 'holdMs is supported only for gesture tap and gesture pan',
  });
});

test('element is refused on gesture kinds other than pinch', () => {
  assert.throws(() => readGesturePayload({ kind: 'rotate', degrees: 30, element: '@e1' }), {
    code: 'INVALID_ARGS',
    message: 'element is supported only for gesture pinch',
  });
});

test('pinch refuses an element together with an origin', () => {
  assert.throws(
    () => readGesturePayload({ kind: 'pinch', scale: 2, element: '@e17', origin: { x: 1, y: 2 } }),
    { code: 'INVALID_ARGS', message: 'gesture pinch takes an element or an origin, not both' },
  );
});

test('pan accepts a hold before the move', () => {
  assert.deepEqual(
    readGesturePayload({
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 0, y: 80 },
      holdMs: 800,
    }),
    { kind: 'pan', origin: { x: 10, y: 20 }, delta: { x: 0, y: 80 }, holdMs: 800 },
  );
});

test('pan refuses a two-pointer hold and out-of-range holdMs', () => {
  assert.throws(
    () =>
      readGesturePayload({
        kind: 'pan',
        origin: { x: 10, y: 20 },
        delta: { x: 0, y: 80 },
        pointerCount: 2,
        holdMs: 800,
      }),
    {
      code: 'INVALID_ARGS',
      message: 'holdMs is supported only for single-pointer gesture pan',
    },
  );
  assert.throws(
    () =>
      readGesturePayload({
        kind: 'pan',
        origin: { x: 10, y: 20 },
        delta: { x: 0, y: 80 },
        holdMs: 10_001,
      }),
    { code: 'INVALID_ARGS' },
  );
});
