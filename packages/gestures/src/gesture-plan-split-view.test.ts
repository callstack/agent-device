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
});

test('a Split View preset off iOS is refused before planning a touch', () => {
  expect(() =>
    buildGesturePlan({ intent: 'fling', preset: 'split-view-left' }, viewport, 'android'),
  ).toThrow(
    expect.objectContaining({
      code: 'UNSUPPORTED_OPERATION',
      details: expect.objectContaining({ reason: 'split_view_unavailable' }),
    }),
  );
});
