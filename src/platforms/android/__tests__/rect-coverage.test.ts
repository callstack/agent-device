import type { Rect } from '@agent-device/kernel/snapshot';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { PROPERTY_RUNS } from '../../../__tests__/test-utils/property-arbitraries.ts';
import { unionCoverage } from '../rect-coverage.ts';
import { createAndroidSnapshotPresentationBudget } from '../snapshot-presentation.ts';

const smallRect = fc.record({
  x: fc.integer({ min: -4, max: 20 }),
  y: fc.integer({ min: -4, max: 20 }),
  width: fc.integer({ min: 0, max: 6 }),
  height: fc.integer({ min: 0, max: 6 }),
});

test('matches an exact unit-cell oracle for integer rectangles', () => {
  fc.assert(
    fc.property(
      fc.array(smallRect, { maxLength: 6 }),
      fc.array(smallRect, { maxLength: 6 }),
      (covering, covered) => {
        const coverage = unionCoverage(covering, covered);
        expect(coverage).toBe(bruteForceCoverage(covering, covered));
        expect(coverage).toBeGreaterThanOrEqual(0);
        expect(coverage).toBeLessThanOrEqual(1);
        expect(unionCoverage([...covering].reverse(), [...covered].reverse())).toBe(coverage);
        expect(unionCoverage([...covering, ...covering], [...covered, ...covered])).toBe(coverage);
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test('uses edges from both sets when measuring partial coverage', () => {
  expect(
    unionCoverage([{ x: 0, y: 0, width: 5, height: 10 }], [{ x: 0, y: 0, width: 10, height: 10 }]),
  ).toBe(0.5);
});

test('handles numeric edge ordering, adjacency, duplicates, and negative coordinates', () => {
  expect(
    unionCoverage(
      [{ x: 9, y: -10, width: 91, height: 10 }],
      [{ x: 9, y: -10, width: 91, height: 10 }],
    ),
  ).toBe(1);
  expect(
    unionCoverage(
      [
        { x: -10, y: 0, width: 10, height: 10 },
        { x: 10, y: 0, width: 10, height: 10 },
      ],
      [{ x: 0, y: 0, width: 10, height: 10 }],
    ),
  ).toBe(0);
  expect(
    unionCoverage(
      [{ x: -10, y: -10, width: 10, height: 10 }],
      [
        { x: -10, y: -10, width: 10, height: 10 },
        { x: -10, y: -10, width: 10, height: 10 },
      ],
    ),
  ).toBe(1);
});

test('ignores degenerate rectangles and keeps the ratio within its exact threshold', () => {
  expect(
    unionCoverage(
      [
        { x: 0, y: 0, width: 90, height: 1 },
        { x: 0, y: 0, width: 0, height: 100 },
      ],
      [{ x: 0, y: 0, width: 100, height: 1 }],
    ),
  ).toBe(0.9);
  expect(
    unionCoverage([{ x: 0, y: 0, width: 89, height: 1 }], [{ x: 0, y: 0, width: 100, height: 1 }]),
  ).toBe(0.89);
});

test('charges deterministic work and rejects overlapping hostile inputs', () => {
  const covering = Array.from({ length: 100 }, () => ({ x: 0, y: 0, width: 100, height: 100 }));
  const covered = Array.from({ length: 100 }, () => ({ x: 0, y: 0, width: 100, height: 100 }));
  const first = createAndroidSnapshotPresentationBudget(
    { deadlineAtMs: Number.POSITIVE_INFINITY },
    10_000,
  );
  const second = createAndroidSnapshotPresentationBudget(
    { deadlineAtMs: Number.POSITIVE_INFINITY },
    10_000,
  );

  expect(unionCoverage(covering, covered, first)).toBe(1);
  expect(unionCoverage(covering, covered, second)).toBe(1);
  expect(first.workUnitCount).toBe(1001);
  expect(first.workUnitCount).toBe(second.workUnitCount);

  const constrained = createAndroidSnapshotPresentationBudget(
    { deadlineAtMs: Number.POSITIVE_INFINITY, maxWorkUnits: 900 },
    10_000,
  );
  expect(() => unionCoverage(covering, covered, constrained)).toThrow(
    'Android snapshot presentation exceeded its linear work budget',
  );
});

function bruteForceCoverage(covering: Rect[], covered: Rect[]): number {
  const coveringCells = cellsOf(covering);
  const coveredCells = cellsOf(covered);
  if (coveredCells.size === 0) return 0;
  let overlap = 0;
  for (const cell of coveredCells) {
    if (coveringCells.has(cell)) overlap += 1;
  }
  return overlap / coveredCells.size;
}

function cellsOf(rects: Rect[]): Set<string> {
  const cells = new Set<string>();
  for (const rect of rects) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        cells.add(`${x},${y}`);
      }
    }
  }
  return cells;
}
