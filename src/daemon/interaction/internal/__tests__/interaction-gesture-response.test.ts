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
