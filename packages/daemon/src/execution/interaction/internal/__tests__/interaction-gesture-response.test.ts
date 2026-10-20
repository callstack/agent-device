import { expect, test } from 'vitest';
import { gestureResponseData } from '../interaction-gesture-response.ts';

test('gesture response builder preserves the dual-target drag disclosure and timing profile', () => {
  const resolution = { source: 'runtime', phase: 'pre-action', kind: 'unique' } as const;
  expect(
    gestureResponseData(
      {
        kind: 'drag',
        durationMs: 1_300,
        pointerCount: 1,
        from: { x: 10, y: 20 },
        to: { x: 30, y: 40 },
        targets: {
          source: { selectorChain: ['id="source"'], resolution },
          destination: { selectorChain: ['id="destination"'], resolution },
        },
        message: 'Dragged source to destination',
      },
      { executionProfile: 'timed-pan' },
    ),
  ).toMatchObject({
    kind: 'drag',
    durationMs: 1_300,
    pointerCount: 1,
    targets: {
      source: { selectorChain: ['id="source"'] },
      destination: { selectorChain: ['id="destination"'] },
    },
    timing: { executionProfile: 'timed-pan', gestureDurationMs: 1_300 },
  });
});

test('a tap response lists its contacts and how many repetitions completed', () => {
  const points = [
    { x: 80, y: 300 },
    { x: 200, y: 450 },
    { x: 310, y: 600 },
  ];
  expect(
    gestureResponseData({
      kind: 'tap',
      durationMs: 50,
      pointerCount: 3,
      from: { x: 196.66666666666666, y: 450 },
      to: { x: 196.66666666666666, y: 450 },
      tapSeries: { points, holdMs: 50, count: 4, pauseMs: 100, completed: 4 },
      message: 'Tapped 3 points 4 times',
    }),
  ).toEqual({
    kind: 'tap',
    durationMs: 50,
    pointerCount: 3,
    from: { x: 196.66666666666666, y: 450 },
    to: { x: 196.66666666666666, y: 450 },
    points,
    holdMs: 50,
    count: 4,
    pauseMs: 100,
    completed: 4,
    message: 'Tapped 3 points 4 times',
  });
});
