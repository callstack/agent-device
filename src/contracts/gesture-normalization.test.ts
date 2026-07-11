import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  gesturePayloadFromLegacyPositionals,
  normalizePublicGesture,
} from './gesture-normalization.ts';

test('legacy CLI and .ad positionals normalize at one explicit compatibility seam', () => {
  assert.deepEqual(
    gesturePayloadFromLegacyPositionals(['pan', '10', '20', '30', '-40', '500'], 2),
    {
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 30, y: -40 },
      durationMs: 500,
      pointerCount: 2,
    },
  );
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
});
