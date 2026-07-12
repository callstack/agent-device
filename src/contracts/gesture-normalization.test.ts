import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  gesturePayloadFromPositionals,
  gesturePayloadToPositionals,
  normalizePublicGesture,
  swipePayloadFromPositionals,
} from './gesture-normalization.ts';

test('CLI and .ad positionals normalize at one explicit syntax seam', () => {
  assert.deepEqual(gesturePayloadFromPositionals(['pan', '10', '20', '30', '-40', '500'], 2), {
    kind: 'pan',
    origin: { x: 10, y: 20 },
    delta: { x: 30, y: -40 },
    durationMs: 500,
    pointerCount: 2,
  });
});

test('CLI and .ad coordinate swipes normalize at one explicit syntax seam', () => {
  assert.deepEqual(
    swipePayloadFromPositionals(['10', '20', '30', '40', '300'], {
      count: 2,
      pauseMs: 5,
      pattern: 'ping-pong',
    }),
    {
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      durationMs: 300,
      count: 2,
      pauseMs: 5,
      pattern: 'ping-pong',
    },
  );
});

test('gesture recording codec round-trips structured requests', () => {
  const payload = {
    kind: 'transform' as const,
    origin: { x: 10, y: 20 },
    delta: { x: 30, y: -40 },
    scale: 1.5,
    degrees: -35,
    durationMs: 600,
  };
  assert.deepEqual(gesturePayloadFromPositionals(gesturePayloadToPositionals(payload)), payload);
});

test('gesture recording codec preserves timed fling duration when distance is omitted', () => {
  const payload = {
    kind: 'fling' as const,
    direction: 'left' as const,
    origin: { x: 10, y: 20 },
    durationMs: 600,
  };
  const positionals = gesturePayloadToPositionals(payload);
  assert.deepEqual(positionals, ['fling', 'left', '10', '20', '180', '600']);
  assert.deepEqual(normalizePublicGesture(gesturePayloadFromPositionals(positionals)), {
    gesture: {
      intent: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: -180, y: 0 },
      durationMs: 600,
    },
    deprecations: [{ rule: 'fling-duration', replacement: 'Use gesture pan for timed movement.' }],
  });
});

test('pinch and rotate syntax rejects a partial origin', () => {
  assert.throws(() => gesturePayloadFromPositionals(['pinch', '1.5', '100']), {
    code: 'INVALID_ARGS',
  });
  assert.throws(() => gesturePayloadFromPositionals(['rotate', '35', '100']), {
    code: 'INVALID_ARGS',
  });
});

test('rotate serialization omits behaviorless velocity when no origin can delimit it', () => {
  assert.deepEqual(gesturePayloadToPositionals({ kind: 'rotate', degrees: 35, velocity: 2 }), [
    'rotate',
    '35',
  ]);
});

test('swipe is fling sugar unless legacy duration requests a pan', () => {
  assert.deepEqual(normalizePublicGesture({ kind: 'swipe', preset: 'left' }), {
    gesture: { intent: 'fling', preset: 'left' },
    deprecations: [],
  });
  assert.deepEqual(normalizePublicGesture({ kind: 'swipe', preset: 'left', durationMs: 400 }), {
    gesture: { intent: 'pan', preset: 'left', durationMs: 400 },
    deprecations: [{ rule: 'swipe-duration', replacement: 'Use gesture pan for timed movement.' }],
  });
});

test('duration-bearing fling is an explicit compatibility alias for pan', () => {
  assert.deepEqual(
    normalizePublicGesture({
      kind: 'fling',
      direction: 'left',
      origin: { x: 200, y: 300 },
      distance: 80,
      durationMs: 500,
    }),
    {
      gesture: {
        intent: 'pan',
        origin: { x: 200, y: 300 },
        delta: { x: -80, y: 0 },
        durationMs: 500,
      },
      deprecations: [
        { rule: 'fling-duration', replacement: 'Use gesture pan for timed movement.' },
      ],
    },
  );
});

test('multi-touch aliases become constraints on transform motion', () => {
  assert.deepEqual(normalizePublicGesture({ kind: 'pinch', scale: 1.5 }).gesture, {
    intent: 'pinch',
    origin: undefined,
    scale: 1.5,
  });
  assert.deepEqual(normalizePublicGesture({ kind: 'rotate', degrees: -45, velocity: 2 }), {
    gesture: { intent: 'rotate', origin: undefined, degrees: -45 },
    deprecations: [
      { rule: 'rotate-velocity', replacement: 'Rotation pacing is derived from degrees.' },
    ],
  });
  assert.deepEqual(normalizePublicGesture({ kind: 'rotate', degrees: -45, velocity: -1.5 }), {
    gesture: { intent: 'rotate', origin: undefined, degrees: -45 },
    deprecations: [
      { rule: 'rotate-velocity', replacement: 'Rotation pacing is derived from degrees.' },
    ],
  });
});
