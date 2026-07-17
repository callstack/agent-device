import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  gesturePayloadFromPositionals,
  gesturePayloadToPositionals,
  normalizePublicGesture,
  normalizePublicSwipeMotion,
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
    swipePayloadFromPositionals(['10', '20', '30', '40'], {
      count: 2,
      pauseMs: 5,
      pattern: 'ping-pong',
    }),
    {
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
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

test('gesture recording codec round-trips fling with distance', () => {
  const payload = {
    kind: 'fling' as const,
    direction: 'left' as const,
    origin: { x: 10, y: 20 },
    distance: 180,
  };
  assert.deepEqual(gesturePayloadFromPositionals(gesturePayloadToPositionals(payload)), payload);
});

test('pinch and rotate syntax rejects a partial origin', () => {
  assert.throws(() => gesturePayloadFromPositionals(['pinch', '1.5', '100']), {
    code: 'INVALID_ARGS',
  });
  assert.throws(() => gesturePayloadFromPositionals(['rotate', '35', '100']), {
    code: 'INVALID_ARGS',
  });
});

test('swipe is fling sugar', () => {
  assert.deepEqual(normalizePublicGesture({ kind: 'swipe', preset: 'left' }), {
    gesture: { intent: 'fling', preset: 'left' },
  });
});

test('coordinate swipe is a quick fling', () => {
  assert.deepEqual(
    normalizePublicSwipeMotion({
      from: { x: 360, y: 400 },
      to: { x: 40, y: 400 },
    }),
    {
      gesture: { intent: 'fling', from: { x: 360, y: 400 }, to: { x: 40, y: 400 } },
    },
  );
});

test('fling stays a fling', () => {
  assert.deepEqual(
    normalizePublicGesture({
      kind: 'fling',
      direction: 'left',
      origin: { x: 200, y: 300 },
      distance: 80,
    }),
    {
      gesture: {
        intent: 'fling',
        direction: 'left',
        origin: { x: 200, y: 300 },
        distance: 80,
      },
    },
  );
});

test('multi-touch aliases become constraints on transform motion', () => {
  assert.deepEqual(normalizePublicGesture({ kind: 'pinch', scale: 1.5 }).gesture, {
    intent: 'pinch',
    origin: undefined,
    scale: 1.5,
  });
  assert.deepEqual(normalizePublicGesture({ kind: 'rotate', degrees: -45 }), {
    gesture: { intent: 'rotate', origin: undefined, degrees: -45 },
  });
});
