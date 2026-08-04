import { describe, expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveMaestroScrollableGesture } from '../runtime-port-geometry.ts';
// The snapshot-facing platform union ('android' | 'ios'), not program-ir's,
// which also carries 'web'.
import type { MaestroPlatform } from '../runtime-target-policy.ts';
import { isMaestroNodeVisible } from '../snapshot-policy.ts';

// Maestro asks two different questions about "is this node scrollable":
//
//   clips  - snapshot-policy.ts walks to the nearest scrollable ancestor to
//            decide which viewport a node is measured against (contracts'
//            isScrollableNodeLike: substring match on the RAW type, plus
//            role/subrole).
//   swipes - runtime-port-geometry.ts walks to the nearest scroll container to
//            decide where scrollUntilVisible starts its swipe
//            (isScrollableSnapshotType: equality match on the NORMALIZED type).
//
// The two predicates are structurally similar and were reported as clones, but
// they classify differently in BOTH directions. This table is the agreed
// answer for every type where they disagree; a "consolidation" that makes any
// row's two columns equal changes which element a flow taps or swipes.
//
// The third walk (contracts' findNearestScrollableAncestor) is the one
// snapshot-policy.ts now calls, so `clips` covers it too.

const APPLICATION: SnapshotNode = {
  index: 0,
  ref: '@e1',
  type: 'Application',
  visibleToUser: true,
  rect: { x: 0, y: 0, width: 402, height: 874 },
};

// Tall and narrow so the vertical-axis check in selectMaestroScrollableViewport
// accepts it, and short enough that the target below sits outside it.
const CONTAINER_RECT = { x: 0, y: 100, width: 200, height: 600 };
const TARGET_RECT = { x: 20, y: 750, width: 100, height: 40 };

function snapshotWithContainer(containerType: string) {
  const nodes: SnapshotNode[] = [
    APPLICATION,
    {
      index: 1,
      ref: '@e2',
      parentIndex: 0,
      type: containerType,
      visibleToUser: true,
      rect: CONTAINER_RECT,
    },
    {
      index: 2,
      ref: '@e3',
      parentIndex: 1,
      type: 'Button',
      identifier: 'target',
      visibleToUser: true,
      rect: TARGET_RECT,
    },
  ];
  return { createdAt: 0, nodes };
}

/** True when the container clips the target, i.e. it is the effective viewport. */
function clips(containerType: string, platform: MaestroPlatform): boolean {
  const { nodes } = snapshotWithContainer(containerType);
  // The target sits outside the container rect but inside the Application rect,
  // so it reads as hidden exactly when the container is the viewport.
  return !isMaestroNodeVisible(nodes[2]!, nodes, platform);
}

/** True when scrollUntilVisible swipes inside the container instead of the screen. */
function swipes(containerType: string, platform: MaestroPlatform): boolean {
  const gesture = resolveMaestroScrollableGesture(
    snapshotWithContainer(containerType),
    { id: 'target' },
    'down',
    600,
    platform,
  );
  // No container selected => daemon-runtime-port.ts falls back to a plain
  // screen scroll, which is the upstream-shaped gesture.
  if (!gesture) return false;
  expect(gesture.viewport).toEqual(CONTAINER_RECT);
  return true;
}

describe('scrollable predicates agree on the canonical scroll types', () => {
  const cases: ReadonlyArray<[string, MaestroPlatform, boolean]> = [
    ['XCUIElementTypeScrollView', 'ios', true],
    ['XCUIElementTypeCollectionView', 'ios', true],
    ['AXScrollArea', 'ios', true],
    ['android.widget.ScrollView', 'android', true],
    ['ScrollView', 'android', true],
    ['XCUIElementTypeButton', 'ios', false],
    ['android.widget.LinearLayout', 'android', false],
  ];

  test.each(cases)('%s on %s is scrollable to both walks: %s', (type, platform, scrollable) => {
    expect(clips(type, platform)).toBe(scrollable);
    expect(swipes(type, platform)).toBe(scrollable);
  });
});

describe('scrollable predicates diverge, and each answer is the intended one', () => {
  // Substring match on the raw type catches these; equality on the normalized
  // type does not. They clip (a nested list really does bound what you can
  // see) but do not capture the swipe, which falls back to a screen scroll.
  const clipsOnly: ReadonlyArray<[string, MaestroPlatform]> = [
    ['android.widget.ListView', 'android'],
    ['android.widget.GridView', 'android'],
    ['androidx.recyclerview.widget.RecyclerView', 'android'],
    ['RecyclerView', 'android'],
    ['android.widget.HorizontalScrollView', 'android'],
    ['AXScrollBar', 'ios'],
  ];

  test.each(clipsOnly)('%s on %s clips but is not a swipe container', (type, platform) => {
    expect(clips(type, platform)).toBe(true);
    expect(swipes(type, platform)).toBe(false);
  });

  // The mirror image: normalizing strips the XCUIElementType/AX prefix, so
  // these reach the `=== 'table'` arm of the swipe predicate. The clip
  // predicate compares 'table' against the UNNORMALIZED type, so the prefixed
  // forms miss it and the target is measured against the root viewport.
  const swipesOnly: ReadonlyArray<[string, MaestroPlatform]> = [
    ['XCUIElementTypeTable', 'ios'],
    ['AXTable', 'ios'],
  ];

  test.each(swipesOnly)('%s on %s is a swipe container but does not clip', (type, platform) => {
    expect(clips(type, platform)).toBe(false);
    expect(swipes(type, platform)).toBe(true);
  });

  // Bare 'table' is the one spelling both predicates accept, which is why the
  // divergence above is easy to miss when reading either one alone.
  test('bare table is accepted by both', () => {
    expect(clips('table', 'ios')).toBe(true);
    expect(swipes('table', 'ios')).toBe(true);
  });

  // Only the clip predicate looks at role/subrole at all.
  test('role-only scrollables clip but are not swipe containers', () => {
    const { nodes } = snapshotWithContainer('Other');
    const container = { ...nodes[1]!, role: 'AXScrollArea' };
    const withRole = [nodes[0]!, container, nodes[2]!];
    expect(isMaestroNodeVisible(withRole[2]!, withRole, 'ios')).toBe(false);
    expect(
      resolveMaestroScrollableGesture(
        { createdAt: 0, nodes: withRole },
        { id: 'target' },
        'down',
        600,
        'ios',
      ),
    ).toBeUndefined();
  });
});
