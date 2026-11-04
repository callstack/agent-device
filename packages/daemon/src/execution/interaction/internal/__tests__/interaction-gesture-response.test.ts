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

test('the schedule a backend reports it ran replaces the planned one', () => {
  const fling = (backendResult: Record<string, unknown>) =>
    gestureResponseData(
      {
        kind: 'fling',
        durationMs: 100,
        pointerCount: 1,
        from: { x: 8, y: 426 },
        to: { x: 334, y: 426 },
        backendResult,
        message: 'Flung',
      },
      { executionProfile: 'endpoint-hold' },
    );

  expect(fling({ executionProfile: 'edge-ease-in' })).toMatchObject({
    executionProfile: 'edge-ease-in',
    timing: { executionProfile: 'edge-ease-in', gestureDurationMs: 100 },
  });
  expect(fling({})).toMatchObject({
    executionProfile: 'endpoint-hold',
    timing: { executionProfile: 'endpoint-hold' },
  });
  expect(fling({ executionProfile: 'future-schedule' })).toMatchObject({
    executionProfile: 'future-schedule',
    timing: { executionProfile: 'future-schedule' },
  });
  expect(fling({ executionProfile: 42 })).toMatchObject({
    executionProfile: 'endpoint-hold',
    timing: { executionProfile: 'endpoint-hold' },
  });
});
