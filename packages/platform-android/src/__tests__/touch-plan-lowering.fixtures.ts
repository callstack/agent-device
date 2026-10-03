import fc from 'fast-check';
import type { Rect } from '@agent-device/kernel/snapshot';
import { SCROLL_DIRECTIONS } from '@agent-device/contracts/scroll-gesture';

export const PROPERTY_RUNS_SMALL = 40;

const viewportRectArb: fc.Arbitrary<Rect> = fc.oneof(
  fc.constantFrom({ x: 0, y: 0, width: 320, height: 568 }, { x: 0, y: 0, width: 375, height: 667 }),
  fc.record({
    x: fc.integer({ min: 0, max: 200 }),
    y: fc.integer({ min: 0, max: 200 }),
    width: fc.integer({ min: 1, max: 2400 }),
    height: fc.integer({ min: 1, max: 2400 }),
  }),
);

export const scrollInViewportArb = fc.record({
  viewport: viewportRectArb.filter(({ width, height }) => width >= 32 && height >= 32),
  direction: fc.constantFrom(...SCROLL_DIRECTIONS),
  durationMs: fc.integer({ min: 16, max: 10000 }),
  pixels: fc.integer({ min: 1, max: 2000 }),
});
