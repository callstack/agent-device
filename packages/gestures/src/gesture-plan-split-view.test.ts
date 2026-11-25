import { expect, test } from 'vitest';
import { buildGesturePlan } from './gesture-plan.ts';

const viewport = { x: 0, y: 0, width: 951, height: 669 };

test.each([
  ['split-view-left', (x: number) => x < viewport.width / 2],
  ['split-view-right', (x: number) => x > viewport.width / 2],
] as const)('%s drags up from the bottom edge, holds, then moves to its half', (preset, inHalf) => {
  const plan = buildGesturePlan({ intent: 'fling', preset }, viewport, 'ios');
  expect(plan.topology === 'single' && plan.contactOrigin).toBe('split-view-edge');
  const samples = plan.pointers[0].samples;
  const start = samples[0]!.point;
  const end = samples.at(-1)!.point;
  expect(start.y).toBeGreaterThan(viewport.height - 2);
  expect(inHalf(end.x)).toBe(true);
  // The runner derives the edge touch's swipe direction from start to end; it must stay upward.
  expect(Math.abs(end.x - start.x)).toBeLessThan(Math.abs(end.y - start.y));
  // The pause at the middle is what lifts the app window before the sideways move.
  const middle = { x: viewport.width / 2, y: viewport.height / 2 };
  expect(samples.map((sample) => sample.offsetMs)).toEqual([0, 600, 1400, 1900, 2100]);
  expect([samples[1]!.point, samples[2]!.point]).toEqual([middle, middle]);
});

test('split-view-exit drags the divider from the center to the left edge', () => {
  const display = { ...viewport, x: 20, y: 10 };
  const plan = buildGesturePlan({ intent: 'fling', preset: 'split-view-exit' }, display, 'ios');
  expect(plan).toMatchObject({
    topology: 'single',
    executionProfile: 'timed-pan',
    contactOrigin: 'split-view-divider',
    pointers: [
      {
        samples: [
          { offsetMs: 0, point: { x: 495.5, y: 344.5 } },
          { offsetMs: 700, point: { x: 21, y: 344.5 } },
        ],
      },
    ],
  });
});

test.each(['split-view-left', 'split-view-exit'] as const)(
  '%s off iOS is refused before planning a touch',
  (preset) => {
    expect(() => buildGesturePlan({ intent: 'fling', preset }, viewport, 'android')).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_OPERATION',
        details: expect.objectContaining({ reason: 'split_view_unavailable', dispatched: 'no' }),
      }),
    );
  },
);
