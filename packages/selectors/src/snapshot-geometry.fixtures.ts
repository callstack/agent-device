import fc from 'fast-check';
import { attachRefs, type Rect, type SnapshotNode } from '@agent-device/kernel/snapshot';

export { makeSnapshotState } from '@agent-device/capture-kit/snapshot-state-fixtures';

/**
 * Run budget for every property in the unit suite. Properties share the unit
 * slow-test budget (2.5s per file, see docs/agents/testing.md), so the count is
 * bounded here rather than per call site — raise it in one place, and only with
 * a measured file duration.
 */
export const PROPERTY_RUNS = 100;

// ---------------------------------------------------------------------------
// Rects / viewports
// ---------------------------------------------------------------------------

export const scrollingContainerTypeArb = fc.constantFrom(
  'XCUIElementTypeScrollView',
  'XCUIElementTypeTable',
  'XCUIElementTypeCollectionView',
  'android.widget.ListView',
  'androidx.recyclerview.widget.RecyclerView',
);

export const distinctRectPairArb: fc.Arbitrary<{ ancestor: Rect; target: Rect }> = fc
  .record({
    x: fc.integer({ min: -200, max: 200 }),
    y: fc.integer({ min: -200, max: 200 }),
    width: fc.integer({ min: 1, max: 1200 }),
    height: fc.integer({ min: 1, max: 1200 }),
  })
  .chain((ancestor) =>
    fc.constantFrom<keyof Rect>('x', 'y', 'width', 'height').map((field) => ({
      ancestor,
      target: { ...ancestor, [field]: ancestor[field] + 1 },
    })),
  );

export type InteractionTouchPointScenario = {
  nodes: SnapshotNode[];
  permutedNodes: SnapshotNode[];
  target: SnapshotNode;
  bound: Rect;
  competitorRects: Rect[];
};

const halfPixel = (value: number): number => value / 2;
const touchPointAxisStepsArb = fc.oneof(
  fc.integer({ min: 4, max: 46 }),
  fc.integer({ min: 48, max: 800 }),
);

const touchPointTargetRectArb = fc
  .record({
    x: fc.integer({ min: -200, max: 200 }),
    y: fc.integer({ min: -200, max: 200 }),
    // Exercise dense desktop rows as well as standard mobile touch targets.
    width: touchPointAxisStepsArb,
    height: touchPointAxisStepsArb,
  })
  .map(({ x, y, width, height }) => ({
    x: halfPixel(x),
    y: halfPixel(y),
    width: halfPixel(width),
    height: halfPixel(height),
  }));

function containedRectArb(container: Rect): fc.Arbitrary<Rect> {
  const widthSteps = Math.round(container.width * 2);
  const heightSteps = Math.round(container.height * 2);
  return fc
    .record({
      width: fc.integer({ min: 2, max: widthSteps - 2 }),
      height: fc.integer({ min: 2, max: heightSteps - 2 }),
    })
    .chain(({ width, height }) =>
      fc
        .record({
          x: fc.integer({ min: 0, max: widthSteps - width }),
          y: fc.integer({ min: 0, max: heightSteps - height }),
        })
        .map(({ x, y }) => ({
          x: container.x + halfPixel(x),
          y: container.y + halfPixel(y),
          width: halfPixel(width),
          height: halfPixel(height),
        })),
    );
}

export const interactionTouchPointScenarioArb: fc.Arbitrary<InteractionTouchPointScenario> =
  touchPointTargetRectArb.chain((targetRect) =>
    fc
      .tuple(
        fc.array(containedRectArb(targetRect), { minLength: 1, maxLength: 6 }),
        containedRectArb(targetRect),
      )
      .chain(([competitorRects, bound]) => {
        const nodes = attachRefs([
          {
            index: 0,
            depth: 0,
            type: 'Link',
            label: 'Generated parent',
            rect: targetRect,
            hittable: true,
          },
          ...competitorRects.map((rect, offset) => ({
            index: offset + 1,
            depth: 1,
            parentIndex: 0,
            type: 'Button',
            label: `Generated child ${offset + 1}`,
            rect,
            hittable: true,
          })),
        ]);
        return fc
          .shuffledSubarray(nodes, { minLength: nodes.length, maxLength: nodes.length })
          .map((permutedNodes) => ({
            nodes,
            permutedNodes,
            target: nodes[0]!,
            bound,
            competitorRects,
          }));
      }),
  );
